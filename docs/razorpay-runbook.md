# Paid plans with Razorpay: runbook

How White Petal's paid plans are configured, tested, released and rolled back.

## How it works

- **The plan catalogue lives in the database** (tables `plans`, `plan_prices`, `plan_limits`, `plan_features`, seeded by migration 004). Operators
  edit it in the app: Plan & billing > Plan catalogue (limits, engines, schedules, integrations, AI allowance, prices per currency, the
  Razorpay plan id for each price, which plan is "most popular", visibility). Edits apply at once on that instance and within ~15 seconds
  on the others, with no deploy, and every edit is audited with before/after. `server/plans.mjs` keeps a live in-memory view and its
  `DEFAULT_PLANS` mirrors the seed (a test fails if they drift). The pricing page, billing screen and every enforcement check read the same data.
- **Razorpay plan ids go in the catalogue, not in Terraform.** Create a monthly plan in the Razorpay dashboard per plan and currency, paste
  its id next to the price. A price with no id can't be bought. Razorpay plans can't be edited, so for a price change create a new plan and
  paste the new id: the old id is kept as "retired", so subscribers still on it keep working. (`razorpay_plan_ids` in Terraform and the
  `RAZORPAY_PLAN_*` variables are only a fallback.)
- **Recorder and reader** (`server/usage.mjs`, `server/billing.mjs`): every billable call is one event in `usage` stamped with its billing period and
  added to that period's counters in `usage_counters` (ai_usd, calls, per kind, drafts) in the same transaction. The reader compares the counters
  and live counts (brands, questions, seats) with the plan's limits and returns used / limit / remaining / state per metric; the billing
  screen, the enforcement checks and the AI allowance all use it. A new billing period is a new counter key, so nothing resets by job.
  Migration 004 carries existing usage into counters (calendar months, the only period there was).
- `server/billing.mjs` decides what an organisation may do. Brands, questions, competitors, seats, engines, schedules, samples,
  integrations, drafted fixes, AI calls and the scheduler all check it on the server. Hiding a button is never enforcement.
- **Limits, not credits.** Each plan has fixed limits. Margin is protected by the plan's monthly AI-cost cap (`capUsd` in
  `plans.mjs`, enforced through `capState` in `server/orgs.mjs`); an admin may set a lower cap, never a higher one.
- **Access modes:** `write` (plan allows it), `manual` (payment late, inside the 3-day grace: people can work, scheduled checks pause),
  `read` (reports stay readable; new checks, drafts, edits, invites, integrations and scheduled runs are refused).
- **Checkout** creates a *pending* Razorpay subscription from an internal plan and currency. The browser never sends an amount or a plan id.
  The pending subscription becomes the organisation's subscription only when Razorpay confirms it was paid, so an abandoned or repeated
  checkout can never orphan the subscription actually being paid for. A second checkout cancels the first unpaid one; a subscription
  paid while another is active is cancelled upstream (refund it by hand), and one that replaces a failed or cancelling one retires the old.
- **Only Razorpay can grant access**, in two ways: a webhook signed with our webhook secret (`POST /api/webhooks/razorpay`), or our own
  authenticated call to Razorpay's API (`POST /api/billing/verify` after the checkout window, `POST /api/billing/refresh`, and the daily job).
  The checkout callback is verified with HMAC-SHA256 of `payment_id|subscription_id` using the key secret and *our* stored subscription id.
  The browser's say-so never changes a plan.
- **Request limits:** checkout, change-plan, cancel, verify, refresh and payment-link are rate limited per organisation; a flood of bad
  webhook signatures is throttled per address (20 a minute, then 429); every body has a size limit.
- **AI allowance:** each plan has a monthly AI-cost cap counted from the plan's own period (trial: from trial start). When it is used up the
  AI is refused with a message that says to upgrade (not "ask an admin"); the billing card shows the percentage used.
- **Pricing page:** lives on the marketing website, which links into the app with `?plan=…&currency=…` (remembered through sign-up). The app's own plans page reads prices and limits live from `GET /api/billing/plans`, so it can't drift from what
  the server enforces. Its buttons go to `/?plan=<plan>&currency=<INR|USD>[&trial=1]`; the app remembers the choice across sign-up or Google
  sign-in and then opens checkout (or, for the trial button, starts the app on the trial). It only advertises limits that are enforced:
  "daily priority questions", white-label reports and monthly reports are not built and are not on the page.
- **Operators** can set a plan by hand (Team & keys > All organisations > "Set plan…"): an invoiced Enterprise contract (ends on its date),
  a longer trial, or custom limits with an expiry. A reason is required and the before/after goes in the audit log. It is refused for an
  organisation with a live Razorpay subscription.
- **Only Razorpay can grant access.** After paying, the page verifies the callback and polls; "Check with Razorpay now" forces a sync.
- **Everyone starts with a 7-day free trial, no card.** With `BILLING_ENABLED=1` a new self-serve organisation starts the trial at sign-up (one
  trial per person). Right after sign-up, until a plan is picked, the app opens the **Plans & payment** page ("Start your 7-day free trial": each
  plan has a "Start 7-day free trial" button; "Skip for now" keeps it out of the way for the session, and a pill on the dashboard keeps
  reminding). Picking a plan (`POST /api/billing/start-trial`) puts the trial on THAT plan's limits and AI allowance; the window never changes,
  and plans can be switched freely until a payment method is connected. The website's pricing buttons carry the chosen plan through sign-up.
- **Connecting a payment method during the trial** (`POST /api/billing/checkout`) creates the Razorpay subscription with `start_at` = the trial's
  end, so nothing is charged before then. When Razorpay authorises it (`subscription.authenticated`) it becomes the organisation's subscription
  and the plan becomes the one they will be charged for. On the trial's last day Razorpay charges it (`activated`/`charged`) and the
  organisation becomes a paying one on that plan, automatically. A day of grace covers the first charge landing late. Removing it
  (`POST /api/billing/remove-payment-method`), or the bank revoking it, only forgets the payment method: the trial carries on to its end.
  Not connected by day 7 means read-only. To switch plans after connecting, connect again on the new plan: the old subscription is cancelled.
  `start_at` and the authorisation charge are from Razorpay's docs and not yet verified against a live account: check in test mode.
- **Two pages, on purpose.** *Plans & payment* (account menu, the dashboard pill, or first run) shows only the plans and the payment method.
  *Account & usage* (Account button on the home screen, account menu) holds all the records: plan and status, usage against the plan (reader),
  what is included, and the activity timeline. Operators edit the plan catalogue on the Team page.
- **Daily reconciliation** (inside `/api/cron/tick`) compares up to 20 subscriptions a day with Razorpay and applies what a missed
  webhook would have. It never moves `billing_event_at`, so a delayed real webhook still wins.

## Sign in with Google (self-serve)

Already built: `GET /api/auth/google/start` and `/callback`, account linking, takeover protection for unverified password accounts, invites.
To switch it on:

1. Google Cloud Console > APIs & Services > Credentials > Create OAuth client ID > **Web application**.
2. Authorised redirect URIs: `<PUBLIC_ORIGIN>/api/auth/google/callback` (and `http://localhost:3000/api/auth/google/callback` for local runs). The
   Search Console connection uses a different one: `<PUBLIC_ORIGIN>/api/oauth/google/callback`.
3. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (Secret Manager via `infra/secrets.sh`). The "Continue with Google" button then appears.
4. With `BILLING_ENABLED=1` a new Google user gets a verified account, a personal organisation and the 7-day
   trial. One trial per person: extra organisations they create inherit the first one's window.

## Configuration

| Name | Secret | Where |
|---|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | yes | Secret Manager `WHITEPETAL_<NAME>` via `infra/secrets.sh` |
| `RAZORPAY_PLAN_<STARTER\|GROWTH\|AGENCY>_<INR\|USD>` | no | fallback only: normally ids are stored in the plan catalogue (database) |
| `BILLING_ENABLED` = `0` / `operators` / `1` | no | Terraform `billing_enabled` (default `0`) |
| `BILLING_TRIAL_DAYS`, `BILLING_GRACE_DAYS` | no | optional, default 7 and 3 |
| `BILLING_CONTACT_EMAIL` | no | Terraform `billing_contact_email`: where Enterprise "Talk to us" goes |

Test and live keys are different values, rotated separately. Never put either in Git, logs, screenshots or chat.

## Razorpay setup (Test Mode first)

1. **Plans (Razorpay's step 2)** can be created two ways. In the app (recommended): on the Team page, open the plan in the Plan catalogue, enter its
   price, save, then click **Create in Razorpay** next to the price. It creates a monthly plan at exactly that amount and stores the id. Or
   create it in the Razorpay dashboard (period `monthly`, interval `1`, the catalogue amount) and paste the id. Either way, **Verify** checks a
   stored id against Razorpay (monthly cycle, same amount, same currency), and saving a changed id is refused if Razorpay doesn't know it or
   its amount, currency or cycle differ, so customers can't be charged the wrong thing. Plans can't be edited in Razorpay: for a price change,
   create a new plan and the old id is kept as "retired". Plans belong to the account and keys that created them, so test-mode ids don't work
   with live keys: create them again in live mode.
2. Make sure each priced currency of each plan you sell has an id; a plan and currency with no id can't be bought.
3. Add a webhook at `<PUBLIC_ORIGIN>/api/webhooks/razorpay` with its own secret and these events: `subscription.authenticated`,
   `activated`, `charged`, `updated`, `pending`, `halted`, `cancelled`, `completed`, `paused`, `resumed`. Compare against
   razorpay.com/docs/webhooks/subscriptions.
4. Signature: HMAC-SHA256 of the **raw** body (`X-Razorpay-Signature`); `x-razorpay-event-id` is the idempotency key in `billing_events`.
   Use a tunnel that forwards bytes untouched for local testing (for example `cloudflared tunnel --url http://localhost:3000`).

## Open items that block going live (confirm in writing with Razorpay)

- **Agency in India:** ₹24,999 + GST is above the ₹15,000 recurring-card limit RBI sets without extra authentication. Decide how to
  bill it (invoice with a payment link, UPI Autopay/eNACH if supported, or sales-assisted) before setting `AGENCY_INR`.
- **International payments** must be enabled by Razorpay for the account (KYC, bank-partner approval, site policy pages), and
  **recurring** in USD, CAD and AED must be confirmed. CAD and AED are not offered until priced and confirmed:
  add a price row in that currency to each plan in the plan catalogue (type the currency code in the plan editor, save, then fill its price and Razorpay plan id).
- **Settlement currency** and the international fee change the margin; confirm both.
- Tax: GST (India), VAT (UAE), GST/HST (Canada) are configured in Razorpay with your accountant; nothing here computes tax.
- **Growth "daily priority questions"** is not built. Growth runs weekly checks; change the pricing-page line or build it.
- Confirm Razorpay's refund and payment-failure webhook event names; this release ignores them.

## Test-mode checks

Automated (no network): `TEST_DATABASE_URL=… npm test` covers the catalogue, limits, trial, grace, read-only, signature, idempotency
(including two identical deliveries at once), ordering, failed renewal, cancellation, plan changes, reconciliation and isolation.

Manual with test keys and `BILLING_ENABLED=operators` or `1`:

| Case | Do | Expect |
|---|---|---|
| Free trial | Sign up, pick Growth, connect a test card | "Payment method connected"; no charge; Razorpay shows `authenticated` with start = trial end |
| Trial converts | Move the subscription's start to now / wait for the first charge | status Active, renewal date set, pill gone |
| Success | Buy Growth INR with a Razorpay test card | "Confirming your payment…" then `Growth · Renews <date>`; audit shows `billing.payment_verified` |
| Bad callback | POST `/api/billing/verify` with a wrong signature | 400 `bad_signature`, nothing changes |
| Lost webhook | Pay, block webhook delivery, click "Check with Razorpay now" | plan becomes active |
| Restart while read-only | Past due, halted: choose a plan | new subscription active, old one cancelled upstream |
| Duplicate webhook | Resend `subscription.activated` from the Dashboard | 200 with `duplicate:true`; one `billing_events` row |
| Failed renewal | Failing test card / `subscription.pending` | past due, 3-day grace, scheduled checks pause, manual work allowed |
| Grace expiry | `subscription.halted` | read-only, reports readable, new work refused |
| Upgrade | Growth → Agency | Razorpay charges the difference; plan changes after the charge |
| Downgrade | Growth → Starter | blocked while over Starter's limits; otherwise "Starts <date>"; "Keep Growth" withdraws it |
| Cancel | Cancel subscription | access until period end, then read-only |
| Delayed webhook | Pause delivery, pay, resume | "Still confirming…" message, plan updates when the webhook lands |
| Each currency | Repeat "Success" in INR, USD (and CAD, AED once added) | a test subscription must succeed in a currency before it is offered |

Record test event ids and the resulting states (no card data).

## Release

1. Back up the production database.
2. Deploy with `billing_enabled = "0"`. Migration 004 runs at boot under the advisory lock. Check `/api/health` is `ok:true, db:true`
   and every organisation is still `legacy`: `select plan_code, billing_status, count(*) from whitepetal.organizations group by 1, 2;`
3. `GET /api/billing/plans` shows no ids or secrets.
4. Set the live secrets (`infra/secrets.sh`), live plan ids and the live webhook with its own secret.
5. `billing_enabled = "operators"`; make one small real payment on an internal organisation, then cancel or refund and reconcile.
6. Update the pricing page; verify live prices match and that altered `plan`/`currency` values are refused.
7. `billing_enabled = "1"`: self-serve sign-up and trials open. Test a brand-new account from sign-up to paid plan.
8. Weekly for 90 days compare the plan AI-cost caps, real provider invoices and revenue per plan before changing limits or adding annual plans.

## Rollback

1. `billing_enabled = "0"` and redeploy. This is a true kill switch: **nobody is limited or locked**, whatever their plan, trial or payment
   state says (an ended trial, a failed payment). Checkout and plan changes close and new sign-ups stop getting trials. Webhooks and reconciliation keep recording and applying, so no payment is lost and turning it back on picks up the real state.
   Cancelling a subscription stays possible. `operators` enforces limits for everyone but only operators can start checkout.
2. Never drop billing columns or `billing_events`.
3. To free one organisation permanently, an operator sets `billing_status = 'internal'`, `plan_code = 'legacy'` (audit it).
4. Reconcile Razorpay subscriptions against `billing_events` before re-enabling.

Rollback triggers: a valid signature rejected or an invalid one accepted; one event changing state twice; existing organisations losing
access; a limit exceeded server-side; paid access without a webhook; secrets in logs; usage attributed across organisations.

## Annual prices, trial length per plan, extra seats (added 2026-10-15)

Set in the plan catalogue (Command Deck → Plan catalogue, or `PUT /api/admin/plans/:code`). All optional; empty keeps today's behaviour.

- **Annual price** (per currency, before tax): a second Razorpay plan billed **yearly** (`period: yearly`), created from the editor's
  "Create in Razorpay" button on the Annual row, or pasted. Env fallback: `RAZORPAY_PLAN_<PLAN>_<CCY>_ANNUAL`. Checkout takes
  `cycle: "annual"`; the subscription runs 10 yearly cycles (effectively until cancelled). The webhook records `organizations.billing_cycle`
  from the plan id it was paid on; plan changes keep the cycle (an annual subscriber moves to the target plan's annual Razorpay plan).
  MRR counts a twelfth of the yearly price. A yearly INR charge is above UPI Autopay's limit, so it is card or net banking. A replaced
  annual id is retired like a monthly one, so existing subscribers keep resolving.
- **Free trial (days)**: empty = `BILLING_TRIAL_DAYS`; 0 = no free trial on that plan (start-trial is refused; people subscribe).
  Picking a plan with a longer trial during a running trial stretches it to that length from the trial's start; a shorter one never cuts it.
  The trial still belongs to the person, once.
- **Extra seats**: `seat_amount_minor` (per seat per month, before tax, per currency) and `max_extra_seats` (empty = no cap, 0 = not sold).
  An operator sets an organisation's extra seats in its drawer (`POST /api/admin/console/customers/:slug/seats`, reason required). They add
  to the seat limit and to MRR. Billing either **invoice** (outside Razorpay) or **razorpay**: the seats added go on the subscription's next
  invoice as a Razorpay add-on, prorated to what is left of the current cycle (by `current_period_end`), and every `subscription.charged`
  (renewal) adds the cycle's seats again in full: billed in arrears, 12 months' worth on an annual plan. Lowering seats withdraws this
  cycle's mid-cycle add-ons Razorpay hasn't invoiced yet (newest first); the renewal's add-on stays, so a cut takes effect at the next
  renewal. A repeated webhook doesn't charge twice (events are idempotent). Owners can't buy seats themselves yet.
- **Before relying on it in production**, run once in Razorpay test mode: create a yearly plan from the editor, subscribe yearly, confirm
  the webhook sets `billing_cycle = annual`, add razorpay-billed seats and check the add-on appears on the next invoice.
- The customer plans page shows a Monthly/Annual switch and each plan's trial length, but it is hidden while `PAY_HIDDEN = true` in
  `public/app.js` (the current product decision).
