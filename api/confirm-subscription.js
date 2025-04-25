require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === "POST") {
    const { customerId } = req.body;

    try {
      const customer = await stripe.customers.retrieve(customerId);
      const defaultPaymentMethod = customer.invoice_settings.default_payment_method;

      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: process.env.PRICE_ID }],
        default_payment_method: defaultPaymentMethod,
        expand: ["latest_invoice"],
      });

      res.status(200).json({ success: true, subscriptionId: subscription.id });
    } catch (err) {
      console.error("Subscription Error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  } else {
    res.status(405).json({ message: "Method Not Allowed" });
  }
};
