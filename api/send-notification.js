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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { fcmToken, title, body, data } = req.body;
    const { screen } = data || {};

    if (!fcmToken || !title || !body) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const message = {
      token: fcmToken,
      notification: { title, body },
      data: { screen: screen || '' },
      android: {
        priority: "high",
        notification: {
          channel_id: "default",
          sound: "default",
        },
      },
    };

    await admin.messaging().send(message);
    return res.status(200).json({ success: "Notification sent!" });
  } catch (error) {
    console.error("Error sending notification:", error);
    return res.status(500).json({ error: "Server error" });
  }
}
