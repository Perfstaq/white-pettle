// Billing HTTP routes: the public catalogue, an organisation's plan and usage, checkout, plan changes, cancellation, payment
// verification and the Razorpay webhook. A factory (not an import of routes.mjs) so there is no import cycle.
//
// Trust model: only Razorpay can grant access, and only two ways reach it: a webhook signed with our webhook secret, or our own
// authenticated call to Razorpay's API (syncOrg). The browser's say-so never changes a plan. A checkout creates a *pending*
// subscription; it becomes the organisation's subscription only when Razorpay confirms it was paid.
import crypto from "node:crypto";
import { q, one, tx } from "./db.mjs";
import { fail, sendJson, readBody, readJson, clientIp, redirect, origin } from "./http.mjs";
import { limited } from "./security.mjs";
import * as O from "./orgs.mjs";
import * as B from "./billing.mjs";
import * as N from "./notify.mjs";
import { PLANS, SELF_SERVE, CURRENCIES, TAX_RATE, withTax, upiAllowed, UPI_MAX_MINOR, LIMIT_METRICS, ALL_ENGINES, KNOWN_INTEGRATIONS, SCHEDULES, publicPlans, catalogueFlat, cleanPlan, savePlan, loadCatalogue, flatOf, CYCLES, cyclePrice, monthlyEquivalent, trialDaysFor } from "./plans.mjs";
import { billingConfig, client, razorpayLink, planIdFor, planOf, planMismatches, verifyWebhook, verifyPaymentSignature } from "./razorpay.mjs";

const PRICE = (code, ccy, cycle = "monthly") => monthlyEquivalent(code, ccy, cycle) ?? 0; // compared per month, so annual and monthly line up
// Columns a webhook or a sync may change. A fixed list, so event content can never name a column.
const COLUMNS = new Set(["plan_code", "billing_status", "billing_currency", "razorpay_customer_id", "razorpay_subscription_id", "razorpay_checkout_subscription_id",
  "current_period_start", "current_period_end", "grace_ends_at", "pending_plan_code", "cancel_at_period_end", "billing_event_at", "billing_cycle"]);
const MONEY_EVENTS = new Set(["subscription.activated", "subscription.charged"]);
const apply = (c, id, patch, org) => {
  const keys = Object.keys(patch || {}).filter((k) => COLUMNS.has(k) && String(patch[k]) !== String(org[k]));
  return keys.length ? c.query(`update organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [id, ...keys.map((k) => patch[k])]).then(() => keys) : Promise.resolve([]);
};

// Razorpay's subscription status -> the event our state machine understands.
const REMOTE = { active: "subscription.charged", pending: "subscription.pending", halted: "subscription.halted", paused: "subscription.paused", cancelled: "subscription.cancelled", completed: "subscription.completed", expired: "subscription.cancelled" };

// Compare one subscription with Razorpay's own record and apply what we missed. Remote state goes through the same state machine,
// stamped with the last applied event time and never moving billing_event_at, so a real webhook that was delayed still wins and a
// sync can never shorten a paid period. `promote` turns a confirmed-paid checkout into the organisation's subscription.
async function applyRemote(orgId, remote, { promote = false, cfg }) {
  let retire = null, changed = 0, before = null, saved = null;
  await tx(async (c) => {
    const org = (await c.query(`select * from organizations where id = $1 for update`, [orgId])).rows[0]; if (!org) return;
    const event = promote ? (remote.status === "authenticated" ? "subscription.authenticated" : "subscription.charged") : REMOTE[remote.status];
    let patch = {};
    if (event) {
      const stamp = org.billing_event_at ? Math.floor(new Date(org.billing_event_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
      const r = B.applyEvent(org, { event, created_at: stamp, payload: { subscription: { entity: remote } } }, { planOf, graceDays: cfg.graceDays });
      if (r.status === "processed") {
        patch = { ...r.patch }; delete patch.billing_event_at;
        // Razorpay keeps a cancel-at-cycle-end subscription "active" until the cycle ends, so remote "active" never means "not cancelling".
        if (!promote) delete patch.cancel_at_period_end;
        if (promote) { patch.razorpay_subscription_id = remote.id; patch.razorpay_checkout_subscription_id = null; if (org.razorpay_subscription_id && org.razorpay_subscription_id !== remote.id) retire = org.razorpay_subscription_id; }
      }
      // A scheduled change that no longer exists upstream (applied or withdrawn) must not linger here.
      if (!promote && remote.has_scheduled_changes === false && org.pending_plan_code) patch.pending_plan_code = null;
    }
    const keys = await apply(c, orgId, patch, org); changed = keys.length; if (keys.length) { before = org; saved = patch; }
    if (keys.length) await c.query(`insert into audit_log (org_id, action, target, detail) values ($1, $2, $3, $4)`, [orgId, promote ? "billing.payment_confirmed" : "billing.reconciled", remote.status, { changed: keys }]);
  });
  if (before) await N.billingChanged(before, saved);
  return { changed, retire };
}
// ── One-time payments (a Razorpay Payment Link for N months of a plan, no renewal) ──
// Paid: the organisation is active on that plan from now (or from the end of a month still running) for `months` calendar months, with
// no subscription, so it turns read-only when that time ends (accessMode: active without a subscription ends on its date). Usage counts
// from a fresh period. Runs inside the caller's transaction; returns { org, patch } or { ignored: reason }.
export async function activateOneTime(c, linkId, { paymentId = null, amountPaid = null, orgNote = null } = {}) {
  const link = (await c.query(`select * from payment_links where id = $1 for update`, [linkId])).rows[0];
  if (!link) return { ignored: "not one of our payment links" };
  if (link.status === "paid") return { ignored: "already applied" };
  if (!link.org_id) return { ignored: "its organisation was deleted" };
  if (orgNote && orgNote !== link.org_id) return { ignored: "organisation note doesn't match" };
  if (amountPaid != null && Number(amountPaid) < Number(link.amount_minor)) return { ignored: "paid less than the link's amount" };
  const org = (await c.query(`select * from organizations where id = $1 for update`, [link.org_id])).rows[0];
  if (!org) return { ignored: "no organisation" };
  if (org.razorpay_subscription_id && ["active", "past_due"].includes(org.billing_status)) return { ignored: "organisation pays by subscription", org };
  const now = new Date(), running = org.billing_status === "active" && !org.razorpay_subscription_id && org.current_period_end && new Date(org.current_period_end) > now && org.plan_code === link.plan_code;
  const from = running ? new Date(org.current_period_end) : now, end = new Date(from); end.setMonth(end.getMonth() + link.months);
  const patch = { plan_code: link.plan_code, billing_status: "active", billing_currency: link.currency, billing_cycle: "monthly", current_period_end: end,
    current_period_start: running ? org.current_period_start : now, grace_ends_at: null, cancel_at_period_end: false, pending_plan_code: null };
  await apply(c, org.id, patch, org);
  await c.query(`update payment_links set status = 'paid', paid_at = now(), payment_id = $2, period_end = $3 where id = $1`, [link.id, paymentId, end]);
  await c.query(`insert into audit_log (org_id, action, target, detail) values ($1, 'billing.onetime_paid', $2, $3)`,
    [org.id, link.plan_code, { link: link.id, payment: paymentId, amount: Number(link.amount_minor), currency: link.currency, until: end, extended: running }]);
  return { org, patch };
}
// Unpaid one-time links of an organisation: cancel them upstream (a new link, a subscription link, or deleting the organisation).
// `strict`: refuse when one was paid meanwhile, or when Razorpay can't be asked (the caller must not go on as if nothing was payable).
export async function cancelOpenPaymentLinks(orgId, { strict = false } = {}) {
  const open = await q(`select id from payment_links where org_id = $1 and status = 'created'`, [orgId]);
  for (const l of open) {
    let r = null;
    try { r = await client().fetchPaymentLink(l.id); } catch (e) { if (strict) fail(502, "Razorpay didn't answer about an open one-time payment link: " + String(e.message).slice(0, 120)); continue; }
    if (r.status === "paid") { if (strict) fail(409, "A one-time payment link was just paid. Sync billing first.", { code: "link_paid" }); continue; }
    if (["created", "partially_paid"].includes(r.status)) {
      try { await client().cancelPaymentLink(l.id); } catch (e) { if (strict) fail(502, "Couldn't cancel an open one-time payment link: " + String(e.message).slice(0, 120)); continue; }
    }
    await q(`update payment_links set status = $2 where id = $1 and status = 'created'`, [l.id, r.status === "expired" ? "expired" : "cancelled"]);
  }
}
// A missed payment_link.paid webhook: ask Razorpay about each open link and apply a paid one.
async function syncPaymentLinks(orgId) {
  let changed = 0;
  for (const l of await q(`select id from payment_links where org_id = $1 and status = 'created'`, [orgId])) {
    const r = await client().fetchPaymentLink(l.id);
    if (r.status === "paid") {
      const out = await tx((c) => activateOneTime(c, l.id, { paymentId: r.payments?.[0]?.payment_id || null, amountPaid: r.amount_paid }));
      if (out.patch) { changed++; await N.billingChanged(out.org, out.patch); }
    } else if (["cancelled", "expired"].includes(r.status)) await q(`update payment_links set status = $2 where id = $1 and status = 'created'`, [l.id, r.status]);
  }
  return changed;
}

export async function syncOrg(orgId, { log = console.log } = {}) {
  const cfg = billingConfig(); if (!cfg.ready) return { changed: 0 };
  const rzp = client(); let changed = await syncPaymentLinks(orgId), retire = null;
  const ids = await one(`select razorpay_subscription_id as main, razorpay_checkout_subscription_id as pending from organizations where id = $1`, [orgId]);
  if (!ids) return { changed: 0 };
  if (ids.pending) {
    const remote = await rzp.fetchSubscription(ids.pending);
    // Paid, or (during the free trial) authorised with its first charge still in the future: either way it is now the organisation's subscription.
    const trialAuth = remote.status === "authenticated" && Number(remote.start_at) * 1000 > Date.now() && (await one(`select 1 from organizations where id = $1 and (billing_status = 'trialing' or billing_status = 'active')`, [orgId]));
    if (remote.status === "active" || trialAuth) { const r = await applyRemote(orgId, remote, { promote: true, cfg }); changed += r.changed; retire = r.retire; }
    else if (["cancelled", "expired", "completed"].includes(remote.status)) await q(`update organizations set razorpay_checkout_subscription_id = null where id = $1 and razorpay_checkout_subscription_id = $2`, [orgId, ids.pending]);
  }
  const main = (await one(`select razorpay_subscription_id as s from organizations where id = $1`, [orgId]))?.s;
  if (main) { const r = await applyRemote(orgId, await rzp.fetchSubscription(main), { cfg }); changed += r.changed; }
  if (retire) await rzp.cancelSubscription(retire, { atCycleEnd: false }).catch((e) => log(`[billing] could not retire ${retire}: ${e.message}`));
  await q(`update organizations set billing_reconciled_at = now() where id = $1`, [orgId]);
  return { changed };
}
// Daily safety net (called from the scheduler tick): a small batch, each organisation at most once a day.
export async function reconcile({ limit = 20, log = console.log } = {}) {
  if (!billingConfig().ready) return { checked: 0, changed: 0 };
  // A trial that ended with a payment method connected is checked hourly until its first charge resolves: a missed webhook there would
  // otherwise lock out a customer who has paid.
  const due = await q(`select id from organizations where
      (((razorpay_subscription_id is not null and billing_status in ('active','past_due')) or razorpay_checkout_subscription_id is not null)
        and (billing_reconciled_at is null or billing_reconciled_at < now() - interval '1 day'))
      or (billing_status = 'trialing' and razorpay_subscription_id is not null and trial_ends_at < now()
        and (billing_reconciled_at is null or billing_reconciled_at < now() - interval '1 hour'))
      or (exists (select 1 from payment_links p where p.org_id = organizations.id and p.status = 'created')
        and (billing_reconciled_at is null or billing_reconciled_at < now() - interval '1 hour'))
    order by billing_reconciled_at nulls first limit $1`, [limit]);
  let changed = 0;
  for (const d of due) {
    try { changed += (await syncOrg(d.id, { log })).changed; }
    catch (e) { log(`[reconcile] ${d.id}: ${e.message}`); await q(`update organizations set billing_reconciled_at = now() where id = $1`, [d.id]).catch(() => {}); }
  }
  return { checked: due.length, changed };
}

const names = () => SELF_SERVE.map((c) => PLANS[c].name).join(", ").replace(/, ([^,]*)$/, " or $1");

// Change a paying subscription's plan: an upgrade applies now (Razorpay charges the difference), a downgrade at the end of the cycle,
// and choosing the current plan withdraws a scheduled downgrade. The plan itself only changes when Razorpay confirms. Currency is
// locked to the subscription's. Shared by the owner (self-serve plans) and the operator console (`anyPlan`: any price with a Razorpay
// plan id, e.g. Enterprise; `reason` goes in the audit log).
export async function changePlan(orgId, actorId, plan, { anyPlan = false, reason = null } = {}) {
  const org = await one(`select plan_code, billing_status, billing_currency, billing_cycle, razorpay_subscription_id, pending_plan_code, cancel_at_period_end, current_period_end from organizations where id = $1`, [orgId]);
  if (!org.razorpay_subscription_id || org.billing_status !== "active") fail(409, org.billing_status === "past_due" ? "Fix the failed payment first." : "There's no active subscription to change.", { code: "no_subscription" });
  if (org.cancel_at_period_end) fail(409, "This subscription is set to end. Subscribe again to choose a plan.", { code: "cancelling" });
  const currency = org.billing_currency, cycle = org.billing_cycle || "monthly", why = reason ? { reason } : {}; // the cycle stays the subscription's
  if (!(anyPlan ? PLANS[plan] : SELF_SERVE.includes(plan))) fail(400, `Choose ${names()}.`, { code: "bad_plan" });
  if (limited("plan-change:" + orgId, 10, 3600e3)) fail(429, "Too many changes. Try again in a bit.");
  const rzp = client();
  try {
    if (plan === org.plan_code) { // withdraw a scheduled downgrade
      if (!org.pending_plan_code) fail(400, "You're already on that plan.", { code: "same_plan" });
      await rzp.cancelScheduledChanges(org.razorpay_subscription_id);
      await q(`update organizations set pending_plan_code = null, updated_at = now() where id = $1`, [orgId]);
      await O.audit(orgId, actorId, "billing.downgrade_withdrawn", plan, why);
      return { ok: true, pendingPlan: null };
    }
    const planId = (anyPlan && (cycle === "annual" ? PLANS[plan]?.annualRazorpayIds : PLANS[plan]?.razorpayIds)?.[currency]) || planIdFor(plan, currency, cycle);
    if (!planId) fail(503, `${PLANS[plan].name} in ${currency}${cycle === "annual" ? " (annual)" : ""} isn't available yet.`, { code: "plan_unavailable" });
    const upgrade = PRICE(plan, currency, cycle) > PRICE(org.plan_code, currency, cycle);
    // Razorpay can only update card subscriptions ("You cannot update a Subscription authorised via UPI mode or Emandate").
    const viaMandate = (m) => /upi|emandate|nach/i.test(String(m || ""));
    const remote = await rzp.fetchSubscription(org.razorpay_subscription_id).catch(() => null);
    const mandate = () => fail(409, `Your plan is paid by ${/upi/i.test(remote?.payment_method || "") ? "UPI" : "bank mandate"}, which Razorpay can't change. Approve a new mandate for ${PLANS[plan].name} and it starts at your renewal.`, { code: "needs_new_mandate" });
    if (!upgrade) {
      const blockers = await B.downgradeBlockers(orgId, plan);
      if (blockers.length) fail(409, `Before moving to ${PLANS[plan].name}, reduce: ${blockers.join("; ")}.`, { code: "over_plan", blockers });
    }
    if (viaMandate(remote?.payment_method)) mandate();
    if (org.pending_plan_code) await rzp.cancelScheduledChanges(org.razorpay_subscription_id).catch(() => {});
    try { await rzp.updateSubscription(org.razorpay_subscription_id, { planId, at: upgrade ? "now" : "cycle_end" }); }
    catch (e) { if (viaMandate(e.message)) mandate(); throw e; }
    await q(`update organizations set pending_plan_code = $2, updated_at = now() where id = $1`, [orgId, upgrade ? null : plan]);
    await O.audit(orgId, actorId, upgrade ? "billing.upgrade_requested" : "billing.downgrade_scheduled", plan, { from: org.plan_code, ...why });
    if (!upgrade) void N.notify(orgId, "downgrade_scheduled", `${plan}:${new Date(org.current_period_end).toISOString().slice(0, 10)}:${Date.now()}`, { plan, from: org.plan_code, on: org.current_period_end });
    return { ok: true, upgrade, pendingPlan: upgrade ? null : plan };
  } catch (e) {
    if (e.status && !e.extra) { console.warn("[billing] change-plan:", e.message); fail(502, "The payment provider couldn't make that change just now. Nothing changed. Try again."); }
    throw e;
  }
}

// Cancel a subscription at the end of the paid period (the owner's only option). Operators may also end it now (`now`): Razorpay stops
// it at once and its cancellation webhook moves the organisation off the plan, as for any other cancellation.
export async function cancelPlan(orgId, actorId, { now = false, reason = null } = {}) {
  if (limited("cancel:" + orgId, 10, 3600e3)) fail(429, "Too many attempts. Try again in a bit.");
  const org = await one(`select plan_code, billing_status, razorpay_subscription_id, current_period_end, cancel_at_period_end from organizations where id = $1`, [orgId]);
  if (!org.razorpay_subscription_id || !["active", "past_due"].includes(org.billing_status)) fail(409, "There's no active subscription to cancel.", { code: "no_subscription" });
  if (org.cancel_at_period_end && !now) return { ok: true, until: org.current_period_end };
  try { await client().cancelSubscription(org.razorpay_subscription_id, { atCycleEnd: !now }); }
  catch (e) { console.warn("[billing] cancel:", e.message); fail(502, "The payment provider couldn't cancel just now. Nothing changed. Try again."); }
  if (now) {
    await O.audit(orgId, actorId, "billing.cancel_now_requested", PLANS[org.plan_code]?.name, { reason });
    return { ok: true, until: null };
  }
  await q(`update organizations set cancel_at_period_end = true, pending_plan_code = null, updated_at = now() where id = $1`, [orgId]);
  await O.audit(orgId, actorId, "billing.cancel_requested", PLANS[org.plan_code]?.name, { until: org.current_period_end, ...(reason ? { reason } : {}) });
  void N.notify(orgId, "cancel_scheduled", `${org.razorpay_subscription_id}:${new Date(org.current_period_end).toISOString().slice(0, 10)}`, { plan: org.plan_code, until: org.current_period_end });
  return { ok: true, until: org.current_period_end };
}

// Extra seats billed through Razorpay: one add-on on the subscription's next invoice for `seats` seats over one cycle (12 months for an
// annual plan), i.e. billed in arrears. Called when an operator adds seats and again on every renewal while the organisation has them.
// `prorate`: seats added mid-cycle pay only for what is left of the current cycle (by current_period_end), not a whole one.
// Returns what was charged, or null when there is nothing to charge.
export async function chargeSeats(orgId, { seats = null, actorId = null, reason = "renewal", prorate = false } = {}) {
  const o = await one(`select plan_code, billing_currency, billing_cycle, extra_seats, extra_seats_billing, razorpay_subscription_id, billing_status, current_period_end from organizations where id = $1`, [orgId]);
  const n = seats ?? o?.extra_seats ?? 0, ccy = o?.billing_currency || "INR", per = PLANS[o?.plan_code]?.seatPrices?.[ccy];
  if (!o || n <= 0 || o.extra_seats_billing !== "razorpay" || !o.razorpay_subscription_id || !["active", "past_due"].includes(o.billing_status) || !(per > 0)) return null;
  const months = o.billing_cycle === "annual" ? 12 : 1;
  let share = 1;
  if (prorate && o.current_period_end) { // the cycle runs from one calendar month (or year) before its end
    const end = new Date(o.current_period_end), start = new Date(end); start.setUTCMonth(start.getUTCMonth() - months);
    share = Math.min(1, Math.max(0, (end - Date.now()) / (end - start)));
  }
  const amount = withTax(Math.round(per * n * months * share), ccy);
  if (amount <= 0) return null; // the cycle is ending: the renewal charges these seats
  const label = share < 1 ? `rest of this ${months === 12 ? "year" : "month"}` : months === 12 ? "1 year" : "1 month";
  const addon = await client().createAddon(o.razorpay_subscription_id, { name: `${n} extra seat${n > 1 ? "s" : ""} (${label})`, amount, currency: ccy,
    description: `${n} × ${PLANS[o.plan_code].name} extra seat` });
  await O.audit(orgId, actorId, "billing.seats_charged", String(n), { amount, currency: ccy, months, share: Math.round(share * 1000) / 1000, addonId: addon?.id || null, reason });
  return { seats: n, amount, currency: ccy, months, share };
}

// Seats lowered after a mid-cycle raise: withdraw this cycle's raise add-ons that Razorpay hasn't invoiced yet (newest first), up to the
// seats taken away, and re-add any seats a withdrawn add-on covered beyond that. The renewal's own add-on is left alone: seats removed
// stop at the next renewal, as before. Returns { withdrawn, recharged }.
export async function withdrawSeats(orgId, { seats, actorId = null, reason = "seats lowered" }) {
  const raises = await q(`select a.id, a.target, a.detail from audit_log a join organizations o on o.id = a.org_id
      where a.org_id = $1 and a.action = 'billing.seats_charged' and a.detail->>'addonId' is not null and a.detail->>'reason' <> 'renewal'
        and not coalesce((a.detail->>'withdrawn')::boolean, false)
        and a.at > coalesce(o.current_period_end - case when o.billing_cycle = 'annual' then interval '1 year' else interval '1 month' end, '-infinity')
      order by a.at desc`, [orgId]);
  let left = seats, withdrawn = 0;
  for (const r of raises) {
    if (left <= 0) break;
    try { await client().deleteAddon(r.detail.addonId); } catch (e) { console.warn(`[billing] add-on ${r.detail.addonId} not withdrawn: ${e.message}`); break; } // already invoiced: stop
    await q(`update audit_log set detail = detail || '{"withdrawn": true}' where id = $1`, [r.id]);
    const k = Number(r.target) || 0; withdrawn += k; left -= k;
  }
  if (withdrawn) await O.audit(orgId, actorId, "billing.seats_withdrawn", String(withdrawn), { reason });
  const recharged = left < 0 ? await chargeSeats(orgId, { seats: -left, actorId, reason, prorate: true }) : null;
  return { withdrawn, recharged };
}

export function makeBillingRoutes({ needCtx, needUser }) {
  const availableAnnual = () => Object.fromEntries(SELF_SERVE.map((p) => [p, Object.fromEntries(CURRENCIES.map((c) => [c, cyclePrice(p, c, "annual") != null && !!planIdFor(p, c, "annual")]))]));
  const available = () => Object.fromEntries(SELF_SERVE.map((p) => [p, Object.fromEntries(CURRENCIES.map((c) => [c, !!planIdFor(p, c)]))]));
  // Only currencies Razorpay can actually sell (a plan id exists) are offered; USD stays hidden until Razorpay approves it.
  // Before any plan id exists (a fresh setup) every priced currency is listed, so the page isn't empty.
  const sellable = () => { const s = CURRENCIES.filter((c) => SELF_SERVE.some((p) => planIdFor(p, c))); return s.length ? s : [...CURRENCIES]; };
  function checkoutOpen(ctx) {
    const cfg = billingConfig();
    if (cfg.enabled === "0" || (cfg.enabled === "operators" && !ctx.operator)) fail(503, "Paid plans aren't open yet. Your reports and current access are unchanged.", { code: "billing_disabled" });
    if (!cfg.ready) fail(503, "Payments aren't configured on this server yet.", { code: "billing_unconfigured" });
    return cfg;
  }
  const ownerOnly = async (req) => { const ctx = await needCtx(req, "owner"); if (ctx.operatorVisit) fail(403, "Only the owner can do that."); return ctx; };
  // Create (or verify) the Razorpay plan behind one catalogue price. Shared by the per-price buttons and "sync all".
  // Create (or verify) the Razorpay plan behind one catalogue price: monthly, or annual (billed yearly) when `cycle` is "annual".
  async function rzpPlan(u, code, currency, action, cycle = "monthly") {
    const plan = PLANS[code], f = flatOf(plan), price = f.prices[currency], rzp = client(), annual = cycle === "annual";
    if (!price) fail(400, `${plan.name} has no ${currency} price yet. Add it first.`, { code: "no_price" });
    const amount = annual ? price.annualAmount : price.amount, idKey = annual ? "annualRazorpayPlanId" : "razorpayPlanId", have = price[idKey];
    const label = `${plan.name} (${currency}${annual ? ", annual" : ""})`;
    if (action === "create") {
      if (have) fail(409, `${label} already has Razorpay plan ${have}. Verify it, or clear the id first.`, { code: "has_plan_id" });
      if (!(amount > 0)) fail(400, `Set ${annual ? "an annual" : "a"} price above zero first.`, { code: "no_price" });
      // Plans can't be edited or deleted in Razorpay, so a matching one that already exists (made by hand in the dashboard) is linked
      // instead of making a duplicate. Only plans no other catalogue price uses, with the same cycle, amount and currency.
      const used = new Set(Object.values(PLANS).flatMap((x) => [...Object.values(x.razorpayIds || {}), ...Object.values(x.annualRazorpayIds || {})]));
      let rp = typeof rzp.listPlans === "function" ? (await rzp.listPlans().catch(() => ({}))).items?.find((x) => !used.has(x.id) && !planMismatches(x, { amount }, currency, cycle).length) : null;
      const adopted = !!rp;
      if (!rp) rp = await rzp.createPlan({ name: `${plan.name} (${currency} ${annual ? "yearly" : "monthly"}${TAX_RATE[currency] ? `, incl. ${TAX_RATE[currency] * 100}% GST` : ""})`.slice(0, 100),
        amount: withTax(amount, currency), currency, description: plan.description || "", period: annual ? "yearly" : "monthly" });
      const next = cleanPlan(code, { prices: { ...f.prices, [currency]: { ...price, [idKey]: rp.id } } }, f);
      await tx(async (c) => { await savePlan(c, next); }); await loadCatalogue(q);
      await O.audit(null, u.id, adopted ? "plan.razorpay_linked" : "plan.razorpay_created", code, { currency, cycle, razorpayPlanId: rp.id, amount, charged: withTax(amount, currency) });
      return { ok: true, created: !adopted, linked: adopted, razorpayPlanId: rp.id, cycle, plan: flatOf(PLANS[code]) };
    }
    if (action === "verify") {
      if (!have) fail(400, `${label} has no Razorpay plan id yet.`, { code: "no_plan_id" });
      const rp = await rzp.fetchPlan(have), mismatches = planMismatches(rp, { amount }, currency, cycle);
      return { ok: mismatches.length === 0, mismatches, cycle, razorpay: { id: rp.id, name: rp.item?.name, amount: rp.item?.amount, currency: rp.item?.currency, period: rp.period, interval: rp.interval } };
    }
    fail(400, "action must be create or verify.", { code: "bad_action" });
  }
  function rzpFail(e) {
    if (e.status && !e.extra) { console.warn("[billing] razorpay plan:", e.message); fail(502, `Razorpay said: ${String(e.message).replace(/^Razorpay \d+: /, "")}`); }
    throw e;
  }
  return [
    // Public: no ids or internal budgets. `available` says which plan + currency pairs can be bought right now.
    ["GET", "/api/billing/plans", async (req, res) => sendJson(res, 200, { plans: publicPlans(), currencies: sellable(), taxRates: TAX_RATE, upiMax: UPI_MAX_MINOR, cycles: CYCLES, available: available(), availableAnnual: availableAnnual(), trialDays: billingConfig().trialDays, open: billingConfig().enabled !== "0", contact: billingConfig().contact, trialDays: billingConfig().trialDays })],

    ["GET", "/api/billing", async (req, res) => {
      const ctx = await needCtx(req, "viewer"), cfg = billingConfig(), cap = await O.capState(ctx.org.id);
      sendJson(res, 200, { ...(await B.billingSummary(ctx.org.id, { ai: cap })), ai: { pct: cap.pct, warn: cap.warn, over: cap.over, source: cap.source },
        checkout: { enabled: cfg.enabled === "1" || (cfg.enabled === "operators" && ctx.operator), keyId: cfg.enabled === "0" ? "" : cfg.keyId, testMode: cfg.testMode }, available: available() });
    }],

    // Owner only. Creates a *pending* subscription for an internal plan + currency; the browser never sends an amount or a plan id.
    // A previous unpaid checkout is cancelled first so two payment windows can't both be paid.
    ["POST", "/api/billing/checkout", async (req, res) => {
      const ctx = await ownerOnly(req), b = await readJson(req, 5000), cfg = checkoutOpen(ctx);
      const plan = String(b.plan || ""), currency = String(b.currency || "").toUpperCase(), cycle = b.cycle === "annual" ? "annual" : "monthly";
      if (!SELF_SERVE.includes(plan)) fail(400, `Choose ${names()}. For anything else, talk to us.`, { code: "bad_plan" });
      if (!sellable().includes(currency)) fail(400, `Choose ${sellable().join(" or ")}.`, { code: "bad_currency" });
      if (cycle === "annual" && cyclePrice(plan, currency, "annual") == null) fail(400, `${PLANS[plan].name} isn't sold yearly in ${currency}.`, { code: "no_annual" });
      const planId = planIdFor(plan, currency, cycle);
      if (!planId) fail(503, `${PLANS[plan].name} in ${currency}${cycle === "annual" ? " (annual)" : ""} isn't available yet.`, { code: "plan_unavailable" });
      if (limited("checkout:" + ctx.org.id, 10, 3600e3)) fail(429, "Too many checkout attempts. Try again in a bit.");
      const org = await one(`select plan_code, billing_status, cancel_at_period_end, trial_ends_at, current_period_end, razorpay_subscription_id as main, razorpay_checkout_subscription_id as pending from organizations where id = $1`, [ctx.org.id]);
      // A paying, not-ending subscription is changed with change-plan. A past-due one may start over: Razorpay's own recovery link is
      // emailed to the customer and not always available, and the old subscription is retired once the new one is confirmed.
      // ...except a plan switch on a UPI / e-mandate subscription, which Razorpay can't update: a new mandate starts at the renewal.
      const switching = !!b.switch && org.main && org.billing_status === "active" && !org.cancel_at_period_end;
      if (org.main && org.billing_status === "active" && !org.cancel_at_period_end && !switching) fail(409, "This organisation already has a subscription. Change plan instead.", { code: "has_subscription" });
      const rzp = client();
      if (org.pending) await rzp.cancelSubscription(org.pending, { atCycleEnd: false }).catch((e) => console.warn("[billing] could not cancel the previous checkout:", e.message));
      await cancelOpenPaymentLinks(ctx.org.id); // buying a subscription withdraws an unpaid one-time link the team sent
      let sub;
      // Buying during the free trial starts the plan today: Razorpay charges now and the trial ends there. After a cancellation that is
      // still paid up the subscription starts when the paid period ends (no double charge). Within half an hour, it simply starts.
      if (switching && PRICE(plan, currency, cycle) < PRICE(org.plan_code, currency, cycle)) {
        const blockers = await B.downgradeBlockers(ctx.org.id, plan);
        if (blockers.length) fail(409, `Before moving to ${PLANS[plan].name}, reduce: ${blockers.join("; ")}.`, { code: "over_plan", blockers });
      }
      const covered = org.billing_status === "active" && (org.cancel_at_period_end || switching) ? org.current_period_end : null;
      const startAt = covered && new Date(covered).getTime() - Date.now() > 30 * 60e3 ? Math.floor(new Date(covered).getTime() / 1000) : null;
      const starts = !startAt ? "now" : org.billing_status === "trialing" ? "trial" : "resume";
      try { sub = await rzp.createSubscription({ planId, orgId: ctx.org.id, plan, cycle, startAt }); }
      catch (e) { console.warn("[billing] checkout:", e.message); fail(502, "The payment provider didn't respond. Nothing was charged. Try again."); }
      await q(`update organizations set razorpay_checkout_subscription_id = $2, updated_at = now() where id = $1`, [ctx.org.id, sub.id]);
      await O.audit(ctx.org.id, ctx.user.id, "billing.checkout_started", plan, { currency, cycle, subscription: sub.id });
      const price = cyclePrice(plan, currency, cycle);
      sendJson(res, 200, { subscriptionId: sub.id, keyId: cfg.keyId, plan, currency, cycle, amount: withTax(price, currency), upi: cycle === "monthly" && upiAllowed(price, currency), name: PLANS[plan].name, testMode: cfg.testMode, startsAt: startAt ? new Date(startAt * 1000).toISOString() : null, starts,
        callbackUrl: `${(process.env.PUBLIC_ORIGIN || origin(req)).replace(/\/$/, "")}/api/billing/callback?sub=${encodeURIComponent(sub.id)}` });
    }],

    // Pick (or switch) the plan the free trial runs on. The first pick starts the trial (one per person, see beginTrial); switching
    // afterwards only changes the plan, the window carries on untouched. Refused once a payment method is connected, because that
    // subscription is for a particular plan; connect again to change it.
    ["POST", "/api/billing/start-trial", async (req, res) => {
      const ctx = await ownerOnly(req), b = await readJson(req, 5000);
      const plan = String(b.plan || "");
      // No plan: start the default free trial on an organisation still waiting on a plan (made before the trial began at sign-up).
      if (!plan) {
        if ((await one(`select billing_status from organizations where id = $1`, [ctx.org.id])).billing_status !== "new") fail(409, "Your free trial isn't waiting to start.", { code: "not_new" });
        const ends = await B.startDefaultTrial(ctx.org.id, ctx.user.id, billingConfig().trialDays);
        if (ends) void N.notify(ctx.org.id, "trial_started", "trial", { plan: "trial", ends });
        return sendJson(res, 200, await B.billingSummary(ctx.org.id));
      }
      if (!SELF_SERVE.includes(plan)) fail(400, `Choose ${names()}.`, { code: "bad_plan" });
      const days = trialDaysFor(plan, billingConfig().trialDays);
      if (days === 0) fail(409, `${PLANS[plan].name} has no free trial. Subscribe to start it.`, { code: "no_trial" });
      let org = await one(`select plan_code, billing_status, razorpay_subscription_id, trial_started_at, trial_ends_at from organizations where id = $1`, [ctx.org.id]);
      const fresh = org.billing_status === "new";
      if (fresh) { await B.beginTrial(ctx.org.id, ctx.user.id, days); org = { ...org, billing_status: "trialing" }; }
      if (org.billing_status !== "trialing") fail(409, "Your free trial isn't running. Choose a plan to subscribe instead.", { code: "not_trialing" });
      if (org.razorpay_subscription_id) fail(409, "A payment method is connected to " + (PLANS[org.plan_code]?.name || "your plan") + ". Connect again on the plan you want, or remove it first.", { code: "has_payment_method" });
      await q(`update organizations set plan_code = $2, updated_at = now() where id = $1`, [ctx.org.id, plan]);
      // A plan with a longer trial stretches the running trial to its length (from when the trial started); a shorter one never cuts it.
      if (!fresh && org.trial_started_at) {
        const longer = new Date(new Date(org.trial_started_at).getTime() + days * 864e5);
        if (longer > new Date(org.trial_ends_at)) {
          await q(`update organizations set trial_ends_at = $2 where id = $1`, [ctx.org.id, longer]);
          await q(`update users set trial_ends_at = greatest(trial_ends_at, $2) where id = $1`, [ctx.user.id, longer]);
          await O.audit(ctx.org.id, ctx.user.id, "billing.trial_extended", plan, { to: longer, days });
        }
      }
      if (org.plan_code !== plan) await O.audit(ctx.org.id, ctx.user.id, "billing.trial_plan_chosen", plan, { from: org.plan_code });
      const sum = await B.billingSummary(ctx.org.id);
      if (fresh) void N.notify(ctx.org.id, "trial_started", "trial", { plan, ends: sum.trialEndsAt });
      sendJson(res, 200, sum);
    }],

    // Disconnect the payment method during the trial: the subscription is cancelled upstream (nothing has been charged) and the trial carries on.
    ["POST", "/api/billing/remove-payment-method", async (req, res) => {
      const ctx = await ownerOnly(req);
      const org = await one(`select billing_status, razorpay_subscription_id as main, razorpay_checkout_subscription_id as pending from organizations where id = $1`, [ctx.org.id]);
      if (org.billing_status !== "trialing" || !org.main) fail(409, "There's no payment method to remove. To end a subscription, cancel it instead.", { code: "no_payment_method" });
      const rzp = client();
      try { await rzp.cancelSubscription(org.main, { atCycleEnd: false }); }
      catch (e) { console.warn("[billing] remove payment method:", e.message); fail(502, "The payment provider couldn't remove it just now. Nothing changed. Try again."); }
      if (org.pending) await rzp.cancelSubscription(org.pending, { atCycleEnd: false }).catch(() => {});
      await q(`update organizations set razorpay_subscription_id = null, razorpay_checkout_subscription_id = null, updated_at = now() where id = $1`, [ctx.org.id]);
      await O.audit(ctx.org.id, ctx.user.id, "billing.payment_method_removed", org.main);
      sendJson(res, 200, { ...(await B.billingSummary(ctx.org.id)) });
    }],

    // End the free trial now. Nothing has been charged: a connected payment method is cancelled upstream, the person's one trial is
    // spent, and the organisation waits on 'new' (read-only, reports readable) until its owner subscribes.
    ["POST", "/api/billing/cancel-trial", async (req, res) => {
      const ctx = await ownerOnly(req);
      if (limited("cancel:" + ctx.org.id, 10, 3600e3)) fail(429, "Too many attempts. Try again in a bit.");
      const org = await one(`select plan_code, billing_status, razorpay_subscription_id as main, razorpay_checkout_subscription_id as pending from organizations where id = $1`, [ctx.org.id]);
      if (org.billing_status !== "trialing") fail(409, "There's no free trial running to cancel.", { code: "not_trialing" });
      const rzp = (org.main || org.pending) ? client() : null;
      if (org.main) {
        try { await rzp.cancelSubscription(org.main, { atCycleEnd: false }); }
        catch (e) { console.warn("[billing] cancel trial:", e.message); fail(502, "The payment provider couldn't cancel just now. Nothing changed. Try again."); }
      }
      if (org.pending) await rzp.cancelSubscription(org.pending, { atCycleEnd: false }).catch(() => {});
      await tx(async (c) => {
        await c.query(`update organizations set billing_status = 'new', plan_code = 'trial', trial_ends_at = now(), razorpay_subscription_id = null, razorpay_checkout_subscription_id = null,
                       pending_plan_code = null, updated_at = now() where id = $1`, [ctx.org.id]);
        await c.query(`update users set trial_ends_at = least(trial_ends_at, now()) where id = $1`, [ctx.user.id]);
      });
      await O.audit(ctx.org.id, ctx.user.id, "billing.trial_cancelled", PLANS[org.plan_code]?.name, { paymentMethod: !!org.main });
      void N.notify(ctx.org.id, "trial_cancelled", "trial");
      sendJson(res, 200, { ...(await B.billingSummary(ctx.org.id)) });
    }],

    // The checkout window's success callback. The signature proves the payment is genuine (and ours); the plan itself comes from
    // asking Razorpay, never from this request. The webhook usually gets there first or right after; both are idempotent.
    ["POST", "/api/billing/verify", async (req, res) => {
      const ctx = await ownerOnly(req), b = await readJson(req, 5000), cfg = billingConfig();
      if (!cfg.ready) fail(503, "Payments aren't configured on this server yet.", { code: "billing_unconfigured" });
      if (limited("verify:" + ctx.org.id, 20, 3600e3)) fail(429, "Too many attempts. Try again in a bit.");
      const org = await one(`select razorpay_subscription_id as main, razorpay_checkout_subscription_id as pending from organizations where id = $1`, [ctx.org.id]);
      const sid = String(b.razorpay_subscription_id || "");
      if (!sid || ![org.main, org.pending].includes(sid)) fail(400, "That payment doesn't match this organisation's subscription.", { code: "bad_subscription" });
      if (!verifyPaymentSignature(String(b.razorpay_payment_id || ""), sid, String(b.razorpay_signature || ""), cfg.keySecret)) fail(400, "We couldn't verify that payment. If you were charged, your plan updates once Razorpay confirms it.", { code: "bad_signature" });
      let synced = true; try { await syncOrg(ctx.org.id); } catch (e) { synced = false; console.warn("[billing] verify sync:", e.message); }
      await O.audit(ctx.org.id, ctx.user.id, "billing.payment_verified", sid);
      sendJson(res, 200, { verified: true, synced, ...(await B.billingSummary(ctx.org.id)) });
    }],

    // Razorpay's full-page checkout posts back here (a cross-site form POST, so the session cookie isn't sent). The signature alone
    // proves the payment is genuine and for this subscription; the plan still comes from asking Razorpay. Then back into the app.
    ["POST", "/api/billing/callback", async (req, res, p, url) => {
      const cfg = billingConfig(); if (!cfg.ready) return redirect(res, "/?billing=failed");
      if (limited("rzp-cb:" + clientIp(req), 30, 600e3)) return redirect(res, "/?billing=failed");
      const f = new URLSearchParams((await readBody(req, 20000)).toString("utf8"));
      const sid = String(f.get("razorpay_subscription_id") || url.searchParams.get("sub") || ""), pid = String(f.get("razorpay_payment_id") || "");
      if (!pid) return redirect(res, `/?billing=failed&why=${encodeURIComponent(String(f.get("error[description]") || "").slice(0, 160))}`);
      if (!/^sub_[A-Za-z0-9]{6,40}$/.test(sid) || !verifyPaymentSignature(pid, sid, String(f.get("razorpay_signature") || ""), cfg.keySecret)) return redirect(res, "/?billing=failed&why=unverified");
      const org = await one(`select id from organizations where razorpay_subscription_id = $1 or razorpay_checkout_subscription_id = $1`, [sid]);
      if (org) { try { await syncOrg(org.id); } catch (e) { console.warn("[billing] callback sync:", e.message); } await O.audit(org.id, null, "billing.payment_verified", sid); }
      redirect(res, "/?billing=ok");
    }],

    // "Check with Razorpay now": the same sync the daily job does, for one organisation, so an upgrade, downgrade or payment shows
    // up immediately instead of waiting for the webhook. Owner only and rate limited.
    ["POST", "/api/billing/refresh", async (req, res) => {
      const ctx = await ownerOnly(req);
      if (!billingConfig().ready) fail(503, "Payments aren't configured on this server yet.", { code: "billing_unconfigured" });
      if (limited("refresh:" + ctx.org.id, 30, 3600e3)) fail(429, "Too many refreshes. Try again in a bit.");
      let synced = true; try { await syncOrg(ctx.org.id); } catch (e) { synced = false; console.warn("[billing] refresh:", e.message); }
      sendJson(res, 200, { synced, ...(await B.billingSummary(ctx.org.id)) });
    }],

    // A plain-language timeline of what happened to this organisation's plan, for its owner and admins.
    ["GET", "/api/billing/history", async (req, res) => {
      const ctx = await needCtx(req, "admin");
      const rows = await q(`select a.at, a.action, a.target, a.detail, u.email as who from audit_log a left join users u on u.id = a.user_id where a.org_id = $1 and a.action like 'billing.%' order by a.at desc limit 40`, [ctx.org.id]);
      sendJson(res, 200, { events: rows });
    }],

    // Operators only: the plan catalogue. Reads and writes the database tables; the live view reloads at once on this instance and
    // within seconds on the others.
    ["GET", "/api/admin/plans", async (req, res) => {
      const u = await O.needBillingAdmin(await needUser(req));
      const counts = Object.fromEntries((await q(`select plan_code, count(*)::int as n from organizations group by 1`)).map((r) => [r.plan_code, r.n]));
      sendJson(res, 200, { plans: catalogueFlat(), organisations: counts, options: { limits: LIMIT_METRICS, engines: ALL_ENGINES, integrations: KNOWN_INTEGRATIONS, schedules: SCHEDULES } });
    }],
    ["PUT", "/api/admin/plans/:code", async (req, res, p) => {
      const u = await O.needBillingAdmin(await needUser(req));
      const b = await readJson(req, 20000), code = String(p.code);
      const before = PLANS[code] ? flatOf(PLANS[code]) : null;
      const f = cleanPlan(code, b, before);
      if (["legacy", "trial"].includes(code) && (f.public || f.selfServe || f.featured || !f.active)) fail(400, `${PLANS[code].name} is a built-in plan: it can't be public, bought, featured or switched off.`, { code: "bad_plan_input" });
      if (before && before.active && !f.active && (await one(`select 1 from organizations where plan_code = $1 and billing_status in ('active','past_due') limit 1`, [code]))) fail(409, "Organisations are paying on this plan. Move them first, or leave it active and uncheck 'public'.", { code: "plan_in_use" });
      // A Razorpay plan id that changed is checked against Razorpay itself: wrong amount, currency or cycle would charge customers the
      // wrong thing. Skipped when the keys aren't configured; a network failure doesn't block the save, a mismatch does.
      if (billingConfig().ready) for (const [ccy, v] of Object.entries(f.prices)) {
        if (!v.razorpayPlanId || v.razorpayPlanId === before?.prices?.[ccy]?.razorpayPlanId) continue;
        let rp; try { const c = client(); if (typeof c.fetchPlan !== "function") continue; rp = await c.fetchPlan(v.razorpayPlanId); } catch (e) { if ((e.status === 400 || e.status === 404) && /invalid or could not be found|does not exist|not found/i.test(e.message)) fail(400, `Razorpay doesn't know the plan ${v.razorpayPlanId} (${ccy}). Check the id, and that it was created with the same keys.`, { code: "bad_plan_input" }); continue; }
        const bad = planMismatches(rp, v, ccy); if (bad.length) fail(400, `Razorpay plan ${v.razorpayPlanId} doesn't match the ${ccy} price: ${bad.join("; ")}.`, { code: "bad_plan_input" });
      }
      await tx(async (c) => { await savePlan(c, f); });
      await loadCatalogue(q);
      await O.audit(null, u.id, "plan.catalogue_edited", code, { before, after: f });
      sendJson(res, 200, { plan: flatOf(PLANS[code]) });
    }],

    // Delete a plan nobody is on. A plan with organisations (or one scheduled to move onto it) is archived instead (active: false), so
    // existing customers and their Razorpay subscriptions keep resolving. Razorpay plans can't be deleted; an unused one is harmless.
    ["DELETE", "/api/admin/plans/:code", async (req, res, p) => {
      const u = await O.needBillingAdmin(await needUser(req)), code = String(p.code);
      if (!PLANS[code]) fail(404, "Unknown plan.");
      if (["legacy", "trial"].includes(code)) fail(400, `${PLANS[code].name} is built in and can't be deleted.`, { code: "built_in" });
      const using = await one(`select count(*)::int as n from organizations where plan_code = $1 or pending_plan_code = $1`, [code]);
      if (using.n) fail(409, `${using.n} organisation(s) are on ${PLANS[code].name} or moving to it. Archive it instead (untick Active).`, { code: "in_use", organisations: using.n });
      const before = flatOf(PLANS[code]);
      await q(`delete from plans where code = $1`, [code]);
      await loadCatalogue(q);
      await O.audit(null, u.id, "plan.catalogue_deleted", code, { before });
      sendJson(res, 200, { ok: true, razorpayPlans: Object.values(before.prices).map((x) => x.razorpayPlanId).filter(Boolean) });
    }],

    // Create the Razorpay plan for a catalogue price (Razorpay's step 2 via API), or verify the id already stored against Razorpay.
    ["POST", "/api/admin/plans/:code/razorpay", async (req, res, p) => {
      const u = await O.needBillingAdmin(await needUser(req));
      const b = await readJson(req, 2000), code = String(p.code), currency = String(b.currency || "").toUpperCase(), action = String(b.action || ""), cycle = b.cycle === "annual" ? "annual" : "monthly";
      const plan = PLANS[code]; if (!plan) fail(404, "Unknown plan.");
      const f = flatOf(plan), price = f.prices[currency];
      if (!price) fail(400, `${plan.name} has no ${currency} price yet. Add it first.`, { code: "no_price" });
      if (!billingConfig().ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
      if (limited("rzp-plan:" + u.id, 30, 3600e3)) fail(429, "Too many requests. Try again in a bit.");
      try { sendJson(res, 200, await rzpPlan(u, code, currency, action, cycle)); }
      catch (e) { rzpFail(e); }
    }],

    // Operators only: create (or verify) every self-serve plan's Razorpay plan in one go, one row per plan and currency.
    // A row that fails (say USD isn't enabled on the account yet) doesn't stop the others.
    ["POST", "/api/admin/billing/sync-plans", async (req, res) => {
      const u = await O.needBillingAdmin(await needUser(req));
      const b = await readJson(req, 2000), action = b.action === "verify" ? "verify" : "create";
      if (!billingConfig().ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
      if (limited("rzp-sync:" + u.id, 10, 3600e3)) fail(429, "Too many requests. Try again in a bit.");
      const rows = [];
      for (const code of SELF_SERVE) for (const [ccy, p0] of Object.entries(flatOf(PLANS[code]).prices)) for (const cycle of CYCLES) {
        const v = cycle === "annual" ? { amount: p0.annualAmount, razorpayPlanId: p0.annualRazorpayPlanId } : p0;
        if (!(v.amount > 0)) continue;
        const row = { plan: code, currency: ccy, cycle };
        if (action === "create" && v.razorpayPlanId) { rows.push({ ...row, status: "exists", razorpayPlanId: v.razorpayPlanId }); continue; }
        if (action === "verify" && !v.razorpayPlanId) { rows.push({ ...row, status: "missing" }); continue; }
        try { const r = await rzpPlan(u, code, ccy, action, cycle); rows.push({ ...row, status: action === "create" ? (r.linked ? "linked" : "created") : r.ok ? "ok" : "mismatch", razorpayPlanId: r.razorpayPlanId || v.razorpayPlanId, detail: r.mismatches?.join("; ") || undefined }); }
        catch (e) { rows.push({ ...row, status: "error", detail: e.message }); }
      }
      sendJson(res, 200, { action, rows });
    }],

    // Operators only: is the billing system set up and healthy? Everything here is read from our own config and database; nothing
    // calls Razorpay, so it is safe to open as often as you like.
    ["GET", "/api/admin/billing/status", async (req, res) => {
      const u = await O.needBillingAdmin(await needUser(req));
      const cfg = billingConfig(), origin = process.env.PUBLIC_ORIGIN || "";
      const prices = SELF_SERVE.flatMap((code) => Object.entries(flatOf(PLANS[code]).prices).flatMap(([currency, v]) => [
        ...(v.amount > 0 ? [{ plan: code, name: PLANS[code].name, currency, cycle: "monthly", amount: v.amount, charged: withTax(v.amount, currency), razorpayPlanId: v.razorpayPlanId || null }] : []),
        ...(v.annualAmount > 0 ? [{ plan: code, name: PLANS[code].name, currency, cycle: "annual", amount: v.annualAmount, charged: withTax(v.annualAmount, currency), razorpayPlanId: v.annualRazorpayPlanId || null }] : [])]));
      const missing = prices.filter((r) => !r.razorpayPlanId);
      const ev = await one(`select max(received_at) as last, count(*) filter (where received_at > now() - interval '1 day')::int as day, count(*) filter (where status = 'failed' and received_at > now() - interval '1 day')::int as failed from billing_events`);
      const lastFail = await one(`select event_type, error, received_at from billing_events where status = 'failed' order by received_at desc limit 1`);
      const orgs = Object.fromEntries((await q(`select billing_status, count(*)::int as n from organizations group by 1`)).map((r) => [r.billing_status, r.n]));
      const soon = (await one(`select count(*)::int as n from organizations where billing_status = 'trialing' and trial_ends_at < now() + interval '2 days'`)).n;
      const stale = (await one(`select count(*)::int as n from organizations where razorpay_subscription_id is not null and billing_status in ('active','past_due') and (billing_reconciled_at is null or billing_reconciled_at < now() - interval '2 days')`)).n;
      const C = (ok, label, fix, level = "error") => ({ ok, label, level: ok ? "ok" : level, fix: ok ? null : fix });
      const checks = [
        C(cfg.enabled !== "0", `Billing switch is ${cfg.enabled === "0" ? "off (0)" : cfg.enabled === "operators" ? "on for operators only" : "on for everyone"}`, "Set BILLING_ENABLED to operators, then 1, when you are ready to take payments.", "warn"),
        C(!!(cfg.keyId && cfg.keySecret), "Razorpay key id and secret are set", "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."),
        C(!!cfg.webhookSecret, "Webhook secret is set", "Create the webhook in Razorpay, then set RAZORPAY_WEBHOOK_SECRET to its secret. Without it no payment can update an account."),
        C(/^https:\/\//.test(origin), `Public address is ${origin || "not set"}`, "Set PUBLIC_ORIGIN to the https address Razorpay can reach.", "warn"),
        C(!missing.length, missing.length ? `${missing.length} of ${prices.length} prices have no Razorpay plan` : `All ${prices.length} prices have a Razorpay plan`, "Use \"Create missing Razorpay plans\" below."),
        C(!ev.failed, ev.failed ? `${ev.failed} webhook event(s) failed in the last 24 hours` : "No failed webhook events in the last 24 hours", `Latest: ${lastFail?.event_type || ""} ${lastFail?.error || ""}`.trim()),
        C(!!ev.last || !cfg.ready, ev.last ? "Razorpay has sent webhooks" : "No webhook has ever arrived", "Add the webhook URL in Razorpay (Settings, Webhooks) with the subscription events ticked.", "warn"),
        C(!stale, stale ? `${stale} paying organisation(s) not checked against Razorpay for 2+ days` : "Daily check against Razorpay is keeping up", "Make sure the scheduler calls /api/cron/tick at least daily.", "warn"),
        C(!(orgs.past_due > 0), orgs.past_due ? `${orgs.past_due} organisation(s) have a failed payment` : "No failed payments", "Open Account for the organisation; Razorpay is retrying the charge.", "warn"),
      ];
      sendJson(res, 200, { enabled: cfg.enabled, razorpay: { keyId: cfg.keyId ? cfg.keyId.slice(0, 12) + "…" : null, mode: !cfg.keyId ? null : cfg.testMode ? "test" : "live" },
        webhookUrl: origin ? origin.replace(/\/$/, "") + "/api/webhooks/razorpay" : null, prices, webhooks: { last: ev.last, last24h: ev.day, failed24h: ev.failed }, orgs, trialsEndingSoon: soon, checks });
    }],

    // Razorpay emails the customer a recovery link when a charge fails; the subscription's own short_url is sometimes available too.
    ["GET", "/api/billing/payment-link", async (req, res) => {
      const ctx = await ownerOnly(req);
      if (limited("paylink:" + ctx.org.id, 20, 3600e3)) fail(429, "Too many requests. Try again in a bit.");
      const sid = (await one(`select razorpay_subscription_id as s from organizations where id = $1`, [ctx.org.id]))?.s;
      if (!sid) return sendJson(res, 200, { url: null });
      try { const s = await client().fetchSubscription(sid); sendJson(res, 200, { url: razorpayLink(s.short_url), status: s.status }); }
      catch (e) { console.warn("[billing] payment-link:", e.message); sendJson(res, 200, { url: null }); }
    }],

    // Upgrade now (Razorpay charges the difference), downgrade at the end of the cycle, or withdraw a scheduled downgrade
    // by choosing the current plan. The plan itself only changes when Razorpay confirms. Currency is locked to the subscription's.
    ["POST", "/api/billing/change-plan", async (req, res) => {
      const ctx = await ownerOnly(req), b = await readJson(req, 5000);
      checkoutOpen(ctx);
      sendJson(res, 200, await changePlan(ctx.org.id, ctx.user.id, String(b.plan || "")));
    }],
    ["POST", "/api/billing/cancel", async (req, res) => {
      const ctx = await ownerOnly(req);
      sendJson(res, 200, await cancelPlan(ctx.org.id, ctx.user.id));
    }],

    // Razorpay -> us. The signature is checked on the exact bytes; the event id makes processing idempotent.
    ["POST", "/api/webhooks/razorpay", async (req, res) => {
      const cfg = billingConfig();
      if (!cfg.webhookSecret) fail(503, "Webhooks aren't configured.");
      const raw = await readBody(req, 1024 * 1024);
      if (!verifyWebhook(raw, req.headers["x-razorpay-signature"], cfg.webhookSecret)) {
        if (limited("hook-bad:" + clientIp(req), 20, 60e3)) fail(429, "Too many bad requests.");
        fail(401, "Bad signature.");
      }
      let evt; try { evt = JSON.parse(raw.toString("utf8")); } catch { fail(400, "Not JSON."); }
      const eventId = String(req.headers["x-razorpay-event-id"] || "").slice(0, 100) || "sha256:" + crypto.createHash("sha256").update(raw).digest("hex");
      const summary = B.eventSummary(evt), evtName = String(evt.event || "unknown").slice(0, 80);
      try {
        const out = await tx(async (c) => {
          const row = (await c.query(`insert into billing_events (event_id, event_type, status, payload) values ($1, $2, 'received', $3)
            on conflict (event_id) do update set received_at = now(), error = null where billing_events.status = 'failed' returning event_id`, [eventId, evtName, summary])).rows[0];
          if (!row) return { duplicate: true };
          const sub = evt.payload?.subscription?.entity, sid = sub?.id;
          const ignore = async (reason, orgId = null, extra = {}) => {
            await c.query(`update billing_events set status = 'ignored', org_id = $2, processed_at = now(), error = $3 where event_id = $1`, [eventId, orgId, reason]);
            return { ignored: true, status: "ignored", reason, money: MONEY_EVENTS.has(evt.event) || evt.event === "payment_link.paid", sid: sid || evt.payload?.payment_link?.entity?.id, ...extra };
          };
          // One-time payment links: paid -> the plan for its months; cancelled / expired -> just the link's state.
          if (String(evt.event).startsWith("payment_link.")) {
            const pl = evt.payload?.payment_link?.entity;
            if (!pl?.id) return ignore("no payment link in the event");
            if (evt.event !== "payment_link.paid") {
              if (["payment_link.cancelled", "payment_link.expired"].includes(evt.event)) await c.query(`update payment_links set status = $2 where id = $1 and status = 'created'`, [pl.id, evt.event.split(".")[1]]);
              return ignore("payment link " + evt.event.split(".")[1]);
            }
            const r = await activateOneTime(c, pl.id, { paymentId: evt.payload?.payment?.entity?.id || null, amountPaid: pl.amount_paid ?? evt.payload?.payment?.entity?.amount, orgNote: pl.notes?.white_petal_org_id || null });
            if (r.ignored) return ignore(r.ignored, r.org?.id || null);
            await c.query(`update billing_events set status = 'processed', org_id = $2, processed_at = now() where event_id = $1`, [eventId, r.org.id]);
            return { status: "processed", org: r.org, patch: r.patch, oneTime: true };
          }
          let org = sid ? (await c.query(`select * from organizations where razorpay_subscription_id = $1 or razorpay_checkout_subscription_id = $1 for update`, [sid])).rows[0] : null;
          // Our own note on the subscription is a fallback for an event that beats the checkout write.
          if (!org && sid && /^[0-9a-f-]{36}$/i.test(String(sub?.notes?.white_petal_org_id || ""))) org = (await c.query(`select * from organizations where id = $1 for update`, [sub.notes.white_petal_org_id])).rows[0];
          if (!org) return ignore("no organisation for this subscription");
          // A subscription that is not (yet) the organisation's own can only become it by being paid; anything else about it waits.
          const adopting = !!sid && org.razorpay_subscription_id !== sid;
          if (adopting) {
            // Authorised but not yet charged counts only while the time is already covered: a trial, or a cancelled period still paid up
            // (then only when the new subscription starts in the future; one that charges at once is adopted on that charge).
            // A subscription that charges at once (bought or sent during a trial) is adopted on that charge, not on the card's authorisation.
            const waiting = ["trialing", "active"].includes(org.billing_status) && Number(sub?.start_at) * 1000 > Date.now();
            if (!MONEY_EVENTS.has(evt.event) && !(evt.event === "subscription.authenticated" && waiting)) return ignore("subscription not confirmed yet", org.id);
            // A second subscription was paid while one is already active: stop it recurring (a refund is for a person to decide).
            if (MONEY_EVENTS.has(evt.event) && org.razorpay_subscription_id && org.billing_status === "active" && !org.cancel_at_period_end) return ignore("organisation already has an active subscription", org.id, { retire: sid });
          }
          const r = B.applyEvent(org, evt, { planOf, graceDays: cfg.graceDays });
          const patch = { ...(r.patch || {}) }; let retire = null;
          if (adopting && r.status === "processed") {
            patch.razorpay_subscription_id = sid;
            if (org.razorpay_checkout_subscription_id === sid) patch.razorpay_checkout_subscription_id = null;
            if (org.razorpay_subscription_id) retire = org.razorpay_subscription_id;
          }
          if (r.status !== "processed") return ignore(r.reason, org.id);
          await apply(c, org.id, patch, org);
          await c.query(`update billing_events set status = 'processed', org_id = $2, processed_at = now() where event_id = $1`, [eventId, org.id]);
          return { status: "processed", org, patch, retire };
        });
        if (out.money) console.error(`[billing] ALERT: ${evtName} for ${out.sid} was not applied (${out.reason}). Money may have moved; check billing_events.`);
        if (out.patch && !out.oneTime && (out.patch.plan_code || out.patch.billing_status)) await O.audit(out.org.id, null, "billing." + String(evt.event).replace("subscription.", ""), out.patch.plan_code || out.org.plan_code, { from: { plan: out.org.plan_code, status: out.org.billing_status }, to: { plan: out.patch.plan_code || out.org.plan_code, status: out.patch.billing_status || out.org.billing_status } });
        if (out.patch && out.org) void N.billingChanged(out.org, out.patch);
        // A renewal was paid: put this cycle's extra seats on the next invoice. A failure here is logged, never fails the webhook.
        if (out.patch && out.org && evt.event === "subscription.charged") await chargeSeats(out.org.id).catch((e) => console.error(`[billing] ALERT: extra seats not charged for ${out.org.id}: ${e.message}`));
        // The subscription this one replaced is cancelled upstream, so the customer can't be billed twice.
        if (out.retire) await client().cancelSubscription(out.retire, { atCycleEnd: false }).catch((e) => console.warn(`[billing] could not retire ${out.retire}: ${e.message}`));
        sendJson(res, 200, { ok: true, ...(out.duplicate ? { duplicate: true } : {}), ...(out.ignored ? { ignored: true } : {}), ...(out.status ? { status: out.status } : {}) });
      } catch (e) {
        console.error("[billing] webhook failed:", eventId, e.message);
        // Recorded outside the rolled-back transaction, so a retry can claim it; a 500 makes Razorpay retry.
        await q(`insert into billing_events (event_id, event_type, status, payload, error) values ($1, $2, 'failed', $3, $4)
                 on conflict (event_id) do update set status = 'failed', error = excluded.error`, [eventId, evtName, summary, String(e.message).slice(0, 300)]).catch(() => {});
        fail(500, "Couldn't process the event; it will be retried.");
      }
    }],
  ];
}
