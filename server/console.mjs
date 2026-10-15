// Command Deck read side: every number the operator console shows, derived from the tables White Petal already keeps.
// Definitions live in docs/founder-console-plan.md §12; the pure helpers below are what the tests pin.
import { q, one } from "./db.mjs";
import { PLANS, monthlyEquivalent } from "./plans.mjs";
import { billingConfig, planIdFor } from "./razorpay.mjs";

const PAYING = ["active", "past_due"];
// Totals are shown in INR; USD prices convert at this rate (an estimate, labelled as such on screen).
export const usdInr = () => Number(process.env.CONSOLE_USD_INR || 84);

// Monthly price before tax, in minor units of the organisation's currency. Only paying organisations count. An annual plan counts a
// twelfth of its yearly price; extra seats count at the plan's seat price unless the plan has none.
export function mrrOf(org) {
  if (!PAYING.includes(org.billing_status) || org.one_time) return 0; // a one-time month is revenue, not recurring
  const ccy = org.billing_currency || "INR", base = monthlyEquivalent(org.plan_code, ccy, org.billing_cycle || "monthly") ?? 0;
  return base + (org.extra_seats || 0) * (PLANS[org.plan_code]?.seatPrices?.[ccy] ?? 0);
}
export const toInrMinor = (minor, ccy) => (ccy === "USD" ? Math.round(minor * usdInr()) : minor);
// A trial that is still running. An ended, unpaid trial keeps billing_status "trialing" (access is decided from trial_ends_at), so
// counting the status alone would count dead trials.
export const liveTrial = (o, now = Date.now()) => o.billing_status === "trialing" && (!o.trial_ends_at || new Date(o.trial_ends_at) > now);
// AI cost (USD) against the price (minor units) → gross margin %, or null when there is no revenue.
export function marginPct(priceMinor, ccy, aiUsd) {
  const revenueUsd = ccy === "USD" ? priceMinor / 100 : priceMinor / 100 / usdInr();
  return revenueUsd > 0 ? Math.round((1 - aiUsd / revenueUsd) * 100) : null;
}

// Health 0-100 (plan §7 D2). Each part is 0..1 times its weight.
export const HEALTH_WEIGHTS = { checks: 30, actions: 20, seats: 10, integrations: 10, budget: 10, payment: 10, login: 10 };
export function health(s) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const parts = {
    checks: clamp((s.checks14 || 0) / 2),                                      // two checks in a fortnight = full marks
    actions: clamp((s.actions14 || 0) / 3),
    seats: s.seatLimit ? clamp((s.members || 0) / s.seatLimit) : (s.members ? 1 : 0),       // unlimited seats: any member counts as full
    integrations: clamp((s.integrations || 0) / 2),
    budget: s.capUsd ? clamp(1 - (s.spentUsd || 0) / s.capUsd) : 1,
    payment: s.billing_status === "past_due" ? 0 : s.billing_status === "canceled" ? 0.3 : 1,
    login: s.lastLoginDays == null ? 0 : clamp(1 - s.lastLoginDays / 30),
  };
  const score = Math.round(Object.entries(HEALTH_WEIGHTS).reduce((t, [k, w]) => t + parts[k] * w, 0));
  return { score, band: score >= 75 ? "Thriving" : score >= 50 ? "Steady" : score >= 25 ? "At risk" : "Dormant", parts };
}

// The global filter bar (Founder Command): accounts = customers | all | group:<id>, demo = show | hide, days = 7 | 30 | 90 | 365.
// Returns the organisation ids in view (`ids`, null = every organisation) for SQL as `($n::uuid[] is null or org_id = any($n))`.
export async function scopeFrom(url) {
  const sp = url?.searchParams || new URLSearchParams(), accounts = String(sp.get("accounts") || "customers"), demo = sp.get("demo") === "hide";
  const days = [7, 30, 90, 365].includes(Number(sp.get("days"))) ? Number(sp.get("days")) : 30;
  let ids = null, group = null;
  const gm = accounts.match(/^group:([0-9a-f-]{36})$/);
  if (gm) {
    group = await one(`select id, name from account_groups where id = $1`, [gm[1]]);
    ids = group ? (await q(`select org_id from account_group_members where group_id = $1`, [group.id])).map((r) => r.org_id) : [];
  } else {
    const out = (await q(`select distinct m.org_id from account_group_members m join account_groups g on g.id = m.group_id
        where ($1 and g.leave_out and g.kind <> 'demo') or ($2 and g.kind = 'demo')`, [accounts !== "all", demo])).map((r) => r.org_id);
    if (out.length) { const drop = new Set(out); ids = (await q(`select id from organizations`)).map((r) => r.id).filter((id) => !drop.has(id)); }
  }
  const set = ids ? new Set(ids) : null;
  return { ids, set, has: (id) => !set || set.has(id), accounts: group ? "group" : accounts === "all" ? "all" : "customers", group, demo, days,
    label: [group ? `group: ${group.name}` : accounts === "all" ? "all accounts" : "customers only", demo ? "demo hidden" : "demo included", `last ${days} days`].join(" · ") };
}

// One row per organisation with everything the list, margin and attention views need.
export async function orgRows(scope = null) {
  const rows = await q(`
    select o.id, o.slug, o.name, o.created_at, o.plan_code, o.billing_status, o.billing_currency, o.trial_ends_at, o.current_period_end,
      o.cancel_at_period_end, o.pending_plan_code, o.razorpay_subscription_id, o.billing_reconciled_at, o.monthly_cap_usd, o.allow_platform_keys, o.paused_at, o.billing_cycle, o.extra_seats, o.extra_seats_billing,
      (select u.email from memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner' limit 1) as owner,
      (select count(*)::int from memberships m where m.org_id = o.id) as members,
      exists (select 1 from payment_links p where p.org_id = o.id and p.status = 'paid' and p.period_end = o.current_period_end) as one_time,
      (select count(*)::int from workspaces w where w.org_id = o.id) as brands,
      (select count(*)::int from runs r join workspaces w on w.id = r.workspace_id where w.org_id = o.id and r.status = 'done' and r.started_at > now() - interval '14 days') as checks14,
      (select count(*)::int from runs r join workspaces w on w.id = r.workspace_id where w.org_id = o.id and r.status = 'done') as checks_all,
      (select count(*)::int from runs r join workspaces w on w.id = r.workspace_id where w.org_id = o.id and r.source = 'scheduled' and r.status = 'failed' and r.started_at > now() - interval '3 days') as failed3,
      (select max(r.started_at) from runs r join workspaces w on w.id = r.workspace_id where w.org_id = o.id) as last_run,
      (select count(*)::int from recovery_actions a join workspaces w on w.id = a.workspace_id where w.org_id = o.id and a.updated_at > now() - interval '14 days' and a.status <> 'suggested') as actions14,
      (select count(*)::int from integrations i join workspaces w on w.id = i.workspace_id where w.org_id = o.id and i.status = 'connected') as integrations,
      (select extract(day from now() - max(u.last_login_at))::int from memberships m join users u on u.id = m.user_id where m.org_id = o.id) as last_login_days,
      (select coalesce(sum(cost_usd), 0)::float from usage x where x.org_id = o.id and x.at >= date_trunc('month', now())) as spent_usd,
      (select coalesce(sum(cost_usd), 0)::float from usage x where x.org_id = o.id and x.at >= now() - interval '1 day') as spent_day,
      (select coalesce(sum(cost_usd), 0)::float / 7 from usage x where x.org_id = o.id and x.at >= now() - interval '8 days' and x.at < now() - interval '1 day') as spent_day_avg
    from organizations o order by o.created_at desc limit 2000`);
  return rows.map((o) => {
    const ccy = o.billing_currency || "INR", mrr = mrrOf(o), plan = PLANS[o.plan_code];
    const capUsd = o.monthly_cap_usd != null ? Number(o.monthly_cap_usd) : plan?.capUsd ?? null;
    const h = health({ ...o, capUsd, spentUsd: o.spent_usd, seatLimit: Number.isFinite(plan?.entitlements?.seats) ? plan.entitlements.seats : null, lastLoginDays: o.last_login_days });
    return { ...o, currency: ccy, planName: plan?.name || o.plan_code, mrr, mrrInr: toInrMinor(mrr, ccy), contracted: mrr > 0 && !o.razorpay_subscription_id,
      capUsd, margin: marginPct(mrr, ccy, o.spent_usd), health: h.score, band: h.band, healthParts: h.parts };
  }).filter((o) => !scope || scope.has(o.id));
}

// The "needs you" feed (plan §4 A2), ranked by money at risk then urgency.
export function attention(orgs, now = Date.now()) {
  const out = [], day = 864e5, add = (o, rule, level, title, detail, action) => out.push({ key: `${rule}:${o.slug}`, rule, level, slug: o.slug, org: o.name, title, detail, action, money: o.mrrInr || 0 });
  for (const o of orgs) {
    const trialLeft = o.trial_ends_at ? (new Date(o.trial_ends_at) - now) / day : null;
    if (o.billing_status === "past_due") add(o, "payment_failed", "bad", "Payment failed", `${o.planName}, renewal not paid`, "Open billing");
    if (o.billing_status === "trialing" && trialLeft != null && trialLeft >= 0 && trialLeft <= 2)
      add(o, o.checks_all ? "trial_ending" : "trial_dormant", o.checks_all ? "warn" : "bad", o.checks_all ? "Trial ends soon" : "Trial ends soon, no check run",
        `${Math.max(0, Math.ceil(trialLeft))} day(s) left · ${o.checks_all} check(s) run`, o.checks_all ? "Nudge to upgrade" : "Extend trial");
    if (o.capUsd && o.spent_usd >= o.capUsd) add(o, "budget_over", "bad", "AI budget used up", `$${o.spent_usd.toFixed(2)} of $${o.capUsd} this month; new checks are stopped`, "Raise budget");
    else if (o.capUsd && o.spent_usd >= o.capUsd * 0.8) add(o, "budget_near", "warn", "AI budget at " + Math.round((o.spent_usd / o.capUsd) * 100) + "%", `$${o.spent_usd.toFixed(2)} of $${o.capUsd} this month`, "Review usage");
    if (o.margin != null && o.margin < 0) add(o, "margin_negative", "bad", "Negative margin", `AI cost $${o.spent_usd.toFixed(2)} is above this month's price`, "Review usage");
    if (o.failed3 >= 2) add(o, "runs_failing", "warn", "Scheduled checks failing", `${o.failed3} failed in 3 days`, "Open runs");
    if (o.spent_day_avg > 0.05 && o.spent_day > o.spent_day_avg * 5) add(o, "cost_spike", "warn", "Cost spike", `$${o.spent_day.toFixed(2)} today vs $${o.spent_day_avg.toFixed(2)} typical`, "Review usage");
    if (o.cancel_at_period_end && o.current_period_end && new Date(o.current_period_end) - now < 7 * day) add(o, "cancel_pending", "warn", "Cancels this week", `${o.planName} ends ${new Date(o.current_period_end).toDateString()}`, "Win back");
    if (o.razorpay_subscription_id && PAYING.includes(o.billing_status) && (!o.billing_reconciled_at || now - new Date(o.billing_reconciled_at) > 3 * day))
      add(o, "reconcile_stale", "warn", "Not synced with Razorpay", "Last sync over 3 days ago", "Reconcile");
  }
  const rank = { bad: 0, warn: 1, good: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || b.money - a.money);
}

async function snoozed() {
  return new Set((await q(`select key from console_attention_state where done_at is not null or snoozed_until > now()`)).map((r) => r.key));
}

export async function overview(scope = null) {
  const orgs = await orgRows(scope), hidden = await snoozed();
  const paying = orgs.filter((o) => o.mrr > 0);
  const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
  const [runs, ai, newOrgs, wk, trend, upgrades] = await Promise.all([
    one(`select count(*) filter (where status = 'done')::int as ok, count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'running')::int as running from runs where started_at >= date_trunc('day', now())`),
    one(`select coalesce(sum(cost_usd) filter (where at >= date_trunc('day', now())), 0)::float as today, coalesce(sum(cost_usd) filter (where at >= date_trunc('month', now())), 0)::float as mtd from usage`),
    one(`select count(*) filter (where created_at > now() - interval '30 days')::int as d30, count(*) filter (where created_at > now() - interval '60 days' and created_at <= now() - interval '30 days')::int as prev from organizations`),
    one(`with w as (select w.org_id,
            bool_or(r.status = 'done') as checked,
            exists (select 1 from usage x where x.org_id = w.org_id and x.sub in ('pitch','article','fixpack') and x.at > now() - interval '7 days') as drafted,
            exists (select 1 from recovery_actions a join workspaces w2 on w2.id = a.workspace_id where w2.org_id = w.org_id and a.status <> 'suggested' and a.updated_at > now() - interval '7 days') as acted
          from workspaces w left join runs r on r.workspace_id = w.id and r.started_at > now() - interval '7 days' group by w.org_id)
         select count(*) filter (where checked)::int as wao, count(*) filter (where checked and drafted and acted)::int as wrl from w`),
    q(`select d::date as day,
          (select count(*)::int from organizations o where o.created_at::date = d::date) as signups,
          (select count(*)::int from runs r where r.started_at::date = d::date and r.status = 'done') as checks,
          (select coalesce(sum(cost_usd), 0)::float from usage x where x.at::date = d::date) as ai
        from generate_series(now() - interval '29 days', now(), interval '1 day') d order by 1`),
    q(`select a.at, o.slug, o.name, a.detail from audit_log a join organizations o on o.id = a.org_id where a.action in ('billing.activated', 'billing.payment_confirmed', 'billing.operator_set') and a.at > now() - interval '7 days' order by a.at desc limit 5`).catch(() => []),
  ]);
  const mrr = sum(paying, (o) => o.mrrInr), revenueUsd = mrr / 100 / usdInr();
  const items = attention(orgs).filter((i) => !hidden.has(i.key));
  for (const u of upgrades) items.push({ key: `upgrade:${u.slug}:${u.at}`, rule: "upgrade", level: "good", slug: u.slug, org: u.name, title: "New or upgraded plan", detail: new Date(u.at).toDateString(), action: "Open" });
  return {
    usdInr: usdInr(),
    kpis: {
      mrrInr: mrr, contractedInr: sum(paying.filter((o) => o.contracted), (o) => o.mrrInr), paying: paying.length,
      trials: orgs.filter((o) => liveTrial(o)).length, newOrgs30: newOrgs.d30, newOrgsPrev: newOrgs.prev,
      wao: wk.wao, wrl: wk.wrl, runsToday: runs, aiToday: ai.today, aiMtd: ai.mtd,
      marginMtd: revenueUsd > 0 ? Math.round((1 - ai.mtd / revenueUsd) * 100) : null, orgs: orgs.length,
    },
    attention: items.slice(0, 40), trend,
  };
}

export async function customers(scope = null) {
  return (await orgRows(scope)).map(({ id, healthParts, ...o }) => o);
}

export async function customer(slug) {
  const o = (await orgRows()).find((x) => x.slug === slug);
  if (!o) return null;
  const [members, brands, runs, usage, audit, notes, emails, invites, paymentLinks] = await Promise.all([
    q(`select u.id, u.email, u.name, m.role, u.last_login_at, m.created_at as joined_at, u.email_verified_at is not null as verified from memberships m join users u on u.id = m.user_id where m.org_id = $1
       order by case m.role when 'owner' then 0 when 'admin' then 1 when 'editor' then 2 else 3 end, u.email`, [o.id]),
    q(`select w.slug, w.name, w.site, w.schedule, w.last_run_at, w.next_run_at,
         (select count(*)::int from recovery_actions a where a.workspace_id = w.id and a.status not in ('archived')) as actions
       from workspaces w where w.org_id = $1 order by w.created_at`, [o.id]),
    q(`select r.id, w.name as brand, r.source, r.status, r.started_at, r.finished_at, left(r.error, 200) as error from runs r join workspaces w on w.id = r.workspace_id where w.org_id = $1 order by r.started_at desc limit 15`, [o.id]),
    q(`select kind, coalesce(engine, '') as engine, sum(n)::int as calls, round(sum(cost_usd)::numeric, 4)::float as usd from usage where org_id = $1 and at >= date_trunc('month', now()) group by 1, 2 order by usd desc`, [o.id]),
    q(`select a.at, a.action, a.target, u.email as who from audit_log a left join users u on u.id = a.user_id where a.org_id = $1 order by a.at desc limit 40`, [o.id]),
    q(`select n.id, n.body, n.at, u.email as by from org_notes n left join users u on u.id = n.by_user where n.org_id = $1 order by n.pinned desc, n.at desc limit 50`, [o.id]),
    q(`select kind, status, created_at from email_log where org_id = $1 order by created_at desc limit 20`, [o.id]),
    q(`select i.id, i.email, i.role, i.created_at, i.expires_at from invitations i where i.org_id = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now() order by i.created_at desc`, [o.id]),
    q(`select id, plan_code, currency, amount_minor::float as amount, status, short_url, created_at, paid_at, period_end from payment_links where org_id = $1 order by created_at desc limit 10`, [o.id]),
  ]);
  const { id, ...org } = o;
  // Prices an operator can send as a Razorpay subscription link: any catalogue price with a Razorpay plan id.
  const offers = Object.values(PLANS).flatMap((p) => Object.keys(p.prices || {}).flatMap((currency) => [
    ...(p.razorpayIds?.[currency] || planIdFor(p.code, currency) ? [{ plan: p.code, name: p.name, currency, cycle: "monthly", amount: p.prices[currency] }] : []),
    ...(p.annualPrices?.[currency] != null && (p.annualRazorpayIds?.[currency] || planIdFor(p.code, currency, "annual")) ? [{ plan: p.code, name: p.name, currency, cycle: "annual", amount: p.annualPrices[currency] }] : [])]));
  return { org, members, invites, brands, runs, usage, audit, notes, emails, offers, paymentLinks, billingReady: billingConfig().ready };
}

export async function revenue(scope = null) {
  const orgs = await orgRows(scope), paying = orgs.filter((o) => o.mrr > 0);
  const byPlan = {};
  for (const o of paying) { const p = (byPlan[o.planName] ||= { plan: o.planName, orgs: 0, mrrInr: 0 }); p.orgs++; p.mrrInr += o.mrrInr; }
  const status = {}; for (const o of orgs) status[o.billing_status] = (status[o.billing_status] || 0) + 1;
  const [funnel, months, events] = await Promise.all([
    one(`with u as (select id from users where created_at > now() - interval '90 days'),
          o as (select distinct m.org_id from memberships m join u on u.id = m.user_id where m.role = 'owner')
         select (select count(*)::int from u) as signups,
                (select count(*)::int from o where exists (select 1 from workspaces w where w.org_id = o.org_id)) as brand,
                (select count(*)::int from o where exists (select 1 from runs r join workspaces w on w.id = r.workspace_id where w.org_id = o.org_id and r.status = 'done')) as checked,
                (select count(*)::int from o join organizations x on x.id = o.org_id where x.trial_started_at is not null) as trial,
                (select count(*)::int from o join organizations x on x.id = o.org_id where x.billing_status in ('active','past_due') and x.razorpay_subscription_id is not null) as paid`),
    q(`select to_char(m, 'Mon YY') as month,
          (select count(*)::int from organizations o where date_trunc('month', o.created_at) = m) as signups,
          (select count(*)::int from audit_log a where a.action = 'billing.activated' and date_trunc('month', a.at) = m) as activations,
          (select count(*)::int from audit_log a where a.action = 'billing.cancelled' and date_trunc('month', a.at) = m) as cancellations
        from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m order by m`),
    q(`select a.at, a.action, o.slug, o.name from audit_log a join organizations o on o.id = a.org_id where a.action like 'billing.%' order by a.at desc limit 25`),
  ]);
  // One-time payments (payment links) in the period: revenue, not MRR. Amounts include tax, as charged.
  const days = scope?.days || 30, links = (await q(`select org_id, amount_minor, currency from payment_links where status = 'paid' and paid_at > now() - make_interval(days => $1)`, [days])).filter((l) => !scope || scope.has(l.org_id));
  const oneTime = { count: links.length, inr: links.reduce((t, l) => t + toInrMinor(Number(l.amount_minor), l.currency), 0), days };
  return { oneTime, usdInr: usdInr(), mrrInr: paying.reduce((t, o) => t + o.mrrInr, 0), byPlan: Object.values(byPlan).sort((a, b) => b.mrrInr - a.mrrInr), status, funnel, months, events,
    arpaInr: paying.length ? Math.round(paying.reduce((t, o) => t + o.mrrInr, 0) / paying.length) : 0 };
}

export async function margin(scope = null) {
  const orgs = (await orgRows(scope)).filter((o) => o.mrr > 0 || o.spent_usd > 0);
  const [byEngine, byKind] = await Promise.all([
    q(`select coalesce(engine, 'writing') as engine, sum(n)::int as calls, round(sum(cost_usd)::numeric, 4)::float as usd from usage where at >= date_trunc('month', now()) group by 1 order by usd desc`),
    q(`select kind, sum(n)::int as calls, round(sum(cost_usd)::numeric, 4)::float as usd from usage where at >= date_trunc('month', now()) group by 1 order by usd desc`),
  ]);
  const rows = orgs.map((o) => ({ slug: o.slug, name: o.name, plan: o.planName, mrrInr: o.mrrInr, currency: o.currency, spentUsd: o.spent_usd, capUsd: o.capUsd, margin: o.margin, platformKeys: o.allow_platform_keys }))
    .sort((a, b) => (a.margin ?? -999) - (b.margin ?? -999));
  return { usdInr: usdInr(), rows, byEngine, byKind, platformKeysUsd: orgs.filter((o) => o.allow_platform_keys).reduce((t, o) => t + o.spent_usd, 0) };
}

export async function subscriptions(scope = null) {
  const orgs = await orgRows(scope), day = 864e5, now = Date.now();
  const subs = orgs.filter((o) => o.billing_status !== "internal").map((o) => ({ slug: o.slug, name: o.name, owner: o.owner, plan: o.planName, status: o.billing_status, currency: o.currency, mrr: o.mrr,
    renews: o.current_period_end, trialEnds: o.trial_ends_at, cancelAtEnd: o.cancel_at_period_end, pendingPlan: o.pending_plan_code ? PLANS[o.pending_plan_code]?.name || o.pending_plan_code : null,
    razorpay: o.razorpay_subscription_id, reconciled: o.billing_reconciled_at, contracted: o.contracted }));
  const within = (d, n) => d && new Date(d) - now >= 0 && new Date(d) - now <= n * day;
  return { subs,
    pastDue: subs.filter((s) => s.status === "past_due"),
    renewals: subs.filter((s) => s.status === "active" && !s.cancelAtEnd && within(s.renews, 30)),
    trialsEnding: subs.filter((s) => s.status === "trialing" && within(s.trialEnds, 7)),
    cancelling: subs.filter((s) => s.cancelAtEnd),
    downgrades: subs.filter((s) => s.pendingPlan) };
}

export async function platform() {
  const [runs, errors, engines, sched, hooks, emails, lastTick] = await Promise.all([
    one(`select count(*)::int as total, count(*) filter (where status = 'done')::int as ok, count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where status = 'stopped')::int as stopped, count(*) filter (where status = 'running')::int as running,
            count(*) filter (where source = 'scheduled')::int as scheduled,
            percentile_cont(0.5) within group (order by extract(epoch from finished_at - started_at)) filter (where status = 'done') as p50,
            percentile_cont(0.95) within group (order by extract(epoch from finished_at - started_at)) filter (where status = 'done') as p95
          from runs where started_at > now() - interval '7 days'`),
    q(`select left(regexp_replace(coalesce(error, 'no error text'), '[0-9a-f-]{8,}|\\d+', '#', 'g'), 140) as error, count(*)::int as n, max(started_at) as last,
          count(distinct workspace_id)::int as brands from runs where status = 'failed' and started_at > now() - interval '7 days' group by 1 order by n desc limit 12`),
    q(`select coalesce(engine, 'writing') as engine, kind, sum(n)::int as calls, round(sum(cost_usd)::numeric, 4)::float as usd from usage where at > now() - interval '1 day' group by 1, 2 order by calls desc limit 20`),
    one(`select count(*) filter (where schedule <> 'off' and next_run_at < now() - interval '30 minutes')::int as overdue,
            count(*) filter (where running_at is not null)::int as running, count(*) filter (where schedule <> 'off')::int as scheduled from workspaces`),
    one(`select count(*)::int as day, count(*) filter (where status = 'failed')::int as failed, max(received_at) as last from billing_events where received_at > now() - interval '1 day'`),
    one(`select count(*)::int as day, count(*) filter (where status is distinct from 'sent')::int as failed from email_log where created_at > now() - interval '1 day'`),
    one(`select max(started_at) as at from runs where source = 'scheduled'`),
  ]);
  return { runs, errors, engines, sched, hooks, emails, lastScheduledRun: lastTick?.at || null };
}

export async function auditFeed(limit = 100) {
  return q(`select a.at, a.action, a.target, o.slug, o.name as org, u.email as who from audit_log a left join organizations o on o.id = a.org_id left join users u on u.id = a.user_id order by a.at desc limit $1`, [limit]);
}

// Active users and organisations per day, week and month. "Active" = signed in, ran a check, made an AI call or did anything audited
// that day. DAU = that day; WAU = the 7 days ending that day; MAU = the 30 days ending that day. A sign-in alone counts only while
// its session row exists (sign-out deletes it); checks, AI calls and audited actions are kept for good.
// People active per day over the Period filter (7 to 365 days), counting only people in the accounts the Accounts filter shows.
export async function activity(days = 30, scope = null) {
  days = Math.max(7, Math.min(365, Math.round(days)));
  const ids = scope?.ids || null, inScope = `($2::uuid[] is null or user_id in (select user_id from memberships where org_id = any($2)))`;
  const ev = `ev as (select * from (
      select user_id, at::date as day from usage where user_id is not null and at > now() - interval '1 day' * ($1 + 30)
      union select started_by, started_at::date from runs where started_by is not null and started_at > now() - interval '1 day' * ($1 + 30)
      union select user_id, created_at::date from sessions where created_at > now() - interval '1 day' * ($1 + 30)
      union select user_id, at::date from audit_log where user_id is not null and action not like 'operator.%' and at > now() - interval '1 day' * ($1 + 30)) e (user_id, day) where ${inScope}),
    oev as (select * from (
      select org_id, at::date as day from usage where at > now() - interval '1 day' * ($1 + 30)
      union select w.org_id, r.started_at::date from runs r join workspaces w on w.id = r.workspace_id where r.started_at > now() - interval '1 day' * ($1 + 30)) o (org_id, day) where ($2::uuid[] is null or org_id = any($2)))`;
  const [series, now, byPlan, top] = await Promise.all([
    q(`with ${ev}, d as (select generate_series(current_date - ($1 - 1), current_date, interval '1 day')::date as day)
       select d.day,
         (select count(distinct user_id)::int from ev where ev.day = d.day) as dau,
         (select count(distinct user_id)::int from ev where ev.day between d.day - 6 and d.day) as wau,
         (select count(distinct user_id)::int from ev where ev.day between d.day - 29 and d.day) as mau,
         (select count(distinct org_id)::int from oev where oev.day = d.day) as dao,
         (select count(*)::int from users u where u.created_at::date = d.day and ($2::uuid[] is null or u.id in (select user_id from memberships where org_id = any($2)))) as signups
       from d order by d.day`, [days, ids]),
    one(`with ${ev} select
         (select count(distinct user_id)::int from ev where day = current_date) as dau,
         (select count(distinct user_id)::int from ev where day > current_date - 7) as wau,
         (select count(distinct user_id)::int from ev where day > current_date - 30) as mau,
         (select count(distinct org_id)::int from oev where day = current_date) as dao,
         (select count(distinct org_id)::int from oev where day > current_date - 7) as wao,
         (select count(distinct org_id)::int from oev where day > current_date - 30) as mao,
         (select count(*)::int from users u where $2::uuid[] is null or u.id in (select user_id from memberships where org_id = any($2))) as users`, [days, ids]),
    q(`with ${ev} select coalesce(p.name, o.plan_code) as plan, count(distinct ev.user_id)::int as mau, count(distinct o.id)::int as orgs
       from ev join memberships m on m.user_id = ev.user_id join organizations o on o.id = m.org_id left join plans p on p.code = o.plan_code
       where ev.day > current_date - 30 and ($2::uuid[] is null or o.id = any($2)) group by 1 order by mau desc`, [days, ids]),
    q(`with ${ev} select o.slug, o.name, count(distinct ev.user_id)::int as users, count(distinct ev.day)::int as active_days
       from ev join memberships m on m.user_id = ev.user_id join organizations o on o.id = m.org_id
       where ev.day > current_date - 30 and ($2::uuid[] is null or o.id = any($2)) group by 1, 2 order by active_days desc, users desc limit 10`, [days, ids]),
  ]);
  return { days, series, now: { ...now, stickiness: now.mau ? Math.round((100 * now.dau) / now.mau) : null }, byPlan, top };
}

// ── Live: who is in the app now and what is happening (polled every 5 s by the console's SSE stream) ──
export async function live() {
  const [online, running, feed, perMinute, today, spend] = await Promise.all([
    q(`select u.email, u.name, o.slug, o.name as org, coalesce(pl.name, o.plan_code) as plan, o.billing_status, p.page, p.brand, p.device,
          extract(epoch from now() - p.since)::int as on_page_s, extract(epoch from now() - p.at)::int as seen_s
        from presence p join users u on u.id = p.user_id left join organizations o on o.id = p.org_id left join plans pl on pl.code = o.plan_code
        where p.at > now() - interval '2 minutes' order by p.since desc limit 200`),
    q(`select r.id, w.name as brand, o.slug, o.name as org, r.source, extract(epoch from now() - r.started_at)::int as elapsed_s
        from runs r join workspaces w on w.id = r.workspace_id join organizations o on o.id = w.org_id
        where r.status = 'running' and r.started_at > now() - interval '2 hours' order by r.started_at desc limit 50`),
    q(`(select x.at, 'ai' as type, x.kind || coalesce(' · ' || x.engine, '') || coalesce(' · ' || x.sub, '') as what, o.slug, o.name as org, u.email as who, x.cost_usd::float as usd
          from usage x left join organizations o on o.id = x.org_id left join users u on u.id = x.user_id where x.at > now() - interval '30 minutes' order by x.at desc limit 40)
       union all (select r.started_at, 'check', 'started a ' || r.source || ' check on ' || w.name, o.slug, o.name, u.email, null
          from runs r join workspaces w on w.id = r.workspace_id join organizations o on o.id = w.org_id left join users u on u.id = r.started_by where r.started_at > now() - interval '30 minutes' order by r.started_at desc limit 20)
       union all (select r.finished_at, case when r.status = 'failed' then 'failed' else 'done' end, 'check ' || r.status || ' on ' || w.name, o.slug, o.name, null, null
          from runs r join workspaces w on w.id = r.workspace_id join organizations o on o.id = w.org_id where r.finished_at > now() - interval '30 minutes' order by r.finished_at desc limit 20)
       union all (select a.at, 'action', a.action, o.slug, o.name, u.email, null
          from audit_log a left join organizations o on o.id = a.org_id left join users u on u.id = a.user_id where a.at > now() - interval '30 minutes' and a.action not like 'console.%' order by a.at desc limit 20)
       union all (select v.at, 'view', 'opened ' || v.page, o.slug, o.name, u.email, null
          from page_views v left join organizations o on o.id = v.org_id left join users u on u.id = v.user_id where v.at > now() - interval '30 minutes' order by v.at desc limit 30)
       order by at desc limit 60`),
    q(`select m as minute,
          (select count(*)::int from usage x where x.at >= m and x.at < m + interval '1 minute') as ai,
          (select count(*)::int from page_views v where v.at >= m and v.at < m + interval '1 minute') as views,
          (select count(*)::int from runs r where r.started_at >= m and r.started_at < m + interval '1 minute') as checks
        from generate_series(date_trunc('minute', now()) - interval '59 minutes', date_trunc('minute', now()), interval '1 minute') m order by m`),
    one(`select count(distinct user_id)::int as n from (select user_id from page_views where at >= date_trunc('day', now()) union select user_id from usage where at >= date_trunc('day', now()) union select user_id from presence where at >= date_trunc('day', now())) t`),
    one(`select coalesce(sum(cost_usd) filter (where at > now() - interval '1 hour'), 0)::float as hour, coalesce(sum(cost_usd) filter (where at > now() - interval '24 hours'), 0)::float as day from usage`),
  ]);
  const by = (k) => Object.entries(online.reduce((m, x) => ((m[x[k] || "—"] = (m[x[k] || "—"] || 0) + 1), m), {})).map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
  return { at: new Date(), online, running, feed, perMinute, spend, today: today.n, onlineByPage: by("page"), onlineByPlan: by("plan"), onlineByDevice: by("device"),
    onlineOrgs: new Set(online.map((x) => x.slug).filter(Boolean)).size };
}

// ── Insights: the product questions a PM or analyst asks of the business, answered from the same tables ──
export async function engagement(scope = null) {
  const ids = scope?.ids || null;
  const [adoption, byPlan, devices, cohorts, activation, depth, northStar, concentration] = await Promise.all([
    // Feature adoption: of the people active in 30 days, how many used each page.
    q(`with act as (select count(distinct user_id)::int as n from page_views where at > now() - interval '30 days' and ($1::uuid[] is null or org_id = any($1)))
       select page, count(*)::int as views, count(distinct user_id)::int as users, count(distinct org_id)::int as orgs,
              round(100.0 * count(distinct user_id) / greatest(1, (select n from act)))::int as pct
       from page_views where at > now() - interval '30 days' and ($1::uuid[] is null or org_id = any($1)) group by page order by users desc, views desc limit 25`, [ids]),
    // Per plan: how many of that plan's active people used each page (shares, so big plans don't drown small ones).
    q(`with v as (select coalesce(pl.name, o.plan_code) as plan, v.page, v.user_id from page_views v join organizations o on o.id = v.org_id left join plans pl on pl.code = o.plan_code
                  where v.at > now() - interval '30 days' and ($1::uuid[] is null or v.org_id = any($1)))
       select plan, page, count(distinct user_id)::int as users, (select count(distinct user_id)::int from v v2 where v2.plan = v.plan) as active
       from v group by plan, page`, [ids]),
    q(`select device, count(*)::int as views, count(distinct user_id)::int as users from page_views where at > now() - interval '30 days' and ($1::uuid[] is null or org_id = any($1)) group by 1 order by users desc`, [ids]),
    // Weekly retention: people grouped by sign-up week, and the weeks after sign-up in which they did anything (cohortTable below).
    q(`with ev as (select user_id, at from page_views union all select user_id, at from usage where user_id is not null union all select started_by, started_at from runs where started_by is not null),
         c as (select id, date_trunc('week', created_at) as wk from users where created_at > date_trunc('week', now()) - interval '7 weeks'
                 and ($1::uuid[] is null or id in (select user_id from memberships where org_id = any($1))))
       select c.wk, c.id, coalesce(array_agg(distinct floor(extract(epoch from e.at - c.wk) / 604800)::int) filter (where e.at is not null), '{}') as ks
       from c left join ev e on e.user_id = c.id and e.at >= c.wk group by c.wk, c.id`, [ids]),
    // Activation: new organisations (90 days) reaching each milestone, and how long it takes.
    one(`with o as (select o.id, o.created_at,
            (select min(r.finished_at) from runs r join workspaces w on w.id = r.workspace_id where w.org_id = o.id and r.status = 'done') as first_check,
            (select min(x.at) from usage x where x.org_id = o.id and x.sub in ('pitch','article','fixpack')) as first_draft,
            (select min(a.updated_at) from recovery_actions a join workspaces w on w.id = a.workspace_id where w.org_id = o.id and a.status <> 'suggested') as first_action,
            (select min(a.at) from audit_log a where a.org_id = o.id and a.action in ('billing.activated','billing.payment_confirmed')) as paid
          from organizations o where o.created_at > now() - interval '90 days' and ($1::uuid[] is null or o.id = any($1)))
       select count(*)::int as orgs, count(first_check)::int as checked, count(first_draft)::int as drafted, count(first_action)::int as acted, count(paid)::int as paid,
         count(*) filter (where first_check < created_at + interval '1 day')::int as checked_1d,
         count(*) filter (where first_check < created_at + interval '7 days')::int as checked_7d,
         round((percentile_cont(0.5) within group (order by extract(epoch from first_check - created_at) / 3600))::numeric, 1)::float as h_to_check,
         round((percentile_cont(0.5) within group (order by extract(epoch from first_draft - created_at) / 3600))::numeric, 1)::float as h_to_draft,
         round((percentile_cont(0.5) within group (order by extract(epoch from paid - created_at) / 86400))::numeric, 1)::float as d_to_paid
       from o`, [ids]),
    // Depth: per active organisation per week, how much of the product they use.
    q(`select to_char(wk, 'DD Mon') as week, count(*)::int as orgs, round(avg(checks), 1)::float as checks, round(avg(ai), 1)::float as ai_calls
       from (select wk, org_id, sum(ai) as ai, sum(checks) as checks from (
               select date_trunc('week', x.at) as wk, x.org_id, count(*) as ai, 0 as checks from usage x where x.at > date_trunc('week', now()) - interval '7 weeks' and ($1::uuid[] is null or x.org_id = any($1)) group by 1, 2
               union all select date_trunc('week', r.started_at), w.org_id, 0, count(*) from runs r join workspaces w on w.id = r.workspace_id where r.started_at > date_trunc('week', now()) - interval '7 weeks' and ($1::uuid[] is null or w.org_id = any($1)) group by 1, 2) t
             group by 1, 2) per_org
       group by wk order by wk`, [ids]),
    // North star: organisations completing the full loop (check + draft + action) per week, last 12 weeks.
    q(`select to_char(wk, 'DD Mon') as week,
         (select count(*)::int from organizations o where ($1::uuid[] is null or o.id = any($1)) and
            exists (select 1 from runs r join workspaces w on w.id = r.workspace_id where w.org_id = o.id and r.status = 'done' and r.started_at >= wk and r.started_at < wk + interval '1 week')
            and exists (select 1 from usage x where x.org_id = o.id and x.sub in ('pitch','article','fixpack') and x.at >= wk and x.at < wk + interval '1 week')
            and exists (select 1 from recovery_actions a join workspaces w on w.id = a.workspace_id where w.org_id = o.id and a.status <> 'suggested' and a.updated_at >= wk and a.updated_at < wk + interval '1 week')) as loops
       from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') wk order by wk`, [ids]),
    q(`select o.slug, o.name, o.plan_code, o.billing_status, o.billing_currency, o.billing_cycle, o.extra_seats from organizations o where o.billing_status in ('active','past_due') and ($1::uuid[] is null or o.id = any($1))`, [ids]),
  ]);
  const paying = concentration.map((o) => ({ ...o, mrrInr: toInrMinor(mrrOf(o), o.billing_currency || "INR") })).filter((o) => o.mrrInr > 0).sort((a, b) => b.mrrInr - a.mrrInr);
  const total = paying.reduce((t, o) => t + o.mrrInr, 0), share = (n) => (total ? Math.round((100 * paying.slice(0, n).reduce((t, o) => t + o.mrrInr, 0)) / total) : 0);
  const out = { adoption, byPlan, devices, cohorts: cohortTable(cohorts), activation, depth, northStar,
    revenue: { total, top1: share(1), top5: share(5), top10: share(10), largest: paying.slice(0, 5).map((o) => ({ slug: o.slug, name: o.name, mrrInr: o.mrrInr })) } };
  out.findings = findings(out);
  return out;
}

// Plain-language findings from the numbers above: each one names the evidence it rests on, never more than the data shows.
export function findings(d) {
  const f = [], a = d.activation || {};
  const pct = (n, of) => (of ? Math.round((100 * n) / of) : 0);
  if (a.orgs) {
    const steps = [["sign up → first check", a.orgs, a.checked], ["first check → first draft", a.checked, a.drafted], ["first draft → first action", a.drafted, a.acted]];
    const worst = steps.filter(([, from]) => from > 0).map(([l, from, to]) => ({ l, drop: 100 - pct(to, from), from, to })).sort((x, y) => y.drop - x.drop)[0];
    if (worst && worst.drop >= 30) f.push({ tone: "warn", title: `Biggest drop-off: ${worst.l}`, body: `${worst.drop}% of organisations stop here (${worst.to} of ${worst.from} in the last 90 days). This is the step to fix first.` });
    if (a.h_to_check != null) f.push({ tone: a.h_to_check <= 24 ? "good" : "warn", title: `Median time to first check: ${a.h_to_check < 48 ? a.h_to_check + " hours" : Math.round(a.h_to_check / 24) + " days"}`, body: `${pct(a.checked_1d, a.orgs)}% of new organisations ran a check on day one; ${pct(a.checked_7d, a.orgs)}% within a week.` });
  }
  const unused = (d.adoption || []).filter((x) => x.pct < 10 && !["landing", "auth"].includes(x.page));
  if (unused.length) f.push({ tone: "info", title: `${unused.length} page${unused.length > 1 ? "s are" : " is"} used by under 10% of active people`, body: `${unused.slice(0, 4).map((x) => x.page).join(", ")}. Either make them easier to find or stop investing in them.` });
  // The overview is where everyone lands, so "most used" means the most used page after it.
  const top = (d.adoption || []).find((x) => x.page !== "overview"); if (top) f.push({ tone: "good", title: `Most used after the overview: ${top.page}`, body: `${top.pct}% of active people opened it in the last 30 days (${top.users} people, ${top.orgs} organisations).` });
  const ret = (d.cohorts || []).filter((c) => c.weeks.length > 4 && c.size >= 3);
  if (ret.length) { const best = [...ret].sort((x, y) => y.weeks[4] - x.weeks[4])[0]; f.push({ tone: "info", title: `Week-4 retention: ${Math.round(ret.reduce((t, c) => t + c.weeks[4], 0) / ret.length)}% on average`, body: `Best cohort: week of ${best.cohort} at ${best.weeks[4]}% (${best.size} people).` }); }
  const r = d.revenue; if (r?.total && r.top5 >= 40) f.push({ tone: "warn", title: `Revenue concentration: top 5 customers are ${r.top5}% of MRR`, body: `Losing one of ${r.largest.slice(0, 3).map((x) => x.name).join(", ")} would show in the month. Watch their health scores.` });
  const ns = d.northStar || []; if (ns.length >= 4) { const now = ns.at(-2)?.loops ?? 0, before = ns.at(-6)?.loops ?? 0; f.push({ tone: now >= before ? "good" : "warn", title: `Weekly recovery loops: ${now} last week`, body: before ? `${now >= before ? "Up" : "Down"} from ${before} four weeks earlier.` : "The first full weeks of data are coming in." }); }
  const mob = (d.devices || []).find((x) => x.device === "mobile"), allU = (d.devices || []).reduce((t, x) => t + x.users, 0);
  if (mob && allU && pct(mob.users, allU) >= 15) f.push({ tone: "info", title: `${pct(mob.users, allU)}% of active people use a phone`, body: "Check the dashboard pages they open most at phone width." });
  return f;
}

// Rows of (sign-up week, person, weeks-after-sign-up they were active) → one row per cohort with the % active in week 0..7.
// Weeks that haven't happened yet are left off, so a young cohort has a shorter row.
export function cohortTable(rows, now = Date.now()) {
  const byWk = new Map();
  for (const r of rows) { const k = new Date(r.wk).getTime(); if (!byWk.has(k)) byWk.set(k, []); byWk.get(k).push(new Set(r.ks || [])); }
  return [...byWk.entries()].sort((a, b) => a[0] - b[0]).map(([wk, people]) => {
    const weeks = [];
    for (let k = 0; k < 8 && wk + k * 604800e3 <= now; k++) weeks.push(Math.round((100 * people.filter((s) => s.has(k)).length) / people.length));
    return { cohort: new Date(wk).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }), size: people.length, weeks };
  });
}
