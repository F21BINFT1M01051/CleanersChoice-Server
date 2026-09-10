#!/usr/bin/env node
/**
 * scripts/verify-visibility.js
 *
 * Assertions for lib/visibility.js. No Firestore, no network — runs anywhere.
 *
 *   node scripts/verify-visibility.js
 *
 * Two halves:
 *  1. Every case in scripts/visibility-fixtures.json, which is the SHARED
 *     CONTRACT with the app's src/utils/cleanerVisibility.ts. The app's Jest
 *     suite asserts the same file, so a divergence between the two
 *     implementations fails one of the two runs.
 *  2. syncCleanerVisibility() against a fake Firestore, covering the paths that
 *     only show up with a database: missing user, missing services doc, a
 *     Customer document, and a write that throws.
 */

const assert = require("assert");
const {
  computeVisibleUntil,
  isVisibleNow,
  describeVisibility,
  syncCleanerVisibility,
  VISIBILITY_REVOKED,
} = require("../lib/visibility");

const fixtures = require("./visibility-fixtures.json");

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`\n❌ ${label}\n   ${err.message}`);
    process.exitCode = 1;
  }
};

/* ---------------- 1. shared contract ---------------- */

const NOW = fixtures.now;

fixtures.cases.forEach((testCase) => {
  check(`fixture: ${testCase.name}`, () => {
    assert.strictEqual(
      computeVisibleUntil(testCase.user),
      testCase.visibleUntil,
      `computeVisibleUntil -> ${computeVisibleUntil(testCase.user)}, expected ${testCase.visibleUntil}`,
    );
    assert.strictEqual(
      isVisibleNow(testCase.user, NOW),
      testCase.visibleNow,
      `isVisibleNow -> ${isVisibleNow(testCase.user, NOW)}, expected ${testCase.visibleNow}`,
    );
  });
});

/* ---------------- 2. properties the fixtures cannot express ---------------- */

check("null and undefined users are revoked", () => {
  assert.strictEqual(computeVisibleUntil(null), VISIBILITY_REVOKED);
  assert.strictEqual(computeVisibleUntil(undefined), VISIBILITY_REVOKED);
});

check("computeVisibleUntil is time-independent", () => {
  // The property that makes a stored value impossible to go stale: the function
  // takes no clock, so the same document always yields the same deadline.
  const user = { role: "Cleaner", subscription: true, subscriptionEndDate: fixtures.sep30 };
  const a = computeVisibleUntil(user);
  const b = computeVisibleUntil(user);
  assert.strictEqual(a, b);
  assert.strictEqual(a, fixtures.sep30);
});

check("a grace is a floor, and hard revocations ignore it", () => {
  const elapsed = { subscriptionEndDate: fixtures.aug31 };
  // Raises a lapsed deadline...
  assert.strictEqual(
    computeVisibleUntil({ ...elapsed, visibilityGraceUntil: fixtures.sep30 }),
    fixtures.sep30,
  );
  // ...but never lowers a live one.
  assert.strictEqual(
    computeVisibleUntil({
      subscriptionEndDate: fixtures.sep30,
      visibilityGraceUntil: fixtures.aug31,
    }),
    fixtures.sep30,
  );
  // ...and cannot resurrect someone whose money went back, or a closed account.
  assert.strictEqual(
    computeVisibleUntil({
      ...elapsed,
      subscriptionStatus: "refunded",
      visibilityGraceUntil: fixtures.sep30,
    }),
    VISIBILITY_REVOKED,
  );
  assert.strictEqual(
    computeVisibleUntil({
      ...elapsed,
      accountStatus: "disabled",
      visibilityGraceUntil: fixtures.sep30,
    }),
    VISIBILITY_REVOKED,
  );
  // Reported distinctly, so a granted cohort cannot be mistaken in the sweep's
  // summary for cleaners who genuinely resubscribed.
  assert.strictEqual(
    describeVisibility({ ...elapsed, visibilityGraceUntil: fixtures.sep30 }, NOW),
    "active_grace",
  );
});

check("the cancellation flag alone never changes the outcome", () => {
  const base = { role: "Cleaner", subscription: true, subscriptionEndDate: fixtures.sep30 };
  assert.strictEqual(
    computeVisibleUntil({ ...base, cancelSubscription: true }),
    computeVisibleUntil({ ...base, cancelSubscription: false }),
  );
});

check("describeVisibility distinguishes the hidden reasons", () => {
  assert.strictEqual(
    describeVisibility({ subscriptionStatus: "refunded", subscriptionEndDate: fixtures.sep30 }, NOW),
    "status_refunded",
  );
  assert.strictEqual(
    describeVisibility({ accountStatus: "disabled", subscriptionEndDate: fixtures.sep30 }, NOW),
    "account_disabled",
  );
  assert.strictEqual(
    describeVisibility({ subscription: true, subscriptionEndDate: fixtures.aug31 }, NOW),
    "period_elapsed",
  );
  assert.strictEqual(describeVisibility({ subscription: true }, NOW), "no_subscription_period");
  assert.strictEqual(
    describeVisibility({ subscription: true, subscriptionEndDate: fixtures.sep30 }, NOW),
    "active",
  );
  assert.strictEqual(
    describeVisibility(
      { subscription: true, subscriptionEndDate: fixtures.sep30, cancelSubscription: true },
      NOW,
    ),
    "active_cancelling",
  );
});

/* ---------------- 3. syncCleanerVisibility against a fake db ---------------- */

const fakeDb = ({ users = {}, services = {}, failOn = null }) => {
  const writes = { users: {}, services: {} };
  const docFor = (collection, id) => ({
    get: async () => ({
      exists: Object.prototype.hasOwnProperty.call(
        collection === "Users" ? users : services,
        id,
      ),
      data: () => (collection === "Users" ? users : services)[id],
    }),
    update: async (payload) => {
      if (failOn === collection) {
        const err = new Error("NOT_FOUND: No document to update");
        err.code = 5;
        throw err;
      }
      writes[collection === "Users" ? "users" : "services"][id] = payload;
    },
  });
  return {
    writes,
    db: { collection: (name) => ({ doc: (id) => docFor(name, id) }) },
  };
};

const fakeAdmin = { firestore: { FieldValue: { serverTimestamp: () => "ts" } } };

const run = async () => {
  {
    const { db, writes } = fakeDb({
      users: { c1: { role: "Cleaner", subscription: true, subscriptionEndDate: fixtures.sep30 } },
      services: { c1: { name: "Deep clean" } },
    });
    const result = await syncCleanerVisibility({ db, admin: fakeAdmin, userId: "c1" });
    check("sync writes both documents for a visible cleaner", () => {
      assert.strictEqual(result.visibleUntil, fixtures.sep30);
      assert.strictEqual(result.user, "updated");
      assert.strictEqual(result.services, "updated");
      assert.strictEqual(writes.users.c1.visibleUntil, fixtures.sep30);
      assert.strictEqual(writes.services.c1.visibleUntil, fixtures.sep30);
      assert.strictEqual(writes.services.c1.visibilityReason, "active");
    });
  }

  {
    const { db, writes } = fakeDb({
      users: { c2: { role: "Cleaner", subscriptionStatus: "refunded", subscriptionEndDate: fixtures.sep30 } },
      services: { c2: {} },
    });
    await syncCleanerVisibility({ db, admin: fakeAdmin, userId: "c2" });
    check("sync revokes a refunded cleaner to 0", () => {
      assert.strictEqual(writes.services.c2.visibleUntil, 0);
      assert.strictEqual(writes.services.c2.visibilityReason, "status_refunded");
    });
  }

  {
    // A cleaner who never published: the Users mirror still updates, the
    // services write is a normal no-op rather than an error.
    const { db, writes } = fakeDb({
      users: { c3: { role: "Cleaner", subscription: true, subscriptionEndDate: fixtures.sep30 } },
      services: {},
      failOn: "CleanerServices",
    });
    const result = await syncCleanerVisibility({ db, admin: fakeAdmin, userId: "c3" });
    check("a missing services document is not an error", () => {
      assert.strictEqual(result.services, "absent");
      assert.strictEqual(result.user, "updated");
      assert.strictEqual(writes.users.c3.visibleUntil, fixtures.sep30);
    });
  }

  {
    const { db, writes } = fakeDb({ users: {}, services: {} });
    const result = await syncCleanerVisibility({ db, admin: fakeAdmin, userId: "gone" });
    check("a deleted account is skipped, not resurrected", () => {
      assert.strictEqual(result.user, "skipped");
      assert.deepStrictEqual(writes.users, {});
      assert.deepStrictEqual(writes.services, {});
    });
  }

  {
    const { db, writes } = fakeDb({
      users: { cust: { role: "Customer", subscription: true, subscriptionEndDate: fixtures.sep30 } },
      services: {},
    });
    const result = await syncCleanerVisibility({ db, admin: fakeAdmin, userId: "cust" });
    check("customer documents are left alone", () => {
      assert.strictEqual(result.user, "not_cleaner");
      assert.deepStrictEqual(writes.users, {});
    });
  }

  {
    const result = await syncCleanerVisibility({ db: null, admin: fakeAdmin, userId: "x" });
    check("sync never throws on a missing db", () => {
      assert.strictEqual(result.visibleUntil, null);
    });
  }

  console.log(
    `\n${process.exitCode ? "❌" : "✅"} ${passed} assertion group(s) passed${
      process.exitCode ? " — see failures above" : ""
    }\n`,
  );
};

run().catch((err) => {
  console.error("verify-visibility crashed:", err);
  process.exit(1);
});
