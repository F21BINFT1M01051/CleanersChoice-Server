const admin = require("firebase-admin");
const fetch = require("node-fetch");

const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const { receipt, uid } = req.body;

  if (!receipt || !uid) {
    return res.status(400).json({ error: "missing data" });
  }

  try {
    const response = await fetch("https://buy.itunes.apple.com/verifyReceipt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "receipt-data": receipt,
        password: '98d2743b685b48bf898963a289e260af',
        "exclude-old-transactions": true,
      }),
    });

    const data = await response.json();

    // handle sandbox auto redirect
    if (data.status === 21007) {
      const sandbox = await fetch(
        "https://sandbox.itunes.apple.com/verifyReceipt",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "receipt-data": receipt,
            password: '98d2743b685b48bf898963a289e260af',
            "exclude-old-transactions": true,
          }),
        }
      );
      Object.assign(data, await sandbox.json());
    }

    if (data.status !== 0) {
      return res.status(400).json({ error: "invalid receipt" });
    }

    const latest = data.latest_receipt_info?.pop();
    if (!latest) {
      return res.status(400).json({ error: "no subscription" });
    }

    const expires = parseInt(latest.expires_date_ms, 10);

    await db.collection("Users").doc(uid).update({
      subscription: expires > Date.now(),
      subscriptionProvider: "apple",
      originalTransactionId: latest.original_transaction_id,
      subscriptionId: latest.transaction_id,
      subscriptionEndDate: expires,
      cancelSubscription: false,
      webhook: false,
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.log(e);
    return res.status(500).json({ error: e.message });
  }
};
