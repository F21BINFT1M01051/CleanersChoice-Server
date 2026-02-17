const Stripe = require("stripe");
const getRawBody = require("raw-body");
const admin = require("firebase-admin");

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
    const periodEnd = invoice.lines.data[0]?.period?.end
      ? invoice.lines.data[0].period.end * 1000
      : null;

    try {
      const customer = await stripe.customers.retrieve(customerId);
      const userId = customer.metadata?.firebaseUID;

      if (!userId) {
        throw new Error("firebaseUID missing in Stripe metadata");
      }

      const updateData = {
        subscription: true,
        subscriptionProvider: "stripe",
        cancelSubscription: false,
        webhook: true,
      };

      if (subscriptionId) updateData.subscriptionId = subscriptionId;
      if (periodEnd) updateData.subscriptionEndDate = periodEnd;

      await db.collection("Users").doc(userId).update(updateData);

      console.log(`✅ Subscription updated in Firestore for user ${userId}`);
    } catch (err) {
      console.error("❌ Firestore update error:", err);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    try {
      const customer = await stripe.customers.retrieve(customerId);
      const userId = customer.metadata?.firebaseUID;

      if (!userId) throw new Error("firebaseUID missing");

      await db.collection("Users").doc(userId).update({
        subscription: false,
        cancelSubscription: true,
        webhook: true,
      });

      console.log(`Subscription canceled in Firestore for user ${userId}`);
    } catch (err) {
      console.error("Firestore update error on cancel:", err);
    }
  }

  // Final response
  res.status(200).send("Webhook received");
}
