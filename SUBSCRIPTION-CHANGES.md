# Backend changes — subscription status, payment history, Apple webhook fixes

**Date:** 05 Aug 2026 · Repo: `CleanersChoice-Server`

Every change is **additive**. No existing field was removed or renamed, no API response shape changed, and no code path that currently grants access was made stricter. `subscriptionStatus` becomes the new source of truth while `subscription` / `subscriptionEndDate` / `cancelSubscription` keep being written exactly as before, so the app, the admin view and the backfill can migrate on their own schedule.

---

## Files

| File | Change |
|---|---|
| `lib/subscriptions.js` | **NEW** — shared status maps, Apple notification → state derivation, idempotent payment recording, helpers |
| `api/webhook.js` | **MODIFIED** — Stripe: added `invoice.payment_failed` + `customer.subscription.updated`; extended the two existing handlers |
| `api/apple-webhook.js` | **MODIFIED** — Apple: status mapping, `signedRenewalInfo`, multi-key user lookup, retry behaviour, payment history |
| `api/apple-validate.js` | **MODIFIED** — added `subscriptionStatus` + `subscriptionUpdatedAt` only; receipt-validation logic untouched |
| `scripts/backfill-subscription-status.js` | **NEW** — one-off migration, dry-run by default |
| `scripts/verify-subscription-helpers.js` | **NEW** — 35 assertions over the pure helpers + idempotency; `node scripts/verify-subscription-helpers.js` |

`lib/` sits at the repo root **on purpose**: `vercel.json` builds `api/**/*.js` as serverless functions, and a helper module has no default export. @vercel/node traces and bundles `require()`d files from anywhere in the repo, so this resolves correctly — verified locally by bundling `api/webhook.js` with esbuild and confirming `../lib/subscriptions` is pulled in.

**No `vercel.json` change needed.** Routes are unchanged.

---

## 1. `subscriptionStatus`

New field on `Users`, values: `active · past_due · canceled · expired · refunded · incomplete · none`.

Written by all four Stripe events, all handled Apple notifications, and `apple-validate`. Optional until populated — `deriveLegacyStatus()` in the lib covers reads for users who don't have it yet, and the backfill script fills it in.

### Stripe status mapping

| Stripe | Ours | Access (`subscription`) |
|---|---|---|
| `active`, `trialing` | `active` | ✅ |
| `past_due` | `past_due` | ✅ **kept** — card may still succeed on retry |
| `unpaid` | `expired` | ❌ retries exhausted |
| `incomplete` | `incomplete` | ❌ |
| `incomplete_expired` | `expired` | ❌ |
| `canceled`, `paused` | `canceled` | ❌ |
| anything unrecognised | *not written* | unchanged |

That last row matters: an unmapped status logs a warning and writes **nothing**, rather than persisting a guess that could revoke access.

---

## 2. Stripe webhook (`api/webhook.js`)

### Preserved exactly

`setup_intent.succeeded`, signature verification, `bodyParser: false` + `raw-body`, per-event `try/catch`, and the final unconditional `res.status(200)`. Both pre-existing handlers keep every field write they had.

### `invoice.payment_succeeded` — extended

Existing writes unchanged. Added:

```js
subscriptionStatus: "active",
subscriptionUpdatedAt: Date.now(),
lastPaymentFailedAt: null,   // a successful charge clears prior dunning
gracePeriodEndsAt: null,
```

Then records the payment (see §4). The payment write runs *after* the state update, so a bookkeeping failure can never affect access.

### `invoice.payment_failed` — NEW

```js
subscriptionStatus: "past_due",
lastPaymentFailedAt: Date.now(),
gracePeriodEndsAt: invoice.next_payment_attempt * 1000,   // Stripe tells us when it retries
lastPaymentFailure: { amountDue, currency, attemptCount, invoiceId },
subscriptionUpdatedAt, webhook: true
```

**Deliberately does not set `subscription: false`.** Revoking access the instant a card fails would lock out customers Stripe is about to successfully re-charge.

### `customer.subscription.updated` — NEW

The one that keeps `subscriptionEndDate` correct across renewals, and catches cancel-at-period-end, plan changes and dunning recovery:

```js
subscriptionStatus: mapped,
subscription: ["active","trialing","past_due"].includes(subscription.status),
cancelSubscription: !!subscription.cancel_at_period_end,
subscriptionEndDate: periodEndMs,   // only when present
```

`current_period_end` moved from the subscription onto the subscription **item** in recent Stripe API versions — `getStripePeriodEndMs()` reads both, so it works either side of that change.

### `customer.subscription.deleted` — extended

Existing `{subscription: false, cancelSubscription: true, webhook: true}` preserved; added `subscriptionStatus: "canceled"`, `subscriptionUpdatedAt`, `gracePeriodEndsAt: null`.

---

## 3. Apple webhook (`api/apple-webhook.js`)

### Preserved exactly

JWS decoding, the "never respond before the Firestore write" ordering (that comment was right — Vercel freezes the invocation when the response closes), `subscriptionProvider`/`subscriptionId`/`webhook`/`lastWebhookType`/`lastWebhookSubtype`/`lastWebhookAt`, and the `expiresDate`-only-when-present guard.

### `signedRenewalInfo` now decoded

Wasn't touched before. Supplies `gracePeriodExpiresDate`, `autoRenewStatus`, `isInBillingRetryPeriod`, `renewalPrice`. Decoded in its own `try/catch` so a malformed renewal block can't abort an otherwise valid transaction update.

### Status mapping — `DID_FAIL_TO_RENEW` split out

Previously `EXPIRED`, `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED` and `REFUND` all collapsed into `{subscription: false, cancelSubscription: true}`.

| Notification | `subscriptionStatus` | Legacy fields |
|---|---|---|
| `SUBSCRIBED` / `DID_RENEW` / `DID_RECOVER` | `active` | `subscription: true, cancelSubscription: false` (as before) |
| `DID_FAIL_TO_RENEW` **in grace** | `past_due` | `subscription: true` — **access granted**, was `false` |
| `DID_FAIL_TO_RENEW` no grace | `past_due` | `subscription: false, cancelSubscription: true` — identical to before |
| `EXPIRED` / `GRACE_PERIOD_EXPIRED` | `expired` | unchanged from before |
| `REFUND` / `REVOKE` | `refunded` | unchanged from before |
| `DID_CHANGE_RENEWAL_STATUS` | *untouched* | unchanged from before |
| `RENEWAL_EXTENDED` | `active` | + new `subscriptionEndDate` |

The only behavioural difference for an existing subscriber is the in-grace case, and it **grants** access rather than removing it. Every terminal state keeps writing the same legacy field pair it always did, so nothing reading `subscription`/`cancelSubscription` today changes.

> **`subscriptionEndDate` is NOT extended to the grace deadline.** Per your requirement that new fields must not affect existing access logic, the app's gate (`subscriptionEndDate > now`) is untouched. `gracePeriodEndsAt` is recorded so the app can opt in later — that's a one-line change in `StackNavigator.tsx`, deliberately not made here.

### User lookup — the first-purchase race fix

Was a single query on `originalTransactionId`, a field the **client** writes after `/api/apple-validate` returns. Apple's `SUBSCRIBED` can arrive first, the lookup missed, and a 200 discarded it permanently. Now tries in order:

1. `appAccountToken` — forward-looking, needs no prior server write *(requires a client change, see §7)*
2. `originalTransactionId` — as before
3. `originalTransactionId == transaction.transactionId` — first purchases where the two coincide
4. `subscriptionId == transaction.transactionId` — docs where only the latest id was stored

All single-field equality queries, so **no composite indexes required**.

### Retry behaviour

| Situation | Before | Now |
|---|---|---|
| No matching user | `200` → discarded forever | **`500`** → Apple retries with backoff for ~3 days |
| Handler threw | `200` → discarded | **`500`** → Apple retries |
| No `signedPayload` / no `signedTransactionInfo` | `200` | **`200`** (unchanged — retrying a structural mismatch can never help) |

### Audit fields on unhandled types

`TEST`, `CONSUMPTION_REQUEST`, `PRICE_INCREASE` etc. now still stamp `lastWebhookType`/`lastWebhookAt` (no state change). Their presence on a user doc is the fastest proof that delivery is working — useful for the open diagnosis.

---

## 4. `Payments` collection

One document per successful payment, deterministic ID → **idempotent by construction**:

```
Payments/stripe_in_1abc234          Payments/apple_2000000123456789
{
  userId, provider, amount, currency, paidAt,
  productId, invoiceId, invoiceNumber, receiptUrl,
  transactionId, periodStart, periodEnd, environment, createdAt
}
```

`amount` is always **minor units (cents) as an integer**, for both providers. Apple reports `price` in milliunits (`4990` = $4.99), normalised at the boundary via `appleMilliunitsToMinor()` — so Stripe and Apple rows are directly comparable and summable.

Rows are never created without a real positive amount. Apple only includes `price`/`currency` on notifications generated from ~Dec 2023 onward, so older sandbox payloads log and skip rather than storing a zero that would corrupt `totalPaid`.

---

## 5. `lastPayment` / `totalPaid` — no double counting

`FieldValue.increment` is **not** idempotent: a redelivered webhook would inflate the total. `recordPayment()` therefore runs a Firestore transaction that reads the `Payments` doc first and returns `"duplicate"` without writing if it exists.

```js
await db.runTransaction(async tx => {
  const [existing, userSnap] = await Promise.all([tx.get(paymentRef), tx.get(userRef)]);
  if (existing.exists) return "duplicate";      // ← the guard
  tx.set(paymentRef, {...});
  if (userSnap.exists) tx.update(userRef, {
    totalPaid: FieldValue.increment(amount),
    lastPayment: {amount, currency, paidAt, provider},
  });
});
```

All reads happen before any write, as Firestore transactions require. If the `Users` doc is missing (deleted account, late webhook) the payment is still stored but the summary is skipped — a late webhook can't resurrect a deleted user.

Verified in `scripts/verify-subscription-helpers.js`: three deliveries of the same event → `recorded`, `duplicate`, `duplicate`, with `totalPaid` incremented exactly once.

---

## 6. Migration

```bash
node -r dotenv/config scripts/backfill-subscription-status.js            # dry run
node -r dotenv/config scripts/backfill-subscription-status.js --commit
```

- **Dry run by default.** Prints the status distribution and flags ambiguous users before anything is written.
- **Skips any user who already has `subscriptionStatus`** — webhooks always win.
- Writes **only** `subscriptionStatus` + `subscriptionUpdatedAt`. Never touches `subscription`, `subscriptionEndDate`, `cancelSubscription`, `subscriptionId` or `originalTransactionId`, so it **cannot change anyone's access**.
- Conservative derivation: a user with `subscription: true` but no `subscriptionEndDate` (older Apple subscribers) resolves to `active`, never to a lapsed state. Those get flagged in the output and self-correct on their next Apple notification.
- Batched at 400 writes (Firestore caps at 500).

Running it is **optional** — the app and admin view work without it via `deriveLegacyStatus()`. It just makes the admin list accurate immediately instead of as each user's next webhook arrives.

---

## 7. Config / env / dashboard

**No new environment variables.** Everything reuses the existing service-account vars, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `APPLE_SHARED_SECRET`.

**Stripe Dashboard — required.** The two new events must be enabled on the existing webhook endpoint, or they'll never be delivered:

- `invoice.payment_failed`
- `customer.subscription.updated`

*Developers → Webhooks → your endpoint → "Update details" → Select events.* Keep the three already enabled. Without `customer.subscription.updated`, renewals still won't refresh `subscriptionEndDate`.

**App Store Connect — still to confirm.** Both URLs are correct. The remaining unknown is the **Version** selector on each — it must be **Version 2**. On V1 the body has no `signedPayload`, so the handler returns 200 and nothing is ever written.

**Client change (optional, not made here).** `appAccountToken` is the robust fix for the first-purchase race. It must be a **UUID**, and Firebase uids aren't UUIDs, so it needs: generate a UUID per user → store as `Users.appAccountToken` → pass to `requestSubscription({sku, appAccountToken})` in `useAppleIAP.ts`. `uuid` is already a dependency. The lookup side is already implemented and inert until the field exists.

---

## 8. Not done — deliberately

- **Apple JWS signature verification.** `decodeSignedPayload` still decodes without verifying, so a forged POST can flip a user to subscribed. `@apple/app-store-server-library` is already in `package.json` but unused; `SignedDataVerifier` is the fix. Left out because it needs your Apple root certs + bundle id + environment config and would change the failure mode of a handler we're still diagnosing. **Recommend a follow-up ticket.**
- **Migrating `apple-validate.js` off the deprecated `verifyReceipt` endpoint** — works today, and changing it mid-diagnosis adds risk.
- **App-side grace handling** (honouring `gracePeriodEndsAt` in `StackNavigator.tsx`) — a product decision, and out of scope for backend-only changes.

---

## Rollout order

1. Enable the two new Stripe events in the Stripe Dashboard.
2. Deploy. Stripe behaviour is strictly a superset of today's; existing subscribers are unaffected.
3. Confirm **Version 2** in App Store Connect, then re-run `test-apple-webhook.js` — with the 500-on-miss change, a real notification that previously vanished will now retry.
4. `backfill-subscription-status.js` dry run → review → `--commit`.
5. Build the admin services list against `subscriptionStatus`, with `deriveLegacyStatus()` as the fallback for any user not yet backfilled.

## Verification run locally

- `node --check` clean on all CJS files.
- `api/webhook.js` (hybrid ESM/CJS, as it already was) bundles cleanly with esbuild, confirming `../lib/subscriptions` resolves the way @vercel/node will resolve it.
- `node scripts/verify-subscription-helpers.js` → **35 passed, 0 failed**, covering every status mapping, the milliunits conversion, each Apple notification type, the no-downgrade guarantees in the backfill derivation, and triple-delivery idempotency.
