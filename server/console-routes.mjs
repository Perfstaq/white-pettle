// Command Deck: the operator console API (docs/founder-console-plan.md). A factory, like billing-routes.mjs, so there is no import cycle.
// Every route answers 404 to anyone who is not an operator, so the console's existence isn't revealed.
import { q, one, tx } from "./db.mjs";
import { fail, sendJson, readJson, origin } from "./http.mjs";
import { normEmail, emailOk } from "./util.mjs";
import * as B from "./billing.mjs";
import * as mail from "./mail.mjs";
import { limited } from "./security.mjs";
import * as O from "./orgs.mjs";
import * as C from "./console.mjs";
import * as F from "./console-founder.mjs";
import { PLANS, withTax, LIMIT_METRICS } from "./plans.mjs";
import { billingConfig, client, razorpayLink, planIdFor } from "./razorpay.mjs";
import { syncOrg, changePlan, cancelPlan, chargeSeats, withdrawSeats, cancelOpenPaymentLinks } from "./billing-routes.mjs";

export const CONSOLE_ROLES = ["founder", "finance", "support", "analyst"];

export const consoleRole = O.consoleRole;

// What deleting one person would do, and what stops it.
async function userDeletion(id, actor) {
  if (!/^[0-9a-f-]{36}$/.test(id)) fail(404, "No such person.");
  const u = await one(`select id, email, name from users where id = $1`, [id]);
  if (!u) fail(404, "No such person.");
  const orgs = await q(`select o.id, o.slug, o.name, m.role, o.billing_status, o.razorpay_subscription_id, o.razorpay_checkout_subscription_id as pending,
      (select count(*)::int from memberships x where x.org_id = o.id) as members, (select count(*)::int from workspaces w where w.org_id = o.id and w.parent_id is null) as brands
    from memberships m join organizations o on o.id = m.org_id where m.user_id = $1 order by o.name`, [id]);
  const blockers = [];
  if (u.id === actor.id) blockers.push("You can't delete yourself.");
  if (O.operators().includes(normEmail(u.email))) blockers.push("This person is a founder (PLATFORM_OPERATORS); remove them there first.");
  const out = orgs.map((o) => {
    const alone = o.members === 1, live = !!o.razorpay_subscription_id && ["active", "past_due", "trialing"].includes(o.billing_status);
    if (o.role === "owner" && !alone) blockers.push(`They own ${o.name}, which has ${o.members - 1} other ${o.members === 2 ? "person" : "people"}: hand ownership over first.`);
    if (alone && live) blockers.push(`${o.name} pays through Razorpay: cancel its subscription first.`);
    return { id: o.id, slug: o.slug, name: o.name, role: o.role, members: o.members, brands: o.brands, deleted: alone, pending: o.pending };
  });
  return { id: u.id, email: u.email, name: u.name, orgs: out, blockers };
}

// Analysts see numbers, not people: who someone is (emails, a person's name, who did or was sent something) and what operators wrote
// about them are blanked, and so is any other string that holds an email address (audit targets, invite lines).
const PERSON_KEYS = ["owner", "email", "who", "by", "invited_by", "to", "sentTo", "ownerEmail", "body"], HAS_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const redact = (role, v) => role !== "analyst" ? v : JSON.parse(JSON.stringify(v, function (k, x) {
  if (typeof x !== "string") return x;
  if (PERSON_KEYS.includes(k) || HAS_EMAIL.test(x) || (k === "name" && typeof this.email === "string")) return "•••"; // a name next to an email is a person's
  return x;
}));

// A Razorpay link an operator or checkout left on an organisation stays payable for days; before the organisation goes, withdraw it,
// so nobody can pay into an organisation that no longer exists. A link already paid (webhook not yet seen) stops the deletion.
async function withdrawPendingLink(orgId, subscriptionId) {
  if ((await one(`select 1 from payment_links where org_id = $1 and status = 'created' limit 1`, [orgId]))) {
    if (!billingConfig().ready) fail(409, "This organisation has an unpaid one-time payment link, and Razorpay keys aren't configured here to cancel it.", { code: "pending_link" });
    await cancelOpenPaymentLinks(orgId, { strict: true });
  }
  if (!subscriptionId) return;
  if (!billingConfig().ready) fail(409, "This organisation has an unpaid Razorpay link, and Razorpay keys aren't configured here to withdraw it.", { code: "pending_link" });
  let s; try { s = await client().fetchSubscription(subscriptionId); } catch (e) { fail(502, "Razorpay didn't answer about this organisation's payment link: " + String(e.message).slice(0, 120)); }
  if (["active", "pending", "halted"].includes(s.status)) fail(409, "This organisation's payment link was just paid. Sync billing, then cancel the subscription first.", { code: "has_subscription" });
  if (["created", "authenticated"].includes(s.status)) {
    try { await client().cancelSubscription(subscriptionId, { atCycleEnd: false }); } catch (e) { fail(502, "Couldn't withdraw this organisation's payment link: " + String(e.message).slice(0, 120)); }
  }
  await q(`update organizations set razorpay_checkout_subscription_id = null where id = $1`, [orgId]);
}

const needReason = (b) => { const r = String(b.reason || "").trim(); if (r.length < 3) fail(400, "Say why (a few words): it goes in the audit log."); return r.slice(0, 300); };
async function invoicesOf(subscriptionId) {
  let list; try { list = await client().listInvoices(subscriptionId); } catch (e) { fail(502, "Razorpay didn't answer: " + String(e.message).slice(0, 120)); }
  return (list.items || []).map((i) => ({ id: i.id, paymentId: i.payment_id || null, amount: Number(i.amount) || 0, amountPaid: Number(i.amount_paid) || 0, currency: i.currency,
    status: i.status, issuedAt: i.issued_at ? new Date(i.issued_at * 1000) : null, paidAt: i.paid_at ? new Date(i.paid_at * 1000) : null, url: razorpayLink(i.short_url) }));
}

// An invite sent by an operator from the console (same token, email and audit trail as an admin's invite in the app).
async function consoleInvite(req, by, org, email, role) {
  const { invite, token } = await O.createInvite({ orgId: org.id, email, role, by: by.id });
  const link = `${(process.env.PUBLIC_ORIGIN || origin(req)).replace(/\/$/, "")}/#invite=${token}`;
  const r = await mail.inviteEmail({ to: email, orgName: org.name, role, inviter: "the White Petal team", link }).catch(() => ({ sent: false }));
  await O.audit(org.id, by.id, "invite.sent", email, { role, emailed: r.sent, by: "console" });
  return { ...invite, link, emailed: !!r.sent };
}
const orgBySlug = async (slug) => (await one(`select id, slug, name, billing_status, razorpay_subscription_id, razorpay_checkout_subscription_id, paused_at from organizations where slug = $1`, [slug])) || fail(404, "No such organisation.");
const ROLE_OK = (r) => O.ROLES.includes(r);
// Admin and owner of a customer's organisation are founder-only grants from the console: otherwise a support or finance operator could
// invite or promote themselves (or anyone) into control of a customer's account. Founders reach any organisation through an audited visit.
const needGrant = (opRole, role) => { if (["owner", "admin"].includes(role) && opRole !== "founder") fail(403, "Only a founder can make someone an admin or the owner of a customer's organisation.", { code: "role", need: ["founder"] }); };
// No operator adds themselves to a customer's organisation from the console.
const notSelf = (user, email) => { if (normEmail(user.email) === normEmail(email)) fail(403, "You can't add yourself to a customer's organisation. Founders open it with a visit instead.", { code: "self" }); };

export function makeConsoleRoutes({ needUser }) {
  // Resolves the operator's role or throws 404; `allow` narrows a route to some roles (403 for other operators).
  const needConsole = async (req, ...allow) => {
    const user = await needUser(req), role = await consoleRole(user);
    if (!role) fail(404, "Not found");
    if (allow.length && !allow.includes(role)) fail(403, "Your operator role can't do that.", { code: "role", need: allow });
    return { user, role };
  };
  const read = (path, fn, ...allow) => ["GET", "/api/admin/console/" + path, async (req, res, p, url) => {
    const { role } = await needConsole(req, ...allow);
    const scope = await C.scopeFrom(url);
    sendJson(res, 200, redact(role, { ...(await fn(p, url, scope)), scope: { label: scope.label, accounts: scope.accounts, days: scope.days, demo: scope.demo } }));
  }];
  const orgId = async (slug) => (await one(`select id from organizations where slug = $1`, [slug]))?.id || fail(404, "No such organisation.");
  return [
    // The browser's heartbeat (any signed-in person, while the tab is visible): which page of the app they are on. Feeds the Live
    // page and feature analytics. Only a page name from the app's navigation and a brand slug are accepted.
    ["POST", "/api/presence", async (req, res) => {
      const user = await needUser(req);
      if (limited("presence:" + user.id, 400, 3600e3)) return sendJson(res, 200, { ok: false });
      const b = await readJson(req, 1000), page = String(b.page || ""), brand = b.brand ? String(b.brand) : null;
      if (!/^[a-z][a-z0-9_-]{0,30}$/.test(page)) fail(400, "Unknown page.");
      if (brand && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(brand)) fail(400, "Unknown brand.");
      const ctx = await O.context(user);
      if (ctx.operatorVisit) return sendJson(res, 200, { ok: true }); // an operator looking at a customer's organisation is not that customer
      const ua = String(req.headers["user-agent"] || ""), device = /iPad|Tablet/i.test(ua) ? "tablet" : /Mobi|Android|iPhone/i.test(ua) ? "mobile" : "desktop";
      // `since` restarts when the page or brand changes (or after 10 quiet minutes); that moment is also one page view.
      const r = await one(`insert into presence (user_id, org_id, page, brand, device) values ($1, $2, $3, $4, $5)
          on conflict (user_id) do update set org_id = excluded.org_id, page = excluded.page, brand = excluded.brand, device = excluded.device, at = now(),
            since = case when presence.page = excluded.page and presence.brand is not distinct from excluded.brand and presence.at > now() - interval '10 minutes' then presence.since else now() end
          returning since = at as changed`, [user.id, ctx.org?.id || null, page, brand, device]);
      if (r.changed) await q(`insert into page_views (user_id, org_id, page, device) values ($1, $2, $3, $4)`, [user.id, ctx.org?.id || null, page, device]);
      // ponytail: opportunistic 90-day retention instead of a job; move to the cron tick if page_views gets large.
      if (Math.random() < 0.01) await q(`delete from page_views where at < now() - interval '90 days'`).catch(() => {});
      sendJson(res, 200, { ok: true });
    }],
    // Live: a snapshot every 5 seconds over Server-Sent Events, for up to 30 minutes per connection (the page reconnects).
    ["GET", "/api/admin/console/live", async (req, res) => {
      let { role } = await needConsole(req);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      let open = true, timer = null;
      const stop = () => { open = false; clearTimeout(timer); };
      req.on("close", stop);
      const started = Date.now();
      const tick = async () => {
        if (!open) return;
        // Access is re-checked on every snapshot: a signed-out, deactivated or demoted operator stops receiving it at once.
        try { ({ role } = await needConsole(req)); } catch { stop(); res.write(`event: problem\ndata: ${JSON.stringify({ error: "Your console access ended.", ended: true })}\n\n`); return res.end(); }
        try { res.write(`event: snapshot\ndata: ${JSON.stringify(redact(role, await C.live()))}\n\n`); }
        catch (e) { res.write(`event: problem\ndata: ${JSON.stringify({ error: String(e.message).slice(0, 200) })}\n\n`); }
        if (Date.now() - started > 30 * 60e3) { stop(); return res.end(); }
        timer = setTimeout(tick, 5000);
      };
      tick();
    }],
    ["GET", "/api/admin/console/me", async (req, res) => {
      const { user, role } = await needConsole(req);
      const groups = await q(`select g.id, g.name, g.kind, g.leave_out, count(m.org_id)::int as n from account_groups g left join account_group_members m on m.group_id = g.id group by g.id order by g.created_at`);
      sendJson(res, 200, { role, id: user.id, email: user.email, canVisit: O.isOperator(user), trialDays: billingConfig().trialDays, env: process.env.NODE_ENV === "production" ? "Production" : process.env.K_REVISION ? "Staging" : "Local", groups });
    }],
    read("overview", (p, u, sc) => C.overview(sc)),
    read("revenue", (p, u, sc) => C.revenue(sc), "founder", "finance", "analyst"),
    read("margin", (p, u, sc) => C.margin(sc), "founder", "finance", "analyst"),
    read("customers", async (p, u, sc) => ({ orgs: await C.customers(sc) })),
    read("customers/:slug", async (p) => { const c = await C.customer(p.slug); if (!c) fail(404, "No such organisation."); const id = await orgId(p.slug);
      return { ...c, subscription: await F.subscriptionOf(id), groups: await q(`select g.id, g.name, g.kind from account_group_members m join account_groups g on g.id = m.group_id where m.org_id = $1`, [id]) }; }),
    // Founder Command pages
    read("pulse", (p, u, sc) => F.pulse(sc)),
    read("value", (p, u, sc) => F.productValue(sc)),
    read("customers-page", (p, u, sc) => F.customersPage(sc, ["active", "blocked", "no_first_check", "unused_approved", "stale_integration"].includes(u.searchParams.get("health")) ? u.searchParams.get("health") : null)),
    read("plans-subs", (p, u, sc) => F.plansSubs(sc), "founder", "finance", "support", "analyst"),
    read("operations", (p, u, sc) => F.operations(sc, u.searchParams.get("status") || "all")),
    read("ai", (p, u, sc) => F.aiCost(sc)),
    read("integrations", (p, u, sc) => F.integrationsHealth(sc)),
    read("releases", () => F.releases()),
    read("outcomes", (p, u, sc) => F.outcomes(sc)),
    read("plan-fit", (p, u, sc) => F.planFit(sc), "founder", "finance", "analyst"),
    read("unit-costs", (p, u, sc) => F.unitCosts(sc), "founder", "finance", "analyst"),
    read("usage-depth", (p, u, sc) => F.usageDepth(sc)),
    read("plans/:code/accounts", async (p, u, sc) => (await F.planAccounts(String(p.code), sc)) || fail(404, "Unknown plan."), "founder", "finance", "support", "analyst"),
    read("subscriptions", (p, u, sc) => C.subscriptions(sc), "founder", "finance", "support"),
    read("platform", () => C.platform()),
    read("activity", (p, url, sc) => C.activity(sc.days, sc)),
    read("engagement", (p, url, sc) => C.engagement(sc)),
    read("audit", async () => ({ log: await C.auditFeed(150) }), "founder", "finance"),

    ["POST", "/api/admin/console/customers/:slug/notes", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "support", "finance");
      if (limited("console-note:" + user.id, 120, 3600e3)) fail(429, "Too many notes. Try again in a bit.");
      const body = String((await readJson(req, 8000)).body || "").trim();
      if (!body || body.length > 4000) fail(400, "Write a note of up to 4,000 characters.");
      const id = await orgId(p.slug);
      const note = await one(`insert into org_notes (org_id, by_user, body) values ($1, $2, $3) returning id, body, at`, [id, user.id, body]);
      await O.audit(id, user.id, "console.note_added", p.slug, { noteId: note.id });
      sendJson(res, 200, { note: { ...note, by: user.email } });
    }],
    // Send a customer a Razorpay subscription for a plan: Razorpay emails the owner a link to authorise it. It is stored as the
    // organisation's *pending* subscription, so the plan only changes when Razorpay's signed webhook says it was paid (same trust
    // model as self-serve checkout). Works for any catalogue price with a Razorpay plan id, including non-self-serve ones (Enterprise).
    ["POST", "/api/admin/console/customers/:slug/subscription", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance");
      const b = await readJson(req, 4000), plan = String(b.plan || ""), currency = String(b.currency || "").toUpperCase(), reason = String(b.reason || "").trim(), cycle = b.cycle === "annual" ? "annual" : "monthly";
      const cfg = billingConfig();
      if (!cfg.ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
      const planId = (cycle === "annual" ? PLANS[plan]?.annualRazorpayIds : PLANS[plan]?.razorpayIds)?.[currency] || planIdFor(plan, currency, cycle);
      if (!planId) fail(400, `${PLANS[plan]?.name || "That plan"} has no ${cycle === "annual" ? "annual " : ""}Razorpay plan in ${currency || "that currency"}. Add one in the plan catalogue first.`, { code: "plan_unavailable" });
      if (reason.length < 3) fail(400, "Say why (a few words): it goes in the audit log.");
      if (limited("console-sub:" + p.slug, 10, 3600e3)) fail(429, "Too many links for this organisation. Try again in a bit.");
      const org = await one(`select o.id, o.billing_status, o.cancel_at_period_end, o.trial_ends_at, o.razorpay_subscription_id as main, o.razorpay_checkout_subscription_id as pending,
          (select u.email from memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner' limit 1) as owner from organizations o where o.slug = $1`, [p.slug]);
      if (!org) fail(404, "No such organisation.");
      if (org.main && org.billing_status === "active" && !org.cancel_at_period_end) fail(409, "This organisation already pays for a subscription. The owner changes plan from Plans & payment.", { code: "has_subscription" });
      if (!org.owner) fail(409, "This organisation has no owner to send the link to.");
      const rzp = client();
      if (org.pending) await rzp.cancelSubscription(org.pending, { atCycleEnd: false }).catch((e) => console.warn("[console] could not cancel the previous link:", e.message));
      await cancelOpenPaymentLinks(org.id); // one way to pay at a time: an open one-time link goes
      // Paying starts the plan at once, even during a free trial (the trial ends there).
      const startAt = null;
      let sub;
      try { sub = await rzp.createSubscription({ planId, orgId: org.id, plan, cycle, startAt, notifyEmail: org.owner, validFor: 7 * 86400 }); }
      catch (e) { console.warn("[console] subscription:", e.message); fail(502, "Razorpay didn't accept the request. Nothing was created or charged."); }
      await q(`update organizations set razorpay_checkout_subscription_id = $2, updated_at = now() where id = $1`, [org.id, sub.id]);
      await O.audit(org.id, user.id, "billing.link_sent", plan, { currency, cycle, subscription: sub.id, to: org.owner, reason, amount: withTax((cycle === "annual" ? PLANS[plan].annualPrices : PLANS[plan].prices)[currency], currency) });
      sendJson(res, 200, { subscriptionId: sub.id, url: razorpayLink(sub.short_url), sentTo: org.owner, startsAt: startAt ? new Date(startAt * 1000) : null });
    }],
    // One month of a plan, paid once (a Razorpay Payment Link, emailed to the owner by Razorpay). Paying makes the organisation active on
    // that plan for a month from then (added on to a month still running), with no renewal; it ends a free trial. The amount comes from the
    // catalogue's monthly price with tax, never from the browser. Not while a subscription is live: one way to pay at a time.
    ["POST", "/api/admin/console/customers/:slug/one-time", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance");
      const b = await readJson(req, 4000), plan = String(b.plan || ""), currency = String(b.currency || "").toUpperCase(), reason = needReason(b);
      if (!billingConfig().ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
      const price = PLANS[plan]?.prices?.[currency];
      if (!(price > 0)) fail(400, `${PLANS[plan]?.name || "That plan"} has no monthly price in ${currency || "that currency"}.`, { code: "plan_unavailable" });
      if (limited("console-sub:" + p.slug, 10, 3600e3)) fail(429, "Too many links for this organisation. Try again in a bit.");
      const org = await one(`select o.id, o.name, o.billing_status, o.razorpay_subscription_id as main, o.razorpay_checkout_subscription_id as pending,
          (select u.email from memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner' limit 1) as owner from organizations o where o.slug = $1`, [p.slug]);
      if (!org) fail(404, "No such organisation.");
      if (org.main && ["active", "past_due"].includes(org.billing_status)) fail(409, "This organisation pays by subscription. Cancel it first, or change its plan instead.", { code: "has_subscription" });
      if (!org.owner) fail(409, "This organisation has no owner to send the link to.");
      // A cheaper plan while a dearer paid month is still running would cut that month short (the new month starts on payment).
      // Upgrades start at once; a downgrade waits until the running month ends (or the team assigns the plan now).
      const run = await one(`select plan_code, current_period_end from organizations where id = $1 and billing_status = 'active' and razorpay_subscription_id is null and current_period_end > now()`, [org.id]);
      const per = (code) => PLANS[code]?.prices?.[currency] ?? null;
      if (run && run.plan_code !== plan && per(run.plan_code) != null && price < per(run.plan_code))
        fail(409, `Their ${PLANS[run.plan_code]?.name || run.plan_code} month runs until ${new Date(run.current_period_end).toDateString().slice(4)}. Send the ${PLANS[plan].name} link after that, or assign ${PLANS[plan].name} now with "Assign a plan".`, { code: "downgrade_running", until: run.current_period_end });
      const rzp = client(), amount = withTax(price, currency), expireBy = Math.floor(Date.now() / 1000) + 7 * 86400;
      if (org.pending) { await rzp.cancelSubscription(org.pending, { atCycleEnd: false }).catch((e) => console.warn("[console] could not cancel the subscription link:", e.message)); await q(`update organizations set razorpay_checkout_subscription_id = null where id = $1`, [org.id]); }
      await cancelOpenPaymentLinks(org.id);
      let link;
      try { link = await rzp.createPaymentLink({ amount, currency, email: org.owner, expireBy, description: `${PLANS[plan].name} plan, one month (${org.name})`.slice(0, 2048),
        notes: { white_petal_org_id: org.id, white_petal_plan: plan, kind: "one_month" } }); }
      catch (e) { console.warn("[console] payment link:", e.message); fail(502, "Razorpay didn't accept the request. Nothing was created or charged."); }
      await q(`insert into payment_links (id, org_id, plan_code, currency, amount_minor, months, short_url, created_by) values ($1, $2, $3, $4, $5, 1, $6, $7)`,
        [link.id, org.id, plan, currency, amount, link.short_url || null, user.id]);
      await O.audit(org.id, user.id, "billing.onetime_link_sent", plan, { link: link.id, currency, amount, to: org.owner, reason });
      sendJson(res, 200, { linkId: link.id, url: razorpayLink(link.short_url), sentTo: org.owner, amount, currency, expiresAt: new Date(expireBy * 1000) });
    }],
    // Change a paying organisation's plan for them (upgrade now, downgrade at the cycle end, same rules as the owner's own change).
    ["POST", "/api/admin/console/customers/:slug/change-plan", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance");
      const b = await readJson(req, 4000), reason = needReason(b);
      if (!billingConfig().ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
      sendJson(res, 200, await changePlan(await orgId(p.slug), user.id, String(b.plan || ""), { anyPlan: true, reason }));
    }],
    // Cancel at the end of the paid period, or now (Razorpay stops it at once; its webhook moves the organisation off the plan).
    ["POST", "/api/admin/console/customers/:slug/cancel", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance");
      const b = await readJson(req, 4000), reason = needReason(b);
      if (!billingConfig().ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
      if (b.now && String(b.confirm || "") !== p.slug) fail(400, `To end it now, type the organisation's id (${p.slug}) to confirm.`, { code: "confirm" });
      sendJson(res, 200, await cancelPlan(await orgId(p.slug), user.id, { now: !!b.now, reason }));
    }],
    // The subscription's charges, straight from Razorpay (amount, status, payment id, hosted invoice link).
    ["GET", "/api/admin/console/customers/:slug/invoices", async (req, res, p) => {
      await needConsole(req, "founder", "finance", "support");
      if (!billingConfig().ready) return sendJson(res, 200, { invoices: [], unavailable: true });
      const sid = (await one(`select razorpay_subscription_id as s from organizations where slug = $1`, [p.slug]))?.s;
      if (!sid) return sendJson(res, 200, { invoices: [] });
      sendJson(res, 200, { invoices: await invoicesOf(sid) });
    }],
    // Refund one charge of this organisation's subscription (full or partial). The payment must be one of the subscription's own
    // invoices, so a payment id from anywhere else is refused; confirmation by typing the organisation's id, reason in the audit log.
    ["POST", "/api/admin/console/customers/:slug/refund", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance");
      const b = await readJson(req, 4000), reason = needReason(b);
      if (!billingConfig().ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
      if (String(b.confirm || "") !== p.slug) fail(400, `Type the organisation's id (${p.slug}) to confirm the refund.`, { code: "confirm" });
      if (limited("console-refund:" + p.slug, 5, 3600e3)) fail(429, "Too many refunds for this organisation. Try again later.");
      const org = await one(`select id, razorpay_subscription_id as s from organizations where slug = $1`, [p.slug]);
      if (!org?.s) fail(409, "This organisation has no Razorpay subscription.");
      const inv = (await invoicesOf(org.s)).find((x) => x.paymentId && x.paymentId === String(b.paymentId || ""));
      if (!inv) fail(400, "That payment isn't one of this subscription's charges.", { code: "bad_payment" });
      const amount = b.amount == null || b.amount === "" ? null : Math.round(Number(b.amount));
      if (amount != null && !(amount > 0 && amount <= inv.amount)) fail(400, "Refund between 1 and the amount charged.", { code: "bad_amount" });
      let r; try { r = await client().refundPayment(inv.paymentId, { amount, notes: { white_petal_org: p.slug, reason: reason.slice(0, 200) } }); }
      catch (e) { console.warn("[console] refund:", e.message); fail(502, "Razorpay didn't accept the refund: " + String(e.message).replace(/^Razorpay \d+: /, "").slice(0, 160)); }
      await O.audit(org.id, user.id, "billing.refund_issued", inv.paymentId, { refundId: r.id, amount: r.amount ?? amount ?? inv.amount, currency: inv.currency, reason });
      sendJson(res, 200, { refundId: r.id, amount: r.amount ?? amount ?? inv.amount, status: r.status });
    }],
    // Extra seats on top of the plan's own. Invoiced, or through Razorpay (the added seats go on the next invoice now, and every
    // renewal adds the cycle's seats again). The plan's cap applies; 0 means extra seats aren't sold on it.
    // Raise (or lower) one organisation's limits on the plan it already has: questions, brands, website pages read per check and the rest.
    // Only the custom limits change, never the plan, price or Razorpay subscription, so it works for paying customers too.
    // values: { metric: whole number | null }, null = back to the plan's own; expiresAt: optional date the custom limits stop.
    ["PUT", "/api/admin/console/customers/:slug/limits", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance");
      const b = await readJson(req, 4000), reason = needReason(b), v = b.values || {};
      const org = await one(`select id, name, plan_code, entitlement_overrides from organizations where slug = $1`, [p.slug]);
      if (!org) fail(404, "No such organisation.");
      if (typeof v !== "object" || Array.isArray(v)) fail(400, "values must be an object of limits.");
      for (const [k, n] of Object.entries(v)) {
        if (!LIMIT_METRICS.includes(k)) fail(400, `Unknown limit "${k}". Limits are ${LIMIT_METRICS.join(", ")}.`, { code: "bad_limit" });
        if (n !== null && !(Number.isInteger(n) && n >= 0 && n <= 1000000)) fail(400, `${k} must be a whole number from 0 to 1,000,000, or empty for the plan's own.`, { code: "bad_limit" });
      }
      const before = org.entitlement_overrides || {}, live = before.values && (!before.expiresAt || new Date(before.expiresAt) > new Date());
      // expiresAt left out keeps the custom limits' current end date; null or "" removes it; a date sets it.
      let expiresAt = b.expiresAt === undefined && live ? before.expiresAt || null : null;
      if (b.expiresAt) { const d = new Date(b.expiresAt); if (Number.isNaN(d.getTime()) || d <= new Date()) fail(400, "The end date must be in the future.", { code: "bad_limit" }); expiresAt = d.toISOString(); }
      const values = { ...(live ? before.values : {}) };
      for (const [k, n] of Object.entries(v)) { if (n === null) delete values[k]; else values[k] = n; }
      const after = Object.keys(values).length ? { values, expiresAt, reason, by: user.email } : {};
      await q(`update organizations set entitlement_overrides = $2, updated_at = now() where id = $1`, [org.id, after]);
      await O.audit(org.id, user.id, "billing.limits_set", org.name, { reason, before, after });
      sendJson(res, 200, { subscription: await F.subscriptionOf(org.id) });
    }],
    ["POST", "/api/admin/console/customers/:slug/seats", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance");
      const b = await readJson(req, 2000), reason = needReason(b), n = Number(b.extraSeats), how = b.billing === "razorpay" ? "razorpay" : "invoice";
      if (!Number.isInteger(n) || n < 0 || n > 10000) fail(400, "Extra seats is a whole number from 0.");
      const o = await one(`select id, plan_code, billing_currency, billing_status, extra_seats, extra_seats_billing, razorpay_subscription_id from organizations where slug = $1`, [p.slug]);
      if (!o) fail(404, "No such organisation.");
      const plan = PLANS[o.plan_code], cap = plan?.maxExtraSeats;
      if (cap != null && n > cap) fail(400, cap === 0 ? `${plan.name} doesn't sell extra seats. Raise "Most extra seats" on the plan, or give custom limits instead.` : `${plan.name} allows at most ${cap} extra seats.`, { code: "seat_cap" });
      if (how === "razorpay") {
        if (!billingConfig().ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
        if (!o.razorpay_subscription_id || !["active", "past_due"].includes(o.billing_status)) fail(409, "Billing seats through Razorpay needs an active Razorpay subscription. Invoice them instead.", { code: "no_subscription" });
        if (!(plan?.seatPrices?.[o.billing_currency || "INR"] > 0)) fail(400, `${plan?.name || "This plan"} has no extra-seat price in ${o.billing_currency || "INR"}. Set one on the plan first.`, { code: "no_seat_price" });
      }
      await q(`update organizations set extra_seats = $2, extra_seats_billing = $3, updated_at = now() where id = $1`, [o.id, n, how]);
      await O.audit(o.id, user.id, "billing.seats_changed", String(n), { from: o.extra_seats, billing: how, reason });
      // Seats added now are billed for the rest of the current cycle on the next invoice. Removed ones withdraw this cycle's not-yet-invoiced
      // raises, and aren't added at the next renewal.
      let charged = null, withdrawn = null;
      if (how === "razorpay" && n > o.extra_seats) {
        try { charged = await chargeSeats(o.id, { seats: n - o.extra_seats, actorId: user.id, reason, prorate: true }); }
        catch (e) { fail(502, "Seats saved, but Razorpay didn't accept the charge: " + String(e.message).slice(0, 140) + ". Retry, or bill this cycle by invoice."); }
      }
      if (o.extra_seats_billing === "razorpay" && n < o.extra_seats && billingConfig().ready) {
        try { withdrawn = await withdrawSeats(o.id, { seats: o.extra_seats - n, actorId: user.id, reason }); }
        catch (e) { console.warn("[console] seats withdraw:", e.message); withdrawn = { error: "Seats saved, but this cycle's added seats couldn't be withdrawn from Razorpay. Check the next invoice." }; }
      }
      sendJson(res, 200, { extraSeats: n, billing: how, charged, withdrawn });
    }],
    // Ask Razorpay for the truth now instead of waiting for the daily reconcile.
    ["POST", "/api/admin/console/customers/:slug/sync", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance", "support");
      if (!billingConfig().ready) fail(503, "Razorpay keys aren't configured on this server.", { code: "billing_unconfigured" });
      if (limited("console-sync:" + p.slug, 20, 3600e3)) fail(429, "Too many syncs. Try again in a bit.");
      const id = await orgId(p.slug);
      let out; try { out = await syncOrg(id); } catch (e) { fail(502, "Razorpay didn't answer: " + String(e.message).slice(0, 120)); }
      await O.audit(id, user.id, "console.billing_synced", p.slug, out);
      sendJson(res, 200, out);
    }],
    // Account groups: keep your own, your team's and test organisations out of the figures.
    ["POST", "/api/admin/console/groups", async (req, res) => {
      const { user } = await needConsole(req, "founder", "finance", "support");
      const b = await readJson(req, 2000), name = String(b.name || "").trim(), kind = ["internal", "demo", "custom"].includes(b.kind) ? b.kind : "internal";
      if (!name || name.length > 60) fail(400, "Name the group (up to 60 characters).");
      const g = await F.groupCreate(name, kind, user.id);
      await O.audit(null, user.id, "console.group_created", name, { id: g.id, kind });
      sendJson(res, 200, { group: g });
    }],
    ["PATCH", "/api/admin/console/groups/:id", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance", "support");
      if (!/^[0-9a-f-]{36}$/.test(p.id)) fail(404, "No such group.");
      const b = await readJson(req, 20000), slugs = (k) => (Array.isArray(b[k]) ? b[k].map(String).filter((x) => /^[a-z0-9-]{1,80}$/.test(x)).slice(0, 500) : []);
      if (b.name != null && (!String(b.name).trim() || String(b.name).length > 60)) fail(400, "Name the group (up to 60 characters).");
      const g = await F.groupUpdate(p.id, { name: b.name != null ? String(b.name).trim() : null, leaveOut: typeof b.leaveOut === "boolean" ? b.leaveOut : null, kind: ["internal", "demo", "custom"].includes(b.kind) ? b.kind : null });
      if (!g) fail(404, "No such group.");
      await F.groupMembers(p.id, slugs("add"), slugs("remove"));
      await O.audit(null, user.id, "console.group_changed", g.name, { id: g.id, add: slugs("add"), remove: slugs("remove"), leaveOut: g.leave_out });
      sendJson(res, 200, { group: g });
    }],
    ["DELETE", "/api/admin/console/groups/:id", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance");
      if (!/^[0-9a-f-]{36}$/.test(p.id)) fail(404, "No such group.");
      await F.groupDelete(p.id);
      await O.audit(null, user.id, "console.group_deleted", p.id);
      sendJson(res, 200, { ok: true });
    }],
    // ── Accounts: create, rename, suspend / resume, delete ──
    ["POST", "/api/admin/console/accounts", async (req, res) => {
      const { user, role: opRole } = await needConsole(req, "founder", "finance", "support");
      const b = await readJson(req, 4000), name = String(b.name || "").trim(), ownerEmail = normEmail(b.ownerEmail || ""), start = ["new", "internal"].includes(b.start) ? b.start : "new";
      // Internal accounts are unlimited and may run on the platform's AI keys: a founder's decision, not one any operator can make.
      if ((start === "internal" || b.allowPlatformKeys) && opRole !== "founder") fail(403, "Only a founder can create an internal account or let one use the platform's AI keys.", { code: "role", need: ["founder"] });
      if (name.length < 2 || name.length > 80) fail(400, "Give the organisation a name (2 to 80 characters).");
      if (!emailOk(ownerEmail)) fail(400, "Enter the owner's email address.");
      if (limited("console-account:" + user.id, 30, 3600e3)) fail(429, "That's a lot of new accounts in an hour. Try again later.");
      // No operator membership: the organisation belongs to its owner from the start. "new" waits for the owner to pick a plan (which
      // starts their one free trial); "internal" is unlimited, for the team's own and test accounts.
      const org = await O.createOrg({ name, by: null, allowPlatformKeys: !!b.allowPlatformKeys && start === "internal" });
      await q(`update organizations set created_by = $2, billing_status = $3 where id = $1`, [org.id, user.id, start]);
      await O.audit(org.id, user.id, "org.created", org.name, { owner: ownerEmail, by: "console", start });
      const invite = await consoleInvite(req, user, org, ownerEmail, "owner");
      sendJson(res, 200, { account: { slug: org.slug, name: org.name }, invite });
    }],
    ["PATCH", "/api/admin/console/accounts/:slug", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance", "support");
      const org = await orgBySlug(p.slug), b = await readJson(req, 4000);
      if (b.name != null) {
        const name = String(b.name).trim(); if (name.length < 2 || name.length > 80) fail(400, "Give the organisation a name (2 to 80 characters).");
        await q(`update organizations set name = $2, updated_at = now() where id = $1`, [org.id, name]);
        await O.audit(org.id, user.id, "org.renamed", name, { from: org.name, by: "console" });
      }
      if (typeof b.suspended === "boolean") {
        const reason = String(b.reason || "").trim(); if (reason.length < 3) fail(400, "Say why (a few words): it goes in the audit log.");
        await q(`update organizations set paused_at = $2, updated_at = now() where id = $1`, [org.id, b.suspended ? new Date() : null]);
        await O.audit(org.id, user.id, b.suspended ? "org.suspended" : "org.resumed", org.name, { reason });
      }
      sendJson(res, 200, { account: await one(`select slug, name, paused_at from organizations where id = $1`, [org.id]) });
    }],
    // Deleting removes the organisation and everything in it (brands, runs, usage, notes). Founders only, typed confirmation, and never
    // while Razorpay may still charge it. The record of the deletion is kept with no organisation attached.
    ["DELETE", "/api/admin/console/accounts/:slug", async (req, res, p) => {
      const { user } = await needConsole(req, "founder");
      const org = await orgBySlug(p.slug), b = await readJson(req, 2000), reason = String(b.reason || "").trim();
      if (String(b.confirm || "") !== org.slug) fail(400, `Type the organisation's id (${org.slug}) to confirm.`, { code: "confirm" });
      if (reason.length < 3) fail(400, "Say why (a few words): it goes in the audit log.");
      if (org.razorpay_subscription_id && ["active", "past_due", "trialing"].includes(org.billing_status)) fail(409, "This organisation has a live Razorpay subscription. Cancel it first.", { code: "has_subscription" });
      await withdrawPendingLink(org.id, org.razorpay_checkout_subscription_id);
      const counts = await one(`select (select count(*)::int from workspaces where org_id = $1 and parent_id is null) as brands, (select count(*)::int from memberships where org_id = $1) as members`, [org.id]);
      await O.audit(null, user.id, "org.deleted", org.slug, { name: org.name, reason, ...counts });
      await q(`delete from organizations where id = $1`, [org.id]);
      sendJson(res, 200, { deleted: org.slug, ...counts });
    }],

    // ── Delete a person entirely (every account they belong to) ──
    // GET says what would happen; DELETE does it. An organisation only they are in goes with them (unless it pays through Razorpay);
    // one shared with others must be handed over first. Founders only; the email must be typed; nothing is half-done (one transaction).
    ["GET", "/api/admin/console/users/:id/deletion", async (req, res, p) => {
      const { user } = await needConsole(req, "founder");
      sendJson(res, 200, await userDeletion(String(p.id), user));
    }],
    ["DELETE", "/api/admin/console/users/:id", async (req, res, p) => {
      const { user } = await needConsole(req, "founder");
      const b = await readJson(req, 2000), reason = needReason(b), plan = await userDeletion(String(p.id), user);
      if (normEmail(String(b.confirm || "")) !== plan.email) fail(400, `Type the person's email (${plan.email}) to confirm.`, { code: "confirm" });
      if (plan.blockers.length) fail(409, plan.blockers.join(" "), { code: "blocked" });
      const gone = plan.orgs.filter((o) => o.deleted);
      for (const o of gone) await withdrawPendingLink(o.id, o.pending);
      await tx(async (c) => {
        for (const o of gone) await c.query(`delete from organizations where id = $1`, [o.id]);
        await c.query(`delete from users where id = $1`, [plan.id]);
      });
      for (const o of plan.orgs.filter((x) => !x.deleted)) await O.audit(o.id, user.id, "member.deleted_user", plan.email, { reason });
      await O.audit(null, user.id, "user.deleted", plan.email, { reason, organisationsDeleted: gone.map((o) => o.slug), memberOf: plan.orgs.map((o) => o.slug) });
      sendJson(res, 200, { deleted: plan.email, organisationsDeleted: gone.map((o) => o.slug) });
    }],

    // ── People in an account: invite, change role, remove, revoke an invite ──
    ["GET", "/api/admin/console/accounts/:slug/people", async (req, res, p) => {
      const { role } = await needConsole(req);
      const org = await orgBySlug(p.slug);
      sendJson(res, 200, redact(role, { members: await O.members(org.id), invites: await O.pendingInvites(org.id) }));
    }],
    ["POST", "/api/admin/console/accounts/:slug/people", async (req, res, p) => {
      const { user, role: opRole } = await needConsole(req, "founder", "finance", "support");
      const org = await orgBySlug(p.slug), b = await readJson(req, 2000), email = normEmail(b.email || ""), role = String(b.role || "viewer");
      if (!emailOk(email)) fail(400, "Enter a valid email address.");
      if (!ROLE_OK(role)) fail(400, "Pick a role: owner, admin, editor or viewer.");
      needGrant(opRole, role); notSelf(user, email);
      if (role === "owner" && (await one(`select 1 from memberships where org_id = $1 and role = 'owner'`, [org.id]))) fail(409, "This organisation already has an owner. Change an existing member to owner instead.");
      if (await one(`select 1 from memberships m join users u on u.id = m.user_id where m.org_id = $1 and u.email = $2`, [org.id, email])) fail(409, `${email} is already in this organisation.`);
      if (limited("console-invite:" + org.id, 30, 3600e3)) fail(429, "That's a lot of invites in an hour. Try again later.");
      await B.assertSeat(org.id, { operator: true });
      sendJson(res, 200, { invite: await consoleInvite(req, user, org, email, role) });
    }],
    ["PATCH", "/api/admin/console/accounts/:slug/people/:id", async (req, res, p) => {
      const { user, role: opRole } = await needConsole(req, "founder", "finance", "support");
      const org = await orgBySlug(p.slug), b = await readJson(req, 2000), role = String(b.role || "");
      if (!ROLE_OK(role)) fail(400, "Unknown role.");
      needGrant(opRole, role);
      if (p.id === user.id) fail(403, "You can't change your own role in a customer's organisation.", { code: "self" });
      await tx(async (c) => {
        const m = (await c.query(`select m.role, u.email from memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.user_id::text = $2 for update of m`, [org.id, p.id])).rows[0];
        if (!m) fail(404, "That person isn't in this organisation.");
        if (m.role === role) return;
        needGrant(opRole, m.role); // lowering an admin or the owner is a founder's call too
        if (role === "owner") { // hand over ownership: the current owner stays on as an admin
          await c.query(`update memberships set role = 'admin' where org_id = $1 and role = 'owner'`, [org.id]);
          await c.query(`update memberships set role = 'owner' where org_id = $1 and user_id::text = $2`, [org.id, p.id]);
          await c.query(`insert into audit_log (org_id, user_id, action, target, detail) values ($1, $2, 'owner.transferred', $3, $4)`, [org.id, user.id, m.email, { by: "console" }]);
        } else {
          if (m.role === "owner") fail(409, "Make someone else the owner first; the owner's role can't be lowered on its own.");
          await c.query(`update memberships set role = $3 where org_id = $1 and user_id::text = $2`, [org.id, p.id, role]);
          await c.query(`insert into audit_log (org_id, user_id, action, target, detail) values ($1, $2, 'role.changed', $3, $4)`, [org.id, user.id, m.email, { from: m.role, to: role, by: "console" }]);
        }
      });
      sendJson(res, 200, { members: await O.members(org.id) });
    }],
    ["DELETE", "/api/admin/console/accounts/:slug/people/:id", async (req, res, p) => {
      const { user, role: opRole } = await needConsole(req, "founder", "finance", "support");
      const org = await orgBySlug(p.slug);
      const target = await one(`select role from memberships where org_id = $1 and user_id::text = $2`, [org.id, p.id]);
      if (target) needGrant(opRole, target.role); // removing an admin is a founder's call
      const m = await one(`delete from memberships m using users u where u.id = m.user_id and m.org_id = $1 and m.user_id::text = $2 and m.role <> 'owner' and ($3 or m.role not in ('admin', 'owner')) returning m.role, u.email`, [org.id, p.id, opRole === "founder"]);
      if (!m) { const still = await one(`select 1 from memberships where org_id = $1 and user_id::text = $2`, [org.id, p.id]); fail(still ? 409 : 404, still ? "The owner can't be removed. Make someone else the owner first." : "That person isn't in this organisation."); }
      await q(`update sessions set org_id = null where org_id = $1 and user_id::text = $2`, [org.id, p.id]);
      await O.audit(org.id, user.id, "member.removed", m.email, { role: m.role, by: "console" });
      sendJson(res, 200, { members: await O.members(org.id) });
    }],
    ["DELETE", "/api/admin/console/accounts/:slug/invites/:id", async (req, res, p) => {
      const { user } = await needConsole(req, "founder", "finance", "support");
      const org = await orgBySlug(p.slug);
      const r = await one(`update invitations set revoked_at = now() where id::text = $2 and org_id = $1 and accepted_at is null and revoked_at is null returning email`, [org.id, p.id]);
      if (!r) fail(404, "That invite is already used, revoked or expired.");
      await O.audit(org.id, user.id, "invite.revoked", r.email, { by: "console" });
      sendJson(res, 200, { invites: await O.pendingInvites(org.id) });
    }],

    // ── Console operators (founders only): who can open the Command Deck and with which role ──
    ["GET", "/api/admin/console/operators", async (req, res) => {
      await needConsole(req, "founder");
      const table = await q(`select o.user_id as id, u.email, u.name, o.role, o.active, o.created_at, u.last_login_at, u.email_verified_at is not null as verified from operators o join users u on u.id = o.user_id order by o.created_at`);
      const env = O.operators().map((email) => ({ email, role: "founder", source: "PLATFORM_OPERATORS" }));
      sendJson(res, 200, { operators: table, env, roles: ["founder", "finance", "support", "analyst"] });
    }],
    ["POST", "/api/admin/console/operators", async (req, res) => {
      const { user } = await needConsole(req, "founder");
      const b = await readJson(req, 2000), email = normEmail(b.email || ""), role = String(b.role || "");
      if (!["founder", "finance", "support", "analyst"].includes(role)) fail(400, "Pick a role: founder, finance, support or analyst.");
      const u = await one(`select id, email_verified_at from users where email = $1`, [email]);
      if (!u) fail(404, `No White Petal account uses ${email || "that email"}. Ask them to sign up first.`, { code: "no_user" });
      if (!u.email_verified_at) fail(409, `${email} hasn't verified their email yet, so they can't be an operator.`, { code: "unverified" });
      await q(`insert into operators (user_id, role, active) values ($1, $2, true) on conflict (user_id) do update set role = excluded.role, active = true`, [u.id, role]);
      await O.audit(null, user.id, "console.operator_added", email, { role });
      sendJson(res, 200, { ok: true });
    }],
    ["PATCH", "/api/admin/console/operators/:id", async (req, res, p) => {
      const { user } = await needConsole(req, "founder");
      const b = await readJson(req, 2000);
      if (p.id === user.id) fail(409, "Ask another founder to change your own access.");
      if (b.role != null && !["founder", "finance", "support", "analyst"].includes(b.role)) fail(400, "Unknown role.");
      const r = await one(`update operators o set role = coalesce($2, o.role), active = coalesce($3, o.active) from users u where u.id = o.user_id and o.user_id::text = $1 returning u.email, o.role, o.active`,
        [p.id, b.role ?? null, typeof b.active === "boolean" ? b.active : null]);
      if (!r) fail(404, "No such operator.");
      await O.audit(null, user.id, "console.operator_changed", r.email, { role: r.role, active: r.active });
      sendJson(res, 200, { operator: r });
    }],
    ["DELETE", "/api/admin/console/operators/:id", async (req, res, p) => {
      const { user } = await needConsole(req, "founder");
      if (p.id === user.id) fail(409, "Ask another founder to remove your own access.");
      const r = await one(`delete from operators o using users u where u.id = o.user_id and o.user_id::text = $1 returning u.email`, [p.id]);
      if (!r) fail(404, "No such operator.");
      await O.audit(null, user.id, "console.operator_removed", r.email);
      sendJson(res, 200, { ok: true });
    }],

    // Snooze (days > 0) or mark done (days omitted) one item of the "needs you" feed.
    ["POST", "/api/admin/console/attention", async (req, res) => {
      const { user } = await needConsole(req, "founder", "support", "finance");
      const b = await readJson(req, 2000), key = String(b.key || "");
      if (!/^[a-z_]+:[a-z0-9-]+(:.*)?$/.test(key) || key.length > 200) fail(400, "Unknown item.");
      const days = b.days == null ? null : Number(b.days);
      if (days != null && !(days > 0 && days <= 30)) fail(400, "Snooze for 1 to 30 days.");
      await q(`insert into console_attention_state (key, snoozed_until, done_at, by_user) values ($1, $2, $3, $4)
               on conflict (key) do update set snoozed_until = excluded.snoozed_until, done_at = excluded.done_at, by_user = excluded.by_user`,
        [key, days ? new Date(Date.now() + days * 864e5) : null, days ? null : new Date(), user.id]);
      await O.audit(null, user.id, days ? "console.attention_snoozed" : "console.attention_done", key, days ? { days } : {});
      sendJson(res, 200, { ok: true });
    }],
  ];
}
