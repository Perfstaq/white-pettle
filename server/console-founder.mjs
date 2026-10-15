// Founder Command pages for White Petal (docs/founder-command-reference.md): the same page structure and principles as Perfstaq's founder
// console, on White Petal's data. Brands = workspaces; "value" = a recovery action approved, published or rechecked; checks = runs.
// Every function takes the scope from the global filter bar (console.mjs scopeFrom) and never estimates a missing figure.
import { q, one } from "./db.mjs";
import { PLANS, withTax, cyclePrice, LIMIT_METRICS, effectiveEntitlements } from "./plans.mjs";
import { billingState } from "./billing.mjs";
import { billingConfig } from "./razorpay.mjs";
import { orgKeys, KEY_LABELS } from "./orgs.mjs";
import { llmProvider, serpConfig } from "../api/_lib.js";
import { orgRows, attention, usdInr, toInrMinor, mrrOf, mrrOf as mrrOfRow, liveTrial } from "./console.mjs";

const DRAFTS = "('pitch','article','fixpack')";
const APPROVED = "('approved','published','recheck_scheduled','result_observed')";
const VALUE = "('published','recheck_scheduled','result_observed')";
const median = (xs) => { const a = xs.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const pctile = (xs, p) => { const a = xs.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null; };
const asOf = () => new Date().toISOString();

// One row per brand with the evidence the founder pages need.
export async function brandRows(scope) {
  const rows = await q(`
    select w.id, w.slug, w.name, w.org_id, o.slug as org_slug, o.name as org, w.created_at, w.schedule,
      (w.setup->'profile'->>'name') is not null as profiled, nullif(w.setup->'profile'->>'category', '') as category,
      (select min(r.finished_at) from runs r where r.workspace_id = w.id and r.status = 'done') as first_check,
      (select max(r.started_at) from runs r where r.workspace_id = w.id) as last_run,
      (select count(*)::int from runs r where r.workspace_id = w.id and r.status = 'failed' and r.started_at > now() - interval '7 days') as failed7,
      (select min(x.at) from usage x where x.workspace_id = w.id and x.sub in ${DRAFTS}) as first_draft,
      (select max(x.at) from usage x where x.workspace_id = w.id and x.sub in ${DRAFTS}) as last_draft,
      (select min(a.updated_at) from recovery_actions a where a.workspace_id = w.id and a.status in ${APPROVED}) as first_approved,
      (select max(a.updated_at) from recovery_actions a where a.workspace_id = w.id and a.status in ${VALUE}) as last_value,
      (select count(*)::int from recovery_actions a where a.workspace_id = w.id and a.status = 'approved' and a.updated_at < now() - interval '7 days') as approved_unused,
      (select count(*)::int from recovery_actions a where a.workspace_id = w.id and a.status = 'ready_for_review') as waiting_review,
      (select count(*)::int from integrations i where i.workspace_id = w.id and i.status = 'error') as broken_int,
      (select count(*)::int from integrations i where i.workspace_id = w.id and i.status = 'connected' and (i.collected_at is null or i.collected_at < now() - interval '48 hours')) as stale_int
    from workspaces w join organizations o on o.id = w.org_id
    where ($1::uuid[] is null or w.org_id = any($1)) order by w.created_at`, [scope?.ids || null]);
  const now = Date.now(), day = 864e5;
  return rows.map((b) => {
    const stage = b.last_value ? ["Producing value", "good"] : b.first_approved ? ["Approved work", "violet"] : b.first_draft ? ["Drafted", "violet"]
      : b.first_check ? ["Checked", "coral"] : b.profiled ? ["Profile ready", "coral"] : ["Just created", "muted"];
    const blockers = [];
    if (b.failed7 >= 2) blockers.push({ key: "blocked", tone: "bad", text: `${b.failed7} failed checks in 7 days` });
    if (b.broken_int) blockers.push({ key: "blocked", tone: "bad", text: `${b.broken_int} broken integration${b.broken_int > 1 ? "s" : ""}` });
    if (b.stale_int) blockers.push({ key: "stale_integration", tone: "warn", text: "Stale integration (>48 h)" });
    if (!b.first_check && now - new Date(b.created_at) > 7 * day) blockers.push({ key: "no_first_check", tone: "warn", text: "No check after 7 days" });
    if (b.approved_unused) blockers.push({ key: "unused_approved", tone: "warn", text: "Approved work unused" });
    if (b.waiting_review) blockers.push({ key: "waiting", tone: "info", text: `${b.waiting_review} waiting for review` });
    const lastAction = [[b.last_value, "Value action"], [b.first_approved, "Approved"], [b.last_draft, "Drafted"], [b.last_run, "Check"]].filter(([t]) => t).sort((x, y) => new Date(y[0]) - new Date(x[0]))[0];
    return { ...b, stage: stage[0], stageTone: stage[1], blockers, lastAction: lastAction ? { at: lastAction[0], what: lastAction[1] } : null,
      hoursToFirstCheck: b.first_check ? (new Date(b.first_check) - new Date(b.created_at)) / 36e5 : null };
  });
}
const RANK = { blocked: 0, stale_integration: 1, no_first_check: 2, unused_approved: 3, waiting: 4 };
export const watchList = (brands, filter = null) => brands
  .filter((b) => b.blockers.length && (!filter || b.blockers.some((x) => x.key === filter)))
  .sort((a, b) => Math.min(...a.blockers.map((x) => RANK[x.key])) - Math.min(...b.blockers.map((x) => RANK[x.key])) || new Date(b.lastAction?.at || 0) - new Date(a.lastAction?.at || 0));

// ── Company Pulse ──
export async function pulse(scope) {
  const ids = scope?.ids || null;
  const [brands, orgs, weeks, roll, week] = await Promise.all([
    brandRows(scope), orgRows(scope),
    q(`with wk as (select generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') as w),
          b as (select id from workspaces where ($1::uuid[] is null or org_id = any($1))),
          ev as (select workspace_id as ws, started_at as at from runs union all select workspace_id, at from usage where workspace_id is not null
                 union all select workspace_id, updated_at from recovery_actions where status <> 'suggested')
       select w as week,
         (select count(distinct ev.ws)::int from ev where ev.ws in (select id from b) and ev.at >= w and ev.at < w + interval '1 week') as active,
         (select count(distinct r.workspace_id)::int from runs r where r.status = 'done' and r.workspace_id in (select id from b) and r.started_at >= w and r.started_at < w + interval '1 week') as checking,
         (select count(distinct a.workspace_id)::int from recovery_actions a where a.status in ${VALUE} and a.workspace_id in (select id from b) and a.updated_at >= w and a.updated_at < w + interval '1 week') as value,
         (select count(*)::int from runs r where r.status = 'done' and r.source = 'live' and r.workspace_id in (select id from b) and r.started_at >= w and r.started_at < w + interval '1 week') as live,
         (select count(*)::int from runs r where r.status = 'done' and r.source = 'scheduled' and r.workspace_id in (select id from b) and r.started_at >= w and r.started_at < w + interval '1 week') as scheduled,
         (select count(*)::int from usage x where x.sub in ${DRAFTS} and x.workspace_id in (select id from b) and x.at >= w and x.at < w + interval '1 week') as drafts
       from wk order by w`, [ids]),
    one(`with b as (select id from workspaces where ($1::uuid[] is null or org_id = any($1))),
          ev as (select workspace_id as ws, started_at as at from runs union all select workspace_id, at from usage where workspace_id is not null
                 union all select workspace_id, updated_at from recovery_actions where status <> 'suggested')
       select (select count(distinct ws)::int from ev where ws in (select id from b) and at > now() - interval '7 days') as active7,
              (select count(distinct ws)::int from ev where ws in (select id from b) and at > now() - interval '14 days' and at <= now() - interval '7 days') as prev7,
              (select count(*)::int from runs r where r.status = 'done' and r.workspace_id in (select id from b)) as checks_all,
              (select min(r.started_at) from runs r where r.workspace_id in (select id from b)) as since`, [ids]),
    one(`with b as (select id from workspaces where ($1::uuid[] is null or org_id = any($1)))
       select (select count(*)::int from runs r where r.status = 'done' and r.workspace_id in (select id from b) and r.started_at >= date_trunc('week', now())) as checks_wk,
              (select count(*)::int from runs r where r.status = 'done' and r.workspace_id in (select id from b) and r.started_at >= date_trunc('week', now()) - interval '1 week' and r.started_at < now() - interval '1 week') as checks_last_same,
              (select count(*)::int from usage x where x.sub in ${DRAFTS} and x.workspace_id in (select id from b) and x.at >= date_trunc('week', now())) as drafts_wk,
              (select count(*)::int from recovery_actions a where a.status <> 'suggested' and a.workspace_id in (select id from b) and a.updated_at >= date_trunc('week', now())) as actions_wk,
              (select count(distinct r.workspace_id)::int from runs r where r.workspace_id in (select id from b) and r.started_at >= date_trunc('week', now())) as brands_wk`, [ids]),
  ]);
  const now = Date.now(), day = 864e5;
  const mature = brands.filter((b) => now - new Date(b.created_at) >= 7 * day), activated = mature.filter((b) => b.hoursToFirstCheck != null && b.hoursToFirstCheck <= 168);
  // Week-1 retention: brands whose first-check week and the week after it are both over; retained if they checked again in that next week.
  const w1 = await q(`select w.id, exists (select 1 from runs r where r.workspace_id = w.id and r.status = 'done'
        and r.started_at >= date_trunc('week', f.first) + interval '1 week' and r.started_at < date_trunc('week', f.first) + interval '2 weeks') as kept
      from workspaces w cross join lateral (select min(r.finished_at) as first from runs r where r.workspace_id = w.id and r.status = 'done') f
      where f.first is not null and date_trunc('week', f.first) + interval '2 weeks' <= now() and ($1::uuid[] is null or w.org_id = any($1))`, [ids]);
  const funnel = { onboarded: brands.length, profiled: brands.filter((b) => b.profiled).length, checked: brands.filter((b) => b.first_check).length,
    drafted: brands.filter((b) => b.first_draft).length, approved: brands.filter((b) => b.first_approved).length };
  const outcomes = (await one(`select count(distinct a.workspace_id) filter (where a.status = 'published')::int as published,
        count(distinct a.workspace_id) filter (where a.status = 'recheck_scheduled')::int as recheck, count(distinct a.workspace_id) filter (where a.status = 'result_observed')::int as observed
      from recovery_actions a join workspaces w on w.id = a.workspace_id where ($1::uuid[] is null or w.org_id = any($1))`, [ids]));
  // Needs attention: the account rules folded into one row per rule; healthy checks folded into one line.
  const att = attention(orgs), byRule = {};
  for (const a of att) (byRule[a.rule] ||= { rule: a.rule, level: a.level, title: a.title.replace(/ at \d+%$/, ""), detail: a.detail, n: 0, slugs: [] }).n++, byRule[a.rule].slugs.push(a.slug);
  const watch = watchList(brands);
  const unused = brands.filter((b) => b.approved_unused).length;
  const stuck = await one(`select count(*)::int as n from billing_events where status = 'failed' and received_at > now() - interval '7 days'`);
  const healthy = [
    [!brands.some((b) => b.failed7), "No repeated check failures this week"],
    [!stuck.n, "Payment webhooks processed"],
    [!orgs.some((o) => o.billing_status === "past_due"), "No failed payments"],
    [!brands.some((b) => b.broken_int || b.stale_int), "Integrations healthy"],
    [!watch.some((b) => b.blockers.some((x) => x.key === "blocked")), "No blocked brands"],
  ];
  const paying = orgs.filter((o) => o.mrr > 0), mrrInr = paying.reduce((t, o) => t + o.mrrInr, 0);
  return {
    asOf: asOf(),
    hero: { brandsThisWeek: week.brands_wk, checksThisWeek: week.checks_wk, actionsThisWeek: week.actions_wk, draftsThisWeek: week.drafts_wk, needs: Object.values(byRule).reduce((t, r) => t + r.n, 0) + watch.length },
    revenue: { connected: true, mrrInr, arrInr: mrrInr * 12, paying: paying.length, trials: orgs.filter((o) => liveTrial(o)).length,
      pastDue: orgs.filter((o) => o.billing_status === "past_due").length, contractedInr: paying.filter((o) => o.contracted).reduce((t, o) => t + o.mrrInr, 0), usdInr: usdInr() },
    kpis: {
      active7: roll.active7, prev7: roll.prev7, brands: brands.length, activeSpark: weeks.slice(-8).map((w) => w.active),
      valueThisWeek: weeks.at(-1)?.value || 0, valueInPeriod: brands.filter((b) => b.last_value && now - new Date(b.last_value) <= (scope?.days || 30) * day).length,
      activation: { n: activated.length, of: mature.length }, retention: { n: w1.filter((x) => x.kept).length, of: w1.length },
      firstCheckH: median(activated.map((b) => b.hoursToFirstCheck)), firstCheckP90H: pctile(activated.map((b) => b.hoursToFirstCheck), 0.9),
    },
    engine: { checksAll: roll.checks_all, since: roll.since, checksWeek: week.checks_wk, checksLastSame: week.checks_last_same, draftsWeek: week.drafts_wk, actionsWeek: week.actions_wk, brandsWeek: week.brands_wk },
    weeks, funnel, outcomes,
    attention: Object.values(byRule).sort((a, b) => (a.level === "bad" ? -1 : 1) - (b.level === "bad" ? -1 : 1) || b.n - a.n).concat(unused ? [{ rule: "unused_approved", level: "warn", title: "Approved work not yet used", detail: "Brands with approved recovery work that was never published or rechecked: value left on the table.", n: unused }] : []),
    healthy: healthy.filter(([ok]) => ok).map(([, t]) => t),
    watch: watch.slice(0, 12),
  };
}

// ── Product Value ──
export async function productValue(scope) {
  const ids = scope?.ids || null, days = scope?.days || 30;
  const [checks, drafts, actions, period, byBrand] = await Promise.all([
    one(`select count(*) filter (where r.status = 'done')::int as done, count(*) filter (where r.status = 'failed')::int as failed, count(*) filter (where r.status = 'stopped')::int as stopped,
            count(*) filter (where r.status = 'done' and r.source = 'live')::int as live, count(*) filter (where r.status = 'done' and r.source = 'scheduled')::int as scheduled,
            count(distinct r.workspace_id)::int as brands
          from runs r join workspaces w on w.id = r.workspace_id where r.started_at > now() - interval '1 day' * $2 and ($1::uuid[] is null or w.org_id = any($1))`, [ids, days]),
    q(`select coalesce(x.sub, 'other') as kind, count(*)::int as n, count(distinct x.workspace_id)::int as brands from usage x join organizations o on o.id = x.org_id
       where x.kind = 'write' and x.at > now() - interval '1 day' * $2 and ($1::uuid[] is null or x.org_id = any($1)) group by 1 order by n desc`, [ids, days]),
    q(`select a.status, count(*)::int as n from recovery_actions a join workspaces w on w.id = a.workspace_id where ($1::uuid[] is null or w.org_id = any($1)) group by 1`, [ids]),
    one(`select count(*) filter (where a.status in ${VALUE})::int as value_moves, count(*) filter (where a.status = 'published')::int as published,
            count(*) filter (where a.status = 'result_observed')::int as observed, count(*) filter (where a.status = 'archived')::int as archived,
            count(distinct a.workspace_id) filter (where a.status in ${VALUE})::int as value_brands
          from recovery_actions a join workspaces w on w.id = a.workspace_id where a.updated_at > now() - interval '1 day' * $2 and ($1::uuid[] is null or w.org_id = any($1))`, [ids, days]),
    q(`select w.slug, w.name, o.slug as org_slug, o.name as org,
          (select count(*)::int from runs r where r.workspace_id = w.id and r.status = 'done' and r.started_at > now() - interval '1 day' * $2) as checks,
          (select count(*)::int from usage x where x.workspace_id = w.id and x.sub in ${DRAFTS} and x.at > now() - interval '1 day' * $2) as drafts,
          (select count(*)::int from recovery_actions a where a.workspace_id = w.id and a.status in ${APPROVED}) as approved,
          (select count(*)::int from recovery_actions a where a.workspace_id = w.id and a.status in ${VALUE}) as value,
          (select max(a.updated_at) from recovery_actions a where a.workspace_id = w.id and a.status in ${VALUE}) as last_value
        from workspaces w join organizations o on o.id = w.org_id where ($1::uuid[] is null or w.org_id = any($1)) order by value desc, approved desc, checks desc limit 30`, [ids, days]),
  ]);
  const st = Object.fromEntries(actions.map((a) => [a.status, a.n]));
  const decided = ["approved", "published", "recheck_scheduled", "result_observed", "archived"].reduce((t, k) => t + (st[k] || 0), 0);
  const approvedNow = ["approved", "published", "recheck_scheduled", "result_observed"].reduce((t, k) => t + (st[k] || 0), 0);
  return { asOf: asOf(), checks, drafts, actionsByStatus: st, period, byBrand,
    approval: { approved: approvedNow, rejected: st.archived || 0, decided, pending: (st.suggested || 0) + (st.drafting || 0) + (st.ready_for_review || 0), rate: decided ? Math.round((1000 * approvedNow) / decided) / 10 : null } };
}

// ── Customers ──
const SEGMENTS = { plan: "Plan", status: "Billing status", category: "Brand category", schedule: "Automatic checks", brands: "Brands per account", source: "Heard about us" };
export async function customersPage(scope, filter = null) {
  const [orgs, brands, groups, sources] = await Promise.all([
    orgRows(scope), brandRows(scope),
    q(`select g.id, g.name, g.kind, g.leave_out, coalesce(json_agg(json_build_object('slug', o.slug, 'name', o.name, 'owner', (select u.email from memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner' limit 1)) order by o.name) filter (where o.id is not null), '[]') as members
       from account_groups g left join account_group_members gm on gm.group_id = g.id left join organizations o on o.id = gm.org_id group by g.id order by g.created_at`),
    q(`select m.org_id, coalesce(u.signup_source, 'Not answered') as source from memberships m join users u on u.id = m.user_id where m.role = 'owner'`),
  ]);
  const src = Object.fromEntries(sources.map((s) => [s.org_id, s.source]));
  const byOrg = {}; for (const b of brands) (byOrg[b.org_id] ||= []).push(b);
  const STAGE_ORDER = ["Producing value", "Approved work", "Drafted", "Checked", "Profile ready", "Just created"];
  const accounts = orgs.map((o) => { const bs = byOrg[o.id] || []; const best = STAGE_ORDER.find((s) => bs.some((b) => b.stage === s)) || "No brand yet";
    return { slug: o.slug, name: o.name, owner: o.owner, plan: o.planName, status: o.billing_status, currency: o.currency, mrr: o.mrr, brands: bs.map((b) => ({ name: b.name, category: b.category })),
      stage: best, signedUp: o.created_at, lastActive: [o.last_run, ...bs.map((b) => b.lastAction?.at)].filter(Boolean).sort().at(-1) || null, health: o.health, band: o.band, source: src[o.id] || "Not answered" }; });
  const count = (f) => { const m = {}; for (const x of f) m[x] = (m[x] || 0) + 1; return Object.entries(m).map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n); };
  const segments = {
    plan: count(accounts.map((a) => a.plan)), status: count(accounts.map((a) => a.status)), category: count(brands.map((b) => b.category || "Not answered")),
    schedule: count(brands.map((b) => (b.schedule === "off" ? "Off" : b.schedule[0].toUpperCase() + b.schedule.slice(1)))),
    brands: count(accounts.map((a) => (a.brands.length >= 3 ? "3 or more" : String(a.brands.length)))), source: count(accounts.map((a) => a.source)),
  };
  // "active": the brands Company Pulse counts as active (a check, AI call or recovery-action update in the last 7 days), latest first.
  const active = filter === "active" ? await activeBrands(brands.map((b) => b.id)) : null;
  const watch = active ? brands.filter((b) => active.has(b.id)).map((b) => ({ ...b, lastAction: { at: active.get(b.id), what: "Active" } })).sort((a, b) => new Date(b.lastAction.at) - new Date(a.lastAction.at)) : watchList(brands, filter);
  return { asOf: asOf(), segmentNames: SEGMENTS, segments, groups, accounts,
    kpis: { accounts: accounts.length, withBrand: accounts.filter((a) => a.brands.length).length, profiled: accounts.filter((a) => (byOrg[orgs.find((o) => o.slug === a.slug)?.id] || []).some((b) => b.profiled)).length,
      brands: brands.length, withCategory: brands.filter((b) => b.category).length, matching: filter ? watch.length : brands.length },
    health: { filter, rows: (filter ? watch : [...watchList(brands), ...brands.filter((b) => !b.blockers.length)]).slice(0, 40)
      .map((b) => ({ slug: b.slug, name: b.name, org: b.org, org_slug: b.org_slug, stage: b.stage, stageTone: b.stageTone, lastAction: b.lastAction, blockers: b.blockers })) } };
}

// Brands with any activity in the last 7 days and when it last happened: the same events as Company Pulse's "Active brands".
async function activeBrands(ids) {
  if (!ids.length) return new Map();
  const rows = await q(`with ev as (select workspace_id as ws, started_at as at from runs union all select workspace_id, at from usage where workspace_id is not null
      union all select workspace_id, updated_at from recovery_actions where status <> 'suggested')
    select ws, max(at) as last from ev where ws = any($1::uuid[]) and at > now() - interval '7 days' group by ws`, [ids]);
  return new Map(rows.map((r) => [r.ws, r.last]));
}

// ── Plans & Subscriptions ──
export async function plansSubs(scope) {
  const [orgs, flow, events, charges] = await Promise.all([
    orgRows(scope),
    one(`select count(*) filter (where action = 'billing.activated' and at > now() - interval '30 days')::int as new30,
            count(*) filter (where action = 'billing.cancelled' and at > now() - interval '30 days')::int as churn30,
            count(*) filter (where action in ('billing.upgrade_requested') and at > now() - interval '30 days')::int as up30,
            count(*) filter (where action in ('billing.downgrade_scheduled') and at > now() - interval '30 days')::int as down30
          from audit_log where ($1::uuid[] is null or org_id = any($1))`, [scope?.ids || null]),
    q(`select a.at, a.action, a.target, o.slug, o.name, u.email as who from audit_log a join organizations o on o.id = a.org_id left join users u on u.id = a.user_id
       where a.action like 'billing.%' and ($1::uuid[] is null or a.org_id = any($1)) order by a.at desc limit 40`, [scope?.ids || null]),
    q(`select org_id, count(*)::int as n, min(at) as first, max(at) as last from audit_log where action in ('billing.activated', 'billing.charged') group by org_id`),
  ]);
  const ch = Object.fromEntries(charges.map((c) => [c.org_id, c]));
  const plans = Object.values(PLANS).map((p) => {
    const on = orgs.filter((o) => o.plan_code === p.code);
    return { code: p.code, name: p.name, description: p.description, active: p.active, public: p.public, selfServe: p.selfServe, featured: p.featured, capUsd: p.capUsd,
      prices: Object.fromEntries(Object.entries(p.prices).map(([c, a]) => [c, { amount: a, withTax: withTax(a, c), razorpay: !!p.razorpayIds?.[c],
        annual: p.annualPrices?.[c] ?? null, annualRazorpay: !!p.annualRazorpayIds?.[c], seat: p.seatPrices?.[c] ?? null }])),
      trialDays: p.trialDays, maxExtraSeats: p.maxExtraSeats, annualSubs: on.filter((o) => o.billing_cycle === "annual" && o.mrr > 0).length, extraSeats: on.reduce((t, o) => t + (o.extra_seats || 0), 0),
      limits: Object.fromEntries(Object.entries(p.entitlements).filter(([k]) => ["brands", "questions", "seats", "drafts", "checks"].includes(k)).map(([k, v]) => [k, Number.isFinite(v) ? v : null])),
      orgs: on.length, people: on.reduce((t, o) => t + (o.members || 0), 0), paying: on.filter((o) => o.mrr > 0).length, trials: on.filter((o) => liveTrial(o)).length, mrrInr: on.reduce((t, o) => t + o.mrrInr, 0) };
  });
  const paying = orgs.filter((o) => o.mrr > 0), mrrInr = paying.reduce((t, o) => t + o.mrrInr, 0);
  const subs = orgs.filter((o) => o.billing_status !== "internal").map((o) => { const cyc = o.billing_cycle || "monthly", price = cyclePrice(o.plan_code, o.currency, cyc) ?? 0; return { slug: o.slug, name: o.name, owner: o.owner, plan: o.planName, planCode: o.plan_code, status: o.billing_status,
    currency: o.currency, cycle: cyc, price, priceWithTax: withTax(price, o.currency), mrr: o.mrr, extraSeats: o.extra_seats || 0,
    renews: o.current_period_end, trialEnds: o.trial_ends_at, cancelAtEnd: o.cancel_at_period_end, pendingPlan: o.pending_plan_code ? PLANS[o.pending_plan_code]?.name || o.pending_plan_code : null,
    razorpay: o.razorpay_subscription_id, contracted: o.contracted, reconciled: o.billing_reconciled_at, charges: ch[o.id]?.n || 0, since: ch[o.id]?.first || null, lastCharge: ch[o.id]?.last || null }; });
  return { asOf: asOf(), plans, subs, events,
    kpis: { mrrInr, arrInr: mrrInr * 12, arpaInr: paying.length ? Math.round(mrrInr / paying.length) : 0, paying: paying.length, trials: orgs.filter((o) => liveTrial(o)).length,
      pastDue: orgs.filter((o) => o.billing_status === "past_due").length, cancelling: orgs.filter((o) => o.cancel_at_period_end).length, contracted: paying.filter((o) => o.contracted).length,
      new30: flow.new30, churn30: flow.churn30, up30: flow.up30, down30: flow.down30, usdInr: usdInr(),
      annual: paying.filter((o) => o.billing_cycle === "annual").length, extraSeats: orgs.reduce((t, o) => t + (o.extra_seats || 0), 0) } };
}

// ── Operations ──
export async function operations(scope, status = "all") {
  const ids = scope?.ids || null;
  const statusSql = { failed: "and r.status = 'failed'", running: "and r.status = 'running'", done: "and r.status = 'done'" }[status] || "";
  const [runs, recon, quality] = await Promise.all([
    q(`select r.id, r.started_at, r.finished_at, r.status, r.source, w.name as brand, o.slug as org_slug, o.name as org, u.email as by, left(r.error, 160) as error,
          extract(epoch from coalesce(r.finished_at, now()) - r.started_at)::int as secs
        from runs r join workspaces w on w.id = r.workspace_id join organizations o on o.id = w.org_id left join users u on u.id = r.started_by
        where ($1::uuid[] is null or w.org_id = any($1)) ${statusSql} order by r.started_at desc limit 50`, [ids]),
    one(`select
          (select count(*)::int from (select c.org_id from usage_counters c where c.metric = 'ai_usd'
              and abs(c.used - coalesce((select sum(x.cost_usd) from usage x where x.org_id = c.org_id and x.period_start = c.period_start), 0)) > 0.001) t) as ledger_mismatch,
          (select count(*)::int from organizations) as accounts,
          (select count(*)::int from organizations where razorpay_subscription_id is not null and billing_status in ('active','past_due') and (billing_reconciled_at is null or billing_reconciled_at < now() - interval '2 days')) as unsynced,
          (select count(*)::int from billing_events where status = 'failed' and received_at > now() - interval '7 days') as hooks_failed,
          (select count(*)::int from runs where status = 'running' and started_at < now() - interval '2 hours') as stuck_runs`),
    one(`select (select min(received_at) from billing_events where status = 'received') as oldest_unprocessed,
            (select max(at) from usage) as last_usage, (select max(at) from page_views) as last_view, (select max(at) from presence) as last_presence,
            (select count(*)::int from organizations o where not exists (select 1 from memberships m where m.org_id = o.id and m.role = 'owner')) as no_owner,
            (select count(*)::int from usage where user_id is null) as usage_unattributed`),
  ]);
  return { asOf: asOf(), status, runs, recon, quality };
}

// ── AI & Cost ──
export async function aiCost(scope) {
  const ids = scope?.ids || null, days = scope?.days || 30;
  const [rel, durs, engines, kinds, failures, value] = await Promise.all([
    one(`select count(*) filter (where r.status = 'done')::int as done, count(*) filter (where r.status = 'failed')::int as failed, count(*) filter (where r.status = 'stopped')::int as stopped,
            count(*) filter (where r.status = 'running')::int as running
          from runs r join workspaces w on w.id = r.workspace_id where r.started_at > now() - interval '1 day' * $2 and ($1::uuid[] is null or w.org_id = any($1))`, [ids, days]),
    q(`select r.source, extract(epoch from r.finished_at - r.started_at)::float as s from runs r join workspaces w on w.id = r.workspace_id
       where r.status = 'done' and r.finished_at is not null and r.started_at > now() - interval '1 day' * $2 and ($1::uuid[] is null or w.org_id = any($1))`, [ids, days]),
    q(`select coalesce(engine, 'writing') as engine, sum(n)::int as calls, round(sum(cost_usd)::numeric, 4)::float as usd, count(*) filter (where cost_usd = 0)::int as zero_cost
       from usage where at > now() - interval '1 day' * $2 and ($1::uuid[] is null or org_id = any($1)) group by 1 order by usd desc`, [ids, days]),
    q(`select kind, coalesce(sub, '') as sub, sum(n)::int as calls, round(sum(cost_usd)::numeric, 4)::float as usd from usage
       where at > now() - interval '1 day' * $2 and ($1::uuid[] is null or org_id = any($1)) group by 1, 2 order by usd desc limit 20`, [ids, days]),
    q(`select left(regexp_replace(coalesce(r.error, 'no error text'), '[0-9a-f-]{8,}|\\d+', '#', 'g'), 140) as reason, count(*)::int as n
       from runs r join workspaces w on w.id = r.workspace_id where r.status = 'failed' and r.started_at > now() - interval '1 day' * $2 and ($1::uuid[] is null or w.org_id = any($1))
       group by 1 order by n desc limit 10`, [ids, days]),
    one(`select count(*)::int as approved from recovery_actions a join workspaces w on w.id = a.workspace_id
         where a.status in ${APPROVED} and a.updated_at > now() - interval '1 day' * $2 and ($1::uuid[] is null or w.org_id = any($1))`, [ids, days]),
  ]);
  const total = engines.reduce((t, e) => t + e.usd, 0), terminal = rel.done + rel.failed, all = durs.map((d) => d.s);
  return { asOf: asOf(), days,
    reliability: { ...rel, rate: terminal ? Math.round((1000 * rel.done) / terminal) / 10 : null, terminal },
    latency: { p50: pctile(all, 0.5), p95: pctile(all, 0.95), n: all.length, bySource: ["live", "scheduled"].map((s) => { const xs = durs.filter((d) => d.source === s).map((d) => d.s); return { source: s, n: xs.length, p50: pctile(xs, 0.5), p95: pctile(xs, 0.95) }; }) },
    cost: { totalUsd: total, perCheck: rel.done ? total / rel.done : null, perApproved: value.approved ? total / value.approved : null, approved: value.approved,
      zeroCostCalls: engines.reduce((t, e) => t + e.zero_cost, 0) },
    engines: engines.map((e) => ({ ...e, share: total ? Math.round((1000 * e.usd) / total) / 10 : 0, perCall: e.calls ? e.usd / e.calls : null })), kinds, failures };
}

// ── Integrations ──
export async function integrationsHealth(scope) {
  const ids = scope?.ids || null;
  const [byProvider, broken] = await Promise.all([
    q(`select i.provider, count(*)::int as total, count(*) filter (where i.status = 'connected')::int as connected, count(*) filter (where i.status = 'error')::int as error,
            count(*) filter (where i.status = 'connected' and (i.collected_at is null or i.collected_at < now() - interval '48 hours'))::int as stale,
            count(*) filter (where i.collected_at is null)::int as never, max(i.collected_at) as last_sync
          from integrations i join workspaces w on w.id = i.workspace_id where ($1::uuid[] is null or w.org_id = any($1)) group by 1 order by total desc`, [ids]),
    q(`select i.provider, i.status, left(i.detail, 160) as detail, i.collected_at, w.name as brand, o.slug as org_slug, o.name as org
       from integrations i join workspaces w on w.id = i.workspace_id join organizations o on o.id = w.org_id
       where (i.status = 'error' or i.collected_at is null or i.collected_at < now() - interval '48 hours') and ($1::uuid[] is null or w.org_id = any($1))
       order by i.status = 'error' desc, i.collected_at nulls first limit 30`, [ids]),
  ]);
  const t = byProvider.reduce((a, p) => ({ total: a.total + p.total, connected: a.connected + p.connected, error: a.error + p.error, stale: a.stale + p.stale }), { total: 0, connected: 0, error: 0, stale: 0 });
  const brandsWith = await one(`select count(distinct i.workspace_id)::int as n, (select count(*)::int from workspaces w where ($1::uuid[] is null or w.org_id = any($1))) as of
      from integrations i join workspaces w on w.id = i.workspace_id where ($1::uuid[] is null or w.org_id = any($1))`, [ids]);
  return { asOf: asOf(), totals: t, byProvider, broken, brandsWith, platform: await platformConnections(), ownKeys: await ownKeyUse(scope) };
}

// The services White Petal itself is connected to (its own keys in the environment): is each one set up, is it being used, is it
// failing. Only "set or not" is read from the environment, never a value.
const ENGINE_KEYS = [["chatgpt", "ChatGPT", "OPENAI_API_KEY"], ["perplexity", "Perplexity", "PERPLEXITY_API_KEY"], ["gemini", "Gemini", "GEMINI_API_KEY"], ["groq", "Groq", "GROQ_API_KEY"]];
async function platformConnections() {
  const has = (k) => !!String(process.env[k] || "").trim(), serp = serpConfig(), rz = billingConfig();
  const [calls, serpUse, writes, hooks, mails, google] = await Promise.all([
    q(`select engine, count(*) filter (where at > now() - interval '1 day')::int as day, count(*)::int as month, max(at) as last, round(sum(cost_usd)::numeric, 2)::float as usd
       from usage where kind = 'ask' and at > now() - interval '30 days' group by 1`),
    one(`select count(*)::int as n, max(at) as last from usage where kind = 'serp' and at > now() - interval '30 days'`),
    one(`select count(*)::int as n, max(at) as last from usage where kind = 'write' and at > now() - interval '30 days'`),
    one(`select max(received_at) as last, count(*) filter (where status = 'failed' and received_at > now() - interval '7 days')::int as failed,
            (select left(error, 140) from billing_events where status = 'failed' order by received_at desc limit 1) as error from billing_events`),
    one(`select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed, max(created_at) as last,
            (select left(error, 140) from email_log where status = 'failed' order by created_at desc limit 1) as error from email_log where created_at > now() - interval '30 days'`),
    one(`select count(*)::int as n, max(last_login_at) as last from users where google_sub is not null`),
  ]);
  const byEngine = Object.fromEntries(calls.map((c) => [c.engine, c]));
  // live: set up and used in the last 7 days · ready: set up, not used lately · off: not set up · problem: set up and failing
  const state = (on, last, bad = false) => (!on ? "off" : bad ? "problem" : last && Date.now() - new Date(last) < 7 * 864e5 ? "live" : "ready");
  const ai = ENGINE_KEYS.map(([engine, name, key]) => { const c = byEngine[engine] || {}; const on = has(key);
    return { key: engine, name, group: "AI engines", state: state(on, c.last), detail: on ? `${KEY_LABELS[key]} key set` : `Set ${key} to turn it on`,
      day: c.day || 0, month: c.month || 0, last: c.last || null, usd: c.usd || 0 }; });
  const serpCalls = ["aio", "aimode"].reduce((t, e) => t + (byEngine[e]?.month || 0), 0) + serpUse.n;
  const serpLast = [byEngine.aio?.last, byEngine.aimode?.last, serpUse.last].filter(Boolean).sort().at(-1) || null;
  return [
    ...ai,
    { key: "serp", name: "Google AI Overviews + AI Mode", group: "Search data", state: state(!!serp, serpLast),
      detail: serp ? `Through ${serp.backend === "dataforseo" ? "DataForSEO" : "SerpApi"}` : "Set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD, or SERPAPI_KEY", month: serpCalls, last: serpLast },
    { key: "writer", name: "Writing model", group: "AI engines", state: state(!!llmProvider(), writes.last),
      detail: llmProvider() ? `Drafts are written with ${llmProvider()}${process.env.PETTLE_LLM_PROVIDER ? " (chosen)" : " (first key available)"}` : "No writing key: set GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY", month: writes.n, last: writes.last },
    { key: "razorpay", name: "Razorpay", group: "Payments", state: state(rz.ready, hooks.last, hooks.failed > 0),
      detail: !rz.keyId ? "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET" : `${rz.testMode ? "Test mode" : "Live mode"} · checkout ${rz.enabled === "1" ? "open to everyone" : rz.enabled === "operators" ? "for operators only" : "closed"}${rz.webhookSecret ? "" : " · webhook secret missing"}${hooks.failed ? ` · ${hooks.failed} webhook(s) failed this week` : ""}`,
      last: hooks.last, error: hooks.failed ? hooks.error : null, note: !/^https:/.test(process.env.PUBLIC_ORIGIN || "") ? "Razorpay can't reach this server's webhook (it isn't on a public https address), so payments won't update accounts here." : null },
    { key: "resend", name: "Email (Resend)", group: "Email", state: state(has("RESEND_API_KEY"), mails.last, mails.failed > 0),
      detail: has("RESEND_API_KEY") ? `Sends as ${process.env.EMAIL_FROM || "the default sender"} · ${mails.sent} sent, ${mails.failed} failed in 30 days` : "Off: invite and reset links are printed in the server log instead", last: mails.last, error: mails.failed ? mails.error : null },
    { key: "google", name: "Sign in with Google + Search Console", group: "Sign-in", state: state(has("GOOGLE_OAUTH_CLIENT_ID") && has("GOOGLE_OAUTH_CLIENT_SECRET"), google.last),
      detail: has("GOOGLE_OAUTH_CLIENT_ID") ? `${google.n} ${google.n === 1 ? "person signs" : "people sign"} in with Google · redirect ${(process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "")}/api/auth/google/callback` : "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET", last: google.last },
    { key: "kg", name: "Google Knowledge Graph", group: "Search data", state: state(has("GOOGLE_API_KEY"), null), detail: has("GOOGLE_API_KEY") ? "Entity checks on" : "Set GOOGLE_API_KEY for entity checks" },
  ];
}
// Accounts that bring their own AI keys, per provider (names only), and whether they may fall back to the platform's.
async function ownKeyUse(scope) {
  const orgs = await q(`select id from organizations where keys is not null and ($1::uuid[] is null or id = any($1))`, [scope?.ids || null]);
  const n = {}; let anyOwn = 0;
  for (const o of orgs) { const { keys } = await orgKeys(o.id); const set = Object.keys(keys || {}).filter((k) => keys[k]); if (set.length) anyOwn++; for (const k of set) n[k] = (n[k] || 0) + 1; }
  const platform = (await one(`select count(*)::int as n from organizations where allow_platform_keys and ($1::uuid[] is null or id = any($1))`, [scope?.ids || null])).n;
  return { accounts: anyOwn, platformAllowed: platform, byKey: Object.entries(n).map(([key, accounts]) => ({ key, label: KEY_LABELS[key] || key, accounts })).sort((a, b) => b.accounts - a.accounts) };
}

// ── Releases & Feedback (read-only) ──
export async function releases() {
  const flags = await q(`select f.key, f.value, f.updated_at, u.email as by from platform_flags f left join users u on u.id = f.updated_by order by f.key`);
  const env = [
    ["BILLING_ENABLED", process.env.BILLING_ENABLED || "0", "Paid plans: 0 off, operators, 1 everyone"],
    ["ORG_CREATION", process.env.ORG_CREATION || "operators", "Who can create organisations"],
    ["PLATFORM_KEYS_FOR_SIGNUPS", process.env.PLATFORM_KEYS_FOR_SIGNUPS ?? "1", "New sign-ups may use the platform's AI keys"],
    ["PETTLE_LLM_PROVIDER", process.env.PETTLE_LLM_PROVIDER || "auto", "Writing model provider"],
  ].map(([key, value, note]) => ({ key, value, note }));
  const announcements = await q(`select key, value, updated_at from platform_flags where key like 'announce.%' order by updated_at desc`).catch(() => []);
  return { asOf: asOf(), flags, env, announcements, revision: process.env.K_REVISION || "dev" };
}

// ── Account groups (writes) ──
export async function groupCreate(name, kind, by) {
  return one(`insert into account_groups (name, kind, leave_out, created_by) values ($1, $2, $3, $4) returning *`, [name, kind, kind !== "custom", by]);
}
export const groupUpdate = (id, patch) => one(`update account_groups set name = coalesce($2, name), leave_out = coalesce($3, leave_out), kind = coalesce($4, kind) where id = $1 returning *`,
  [id, patch.name ?? null, patch.leaveOut ?? null, patch.kind ?? null]);
export const groupDelete = (id) => q(`delete from account_groups where id = $1`, [id]);
export async function groupMembers(id, add = [], remove = []) {
  if (add.length) await q(`insert into account_group_members (group_id, org_id) select $1, o.id from organizations o where o.slug = any($2) on conflict do nothing`, [id, add]);
  if (remove.length) await q(`delete from account_group_members where group_id = $1 and org_id in (select id from organizations where slug = any($2))`, [id, remove]);
}

// Everyone on one plan and what each pays: the plan pop-up's "On this plan" list. The recurring payment is per billing cycle, before
// and with GST, including extra seats; MRR is that per month, in INR (the figure the revenue pages add up).
export async function planAccounts(code, scope) {
  if (!PLANS[code]) return null;
  const on = (await orgRows(scope)).filter((o) => o.plan_code === code);
  const rows = on.map((o) => {
    const cyc = o.billing_cycle || "monthly", base = cyclePrice(code, o.currency, cyc) ?? 0, seats = (o.extra_seats || 0) * (PLANS[code].seatPrices?.[o.currency] ?? 0) * (cyc === "annual" ? 12 : 1);
    const recurring = o.mrr > 0 ? base + seats : 0;
    return { slug: o.slug, name: o.name, owner: o.owner, status: o.billing_status, trial: liveTrial(o), people: o.members || 0, extraSeats: o.extra_seats || 0, currency: o.currency, cycle: cyc,
      recurring, recurringWithTax: recurring ? withTax(recurring, o.currency) : 0, mrrInr: o.mrrInr, nextCharge: o.mrr > 0 && !o.cancel_at_period_end ? o.current_period_end : null,
      endsAt: o.cancel_at_period_end ? o.current_period_end : o.billing_status === "trialing" ? o.trial_ends_at : null,
      payment: o.razorpay_subscription_id ? "Razorpay" : o.mrr > 0 ? "Contract" : o.billing_status === "trialing" ? "Trial" : "—" };
  }).sort((a, b) => b.mrrInr - a.mrrInr || b.people - a.people);
  const paying = rows.filter((r) => r.mrrInr > 0), mrrInr = paying.reduce((t, r) => t + r.mrrInr, 0);
  return { asOf: asOf(), code, name: PLANS[code].name, rows,
    kpis: { accounts: rows.length, people: rows.reduce((t, r) => t + r.people, 0), paying: paying.length, trials: rows.filter((r) => r.trial).length, mrrInr, arrInr: mrrInr * 12,
      viaRazorpay: paying.filter((r) => r.payment === "Razorpay").length, viaContract: paying.filter((r) => r.payment === "Contract").length } };
}

// The plan and subscription block of the account drawer.
export async function subscriptionOf(orgId) {
  const o = await one(`select plan_code, billing_status, billing_currency, trial_started_at, trial_ends_at, current_period_start, current_period_end, cancel_at_period_end,
      pending_plan_code, razorpay_subscription_id, razorpay_checkout_subscription_id, razorpay_customer_id, billing_reconciled_at, billing_event_at, entitlement_overrides, monthly_cap_usd, grace_ends_at,
      billing_cycle, extra_seats, extra_seats_billing
    from organizations where id = $1`, [orgId]);
  const plan = PLANS[o.plan_code], ccy = o.billing_currency || "INR", cycle = o.billing_cycle || "monthly", price = cyclePrice(o.plan_code, ccy, cycle);
  const hist = await q(`select a.at, a.action, a.target, a.detail, u.email as who from audit_log a left join users u on u.id = a.user_id
      where a.org_id = $1 and (a.action like 'billing.%' or a.action like 'console.billing%') order by a.at desc limit 30`, [orgId]);
  const charges = hist.filter((h) => ["billing.activated", "billing.charged"].includes(h.action));
  // Each limit three ways (the plan's own, what applies now with any custom override, what is used), for the drawer's limits editor.
  const st = await billingState(orgId, { usage: true }), eff = effectiveEntitlements(o.plan_code, o.entitlement_overrides);
  const shape = (await one(`select coalesce(max(${"jsonb_array_length(case when jsonb_typeof(setup->'profile'->'competitors') = 'array' then setup->'profile'->'competitors' else '[]'::jsonb end)"}), 0)::int as competitors,
      coalesce(max(samples), 0)::int as samples from workspaces where org_id = $1`, [orgId]));
  const fin = (v) => (Number.isFinite(v) ? v : null), xs = (k) => (k === "seats" ? o.extra_seats || 0 : 0);
  const limitRows = LIMIT_METRICS.map((k) => ({ key: k, plan: plan && Number.isFinite(plan.entitlements[k]) ? plan.entitlements[k] + xs(k) : null,
    now: fin(eff[k]) == null ? null : eff[k] + xs(k), custom: o.entitlement_overrides?.values?.[k] ?? null,
    used: k === "competitors" || k === "samples" ? shape[k] : k === "pages" ? null : st.used?.[k] ?? null }));
  return { plan: plan?.name || o.plan_code, planCode: o.plan_code, status: o.billing_status, currency: ccy, price, priceWithTax: price == null ? null : withTax(price, ccy),
    cycle: cycle === "annual" ? "Annual (billed yearly)" : "Monthly", cycleKey: cycle, monthly: price == null ? null : cycle === "annual" ? Math.round(price / 12) : price,
    annualOffer: plan?.annualPrices?.[ccy] ?? null, trialDays: plan?.trialDays ?? null,
    extraSeats: o.extra_seats || 0, seatBilling: o.extra_seats_billing, seatPrice: plan?.seatPrices?.[ccy] ?? null, maxExtraSeats: plan?.maxExtraSeats ?? null,
    mrrInr: ["active", "past_due"].includes(o.billing_status) ? toInrMinor(mrrOfRow(o), ccy) : 0,
    started: charges.at(-1)?.at || o.trial_started_at || null, trialStarted: o.trial_started_at, trialEnds: o.trial_ends_at, periodStart: o.current_period_start, periodEnd: o.current_period_end,
    graceEnds: o.grace_ends_at, cancelAtEnd: o.cancel_at_period_end, pendingPlan: o.pending_plan_code ? PLANS[o.pending_plan_code]?.name || o.pending_plan_code : null,
    payment: o.razorpay_subscription_id ? "Razorpay subscription" : o.billing_status === "active" ? "Invoiced contract (no card)" : o.razorpay_checkout_subscription_id ? "Link sent, not paid yet" : "None",
    razorpay: o.razorpay_subscription_id, pendingLink: o.razorpay_checkout_subscription_id, customer: o.razorpay_customer_id, reconciled: o.billing_reconciled_at, lastEvent: o.billing_event_at,
    charges: charges.length, overrides: o.entitlement_overrides?.values ? o.entitlement_overrides : null, capUsd: o.monthly_cap_usd != null ? Number(o.monthly_cap_usd) : plan?.capUsd ?? null,
    limitRows, limits: plan ? Object.fromEntries(["brands", "questions", "seats", "drafts", "checks"].map((k) => [k, Number.isFinite(plan.entitlements[k]) ? plan.entitlements[k] + (k === "seats" ? o.extra_seats || 0 : 0) : null])) : {}, history: hist };
}

// ── Business in White Petal's own units (docs/console-business-model.md) ──
const ACTIVE_QS = `jsonb_array_elements(case when jsonb_typeof(w.setup->'questions') = 'array' then w.setup->'questions' else '[]'::jsonb end)`;
const arrLen = (path) => `coalesce(jsonb_array_length(case when jsonb_typeof(${path}) = 'array' then ${path} else '[]'::jsonb end), 0)`;
const med = (xs) => median(xs);
const pctOf = (n, of) => (of ? Math.round((1000 * n) / of) / 10 : null);

// Customer outcomes: is AI naming our customers more often? From each brand's first and latest scored check.
// A brand counts as improving / declining only with two checks at least 7 days apart and a score change of 5 points or more.
export async function outcomes(scope) {
  const ids = scope?.ids || null;
  const [pairs, weekly, rechecks, gaps] = await Promise.all([
    q(`with d as (select r.workspace_id, r.started_at, r.summary from runs r join workspaces w on w.id = r.workspace_id
                  where r.status = 'done' and r.summary ? 'score' and ($1::uuid[] is null or w.org_id = any($1))),
            f as (select distinct on (workspace_id) workspace_id, started_at, summary from d order by workspace_id, started_at),
            l as (select distinct on (workspace_id) workspace_id, started_at, summary from d order by workspace_id, started_at desc)
       select w.slug, w.name, o.slug as org_slug, o.name as org, coalesce(pl.name, o.plan_code) as plan, f.summary as first, l.summary as latest, f.started_at as first_at, l.started_at as latest_at,
              (select count(*)::int from d where d.workspace_id = w.id) as checks
       from workspaces w join organizations o on o.id = w.org_id left join plans pl on pl.code = o.plan_code join f on f.workspace_id = w.id join l on l.workspace_id = w.id`, [ids]),
    q(`with wk as (select generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') as w),
            d as (select r.workspace_id, r.started_at, (r.summary->>'score')::float as score from runs r join workspaces w on w.id = r.workspace_id
                  where r.status = 'done' and r.summary ? 'score' and ($1::uuid[] is null or w.org_id = any($1)))
       select wk.w as week, percentile_cont(0.5) within group (order by x.score) as median, count(x.score)::int as brands
       from wk left join lateral (select distinct on (d.workspace_id) d.score from d where d.started_at < wk.w + interval '1 week' and d.started_at >= wk.w - interval '3 weeks'
                                  order by d.workspace_id, d.started_at desc) x on true group by wk.w order by wk.w`, [ids]),
    q(`select coalesce(a.result->>'direction', 'none') as direction, count(*)::int as n from recovery_actions a join workspaces w on w.id = a.workspace_id
       where a.status = 'result_observed' and ($1::uuid[] is null or w.org_id = any($1)) group by 1`, [ids]),
    q(`select coalesce(a.gap_type, 'unknown') as gap, count(*) filter (where a.status not in ('result_observed', 'archived'))::int as open,
            count(*) filter (where a.status = 'result_observed' and a.result->>'direction' = 'improved')::int as closed, count(*)::int as total
       from recovery_actions a join workspaces w on w.id = a.workspace_id where ($1::uuid[] is null or w.org_id = any($1)) group by 1`, [ids]),
  ]);
  const now = Date.now(), rows = pairs.map((p) => {
    const a = p.first || {}, b = p.latest || {}, comparable = p.checks >= 2 && new Date(p.latest_at) - new Date(p.first_at) >= 7 * 864e5;
    const delta = comparable ? Math.round((b.score ?? 0) - (a.score ?? 0)) : null;
    return { slug: p.slug, name: p.name, org: p.org, org_slug: p.org_slug, plan: p.plan, checks: p.checks, score: b.score ?? null, firstScore: a.score ?? null, delta, comparable,
      visibility: b.visibility ?? null, visDelta: comparable && a.visibility != null ? Math.round(1000 * (b.visibility - a.visibility)) / 10 : null,
      rank: b.rank ?? null, rankDelta: comparable && a.rank != null && b.rank != null ? a.rank - b.rank : null, brands: b.brands ?? null,
      leader: b.leader?.name || null, youLead: !!b.leader?.name && b.leader.name === p.name, engines: b.engines || {}, latestAt: p.latest_at, stale: now - new Date(p.latest_at) > 21 * 864e5 };
  });
  const comp = rows.filter((r) => r.comparable), improving = comp.filter((r) => r.delta >= 5), declining = comp.filter((r) => r.delta <= -5);
  const engineVis = {}; for (const r of rows) for (const [e, v] of Object.entries(r.engines)) (engineVis[e] ||= []).push(v);
  const leaders = {}; for (const r of rows) if (r.leader && !r.youLead) leaders[r.leader] = (leaders[r.leader] || 0) + 1;
  const dist = [0, 20, 40, 60, 80].map((lo) => ({ band: `${lo}–${lo + 20}`, n: rows.filter((r) => r.score != null && r.score >= lo && (lo === 80 ? r.score <= 100 : r.score < lo + 20)).length }));
  const rc = Object.fromEntries(rechecks.map((x) => [x.direction, x.n])), rcTotal = rechecks.reduce((t, x) => t + x.n, 0);
  return { asOf: asOf(),
    kpis: { brands: rows.length, medianScore: med(rows.map((r) => r.score)), medianFirst: med(comp.map((r) => r.firstScore)), medianLatestComparable: med(comp.map((r) => r.score)),
      medianDelta: med(comp.map((r) => r.delta)), comparable: comp.length, improving: improving.length, declining: declining.length, flat: comp.length - improving.length - declining.length,
      leading: rows.filter((r) => r.youLead || r.rank === 1).length, medianVisibility: med(rows.map((r) => r.visibility)), stale: rows.filter((r) => r.stale).length },
    weekly: weekly.map((w) => ({ week: w.week, median: w.median == null ? null : Math.round(w.median), brands: w.brands })),
    distribution: dist,
    engines: Object.entries(engineVis).map(([engine, xs]) => ({ engine, visibility: Math.round(1000 * xs.reduce((t, v) => t + v, 0) / xs.length) / 10, brands: xs.length })).sort((a, b) => b.visibility - a.visibility),
    rivals: Object.entries(leaders).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 10),
    rechecks: { total: rcTotal, improved: rc.improved || 0, unchanged: rc.unchanged || 0, regressed: rc.regressed || 0, incomparable: rc.incomparable || 0, rate: pctOf(rc.improved || 0, rcTotal - (rc.incomparable || 0)) },
    gaps: ["decision", "consideration", "discovery"].map((g) => gaps.find((x) => x.gap === g) || { gap: g, open: 0, closed: 0, total: 0 }),
    improvers: [...comp].sort((a, b) => b.delta - a.delta).slice(0, 8), decliners: [...comp].sort((a, b) => a.delta - b.delta).filter((r) => r.delta < 0).slice(0, 8),
    brandsList: rows };
}

// Plan fit: how much of each cap accounts use, which cap binds, and what serving them costs against what they pay.
const CAPS = ["brands", "questions", "competitors", "seats", "drafts"];
export async function planFit(scope) {
  const [orgs, usage] = await Promise.all([orgRows(scope), q(`
    select o.id,
      (select count(*)::int from workspaces w where w.org_id = o.id) as brands,
      (select count(*)::int from workspaces w, ${ACTIVE_QS} e where w.org_id = o.id and e->>'on' is distinct from 'false') as questions,
      (select coalesce(max(${arrLen("w.setup->'profile'->'competitors'")}), 0)::int from workspaces w where w.org_id = o.id) as competitors,
      (select coalesce(max(${arrLen("w.setup->'engines'")}), 0)::int from workspaces w where w.org_id = o.id) as engines,
      (select count(*)::int from workspaces w where w.org_id = o.id and w.schedule = 'daily') as daily,
      ((select count(*)::int from memberships m where m.org_id = o.id) + (select count(*)::int from invitations i where i.org_id = o.id and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())) as seats,
      (select count(*)::int from usage x where x.org_id = o.id and x.sub in ${DRAFTS} and x.at >= date_trunc('month', now())) as drafts,
      (select count(*)::int from usage x where x.org_id = o.id and x.kind = 'ask' and x.at > now() - interval '30 days') as answers30
    from organizations o where ($1::uuid[] is null or o.id = any($1))`, [scope?.ids || null])]);
  const use = Object.fromEntries(usage.map((u) => [u.id, u]));
  const accounts = orgs.map((o) => {
    const u = use[o.id] || {}, plan = PLANS[o.billing_status === "trialing" ? "trial" : o.plan_code] || PLANS.trial, ov = o.entitlement_overrides?.values || {};
    const cap = (k) => { const v = ov[k] ?? plan.entitlements[k]; return v === Infinity || v == null ? null : Number(v) + (k === "seats" ? o.extra_seats || 0 : 0); };
    const caps = Object.fromEntries(CAPS.map((k) => { const c = cap(k), n = u[k] || 0; return [k, { used: n, cap: c, pct: c ? Math.round((100 * n) / c) : null }]; }));
    // A cap of 1 (one brand on a single-brand plan) is the plan's shape, not a signal to sell more of it.
    const near = CAPS.filter((k) => caps[k].cap > 1 && caps[k].pct >= 80);
    return { slug: o.slug, name: o.name, plan: o.planName, planCode: o.plan_code, status: o.billing_status, mrrInr: o.mrrInr, caps, near, engines: u.engines || 0, daily: u.daily || 0,
      answers30: u.answers30 || 0, aiUsd: o.spent_usd, checks14: o.checks14, margin: o.margin, health: o.health };
  });
  const byPlan = {};
  for (const a of accounts) (byPlan[a.planCode] ||= []).push(a);
  const plans = Object.entries(byPlan).map(([code, list]) => {
    const p = PLANS[code], paying = list.filter((a) => a.mrrInr > 0);
    const metrics = Object.fromEntries(CAPS.map((k) => { const pcts = list.map((a) => a.caps[k].pct).filter((x) => x != null);
      const counts = (min) => list.filter((a) => a.caps[k].cap > 1 && (a.caps[k].pct ?? 0) >= min).length;
      return [k, { cap: list[0]?.caps[k].cap ?? null, medianUsed: med(list.map((a) => a.caps[k].used)), p90Used: pctile(list.map((a) => a.caps[k].used), 0.9), medianPct: med(pcts), near: counts(80), atCap: counts(100) }]; }));
    const binding = CAPS.map((k) => [k, metrics[k].near]).sort((a, b) => b[1] - a[1])[0];
    const price = paying.length ? med(paying.map((a) => a.mrrInr)) : null, cost = med(paying.map((a) => a.aiUsd));
    return { code, name: p?.name || code, accounts: list.length, paying: paying.length, metrics, binding: binding && binding[1] ? binding[0] : null,
      medianAiUsd: cost, medianPriceInr: price, medianMargin: med(paying.map((a) => a.margin).filter((x) => x != null)), daily: list.reduce((t, a) => t + a.daily, 0) };
  }).sort((a, b) => (PLANS[b.code]?.public ? 1 : 0) - (PLANS[a.code]?.public ? 1 : 0) || (PLANS[a.code]?.sort ?? 99) - (PLANS[b.code]?.sort ?? 99));
  const expansion = accounts.filter((a) => a.near.length && a.status !== "canceled").sort((a, b) => b.mrrInr - a.mrrInr || b.near.length - a.near.length).slice(0, 15);
  const atRisk = accounts.filter((a) => a.mrrInr > 0 && (a.checks14 === 0 || (a.caps.questions.pct != null && a.caps.questions.pct < 25))).sort((a, b) => b.mrrInr - a.mrrInr).slice(0, 15);
  return { asOf: asOf(), plans, expansion, atRisk, accounts: accounts.length };
}

// Cost in product units: per answer (one AI call), per question tracked, per brand; and each brand's projected month from its setup.
export async function unitCosts(scope) {
  const ids = scope?.ids || null;
  const [byEngine, totals, brands] = await Promise.all([
    q(`select coalesce(engine, 'other') as engine, count(*)::int as answers, round(sum(cost_usd)::numeric, 4)::float as usd
       from usage where kind = 'ask' and at > now() - interval '30 days' and ($1::uuid[] is null or org_id = any($1)) group by 1 order by usd desc`, [ids]),
    one(`select round(coalesce(sum(cost_usd), 0)::numeric, 4)::float as all_usd, round(coalesce(sum(cost_usd) filter (where kind = 'ask'), 0)::numeric, 4)::float as ask_usd,
            count(*) filter (where kind = 'ask')::int as answers,
            (select count(*)::int from workspaces w where ($1::uuid[] is null or w.org_id = any($1)) and exists (select 1 from runs r where r.workspace_id = w.id and r.status = 'done' and r.started_at > now() - interval '30 days')) as active_brands,
            (select count(*)::int from workspaces w, ${ACTIVE_QS} e where ($1::uuid[] is null or w.org_id = any($1)) and e->>'on' is distinct from 'false'
               and exists (select 1 from runs r where r.workspace_id = w.id and r.status = 'done' and r.started_at > now() - interval '30 days')) as active_questions
         from usage where at > now() - interval '30 days' and ($1::uuid[] is null or org_id = any($1))`, [ids]),
    q(`select w.slug, w.name, o.slug as org_slug, o.name as org, o.plan_code, o.billing_status, o.billing_currency, o.billing_cycle, o.extra_seats, w.schedule, coalesce(w.samples, 1) as samples,
              (select count(*)::int from ${ACTIVE_QS} e where e->>'on' is distinct from 'false') as questions, ${arrLen("w.setup->'engines'")} as engines,
              (select count(*)::int from runs r where r.workspace_id = w.id and r.status = 'done' and r.started_at > now() - interval '30 days') as checks30,
              (select round(coalesce(sum(cost_usd), 0)::numeric, 4)::float from usage x where x.workspace_id = w.id and x.at > now() - interval '30 days') as usd30
       from workspaces w join organizations o on o.id = w.org_id where ($1::uuid[] is null or w.org_id = any($1))`, [ids]),
  ]);
  const perAnswer = totals.answers ? totals.ask_usd / totals.answers : null;
  const projected = brands.filter((b) => b.questions > 0).map((b) => {
    const perMonth = b.schedule === "daily" ? 30 : b.schedule === "weekly" ? 4.3 : b.checks30, answers = b.questions * Math.max(1, b.engines) * b.samples * perMonth;
    const price = mrrOf({ ...b }) ? toInrMinor(mrrOf({ ...b }), b.billing_currency || "INR") : 0;
    return { ...b, checksPerMonth: perMonth, answersPerMonth: Math.round(answers), projectedUsd: perAnswer == null ? null : Math.round(answers * perAnswer * 100) / 100, priceInr: price };
  }).sort((a, b) => (b.projectedUsd ?? 0) - (a.projectedUsd ?? 0));
  return { asOf: asOf(),
    totals: { usd: totals.all_usd, askUsd: totals.ask_usd, answers: totals.answers, perAnswer, activeBrands: totals.active_brands, activeQuestions: totals.active_questions,
      perBrand: totals.active_brands ? totals.all_usd / totals.active_brands : null, perQuestion: totals.active_questions ? totals.ask_usd / totals.active_questions : null, usdInr: usdInr() },
    engines: byEngine.map((e) => ({ ...e, perAnswer: e.answers ? e.usd / e.answers : null })), projected: projected.slice(0, 20) };
}

// Usage depth: how customers set White Petal up (questions, intents, engines, schedules) and how many answers it collects.
export async function usageDepth(scope) {
  const ids = scope?.ids || null;
  const [brands, intents, engines, weekly] = await Promise.all([
    q(`select w.schedule, coalesce(w.samples, 1) as samples, (select count(*)::int from ${ACTIVE_QS} e where e->>'on' is distinct from 'false') as questions,
              ${arrLen("w.setup->'engines'")} as engines, ${arrLen("w.setup->'profile'->'competitors'")} as competitors
       from workspaces w where ($1::uuid[] is null or w.org_id = any($1))`, [ids]),
    q(`select coalesce(nullif(e->>'intent', ''), 'commercial') as intent, count(*)::int as n from workspaces w, ${ACTIVE_QS} e
       where ($1::uuid[] is null or w.org_id = any($1)) and e->>'on' is distinct from 'false' group by 1 order by n desc`, [ids]),
    q(`select x as engine, count(*)::int as brands from workspaces w, jsonb_array_elements_text(case when jsonb_typeof(w.setup->'engines') = 'array' then w.setup->'engines' else '[]'::jsonb end) x
       where ($1::uuid[] is null or w.org_id = any($1)) group by 1 order by brands desc`, [ids]),
    q(`select wk.w as week, (select count(*)::int from usage x where x.kind = 'ask' and x.at >= wk.w and x.at < wk.w + interval '1 week' and ($1::uuid[] is null or x.org_id = any($1))) as answers
       from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') wk(w) order by 1`, [ids]),
  ]);
  const withQ = brands.filter((b) => b.questions > 0), sched = {}; for (const b of brands) sched[b.schedule] = (sched[b.schedule] || 0) + 1;
  const GAP = { informational: "Discovery (research)", commercial: "Consideration (compare)", transactional: "Decision (act)" };
  return { asOf: asOf(),
    kpis: { brands: brands.length, configured: withQ.length, questions: withQ.reduce((t, b) => t + b.questions, 0), medianQuestions: med(withQ.map((b) => b.questions)), p90Questions: pctile(withQ.map((b) => b.questions), 0.9),
      medianEngines: med(withQ.map((b) => b.engines)), medianCompetitors: med(withQ.map((b) => b.competitors)), answers12w: weekly.reduce((t, w) => t + w.answers, 0) },
    schedules: ["daily", "weekly", "off"].map((s) => ({ key: s, n: sched[s] || 0 })), intents: intents.map((x) => ({ key: GAP[x.intent] || x.intent, n: x.n })),
    engines, weekly: weekly.map((w) => ({ week: w.week, answers: w.answers })),
    questionsHist: [[1, 5], [6, 10], [11, 20], [21, 40], [41, 1e9]].map(([lo, hi]) => ({ key: hi > 1e8 ? `${lo}+` : `${lo}–${hi}`, n: withQ.filter((b) => b.questions >= lo && b.questions <= hi).length })) };
}
