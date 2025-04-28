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
      // Attach payment method to customer (if not already)
      await stripe.paymentMethods.attach(paymentMethod, {
        customer: customerId,
      });
      // Set default payment method for customer
      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethod,
        },
      });
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: process.env.PRICE_ID }],
        default_payment_method: paymentMethod,
        expand: ["latest_invoice"], 
      });
      const subscriptionEndDate = subscription.current_period_end * 1000;

      res.status(200).json({ success: true, subscriptionId: subscription.id ,  subscriptionEndDate,});
    } catch (err) {
      console.error("Subscription Error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  } else {
    res.status(405).json({ message: "Method Not Allowed" });
  }
};