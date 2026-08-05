/* Verification of the pure subscription helpers + recordPayment idempotency.
   Not shipped — run with: node scripts/verify-subscription-helpers.js  */
const L = require("../lib/subscriptions");
let pass = 0,
  fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  else console.log(`ok   ${name}`);
};

// ---- Stripe status mapping ----
eq("stripe active", L.mapStripeStatus("active"), "active");
eq("stripe trialing -> active", L.mapStripeStatus("trialing"), "active");
eq("stripe past_due -> past_due", L.mapStripeStatus("past_due"), "past_due");
eq("stripe unpaid -> expired", L.mapStripeStatus("unpaid"), "expired");
eq("stripe canceled", L.mapStripeStatus("canceled"), "canceled");
eq("stripe unknown -> undefined (no guess written)", L.mapStripeStatus("brand_new"), undefined);
eq("access list keeps past_due", L.STRIPE_STATUSES_WITH_ACCESS.includes("past_due"), true);
eq("access list excludes canceled", L.STRIPE_STATUSES_WITH_ACCESS.includes("canceled"), false);

// ---- Apple price conversion ----
eq("4990 milliunits -> 499 cents", L.appleMilliunitsToMinor(4990), 499);
eq("999 milliunits -> 100 cents", L.appleMilliunitsToMinor(999), 100);
eq("missing price -> null", L.appleMilliunitsToMinor(undefined), null);

// ---- sanitize ----
eq("sanitize drops undefined, keeps null", L.sanitize({ a: 1, b: undefined, c: null }), { a: 1, c: null });

// ---- Apple notification derivation ----
const now = Date.now();
const tx = (o = {}) => ({ expiresDate: now + 86400000, ...o });

eq("DID_RENEW -> active + endDate", L.deriveAppleUpdate({ notificationType: "DID_RENEW", transaction: tx() }), {
  subscription: true, cancelSubscription: false, subscriptionStatus: "active",
  lastPaymentFailedAt: null, gracePeriodEndsAt: null, subscriptionEndDate: now + 86400000,
});

eq("DID_FAIL_TO_RENEW + GRACE_PERIOD -> past_due, keeps access",
  L.deriveAppleUpdate({ notificationType: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD",
    transaction: tx(), renewal: { gracePeriodExpiresDate: now + 1000 } }),
  { subscriptionStatus: "past_due", subscription: true, cancelSubscription: false,
    lastPaymentFailedAt: now, gracePeriodEndsAt: now + 1000 });

const noGrace = L.deriveAppleUpdate({ notificationType: "DID_FAIL_TO_RENEW", transaction: tx(), renewal: {} });
eq("DID_FAIL_TO_RENEW no grace -> past_due, legacy access unchanged (false)",
  [noGrace.subscriptionStatus, noGrace.subscription, noGrace.cancelSubscription],
  ["past_due", false, true]);

eq("EXPIRED preserves legacy field pair",
  L.deriveAppleUpdate({ notificationType: "EXPIRED", transaction: tx() }),
  { subscription: false, cancelSubscription: true, subscriptionStatus: "expired", gracePeriodEndsAt: null });

eq("REFUND -> refunded",
  L.deriveAppleUpdate({ notificationType: "REFUND", transaction: tx() }).subscriptionStatus, "refunded");

eq("DID_CHANGE_RENEWAL_STATUS disabled -> cancelSubscription true, status untouched",
  L.deriveAppleUpdate({ notificationType: "DID_CHANGE_RENEWAL_STATUS", subtype: "AUTO_RENEW_DISABLED", transaction: tx() }),
  { cancelSubscription: true, subscriptionEndDate: now + 86400000 });

eq("TEST notification -> null (audit fields only)",
  L.deriveAppleUpdate({ notificationType: "TEST", transaction: tx() }), null);

// ---- legacy backfill derivation (must never revoke access) ----
eq("never subscribed -> none", L.deriveLegacyStatus({}, now), "none");
eq("future endDate -> active", L.deriveLegacyStatus({ subscription: true, subscriptionEndDate: now + 1000 }, now), "active");
eq("past endDate -> expired", L.deriveLegacyStatus({ subscription: true, subscriptionEndDate: now - 1000 }, now), "expired");
eq("cancelSubscription but still paid -> active",
  L.deriveLegacyStatus({ subscription: true, cancelSubscription: true, subscriptionEndDate: now + 1000 }, now), "active");
eq("legacy Apple, no endDate, subscription true -> active (no downgrade)",
  L.deriveLegacyStatus({ subscription: true, subscriptionId: "x" }, now), "active");

// ---- JWS decode ----
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
eq("decodeSignedPayload", L.decodeSignedPayload(`${b64({a:1})}.${b64({hello:"world"})}.sig`), { hello: "world" });

// ---- recordPayment idempotency (fake Firestore) ----
(async () => {
  const store = { Payments: {}, Users: { u1: { totalPaid: 0 } } };
  let incrementsApplied = 0;

  const FieldValue = {
    increment: n => ({ __inc: n }),
    serverTimestamp: () => "TS",
  };
  const fakeAdmin = { firestore: { FieldValue } };

  const ref = (col, id) => ({ __col: col, __id: id });
  const db = {
    collection: col => ({ doc: id => ref(col, id) }),
    runTransaction: async fn =>
      fn({
        get: async r => ({ exists: store[r.__col][r.__id] !== undefined, data: () => store[r.__col][r.__id] }),
        set: (r, data) => { store[r.__col][r.__id] = data; },
        update: (r, data) => {
          for (const [k, v] of Object.entries(data)) {
            if (v && v.__inc !== undefined) { store[r.__col][r.__id][k] = (store[r.__col][r.__id][k] || 0) + v.__inc; incrementsApplied++; }
            else store[r.__col][r.__id][k] = v;
          }
        },
      }),
  };

  const args = { db, admin: fakeAdmin, userId: "u1", provider: "stripe",
    reference: "in_123", amount: 499, currency: "usd", paidAt: now, invoiceId: "in_123" };

  eq("first delivery -> recorded", await L.recordPayment(args), "recorded");
  eq("redelivery -> duplicate", await L.recordPayment(args), "duplicate");
  eq("third delivery -> duplicate", await L.recordPayment(args), "duplicate");
  eq("totalPaid incremented exactly once", store.Users.u1.totalPaid, 499);
  eq("increment applied once", incrementsApplied, 1);
  eq("lastPayment denormalised", store.Users.u1.lastPayment, { amount: 499, currency: "USD", paidAt: now, provider: "stripe" });
  eq("deterministic payment id", Object.keys(store.Payments), ["stripe_in_123"]);
  eq("zero amount -> skipped (no garbage row)", await L.recordPayment({ ...args, reference: "in_zero", amount: 0 }), "skipped");

  // missing user doc: payment still stored, summary skipped, no throw
  eq("missing user -> still recorded", await L.recordPayment({ ...args, userId: "ghost", reference: "in_g" }), "recorded");

  // apple id sanitisation
  eq("payment id sanitised", L.buildPaymentId("apple", "2000/000 1#2"), "apple_2000-000-1-2");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
