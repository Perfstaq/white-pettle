// The Command Deck's metric rules (docs/founder-console-plan.md §12), without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCatalogue, DEFAULT_PLANS } from "../../server/plans.mjs";
import { mrrOf, marginPct, health, attention, toInrMinor, liveTrial } from "../../server/console.mjs";

applyCatalogue(DEFAULT_PLANS);

test("MRR counts only paying organisations, at the plan's price in their currency", () => {
  assert.equal(mrrOf({ billing_status: "active", plan_code: "growth", billing_currency: "INR" }), 999900);
  assert.equal(mrrOf({ billing_status: "past_due", plan_code: "starter", billing_currency: "USD" }), 4900);
  for (const s of ["trialing", "canceled", "internal", "new"]) assert.equal(mrrOf({ billing_status: s, plan_code: "growth", billing_currency: "INR" }), 0, s);
  assert.equal(toInrMinor(4900, "USD"), 4900 * 84);
});

test("trials: only a trial whose end is still ahead counts; an ended, unpaid one keeps its status but isn't a trial", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(liveTrial({ billing_status: "trialing", trial_ends_at: "2026-10-16T00:00:00Z" }, now), true);
  assert.equal(liveTrial({ billing_status: "trialing", trial_ends_at: "2026-10-14T00:00:00Z" }, now), false);
  assert.equal(liveTrial({ billing_status: "active", trial_ends_at: "2026-10-16T00:00:00Z" }, now), false);
});

test("margin is revenue before tax minus AI cost, over revenue; none without revenue", () => {
  assert.equal(marginPct(840000, "INR", 25), 75);        // ₹8,400 = $100 at 84
  assert.equal(marginPct(10000, "USD", 150), -50);
  assert.equal(marginPct(0, "INR", 3), null);
});

test("health: weights add to 100, a perfect org scores 100, a dormant past-due one is Dormant", () => {
  const top = health({ checks14: 5, actions14: 9, members: 3, seatLimit: 3, integrations: 4, capUsd: 10, spentUsd: 0, billing_status: "active", lastLoginDays: 0 });
  assert.equal(top.score, 100); assert.equal(top.band, "Thriving");
  const low = health({ checks14: 0, actions14: 0, members: 1, seatLimit: 5, integrations: 0, capUsd: 10, spentUsd: 10, billing_status: "past_due", lastLoginDays: 40 });
  assert.equal(low.band, "Dormant");
  assert.equal(health({ members: 2, seatLimit: null }).parts.seats, 1, "unlimited seats count as full");
});

test("attention: payment failures first, dormant trials flagged, budgets and spikes caught, quiet orgs ignored", () => {
  const now = Date.parse("2026-10-15T12:00:00Z"), base = { checks_all: 3, failed3: 0, spent_usd: 0, spent_day: 0, spent_day_avg: 0, mrrInr: 0, planName: "Growth" };
  const items = attention([
    { ...base, slug: "quiet", name: "Quiet", billing_status: "active", mrrInr: 999900, margin: 80, capUsd: 14, razorpay_subscription_id: "s", billing_reconciled_at: new Date(now) },
    { ...base, slug: "trial", name: "Trial", billing_status: "trialing", trial_ends_at: new Date(now + 864e5), checks_all: 0 },
    { ...base, slug: "late", name: "Late", billing_status: "past_due", mrrInr: 999900 },
    { ...base, slug: "spend", name: "Spend", billing_status: "active", capUsd: 10, spent_usd: 9, spent_day: 3, spent_day_avg: 0.4, margin: 50 },
  ], now);
  assert.equal(items[0].rule, "payment_failed");
  assert.ok(items.some((i) => i.rule === "trial_dormant" && i.slug === "trial"));
  assert.ok(items.some((i) => i.rule === "budget_near" && i.slug === "spend"));
  assert.ok(items.some((i) => i.rule === "cost_spike" && i.slug === "spend"));
  assert.ok(!items.some((i) => i.slug === "quiet"));
});

import { findings, cohortTable } from "../../server/console.mjs";

test("cohorts: % of each sign-up week active in each following week; future weeks left off", () => {
  const wk = "2026-09-07T00:00:00Z", now = Date.parse("2026-09-28T12:00:00Z"); // week 3 has started
  const rows = [{ wk, ks: [0, 1, 3] }, { wk, ks: [0] }, { wk, ks: [] }, { wk, ks: [0, 1] }];
  const [c] = cohortTable(rows, now);
  assert.equal(c.size, 4); assert.deepEqual(c.weeks, [75, 50, 0, 25]);
});

test("findings: names the worst activation step, ignores the landing page for 'most used', flags concentration", () => {
  const f = findings({
    activation: { orgs: 100, checked: 40, drafted: 36, acted: 30, checked_1d: 10, checked_7d: 30, h_to_check: 30 },
    adoption: [{ page: "overview", pct: 100, users: 50, orgs: 20 }, { page: "prompts", pct: 70, users: 35, orgs: 15 }, { page: "fanouts", pct: 4, users: 2, orgs: 1 }],
    cohorts: [], revenue: { total: 100, top5: 62, largest: [{ name: "Acme" }, { name: "Beta" }] }, northStar: [], devices: [],
  });
  const t = f.map((x) => x.title).join(" | ");
  assert.match(t, /Biggest drop-off: sign up → first check/);
  assert.match(t, /Most used after the overview: prompts/);
  assert.match(t, /1 page is used by under 10%/);
  assert.match(t, /top 5 customers are 62% of MRR/);
});

import { cleanPlan, flatOf, PLANS, monthlyEquivalent, trialDaysFor } from "../../server/plans.mjs";
import { planMismatches } from "../../server/razorpay.mjs";

test("plan parameters: annual price, trial length and extra seats validate, and older editors don't wipe them", () => {
  const base = flatOf(PLANS.growth);
  const f = cleanPlan("growth", { prices: { INR: { amount: 999900, annualAmount: 9999000, annualRazorpayPlanId: "plan_Annual12345", seatAmount: 50000 } }, trialDays: 14, maxExtraSeats: 20 }, base);
  assert.equal(f.prices.INR.annualAmount, 9999000); assert.equal(f.prices.INR.seatAmount, 50000); assert.equal(f.trialDays, 14); assert.equal(f.maxExtraSeats, 20);
  const old = cleanPlan("growth", { prices: { INR: { amount: 999900 } } }, f); // the app's older editor sends only the monthly price
  assert.equal(old.prices.INR.annualAmount, 9999000); assert.equal(old.prices.INR.annualRazorpayPlanId, "plan_Annual12345"); assert.equal(old.trialDays, 14);
  const cleared = cleanPlan("growth", { prices: { INR: { amount: 999900, annualAmount: null } }, trialDays: null }, f);
  assert.equal(cleared.prices.INR.annualAmount, null); assert.equal(cleared.prices.INR.annualRazorpayPlanId, null, "no annual price, no annual plan"); assert.equal(cleared.trialDays, null);
  const moved = cleanPlan("growth", { prices: { INR: { amount: 999900, annualAmount: 9999000, annualRazorpayPlanId: "plan_Annual99999" } } }, f);
  assert.deepEqual(moved.prices.INR.annualRetired, ["plan_Annual12345"], "a replaced annual id is retired, so its subscribers keep resolving");
  for (const bad of [{ trialDays: 91 }, { trialDays: -1 }, { maxExtraSeats: -2 }, { prices: { INR: { amount: 1, annualAmount: -5 } } }, { prices: { INR: { amount: 1, annualRazorpayPlanId: "nope" } } },
    { prices: { INR: { amount: 1, razorpayPlanId: "plan_Same123456", annualAmount: 10, annualRazorpayPlanId: "plan_Same123456" } } }]) assert.throws(() => cleanPlan("growth", bad, base), JSON.stringify(bad));
});

test("cycles: annual counts a twelfth per month; trial length falls back to the default; yearly plans are checked as yearly", () => {
  PLANS.growth.annualPrices = { INR: 9999000 }; PLANS.growth.seatPrices = { INR: 50000 }; PLANS.growth.trialDays = 14;
  try {
    assert.equal(monthlyEquivalent("growth", "INR", "annual"), 833250); assert.equal(monthlyEquivalent("growth", "INR"), 999900);
    assert.equal(mrrOf({ billing_status: "active", plan_code: "growth", billing_currency: "INR", billing_cycle: "annual", extra_seats: 2 }), 833250 + 2 * 50000);
    assert.equal(trialDaysFor("growth", 7), 14); assert.equal(trialDaysFor("starter", 7), 7);
    assert.deepEqual(planMismatches({ period: "yearly", interval: 1, item: { currency: "INR", amount: Math.round(9999000 * 1.18) } }, { amount: 9999000 }, "INR", "annual"), []);
    assert.equal(planMismatches({ period: "monthly", interval: 1, item: { currency: "INR", amount: Math.round(9999000 * 1.18) } }, { amount: 9999000 }, "INR", "annual").length, 1);
  } finally { delete PLANS.growth.annualPrices; delete PLANS.growth.seatPrices; PLANS.growth.trialDays = null; }
});
