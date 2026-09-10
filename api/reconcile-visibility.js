/**
 * api/reconcile-visibility.js
 *
 * Reconciliation sweep for `visibleUntil`.
 *
 * IT IS A SAFETY NET, NOT THE MECHANISM. Because `visibleUntil` is a deadline
 * rather than a boolean, an expiring subscription hides itself the moment the
 * clock passes it — the Firestore rule and the customer query both compare it to
 * the current time. Nothing here needs to run for that to work.
 *
 * What this repairs is DRIFT, which has exactly three causes:
 *   1. A webhook that never arrived (the App Store Connect notification-version
 *      problem is a live example) or arrived while Firestore was unavailable.
 *   2. Documents written before this field existed — see
 *      scripts/backfill-visibility.js, which is this same logic run once.
 *   3. A cleaner's services document created after the last subscription event,
 *      so nothing had stamped it yet.
 *
 * Because it is not load-bearing, a daily schedule is plenty.
 *
 * AUTH: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when the
 * CRON_SECRET environment variable is set. Set it. Without it this endpoint is
 * refused outright rather than left open — a sweep is a bulk write path.
 *
 * QUERY PARAMS
 *   dryRun=1        report what would change, write nothing
 *   limit=<n>       users per page (default 300, max 1000)
 *   cursor=<uid>    resume after this user id
 *   budgetMs=<n>    stop and return a cursor before the platform timeout
 *
 * Paginates by document id so a resumed run cannot skip or repeat a user, and
 * keeps taking pages until the collection is exhausted or the budget runs out.
 * At the current ~1000 cleaners that is a handful of batched round trips and
 * completes in one invocation. If it ever stops early it returns `nextCursor`,
 * and because Vercel Cron fires the endpoint only once, a run that comes back
 * with a non-null cursor means the sweep needs chaining (call it again with
 * `?cursor=`) or a longer `maxDuration`.
 */

const admin = require("firebase-admin");
const { sanitize } = require("../lib/subscriptions");
const { computeVisibleUntil, describeVisibility } = require("../lib/visibility");

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
      universe_domain: process.env.UNIVERSE_DOMAIN,
    }),
  });
}

const db = admin.firestore();

// Each cleaner can queue two writes and a Firestore batch caps at 500, so a
// page must stay at or below 250.
const DEFAULT_PAGE = 250;
const MAX_PAGE = 250;
const DEFAULT_BUDGET_MS = 8000;

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Constant-time-ish bearer check. Vercel Cron sets the header; a human can pass
 * `?key=` instead for a manual run.
 */
const isAuthorized = (req) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = req.headers?.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const provided = bearer || req.query?.key || null;
  if (!provided) return false;

  const a = Buffer.from(String(provided));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try {
    const crypto = require("crypto");
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end("Method Not Allowed");
  }

  if (!isAuthorized(req)) {
    // Deliberately terse: this endpoint's existence is not a secret, but its
    // behaviour should not be enumerable.
    return res.status(401).json({ error: "Unauthorized" });
  }

  const startedAt = Date.now();
  const dryRun = req.query?.dryRun === "1" || req.query?.dryRun === "true";
  const pageSize = Math.min(toInt(req.query?.limit, DEFAULT_PAGE), MAX_PAGE);
  const budgetMs = toInt(req.query?.budgetMs, DEFAULT_BUDGET_MS);
  let cursor = req.query?.cursor || null;

  const stats = {
    scanned: 0,
    usersRepaired: 0,
    servicesRepaired: 0,
    servicesAbsent: 0,
    hiddenNow: 0,
    visibleNow: 0,
    failures: 0,
  };
  const samples = [];

  try {
    let exhausted = false;

    while (!exhausted && Date.now() - startedAt < budgetMs) {
      let query = db
        .collection("Users")
        .where("role", "==", "Cleaner")
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(pageSize);

      if (cursor) query = query.startAfter(cursor);

      const snap = await query.get();
      if (snap.empty) {
        exhausted = true;
        break;
      }

      // Services documents are fetched with getAll() per page rather than a
      // `.get()` per cleaner, and repairs go into a single WriteBatch. The
      // sequential version cost one round trip per cleaner, which blew the
      // whole time budget on a few hundred users before repairing anything.
      const serviceSnaps = await db.getAll(
        ...snap.docs.map((doc) => db.collection("CleanerServices").doc(doc.id)),
      );

      const batch = db.batch();
      let queued = 0;

      for (let i = 0; i < snap.docs.length; i += 1) {
        const doc = snap.docs[i];
        const serviceSnap = serviceSnaps[i];
        cursor = doc.id;
        stats.scanned += 1;

        const user = doc.data();
        const expected = computeVisibleUntil(user);
        const reason = describeVisibility(user);

        if (expected > Date.now()) stats.visibleNow += 1;
        else stats.hiddenNow += 1;

        const payload = sanitize({
          visibleUntil: expected,
          visibilityReason: reason,
          visibilityUpdatedAt: Date.now(),
        });

        // Only written when it actually differs, so a steady-state sweep costs
        // reads and no writes.
        if (user.visibleUntil !== expected) {
          if (samples.length < 25) {
            samples.push({
              userId: doc.id,
              was: user.visibleUntil ?? null,
              now: expected,
              reason,
            });
          }
          if (!dryRun) {
            batch.update(doc.ref, payload);
            queued += 1;
          }
          stats.usersRepaired += 1;
        }

        // Checked independently of the Users mirror: a cleaner who published
        // after their last subscription event has a correct Users value and a
        // missing services value, and only this branch catches that.
        if (!serviceSnap.exists) {
          stats.servicesAbsent += 1;
        } else if (serviceSnap.data()?.visibleUntil !== expected) {
          if (!dryRun) {
            batch.update(serviceSnap.ref, payload);
            queued += 1;
          }
          stats.servicesRepaired += 1;
        }
      }

      if (queued > 0) {
        try {
          await batch.commit();
        } catch (err) {
          stats.failures += queued;
          console.error(`page commit failed (${queued} writes):`, err.message);
        }
      }

      if (snap.size < pageSize) exhausted = true;
    }

    const response = {
      ok: true,
      dryRun,
      ...stats,
      elapsedMs: Date.now() - startedAt,
      nextCursor: exhausted ? null : cursor,
      samples,
    };

    console.log("reconcile-visibility:", JSON.stringify(response));
    return res.status(200).json(response);
  } catch (err) {
    console.error("reconcile-visibility failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      ...stats,
      nextCursor: cursor,
    });
  }
};
