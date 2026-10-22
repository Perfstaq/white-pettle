// The plan catalogue: what each plan costs and what it allows.
//
// The DATABASE is the source of truth (tables plans, plan_prices, plan_limits, plan_features, seeded by migration 004 and edited by
// operators in the app). This module keeps a live, synchronous view of it in memory: `PLANS` and the lists below are filled from the
// database at boot (loadCatalogue) and refreshed when it changes, so the rest of the server can read a plan without awaiting.
// DEFAULT_PLANS mirrors the migration's seed: it is what runs before the database is loaded (and in tests with no database), and a
// test fails if the two drift apart.
//
// Prices are monthly, before tax, in the smallest currency unit (paise, cents). Razorpay plan ids are stored beside each price.
import { fail } from "./http.mjs";

export const ALL_ENGINES = Object.freeze(["chatgpt", "perplexity", "gemini", "aio", "aimode", "claude", "groq"]);
export const KNOWN_INTEGRATIONS = Object.freeze(["bing", "indexnow", "entity", "google", "cloudflare", "slack"]);
export const SCHEDULES = Object.freeze(["off", "weekly", "daily"]);
// checks: completed runs of the prompts per period (null = no limit). The free trial is one check.
// markets: countries tracked per brand, the brand itself included (meshopcheap.com/in and /us are 2).
export const LIMIT_METRICS = Object.freeze(["brands", "questions", "competitors", "seats", "drafts", "samples", "checks", "pages", "markets"]);
// Writes that count as a "drafted fix" (api/write.js kinds). Chat, topics, insights and the like are not drafts.
export const DRAFT_KINDS = Object.freeze(["pitch", "article", "fixpack"]);
// GST: catalogue prices are before tax ("₹4,999 + GST") and the Razorpay plan charges the price with 18% GST added, because Razorpay
// doesn't add tax to subscriptions. Other currencies are export of services (zero-rated), so nothing is added.
export const TAX_RATE = Object.freeze({ INR: 0.18 });
export const withTax = (amount, ccy) => Math.round(amount * (1 + (TAX_RATE[ccy] || 0)));
// UPI Autopay: offered only while the monthly charge (with GST) is at most ₹15,000, the RBI limit for recurring debits without an
// extra approval each time. Larger plans (Agency) pay by card or net banking.
export const UPI_MAX_MINOR = 1500000;
export const upiAllowed = (amount, ccy) => ccy === "INR" && withTax(amount, ccy) <= UPI_MAX_MINOR;
const CORE = ["chatgpt", "perplexity", "gemini"], BASIC = ["bing", "indexnow", "entity"];

// The flat, editable shape of a plan (what the admin API reads and writes):
// { code, name, description, sort, public, selfServe, featured, active, aiCapUsd, limits: {metric: n|null}, engines, schedules,
//   integrations: [...]|["*"], prices: { INR: { amount, razorpayPlanId } } }
const flat = (code, name, description, sort, flags, aiCapUsd, prices, limits, engines, schedules, integrations) => ({
  code, name, description, sort, public: flags.public, selfServe: flags.selfServe, featured: !!flags.featured, active: true, aiCapUsd,
  trialDays: null, maxExtraSeats: null,
  limits: Object.fromEntries(LIMIT_METRICS.map((m) => [m, limits[m] ?? null])), engines, schedules, integrations, prices: Object.fromEntries(Object.entries(prices).map(([c, amount]) => [c, { amount, annualAmount: null, annualRazorpayPlanId: null, annualRetired: [], seatAmount: null, razorpayPlanId: null }])),
});
export const DEFAULT_PLANS = [
  flat("legacy", "Legacy", "Existing accounts: no limits", 0, { public: false, selfServe: false }, null, {},
    { brands: null, questions: null, competitors: null, seats: null, drafts: null, samples: 5 }, [...ALL_ENGINES], ["off", "weekly", "daily"], ["*"]),
  // The free trial is the same for every plan: these limits for 7 days, then the plan they picked starts.
  flat("trial", "Free trial", "Seven days to try Perfstaq, no card", 1, { public: false, selfServe: false }, 3, {},
    { brands: 1, questions: 20, competitors: 3, seats: 1, drafts: 10, samples: 1, checks: 1, markets: 1 }, [...CORE], ["off"], []),
  flat("starter", "Starter", "Founders and small businesses proving AI visibility", 2, { public: true, selfServe: true }, 5, { INR: 499900, USD: 4900 },
    { brands: 1, questions: 15, competitors: 3, seats: 1, drafts: 10, samples: 1, markets: 2 }, [...CORE], ["off", "weekly"], [...BASIC]),
  flat("growth", "Growth", "Growing brands running a weekly visibility loop", 3, { public: true, selfServe: true, featured: true }, 14, { INR: 999900, USD: 9900 },
    { brands: 1, questions: 30, competitors: 5, seats: 5, drafts: 30, samples: 1, markets: 3 }, [...ALL_ENGINES], ["off", "weekly"], [...BASIC, "google", "cloudflare", "slack"]),
  flat("agency", "Agency", "Agencies running several client brands", 4, { public: true, selfServe: true }, 38, { INR: 2499900, USD: 24900 },
    { brands: 5, questions: 100, competitors: 5, seats: 20, drafts: 100, samples: 1, markets: 5 }, [...ALL_ENGINES], ["off", "weekly"], ["*"]),
  flat("enterprise", "Enterprise", "Large brands and groups with negotiated limits", 5, { public: true, selfServe: false }, null, { INR: 9999900, USD: 99900 },
    { brands: 20, questions: 300, competitors: 20, seats: 100, drafts: 500, samples: 3, markets: 10 }, [...ALL_ENGINES], ["off", "weekly", "daily"], ["*"]),
];

// ── the live view ────────────────────────────────────────────────────────────
export const PLANS = {};          // code -> { code, name, description, sort, public, selfServe, featured, active, capUsd, prices, razorpayIds, entitlements }
export const SELF_SERVE = [];     // codes that can be bought with a card, in display order (mutated in place)
export const CURRENCIES = [];     // currencies at least one self-serve plan is priced in (mutated in place)

const live = (f) => {
  const lim = Object.fromEntries(LIMIT_METRICS.map((m) => [m, f.limits[m] == null ? Infinity : Number(f.limits[m])]));
  return {
    code: f.code, name: f.name, description: f.description || "", sort: f.sort, public: !!f.public, selfServe: !!f.selfServe, featured: !!f.featured, active: f.active !== false,
    capUsd: f.aiCapUsd == null ? null : Number(f.aiCapUsd),
    prices: Object.fromEntries(Object.entries(f.prices || {}).map(([c, v]) => [c, Number(v.amount)])),
    razorpayIds: Object.fromEntries(Object.entries(f.prices || {}).filter(([, v]) => v.razorpayPlanId).map(([c, v]) => [c, v.razorpayPlanId])),
    retiredIds: Object.fromEntries(Object.entries(f.prices || {}).filter(([, v]) => v.retired?.length).map(([c, v]) => [c, [...v.retired]])),
    // Annual prices (billed yearly) with their own Razorpay plans; the price of one extra seat per month; trial length; add-on cap.
    annualPrices: Object.fromEntries(Object.entries(f.prices || {}).filter(([, v]) => v.annualAmount != null).map(([c, v]) => [c, Number(v.annualAmount)])),
    annualRazorpayIds: Object.fromEntries(Object.entries(f.prices || {}).filter(([, v]) => v.annualRazorpayPlanId).map(([c, v]) => [c, v.annualRazorpayPlanId])),
    annualRetiredIds: Object.fromEntries(Object.entries(f.prices || {}).filter(([, v]) => v.annualRetired?.length).map(([c, v]) => [c, [...v.annualRetired]])),
    seatPrices: Object.fromEntries(Object.entries(f.prices || {}).filter(([, v]) => v.seatAmount != null).map(([c, v]) => [c, Number(v.seatAmount)])),
    trialDays: f.trialDays == null ? null : Number(f.trialDays), maxExtraSeats: f.maxExtraSeats == null ? null : Number(f.maxExtraSeats),
    entitlements: { ...lim, engines: [...f.engines], schedule: [...f.schedules], integrations: f.integrations.includes("*") ? "all" : [...f.integrations] },
  };
};
export function applyCatalogue(flatPlans) {
  for (const k of Object.keys(PLANS)) delete PLANS[k];
  for (const f of [...flatPlans].sort((a, b) => a.sort - b.sort)) PLANS[f.code] = live(f);
  const ordered = Object.values(PLANS);
  SELF_SERVE.length = 0; SELF_SERVE.push(...ordered.filter((p) => p.selfServe && p.active).map((p) => p.code));
  CURRENCIES.length = 0;
  for (const p of ordered.filter((x) => x.selfServe && x.active)) for (const c of Object.keys(p.prices)) if (!CURRENCIES.includes(c)) CURRENCIES.push(c);
}
applyCatalogue(DEFAULT_PLANS);

// Back to the flat, editable shape (for the admin API and the parity test).
export const flatOf = (p) => ({
  code: p.code, name: p.name, description: p.description, sort: p.sort, public: p.public, selfServe: p.selfServe, featured: p.featured, active: p.active, aiCapUsd: p.capUsd,
  trialDays: p.trialDays ?? null, maxExtraSeats: p.maxExtraSeats ?? null,
  limits: Object.fromEntries(LIMIT_METRICS.map((m) => [m, p.entitlements[m] === Infinity ? null : p.entitlements[m]])),
  engines: [...p.entitlements.engines], schedules: [...p.entitlements.schedule], integrations: p.entitlements.integrations === "all" ? ["*"] : [...p.entitlements.integrations],
  prices: Object.fromEntries(Object.entries(p.prices).map(([c, amount]) => [c, { amount, razorpayPlanId: p.razorpayIds[c] || null, retired: p.retiredIds?.[c] || [],
    annualAmount: p.annualPrices?.[c] ?? null, annualRazorpayPlanId: p.annualRazorpayIds?.[c] || null, annualRetired: p.annualRetiredIds?.[c] || [], seatAmount: p.seatPrices?.[c] ?? null }])),
});
export const catalogueFlat = () => Object.values(PLANS).map(flatOf);

// ── database ─────────────────────────────────────────────────────────────────
// `query(text, params)` returns rows (db.mjs `q`, or a transaction client wrapped to do the same).
export async function loadCatalogue(query) {
  const [plans, prices, limits, feats] = await Promise.all([
    query(`select code, name, description, sort, public, self_serve, featured, active, ai_cap_usd::float as ai_cap, trial_days, max_extra_seats from plans order by sort, code`),
    query(`select plan_code, currency, amount_minor::float as amount, razorpay_plan_id, retired_plan_ids, annual_amount_minor::float as annual, annual_razorpay_plan_id, annual_retired_plan_ids, seat_amount_minor::float as seat from plan_prices`),
    query(`select plan_code, metric, limit_value::float as v from plan_limits`),
    query(`select plan_code, kind, value from plan_features order by value`),
  ]);
  const flats = plans.map((p) => ({
    code: p.code, name: p.name, description: p.description, sort: p.sort, public: p.public, selfServe: p.self_serve, featured: p.featured, active: p.active, aiCapUsd: p.ai_cap,
    trialDays: p.trial_days, maxExtraSeats: p.max_extra_seats,
    limits: Object.fromEntries(LIMIT_METRICS.map((m) => [m, limits.find((l) => l.plan_code === p.code && l.metric === m)?.v ?? null])),
    engines: ALL_ENGINES.filter((e) => feats.some((f) => f.plan_code === p.code && f.kind === "engine" && f.value === e)),
    schedules: SCHEDULES.filter((s) => feats.some((f) => f.plan_code === p.code && f.kind === "schedule" && f.value === s)),
    integrations: ["*", ...KNOWN_INTEGRATIONS].filter((i) => feats.some((f) => f.plan_code === p.code && f.kind === "integration" && f.value === i)),
    prices: Object.fromEntries(prices.filter((x) => x.plan_code === p.code).map((x) => [x.currency, { amount: x.amount, razorpayPlanId: x.razorpay_plan_id, retired: x.retired_plan_ids || [],
      annualAmount: x.annual, annualRazorpayPlanId: x.annual_razorpay_plan_id, annualRetired: x.annual_retired_plan_ids || [], seatAmount: x.seat }])),
  }));
  if (flats.length) applyCatalogue(flats);
  return flats.length;
}
// Cheap change detector for other instances: a count and the newest edit time.
export const catalogueStamp = async (query) => { const r = (await query(`select count(*)::int as n, max(updated_at) as m from plans`))[0]; return `${r.n}:${r.m ? new Date(r.m).getTime() : 0}`; };

// Validate an operator's edit and return the clean flat plan. Throws a 400 with a plain message.
export function cleanPlan(code, b, base = null) {
  const bad = (m) => fail(400, m, { code: "bad_plan_input" });
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(code)) bad("A plan code is lowercase letters, digits, - or _ (2 to 31 characters).");
  const str = (v, max, label, req = true) => { const s = String(v ?? "").trim(); if (req && !s) bad(`${label} is required.`); if (s.length > max) bad(`${label} is too long.`); return s; };
  const int = (v, label, { min = 0, max = 1e12 } = {}) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) bad(`${label} must be a whole number from ${min}.`); return n; };
  const list = (v, allowed, label) => { if (!Array.isArray(v)) bad(`${label} must be a list.`); for (const x of v) if (!allowed.includes(x)) bad(`${label}: "${x}" is not one of ${allowed.join(", ")}.`); return [...new Set(v)]; };
  const out = { code, name: str(b.name ?? base?.name, 60, "Name"), description: str(b.description ?? base?.description ?? "", 200, "Description", false), sort: int(b.sort ?? base?.sort ?? 50, "Order", { max: 1000 }),
    public: b.public ?? base?.public ?? true, selfServe: b.selfServe ?? base?.selfServe ?? false, featured: b.featured ?? base?.featured ?? false, active: b.active ?? base?.active ?? true };
  for (const k of ["public", "selfServe", "featured", "active"]) if (typeof out[k] !== "boolean") bad(`${k} must be true or false.`);
  const cap = b.aiCapUsd === undefined ? base?.aiCapUsd ?? null : b.aiCapUsd;
  out.aiCapUsd = cap === null || cap === "" ? null : (Number.isFinite(Number(cap)) && Number(cap) >= 0 && Number(cap) <= 100000 ? Number(cap) : bad("The AI allowance is dollars a month, or empty for none."));
  const opt = (v, label, o) => (v === null || v === undefined || v === "" ? null : int(v, label, o));
  out.trialDays = opt(b.trialDays === undefined ? base?.trialDays : b.trialDays, "Trial length (days)", { max: 90 });
  out.maxExtraSeats = opt(b.maxExtraSeats === undefined ? base?.maxExtraSeats : b.maxExtraSeats, "Most extra seats", { max: 10000 });
  const lim = { ...(base?.limits || {}), ...(b.limits || {}) }; out.limits = {}; // merged: a limit not sent keeps its value; send null for unlimited
  for (const m of LIMIT_METRICS) { const v = lim[m]; out.limits[m] = v === null || v === undefined || v === "" ? null : int(v, `Limit ${m}`); }
  out.engines = list(b.engines ?? base?.engines ?? [], ALL_ENGINES, "Engines");
  out.schedules = list(b.schedules ?? base?.schedules ?? ["off"], SCHEDULES, "Schedules"); if (!out.schedules.includes("off")) out.schedules.unshift("off");
  const ints = b.integrations ?? base?.integrations ?? []; out.integrations = ints.includes?.("*") ? ["*"] : list(ints, KNOWN_INTEGRATIONS, "Integrations");
  out.prices = {};
  for (const [c, v] of Object.entries(b.prices ?? base?.prices ?? {})) {
    if (!/^[A-Z]{3}$/.test(c)) bad(`"${c}" is not a currency code.`);
    const id = v.razorpayPlanId == null || v.razorpayPlanId === "" ? null : String(v.razorpayPlanId).trim();
    if (id && !/^plan_[A-Za-z0-9]{6,40}$/.test(id)) bad(`The Razorpay plan id for ${c} should look like plan_AbCd1234567890.`);
    // A replaced Razorpay id is kept as retired: existing subscribers are still on it and their webhooks must keep resolving.
    const old = base?.prices?.[c], retired = [...new Set([...(old?.retired || []), ...(old?.razorpayPlanId && old.razorpayPlanId !== id ? [old.razorpayPlanId] : [])])].filter((x) => x !== id);
    // Annual and seat prices are optional; a field the caller didn't send keeps its stored value (older editors only send the monthly one).
    const keep = (k) => (v[k] === undefined ? old?.[k] : v[k]);
    const aid = keep("annualRazorpayPlanId") == null || keep("annualRazorpayPlanId") === "" ? null : String(keep("annualRazorpayPlanId")).trim();
    if (aid && !/^plan_[A-Za-z0-9]{6,40}$/.test(aid)) bad(`The annual Razorpay plan id for ${c} should look like plan_AbCd1234567890.`);
    if (aid && aid === id) bad(`The annual Razorpay plan for ${c} can't be the monthly one.`);
    const aRetired = [...new Set([...(old?.annualRetired || []), ...(old?.annualRazorpayPlanId && old.annualRazorpayPlanId !== aid ? [old.annualRazorpayPlanId] : [])])].filter((x) => x !== aid);
    const annualAmount = opt(keep("annualAmount"), `Annual price in ${c}`), seatAmount = opt(keep("seatAmount"), `Extra seat price in ${c}`);
    out.prices[c] = { amount: int(v.amount, `Price in ${c}`), razorpayPlanId: id, retired, annualAmount, annualRazorpayPlanId: annualAmount == null ? null : aid, annualRetired: aRetired, seatAmount };
  }
  if (out.selfServe && !Object.keys(out.prices).length) bad("A plan you can buy needs a price in at least one currency.");
  return out;
}
// Write one plan (and its children) in a transaction client; bumps updated_at so other instances reload.
export async function savePlan(c, f) {
  await c.query(`insert into plans (code, name, description, sort, public, self_serve, featured, active, ai_cap_usd, trial_days, max_extra_seats, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
    on conflict (code) do update set name = excluded.name, description = excluded.description, sort = excluded.sort, public = excluded.public, self_serve = excluded.self_serve,
      featured = excluded.featured, active = excluded.active, ai_cap_usd = excluded.ai_cap_usd, trial_days = excluded.trial_days, max_extra_seats = excluded.max_extra_seats, updated_at = now()`,
    [f.code, f.name, f.description, f.sort, f.public, f.selfServe, f.featured, f.active, f.aiCapUsd, f.trialDays ?? null, f.maxExtraSeats ?? null]);
  // Only one plan is "most popular": featuring this one un-features the others.
  if (f.featured) await c.query(`update plans set featured = false, updated_at = now() where code <> $1 and featured`, [f.code]);
  await c.query(`delete from plan_limits where plan_code = $1`, [f.code]); await c.query(`delete from plan_features where plan_code = $1`, [f.code]); await c.query(`delete from plan_prices where plan_code = $1`, [f.code]);
  for (const m of LIMIT_METRICS) await c.query(`insert into plan_limits (plan_code, metric, limit_value) values ($1,$2,$3)`, [f.code, m, f.limits[m]]);
  for (const [kind, vals] of [["engine", f.engines], ["schedule", f.schedules], ["integration", f.integrations]]) for (const v of vals) await c.query(`insert into plan_features (plan_code, kind, value) values ($1,$2,$3)`, [f.code, kind, v]);
  for (const [cur, v] of Object.entries(f.prices)) await c.query(`insert into plan_prices (plan_code, currency, amount_minor, razorpay_plan_id, retired_plan_ids, annual_amount_minor, annual_razorpay_plan_id, annual_retired_plan_ids, seat_amount_minor)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [f.code, cur, v.amount, v.razorpayPlanId, v.retired || [], v.annualAmount ?? null, v.annualRazorpayPlanId ?? null, v.annualRetired || [], v.seatAmount ?? null]);
}

// ── lookups ──────────────────────────────────────────────────────────────────
// The plan after this one: the next public plan up; a trial or legacy organisation is pointed at the featured plan.
export function nextPlan(code) {
  const shown = Object.values(PLANS).filter((p) => p.public && p.active);
  const cur = PLANS[code];
  if (!cur || !cur.public) return (shown.find((p) => p.featured) || shown[0] || PLANS.trial).code;
  return (shown.find((p) => p.sort > cur.sort) || shown[shown.length - 1]).code;
}
// An operator's contract or support grant: { values: { seats: 50 }, expiresAt, reason }. Expired grants stop applying.
export function effectiveEntitlements(code, overrides = {}, now = new Date()) {
  const base = PLANS[code]?.entitlements || PLANS.trial.entitlements; // an unknown code gets the tightest limits
  const live = overrides?.values && (!overrides.expiresAt || new Date(overrides.expiresAt) > now);
  return Object.freeze({ ...base, ...(live ? Object.fromEntries(Object.entries(overrides.values).map(([k, v]) => [k, v])) : {}) });
}
// What the browser and the pricing page may see: no provider ids, no internal budgets. Infinity becomes null (JSON has no Infinity).
export const finite = (e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v === Infinity ? null : v]));
export const publicPlans = () => Object.values(PLANS).filter((p) => p.public && p.active).map((p) => ({
  code: p.code, name: p.name, description: p.description, featured: p.featured, selfServe: p.selfServe && Object.keys(p.prices).length > 0, prices: p.prices, entitlements: finite(p.entitlements),
  annualPrices: p.annualPrices, seatPrices: p.seatPrices, trialDays: p.trialDays, maxExtraSeats: p.maxExtraSeats,
}));
// Billing cycles. The price an organisation is charged per cycle, and what that is per month (the figure MRR adds up).
export const CYCLES = Object.freeze(["monthly", "annual"]);
export const cyclePrice = (code, ccy, cycle = "monthly") => (cycle === "annual" ? PLANS[code]?.annualPrices?.[ccy] : PLANS[code]?.prices?.[ccy]) ?? null;
export const monthlyEquivalent = (code, ccy, cycle = "monthly") => { const v = cyclePrice(code, ccy, cycle); return v == null ? null : cycle === "annual" ? Math.round(v / 12) : v; };
// The free trial for a plan, in days: the plan's own, else the global default. 0 means the plan has no free trial.
export const trialDaysFor = (code, fallback = 7) => (PLANS[code]?.trialDays ?? fallback);
