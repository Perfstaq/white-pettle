// What an organisation may do right now, decided on the server. Routes, the AI gate and the scheduler call the
// helpers here before any work; the browser only mirrors the answer to explain a lock, hiding a control is never
// enforcement. Legacy/internal organisations (everyone today) are unlimited, so nothing changes until an
// organisation is deliberately moved onto a plan, started on a trial, or subscribes.
import { q, tx } from "./db.mjs";
import { fail } from "./http.mjs";
import { PLANS, DRAFT_KINDS, effectiveEntitlements, nextPlan, finite } from "./plans.mjs";
import { readCounters } from "./usage.mjs";
import { billingConfig } from "./razorpay.mjs";

// write  - everything the plan allows (internal, active, trial in date, cancelled but paid up)
// manual - past due inside the grace period: people may still work, unattended (scheduled) spend is paused
// read   - reports stay readable; new checks, drafts, edits, invites, integrations and scheduled jobs are locked
export function accessMode(org, now = new Date()) {
  const after = (t) => !!t && new Date(t) > now;
  if (org?.paused_at) return "read"; // suspended by a platform operator: reports stay readable, nothing new runs
  switch (org?.billing_status) {
    case "internal": return "write";
    case "new": return "read"; // signed up, no plan chosen yet: picking one starts the trial
    case "active":
      // A cancellation whose webhook never arrived must not give free access forever: the daily reconciliation fixes the
      // status, and this stops access one day after the paid period regardless.
      if (org.cancel_at_period_end && org.current_period_end && now.getTime() > new Date(org.current_period_end).getTime() + 864e5) return "read";
      // Active with no Razorpay subscription is an operator grant (an invoiced contract): it ends on its date.
      if (!org.razorpay_subscription_id && org.current_period_end && !after(org.current_period_end)) return "read";
      return "write";
    case "trialing":
      if (after(org.trial_ends_at)) return "write";
      // A payment method is connected: the first charge is due as the trial ends. Give it a day to land before locking anyone out.
      return org.razorpay_subscription_id && org.trial_ends_at && now.getTime() < new Date(org.trial_ends_at).getTime() + 864e5 ? "write" : "read";
    case "past_due": return after(org.grace_ends_at) ? "manual" : "read";
    case "canceled": return after(org.current_period_end) ? "write" : "read";
    default: return "read";
  }
}

const startOfMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
// Allowances (drafted fixes) count from the plan's own period, not the calendar month.
export function periodStart(org, now = new Date()) {
  if (org.billing_status === "trialing") return org.trial_started_at ? new Date(org.trial_started_at) : startOfMonth(now);
  if (["active", "past_due", "canceled"].includes(org.billing_status) && org.current_period_start) return new Date(org.current_period_start);
  return startOfMonth(now);
}

const run = (c, text, params) => (c ? c.query(text, params).then((r) => r.rows) : q(text, params));
const ACTIVE_Q = `jsonb_array_elements(case when jsonb_typeof(w.setup->'questions') = 'array' then w.setup->'questions' else '[]'::jsonb end)`;

// The organisation's plan, mode and entitlements, and (with usage: true) what it has used. Pass a transaction
// client `c` to read inside a guarded() section.
export async function billingState(orgId, { c = null, usage = false, now = new Date() } = {}) { // usage: true, or "drafts" for just that counter
  const org = (await run(c, `select id, plan_code, billing_status, billing_currency, trial_started_at, trial_ends_at, current_period_start,
      current_period_end, grace_ends_at, pending_plan_code, cancel_at_period_end, entitlement_overrides, razorpay_subscription_id, paused_at, billing_cycle, extra_seats from organizations where id = $1`, [orgId]))[0];
  if (!org) fail(404, "Organisation not found.");
  // During the free trial everyone has the same Trial limits, whatever plan they picked; that plan's limits start when it does.
  const entCode = org.billing_status === "trialing" ? "trial" : org.plan_code;
  const st = { org, plan: PLANS[org.plan_code] || PLANS.trial, mode: accessMode(org, now), ent: effectiveEntitlements(entCode, org.entitlement_overrides, now), since: periodStart(org, now) };
  // BILLING_ENABLED=0 is the kill switch: nobody is limited or locked, whatever their plan or payment state says. The data
  // keeps updating underneath (webhooks, reconciliation), so turning it back on picks up where things really are.
  // Add-on seats sit on top of whatever the plan (or an operator's grant) allows.
  if (org.extra_seats > 0 && st.ent.seats !== Infinity) st.ent = Object.freeze({ ...st.ent, seats: st.ent.seats + org.extra_seats });
  if (billingConfig().enabled === "0") { st.mode = org.paused_at ? "read" : "write"; st.ent = effectiveEntitlements("legacy"); }
  if (usage) st.used = await usageOf(orgId, st.since, c, usage === true ? null : usage);
  return st;
}
// What the organisation has used. Brands, questions and seats are counted as they stand now (they are state, not events); drafted
// fixes and AI spend come from the recorder's counters for the current billing period (server/usage.mjs).
async function usageOf(orgId, since, c = null, only = null) {
  const live = {
    // A brand's markets (its country versions) are not more brands: they count against `markets`, per brand.
    brands: `(select count(*)::int from workspaces where org_id = $1 and parent_id is null)`,
    questions: `(select count(*)::int from workspaces w, ${ACTIVE_Q} e where w.org_id = $1 and e->>'on' is distinct from 'false')`,
    seats: `((select count(*)::int from memberships where org_id = $1) + (select count(*)::int from invitations where org_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()))`,
    // A check counts once it finished or was stopped, or was left running (tab closed) for half an hour. The run in progress doesn't count,
    // so its own questions are never refused.
    checks: `(select count(*)::int from runs r join workspaces w on w.id = r.workspace_id where w.org_id = $1 and r.started_at >= $2
              and (r.status in ('done', 'stopped') or (r.status = 'running' and r.updated_at < now() - interval '30 minutes')))`,
  };
  const names = only ? [only].filter((n) => live[n]) : Object.keys(live);
  const sql = names.map((k) => `${live[k]} as ${k}`).join(", "), ps = names.includes("checks") ? [orgId, since] : [orgId];
  const used = names.length ? (await run(c, `select ${sql}`, ps))[0] : {};
  if (!only || only === "drafts") { const k = await readCounters(orgId, since, c); used.drafts = Math.round(k.drafts || 0); if (!only) { used.aiUsd = k.ai_usd || 0; used.calls = Math.round(k.calls || 0); } }
  return used;
}

// ── the reader: recorded usage compared with the plan ─────────────────────────
// One row per limit the plan has: used, limit (null = unlimited), what is left, and a state the page can colour.
//   unlimited | ok | warn (80% or more) | full (exactly at the limit) | over (past it, e.g. after a downgrade)
const ROWS = [["brands", "Brands", "now", "tracked at once"], ["questions", "Tracked questions", "now", "across all brands"], ["checks", "Checks", "period", "runs of your prompts"], ["seats", "Seats", "now", "people and open invites"], ["drafts", "Drafted fixes", "period", "pitches, articles and fix packs"]];
export function meterState(used, limit) {
  if (limit === null || limit === undefined || limit === Infinity) return "unlimited";
  if (used > limit) return "over"; if (used >= limit) return "full"; return limit > 0 && used / limit >= 0.8 ? "warn" : "ok";
}
export function usageReport(st, ai = null) {
  const o = st.org, e = st.ent, u = st.used || {};
  const metrics = ROWS.map(([key, label, scope, note]) => {
    const limit = e[key] === Infinity || e[key] == null ? null : e[key], used = u[key] ?? 0;
    return { key, label, scope, note, used, limit, remaining: limit === null ? null : Math.max(0, limit - used), pct: limit ? Math.min(1, used / limit) : 0, state: meterState(used, limit) };
  }).filter((m) => m.key !== "checks" || m.limit !== null); // checks are only limited on the free trial
  const month = startOfMonth(), nextMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  const period = o.billing_status === "trialing" ? { kind: "trial", start: o.trial_started_at, end: o.trial_ends_at }
    : ["active", "past_due", "canceled"].includes(o.billing_status) && o.current_period_start ? { kind: "plan", start: o.current_period_start, end: o.current_period_end } : { kind: "month", start: month, end: nextMonth };
  return { period, metrics, ai: ai ? { pct: ai.pct, state: ai.over ? "over" : ai.warn ? "warn" : ai.pct == null ? "unlimited" : "ok", source: ai.source } : null,
    features: { engines: e.engines, schedules: e.schedule, integrations: e.integrations, competitors: e.competitors === Infinity ? null : e.competitors, markets: e.markets === Infinity ? null : e.markets, samples: e.samples === Infinity ? null : e.samples },
    over: metrics.filter((m) => m.state === "over").map((m) => m.key) };
}

// ── errors ────────────────────────────────────────────────────────────────────
const LABEL = { markets: "market", brands: "brand", questions: "prompt", competitors: "competitor", seats: "seat", drafts: "drafted fix", checks: "check", engines: "engine", schedule: "schedule", samples: "answer", integrations: "integration" };
export function limitError(st, capability, used, limit) {
  const trial = st.org.billing_status === "trialing", plan = trial ? "The free trial" : st.plan.name;
  const msg = limit === 0 || (Array.isArray(limit) && !limit.length) ? `${plan} doesn't include ${LABEL[capability]}s.`
    : Array.isArray(limit) ? `${plan} doesn't include that ${LABEL[capability]}.`
    : `${plan} includes ${limit} ${LABEL[capability]}${limit === 1 ? "" : "s"}${{ competitors: " per brand", markets: " per brand", samples: " per prompt" }[capability] || ""} (you have ${used}).`;
  if (trial && capability === "checks") fail(402, "Choose a plan to run your prompts again. Paying now starts your plan today; your reports stay readable.", { code: "plan_limit", capability, used, limit, plan: "trial", nextPlan: null, nextPlanName: null, trialDone: true });
  if (trial) fail(402, `${msg} The trial is the same for every plan; ${PLANS[st.org.plan_code]?.selfServe ? `${st.plan.name}'s limits start` : "your plan's limits start"} when the trial ends.`, { code: "plan_limit", capability, used, limit: Array.isArray(limit) ? null : limit, plan: "trial", nextPlan: null, nextPlanName: null });
  fail(402, `${msg} Upgrade to ${PLANS[nextPlan(st.org.plan_code)].name} for more.`, { code: "plan_limit", capability, used, limit: Array.isArray(limit) ? null : limit, plan: st.org.plan_code, nextPlan: nextPlan(st.org.plan_code), nextPlanName: PLANS[nextPlan(st.org.plan_code)].name });
}
const READ_ONLY = {
  new: "Choose a plan to start your free trial.",
  trialing: "Your free trial has ended. Choose a plan to keep running checks. Your reports stay readable.",
  past_due: "Your last payment didn't go through, so the organisation is read-only. Update your payment method to continue.",
  canceled: "This subscription has ended, so the organisation is read-only. Choose a plan to continue.",
};
export function assertWrite(st, { unattended = false } = {}) {
  if (st.mode === "write" || (st.mode === "manual" && !unattended)) return;
  // A suspension is not a billing problem, so it doesn't ask anyone to pay (the upgrade pop-up keys off billing_read_only).
  if (st.org.paused_at) fail(403, "This organisation is suspended by the White Petal team. Your reports stay readable. Contact support to restore it.", { code: "suspended" });
  // 'new' after a trial (it ended or was cancelled): there is no trial left to start.
  // Trial length is per plan now, so say how long this one was rather than assuming 7 days.
  const days = st.org.trial_started_at && st.org.trial_ends_at ? Math.round((new Date(st.org.trial_ends_at) - new Date(st.org.trial_started_at)) / 864e5) : 0;
  const msg = st.org.billing_status === "new" && st.org.trial_ends_at ? "Your free trial has ended. Choose a plan to subscribe. Your reports stay readable."
    : st.org.billing_status === "trialing" && days > 0 ? READ_ONLY.trialing.replace("free trial", `${days}-day trial`) : READ_ONLY[st.org.billing_status];
  fail(402, msg || "This organisation is read-only. Choose a plan to continue.", { code: "billing_read_only", status: st.org.billing_status });
}
export async function needWrite(orgId) { assertWrite(await billingState(orgId)); }

// Run `fn(c, state)` with the organisation row locked, so two requests can't both slip under a creation limit.
// "no key update" still lets inserts that reference the organisation (workspaces, invitations) proceed.
export async function guarded(orgId, fn, usage = true) { // usage: true (all counters), "drafts", or false (state only)
  return tx(async (c) => {
    await c.query(`select 1 from organizations where id = $1 for no key update`, [orgId]);
    return fn(c, await billingState(orgId, { c, usage }));
  });
}

// ── limits ────────────────────────────────────────────────────────────────────
export function assertBrandCreate(st) { if (st.used.brands >= st.ent.brands) limitError(st, "brands", st.used.brands, st.ent.brands); }
// `have`: the markets this brand tracks now, its own included.
export function assertMarketCreate(st, have) { if (have >= st.ent.markets) limitError(st, "markets", have, st.ent.markets); }
const active = (setup) => (Array.isArray(setup?.questions) ? setup.questions : []).filter((x) => x && x.on !== false).length;
const rivals = (setup) => (Array.isArray(setup?.profile?.competitors) ? setup.profile.competitors.length : 0);
// A save may never push questions or competitors past the plan, but one that doesn't add any is always allowed, so an
// organisation over its limit (after a downgrade, or a grant that ended) can still trim down. Nothing is deleted for them.
export async function assertSetup(st, c, setup, prev, workspaceId) {
  const nq = active(setup), pq = active(prev);
  if (nq > pq) {
    const other = (await run(c, `select count(*)::int as n from workspaces w, ${ACTIVE_Q} e where w.org_id = $1 and w.id is distinct from $2 and e->>'on' is distinct from 'false'`, [st.org.id, workspaceId || null]))[0].n;
    if (other + nq > st.ent.questions) limitError(st, "questions", other + nq, st.ent.questions);
  }
  if (rivals(setup) > rivals(prev) && rivals(setup) > st.ent.competitors) limitError(st, "competitors", rivals(setup), st.ent.competitors);
}
export function assertSchedule(st, schedule, samples, w) {
  if (schedule !== w.schedule && !st.ent.schedule.includes(schedule)) limitError(st, "schedule", schedule, st.ent.schedule);
  if (samples !== w.samples && samples > st.ent.samples) limitError(st, "samples", samples, st.ent.samples);
}
// `operator`: the White Petal team setting up an account may invite people before its owner picks a plan; the seat limit still applies.
export async function assertSeat(orgId, { operator = false } = {}) {
  const st = await billingState(orgId, { usage: true }); if (!operator) assertWrite(st);
  // ponytail: not under the org lock (an invite sends email); two admins inviting at the same instant can exceed by one.
  if (st.used.seats >= st.ent.seats) limitError(st, "seats", st.used.seats, st.ent.seats);
}
export const allowsIntegration = (e, provider) => e.integrations === "all" || (Array.isArray(e.integrations) && e.integrations.includes(provider));
export async function assertIntegration(orgId, provider) {
  const st = await billingState(orgId); assertWrite(st);
  if (!allowsIntegration(st.ent, provider)) limitError(st, "integrations", provider, st.ent.integrations === "all" ? [] : st.ent.integrations);
}
// Before an AI call: the engine must be on the plan, and drafted fixes must be within the allowance. Pure, so the caller can run it
// inside guarded() together with recording the usage: check and record are then one atomic step, and a burst of simultaneous
// requests can't all slip under the limit.
export function checkAi(st, { kind, engine, writeKind }) {
  assertWrite(st);
  if (kind === "ask" && engine && !st.ent.engines.includes(engine)) limitError(st, "engines", engine, st.ent.engines);
  if (kind === "write" && DRAFT_KINDS.includes(writeKind) && st.used.drafts >= st.ent.drafts) limitError(st, "drafts", st.used.drafts, st.ent.drafts);
  if (kind === "ask" && st.ent.checks !== Infinity && st.used.checks >= st.ent.checks) limitError(st, "checks", st.used.checks, st.ent.checks);
}
// The free trial's checks are all used (its window may still be open).
export async function trialUsedUp(orgId) {
  const st = await billingState(orgId, { usage: "checks" });
  return st.org.billing_status === "trialing" && st.ent.checks !== Infinity && st.used.checks >= st.ent.checks;
}
// Another check (a queued or scheduled run): only the free trial limits how many.
export function assertCheck(st) { if (st.ent.checks !== Infinity && (st.used?.checks || 0) >= st.ent.checks) limitError(st, "checks", st.used.checks, st.ent.checks); }
export const needsDraftCount = (kind, writeKind) => kind === "write" && DRAFT_KINDS.includes(writeKind);
// The usage counter an AI call needs checked: drafts for a drafted fix, checks for a question asked to an engine, none otherwise.
export const aiUsage = (kind, writeKind) => (needsDraftCount(kind, writeKind) ? "drafts" : kind === "ask" ? "checks" : false);

// What the browser shows: plan, status, mode, renewal and the reader's comparison of usage with limits. No provider ids.
export async function billingSummary(orgId, { ai = null } = {}) {
  const st = await billingState(orgId, { usage: true }), o = st.org;
  // Paid by a one-time link (no renewal): the running period is the one a paid link set.
  const oneTime = o.billing_status === "active" && !o.razorpay_subscription_id && !!o.current_period_end
    && !!(await q(`select 1 from payment_links where org_id = $1 and status = 'paid' and period_end = $2 limit 1`, [orgId, o.current_period_end]))[0];
  return { plan: { code: o.plan_code, name: st.plan.name, description: st.plan.description, status: o.billing_status, currency: o.billing_currency, cycle: o.billing_cycle || "monthly", extraSeats: o.extra_seats || 0, pendingPlan: o.pending_plan_code, cancelAtPeriodEnd: !!o.cancel_at_period_end, oneTime },
    mode: st.mode, trialStartedAt: o.trial_started_at, trialEndsAt: o.trial_ends_at, periodEnd: o.current_period_end, graceEndsAt: o.grace_ends_at, limits: finite(st.ent), used: st.used, nextPlan: nextPlan(o.plan_code), report: usageReport(st, ai),
    // The placeholder "trial" plan means no plan has been picked yet; picking one switches the trial to that plan's limits.
    trialChosen: o.plan_code !== "trial", trialAvailable: o.billing_status === "new" ? await trialAvailable(orgId) : o.billing_status === "trialing",
    paymentMethod: { connected: !!o.razorpay_subscription_id && ["trialing", "active", "past_due"].includes(o.billing_status), firstChargeAt: o.billing_status === "trialing" && o.razorpay_subscription_id ? o.trial_ends_at : null } };
}

// ── Razorpay webhook state machine ────────────────────────────────────────────
// Pure: (organisation row, verified event) -> the columns to change. Only a signed webhook gets here, and it is the
// only thing that changes a plan or status. Events older than the last applied one are ignored, so a late delivery
// can't undo a newer state. Razorpay event names: razorpay.com/docs/webhooks/subscriptions (checked 12 Oct 2026).
const unix = (v) => (v ? new Date(Number(v) * 1000) : null);
export function applyEvent(org, evt, { planOf, now = new Date(), graceDays = 3 } = {}) {
  const sub = evt?.payload?.subscription?.entity;
  if (!sub) return { status: "ignored", reason: "not a subscription event" };
  const at = unix(evt.created_at) || now;
  if (org.billing_event_at && at < new Date(org.billing_event_at)) return { status: "ignored", reason: "older than the last applied event" };
  const patch = { billing_event_at: at };
  const mapped = planOf(sub.plan_id);
  const adopt = () => { patch.plan_code = mapped.plan; patch.billing_currency = mapped.currency; patch.billing_cycle = mapped.cycle || "monthly"; if (org.pending_plan_code === mapped.plan) patch.pending_plan_code = null; };
  if (sub.customer_id) patch.razorpay_customer_id = sub.customer_id;
  // During the free trial nothing has been charged, so a failed, paused or cancelled subscription is only a payment method that went
  // away: the trial carries on until its own end date, and the subscription is forgotten so another can be connected.
  const inTrial = org.billing_status === "trialing" && !(org.trial_ends_at && new Date(org.trial_ends_at) <= now);
  // After the trial's end the first real charge is due, so a failure there is a failed payment (grace, then read-only), not a lost card.
  if (inTrial && ["subscription.pending", "subscription.halted", "subscription.paused", "subscription.cancelled", "subscription.completed"].includes(evt.event)) {
    if (evt.event === "subscription.cancelled" || evt.event === "subscription.completed") patch.razorpay_subscription_id = null;
    return { status: "processed", patch };
  }
  switch (evt.event) {
    case "subscription.authenticated":
      // A payment method was connected during the free trial: authorised now, first charge at start_at (the trial's end). The plan becomes
      // the one they will be charged for; the trial itself carries on untouched.
      if (org.billing_status === "trialing" && mapped && Number(sub.start_at) * 1000 > now.getTime()) adopt();
      // A new subscription that starts when the paid period ends: subscribing again after a cancel, or switching plan on a UPI /
      // e-mandate subscription (Razorpay can't change those). The organisation stops ending; a different plan waits for that first charge.
      else if (org.billing_status === "active" && mapped && Number(sub.start_at) * 1000 > now.getTime()) {
        patch.cancel_at_period_end = false; patch.pending_plan_code = mapped.plan !== org.plan_code ? mapped.plan : null;
      }
      return { status: "processed", patch };
    case "subscription.activated": case "subscription.charged": case "subscription.resumed":
      if (!mapped) return { status: "ignored", reason: "unknown plan id" };
      adopt(); patch.billing_status = "active"; patch.grace_ends_at = null; patch.cancel_at_period_end = false;
      if (unix(sub.current_start)) patch.current_period_start = unix(sub.current_start);
      if (unix(sub.current_end)) patch.current_period_end = unix(sub.current_end);
      return { status: "processed", patch };
    case "subscription.updated":
      // Razorpay sends this when a plan change has happened: an upgrade only once its difference is charged ("if the charge fails, the
      // Subscription is not updated"), a cycle-end downgrade when the cycle turns. A change that is still only scheduled never counts.
      if (mapped && org.plan_code !== mapped.plan && sub.has_scheduled_changes !== true) adopt();
      return { status: "processed", patch };
    case "subscription.pending": // a charge failed; Razorpay keeps retrying. Grace starts once, not on every retry.
      patch.billing_status = "past_due";
      if (org.billing_status !== "past_due" || !org.grace_ends_at) patch.grace_ends_at = new Date(at.getTime() + graceDays * 864e5);
      return { status: "processed", patch };
    case "subscription.halted": case "subscription.paused": // retries exhausted / paused: read-only until fixed
      patch.billing_status = "past_due"; patch.grace_ends_at = at < now ? at : now; // never in the future, even with clock skew
      return { status: "processed", patch };
    case "subscription.cancelled": case "subscription.completed":
      patch.billing_status = "canceled"; patch.pending_plan_code = null;
      patch.current_period_end = unix(sub.current_end) || org.current_period_end || at;
      return { status: "processed", patch };
    default: return { status: "ignored", reason: "event not used" };
  }
}
// What we keep of a webhook: identifiers, statuses and timestamps. Never card, contact or payment-method details.
export function eventSummary(evt) {
  const s = evt?.payload?.subscription?.entity || {}, l = evt?.payload?.payment_link?.entity;
  return { event: evt?.event, created_at: evt?.created_at, subscription: { id: s.id, plan_id: s.plan_id, status: s.status, current_start: s.current_start, current_end: s.current_end, paid_count: s.paid_count, has_scheduled_changes: s.has_scheduled_changes },
    ...(l ? { payment_link: { id: l.id, status: l.status, amount: l.amount, amount_paid: l.amount_paid, currency: l.currency } } : {}) };
}

// Why an organisation can't move to `code` yet: what it uses today that the cheaper plan doesn't allow. Nothing is
// ever deleted for a downgrade; the owner trims first, then changes plan.
export async function downgradeBlockers(orgId, code) {
  const st = await billingState(orgId, { usage: true }), e = PLANS[code].entitlements, out = [];
  if (st.used.brands > e.brands) out.push(`${st.used.brands} brands (${PLANS[code].name} allows ${e.brands})`);
  if (st.used.questions > e.questions) out.push(`${st.used.questions} tracked questions (allows ${e.questions})`);
  if (st.used.seats > e.seats) out.push(`${st.used.seats} seats including invites (allows ${e.seats})`);
  for (const w of await q(`select name, setup, schedule, samples, (select count(*)::int + 1 from workspaces m where m.parent_id = w.id) as markets, parent_id from workspaces w where org_id = $1`, [orgId])) {
    if (!w.parent_id && w.markets > e.markets) out.push(`${w.name} tracks ${w.markets} markets (${PLANS[code].name} allows ${e.markets} per brand)`);
    if (!e.schedule.includes(w.schedule)) out.push(`${w.name} runs ${w.schedule} checks (not in ${PLANS[code].name})`);
    if (w.samples > e.samples) out.push(`${w.name} uses ${w.samples} samples per question (allows ${e.samples})`);
    const r = Array.isArray(w.setup?.profile?.competitors) ? w.setup.profile.competitors.length : 0;
    if (r > e.competitors) out.push(`${w.name} tracks ${r} competitors (allows ${e.competitors})`);
  }
  for (const i of await q(`select distinct i.provider from integrations i join workspaces w on w.id = i.workspace_id where w.org_id = $1`, [orgId])) {
    if (!allowsIntegration(e, i.provider)) out.push(`the ${i.provider} integration (not in ${PLANS[code].name})`);
  }
  return out;
}

// A new self-serve organisation waits for its owner to choose a plan ('new', read-only). Only while it is still legacy/internal, so
// this can never touch a paying or operator-managed organisation.
export async function awaitPlan(orgId) {
  await q(`update organizations set plan_code = 'trial', billing_status = 'new', updated_at = now() where id = $1 and plan_code = 'legacy' and billing_status = 'internal'`, [orgId]);
}
// Choosing a plan on a 'new' organisation starts the free trial: one per person, ever. The person's first choice opens the window;
// any later organisation of theirs joins that same window (what is left of it), and once it has passed there is no trial: subscribe.
export async function beginTrial(orgId, userId, days = 7) {
  return tx(async (c) => {
    let u = (await c.query(`select trial_started_at, trial_ends_at from users where id = $1 for update`, [userId])).rows[0];
    if (!u?.trial_started_at) u = (await c.query(`update users set trial_started_at = now(), trial_ends_at = now() + make_interval(days => $2) where id = $1 returning trial_started_at, trial_ends_at`, [userId, days])).rows[0];
    else if (new Date(u.trial_ends_at) <= new Date()) fail(409, "You've already used your free trial. Subscribe to a plan to continue.", { code: "trial_used" });
    await c.query(`update organizations set billing_status = 'trialing', trial_started_at = $2, trial_ends_at = $3, updated_at = now() where id = $1 and billing_status = 'new'`, [orgId, u.trial_started_at, u.trial_ends_at]);
  });
}
// A new self-serve organisation starts its free trial straight away (no plan pick first). If the person's one trial is already
// spent it stays 'new' (read-only) until they subscribe. Returns when the trial ends, or null when none started.
export async function startDefaultTrial(orgId, userId, days = 7) {
  await awaitPlan(orgId);
  try { await beginTrial(orgId, userId, days); }
  catch (e) { if (e.extra?.code !== "trial_used") throw e; return null; }
  return (await q(`select trial_ends_at from organizations where id = $1 and billing_status = 'trialing'`, [orgId]))[0]?.trial_ends_at || null;
}
// Whether this organisation's owner can still start (or join) a trial. Shown so the plans page offers "free trial" or "subscribe".
async function trialAvailable(orgId) {
  const r = (await q(`select u.trial_ends_at from memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.role = 'owner' limit 1`, [orgId]))[0];
  return !!r && (!r.trial_ends_at || new Date(r.trial_ends_at) > new Date());
}
