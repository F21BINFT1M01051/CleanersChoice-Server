#!/usr/bin/env node
/**
 * scripts/diagnose-visibility.js
 *
 * READ-ONLY. Writes nothing, ever. Run this before backfill --commit.
 *
 * The backfill's summary tells you HOW MANY cleaners get hidden. It cannot tell
 * you whether any of them are actually paying, and there are two specific ways
 * this data set could be hiding paying cleaners:
 *
 *  1. `no_subscription_period` — a cleaner with `subscription: true` (or a
 *     `subscriptionId`) but no `subscriptionEndDate`. The legacy status
 *     derivation calls that "active"; the visibility rule calls it hidden.
 *     Such a cleaner is ALREADY seeing the paywall (the app has always gated on
 *     `subscriptionEndDate > now`), so hiding them changes nothing about their
 *     access — but it is worth knowing how many exist and whether any of them
 *     have live listings.
 *
 *  2. `period_elapsed` on Apple — this is the one that matters. Apple
 *     subscribers' `subscriptionEndDate` is only advanced by the App Store
 *     Server notification (DID_RENEW). If those notifications are not being
 *     delivered — a known open issue in this project — then a genuinely paying
 *     Apple cleaner's end date goes stale after their first period and they
 *     look lapsed. `lastWebhookType` is the tell: its absence on every Apple
 *     document means the handler has never completed for them.
 *
 * Usage:
 *   node scripts/diagnose-visibility.js
 *   node scripts/diagnose-visibility.js --samples=20
 */

try {
  require("dotenv").config();
} catch (err) {
  // dotenv not installed — the platform supplies env.
}

const REQUIRED_ENV = ["PROJECT_ID", "PRIVATE_KEY", "CLIENT_EMAIL"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(
    `\n❌ Missing env var(s): ${missingEnv.join(", ")} — run from the repo root.\n`,
  );
  process.exit(1);
}

const admin = require("firebase-admin");
const { computeVisibleUntil, describeVisibility } = require("../lib/visibility");

const samplesArg = process.argv.find((a) => a.startsWith("--samples="));
const SAMPLES = samplesArg ? Number.parseInt(samplesArg.split("=")[1], 10) : 8;
const READ_CHUNK = 200;

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

const DAY = 24 * 60 * 60 * 1000;
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const show = (title, map, total) => {
  console.log(`\n${title}`);
  if (map.size === 0) {
    console.log("  (none)");
    return;
  }
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([key, count]) => {
      const pct = total ? ` (${((count / total) * 100).toFixed(1)}%)` : "";
      console.log(`  ${String(count).padStart(5)}  ${key}${pct}`);
    });
};

(async () => {
  const now = Date.now();
  console.log("\n🔍 READ-ONLY diagnosis — nothing will be written\n");

  const snap = await db.collection("Users").where("role", "==", "Cleaner").get();
  const docs = snap.docs;
  console.log(`${docs.length} cleaner(s)`);

  const published = new Set();
  for (let i = 0; i < docs.length; i += READ_CHUNK) {
    const slice = docs.slice(i, i + READ_CHUNK);
    const services = await db.getAll(
      ...slice.map((d) => db.collection("CleanerServices").doc(d.id)),
    );
    services.forEach((s, j) => {
      if (s.exists) published.add(slice[j].id);
    });
    process.stdout.write(`  read ${Math.min(i + READ_CHUNK, docs.length)}/${docs.length}\r`);
  }
  process.stdout.write("\n");

  // ── headline: only cleaners WITH a published service can appear to customers
  const withService = docs.filter((d) => published.has(d.id));
  const visibleWithService = withService.filter(
    (d) => computeVisibleUntil(d.data()) > now,
  );

  console.log(
    `\n═══ what customers actually see ═══\n` +
      `  published a service        ${withService.length}\n` +
      `  ...visible after this change ${visibleWithService.length}\n` +
      `  ...hidden by this change     ${withService.length - visibleWithService.length}`,
  );

  const reasonWithService = new Map();
  withService.forEach((d) => bump(reasonWithService, describeVisibility(d.data(), now)));
  show("reason, cleaners WITH a published service:", reasonWithService, withService.length);

  // ── risk 1: subscription true / id present, but no end date
  const noPeriod = docs.filter(
    (d) => describeVisibility(d.data(), now) === "no_subscription_period",
  );
  const suspects = noPeriod.filter((d) => {
    const u = d.data();
    return !!u.subscription || !!u.subscriptionId || !!u.originalTransactionId;
  });

  console.log(
    `\n═══ risk 1: no subscriptionEndDate, but looks like they subscribed ═══\n` +
      `  no_subscription_period total   ${noPeriod.length}\n` +
      `  ...of which show subscription evidence ${suspects.length}\n` +
      `  ...of those, with a published service  ${
        suspects.filter((d) => published.has(d.id)).length
      }`,
  );
  const suspectShape = new Map();
  suspects.forEach((d) => {
    const u = d.data();
    bump(
      suspectShape,
      `subscription=${!!u.subscription} status=${u.subscriptionStatus ?? "unset"} provider=${
        u.subscriptionProvider ?? "unset"
      }`,
    );
  });
  show("shape of those suspects:", suspectShape, suspects.length);
  if (suspects.length > 0) {
    console.log("\n  sample uids (check these in the console):");
    suspects.slice(0, SAMPLES).forEach((d) => {
      const u = d.data();
      console.log(
        `    ${d.id}  service=${published.has(d.id) ? "yes" : "no "}  ` +
          `sub=${!!u.subscription}  status=${u.subscriptionStatus ?? "-"}  ` +
          `provider=${u.subscriptionProvider ?? "-"}  lastWebhook=${u.lastWebhookType ?? "-"}`,
      );
    });
  }

  // ── risk 2: elapsed periods that might be missed renewals
  const elapsed = docs.filter(
    (d) => describeVisibility(d.data(), now) === "period_elapsed",
  );
  const byProvider = new Map();
  const byWebhook = new Map();
  const byAge = new Map();
  elapsed.forEach((d) => {
    const u = d.data();
    bump(byProvider, u.subscriptionProvider ?? "unset");
    bump(byWebhook, u.lastWebhookType ? `webhook seen: ${u.lastWebhookType}` : "NO webhook ever");
    const age = now - (u.subscriptionEndDate || 0);
    bump(
      byAge,
      age < 7 * DAY
        ? "elapsed < 7 days"
        : age < 30 * DAY
        ? "elapsed 7–30 days"
        : age < 90 * DAY
        ? "elapsed 30–90 days"
        : "elapsed > 90 days",
    );
  });

  console.log(`\n═══ risk 2: elapsed periods (${elapsed.length}) ═══`);
  show("by provider:", byProvider, elapsed.length);
  show("by webhook evidence:", byWebhook, elapsed.length);
  show("by how long ago it elapsed:", byAge, elapsed.length);

  // The dangerous intersection: Apple, recently elapsed, renewal never turned
  // off, and no webhook has ever landed on the document.
  const missedRenewalSuspects = elapsed.filter((d) => {
    const u = d.data();
    const age = now - (u.subscriptionEndDate || 0);
    return (
      u.subscriptionProvider === "apple" &&
      !u.lastWebhookType &&
      !u.cancelSubscription &&
      age < 90 * DAY
    );
  });
  console.log(
    `\n  ⚠️  Apple + no webhook ever + renewal not cancelled + elapsed <90d: ${missedRenewalSuspects.length}\n` +
      `      (of those, with a published service: ${
        missedRenewalSuspects.filter((d) => published.has(d.id)).length
      })\n` +
      `      These are the ones that could be paying and simply never had their\n` +
      `      end date advanced. Verify a couple against App Store Connect before\n` +
      `      committing.`,
  );
  missedRenewalSuspects.slice(0, SAMPLES).forEach((d) => {
    const u = d.data();
    console.log(
      `    ${d.id}  service=${published.has(d.id) ? "yes" : "no "}  ` +
        `ended=${new Date(u.subscriptionEndDate).toISOString().slice(0, 10)}  ` +
        `status=${u.subscriptionStatus ?? "-"}`,
    );
  });

  // ── refunds, for completeness
  const refunded = docs.filter(
    (d) => describeVisibility(d.data(), now) === "status_refunded",
  );
  console.log(
    `\n═══ refunded (${refunded.length}) ═══\n` +
      `  with a published service: ${refunded.filter((d) => published.has(d.id)).length}`,
  );

  console.log("\nNothing was written.\n");
  process.exit(0);
})().catch((err) => {
  console.error("\n❌ diagnose failed:", err);
  process.exit(1);
});
