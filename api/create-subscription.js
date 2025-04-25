require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === "POST") {
    const { email } = req.body;

    try {
      const customer = await stripe.customers.create({ email });

      const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        payment_method_types: ["card"],
      });

      res.status(200).json({
        setupIntentClientSecret: setupIntent.client_secret,
        customerId: customer.id,
      });
    } catch (error) {
      console.error("SetupIntent Error:", error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).json({ message: "Method Not Allowed" });
  }
};
