// A narrow Razorpay client: Subscriptions over REST, and webhook signature checks. Endpoints and event names follow
// razorpay.com/docs/api/payments/subscriptions and razorpay.com/docs/webhooks/subscriptions (checked 12 Oct 2026);
// recheck them there before changing anything here. `fetch` is injectable so tests run the whole lifecycle offline.
import crypto from "node:crypto";
import { PLANS, SELF_SERVE, CURRENCIES, withTax } from "./plans.mjs";

// HMAC-SHA256 of the exact bytes received, hex, compared in constant time. Never verify a re-serialised body.
export function verifyWebhook(raw, signature, secret) {
  if (!raw?.length || !signature || !secret) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// The checkout window hands the browser razorpay_payment_id, razorpay_subscription_id and razorpay_signature. The signature is
// HMAC-SHA256 of "payment_id|subscription_id" with the key secret (payment first). Verify it against the subscription id from OUR
// database, never the one the browser sent back.
export function verifyPaymentSignature(paymentId, subscriptionId, signature, secret) {
  if (!paymentId || !subscriptionId || !signature || !secret) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${paymentId}|${subscriptionId}`).digest("hex"));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// `base` is Razorpay's own host. Nothing in the environment can change it, so the key secret only ever goes there.
export function makeClient({ keyId, keySecret, fetch: doFetch = globalThis.fetch, base = "https://api.razorpay.com/v1" }) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  async function request(method, path, body) {
    const r = await doFetch(`${base}${path}`, {
      method, headers: { authorization: auth, "content-type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    // Every change we ask of Razorpay leaves one line (ids and status only, never keys or card data), so a plan change or cancel
    // can be traced to the request that carried it.
    if (method !== "GET") console.log(`[razorpay] ${method} ${path.split("?")[0]} -> ${r.status}${data?.status ? ` (${data.status})` : ""}`);
    if (!r.ok) throw Object.assign(new Error(`Razorpay ${r.status}: ${String(data.error?.description || "request failed").slice(0, 200)}`), { status: r.status });
    return data;
  }
  const sub = (id) => `/subscriptions/${encodeURIComponent(id)}`;
  return {
    // 120 monthly cycles is effectively "until cancelled": Razorpay needs a count or an end date.
    // startAt (unix seconds) delays the first charge: used to connect a payment method during the free trial without charging before it ends.
    // expire_by (documented): the last moment the customer can complete the authorisation. Without it an abandoned checkout stays payable
    // for 30 years, so an unpaid subscription is made to lapse after a day (and before a delayed start).
    // An operator-sent link (notifyEmail) stays payable for `validFor` seconds and Razorpay emails it to that address.
    // total_count: 120 monthly cycles or 10 yearly ones, effectively "until cancelled".
    createSubscription: ({ planId, orgId, plan, cycle = "monthly", startAt = null, notifyEmail = null, validFor = 86400, now = Math.floor(Date.now() / 1000) }) => request("POST", "/subscriptions", {
      plan_id: planId, total_count: cycle === "annual" ? 10 : 120, quantity: 1, customer_notify: true, notes: { white_petal_org_id: orgId, white_petal_plan: plan },
      expire_by: startAt ? Math.min(now + validFor, startAt - 300) : now + validFor, ...(startAt ? { start_at: startAt } : {}),
      ...(notifyEmail ? { notify_info: { notify_email: notifyEmail } } : {}),
    }),
    // Plans (step 2 of Razorpay's procedure): a reusable monthly billing cycle with an amount. They can't be edited afterwards.
    createPlan: ({ name, amount, currency, description = "", period = "monthly" }) => request("POST", "/plans", { period, interval: 1, item: { name, amount, currency, description } }),
    // A one-off charge added to the subscription's next invoice (Razorpay "add-ons"): how extra seats are billed, in arrears, each cycle.
    createAddon: (id, { name, amount, currency, description = "" }) => request("POST", `${sub(id)}/addons`, { item: { name, amount, currency, description }, quantity: 1 }),
    fetchPlan: (id) => request("GET", `/plans/${encodeURIComponent(id)}`),
    listPlans: () => request("GET", "/plans?count=100"),
    fetchSubscription: (id) => request("GET", sub(id)),
    cancelSubscription: (id, { atCycleEnd = true } = {}) => request("POST", `${sub(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 }),
    // Upgrades apply now; downgrades at the end of the cycle. A scheduled change can be withdrawn.
    updateSubscription: (id, { planId, at = "cycle_end" }) => request("PATCH", sub(id), { plan_id: planId, schedule_change_at: at }),
    cancelScheduledChanges: (id) => request("POST", `${sub(id)}/cancel_scheduled_changes`),
    // Every charge of a subscription is an invoice (its payment_id, amount, status and a hosted short_url).
    listInvoices: (subscriptionId) => request("GET", `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=50`),
    // amount in the smallest unit; omitted = full refund.
    refundPayment: (paymentId, { amount = null, notes = {} } = {}) => request("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { ...(amount ? { amount } : {}), speed: "normal", notes }),
  };
}

// Compare a Razorpay plan (as fetched) with a catalogue price: a monthly cycle, the price with tax (GST for INR) in the same currency.
export function planMismatches(rp, { amount }, currency, cycle = "monthly") {
  const out = [], period = cycle === "annual" ? "yearly" : "monthly";
  if (rp.period !== period || Number(rp.interval) !== 1) out.push(`it bills every ${rp.interval} ${rp.period}, not ${period}`);
  if (String(rp.item?.currency || "").toUpperCase() !== currency) out.push(`it is in ${rp.item?.currency}, not ${currency}`);
  else if (Number(rp.item?.amount) !== withTax(amount, currency)) out.push(`its amount is ${Number(rp.item?.amount) / 100}, the catalogue price with tax is ${withTax(amount, currency) / 100}`);
  return out;
}

// The server maps an internal plan and currency to a Razorpay plan id from its own catalogue (the database; operators enter the ids in
// Billing > Plan catalogue). An environment variable RAZORPAY_PLAN_<PLAN>_<CCY> is only a fallback. Browser input never supplies a
// plan id or an amount.
export function planIdFor(plan, currency, cycle = "monthly", env = process.env) {
  if (typeof cycle === "object") { env = cycle; cycle = "monthly"; } // planIdFor(plan, currency, env)
  if (!SELF_SERVE.includes(plan) || !CURRENCIES.includes(currency)) return null;
  if (cycle === "annual") return PLANS[plan]?.annualRazorpayIds?.[currency] || env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${currency}_ANNUAL`] || null;
  return PLANS[plan]?.razorpayIds?.[currency] || env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${currency}`] || null;
}
// The reverse, for webhooks: only ids this server was given count. Retired plans still resolve, so subscriptions already on them keep working.
export function planOf(planId, env = process.env) {
  if (!planId) return null;
  for (const p of Object.values(PLANS)) {
    for (const [currency, id] of Object.entries(p.razorpayIds)) if (id === planId) return { plan: p.code, currency, cycle: "monthly" };
    for (const [currency, ids] of Object.entries(p.retiredIds || {})) if (ids.includes(planId)) return { plan: p.code, currency, cycle: "monthly" };
    for (const [currency, id] of Object.entries(p.annualRazorpayIds || {})) if (id === planId) return { plan: p.code, currency, cycle: "annual" };
    for (const [currency, ids] of Object.entries(p.annualRetiredIds || {})) if (ids.includes(planId)) return { plan: p.code, currency, cycle: "annual" };
  }
  for (const plan of SELF_SERVE) for (const currency of CURRENCIES) {
    if (env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${currency}`] === planId) return { plan, currency, cycle: "monthly" };
    if (env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${currency}_ANNUAL`] === planId) return { plan, currency, cycle: "annual" };
  }
  return null;
}

// BILLING_ENABLED: 0 (default, checkout off), operators (platform operators only), 1 (owners).
export function billingConfig(env = process.env) {
  const enabled = ["0", "operators", "1"].includes(String(env.BILLING_ENABLED || "0")) ? String(env.BILLING_ENABLED || "0") : "0";
  const keyId = env.RAZORPAY_KEY_ID || "";
  return {
    enabled, keyId, keySecret: env.RAZORPAY_KEY_SECRET || "", webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || "",
    ready: !!(keyId && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET),
    testMode: keyId.startsWith("rzp_test_"),
    graceDays: Number(env.BILLING_GRACE_DAYS || 3), trialDays: Number(env.BILLING_TRIAL_DAYS || 7), contact: env.BILLING_CONTACT_EMAIL || "",
  };
}

let override = null;
// Tests swap in a fake; production builds a client from the environment on each use (keys can rotate).
export const setClient = (c) => { override = c; };
// A link Razorpay hands back (a payment page) is only passed on to the browser if it really is Razorpay's.
export const razorpayLink = (u) => { try { const x = new URL(u); return x.protocol === "https:" && (x.hostname === "rzp.io" || x.hostname.endsWith(".razorpay.com") || x.hostname === "razorpay.com") ? x.href : null; } catch { return null; } };
export function client() {
  if (override) return override;
  const c = billingConfig();
  if (!c.keyId || !c.keySecret) throw new Error("Razorpay keys are not configured.");
  return makeClient({ keyId: c.keyId, keySecret: c.keySecret });
}
