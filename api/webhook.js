require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

// Firebase Admin Initialization
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method === "POST") {
    const signature = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ✅ 1. Initial setup success (existing handler)
    if (event.type === "setup_intent.succeeded") {
      const setupIntent = event.data.object;
      const customerId = setupIntent.customer;

      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: setupIntent.payment_method,
        },
      });

      console.log(`Set default payment method for customer ${customerId}`);
    }

    // ✅ 2. Subscription renewal success
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;

      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;
      const periodEnd = invoice.lines.data[0].period?.end * 1000;

      try {
        // Get customer to extract user identity (email or metadata)
        const customer = await stripe.customers.retrieve(customerId);
        const userId = customer.metadata?.firebaseUID;

        if (!userId) throw new Error("firebaseUID missing in metadata");

        await db.collection("Users").doc(userId).update({
          subscription: true,
          cancelSubscription: false,
          subscriptionId,
          subscriptionEndDate: periodEnd,
        });

        console.log(`✅ Subscription updated for user ${userId}`);
      } catch (err) {
        console.error("🔥 Failed to update Firestore:", err);
      }
    }

    res.status(200).send("Webhook received");
  } else {
    res.status(405).json({ message: "Method Not Allowed" });
  }
};
