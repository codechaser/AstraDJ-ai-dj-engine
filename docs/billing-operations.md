# AstraDJ billing implementation notes

## Plan configuration

The proposed monthly INR prices are centralized in `server/src/config/subscriptionPlans.js`: Free ₹0, Premium ₹149, and Pro ₹299. AI DJ request limits and Lounge participant caps are stored on the `Plan` records and can be changed by an Admin within server-side bounds. A new account resolves to Free unless it has an unexpired, verified paid `Subscription` record; user registration never accepts a plan ID.

## Implemented behavior and current limits

- Server-side entitlements are derived from MongoDB subscription status and period dates. Expired subscriptions are switched to `expired` on the next entitlement read and audited.
- The backend meters AI DJ requests per UTC day (100/500/1500 by default) and enforces Lounge creation capacity caps (8/20/50). A daily quota counts an authenticated Lounge member's request after membership validation.
- Other listed Premium and Pro features are product configuration only and are marked **Planned** in `/plans`. They are not implemented or enforced as working capabilities yet. In particular, public/private Lounge visibility, advanced recommendation modes, premium themes, account-level detailed listening reports, and priority AI processing are not present. This implementation does not claim them as delivered.
- Playlist data remains browser-local under the existing app behavior; it is not cloud-synced subscription data.
- Free is an entitlement default, not a separate `Subscription` document. Paid subscription and payment state is durable in MongoDB.

## Razorpay test configuration

Keep these values in the server environment only (never in Vite variables):

```dotenv
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
RAZORPAY_PLAN_PREMIUM_ID=
RAZORPAY_PLAN_PRO_ID=
RAZORPAY_MODE=test
RAZORPAY_CHECKOUT_ENABLED=false
```

Create monthly INR plans in the Razorpay **test** account for ₹149 and ₹299, then set their provider plan IDs. AstraDJ checks the remote provider plan amount and currency before creating a subscription. Checkout stays disabled until explicitly set to `true`. Test mode accepts only `rzp_test_` keys. Live mode is accepted only with `NODE_ENV=production`, `RAZORPAY_MODE=live`, and an `rzp_live_` key. No credentials were available to this implementation session, so Razorpay checkout, webhooks against Razorpay, renewals, refunds, and cancellation at the provider remain unverified.

Register Razorpay's webhook at `/api/v1/billing/webhooks/razorpay` and subscribe to at least `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.paused`, `subscription.resumed`, `subscription.cancelled`, `subscription.completed`, `payment.captured`, `payment.failed`, and `payment.refunded`. The server verifies signatures against the raw request bytes, stores only an event hash and type, and uses unique event/payment IDs for idempotency. A missing local subscription mapping returns a retryable error rather than acknowledging and losing activation.

## API and authorization

- `GET /api/v1/billing/plans` — active plan configuration and per-plan checkout readiness.
- `GET /api/v1/billing/me` — the authenticated account's effective plan and entitlements.
- `GET /api/v1/billing/me/payments?limit=20` — only that account's payment rows.
- `POST /api/v1/billing/subscriptions` — create a paid Razorpay subscription; requires `Idempotency-Key`.
- `POST /api/v1/billing/verify` — validates checkout HMAC and then confirms subscription/payment state with Razorpay before changing access.
- `POST /api/v1/billing/subscriptions/:id/cancel` — schedules cancellation at period end.
- `POST /api/v1/billing/webhooks/razorpay` — unauthenticated provider callback protected by HMAC.
- `/api/v1/admin/billing/*` — Admin-only overview, plans, subscription search, payments, and bounded plan configuration changes.

Subscriptions are owner-scoped. Administrative payloads omit provider payment identifiers and credentials. The Admin UI displays only aggregate/payment metadata and never receives Razorpay secrets.

## MongoDB collections and indexes

`plans` has a unique `planId`; `subscriptions` has unique sparse provider subscription IDs plus `(userId, requestKey)` idempotency and status/renewal indexes; `payments` has unique sparse provider payment IDs and user history indexes; `billingwebhookevents` has a unique provider event ID; `featureusages` has a unique `(userId, feature, periodKey)` quota key; and `billingaudits` has a unique optional idempotency key. Default plans are inserted with `$setOnInsert` at API startup and are never used to delete or replace user records.

## Revenue reporting

MRR sums configured monthly plan prices for active subscriptions with a future renewal date; failed, pending, expired, and cancelled rows are excluded. Payment environment is surfaced as test/live/unconfigured. Test-mode transactions must not be presented as production revenue. Conversion is active paid subscribers divided by total registered accounts; it is an operational estimate, not a cohort conversion metric.
