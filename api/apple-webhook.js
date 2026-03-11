const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      type: process.env.TYPE,
      project_id: process.env.PROJECT_ID,
      private_key_id: process.env.PRIVATE_KEY_ID,
      private_key: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"),
      client_email: process.env.CLIENT_EMAIL,
      client_id: process.env.CLIENT_ID,
      auth_uri: process.env.AUTH_URI,
      token_uri: process.env.TOKEN_URI,
      auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_CERT_URL,
      client_x509_cert_url: process.env.CLIENT_CERT_URL,
    }),
  });
}

const db = admin.firestore();

function decodeSignedPayload(signedPayload) {
  const parts = signedPayload.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  // Always respond 200 to Apple — they retry if you return errors
  res.status(200).end();

  try {
    const notification = req.body;

    // V2 notifications have signedPayload at root level
    const signedPayload = notification.signedPayload;
    if (!signedPayload) {
      console.log("No signedPayload in webhook");
      return;
    }

    // Decode the outer payload
    const outerPayload = decodeSignedPayload(signedPayload);
    const notificationType = outerPayload.notificationType;
    const subtype = outerPayload.subtype;

    // The transaction info is nested inside data.signedTransactionInfo
    const signedTransactionInfo = outerPayload.data?.signedTransactionInfo;
    if (!signedTransactionInfo) {
      console.log("No signedTransactionInfo");
      return;
    }

    const transaction = decodeSignedPayload(signedTransactionInfo);
    const originalTransactionId = transaction.originalTransactionId;
    const expiresDate = transaction.expiresDate; // already in ms for V2

    console.log(
      `Apple webhook: ${notificationType} / ${subtype} for ${originalTransactionId}`,
    );

    // Find user by originalTransactionId
    const snap = await db
      .collection("Users")
      .where("originalTransactionId", "==", originalTransactionId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.error(
        `No user found for originalTransactionId: ${originalTransactionId}`,
      );
      return;
    }

    const userDoc = snap.docs[0];

    // Handle notification types
    switch (notificationType) {
      case "DID_RENEW": 
      case "SUBSCRIBED": 
      case "DID_RECOVER": 
        await userDoc.ref.update({
          subscription: true,
          subscriptionEndDate: expiresDate,
          cancelSubscription: false,
          webhook: true,
        });
        console.log(` Subscription renewed for ${userDoc.id}`);
        break;

      case "EXPIRED": //  Subscription expired (not renewed)
      case "DID_FAIL_TO_RENEW": // Billing retry failed
        await userDoc.ref.update({
          subscription: false,
          cancelSubscription: true,
          webhook: true,
        });
        console.log(`Subscription expired for ${userDoc.id}`);
        break;

      case "CANCEL": //  User cancelled (still active until period end)
        await userDoc.ref.update({
          cancelSubscription: true,
          subscriptionEndDate: expiresDate,
          webhook: true,
        });
        console.log(`Subscription cancelled for ${userDoc.id}`);
        break;

      case "REFUND": //  Apple issued a refund
        await userDoc.ref.update({
          subscription: false,
          cancelSubscription: true,
          webhook: true,
        });
        console.log(`Subscription refunded for ${userDoc.id}`);
        break;

      // In your webhook switch statement, add:

      case "DID_CHANGE_RENEWAL_STATUS":
        if (subtype === "AUTO_RENEW_DISABLED") {
          await userDoc.ref.update({
            cancelSubscription: true,
            subscriptionEndDate: expiresDate,
            webhook: true,
          });
          console.log(` Auto-renew disabled for ${userDoc.id}`);
        } else if (subtype === "AUTO_RENEW_ENABLED") {
          // User re-enabled auto-renew
          await userDoc.ref.update({
            cancelSubscription: false,
            webhook: true,
          });
          console.log(` Auto-renew re-enabled for ${userDoc.id}`);
        }
        break;

      case "GRACE_PERIOD_EXPIRED":
        await userDoc.ref.update({
          subscription: false,
          cancelSubscription: true,
          webhook: true,
        });
        console.log(`Grace period expired for ${userDoc.id}`);
        break;

      default:
        console.log(`Unhandled notification type: ${notificationType}`);
    }
  } catch (error) {
    console.error("Apple webhook error:", error);
  }
};
