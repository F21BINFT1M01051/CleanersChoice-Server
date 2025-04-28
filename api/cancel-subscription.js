require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, message: "Method Not Allowed" });
    }

    const { subscriptionId } = req.body;

    const deletedSubscription = await stripe.subscriptions.cancel(subscriptionId);
    return res.status(200).json({ success: true, canceledAt: deletedSubscription.canceled_at });

  } catch (error) {
    console.error("Cancel Subscription Error:", error);
    return res.status(500).json({ success: false, message: error.message || 'Internal Server Error' });
  }
};
