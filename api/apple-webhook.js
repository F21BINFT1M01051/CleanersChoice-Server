const admin = require("firebase-admin");
const db = admin.firestore();

module.exports = async (req, res) => {
  try {
    const notification = req.body;

    const signedInfo = notification.data?.signedTransactionInfo;
    if (!signedInfo) return res.status(200).end();

    // in production decode JWT properly
    const payload = JSON.parse(
      Buffer.from(signedInfo.split(".")[1], "base64").toString()
    );

    const originalId = payload.originalTransactionId;
    const expires = parseInt(payload.expiresDate, 10);

    const snap = await db
      .collection("Users")
      .where("originalTransactionId", "==", originalId)
      .limit(1)
      .get();

    if (!snap.empty) {
      const doc = snap.docs[0];

      await doc.ref.update({
        subscription: expires > Date.now(),
        subscriptionEndDate: expires,
        webhook: true,
      });
    }

    res.status(200).end();
  } catch (e) {
    console.log(e);
    res.status(200).end();
  }
};
