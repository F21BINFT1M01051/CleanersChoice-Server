/**
 * lib/visibility.js
 *
 * Customer-facing cleaner visibility, denormalized.
 *
 * WHY THIS EXISTS
 * The app can already decide visibility on its own (src/utils/cleanerVisibility.ts),
 * but doing it client-side costs a Users read per cleaner on every Home load and,
 * more importantly, cannot be ENFORCED — a direct Firestore read still returns
 * lapsed cleaners. So the answer is written onto the documents customers query,
 * where one Firestore rule can enforce it and one indexed `where` can filter it.
 *
 * THE FIELD: `visibleUntil` (epoch ms) on `CleanerServices/{cleanerId}`, mirrored
 * onto `Users/{cleanerId}` for the admin views and this module's own sweep.
 *
 *   visibleUntil >  now  ->  the cleaner is discoverable
 *   visibleUntil <= now  ->  hidden
 *   visibleUntil == 0    ->  hidden, permanently, until something changes
 *
 * WHY A TIMESTAMP AND NOT A BOOLEAN — this is the load-bearing decision.
 * A boolean has to be flipped by a scheduled job at the instant a subscription
 * lapses, which makes correctness depend on cron latency (a cleaner stays visible
 * until the next run) and makes the cron a single point of failure. A timestamp
 * compared against `request.time` in a Firestore rule expires EXACTLY on time with
 * no cron involved at all. Immediate revocations (refund, disabled account) fold
 * into the same field by setting it to 0, so one field covers both shapes and the
 * reconciliation cron becomes a safety net for missed webhooks rather than the
 * mechanism.
 *
 * WHY `computeVisibleUntil` TAKES NO `now`
 * It is deliberately time-independent: the value it returns is a deadline, not a
 * decision. That is what makes the stored value impossible to go stale — there is
 * no moment at which a correct write becomes an incorrect one. Only a change to
 * the user's subscription or account state can change it.
 *
 * THE GRACE FIELD: `Users.visibilityGraceUntil` (epoch ms) raises the deadline
 * without touching `subscriptionEndDate`. It exists for one specific situation:
 * a cleaner whose real entitlement cannot be determined from our own data — the
 * Apple cohort whose end date was stranded because renewals only ever advance it
 * via DID_RENEW. Granting a grace keeps them discoverable for a bounded window
 * while receipt re-validation has a chance to establish the truth, and they drop
 * off by themselves if it never does. It is a floor, never a ceiling: a real
 * subscription that extends past the grace wins, and the hard revocations below
 * (refund, disabled account) ignore it entirely — a grace must never resurrect
 * someone whose money went back.
 *
 * MUST STAY IN SYNC WITH `src/utils/cleanerVisibility.ts` in the app repo.
 * Both express the same rule ("active account + valid subscription access"), one
 * as a deadline and one as a boolean at a given instant. The app's
 * `resolveVisibleUntil()` is the mirror of this function and
 * scripts/verify-visibility.js asserts the two agree on a shared fixture set.
 */

const { SUBSCRIPTION_STATUS, sanitize } = require("./subscriptions");

/** Sentinel for "hidden, and not on a timer" — refunds, disabled accounts. */
const VISIBILITY_REVOKED = 0;

/**
 * Statuses that revoke access immediately, whatever the period end says.
 *
 * Only `refunded`: the money went back, so a period end still in the future is
 * not access that was paid for.
 *
 * Deliberately absent:
 *  - `canceled` — a cleaner who turned off renewal has paid through the end of
 *    the current period and stays visible for it. This is the single most
 *    important omission in the file; `cancelSubscription` /
 *    `cancel_at_period_end` is never read here at all.
 *  - `past_due` — the renewal charge is still being retried, which is inside the
 *    period they already paid for. `subscriptionEndDate` is intentionally never
 *    extended into the grace window, so the period end already draws that line.
 */
const ACCESS_REVOKING_STATUSES = new Set([SUBSCRIPTION_STATUS.REFUNDED]);

/** Account states that hide a cleaner regardless of what they have paid. */
const INACTIVE_ACCOUNT_STATUSES = new Set(["disabled", "deleted", "suspended"]);

const normalizeAccountStatus = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : null;

/** A usable grace deadline, or 0. */
const resolveGraceUntil = (user) => {
  const grace = user?.visibilityGraceUntil;
  return typeof grace === "number" && Number.isFinite(grace) && grace > 0
    ? grace
    : 0;
};

/**
 * The deadline after which this cleaner stops being discoverable.
 *
 * Returns `VISIBILITY_REVOKED` (0) rather than a past timestamp for the
 * non-time-based cases, so "hidden because refunded" is distinguishable from
 * "hidden because September ended" when you are staring at a document.
 */
const computeVisibleUntil = (user) => {
  if (!user) return VISIBILITY_REVOKED;

  if (INACTIVE_ACCOUNT_STATUSES.has(normalizeAccountStatus(user.accountStatus))) {
    return VISIBILITY_REVOKED;
  }

  // `subscriptionStatus` is only consulted as a veto. It is never used to grant
  // visibility, because a missed webhook leaves a stale 'active' behind while the
  // period quietly elapses — the period end is the thing that cannot lie.
  if (ACCESS_REVOKING_STATUSES.has(user.subscriptionStatus)) {
    return VISIBILITY_REVOKED;
  }

  const end =
    typeof user.subscriptionEndDate === "number" &&
    Number.isFinite(user.subscriptionEndDate)
      ? user.subscriptionEndDate
      : 0;

  // The grace is a FLOOR. Whichever deadline is later wins, so granting one can
  // only ever extend visibility and can never cut a real subscription short.
  const until = Math.max(end > 0 ? end : 0, resolveGraceUntil(user));

  return until > 0 ? until : VISIBILITY_REVOKED;
};

/** Convenience for logs and the sweep's reporting. */
const isVisibleNow = (user, now = Date.now()) => computeVisibleUntil(user) > now;

/**
 * Why a cleaner is hidden, for the audit field. Purely diagnostic — nothing
 * branches on it.
 */
const describeVisibility = (user, now = Date.now()) => {
  if (!user) return "no_user";
  if (INACTIVE_ACCOUNT_STATUSES.has(normalizeAccountStatus(user.accountStatus))) {
    return `account_${normalizeAccountStatus(user.accountStatus)}`;
  }
  if (ACCESS_REVOKING_STATUSES.has(user.subscriptionStatus)) {
    return `status_${user.subscriptionStatus}`;
  }
  const until = computeVisibleUntil(user);
  if (until === VISIBILITY_REVOKED) return "no_subscription_period";
  if (until <= now) return "period_elapsed";

  // Distinguish "visible because we granted a grace" from "visible because they
  // paid". Without this the grace cohort is invisible in the reporting and the
  // sweep's summary would look like 27 cleaners spontaneously resubscribed.
  const grace = resolveGraceUntil(user);
  const end =
    typeof user.subscriptionEndDate === "number" ? user.subscriptionEndDate : 0;
  if (grace > 0 && grace > end) return "active_grace";

  return user.cancelSubscription ? "active_cancelling" : "active";
};

/**
 * Write the computed deadline onto the two documents that need it.
 *
 * Call this AFTER the subscription fields have been written, with no `user`
 * argument, and it re-reads the user document so it always computes from the
 * post-update state — including fields another handler changed in the same
 * window. One extra read per webhook; webhooks are rare.
 *
 * NEVER THROWS. Denormalization is a cache: if it fails, the subscription write
 * that actually controls access has already succeeded, and the reconciliation
 * sweep will repair the field. Same principle as recordPayment().
 *
 * `CleanerServices` is updated with `.update()`, not `.set({merge:true})`, on
 * purpose — a merge would CREATE a services document for a cleaner who has never
 * published one, leaving a stub with a `visibleUntil` and nothing else in the
 * collection customers list. A missing doc is expected and is not an error.
 *
 * Returns {visibleUntil, reason, user, services} describing what was written.
 */
const syncCleanerVisibility = async ({ db, admin, userId, user = null }) => {
  const result = {
    visibleUntil: null,
    reason: null,
    user: "skipped",
    services: "skipped",
  };

  if (!db || !userId) {
    console.warn("syncCleanerVisibility: missing db or userId — skipped");
    return result;
  }

  try {
    let data = user;

    if (!data) {
      const snap = await db.collection("Users").doc(userId).get();
      if (!snap.exists) {
        // Deleted account. Nothing to mirror onto, and the services document is
        // removed by the same delete flow. Leave history alone.
        console.log(`syncCleanerVisibility: Users/${userId} missing — skipped`);
        return result;
      }
      data = snap.data();
    }

    const visibleUntil = computeVisibleUntil(data);
    const reason = describeVisibility(data);
    result.visibleUntil = visibleUntil;
    result.reason = reason;

    const payload = sanitize({
      visibleUntil,
      visibilityReason: reason,
      visibilityUpdatedAt: Date.now(),
    });

    // Cleaners only. A Customer document has no services to hide, and stamping
    // one would be noise.
    if (data.role === "Cleaner") {
      try {
        await db.collection("Users").doc(userId).update(payload);
        result.user = "updated";
      } catch (err) {
        console.error(
          `syncCleanerVisibility: Users/${userId} write failed:`,
          err.message,
        );
        result.user = "failed";
      }

      try {
        await db.collection("CleanerServices").doc(userId).update(payload);
        result.services = "updated";
      } catch (err) {
        // NOT_FOUND is the normal case for a cleaner who has not published.
        if (err.code === 5 || /NOT_FOUND|No document to update/i.test(err.message)) {
          result.services = "absent";
        } else {
          console.error(
            `syncCleanerVisibility: CleanerServices/${userId} write failed:`,
            err.message,
          );
          result.services = "failed";
        }
      }
    } else {
      result.user = "not_cleaner";
      result.services = "not_cleaner";
    }

    console.log(
      `visibility ${userId}: until=${visibleUntil} (${reason}) user=${result.user} services=${result.services}`,
    );
    return result;
  } catch (err) {
    console.error(`syncCleanerVisibility ${userId} failed:`, err.message);
    return result;
  }
};

module.exports = {
  VISIBILITY_REVOKED,
  resolveGraceUntil,
  ACCESS_REVOKING_STATUSES,
  INACTIVE_ACCOUNT_STATUSES,
  computeVisibleUntil,
  isVisibleNow,
  describeVisibility,
  syncCleanerVisibility,
};
