# What White Petal sells, and what the Command Deck must show

Written 15 Oct 2026 after reading the product code (`server/metrics.mjs`, `server/runner.mjs`, `public/recommendation-model.js`,
`server/billing.mjs`, `server/routes.mjs`). The console was first shaped after Perfstaq's Founder Command, whose product is creative
generation (images, reels, approvals, credits). White Petal's product is different, so its business has to be read in its own units.

## 1. The product, as the code defines it

```
Organisation ─┬─ Brand (workspace) ── profile (name, site, category) + competitors
              │       └─ Questions (prompts) ── intent: informational → discovery, commercial → consideration, transactional → decision
              │       └─ Engines (ChatGPT, Perplexity, Gemini, AI Overviews, AI Mode, Groq) × samples (answers per question)
              │       └─ Check (run): every question × engine × sample → answers → summary
              │             summary = visibility (share of answers naming you), share of voice, position, sentiment,
              │                       visibility score 0–100, rank among brands, leader rival, per-engine visibility
              │       └─ Recommendation gaps: questions where AI names rivals and never you
              │       └─ Recovery actions (pitch, article, fix pack…) → approved → published → recheck → result
              │             result.direction = improved | unchanged | regressed | incomparable (a later comparable check)
              └─ Seats, integrations (Bing, Google, Cloudflare…), schedule (off / weekly / daily)
```

**The promise** (`public/product-language.js`): find the recommendation gaps, fix the evidence, track the recovery.
**The outcome a customer pays for**: their brand named more often, higher, in the AI answers that matter, and proof of it over time.

## 2. The units the business runs on

| Unit | Where it lives | Why it matters to the business |
|---|---|---|
| Brands | `workspaces` | Plan limit; agencies buy for many brands |
| Questions tracked | `setup.questions` (on) | **The main plan limit and the main cost driver** |
| Engines × samples | `setup.engines`, `workspaces.samples` | Multiply cost per question; engines are plan-gated |
| Check frequency | `workspaces.schedule` | Weekly vs daily = 4× vs 30× cost a month |
| Competitors | `setup.profile.competitors` | Plan limit; defines who you're measured against |
| Answers collected | `usage` kind `ask` | One AI call each: the real unit of cost |
| Drafted fixes | `usage` sub pitch/article/fixpack | Plan limit; the "fix the evidence" step |
| Visibility score, rank, share of voice | `runs.summary` | **The customer's outcome**; the reason to renew |
| Recheck results | `recovery_actions.result.direction` | Proof that White Petal's work moved the number |

**Cost to serve one brand a month** ≈ questions × engines × samples × checks a month × cost per answer (+ cited-page inspections and
writing). A daily schedule costs about 7× a weekly one. Plans cap questions, brands, competitors, samples, engines, schedules and drafts —
not credits — so **pricing health is "usage against those caps" and "AI cost against price", per plan.**

## 3. What a founder, a product manager and an analyst need to read from the console

| Question | Answer in White Petal's units | Was it in the console? |
|---|---|---|
| Are customers getting the outcome? | Median visibility score now; change since each brand's first check; share of brands improving; rank change | **No** |
| Does the recovery loop work? | Rechecks improved / unchanged / regressed; gaps found by type vs closed | Partly (actions by state, no results) |
| Where do we win and lose? | Visibility by engine across customers; rivals that most often lead | **No** |
| How deep is usage? | Questions tracked per brand, engines per brand, schedule mix, answers collected | **No** (only check counts) |
| Is the price right? | Per plan: usage vs each cap, which cap binds, AI cost vs price | **No** (margin per org only) |
| Who will expand, who will churn? | Accounts at ≥80 % of question/brand/seat caps (expansion); paying accounts using <25 % and not checking (churn risk) | **No** |
| What does a unit cost? | Cost per answer by engine, per question per month, per brand per month | Partly (cost per check) |
| What's the market? | Categories, question intent mix, engines chosen | Partly (categories) |

## 4. What changes

1. **Customer outcomes** (Company Pulse and Product Value): median visibility score, score change from first to latest check,
   improving / flat / declining brands, rank and share-of-voice change, visibility by engine, rivals that most often lead,
   recheck results (improved / unchanged / regressed) and gaps by type (open vs closed).
2. **Plan fit** (new page under Revenue): per plan, median and p90 usage of every cap (brands, questions, competitors, seats, drafts,
   engines, daily schedules), how many accounts sit at ≥80 % of a cap, which cap binds most, AI cost to serve against price;
   an **expansion list** (near caps, by revenue) and an **at-risk list** (paying, low usage, no recent check).
3. **Cost in product units** (AI & Cost): cost per answer by engine, per question per month, per brand per month; a projected monthly
   cost per brand from its own setup (questions × engines × samples × schedule) next to what its plan pays.
4. **Usage depth** (Growth): questions tracked, engines and schedules chosen, answers collected, question intent mix.
5. **Verification**: a script recomputes the headline figures straight from the tables and compares them with the console's API.

## 5. Where it lives and how it's checked

| Change | Server (`server/console-founder.mjs`) | Endpoint (`/api/admin/console/…`) | Page |
|---|---|---|---|
| Customer outcomes | `outcomes` | `outcomes` | Company Pulse KPIs, Product Value |
| Plan fit, expansion, at-risk | `planFit` | `plan-fit` (founder, finance, analyst) | Revenue › Plan fit |
| Cost in product units | `unitCosts` | `unit-costs` (founder, finance, analyst) | AI & Cost |
| Usage depth | `usageDepth` | `usage-depth` | Growth |

- `scripts/verify-console-metrics.mjs` recomputes MRR, paying accounts, questions tracked, median score, comparable / improving /
  declining brands, recheck results, answers, cost per answer and Starter's median questions from the raw tables in plain JS, and
  compares each with the API (16 of 16 match on the demo data).
- `test/server/api.test.mjs` ("business in product units") builds one Starter account with known numbers (13 of 14 questions on,
  3 competitors, two engines, weekly, scores 40 → 55 over 19 days, four answers at $0.01) and checks every figure on all four endpoints,
  plus that support can't read pricing and cost.

Rules worth knowing when reading the pages: a brand is *comparable* only with two scored checks at least 7 days apart, and
*improving* / *declining* means ±5 points; a switched-off question doesn't count; a cap of 1 (one brand, one seat) is the plan's shape
and never counts as "near the cap"; seats used include pending invites, like the product's own seat check.

Kept from the Founder Command design: the shell, the provenance line, account groups and filters, evidence-not-a-score, "unknown is not
zero". Dropped as Perfstaq-specific: anything framed as images, reels, approvals or credits.
