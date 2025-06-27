const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const { customerId, setupIntentId } = req.body;

  try {
    // Retrieve SetupIntent to get payment method
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    const paymentMethod = setupIntent.payment_method;

    if (!paymentMethod) {
      throw new Error("No payment method found on SetupIntent");
    }

    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethod, { customer: customerId });

    // Set as default
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethod },
    });

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.PRICE_ID }],
      default_payment_method: paymentMethod,
      expand: ['latest_invoice.payment_intent'],
    });

    console.log("Initial subscription object:", subscription);

    // If payment failed
    const invoice = subscription.latest_invoice;
    if (!invoice || invoice.status !== 'paid') {
      return res.status(400).json({
        success: false,
        message: `Payment failed: ${invoice?.status || 'Unknown'}`,
      });
    }

    // Optional: wait a short time before retrieving full subscription
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Retrieve complete subscription again to ensure all fields are populated
    const fullSub = await stripe.subscriptions.retrieve(subscription.id);

    const periodEndTimestamp = fullSub.current_period_end
      ? fullSub.current_period_end * 1000
      : null;

    return res.status(200).json({
      success: true,
      subscriptionId: fullSub.id,
      periodEndTimestamp,
      subscriptionStatus: fullSub.status,
    });
  } catch (err) {
    console.error("Subscription Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
