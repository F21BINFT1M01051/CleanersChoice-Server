#!/usr/bin/env node
/**
 * scripts/grant-visibility-grace.js
 *
 * Grant a bounded visibility grace to the Apple cleaners whose real entitlement
 * cannot be determined from our own data.
 *
 * WHY THIS COHORT EXISTS
 * An Apple subscriber's `subscriptionEndDate` is only ever advanced by the
 * DID_RENEW notification — `apple-validate` is called at purchase and never
 * again. So any gap in notification delivery strands the date permanently, and
 * the cleaner then looks lapsed whether or not Apple is still charging them.
 * Their stored `subscriptionStatus` is no help: for this cohort it was written
 * in bulk by backfill-subscription-status.js, which derives `expired` from
 * nothing but "the end date is in the past" — circular as evidence.
 *
 * WHAT THE GRACE DOES
 * Sets `Users.visibilityGraceUntil = now + <days>`, which raises the visibility
 * deadline WITHOUT touching `subscriptionEndDate` (so no subscription state is
 * falsified). Then:
 *
 *   - a cleaner who really is paying opens the app, receipt re-validation
 *     advances their real end date, and they stay visible on their own merits
 *   - a cleaner who is not simply drops off when the grace elapses
 *
 * No triage, no follow-up script, no App Store Connect spreadsheet. The deadline
 * mechanism is its own safety valve.
 *
 * It is a FLOOR: a real subscription running past the grace wins, and refunds and
 * disabled accounts ignore it entirely (lib/visibility.js). It also grants app
 * access, deliberately — see the note in src/utils/cleanerVisibility.ts. Visible
 * to customers while locked out of the app is the one state worth avoiding.
 *
 * Usage:
 *   node scripts/grant-visibility-grace.js                  # dry run
 *   node scripts/grant-visibility-grace.js --commit
 *   node scripts/grant-visibility-grace.js --commit --days=21
 *   node scripts/grant-visibility-grace.js --revoke --commit # clear the field
 *
 * Re-runnable: it only ever raises an existing grace, never lowers one, so a
 * second run cannot shorten a window someone is relying on.
 */

try {
  require("dotenv").config();
} catch (err) {
  // dotenv absent — platform supplies env.
}

const REQUIRED_ENV = ["PROJECT_ID", "PRIVATE_KEY", "CLIENT_EMAIL"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`\n❌ Missing env var(s): ${missingEnv.join(", ")} — run from the repo root.\n`);
  process.exit(1);
}

const admin = require("firebase-admin");
const { describeVisibility, syncCleanerVisibility } = require("../lib/visibility");

const COMMIT = process.argv.includes("--commit");
const REVOKE = process.argv.includes("--revoke");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = daysArg ? Number.parseInt(daysArg.split("=")[1], 10) : 14;
const DAY = 24 * 60 * 60 * 1000;
const READ_CHUNK = 200;

if (!Number.isFinite(DAYS) || DAYS < 1 || DAYS > 90) {
  console.error("\n❌ --days must be between 1 and 90.\n");
  process.exit(1);
}

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
const day = (ms) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "-");

/**
 * The cohort. Kept byte-for-byte identical in intent to the filter in
 * scripts/inspect-stale-apple.js so the set you inspected is the set you grant:
 * Apple, no App Store notification has ever landed on the document, renewal was
 * not switched off, and the period elapsed within the last 90 days.
 *
 * Excluded on purpose: `cancelSubscription` cleaners (they chose to leave — no
 * benefit of the doubt is owed), anything older than 90 days (long gone), and
 * every provider except Apple (Stripe's `customer.subscription.updated` keeps
 * end dates current, so a stranded Stripe date means something else is wrong and
 * should be investigated rather than papered over).
 */
const inCohort = (user, now) =>
  user.subscriptionProvider === "apple" &&
  !user.lastWebhookType &&
  !user.cancelSubscription &&
  typeof user.subscriptionEndDate === "number" &&
  user.subscriptionEndDate <= now &&
  now - user.subscriptionEndDate < 90 * DAY;

(async () => {
  const now = Date.now();
  const graceUntil = now + DAYS * DAY;

  console.log(
    `\n${COMMIT ? "🚀 COMMIT MODE — writes will be applied" : "🔍 DRY RUN — no writes (pass --commit to apply)"}`,
  );
  console.log(
    REVOKE
      ? "\nRevoking visibilityGraceUntil for the cohort."
      : `\nGrace: ${DAYS} days → ${new Date(graceUntil).toISOString()}`,
  );

  const snap = await db.collection("Users").where("role", "==", "Cleaner").get();

  const published = new Set();
  for (let i = 0; i < snap.docs.length; i += READ_CHUNK) {
    const slice = snap.docs.slice(i, i + READ_CHUNK);
    const services = await db.getAll(
      ...slice.map((d) => db.collection("CleanerServices").doc(d.id)),
    );
    services.forEach((s, j) => {
      if (s.exists) published.add(slice[j].id);
    });
  }

  const cohort = snap.docs.filter((d) => inCohort(d.data(), now));

  console.log(`\ncohort: ${cohort.length} cleaner(s), ${cohort.filter((d) => published.has(d.id)).length} with a published service\n`);
  console.log("  uid                            svc  ended      currentGrace  ->  newGrace");

  let written = 0;
  let skipped = 0;

  for (const doc of cohort) {
    const user = doc.data();
    const existing =
      typeof user.visibilityGraceUntil === "number" ? user.visibilityGraceUntil : 0;

    // Only ever raise. A re-run must not shorten a window a cleaner is relying on.
    const target = REVOKE ? null : Math.max(existing, graceUntil);
    const changing = REVOKE ? existing > 0 : target > existing;

    console.log(
      `  ${doc.id.padEnd(30)} ${published.has(doc.id) ? "yes" : "no "}  ` +
        `${day(user.subscriptionEndDate)} ${day(existing).padEnd(13)} ->  ` +
        `${REVOKE ? "(cleared)" : day(target)}${changing ? "" : "   [no change]"}`,
    );

    if (!changing) {
      skipped += 1;
      continue;
    }

    if (COMMIT) {
      await doc.ref.update({
        visibilityGraceUntil: REVOKE
          ? admin.firestore.FieldValue.delete()
          : target,
        visibilityGraceGrantedAt: REVOKE
          ? admin.firestore.FieldValue.delete()
          : now,
        visibilityGraceReason: REVOKE
          ? admin.firestore.FieldValue.delete()
          : "apple_stranded_end_date",
      });
      // Recompute and mirror onto CleanerServices so the change takes effect for
      // customers immediately rather than waiting for the nightly sweep.
      await syncCleanerVisibility({ db, admin, userId: doc.id });
    }
    written += 1;
  }

  console.log(
    `\n──────── summary ────────\n` +
      `cohort              ${cohort.length}\n` +
      `${REVOKE ? "cleared" : "granted"}             ${written}${COMMIT ? "" : " (would)"}\n` +
      `unchanged           ${skipped}`,
  );

  if (!REVOKE) {
    console.log(
      `\nThese cleaners are visible and can use the app until ${new Date(graceUntil)
        .toISOString()
        .slice(0, 10)}.\n` +
        `Anyone genuinely subscribed will have their real end date restored by\n` +
        `receipt re-validation before then and stay visible on their own merits.\n` +
        `Check back after that date: whoever is still in "active_grace" in the\n` +
        `reconcile sweep never revalidated, and drops off automatically.`,
    );
  }

  if (!COMMIT) console.log("\nNothing was written.");
  process.exit(0);
})().catch((err) => {
  console.error("\n❌ grant failed:", err);
  process.exit(1);
});
