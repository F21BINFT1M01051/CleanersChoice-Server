require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === "POST") {
    const { email, uid } = req.body; // ✅ Accept Firebase UID

    if (!uid) {
      return res.status(400).json({ error: "Missing Firebase UID" });
    }

    try {
      // ✅ Include uid in metadata
      const customer = await stripe.customers.create({
        email,
        metadata: {
          firebaseUID: uid,
        },
      });

      const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        payment_method_types: ["card"],
      });

      res.status(200).json({
        setupIntentClientSecret: setupIntent.client_secret,
        customerId: customer.id,
        setupIntentId: setupIntent.id,
      });
    } catch (error) {
      console.error("SetupIntent Error:", error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).json({ message: "Method Not Allowed" });
  }
};
