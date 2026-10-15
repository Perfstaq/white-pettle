# Perfstaq "Founder Command" — reference for White Petal's console

Surveyed read-only from production `apps.perfstaq.com/internal/founder/*` on 15 Oct 2026 (the `perfstaq-b2b` repo was not reachable).
White Petal's Command Deck copies this design and page structure, mapped from Perfstaq's creative-generation domain to White Petal's
AI-visibility domain (images/reels → checks/drafts/recovery actions).

## Shell

- **Sidebar** (236 px, graphite `#131317`): wordmark "Perfstaq / FOUNDER COMMAND" (mono, tracked), Search ⌘K, groups **COMPANY** (Company Pulse,
  Growth, Product Value, Customers) and **PLATFORM** (Operations, AI & Cost, Integrations, Releases & Feedback); active item: graphite-3 fill +
  coral left bar; footer: Back to the app, signed-in email, Collapse sidebar.
- **Top filter bar** (sticky, pill controls, mono uppercase labels): ENVIRONMENT (Production), ACCOUNTS (Customers only / all / a group),
  PERIOD (Last 30 days …), "Hide demo accounts" switch, "Jump to… ⌘K".
- **Page header**: mono eyebrow with icon ("COMPANY"/"PLATFORM"), 40 px semibold title, one-line purpose, right-aligned provenance line
  "As of <date> UTC · production · customers only · demo included · last 30 days", status chips ("● Live records · last event 8 min ago",
  "Outbox clear").

## Tokens (exact)

| Token | Value | | Token | Value |
|---|---|---|---|---|
| shell | `#fbfaf7` | | graphite | `#131317` / 2 `#1c1c22` / 3 `#26262e` |
| paper (cards) | `#fffdf8` / 2 `#faf6ee` | | graphite ink / muted / line | `#f3efe7` / `#a39e94` / `#2e2e37` |
| ink / ink-2 | `#1b1b1f` / `#57534b` | | coral / ink / tint | `#f2542d` / `#c23a17` / `#fde8e1` |
| muted / soft | `#736e67` / `#9a958c` | | violet / tint | `#7357e8` / `#ece8fd` |
| line / strong | `#e6dfd2` / `#cfc6b6` | | lime / bright / tint | `#5e8f12` / `#c8f25a` / `#eef6dc` |
| success / warning / danger / info | `#2e7d46` / `#b8860b` / `#b3403a` / `#3a6ea8` (+ tints) | | cyan / tint | `#0e8fa8` / `#e1f3f6` |

Type: Geist (13.5 px body), Geist Mono for eyebrows (10.5 px, uppercase, tracked) and axis labels. Radii: section cards 20 px, hero 22 px,
stat cards 16 px, pills fully round. Shadows: card `0 1px 0 #14120e0a, 0 1px 2px #14120e0a`; lift `… 0 10px 30px -12px #14120e38`.

## Components

- **Hero** ("THIS WEEK AT …"): graphite card, coral and violet blurred glows, lime-bright mono eyebrow, a large sentence; right side a
  graphite-2 sub-card (REVENUE).
- **Stat card**: paper-2 at 60 %, 16 px radius, label, 40 px number, sub-line, optional delta pill (lime "▲ +50%", coral "−100%") and coral sparkline.
  Featured variant is graphite ("Images generated · all time").
- **Section card**: mono eyebrow ("PRODUCT ENGINE", "EXCEPTIONS FIRST", "EVIDENCE, NOT A SCORE"), 17 px title, description, content, footer
  meta row (Coverage · Source · Definition v1), "Show as a table" toggle on charts.
- **Funnel**: label + count + %, thick bars (ink for the base, coral for steps, lime for outcomes); "OUTCOMES (BRANCHES, NOT STEPS)" divider.
- **Needs attention**: warning-tint rows (icon, title, explanation, big count, chevron); healthy checks folded into one line of ✓ items.
- **Brands to watch** table: Brand · Stage (coloured dot) · Last value action · Blocker / evidence (warning pill).
- **Metric tile with provenance**: value, "n of m", Coverage, Source, "As of", and a caveat line ("Unknown is not zero").
- **Account drawer** (right sheet): Account groups (add to group), then a definition list — Owner, Stage, Business type, Role · team,
  Revenue band, Heard from, Credits, Signed up, Last active, Account id.

## Pages and parameters

| Page | Sections and figures |
|---|---|
| Company Pulse | hero + revenue; Active brands (7 d, delta, sparkline), Value-producing brands, Activation within 7 days, Week-1 retention, Time to first approval; product engine weekly chart; Growth and value (active / generating / value-producing per week); Value funnel; Needs attention; Brands to watch |
| Growth | same KPIs; cohort funnel with outcomes; time to first output (median, p90); weekly movement (12 weeks); Activity (active brands 7 d, returning brands, D7 retention, campaigns per active brand); activation and retention tiles with provenance; milestones for brands created in the period |
| Product Value | generation volume, regenerations, decisions, approval (current state), rejection reasons, outcomes (self-reported), value outcomes by brand, engine logs |
| Customers | Accounts, With a business profile, Brands with a category, Brands matching health filter; Segments (business type, category, revenue, team size, role, where they sell, heard about us) ranked; Account groups (internal, left out of metrics); Accounts table (Company, Owner, Business type, Brands, Stage, Signed up, Last active, Credits) with search, sort and group tick-boxes; Brand health with filters (Blocked, No approval after 7 days, Unused approved work, Stale integration) |
| Operations | recent jobs (When, Brand, Job, Status, Timing, Requested by, Credits, Provider cost, Failure) with All/Failed/In flight/Ready; credit-ledger reconciliation; data quality and freshness; analytics export health; audit trail of founder reads and actions; founder actions (beta enrolment, credit adjustment with reason) |
| AI & Cost | reliability (success rate, retried, canceled, pending); latency (queue and execution p50/p95); cost and unit economics (known cost, coverage, unknown jobs, cost per approved creative); credits (consumed, refunded, adjustments, reserved); per-kind table; failures by reason |
| Integrations | connection funnel and publishing; by provider; connected accounts; results and matching; publishing and reliability |
| Releases & Feedback | flags (defined, default, evaluation), experiments, surveys, form validation failures |

## Principles carried over

Evidence, not a score · unknown is not zero · every figure shows its cohort, source and as-of time · internal and demo accounts can be left
out everywhere with one filter · founder actions are separate from analytics, need a reason and are audited.

## White Petal's build of it (15 Oct 2026)

| Founder Command | White Petal Command Deck | Mapping |
|---|---|---|
| Company Pulse | Company Pulse (`#pulse`) | images → checks and drafts; "approval" → first completed check; value = recovery action published / rechecked / result observed. Revenue card is live (Razorpay billing exists here). |
| Growth | Growth (`#growth`) | findings, active brands, activation, week-1 retention, time to first check (median, p90), cohort funnel, time to value, weekly movement, active people (DAU/WAU/MAU), retention cohorts, adoption, depth |
| Product Value | Product Value (`#value`) | checks (live / scheduled / failed / stopped), drafted work by kind, approval (current state), recovery actions by state, outcomes, value by brand |
| Customers | Customers (`#customers`) | stat cards, Segments (plan, billing status, brand category, automatic checks, brands per account, heard about us), Account groups (internal / demo / custom), Accounts table with tick-to-group, Brand health filters, account drawer |
| — (new) | **Plans & Subscriptions** (`#subscriptions`) | MRR, ARR, ARPA, trials, past due, new and churned (30 d); plan cards (price, price with GST, limits, AI cap, Razorpay status, on plan / paying / MRR); subscriptions table; billing events |
| — (new) | Account drawer → **Plan and subscription** | plan, status, price and price with tax, billing cycle, payment (Razorpay / contract / link sent / none), MRR counted, customer since, trial, current period, grace, cancel at period end, scheduled change, Razorpay subscription and last sync, charges recorded, AI cap, limits with custom overrides, subscription history; billing actions beside it |
| Operations | Operations (`#operations`) | recent checks with All / Failed / In flight / Done, reconciliation (usage ledger, Razorpay sync, webhooks, stuck checks), data quality, audit trail, where money actions live |
| AI & Cost | AI & Cost (`#ai`) | check success, latency p50/p95 (live, scheduled), estimated cost, per completed check, per approved action, by engine, by kind, failures by reason |
| Integrations | Integrations (`#integrations`) | connections, connected / broken / stale, by provider, needs reconnecting |
| Releases & Feedback | Releases & Feedback (`#releases`) | server switches, platform flags, revision |
| — | Live, Revenue, Margin, Plan catalogue | kept from the earlier Command Deck, restyled |

Global filter bar: Environment (Production / Staging / Local), Accounts (Customers only / All / one group), Period (7, 30, 90, 365 days),
Hide demo accounts. Implemented server-side (`scopeFrom` in `server/console.mjs`, migration `010_account_groups.sql`): every page's
figures and its provenance line ("As of … · customers only · demo included · last 30 days") follow the same filter.

## Accounts, people and operators from the console (15 Oct 2026)

| What | Where | API (all audited, `by: console`) |
|---|---|---|
| Create an account for a client (no team membership; owner invited; starts as "picks a plan" or internal) | Customers → New account | `POST /api/admin/console/accounts` |
| Rename / suspend (read-only, own message, survives the billing kill switch) / resume | Account drawer → Account settings | `PATCH /api/admin/console/accounts/:slug` |
| Delete (founders, typed id, refused while Razorpay may charge; record kept) | Account drawer → Account settings | `DELETE /api/admin/console/accounts/:slug` |
| Invite, change role, hand over ownership, remove, revoke invite | Account drawer → People | `…/accounts/:slug/people[/:id]`, `…/accounts/:slug/invites/:id` |
| Console operators: add (must have a verified account), change role, turn off, remove; founders can't lock themselves out | Platform → Team & access (founders) | `/api/admin/console/operators[/:id]` |
| Plans: create, read, update, duplicate, archive, delete | Plan catalogue | `/api/admin/plans[/:code]` (founder, finance) |
| Assign / modify a plan without a card (contract, trial, internal, custom limits) | Account drawer → Billing actions | `PATCH /api/admin/orgs/:slug/billing` (founder, finance) |

Live check against a running local server: `node scripts/verify-console-api.mjs` (53 checks, cleans up after itself).
Operator invites skip the "choose a plan first" gate (the seat limit still applies), so the team can set up a client before its owner picks a plan.
