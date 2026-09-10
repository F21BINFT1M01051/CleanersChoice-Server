const admin = require("firebase-admin");
const { SUBSCRIPTION_STATUS, sanitize } = require("../lib/subscriptions");
const { syncCleanerVisibility } = require("../lib/visibility");

// Initialize Firebase Admin (same pattern as your webhook)
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

const PRODUCTION_URL = "https://buy.itunes.apple.com/verifyReceipt";
const SANDBOX_URL = "https://sandbox.itunes.apple.com/verifyReceipt";

async function verifyWithApple(receiptData, useSandbox = false) {
  const url = useSandbox ? SANDBOX_URL : PRODUCTION_URL;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "receipt-data": receiptData,
      password: process.env.APPLE_SHARED_SECRET,
      "exclude-old-transactions": true,
    }),
  });
  return response.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const { receipt, uid } = req.body;

  if (!receipt || !uid) {
    return res.status(400).json({ error: "Missing receipt or uid" });
  }

  try {
    // Step 1: Try production first
    let data = await verifyWithApple(receipt, false);
    console.log("Initial Apple response:", data);

    // Step 2: If Apple says it's a sandbox receipt, retry sandbox
    if (data.status === 21007) {
      console.log("Sandbox receipt detected, retrying sandbox...");
      data = await verifyWithApple(receipt, true);
    }

    // Step 3: Validate status
    if (data.status !== 0) {
      console.error("Apple receipt validation failed, status:", data.status);
      return res.status(400).json({
        success: false,
        error: "Invalid receipt",
        status: data.status,
      });
    }

    console.log("data...............", data);

    // Step 4: Get the latest subscription info
    const latestInfo = data.latest_receipt_info || data.receipt?.in_app || [];
    console.log("Latest receipt info:", latestInfo);
    if (!latestInfo || latestInfo.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No subscription found in receipt",
      });
    }

    // Sort by expires_date_ms descending to get the latest
    const latest = latestInfo.sort(
      (a, b) => parseInt(b.expires_date_ms) - parseInt(a.expires_date_ms),
    )[0];

    if (latest.product_id !== "cleaner.premium.monthly.V1") {
      return res.status(400).json({
        success: false,
        error: "Product ID mismatch. Invalid subscription.",
      });
    }

    const expiresMs = parseInt(latest.expires_date_ms, 10);
    const isActive = expiresMs > Date.now();
    const originalTransactionId = latest.original_transaction_id;

    // Step 5: Update Firestore
    // Existing writes are unchanged. The only additions are subscriptionStatus
    // and subscriptionUpdatedAt, so the receipt-validation contract and every
    // legacy field behave exactly as before.
    await db.collection("Users").doc(uid).update(
      sanitize({
        subscription: isActive,
        subscriptionProvider: "apple",
        subscriptionId: latest.transaction_id,
        originalTransactionId: originalTransactionId,
        subscriptionEndDate: expiresMs,
        cancelSubscription: false,
        webhook: false,
        // 🆕 new source of truth
        subscriptionStatus: isActive
          ? SUBSCRIPTION_STATUS.ACTIVE
          : SUBSCRIPTION_STATUS.EXPIRED,
        subscriptionUpdatedAt: Date.now(),
      }),
    );

    console.log(`✅ Apple subscription validated for user ${uid}`);

    // This is the FIRST write of a real subscriptionEndDate for a new Apple
    // purchase — the notification can arrive later, or not at all if the App
    // Store Connect notification version is misconfigured. Stamping visibility
    // here is what makes a brand-new cleaner's services appear immediately
    // rather than waiting on a webhook that may never land. Never throws.
    await syncCleanerVisibility({ db, admin, userId: uid });

    // NOTE: no Payments row is written here on purpose. The legacy verifyReceipt
    // response carries no price, so recording one would either invent an amount
    // or store a zero. Apple's SUBSCRIBED notification fires for the same
    // purchase and does carry `price`/`currency`, and it writes the row
    // idempotently — so the initial payment is captured there instead.

    return res.status(200).json({
      success: true,
      isActive,
      expiresDate: expiresMs,
      originalTransactionId,
    });
  } catch (error) {
    console.error("Apple validate error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
