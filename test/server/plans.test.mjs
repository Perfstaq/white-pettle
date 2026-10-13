// The plan catalogue and the pure access rules. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLANS, SELF_SERVE, CURRENCIES, DRAFT_KINDS, effectiveEntitlements, nextPlan, publicPlans } from "../../server/plans.mjs";
import { accessMode, periodStart } from "../../server/billing.mjs";

test("every self-serve plan has a positive integer price in every currency", () => {
  for (const code of SELF_SERVE) for (const ccy of CURRENCIES) {
    const p = PLANS[code].prices[ccy]; assert.ok(Number.isInteger(p) && p > 0, `${code} ${ccy}`);
  }
});

test("plans get strictly more generous up the ladder", () => {
  const order = ["starter", "growth", "agency", "enterprise"];
  for (let i = 1; i < order.length; i++) {
    const a = PLANS[order[i - 1]], b = PLANS[order[i]];
    for (const ccy of CURRENCIES) assert.ok(b.prices[ccy] > a.prices[ccy]);
    for (const k of ["brands", "questions", "competitors", "seats", "drafts"]) assert.ok(b.entitlements[k] >= a.entitlements[k], k);
    assert.ok(b.entitlements.engines.length >= a.entitlements.engines.length);
  }
  assert.deepEqual([...DRAFT_KINDS].sort(), ["article", "fixpack", "pitch"]);
});

test("the public catalogue exposes no internal budget and no Infinity", () => {
  const s = JSON.stringify(publicPlans());
  assert.ok(!/capUsd|razorpay|Infinity/i.test(s));
  assert.equal(JSON.parse(s).length, 4);
});

test("unknown plan gets the tightest limits; overrides apply until they expire", () => {
  assert.equal(effectiveEntitlements("nonsense").seats, PLANS.trial.entitlements.seats);
  const now = new Date("2026-10-12T00:00:00Z");
  assert.equal(effectiveEntitlements("growth", { values: { seats: 50 }, expiresAt: "2026-11-01T00:00:00Z" }, now).seats, 50);
  assert.equal(effectiveEntitlements("growth", { values: { seats: 50 }, expiresAt: "2026-10-01T00:00:00Z" }, now).seats, 5);
  assert.equal(nextPlan("starter"), "growth");
});

test("access modes: trial, grace, cancelled and unknown", () => {
  const now = new Date("2026-10-12T12:00:00Z"), future = "2026-10-20T00:00:00Z", past = "2026-10-01T00:00:00Z";
  assert.equal(accessMode({ billing_status: "internal" }, now), "write");
  assert.equal(accessMode({ billing_status: "active" }, now), "write");
  assert.equal(accessMode({ billing_status: "trialing", trial_ends_at: future }, now), "write");
  assert.equal(accessMode({ billing_status: "trialing", trial_ends_at: past }, now), "read");
  assert.equal(accessMode({ billing_status: "trialing" }, now), "read");
  assert.equal(accessMode({ billing_status: "past_due", grace_ends_at: future }, now), "manual");
  assert.equal(accessMode({ billing_status: "past_due", grace_ends_at: past }, now), "read");
  assert.equal(accessMode({ billing_status: "canceled", current_period_end: future }, now), "write");
  assert.equal(accessMode({ billing_status: "canceled", current_period_end: past }, now), "read");
  assert.equal(accessMode({ billing_status: "weird" }, now), "read");
  assert.equal(accessMode(null, now), "read");
});

test("allowances count from the plan period, not the calendar month", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  assert.equal(periodStart({ billing_status: "active", current_period_start: "2026-09-25T00:00:00Z" }, now).toISOString(), "2026-09-25T00:00:00.000Z");
  assert.equal(periodStart({ billing_status: "trialing", trial_started_at: "2026-10-10T00:00:00Z" }, now).toISOString(), "2026-10-10T00:00:00.000Z");
  assert.equal(periodStart({ billing_status: "internal" }, now).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("access backstops: a lost cancellation or an expired operator grant can't give free access", () => {
  const now = new Date("2026-10-12T12:00:00Z"), d = (iso) => iso;
  // cancel requested, period ended more than a day ago, no cancelled webhook ever arrived
  assert.equal(accessMode({ billing_status: "active", razorpay_subscription_id: "s", cancel_at_period_end: true, current_period_end: d("2026-10-10T00:00:00Z") }, now), "read");
  assert.equal(accessMode({ billing_status: "active", razorpay_subscription_id: "s", cancel_at_period_end: true, current_period_end: d("2026-10-12T00:00:00Z") }, now), "write", "one day of slack");
  assert.equal(accessMode({ billing_status: "active", razorpay_subscription_id: "s", cancel_at_period_end: false, current_period_end: d("2026-10-10T00:00:00Z") }, now), "write", "renewal pending: webhook/reconcile decide");
  // operator grant: active without a Razorpay subscription ends on its date
  assert.equal(accessMode({ billing_status: "active", razorpay_subscription_id: null, current_period_end: d("2026-10-11T00:00:00Z") }, now), "read");
  assert.equal(accessMode({ billing_status: "active", razorpay_subscription_id: null, current_period_end: d("2026-11-11T00:00:00Z") }, now), "write");
});

import { metricsFor } from "../../server/usage.mjs";
import { meterState, usageReport } from "../../server/billing.mjs";
import { cleanPlan, flatOf, DEFAULT_PLANS, applyCatalogue } from "../../server/plans.mjs";

test("recorder: which counters an event adds to", () => {
  const names = (e) => metricsFor({ n: 1, costUsd: 0.01, ...e }).map(([m]) => m);
  assert.deepEqual(names({ kind: "ask" }), ["ai_usd", "calls", "ask"]);
  assert.deepEqual(names({ kind: "write", sub: "pitch" }), ["ai_usd", "calls", "write", "drafts"]);
  for (const sub of ["article", "fixpack"]) assert.ok(names({ kind: "write", sub }).includes("drafts"));
  for (const sub of ["chat", "insights", "topics", null]) assert.ok(!names({ kind: "write", sub }).includes("drafts"), String(sub));
  assert.deepEqual(metricsFor({ kind: "ask", n: 3, costUsd: 0.04 }), [["ai_usd", 0.04], ["calls", 3], ["ask", 3]]);
});

test("reader: states, remaining and the period, compared with the plan", () => {
  assert.equal(meterState(3, 10), "ok"); assert.equal(meterState(8, 10), "warn"); assert.equal(meterState(10, 10), "full"); assert.equal(meterState(11, 10), "over");
  assert.equal(meterState(99, null), "unlimited"); assert.equal(meterState(0, 0), "full");
  const org = { billing_status: "active", current_period_start: "2026-10-01T00:00:00Z", current_period_end: "2026-11-01T00:00:00Z" };
  const ent = { brands: 1, questions: 30, seats: 5, drafts: 30, competitors: 5, samples: 1, engines: ["chatgpt"], schedule: ["off", "weekly"], integrations: "all" };
  const r = usageReport({ org, ent, used: { brands: 1, questions: 12, seats: 6, drafts: 24 } }, { pct: 0.5, warn: false, over: false, source: "plan" });
  const by = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
  assert.deepEqual([by.brands.state, by.questions.state, by.seats.state, by.drafts.state], ["full", "ok", "over", "warn"]);
  assert.equal(by.questions.remaining, 18); assert.equal(by.seats.remaining, 0); assert.equal(by.drafts.remaining, 6); assert.equal(by.questions.pct, 0.4);
  assert.deepEqual(r.over, ["seats"]); assert.equal(r.period.kind, "plan"); assert.equal(r.ai.state, "ok"); assert.equal(r.features.integrations, "all");
  const unl = usageReport({ org: { billing_status: "internal" }, ent: { ...ent, brands: Infinity, questions: Infinity, seats: Infinity, drafts: Infinity }, used: { brands: 40 } });
  assert.ok(unl.metrics.every((m) => m.state === "unlimited" && m.limit === null && m.remaining === null)); assert.equal(unl.period.kind, "month");
});

test("catalogue: defaults round-trip, validation, partial edits keep limits, replaced Razorpay ids are retired", () => {
  for (const d of DEFAULT_PLANS) assert.deepEqual(JSON.parse(JSON.stringify(roundTrip(d))), JSON.parse(JSON.stringify({ ...d, prices: Object.fromEntries(Object.entries(d.prices).map(([c, v]) => [c, { ...v, retired: [] }])) })));
  const base = roundTrip(DEFAULT_PLANS.find((p) => p.code === "growth"));
  const bad = (b, re) => assert.throws(() => cleanPlan("growth", b, base), (e) => e.status === 400 && re.test(e.message), JSON.stringify(b));
  bad({ limits: { brands: -1 } }, /whole number/); bad({ limits: { seats: 1.5 } }, /whole number/); bad({ engines: ["bard"] }, /not one of/); bad({ schedules: ["hourly"] }, /not one of/);
  bad({ integrations: ["myspace"] }, /not one of/); bad({ prices: { rupees: { amount: 1 } } }, /currency code/); bad({ prices: { INR: { amount: -5 } } }, /whole number/);
  bad({ prices: { INR: { amount: 100, razorpayPlanId: "price_abc123456" } } }, /should look like plan_/); bad({ name: "" }, /required/); bad({ aiCapUsd: -3 }, /AI allowance/);
  assert.throws(() => cleanPlan("Bad Code", {}, null), /lowercase/); assert.throws(() => cleanPlan("x", {}, null), /lowercase/);
  assert.throws(() => cleanPlan("solo", { name: "Solo", selfServe: true, prices: {} }, null), /needs a price/);
  // a partial edit keeps what it didn't mention; unlimited has to be explicit
  const e = cleanPlan("growth", { limits: { drafts: 50 } }, base); assert.equal(e.limits.drafts, 50); assert.equal(e.limits.brands, 1); assert.deepEqual(e.engines, base.engines);
  assert.equal(cleanPlan("growth", { limits: { drafts: null } }, base).limits.drafts, null); assert.equal(cleanPlan("growth", { limits: { drafts: "" } }, base).limits.drafts, null);
  assert.deepEqual(cleanPlan("growth", { schedules: ["weekly"] }, base).schedules, ["off", "weekly"], "off is always allowed");
  // Razorpay plans can't be edited upstream: a new id retires the old, and the old keeps resolving
  const withId = cleanPlan("growth", { prices: { INR: { amount: 999900, razorpayPlanId: "plan_OldOldOld1" } } }, base);
  const swapped = cleanPlan("growth", { prices: { INR: { amount: 1099900, razorpayPlanId: "plan_NewNewNew1" } } }, withId);
  assert.deepEqual(swapped.prices.INR.retired, ["plan_OldOldOld1"]);
  const back = cleanPlan("growth", { prices: { INR: { amount: 999900, razorpayPlanId: "plan_OldOldOld1" } } }, swapped); assert.deepEqual(back.prices.INR.retired, ["plan_NewNewNew1"]);
});
// flat -> the live catalogue view -> flat again
function roundTrip(d) { applyCatalogue([d]); const out = flatOf(PLANS[d.code]); applyCatalogue(DEFAULT_PLANS); return out; }

test("upgrade suggestions follow the catalogue order, and trials go to the featured plan", () => {
  applyCatalogue(DEFAULT_PLANS);
  assert.equal(nextPlan("trial"), "growth"); assert.equal(nextPlan("legacy"), "growth"); assert.equal(nextPlan("starter"), "growth"); assert.equal(nextPlan("growth"), "agency");
  assert.equal(nextPlan("agency"), "enterprise"); assert.equal(nextPlan("enterprise"), "enterprise"); assert.equal(nextPlan("nonsense"), "growth");
});
