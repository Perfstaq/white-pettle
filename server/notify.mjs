// Account and billing emails. Each one is sent at most once per (organisation, kind, ref): the email_log row is claimed first, so a
// repeated webhook, a reconciliation that finds the same change, or two scheduler instances can't send it twice. Sending never
// throws into the caller: an email that fails is logged on its row and the request carries on.
import { q, one } from "./db.mjs";
import { noticeEmail } from "./mail.mjs";
import { PLANS, withTax } from "./plans.mjs";
import crypto from "node:crypto";

const day = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
// Buttons in these emails open the live app: APP_URL if set, else PUBLIC_ORIGIN when it is a real address, else production.
const LIVE = "https://os.perfstaq.com";
const appBase = () => process.env.APP_URL || (/localhost|127\.0\.0\.1/.test(process.env.PUBLIC_ORIGIN || "localhost") ? LIVE : process.env.PUBLIC_ORIGIN);
const appUrl = (hash = "") => `${appBase().replace(/\/$/, "")}/${hash}`;
const planName = (code) => PLANS[code]?.name || "your plan";
const price = (code, ccy) => {
  const a = PLANS[code]?.prices?.[ccy]; if (a == null || !ccy) return "";
  return new Intl.NumberFormat(ccy === "INR" ? "en-IN" : "en-US", { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(withTax(a, ccy) / 100);
};
const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);

// kind -> (data) -> { subject, title, paras, cta, link }
const T = {
  trial_started: (d) => ({ subject: "Your Perfstaq free trial has started", title: "Your free trial has started",
    paras: [`You have until ${day(d.ends)} to try Perfstaq. The trial includes one check of up to 20 prompts across ChatGPT, Perplexity and Gemini.`,
      // Started at sign-up with no plan picked (plan 'trial'): nothing to say about a plan or a payment method.
      ...(d.plan && d.plan !== "trial" ? [`${planName(d.plan)} starts when the trial ends. Nothing is charged until you connect a payment method.`] : [])],
    cta: "Add your website", link: appUrl() }),
  trial_check_used: (d) => ({ subject: "Your free trial check is done", title: "Your free trial check is done",
    paras: ["Your report is ready and stays readable. The free trial includes one check, so running your prompts again needs a plan.",
      `Subscribe to ${planName(d.plan)} and it starts today.`],
    cta: "Choose a plan", link: appUrl("#plans") }),
  trial_ending: (d) => ({ subject: `Your Perfstaq trial ends ${day(d.ends)}`, title: "Your free trial ends soon",
    paras: [`Your free trial ends on ${day(d.ends)}. Connect a payment method before then and ${planName(d.plan)} carries on without a break.`,
      "If you don't, the account becomes read-only. Your reports stay readable."],
    cta: "Choose a plan", link: appUrl("#plans") }),
  trial_ended: () => ({ subject: "Your Perfstaq trial has ended", title: "Your free trial has ended",
    paras: ["Your account is now read-only: your reports and past checks stay readable, but new checks, drafts and invites are paused.",
      "Choose a plan any time to pick up where you left off."],
    cta: "Choose a plan", link: appUrl("#plans") }),
  trial_cancelled: () => ({ subject: "Your Perfstaq trial is cancelled", title: "Your free trial is cancelled",
    paras: ["Nothing was charged, and nothing will be. Your reports and past checks stay readable.", "Subscribe any time to pick up where you left off."],
    cta: "See plans", link: appUrl("#plans") }),
  subscribed: (d) => ({ subject: `Welcome to Perfstaq ${planName(d.plan)}`, title: `You're on ${planName(d.plan)}`,
    paras: [`Your subscription is active${price(d.plan, d.ccy) ? ` at ${price(d.plan, d.ccy)} a month including GST` : ""}${d.periodEnd ? `, renewing on ${day(d.periodEnd)}` : ""}.`,
      "Razorpay emails the payment receipt separately. You can change or cancel the plan any time from Plans & payment."],
    cta: "Open Perfstaq", link: appUrl() }),
  plan_changed: (d) => ({ subject: `You're now on Perfstaq ${planName(d.plan)}`, title: `You're now on ${planName(d.plan)}`,
    paras: [`Your plan changed from ${planName(d.from)} to ${planName(d.plan)}. Its limits apply now.`, `Your renewal date stays ${day(d.periodEnd) || "the same"}.`],
    cta: "See your plan", link: appUrl("#plans") }),
  downgrade_scheduled: (d) => ({ subject: `Your move to Perfstaq ${planName(d.plan)} is scheduled`, title: `You'll move to ${planName(d.plan)} on ${day(d.on)}`,
    paras: [`Nothing is charged or refunded today. You keep everything in ${planName(d.from)} until ${day(d.on)}.`, "You can undo the change any time before then from Plans & payment."],
    cta: "See your plan", link: appUrl("#plans") }),
  cancel_scheduled: (d) => ({ subject: "Your Perfstaq subscription is cancelled", title: "Your subscription is cancelled",
    paras: [`You won't be charged again. ${planName(d.plan)} keeps working until ${day(d.until)}.`, "After that your reports stay readable. Subscribe again any time to pick up where you left off."],
    cta: "Keep my subscription", link: appUrl("#plans") }),
  subscription_ended: (d) => ({ subject: "Your Perfstaq subscription has ended", title: "Your subscription has ended",
    paras: [`${planName(d.plan)} has ended, so the account is read-only. Your reports and past checks stay readable.`, "Choose a plan any time to pick up where you left off."],
    cta: "Choose a plan", link: appUrl("#plans") }),
  payment_failed: (d) => ({ subject: "Your Perfstaq payment didn't go through", title: "Your payment didn't go through",
    paras: [`Razorpay couldn't charge your payment method for ${planName(d.plan)}. It will try again.`,
      `Update your payment method by ${day(d.graceEnds)} to keep scheduled checks running. After that the account becomes read-only.`],
    cta: "Fix payment", link: appUrl("#plans") }),
  weekly_results: (d) => resultsEmail(d),
};
export const KINDS = Object.keys(T);
// Kinds a person can turn off (the link at the bottom of each one). Account and billing notices can't be.
export const OPT_OUT_KINDS = ["weekly_results"];
export const unsubToken = (userId, kind) => crypto.createHmac("sha256", process.env.APP_SECRET || "dev-secret").update(`unsub:${userId}:${kind}`).digest("base64url");
const unsubUrl = (userId, kind) => `${appBase().replace(/\/$/, "")}/api/email/unsubscribe?u=${encodeURIComponent(userId)}&k=${kind}&t=${unsubToken(userId, kind)}`;

// The scheduled report: the headline numbers, then what changed since the last check, and the fixes checked on their own.
const ENGINE = { chatgpt: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini", groq: "Groq", aio: "AI Overviews", aimode: "AI Mode", claude: "Claude" };
const pts = (a, b) => (a == null || b == null ? "" : ` (${a >= b ? "up" : "down"} ${Math.abs(Math.round((a - b) * 100))} points)`);
function resultsEmail(d) {
  const s = d.s || {}, c = d.changes || {}, period = d.schedule === "daily" ? "daily" : "weekly", since = d.schedule === "daily" ? "since yesterday" : "since last week";
  const paras = [`Visibility ${pct(s.visibility)}${pts(s.visibility, d.prev?.visibility)}. Score ${s.score ?? "–"}/100. Share of voice ${pct(s.sov)}.`,
    s.leader ? `The most named brand was ${s.leader.name} at ${pct(s.leader.vis)}.` : "No other brand was named more often than you."];
  for (const o of c.overtook || []) paras.push(`${o.name} passed you this time: it was named in ${pct(o.vis)} of answers.`);
  const site = c.site || {}, siteItems = [];
  if (site.unblocked?.length) siteItems.push(`${site.unblocked.join(", ")} can read your site now.`);
  if (site.newlyBlocked?.length) siteItems.push(`${site.newlyBlocked.join(", ")} ${site.newlyBlocked.length > 1 ? "are" : "is"} now blocked in robots.txt.`);
  if (site.llms != null) siteItems.push(site.llms ? "llms.txt is live." : "llms.txt is gone.");
  if (site.avg != null && site.avgBefore != null && site.avg !== site.avgBefore) siteItems.push(`AI-readiness ${site.avg}/100 (was ${site.avgBefore}).`);
  const fixes = d.fixes || [];
  const sections = [
    { title: `Now named for (${(c.gained || []).length})`, items: (c.gained || []).map((x) => `“${x.text}” on ${x.engines.map((e) => ENGINE[e] || e).join(", ")}`) },
    { title: `No longer named for (${(c.lost || []).length})`, items: (c.lost || []).map((x) => `“${x.text}”`) },
    { title: "By engine", items: (c.engines || []).filter((e) => e.now != null).map((e) => `${ENGINE[e.engine] || e.engine}: ${pct(e.now)}${pts(e.now, e.before)}`) },
    { title: "Your site", items: siteItems },
    { title: "Fixes checked", items: fixes.map((f) => `${f.pass ? "Confirmed" : "Not yet"}: ${f.title}. ${f.detail}`) },
    { title: "Results after publishing", items: (d.observed || []).map((o) => `${o.title}: ${o.direction}${o.before && o.after ? ` (named in ${o.before.named} of ${o.before.total}, now ${o.after.named} of ${o.after.total})` : ""}`) },
  ];
  if (!c.gained?.length && !c.lost?.length && d.prev) paras.push(`No prompt changed between named and not named ${since}.`);
  return { subject: `${d.brand}: your ${period} AI visibility`, title: `${d.brand}: ${d.schedule === "daily" ? "today" : "this week"} in AI answers`, paras, sections,
    cta: "Open the report", link: appUrl(`#brand/${encodeURIComponent(d.slug || "")}`) };
}
// The rendered subject, title, paragraphs and link for one kind (previews and test sends).
export const preview = (kind, data = {}) => T[kind](data);

// Who gets it: the owner, or owners and admins (weekly results), minus anyone who turned this kind off.
async function recipients(orgId, admins, kind) {
  const rows = await q(`select u.id, u.email from memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.role = any($2)
      and not exists (select 1 from email_optouts x where x.user_id = u.id and x.kind = $3) order by m.role`, [orgId, admins ? ["owner", "admin"] : ["owner"], kind]);
  const seen = new Set(); return rows.filter((r) => r.email && !seen.has(r.email) && seen.add(r.email));
}

export async function notify(orgId, kind, ref, data = {}, { admins = false } = {}) {
  try {
    if (!T[kind] || !orgId) return { sent: false, reason: "unknown" };
    const claimed = await one(`insert into email_log (org_id, kind, ref) values ($1, $2, $3) on conflict do nothing returning org_id`, [orgId, kind, String(ref).slice(0, 200)]);
    if (!claimed) return { sent: false, reason: "already sent" };
    const people = await recipients(orgId, admins, kind), to = people.map((r) => r.email), m = T[kind](data);
    const results = await Promise.all(people.map((r) => noticeEmail({ to: r.email, ...m, unsubscribe: OPT_OUT_KINDS.includes(kind) ? unsubUrl(r.id, kind) : null })));
    const sent = results.some((r) => r?.sent), error = results.find((r) => !r?.sent)?.reason || null;
    // Not delivered to anyone (Resend refused or isn't configured): release the claim, so the hourly sweep can try a trial email again.
    if (!sent) await q(`delete from email_log where org_id = $1 and kind = $2 and ref = $3`, [orgId, kind, String(ref).slice(0, 200)]);
    else await q(`update email_log set sent_to = $4, status = 'sent', error = $5 where org_id = $1 and kind = $2 and ref = $3`, [orgId, kind, String(ref).slice(0, 200), to, error]);
    if (!sent) console.warn(`[notify] ${kind} not sent: ${error || "no recipient"}`);
    return { sent, to };
  } catch (e) { console.warn(`[notify] ${kind}:`, e.message); return { sent: false, reason: e.message }; }
}

// What a change of billing state means for the customer, after it is saved: the same for a webhook and for a reconciliation.
export async function billingChanged(before, patch) {
  if (!before || !patch) return;
  const status = patch.billing_status || before.billing_status, plan = patch.plan_code || before.plan_code, sub = patch.razorpay_subscription_id || before.razorpay_subscription_id || "";
  const periodEnd = patch.current_period_end || before.current_period_end, ccy = patch.billing_currency || before.billing_currency;
  // A new subscription (from a trial, no plan or a cancelled one); a payment fixed after a failure is not a welcome (Razorpay sends the receipt).
  if (status === "active" && !["active", "past_due"].includes(before.billing_status)) await notify(before.id, "subscribed", `${sub}:${plan}`, { plan, ccy, periodEnd });
  else if (status === "active" && before.billing_status === "active" && patch.plan_code && patch.plan_code !== before.plan_code)
    await notify(before.id, "plan_changed", `${sub}:${plan}:${day(new Date())}`, { plan, from: before.plan_code, periodEnd });
  if (status === "past_due" && before.billing_status !== "past_due") await notify(before.id, "payment_failed", `${sub}:${day(patch.grace_ends_at || new Date())}`, { plan, graceEnds: patch.grace_ends_at || before.grace_ends_at });
  if (status === "canceled" && before.billing_status !== "canceled") await notify(before.id, "subscription_ended", sub || day(new Date()), { plan });
}

// From the scheduler tick: trials ending within two days without a payment method, and trials that have ended. Small batches.
export async function trialSweep() {
  const ending = await q(`select id, plan_code, trial_ends_at from organizations o where billing_status = 'trialing' and razorpay_subscription_id is null
      and trial_ends_at > now() and trial_ends_at <= now() + interval '2 days'
      and not exists (select 1 from email_log l where l.org_id = o.id and l.kind = 'trial_ending') limit 50`);
  for (const o of ending) await notify(o.id, "trial_ending", day(o.trial_ends_at), { ends: o.trial_ends_at, plan: o.plan_code });
  const ended = await q(`select id, trial_ends_at from organizations o where billing_status = 'trialing' and razorpay_subscription_id is null
      and trial_ends_at <= now() and trial_ends_at > now() - interval '7 days'
      and not exists (select 1 from email_log l where l.org_id = o.id and l.kind = 'trial_ended') limit 50`);
  for (const o of ended) await notify(o.id, "trial_ended", day(o.trial_ends_at));
  return { ending: ending.length, ended: ended.length };
}
