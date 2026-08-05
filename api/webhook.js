const Stripe = require("stripe");
const getRawBody = require("raw-body");
const admin = require("firebase-admin");
const {
  SUBSCRIPTION_STATUS,
  STRIPE_STATUSES_WITH_ACCESS,
  mapStripeStatus,
  sanitize,
  resolveStripeUserId,
  getStripePeriodEndMs,
  recordPayment,
} = require("../lib/subscriptions");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      type: process.env.TYPE,
      project_id: process.env.PROJECT_ID,
      private_key_id: process.env.PRIVATE_KEY_ID,
      private_key: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"),
      client_email: process.env.CLIENT_EMAIL,
      client_id: process.env.CLIENT_ID,
      auth_uri: process.env.AUTH_URI,
      token_uri: process.env.TOKEN_URI,
      auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_CERT_URL,
      client_x509_cert_url: process.env.CLIENT_CERT_URL,
      universe_domain: process.env.UNIVERSE_DOMAIN,
    }),
  });
}

const db = admin.firestore();

export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Update a user doc without ever creating it. `.update()` throws if the doc is
 * missing (deleted account, late webhook) — we log and move on rather than let
 * one event abort the handler.
 */
async function updateUser(userId, data, label) {
  try {
    await db.collection("Users").doc(userId).update(sanitize(data));
    console.log(`✅ [${label}] Users/${userId} updated`);
  } catch (err) {
    console.error(`❌ [${label}] Users/${userId} update failed:`, err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method Not Allowed");
  }

  const signature = req.headers["stripe-signature"];
  let rawBody;

  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("Unable to read request body", err.message);
    return res.status(400).send("Unable to read request body");
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "setup_intent.succeeded") {
    const setupIntent = event.data.object;
    const customerId = setupIntent.customer;

    try {
      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: setupIntent.payment_method,
        },
      });
      console.log(`Default payment method set for ${customerId}`);
    } catch (err) {
      console.error("Failed to update default payment method:", err);
    }
  }

  // ✅ Handle successful subscription payment
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    const subscriptionId = invoice.subscription;
    const firstLine = invoice.lines?.data?.[0];
    const periodEnd = firstLine?.period?.end ? firstLine.period.end * 1000 : null;
    const periodStart = firstLine?.period?.start
      ? firstLine.period.start * 1000
      : null;

    try {
      const userId = await resolveStripeUserId(stripe, customerId);

      // ---- existing behaviour, unchanged ----
      const updateData = {
        subscription: true,
        subscriptionProvider: "stripe",
        cancelSubscription: false,
        webhook: true,
      };

      if (subscriptionId) updateData.subscriptionId = subscriptionId;
      if (periodEnd) updateData.subscriptionEndDate = periodEnd;

      // ---- new: status + grace/failure bookkeeping ----
      updateData.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
      updateData.subscriptionUpdatedAt = Date.now();
      // A successful charge clears any prior dunning state.
      updateData.lastPaymentFailedAt = null;
      updateData.gracePeriodEndsAt = null;

      await db.collection("Users").doc(userId).update(sanitize(updateData));
      console.log(`✅ Subscription updated in Firestore for user ${userId}`);

      // ---- new: payment history (idempotent, non-blocking) ----
      // Runs after the state update so a bookkeeping failure can never affect
      // the user's access.
      await recordPayment({
        db,
        admin,
        userId,
        provider: "stripe",
        reference: invoice.id,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        paidAt:
          (invoice.status_transitions?.paid_at ?? invoice.created) * 1000,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number ?? null,
        receiptUrl: invoice.hosted_invoice_url ?? null,
        productId: firstLine?.price?.id ?? firstLine?.plan?.id ?? null,
        periodStart,
        periodEnd,
      });
    } catch (err) {
      console.error("❌ Firestore update error:", err);
    }
  }

  // 🆕 Payment failed — Stripe is now in its dunning/retry window ("overdue").
  // Deliberately does NOT set `subscription: false`: the card may still succeed
  // on retry, and revoking access here would lock out recoverable customers.
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object;

    try {
      const userId = await resolveStripeUserId(stripe, invoice.customer);

      await updateUser(
        userId,
        {
          subscriptionStatus: SUBSCRIPTION_STATUS.PAST_DUE,
          lastPaymentFailedAt: Date.now(),
          // Stripe tells us when it will retry — that's the natural grace deadline.
          gracePeriodEndsAt: invoice.next_payment_attempt
            ? invoice.next_payment_attempt * 1000
            : null,
          lastPaymentFailure: {
            amountDue: invoice.amount_due ?? null,
            currency: (invoice.currency || "usd").toUpperCase(),
            attemptCount: invoice.attempt_count ?? null,
            invoiceId: invoice.id ?? null,
          },
          subscriptionUpdatedAt: Date.now(),
          webhook: true,
        },
        "invoice.payment_failed",
      );
    } catch (err) {
      console.error("❌ payment_failed handling error:", err.message);
    }
  }

  // 🆕 Any subscription state transition: status changes, cancel-at-period-end,
  // plan changes, dunning recovery. This is what keeps `subscriptionEndDate`
  // correct across renewals.
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object;

    try {
      const userId = await resolveStripeUserId(stripe, subscription.customer);
      const mapped = mapStripeStatus(subscription.status);

      if (!mapped) {
        // Unknown/new Stripe status — never persist a guess. Log only.
        console.warn(
          `Unmapped Stripe status "${subscription.status}" for ${userId} — no status written`,
        );
      } else {
        const periodEndMs = getStripePeriodEndMs(subscription);

        const updateData = {
          subscriptionStatus: mapped,
          subscription: STRIPE_STATUSES_WITH_ACCESS.includes(subscription.status),
          cancelSubscription: !!subscription.cancel_at_period_end,
          subscriptionProvider: "stripe",
          subscriptionUpdatedAt: Date.now(),
          webhook: true,
        };

        if (periodEndMs) updateData.subscriptionEndDate = periodEndMs;
        if (subscription.id) updateData.subscriptionId = subscription.id;
        // Recovered from dunning — clear the failure markers.
        if (subscription.status === "active" || subscription.status === "trialing") {
          updateData.lastPaymentFailedAt = null;
          updateData.gracePeriodEndsAt = null;
        }

        await updateUser(userId, updateData, "customer.subscription.updated");
      }
    } catch (err) {
      console.error("❌ subscription.updated handling error:", err.message);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    try {
      const customer = await stripe.customers.retrieve(customerId);
      const userId = customer.metadata?.firebaseUID;

      if (!userId) throw new Error("firebaseUID missing");

      // ---- existing behaviour preserved, plus the new status fields ----
      await db.collection("Users").doc(userId).update(
        sanitize({
          subscription: false,
          cancelSubscription: true,
          webhook: true,
          subscriptionStatus: SUBSCRIPTION_STATUS.CANCELED,
          subscriptionUpdatedAt: Date.now(),
          gracePeriodEndsAt: null,
        }),
      );

      console.log(`Subscription canceled in Firestore for user ${userId}`);
    } catch (err) {
      console.error("Firestore update error on cancel:", err);
    }
  }

  // Final response
  res.status(200).send("Webhook received");
}
