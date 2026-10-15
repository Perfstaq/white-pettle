# Command Deck: how every number is worked out, and where it can be wrong

Written 15 Oct 2026. Every figure below is computed when a page loads, from White Petal's own Postgres tables. **Nothing on these
pages is read from Razorpay** (Razorpay only changes our tables through webhooks and the daily sync). "Risk" says where a number can
mislead, and what to do about it. A ✅ marks a risk fixed in code; the rest are known limits.

Check the figures yourself: `scripts/verify-console-metrics.mjs` recomputes the headline numbers from the raw tables with separate
code and compares them with the console (16 of 16 match on the demo data).

The global filter (top bar) applies to almost everything: **Accounts** (customers only / all / one group), **Period** (7, 30, 90, 365
days) and **Hide demo**. "Customers only" leaves out accounts in a group marked *leave out* (e.g. Founding team). An account in no
group **counts as a customer**.

---

## 1. Money

| Figure | Exact rule | Code |
|---|---|---|
| **Paying account** | `billing_status` is `active` or `past_due` **and** its plan has a price above 0 in its currency | `mrrOf`, `server/console.mjs:13` |
| **MRR** | Sum over paying accounts of: catalogue price for its plan, currency and cycle (annual = yearly price ÷ 12), **before GST**, + `extra_seats × the plan's seat price`. USD converted to INR at `CONSOLE_USD_INR` (84) | `mrrOf`, `toInrMinor` |
| **ARR** | MRR × 12 | `console-founder.mjs` pulse / plansSubs |
| **ARPA** | MRR ÷ paying accounts | plansSubs |
| **Contracted MRR** | The part of MRR from accounts with **no** Razorpay subscription (given a plan by an operator) | `orgRows` → `contracted` |
| **Trials** | Accounts whose status is `trialing` **and** whose trial end is still in the future | `liveTrial`, `server/console.mjs` |
| **New / churned (30 days)** | Count of audit events `billing.activated` / `billing.cancelled` in 30 days | plansSubs `flow` |
| **Margin** | `1 − AI cost this month (USD) ÷ revenue (USD)`, revenue = MRR ÷ 84 for INR | `marginPct` |

**Risks**

1. **MRR is what accounts *should* pay, not what was paid.** It uses today's catalogue price, not Razorpay invoices. Refunds,
   discounts, failed charges and partial payments don't lower it. *To check:* compare with Razorpay's settlement report monthly.
2. **Editing a plan's price changes every existing customer's MRR at once**, but Razorpay keeps charging the amount of the Razorpay
   plan they subscribed to (Razorpay plans can't be edited; the old id is kept as "retired"). MRR and real charges then disagree.
   *Do:* treat a price change as "new price for new customers" and expect MRR to be wrong for the old ones until they move.
3. **`past_due` counts as paying.** A failed renewal stays in MRR through the grace period. *Do:* read MRR together with the
   "failed payments" count.
4. **Operator-assigned contracts count at catalogue price** even if the invoice you send says something else, and even before it is
   paid. (E.g. *Direct Assign Co*, the test account, adds ₹1,999 to MRR now.) *Do:* put test accounts in the *Founding team* group
   (leave out) or delete them.
5. **USD at a fixed 84.** Change `CONSOLE_USD_INR` when the rate moves.
5a. **An account on a cycle the plan no longer prices counts as ₹0.** If a plan's annual price is removed while someone pays yearly,
   they drop out of MRR and "paying" without warning. Keep a price for every cycle someone is on.
6. **Churn and new counts only see Razorpay events.** An operator ending a contract (status → canceled from the console) is written
   as `billing.operator_set`, so it is **not** counted as churn; an operator-assigned contract is not counted as new.
7. ✅ **Expired trials were counted as trials.** An unpaid trial keeps the status `trialing` after it ends (access is decided from the
   date). The Trials figures now count only trials whose end date is in the future.
8. **Accounts in no group count as customers**, including the founders' own and test accounts. Group them.

## 2. AI cost

| Figure | Exact rule | Code |
|---|---|---|
| **One AI call** | One row in `usage`. One answer from one engine = one `ask` row | `record`, `server/usage.mjs:27` |
| **Cost of a call** | A fixed **estimated** list price per call, written when the call is made: ChatGPT $0.0145, Perplexity $0.0065, Gemini $0.004, AI Overviews / AI Mode $0.003, Claude $0.012, Groq $0, writing $0.002 + $1 per million input tokens, page read $0.0005 | `COST`, `server/usage.mjs:14` |
| **AI this month** | Sum of `usage.cost_usd` since the 1st of the month | `orgRows.spent_usd` |
| **Cost per answer / question / brand** | Answer = ask cost ÷ ask rows (30 days); question = ask cost ÷ active questions; brand = all cost ÷ brands with a check in 30 days | `unitCosts` |
| **Projected monthly cost of a brand** | questions × engines × answers per question × checks a month (daily 30, weekly 4.3, off = its real checks in 30 days) × average cost per answer | `unitCosts` |

**Risks**

1. **Costs are estimates, not provider bills.** A long answer costs the same as a short one. The prices were set to err high.
   *Do:* compare with the OpenAI / Perplexity / Google invoices monthly and adjust `COST`.
2. **Customers using their own AI keys are still charged to our margin.** Every call is recorded with a cost whoever's key paid
   for it, and the row doesn't say which key was used, so margin is understated for those accounts.
3. **The projected brand cost uses the average cost per answer across all engines**, not that brand's own engines: a
   Perplexity-only brand is projected too low, a Groq-only one too high.
4. Groq is recorded as $0, so its share of cost is invisible.

## 3. Checks, usage and limits

| Figure | Exact rule |
|---|---|
| **Check** | A row in `runs`. Counted as done when `status = 'done'`. Live = run in the browser, scheduled = run by the server |
| **Checks used (plan limit)** | Runs this billing period that are done or stopped, or left running for 30+ minutes |
| **Questions used** | Switched-on questions across the account's brands (`setup.questions` where `on` isn't false) |
| **Seats used** | Members + invites still open |
| **Drafted fixes used** | `usage` rows of kind write, sub `pitch` / `article` / `fixpack` this period |
| **Competitors used** | The most competitors on any one brand |
| **Website pages read per check** | New limit `pages` (migration 012): the cited pages a check opens and reads. Empty = 24 for a live check, 18 for a scheduled one |

**Limits that apply** = the plan's limits, replaced by any *custom limits* set on the account (drawer › Limits) until their end date,
+ extra seats. Custom limits never change the plan, price or Razorpay subscription.

**Risks**

1. **Lowering a limit doesn't remove anything** (brands and questions stay); it only blocks new ones. "Used" can be above "Now".
2. **The pages limit is applied by the browser in live checks** (it reads the account's limit and stops there). A tampered browser
   could read more pages; each page read is still metered and stopped by the monthly AI budget. Scheduled checks enforce it on the
   server.
3. **Drafts and checks reset by billing period** (the trial start, or the subscription's period start), not by calendar month,
   while "AI this month" is by calendar month. The two windows differ for most accounts.

## 4. Engagement and growth

| Figure | Exact rule |
|---|---|
| **Active brands (7 days)** | Brands with any check, AI call or recovery-action change in 7 days |
| **Activation** | Of brands older than 7 days: share whose first check came within 168 hours of creation |
| **Week-1 retention** | Of brands whose first-check week and the week after are both over: share with another check that next week |
| **Funnel** | Brands → profiled → checked → drafted → approved |
| **DAU / WAU / MAU** | Distinct people with a page view or sign-in that day / 7 / 30 days |
| **Health 0–100** | Checks in 14 days (30), recovery actions (20), seats filled (10), integrations (10), AI budget left (10), payment ok (10), last login (10) |

**Risks**

1. **Weeks are in UTC** (`date_trunc('week', now())`): an Indian Monday morning before 5:30 belongs to the previous week.
2. **Health weights are a judgement**, not learned from churn. Use the band (Thriving / Steady / At risk / Dormant) as a prompt to
   look, not as a fact.
3. Someone who only signs in and leaves can drop out of DAU after they sign out (their session row is deleted).

## 5. Customer outcomes (Product Value)

| Figure | Exact rule |
|---|---|
| **Visibility score** | `runs.summary.score` (0–100) from the check: named in answers 50 %, share of voice 20 %, position 20 %, sentiment 10 % (`server/metrics.mjs`) |
| **Comparable brand** | 2+ scored checks, the latest at least 7 days after the first |
| **Improving / declining** | Latest score − first score is +5 or more / −5 or less |
| **Recheck improved** | `recovery_actions.result.direction = 'improved'` |

**Risks**

1. **First and latest checks may not ask the same questions or engines.** Adding questions or an engine moves the score without
   anything changing in the market. The comparison doesn't adjust for that.
2. **Small samples are noisy**: one answer per question per engine can swing a score several points; ±5 is a rough line.
3. A brand's latest check can be weeks old; the *stale* count (21+ days) says how many.

## 6. Plan fit and unit economics

- **Near a cap** = using 80 % or more of a limit; **at cap** = 100 %. A cap of 1 (one brand, one seat) is the plan's shape and
  never counts as "near".
- **Binding cap** = the limit the most accounts on that plan are near.
- **Expansion list** = accounts near any cap (not cancelled), by MRR. **At-risk list** = paying accounts with no check in 14 days or
  using under 25 % of their questions.

**Risk:** plan fit counts every account on a plan, including trials and operator contracts, so a plan with many trials looks
emptier than its paying customers.

---

## What to do regularly

| When | Check |
|---|---|
| Monthly | MRR vs Razorpay settlements; AI cost vs provider invoices; `CONSOLE_USD_INR` |
| After a price change | Expect MRR to be off for existing subscribers until they move to the new Razorpay plan |
| After adding test or internal accounts | Put them in the *Founding team* group or delete them |
| Any time | `node scripts/verify-console-metrics.mjs` against a local copy |
