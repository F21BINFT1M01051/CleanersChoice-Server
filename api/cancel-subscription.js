require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, message: "Method Not Allowed" });
    }

    const { subscriptionId } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({ success: false, message: "subscriptionId is required" });
    }

    // Mark subscription to cancel at end of current billing cycle
    const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    return res.status(200).json({
      success: true,
      cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
      currentPeriodEnd: updatedSubscription.current_period_end * 1000, // Convert to ms
    });
  } catch (error) {
    console.error("Cancel Subscription Error:", error);
    return res.status(500).json({ success: false, message: error.message || "Internal Server Error" });
  }
};
