require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const bodyParser = require("body-parser");

module.exports = async (req, res) => {
  if (req.method === "POST") {
    const signature = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

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

    res.status(200).send("Webhook received");
  } else {
    res.status(405).json({ message: "Method Not Allowed" });
  }
};
