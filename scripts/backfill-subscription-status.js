#!/usr/bin/env node
/**
 * scripts/backfill-subscription-status.js
 *
 * One-off migration: give existing users a `subscriptionStatus` derived from the
 * legacy fields they already have. Run once after deploying the webhook changes.
 *
 * Safety properties:
 *  - DRY RUN BY DEFAULT. Pass --commit to actually write.
 *  - Skips any user that already has `subscriptionStatus` (webhooks win).
 *  - Only ever ADDS `subscriptionStatus` + `subscriptionUpdatedAt`. It never
 *    touches `subscription`, `subscriptionEndDate`, `cancelSubscription`,
 *    `subscriptionId`, `originalTransactionId` or anything else — so it cannot
 *    change any existing user's access.
 *  - Conservative derivation: ambiguous cases resolve to `active`, never to a
 *    state that would look like a lapsed subscriber.
 *
 * Usage:
 *   node scripts/backfill-subscription-status.js              # dry run
 *   node scripts/backfill-subscription-status.js --commit     # write
 *   node scripts/backfill-subscription-status.js --commit --role=Cleaner
 *
 * Requires the same service-account env vars the API endpoints use. Load them
 * from .env when running locally:
 *   node -r dotenv/config scripts/backfill-subscription-status.js
 */

const admin = require("firebase-admin");
const { deriveLegacyStatus } = require("../lib/subscriptions");

const COMMIT = process.argv.includes("--commit");
const roleArg = process.argv.find((a) => a.startsWith("--role="));
const ROLE = roleArg ? roleArg.split("=")[1] : null;
const BATCH_SIZE = 400; // Firestore batches cap at 500 writes

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
    `\n${COMMIT ? "🚀 COMMIT MODE — writes will be applied" : "🔍 DRY RUN — no writes (pass --commit to apply)"}`,
  );
  if (ROLE) console.log(`Filtering to role = ${ROLE}`);

  const snap = await db.collection("Users").get();
  console.log(`Scanned ${snap.size} user documents\n`);

  const counts = {};
  const planned = [];
  let alreadySet = 0;
  let skippedRole = 0;

  snap.forEach((doc) => {
    const user = doc.data() || {};

    if (ROLE && user.role !== ROLE) {
      skippedRole++;
      return;
    }
    // Webhooks are the source of truth — never overwrite what they wrote.
    if (typeof user.subscriptionStatus === "string" && user.subscriptionStatus) {
      alreadySet++;
      return;
    }

    const status = deriveLegacyStatus(user);
    counts[status] = (counts[status] || 0) + 1;

    // Flag the genuinely ambiguous ones (legacy Apple docs with no end date)
    const ambiguous =
      typeof user.subscriptionEndDate !== "number" &&
      (!!user.subscription || !!user.subscriptionId);

    planned.push({ id: doc.id, status, ambiguous, email: user.email || "" });
  });

  console.log("Derived status distribution:");
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${v}`));
  console.log(`  ${"(already set)".padEnd(12)} ${alreadySet}`);
  if (ROLE) console.log(`  ${"(other role)".padEnd(12)} ${skippedRole}`);

  const ambiguousOnes = planned.filter((p) => p.ambiguous);
  if (ambiguousOnes.length) {
    console.log(
      `\n⚠️  ${ambiguousOnes.length} user(s) have no subscriptionEndDate (typically older Apple`,
    );
    console.log(
      "    subscribers whose end date was never written client-side). They are being",
    );
    console.log(
      "    set from the `subscription` flag alone. Their real state will self-correct",
    );
    console.log("    on the next Apple notification. Sample:");
    ambiguousOnes.slice(0, 10).forEach((p) => {
      console.log(`      ${p.id}  ${p.status}  ${p.email}`);
    });
  }

  if (!COMMIT) {
    console.log(`\n🔍 Dry run complete — ${planned.length} document(s) would be updated.`);
    console.log("   Re-run with --commit to apply.\n");
    return;
  }

  let written = 0;
  for (let i = 0; i < planned.length; i += BATCH_SIZE) {
    const chunk = planned.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    chunk.forEach(({ id, status }) => {
      batch.update(db.collection("Users").doc(id), {
        subscriptionStatus: status,
        subscriptionUpdatedAt: Date.now(),
      });
    });

    await batch.commit();
    written += chunk.length;
    console.log(`  committed ${written}/${planned.length}`);
  }

  console.log(`\n✅ Backfill complete — ${written} document(s) updated.\n`);
})().catch((err) => {
  console.error("\n❌ Backfill failed:", err);
  process.exit(1);
});
