require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === "POST") {
    const { subscriptionId } = req.body;

    try {
      const deletedSubscription = await stripe.subscriptions.cancel(subscriptionId);
      res.status(200).json({ success: true, canceledAt: deletedSubscription.canceled_at });
    } catch (error) {
      console.error("Cancel Subscription Error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  } else {
    res.status(405).json({ message: "Method Not Allowed" });
  }
};
