const admin = require("firebase-admin");
const fetch = require("node-fetch");

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

    // Step 4: Get the latest subscription info
    const latestInfo = data.latest_receipt_info;
    if (!latestInfo || latestInfo.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No subscription found in receipt",
      });
    }

    // Sort by expires_date_ms descending to get the latest
    const latest = latestInfo.sort(
      (a, b) => parseInt(b.expires_date_ms) - parseInt(a.expires_date_ms)
    )[0];

    const expiresMs = parseInt(latest.expires_date_ms, 10);
    const isActive = expiresMs > Date.now();
    const originalTransactionId = latest.original_transaction_id;

    // Step 5: Update Firestore
    await db.collection("Users").doc(uid).update({
      subscription: isActive,
      subscriptionProvider: "apple",
      subscriptionId: latest.transaction_id,
      originalTransactionId: originalTransactionId,
      subscriptionEndDate: expiresMs,
      cancelSubscription: false,
      webhook: false,
    });

    console.log(`✅ Apple subscription validated for user ${uid}`);

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