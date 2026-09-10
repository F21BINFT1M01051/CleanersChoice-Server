const admin = require("firebase-admin");
const {
  APPLE_PAYMENT_NOTIFICATIONS,
  appleMilliunitsToMinor,
  decodeSignedPayload,
  deriveAppleUpdate,
  recordPayment,
  sanitize,
} = require("../lib/subscriptions");
const { syncCleanerVisibility } = require("../lib/visibility");

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

/**
 * Locate the Users doc for an Apple transaction.
 *
 * The original implementation only matched `originalTransactionId`, which the
 * CLIENT writes after /api/apple-validate returns. Apple's SUBSCRIBED
 * notification can arrive before that write lands, so the lookup missed and the
 * notification was discarded. We now try several keys in order of reliability.
 */
async function findUserDoc({ originalTransactionId, transactionId, appAccountToken }) {
  const attempts = [
    // Most reliable when present: set by the client at purchase time and never
    // dependent on any prior server write.
    appAccountToken && ["appAccountToken", appAccountToken],
    originalTransactionId && ["originalTransactionId", originalTransactionId],
    // Fallbacks for docs written before originalTransactionId existed, or where
    // only the latest transaction id was persisted.
    transactionId && ["originalTransactionId", transactionId],
    transactionId && ["subscriptionId", transactionId],
  ].filter(Boolean);

  for (const [field, value] of attempts) {
    const snap = await db
      .collection("Users")
      .where(field, "==", value)
      .limit(1)
      .get();

    if (!snap.empty) {
      console.log(`Matched user via ${field} = ${value}`);
      return snap.docs[0];
    }
  }

  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method Not Allowed");
  }

  // IMPORTANT: never send the response before the Firestore work is done.
  // Vercel freezes the invocation as soon as the response stream closes, so any
  // pending await after res.end() is killed and the DB write silently vanishes.
  try {
    // V2 notifications have signedPayload at root level
    const signedPayload = req.body?.signedPayload;
    if (!signedPayload) {
      // Structural mismatch (e.g. Version 1 notifications are configured in
      // App Store Connect). Retrying will never help, so 200 is correct here.
      console.log("No signedPayload in webhook");
      return res.status(200).send("No signedPayload");
    }

    const outerPayload = decodeSignedPayload(signedPayload);
    const { notificationType, subtype } = outerPayload;

    // The transaction info is nested inside data.signedTransactionInfo
    const signedTransactionInfo = outerPayload.data?.signedTransactionInfo;
    if (!signedTransactionInfo) {
      console.log(`No signedTransactionInfo for ${notificationType}`);
      return res.status(200).send("No transaction info");
    }

    const transaction = decodeSignedPayload(signedTransactionInfo);

    // 🆕 Renewal info carries gracePeriodExpiresDate, autoRenewStatus,
    // isInBillingRetryPeriod and renewalPrice — needed to tell "overdue" apart
    // from "expired". Decoded defensively: a malformed renewal block must not
    // abort an otherwise valid transaction update.
    let renewal = null;
    const signedRenewalInfo = outerPayload.data?.signedRenewalInfo;
    if (signedRenewalInfo) {
      try {
        renewal = decodeSignedPayload(signedRenewalInfo);
      } catch (err) {
        console.warn("Could not decode signedRenewalInfo:", err.message);
      }
    }

    const originalTransactionId = String(transaction.originalTransactionId);
    const transactionId = transaction.transactionId
      ? String(transaction.transactionId)
      : null;

    console.log(
      `Apple webhook: ${notificationType}/${subtype ?? "-"} for ${originalTransactionId}`,
    );

    const userDoc = await findUserDoc({
      originalTransactionId,
      transactionId,
      appAccountToken: transaction.appAccountToken ?? null,
    });

    if (!userDoc) {
      console.error(
        `No user found for originalTransactionId: ${originalTransactionId}`,
      );
      // 🆕 Was 200, which told Apple "delivered" and permanently discarded the
      // notification. 500 puts it back into Apple's retry schedule (~3 days of
      // backoff), which covers the first-purchase race where the client hasn't
      // written originalTransactionId yet.
      return res.status(500).send("User not found — retry requested");
    }

    const updateData = deriveAppleUpdate({
      notificationType,
      subtype,
      transaction,
      renewal,
    });

    if (!updateData) {
      console.log(`Unhandled notification type: ${notificationType}`);
    }

    // Always stamp the audit fields, even for unhandled types. Their presence
    // on a user doc is the fastest way to confirm delivery is working at all.
    await userDoc.ref.update(
      sanitize({
        ...(updateData || {}),
        subscriptionProvider: "apple",
        subscriptionId: String(transaction.transactionId ?? ""),
        webhook: true,
        lastWebhookType: notificationType,
        lastWebhookSubtype: subtype ?? null,
        lastWebhookAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(updateData ? { subscriptionUpdatedAt: Date.now() } : {}),
      }),
    );
    console.log(
      `Updated ${userDoc.id} -> ${notificationType}/${subtype ?? "-"}`,
    );

    // Re-derive the customer-facing visibility deadline from the post-update
    // document. Runs for every notification type, including the ones that
    // produced no subscription change, because it is cheap and it means a doc
    // repaired by an earlier failure gets picked up on the next notification.
    // Never throws.
    await syncCleanerVisibility({ db, admin, userId: userDoc.id });

    // 🆕 Payment history for money actually collected. Apple reports `price` in
    // milliunits (4990 => $4.99) and only on notifications generated from
    // ~Dec 2023 onward, so this is skipped silently when absent rather than
    // storing a zero-value row.
    if (APPLE_PAYMENT_NOTIFICATIONS.has(notificationType)) {
      const amount = appleMilliunitsToMinor(transaction.price);
      if (amount === null) {
        console.log(
          `No price on ${notificationType} for ${originalTransactionId} — payment row skipped`,
        );
      } else {
        await recordPayment({
          db,
          admin,
          userId: userDoc.id,
          provider: "apple",
          reference: transactionId || originalTransactionId,
          amount,
          currency: transaction.currency,
          paidAt: transaction.purchaseDate,
          productId: transaction.productId ?? null,
          transactionId,
          periodStart: transaction.purchaseDate ?? null,
          periodEnd: transaction.expiresDate ?? null,
          environment: transaction.environment ?? null,
        });
      }
    }

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Apple webhook error:", error);
    // 🆕 Was 200, which silently dropped transient failures (Firestore blip,
    // cold-start timeout). 500 lets Apple retry.
    return res.status(500).send("Error — retry requested");
  }
};
