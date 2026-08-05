/**
 * lib/subscriptions.js
 *
 * Shared subscription helpers for the Stripe + Apple webhooks.
 *
 * Lives OUTSIDE the `api/` directory on purpose: vercel.json builds
 * `api/**\/*.js` as serverless functions, and a helper module has no default
 * export, so it must not be matched by that glob. @vercel/node traces and
 * bundles `require()`d files from anywhere in the repo, so this is safe.
 *
 * This module deliberately does NOT initialise firebase-admin. Each endpoint
 * keeps its own existing `admin.initializeApp` block untouched, and passes
 * `db` / `admin` in. That guarantees zero change to the currently-working
 * initialisation behaviour.
 */

/* ------------------------------------------------------------------ *
 * Subscription status
 * ------------------------------------------------------------------ */

/**
 * The canonical set of values for `Users.subscriptionStatus`.
 * This becomes the new source of truth. The legacy `subscription` (boolean),
 * `subscriptionEndDate` and `cancelSubscription` fields are still written
 * exactly as before, so any existing reader keeps working.
 */
const SUBSCRIPTION_STATUS = {
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  EXPIRED: "expired",
  REFUNDED: "refunded",
  INCOMPLETE: "incomplete",
  NONE: "none",
};

/**
 * Stripe subscription.status -> our status.
 *
 * Note the deliberate split that the audit called out:
 *   past_due -> past_due  (Stripe is still retrying the card: "overdue")
 *   unpaid   -> expired   (retries exhausted, the invoice was left unpaid)
 *
 * An unmapped/unknown Stripe status returns undefined; callers must then skip
 * writing `subscriptionStatus` rather than persist a guess.
 */
const STRIPE_STATUS_MAP = {
  active: SUBSCRIPTION_STATUS.ACTIVE,
  trialing: SUBSCRIPTION_STATUS.ACTIVE,
  past_due: SUBSCRIPTION_STATUS.PAST_DUE,
  unpaid: SUBSCRIPTION_STATUS.EXPIRED,
  incomplete: SUBSCRIPTION_STATUS.INCOMPLETE,
  incomplete_expired: SUBSCRIPTION_STATUS.EXPIRED,
  canceled: SUBSCRIPTION_STATUS.CANCELED,
  paused: SUBSCRIPTION_STATUS.CANCELED,
};

/** Stripe statuses under which the user should retain app access. */
const STRIPE_STATUSES_WITH_ACCESS = ["active", "trialing", "past_due"];

const mapStripeStatus = (stripeStatus) => STRIPE_STATUS_MAP[stripeStatus];

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

/**
 * Firestore rejects `undefined` values outright. Every update object is passed
 * through this so an absent Stripe/Apple field can never blow up a write.
 * `null` is preserved — we use it intentionally to clear fields.
 */
const sanitize = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
};

/** Apple reports `price` in milliunits (4990 => $4.99). Convert to cents. */
const appleMilliunitsToMinor = (price) => {
  if (typeof price !== "number" || !Number.isFinite(price)) return null;
  return Math.round(price / 10);
};

const normalizeCurrency = (currency, fallback = "USD") =>
  typeof currency === "string" && currency.trim()
    ? currency.trim().toUpperCase()
    : fallback;

/** Decode a JWS (App Store Server Notification V2) payload segment. */
const decodeSignedPayload = (signedPayload) => {
  const parts = String(signedPayload || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
};

/* ------------------------------------------------------------------ *
 * Stripe user resolution
 * ------------------------------------------------------------------ */

/**
 * Resolve a Firebase uid from a Stripe customer id via customer metadata
 * (set in create-subscription.js as `firebaseUID`). Same lookup the existing
 * handlers already perform — extracted so all four events share it.
 */
const resolveStripeUserId = async (stripe, customerId) => {
  if (!customerId) throw new Error("Missing Stripe customer id");
  const customer = await stripe.customers.retrieve(customerId);
  const userId = customer?.metadata?.firebaseUID;
  if (!userId) throw new Error("firebaseUID missing in Stripe metadata");
  return userId;
};

/**
 * Stripe moved `current_period_end` from the subscription onto the
 * subscription item in recent API versions. Read both.
 * Returns ms epoch, or null.
 */
const getStripePeriodEndMs = (subscription) => {
  const seconds =
    subscription?.current_period_end ??
    subscription?.items?.data?.[0]?.current_period_end ??
    null;
  return typeof seconds === "number" ? seconds * 1000 : null;
};

/* ------------------------------------------------------------------ *
 * Payment history (idempotent)
 * ------------------------------------------------------------------ */

/**
 * Build the deterministic Payments document id. Webhooks are delivered *at
 * least* once, so the id must be derived purely from the provider's immutable
 * reference. Re-delivery then becomes a no-op instead of a double count.
 */
const buildPaymentId = (provider, reference) =>
  `${provider}_${String(reference).replace(/[/#?\s]/g, "-")}`;

/**
 * Record one successful payment, idempotently, and roll it into the user's
 * summary fields (`lastPayment`, `totalPaid`).
 *
 * Runs in a Firestore transaction because `FieldValue.increment` is NOT
 * idempotent on its own — a re-delivered webhook would otherwise inflate
 * `totalPaid`. The transaction reads the Payments doc first and bails out
 * entirely if it already exists.
 *
 * `amount` is always in MINOR UNITS (cents) as an integer, for both providers.
 *
 * Returns: 'recorded' | 'duplicate' | 'skipped'
 */
const recordPayment = async ({
  db,
  admin,
  userId,
  provider,
  reference,
  amount,
  currency,
  paidAt,
  productId = null,
  invoiceId = null,
  invoiceNumber = null,
  receiptUrl = null,
  transactionId = null,
  periodStart = null,
  periodEnd = null,
  environment = null,
}) => {
  if (!userId || !reference) {
    console.warn("recordPayment: missing userId or reference — skipped");
    return "skipped";
  }
  // Never create a payment row without a real amount; it would corrupt totals.
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    console.warn(
      `recordPayment: no usable amount for ${provider}/${reference} — skipped`,
    );
    return "skipped";
  }

  const paymentId = buildPaymentId(provider, reference);
  const paymentRef = db.collection("Payments").doc(paymentId);
  const userRef = db.collection("Users").doc(userId);
  const normalizedCurrency = normalizeCurrency(currency);
  const paidAtMs = typeof paidAt === "number" ? paidAt : Date.now();

  try {
    const result = await db.runTransaction(async (tx) => {
      // --- all reads first ---
      const [existing, userSnap] = await Promise.all([
        tx.get(paymentRef),
        tx.get(userRef),
      ]);

      if (existing.exists) return "duplicate";

      // --- writes ---
      tx.set(
        paymentRef,
        sanitize({
          userId,
          provider,
          amount,
          currency: normalizedCurrency,
          paidAt: paidAtMs,
          productId,
          invoiceId,
          invoiceNumber,
          receiptUrl,
          transactionId,
          periodStart,
          periodEnd,
          environment,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
      );

      // Only touch the user summary if the doc actually exists — a deleted
      // account must not be resurrected by a late webhook.
      if (userSnap.exists) {
        tx.update(userRef, {
          totalPaid: admin.firestore.FieldValue.increment(amount),
          lastPayment: {
            amount,
            currency: normalizedCurrency,
            paidAt: paidAtMs,
            provider,
          },
        });
      } else {
        console.warn(
          `recordPayment: Users/${userId} missing — payment stored, summary skipped`,
        );
      }

      return "recorded";
    });

    console.log(`recordPayment ${paymentId}: ${result}`);
    return result;
  } catch (err) {
    // Payment history is additive bookkeeping. Never let it break the
    // subscription-state update that matters for access.
    console.error(`recordPayment ${paymentId} failed:`, err.message);
    return "skipped";
  }
};

/* ------------------------------------------------------------------ *
 * Apple notification -> subscription state
 * ------------------------------------------------------------------ */

/**
 * Map an App Store Server Notification V2 to a Firestore update.
 *
 * Backward-compatibility rules applied here, deliberately:
 *  - EXPIRED / GRACE_PERIOD_EXPIRED / REFUND / REVOKE keep writing exactly the
 *    legacy `{subscription: false, cancelSubscription: true}` pair, so nothing
 *    that reads those fields today changes behaviour. Only the new
 *    `subscriptionStatus` distinguishes expired / refunded.
 *  - DID_FAIL_TO_RENEW no longer gets lumped in with expiry. It now maps to
 *    `past_due`. Access is only ever *granted* here (when Apple reports a grace
 *    period), never revoked relative to the old behaviour.
 *  - `subscriptionEndDate` is NOT extended to the grace deadline. The app's
 *    access gate (`subscriptionEndDate > now`) is intentionally left untouched;
 *    `gracePeriodEndsAt` is recorded so the app can opt into honouring it later.
 *
 * Returns null for notification types we don't act on (caller then writes only
 * the audit fields, which is still useful — it proves delivery is working).
 */
const deriveAppleUpdate = ({ notificationType, subtype, transaction, renewal }) => {
  const now = Date.now();
  const expiresDate = transaction?.expiresDate;

  switch (notificationType) {
    // Active: new purchase, successful renewal, or recovery from billing retry.
    case "SUBSCRIBED":
    case "DID_RENEW":
    case "DID_RECOVER": {
      const update = {
        subscription: true,
        cancelSubscription: false,
        subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
        lastPaymentFailedAt: null,
        gracePeriodEndsAt: null,
      };
      // Firestore rejects undefined, so only set the date when Apple sent one.
      if (expiresDate) update.subscriptionEndDate = expiresDate;
      return update;
    }

    // Billing retry — Apple is STILL trying to charge the card. This is
    // "overdue", not "expired". With subtype GRACE_PERIOD the user is meant to
    // keep access while the retries run.
    case "DID_FAIL_TO_RENEW": {
      const graceEnd = renewal?.gracePeriodExpiresDate;
      const inGrace =
        subtype === "GRACE_PERIOD" ||
        (typeof graceEnd === "number" && graceEnd > now);

      const update = {
        subscriptionStatus: SUBSCRIPTION_STATUS.PAST_DUE,
        // inGrace -> grant access (an improvement on the old blanket `false`).
        // not inGrace -> identical to the previous behaviour.
        subscription: !!inGrace,
        cancelSubscription: !inGrace,
        lastPaymentFailedAt: now,
      };
      if (typeof graceEnd === "number") update.gracePeriodEndsAt = graceEnd;
      return update;
    }

    // Terminal states. Legacy field pair preserved exactly.
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      return {
        subscription: false,
        cancelSubscription: true,
        subscriptionStatus: SUBSCRIPTION_STATUS.EXPIRED,
        gracePeriodEndsAt: null,
      };

    case "REFUND":
    case "REVOKE":
      return {
        subscription: false,
        cancelSubscription: true,
        subscriptionStatus: SUBSCRIPTION_STATUS.REFUNDED,
        gracePeriodEndsAt: null,
      };

    // Auto-renew toggled. Access continues until expiresDate either way, so
    // `subscriptionStatus` is intentionally left alone here.
    case "DID_CHANGE_RENEWAL_STATUS": {
      const disabled =
        subtype === "AUTO_RENEW_DISABLED" || renewal?.autoRenewStatus === 0;
      const update = { cancelSubscription: !!disabled };
      if (disabled && expiresDate) update.subscriptionEndDate = expiresDate;
      return update;
    }

    // Apple extended the subscription (e.g. customer-service goodwill).
    case "RENEWAL_EXTENDED":
      return expiresDate
        ? {
            subscription: true,
            subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
            subscriptionEndDate: expiresDate,
          }
        : null;

    default:
      // TEST, CONSUMPTION_REQUEST, DID_CHANGE_RENEWAL_PREF, PRICE_INCREASE, ...
      return null;
  }
};

/** Notification types that represent money actually collected. */
const APPLE_PAYMENT_NOTIFICATIONS = new Set([
  "SUBSCRIBED",
  "DID_RENEW",
  "DID_RECOVER",
]);

/* ------------------------------------------------------------------ *
 * Legacy-safe status derivation (used by the backfill script)
 * ------------------------------------------------------------------ */

/**
 * Derive a status for an existing user document from the legacy fields only.
 * Intentionally conservative: it will never downgrade a user who currently has
 * access. Ambiguous cases (subscription true, no end date — e.g. older Apple
 * docs) resolve to `active`, because the app gates on `subscriptionEndDate`
 * anyway, so writing `active` cannot remove access from anyone.
 */
const deriveLegacyStatus = (user, now = Date.now()) => {
  const end =
    typeof user?.subscriptionEndDate === "number"
      ? user.subscriptionEndDate
      : null;
  const hasEverSubscribed = !!user?.subscription || !!user?.subscriptionId;

  if (!hasEverSubscribed) return SUBSCRIPTION_STATUS.NONE;
  if (end === null) {
    return user?.subscription
      ? SUBSCRIPTION_STATUS.ACTIVE
      : SUBSCRIPTION_STATUS.EXPIRED;
  }
  if (end <= now) return SUBSCRIPTION_STATUS.EXPIRED;
  return SUBSCRIPTION_STATUS.ACTIVE;
};

module.exports = {
  SUBSCRIPTION_STATUS,
  STRIPE_STATUS_MAP,
  STRIPE_STATUSES_WITH_ACCESS,
  APPLE_PAYMENT_NOTIFICATIONS,
  mapStripeStatus,
  sanitize,
  appleMilliunitsToMinor,
  normalizeCurrency,
  decodeSignedPayload,
  resolveStripeUserId,
  getStripePeriodEndMs,
  buildPaymentId,
  recordPayment,
  deriveAppleUpdate,
  deriveLegacyStatus,
};
