// The recorder and the reader of billable usage.
//
// RECORDER: record() writes one event to `usage` (who, what, which engine, estimated cost) stamped with the billing period it counts
// toward, and adds it to that period's counters in `usage_counters`, in the caller's transaction, so an event and its counters can
// never disagree. READER: readCounters() returns a period's totals; server/billing.mjs compares them with the plan's limits.
//
// Counters per (organisation, period, metric): ai_usd (estimated provider cost), calls, one per kind (ask, write, inspect, serp) and
// drafts (the drafted fixes the plan limits). A new billing period is simply a new period_start key, so nothing needs resetting.
import { q } from "./db.mjs";
import { DRAFT_KINDS } from "./plans.mjs";

// Estimated list prices per call (USD), from docs/gcp-cost-plan.md. Real bills come from each provider; these exist to show the trend
// and stop runaway spend, so they err high.
export const COST = { ask: { chatgpt: 0.0145, perplexity: 0.0065, gemini: 0.004, groq: 0, aio: 0.003, aimode: 0.003, claude: 0.012 }, write: 0.002, inspect: 0.0005, site: 0.001, serp: 0.002, entity: 0 };
// Writing is priced by the size of what was sent too (about $1 per million input tokens, ~4 characters a token), so a huge prompt
// counts for what it costs rather than as one flat call.
export const costOf = (kind, engine, bytes = 0) => { const c = COST[kind]; const base = typeof c === "number" ? c : c?.[engine] ?? 0.01; return kind === "write" ? base + (bytes / 4) * 1e-6 : base; };

// Which counters one event adds to.
export function metricsFor({ kind, sub, n, costUsd }) {
  const m = [["ai_usd", costUsd], ["calls", n], [kind, n]];
  if (kind === "write" && DRAFT_KINDS.includes(sub)) m.push(["drafts", n]);
  return m;
}

// `c` is a transaction client; without one the two writes still run, but not atomically (used by after-the-fact metering of scheduled runs).
export async function record({ c = null, orgId, periodStart, workspaceId = null, userId = null, kind, engine = null, sub = null, n = 1, bytes = 0 }) {
  if (!orgId || !n || !periodStart) return null;
  const costUsd = +(costOf(kind, engine, bytes) * n).toFixed(5);
  const run = c ? (text, params) => c.query(text, params) : (text, params) => q(text, params).then((rows) => ({ rows }));
  await run(`insert into usage (org_id, workspace_id, user_id, kind, engine, sub, n, cost_usd, period_start) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [orgId, workspaceId, userId, kind, engine, sub, n, costUsd, periodStart]);
  for (const [metric, amount] of metricsFor({ kind, sub, n, costUsd })) {
    await run(`insert into usage_counters (org_id, period_start, metric, used) values ($1, $2, $3, $4)
               on conflict (org_id, period_start, metric) do update set used = usage_counters.used + excluded.used, updated_at = now()`, [orgId, periodStart, metric, amount]);
  }
  return { costUsd };
}

// A period's totals as { metric: number } (missing metrics are 0).
export async function readCounters(orgId, periodStart, c = null) {
  const rows = c ? (await c.query(`select metric, used::float as used from usage_counters where org_id = $1 and period_start = $2`, [orgId, periodStart])).rows
    : await q(`select metric, used::float as used from usage_counters where org_id = $1 and period_start = $2`, [orgId, periodStart]);
  return Object.fromEntries(rows.map((r) => [r.metric, r.used]));
}
