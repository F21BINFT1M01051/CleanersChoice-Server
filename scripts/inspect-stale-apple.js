#!/usr/bin/env node
/**
 * scripts/inspect-stale-apple.js
 *
 * READ-ONLY. Forensics on the Apple cleaners whose paid period has elapsed but
 * whose documents carry no App Store notification.
 *
 * The question this answers: were they written off by something AUTHORITATIVE
 * (Apple's own receipt validation, or a notification) or merely DERIVED by the
 * backfill-subscription-status script, which sets `expired` from nothing more
 * than "end date is in the past" and is therefore circular as evidence?
 *
 * Two signals separate them:
 *
 *  - `subscriptionStatus === 'active'` on an elapsed period, BUT ONLY IF the
 *    status was written AFTER the period ended (`subscriptionUpdatedAt >
 *    subscriptionEndDate`). Without that guard the signal is worthless: the
 *    backfill derives `active` from a date that was still in the future when it
 *    ran, and the period elapses later — which looks identical but means
 *    nothing. Corrected 2026-09-10 after the first version of this script
 *    reported two false positives for exactly that reason.
 *
 *  - `subscriptionUpdatedAt` clustering. If the whole cohort shares one
 *    timestamp, that is the backfill script's fingerprint and the statuses on
 *    those documents carry no independent information. Spread out over months
 *    means each was written by a real Apple event.
 *
 * Prints `originalTransactionId` for each so they can be looked up in App Store
 * Connect → Subscriptions, which is the only authoritative answer.
 *
 * Usage:
 *   node scripts/inspect-stale-apple.js
 *   node scripts/inspect-stale-apple.js --all        # every elapsed cleaner
 *   node scripts/inspect-stale-apple.js --csv        # machine-readable
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
const { describeVisibility } = require("../lib/visibility");

const ALL = process.argv.includes("--all");
const CSV = process.argv.includes("--csv");
const READ_CHUNK = 200;
const DAY = 24 * 60 * 60 * 1000;

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

(async () => {
  const now = Date.now();
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

  const elapsed = snap.docs.filter(
    (d) => describeVisibility(d.data(), now) === "period_elapsed",
  );

  const cohort = ALL
    ? elapsed
    : elapsed.filter((d) => {
        const u = d.data();
        return (
          u.subscriptionProvider === "apple" &&
          !u.lastWebhookType &&
          !u.cancelSubscription &&
          now - (u.subscriptionEndDate || 0) < 90 * DAY
        );
      });

  // ── signal 1: stored status 'active' written AFTER the period had ended.
  //
  // The `subscriptionUpdatedAt > subscriptionEndDate` guard is the whole signal.
  // A bare `status === 'active'` on an elapsed period is meaningless: the
  // backfill wrote `active` for anyone whose end date was still in the future on
  // the day it ran, and those periods elapsed afterwards.
  const writtenAfterExpiry = (u) =>
    typeof u.subscriptionUpdatedAt === "number" &&
    typeof u.subscriptionEndDate === "number" &&
    u.subscriptionUpdatedAt > u.subscriptionEndDate;

  const storedActive = elapsed.filter(
    (d) => d.data().subscriptionStatus === "active" && writtenAfterExpiry(d.data()),
  );
  const storedActiveInCohort = cohort.filter(
    (d) => d.data().subscriptionStatus === "active" && writtenAfterExpiry(d.data()),
  );
  const staleActiveInCohort = cohort.filter(
    (d) => d.data().subscriptionStatus === "active" && !writtenAfterExpiry(d.data()),
  );

  // ── signal 2: is subscriptionUpdatedAt clustered on one day?
  const byUpdatedDay = new Map();
  cohort.forEach((d) => {
    const key = day(d.data().subscriptionUpdatedAt);
    byUpdatedDay.set(key, (byUpdatedDay.get(key) || 0) + 1);
  });

  if (CSV) {
    console.log(
      "uid,publishedService,subscriptionEndDate,endedOn,subscriptionStatus,subscriptionUpdatedAt,updatedOn,originalTransactionId,subscriptionId,cancelSubscription,webhook",
    );
    cohort.forEach((d) => {
      const u = d.data();
      console.log(
        [
          d.id,
          published.has(d.id),
          u.subscriptionEndDate ?? "",
          day(u.subscriptionEndDate),
          u.subscriptionStatus ?? "",
          u.subscriptionUpdatedAt ?? "",
          day(u.subscriptionUpdatedAt),
          u.originalTransactionId ?? "",
          u.subscriptionId ?? "",
          !!u.cancelSubscription,
          u.webhook ?? "",
        ].join(","),
      );
    });
    process.exit(0);
  }

  console.log("\n🔍 READ-ONLY — nothing will be written\n");
  console.log(`elapsed cleaners total                  ${elapsed.length}`);
  console.log(`cohort under inspection                 ${cohort.length}${ALL ? " (--all)" : " (apple, no webhook, not cancelled, <90d)"}`);
  console.log(`  ...with a published service           ${cohort.filter((d) => published.has(d.id)).length}`);

  console.log(
    `\n═══ signal 1: "active" written AFTER the period had already ended ═══\n` +
      `  across all elapsed cleaners           ${storedActive.length}\n` +
      `  within this cohort                    ${storedActiveInCohort.length}\n` +
      `  Only these count. A writer that saw an elapsed date and still recorded\n` +
      `  "active" was working from Apple, not from arithmetic.\n` +
      `\n  discounted (status "active" but written BEFORE expiry): ${staleActiveInCohort.length}\n` +
      `  Those are the backfill's snapshot from a day when the period was still\n` +
      `  live. They carry no information at all.`,
  );

  console.log(`\n═══ signal 2: subscriptionUpdatedAt, by day ═══`);
  if (byUpdatedDay.size === 0) {
    console.log("  (none set)");
  } else {
    [...byUpdatedDay.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .forEach(([d, c]) => console.log(`  ${String(c).padStart(4)}  ${d}`));
    const top = Math.max(...byUpdatedDay.values());
    console.log(
      top / cohort.length > 0.6
        ? `\n  ⚠️  ${((top / cohort.length) * 100).toFixed(0)}% share one day — that is the\n      backfill-subscription-status fingerprint. Their "expired" status is\n      DERIVED and proves nothing about whether Apple stopped charging them.`
        : `\n  ✅ Spread across days — each looks like a real Apple event rather than\n      one bulk script run.`,
    );
  }

  console.log(`\n═══ the cohort ═══`);
  console.log(
    "  uid                            svc  ended      status    updated     originalTransactionId",
  );
  cohort
    .slice()
    .sort((a, b) => (b.data().subscriptionEndDate || 0) - (a.data().subscriptionEndDate || 0))
    .forEach((d) => {
      const u = d.data();
      console.log(
        `  ${d.id.padEnd(30)} ${published.has(d.id) ? "yes" : "no "}  ` +
          `${day(u.subscriptionEndDate)} ${String(u.subscriptionStatus ?? "-").padEnd(9)} ` +
          `${day(u.subscriptionUpdatedAt)}  ${u.originalTransactionId ?? "(none)"}`,
      );
    });

  console.log(
    `\nLook the originalTransactionIds up in App Store Connect → Subscriptions.\n` +
      `If any are still being charged, the fix is to advance their end date (a\n` +
      `receipt re-validation does it), not to weaken the visibility rule.\n`,
  );
  process.exit(0);
})().catch((err) => {
  console.error("\n❌ inspect failed:", err);
  process.exit(1);
});
