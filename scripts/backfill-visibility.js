#!/usr/bin/env node
/**
 * scripts/backfill-visibility.js
 *
 * One-off migration: stamp `visibleUntil` onto every Cleaner's `Users` doc and
 * their `CleanerServices` doc.
 *
 * THIS MUST RUN BEFORE the app ships the `where('visibleUntil','>',now)` query
 * or the Firestore rule goes live. Documents written before the field existed
 * have no `visibleUntil` at all, and Firestore inequality filters silently skip
 * documents that are missing the field — so enforcing first would make EVERY
 * cleaner disappear from the customer side at once.
 *
 * Safety properties:
 *  - DRY RUN BY DEFAULT. Pass --commit to write.
 *  - Only ever writes `visibleUntil`, `visibilityReason`, `visibilityUpdatedAt`.
 *    It never touches `subscription`, `subscriptionEndDate`, `subscriptionStatus`,
 *    `cancelSubscription` or anything else, so it cannot change anyone's access.
 *  - The value is computed by the same `computeVisibleUntil()` the webhooks use,
 *    so the backfill and live traffic cannot disagree.
 *  - Idempotent. Re-running writes nothing once values match.
 *
 * Usage:
 *   node scripts/backfill-visibility.js                 # dry run
 *   node scripts/backfill-visibility.js --commit
 *   node scripts/backfill-visibility.js --commit --verbose
 *
 * The dry run prints how many cleaners would be visible vs hidden. Read that
 * number before committing: if "hidden" is implausibly high, the cause is
 * missing `subscriptionEndDate` values, not this script, and enforcing would
 * hide real paying cleaners.
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
const { computeVisibleUntil, describeVisibility } = require("../lib/visibility");

const COMMIT = process.argv.includes("--commit");
const VERBOSE = process.argv.includes("--verbose");
const BATCH_SIZE = 400; // Firestore batches cap at 500 writes
const READ_CHUNK = 200; // documents per getAll() round trip

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

(async () => {
  console.log(
    `\n${
      COMMIT
        ? "🚀 COMMIT MODE — writes will be applied"
        : "🔍 DRY RUN — no writes (pass --commit to apply)"
    }`,
  );

  const now = Date.now();
  const cleaners = await db.collection("Users").where("role", "==", "Cleaner").get();
  const docs = cleaners.docs;
  console.log(`Found ${docs.length} cleaner(s)\n`);

  const reasons = {};
  let visible = 0;
  let hidden = 0;
  let userWrites = 0;
  let serviceWrites = 0;
  let servicesAbsent = 0;

  let batch = db.batch();
  let pending = 0;

  const flush = async () => {
    if (COMMIT && pending > 0) await batch.commit();
    batch = db.batch();
    pending = 0;
  };

  // The services documents are read with getAll() in chunks rather than one
  // `.get()` per cleaner. At a thousand cleaners the sequential version is a
  // thousand serial round trips — minutes of apparent hang with no output —
  // while this is a handful of batched reads.
  for (let i = 0; i < docs.length; i += READ_CHUNK) {
    const slice = docs.slice(i, i + READ_CHUNK);
    const serviceSnaps = await db.getAll(
      ...slice.map((doc) => db.collection("CleanerServices").doc(doc.id)),
    );

    for (let j = 0; j < slice.length; j += 1) {
      const doc = slice[j];
      const serviceSnap = serviceSnaps[j];
      const user = doc.data();

      const visibleUntil = computeVisibleUntil(user);
      const reason = describeVisibility(user, now);

      reasons[reason] = (reasons[reason] || 0) + 1;
      if (visibleUntil > now) visible += 1;
      else hidden += 1;

      const payload = {
        visibleUntil,
        visibilityReason: reason,
        visibilityUpdatedAt: now,
      };

      if (VERBOSE) {
        console.log(
          `  ${doc.id}  until=${visibleUntil}  ${reason}  (was ${
            user.visibleUntil ?? "unset"
          })`,
        );
      }

      if (user.visibleUntil !== visibleUntil) {
        batch.update(doc.ref, payload);
        pending += 1;
        userWrites += 1;
      }

      // Checked independently of the Users mirror: a cleaner who published
      // after their last subscription event has a correct Users value and a
      // missing services value, and only this catches that.
      if (!serviceSnap.exists) {
        servicesAbsent += 1;
      } else if (serviceSnap.data()?.visibleUntil !== visibleUntil) {
        batch.update(serviceSnap.ref, payload);
        pending += 1;
        serviceWrites += 1;
      }

      if (pending >= BATCH_SIZE) await flush();
    }

    if (!VERBOSE) {
      const done = Math.min(i + READ_CHUNK, docs.length);
      process.stdout.write(`  scanned ${done}/${docs.length}\r`);
    }
  }

  await flush();
  if (!VERBOSE) process.stdout.write("\n");

  console.log("\n──────── summary ────────");
  console.log(`cleaners scanned      ${docs.length}`);
  console.log(`visible right now     ${visible}`);
  console.log(`hidden right now      ${hidden}`);
  console.log(`Users writes          ${userWrites}${COMMIT ? "" : " (would)"}`);
  console.log(`Services writes       ${serviceWrites}${COMMIT ? "" : " (would)"}`);
  console.log(`Services absent       ${servicesAbsent} (cleaner never published)`);
  console.log("\nby reason:");
  Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) =>
      console.log(`  ${String(count).padStart(5)}  ${reason}`),
    );

  if (!COMMIT) {
    console.log(
      "\nNothing was written. Re-run with --commit once the visible/hidden split looks right.",
    );
  }

  process.exit(0);
})().catch((err) => {
  console.error("\n❌ backfill failed:", err);
  process.exit(1);
});
