const Stripe = require("stripe");
const getRawBody = require("raw-body");
const admin = require("firebase-admin");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Firebase Admin Initialization
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

export const config = {
  api: {
    bodyParser: false, // Disable default body parsing
  },
};

export default async function handler(req, res) {
  if (req.method === "POST") {
    const signature = req.headers["stripe-signature"];

    let rawBody;
    try {
      rawBody = await getRawBody(req);
    } catch (err) {
      return res.status(400).send("Unable to read request body");
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log(" Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle setup_intent.succeeded
    if (event.type === "setup_intent.succeeded") {
      const setupIntent = event.data.object;
      const customerId = setupIntent.customer;

      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: setupIntent.payment_method,
        },
      });

      console.log(`Default payment method set for ${customerId}`);
    }

    // Handle invoice.payment_succeeded
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;
      const periodEnd = invoice.lines.data[0].period?.end * 1000;

      try {
        const customer = await stripe.customers.retrieve(customerId);
        const userId = customer.metadata?.firebaseUID;

        if (!userId) throw new Error("firebaseUID missing in metadata");

        await db.collection("Users").doc(userId).update({
          subscription: true,
          cancelSubscription: false,
          subscriptionId,
          subscriptionEndDate: periodEnd,
          webhook : true
        });

        console.log(`Subscription updated for user ${userId}`);
      } catch (err) {
        console.log("Firestore update error:", err);
      }
    }

    res.status(200).send("Webhook received");
  } else {
    res.setHeader("Allow", "POST");
    res.status(405).end("Method Not Allowed");
  }
}
