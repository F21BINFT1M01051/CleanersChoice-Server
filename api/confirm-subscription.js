const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === "POST") {
    const { customerId, setupIntentId } = req.body;
    try {
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      const paymentMethod = setupIntent.payment_method;
      if (!paymentMethod) {
        throw new Error("No payment method found on SetupIntent");
      }

      // Attach the payment method to the customer
      await stripe.paymentMethods.attach(paymentMethod, {
        customer: customerId,
      });

      // Set as default payment method
      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethod,
        },
      });

      // Create the subscription
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: process.env.PRICE_ID }],
        default_payment_method: paymentMethod,
        expand: ["latest_invoice.payment_intent"], // 👈 expand intent to check status
      });

      console.log("Subscription object:", subscription);

      // Check if the payment was successful
      const invoice = subscription.latest_invoice;
      if (!invoice || invoice.status !== "paid") {
        return res.status(400).json({
          success: false,
          message: `Payment failed: ${invoice?.status || "Unknown"}`,
        });
      }

      // ✅ Payment succeeded
      const periodEndTimestamp = subscription.current_period_end * 1000;

      return res.status(200).json({
        success: true,
        subscriptionId: subscription.id,
        periodEndTimestamp,
        subscriptionStatus: subscription.status,
      });
    } catch (err) {
      console.error("Subscription Error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  } else {
    res.status(405).json({ message: "Method Not Allowed" });
  }
};
