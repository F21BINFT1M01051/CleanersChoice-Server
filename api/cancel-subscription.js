require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, message: "Method Not Allowed" });
    }

    const { subscriptionId } = req.body;

    const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    return res.status(200).json({
      success: true,
      canceledAt: updatedSubscription.canceled_at, 
      currentPeriodEnd: updatedSubscription.current_period_end,
    });
  } catch (error) {
    console.error("Cancel Subscription Error:", error);
    return res.status(500).json({ success: false, message: error.message || "Internal Server Error" });
  }
};
