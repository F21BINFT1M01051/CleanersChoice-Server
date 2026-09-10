#!/usr/bin/env node
/**
 * scripts/set-admin-claim.js
 *
 * Mint the `admin` custom claim from the existing `Users.admin` boolean.
 *
 * WHY THIS IS NEEDED
 * firestore.rules gates the admin exemption on `request.auth.token.admin`, not
 * on the Firestore flag. Reading the flag from inside a rule means a `get()` per
 * document evaluated, and Firestore caps a multi-document read at 20 access
 * calls — so an admin opening AdminCleanerServices with more than ~20 hidden
 * cleaners would be denied outright, which is precisely the screen that exists
 * to show hidden cleaners. A custom claim costs nothing and has no such cap.
 *
 * The Firestore boolean stays the source of truth for the APP (useIsAdmin()
 * still reads it); this only mirrors it into the token so rules can see it.
 *
 * The claim lands in the user's ID token on their next token refresh (within an
 * hour, or immediately after `getIdToken(true)` / a fresh sign-in).
 *
 * Usage:
 *   node scripts/set-admin-claim.js                  # dry run, all flagged users
 *   node scripts/set-admin-claim.js --commit
 *   node scripts/set-admin-claim.js <uid> --commit   # one user
 *   node scripts/set-admin-claim.js <uid> --revoke --commit
 *
 * Re-runnable. Existing claims are merged, not replaced, so nothing else in the
 * token is disturbed.
 */

// Load .env automatically so plain `node scripts/<name>.js` works, not just
// `node -r dotenv/config scripts/<name>.js`. dotenv is already a dependency,
// and config() is a no-op when the variables are already set (CI, Vercel).
try {
  require("dotenv").config();
} catch (err) {
  // dotenv not installed (production-only install) — the platform supplies env.
}

// Fail with something readable instead of "Cannot read properties of undefined
// (reading 'replace')" fifteen lines further down.
const REQUIRED_ENV = ["PROJECT_ID", "PRIVATE_KEY", "CLIENT_EMAIL"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(
    [
      "",
      `\u274c Missing service-account environment variable(s): ${missingEnv.join(", ")}`,
      "",
      `   Looked for a .env file at: ${require("path").resolve(process.cwd(), ".env")}`,
      "   Run this from the repository root, or point dotenv at the file:",
      "     node -r dotenv/config scripts/<name>.js dotenv_config_path=/path/to/.env",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const REVOKE = args.includes("--revoke");
const TARGET_UID = args.find((a) => !a.startsWith("--")) || null;

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
const auth = admin.auth();

const apply = async (uid, value) => {
  const user = await auth.getUser(uid);
  const existing = user.customClaims || {};

  if (!!existing.admin === value) {
    console.log(`  ${uid}  already ${value ? "admin" : "not admin"} — skipped`);
    return false;
  }

  if (COMMIT) {
    // Merge: never clobber claims this script does not own.
    await auth.setCustomUserClaims(uid, { ...existing, admin: value });
  }
  console.log(
    `  ${uid}  admin=${value}${COMMIT ? " ✅ written" : " (dry run)"}`,
  );
  return true;
};

(async () => {
  console.log(
    `\n${
      COMMIT
        ? "🚀 COMMIT MODE — claims will be written"
        : "🔍 DRY RUN — no writes (pass --commit to apply)"
    }`,
  );

  let changed = 0;

  if (TARGET_UID) {
    console.log(`\nTarget: ${TARGET_UID} -> admin=${!REVOKE}\n`);
    changed += (await apply(TARGET_UID, !REVOKE)) ? 1 : 0;
  } else {
    if (REVOKE) {
      console.error("\n--revoke requires an explicit uid. Refusing to bulk-revoke.");
      process.exit(1);
    }
    const snap = await db.collection("Users").where("admin", "==", true).get();
    console.log(`\nFound ${snap.size} user(s) with Users.admin == true\n`);
    for (const doc of snap.docs) {
      try {
        changed += (await apply(doc.id, true)) ? 1 : 0;
      } catch (err) {
        console.error(`  ${doc.id}  ❌ ${err.message}`);
      }
    }
  }

  console.log(
    `\n${changed} claim(s) ${COMMIT ? "written" : "would be written"}.`,
  );
  if (COMMIT && changed > 0) {
    console.log(
      "Affected admins must refresh their ID token — sign out and back in, or wait up to an hour.",
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error("\n❌ set-admin-claim failed:", err);
  process.exit(1);
});
