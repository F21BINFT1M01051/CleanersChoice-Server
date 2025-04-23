require("dotenv").config();
const express = require("express");
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cors = require("cors");
const bodyParser = require("body-parser");

app.use(cors());

// ONLY for create-payment-intent route
app.post("/create-subscription", express.json(), async (req, res) => {
  const { email } = req.body;

  try {
    const customer = await stripe.customers.create({ email });

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ["card"],
    });

    res.send({
      setupIntentClientSecret: setupIntent.client_secret,
      customerId: customer.id,
    });
  } catch (error) {
    console.error("SetupIntent Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/confirm-subscription", express.json(), async (req, res) => {
  console.log("Received body:", req.body);
  const { customerId } = req.body;

  try {
    const customer = await stripe.customers.retrieve(customerId);
    const defaultPaymentMethod = customer.invoice_settings.default_payment_method;
    console.log("default method................", defaultPaymentMethod);

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.PRICE_ID }],
      default_payment_method: defaultPaymentMethod,
      expand: ["latest_invoice"],
    });

    res.json({ success: true, subscriptionId: subscription.id });
  } catch (err) {
    console.error("Subscription Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/cancel-subscription", express.json(), async (req, res) => {
  const { subscriptionId } = req.body;

  try {
    const deletedSubscription = await stripe.subscriptions.cancel(subscriptionId);
    res.json({ success: true, canceledAt: deletedSubscription.canceled_at });
  } catch (error) {
    console.error("Cancel Subscription Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (request, response) => {
  const signature = request.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook Error:", err.message);
    return response.status(400).send(`Webhook Error: ${err.message}`);
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

  response.send();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Payment server running on port ${PORT}`);
});
