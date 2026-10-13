// The Razorpay client's wire shape, checked without a network: exact URLs, methods, auth and bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeClient, verifyWebhook, verifyPaymentSignature, planIdFor, planOf, billingConfig, razorpayLink } from "../../server/razorpay.mjs";

const recorder = (reply = { id: "sub_1" }, status = 200) => { const calls = []; const fetch = async (url, init) => { calls.push({ url, ...init, body: init.body && JSON.parse(init.body) }); return { ok: status < 400, status, json: async () => reply }; }; return { calls, fetch }; };
const rz = (fetch, extra = {}) => makeClient({ keyId: "rzp_test_k", keySecret: "s3cret", fetch, ...extra });

test("requests: URL, method, basic auth and body for every call", async () => {
  const { calls, fetch } = recorder(); const c = rz(fetch);
  await c.createSubscription({ planId: "plan_1", orgId: "org-1", plan: "growth" });
  await c.fetchSubscription("sub_1"); await c.cancelSubscription("sub_1"); await c.cancelSubscription("sub_1", { atCycleEnd: false });
  await c.updateSubscription("sub_1", { planId: "plan_2", at: "now" }); await c.updateSubscription("sub_1", { planId: "plan_2" }); await c.cancelScheduledChanges("sub_1");
  const base = "https://api.razorpay.com/v1";
  assert.deepEqual(calls.map((x) => [x.method, x.url.replace(base, "")]), [["POST", "/subscriptions"], ["GET", "/subscriptions/sub_1"], ["POST", "/subscriptions/sub_1/cancel"], ["POST", "/subscriptions/sub_1/cancel"],
    ["PATCH", "/subscriptions/sub_1"], ["PATCH", "/subscriptions/sub_1"], ["POST", "/subscriptions/sub_1/cancel_scheduled_changes"]]);
  assert.equal(calls[0].headers.authorization, "Basic " + Buffer.from("rzp_test_k:s3cret").toString("base64"));
  assert.equal(calls[0].body.expire_by - Math.floor(Date.now() / 1000) > 86300, true, "unpaid checkouts lapse after a day");
  delete calls[0].body.expire_by; assert.deepEqual(calls[0].body, { plan_id: "plan_1", total_count: 120, quantity: 1, customer_notify: true, notes: { white_petal_org_id: "org-1", white_petal_plan: "growth" } });
  const trial = recorder(); await rz(trial.fetch).createSubscription({ planId: "p", orgId: "o", plan: "growth", startAt: 2000000000, now: 1999000000 });
  assert.deepEqual([trial.calls[0].body.start_at, trial.calls[0].body.expire_by], [2000000000, 1999000000 + 86400], "a day to authorise, well before a distant start");
  const soon = recorder(); await rz(soon.fetch).createSubscription({ planId: "p", orgId: "o", plan: "growth", startAt: 1999990200, now: 1999990000 });
  assert.equal(soon.calls[0].body.expire_by, 1999990200 - 300);
  assert.deepEqual(calls[2].body, { cancel_at_cycle_end: 1 }); assert.deepEqual(calls[3].body, { cancel_at_cycle_end: 0 });
  assert.deepEqual(calls[4].body, { plan_id: "plan_2", schedule_change_at: "now" }); assert.deepEqual(calls[5].body, { plan_id: "plan_2", schedule_change_at: "cycle_end" });
  assert.equal(calls[1].body, undefined);
});
test("ids are URL-encoded, the API base is overridable, and errors carry the status without leaking the body", async () => {
  const { calls, fetch } = recorder(); await rz(fetch, { base: "http://127.0.0.1:9/v1" }).fetchSubscription("sub/../x");
  assert.equal(calls[0].url, "http://127.0.0.1:9/v1/subscriptions/sub%2F..%2Fx");
  const bad = recorder({ error: { description: "The id provided does not exist" } }, 400);
  await assert.rejects(rz(bad.fetch).fetchSubscription("nope"), (e) => e.status === 400 && /does not exist/.test(e.message));
  const huge = recorder({ error: { description: "x".repeat(5000) } }, 500);
  await assert.rejects(rz(huge.fetch).fetchSubscription("a"), (e) => e.message.length < 260);
});
test("webhook signature: exact bytes, constant time, rejects anything else", () => {
  const raw = Buffer.from('{"event":"subscription.charged"}'), good = crypto.createHmac("sha256", "wh").update(raw).digest("hex");
  assert.equal(verifyWebhook(raw, good, "wh"), true);
  assert.equal(verifyWebhook(Buffer.from('{"event":"subscription.charged" }'), good, "wh"), false, "a re-serialised body fails");
  for (const bad of [[raw, "", "wh"], [raw, good, ""], [raw, good.slice(1), "wh"], [raw, good + "0", "wh"], [Buffer.alloc(0), good, "wh"], [raw, undefined, "wh"], [raw, "x", "wh"]]) assert.equal(verifyWebhook(...bad), false);
});
test("checkout callback signature is HMAC of payment_id|subscription_id (payment first)", () => {
  const sig = crypto.createHmac("sha256", "key").update("pay_1|sub_1").digest("hex");
  assert.equal(verifyPaymentSignature("pay_1", "sub_1", sig, "key"), true);
  assert.equal(verifyPaymentSignature("sub_1", "pay_1", sig, "key"), false, "order matters");
  assert.equal(verifyPaymentSignature("pay_1", "sub_2", sig, "key"), false);
  assert.equal(verifyPaymentSignature("pay_1", "sub_1", sig, "other"), false);
  assert.equal(verifyPaymentSignature("", "sub_1", sig, "key"), false);
});
test("plan ids map both ways, only for configured self-serve plans and currencies", () => {
  const env = { RAZORPAY_PLAN_GROWTH_INR: "plan_g", RAZORPAY_PLAN_STARTER_USD: "plan_s" };
  assert.equal(planIdFor("growth", "INR", env), "plan_g"); assert.equal(planIdFor("agency", "INR", env), null);
  assert.equal(planIdFor("enterprise", "INR", { RAZORPAY_PLAN_ENTERPRISE_INR: "x" }), null); assert.equal(planIdFor("growth", "EUR", env), null);
  assert.deepEqual(planOf("plan_s", env), { plan: "starter", currency: "USD" }); assert.equal(planOf("plan_x", env), null); assert.equal(planOf("", env), null); assert.equal(planOf(undefined, env), null);
});
test("billing config: unknown flag values mean off; ready needs all three keys", () => {
  assert.equal(billingConfig({}).enabled, "0"); assert.equal(billingConfig({ BILLING_ENABLED: "yes" }).enabled, "0");
  assert.equal(billingConfig({ BILLING_ENABLED: "operators" }).enabled, "operators"); assert.equal(billingConfig({ BILLING_ENABLED: "1" }).enabled, "1");
  assert.equal(billingConfig({ RAZORPAY_KEY_ID: "rzp_test_a", RAZORPAY_KEY_SECRET: "b" }).ready, false);
  const c = billingConfig({ RAZORPAY_KEY_ID: "rzp_test_a", RAZORPAY_KEY_SECRET: "b", RAZORPAY_WEBHOOK_SECRET: "c" }); assert.equal(c.ready, true); assert.equal(c.testMode, true);
  assert.equal(billingConfig({}).graceDays, 3); assert.equal(billingConfig({}).trialDays, 7);
});

test("plans API: a monthly plan at the catalogue price, and what counts as a mismatch", async () => {
  const { calls, fetch } = recorder({ id: "plan_X" }); const c = rz(fetch);
  await c.createPlan({ name: "Growth (INR monthly)", amount: 999900, currency: "INR", description: "d" }); await c.fetchPlan("plan_X");
  assert.deepEqual([calls[0].method, calls[0].url.replace("https://api.razorpay.com/v1", "")], ["POST", "/plans"]);
  assert.deepEqual(calls[0].body, { period: "monthly", interval: 1, item: { name: "Growth (INR monthly)", amount: 999900, currency: "INR", description: "d" } });
  assert.equal(calls[1].url.endsWith("/plans/plan_X"), true);
  const { planMismatches } = await import("../../server/razorpay.mjs");
  const ok = { period: "monthly", interval: 1, item: { amount: 1179882, currency: "INR" } }; // ₹9,999 + 18% GST
  assert.deepEqual(planMismatches(ok, { amount: 999900 }, "INR"), []);
  assert.match(planMismatches({ ...ok, item: { amount: 999900, currency: "INR" } }, { amount: 999900 }, "INR")[0], /price with tax is 11798.82/, "a plan without GST is a mismatch");
  assert.deepEqual(planMismatches({ ...ok, item: { amount: 9900, currency: "USD" } }, { amount: 9900 }, "USD"), [], "no GST outside India");
  assert.match(planMismatches({ ...ok, period: "yearly" }, { amount: 999900 }, "INR")[0], /not monthly/); assert.match(planMismatches({ ...ok, interval: 3 }, { amount: 999900 }, "INR")[0], /every 3 monthly/);
  assert.match(planMismatches({ ...ok, item: { amount: 1, currency: "INR" } }, { amount: 999900 }, "INR")[0], /amount is 0.01/); assert.match(planMismatches({ ...ok, item: { amount: 1179882, currency: "usd" } }, { amount: 999900 }, "INR")[0], /in usd, not INR/);
});

test("a payment link is passed on only if it is really Razorpay's", () => {
  assert.equal(razorpayLink("https://rzp.io/i/abc"), "https://rzp.io/i/abc");
  assert.equal(razorpayLink("https://pages.razorpay.com/x"), "https://pages.razorpay.com/x");
  for (const bad of ["http://rzp.io/i/abc", "https://rzp.io.evil.example/", "https://evilrazorpay.com/", "javascript:alert(1)", null, undefined, ""]) assert.equal(razorpayLink(bad), null, String(bad));
});

test("UPI Autopay only up to the ₹15,000 recurring limit (with GST): Starter and Growth yes, Agency no", async () => {
  const { upiAllowed } = await import("../../server/plans.mjs");
  assert.equal(upiAllowed(499900, "INR"), true); assert.equal(upiAllowed(999900, "INR"), true);
  assert.equal(upiAllowed(2499900, "INR"), false); assert.equal(upiAllowed(1271186, "INR"), true, "₹14,999.99 with GST is still allowed, a paisa more is not"); assert.equal(upiAllowed(1271187, "INR"), false);
  assert.equal(upiAllowed(4900, "USD"), false, "no UPI outside India");
});
