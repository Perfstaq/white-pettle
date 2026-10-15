// Recomputes the Command Deck's headline figures straight from the tables, with different code from the console (plain JS over raw
// rows instead of its SQL), and compares them with what the console's API returns. Any difference is printed. Local only.
//
//   DATABASE_URL=postgres://wp@127.0.0.1:54329/whitepetal_dev BILLING_ENABLED=1 node scripts/verify-console-metrics.mjs [http://localhost:3210]
import pg from "pg";
const BASE = process.argv[2] || "http://localhost:3210";
const url = process.env.DATABASE_URL || "";
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url) || !/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) { console.error("Refusing: local database and server only."); process.exit(1); }
const db = new pg.Client({ connectionString: url }); await db.connect(); await db.query("set search_path to whitepetal, public");
const rows = async (sql, p = []) => (await db.query(sql, p)).rows;
let cookie = "";
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "founder@demo.test", password: "demo-founder-pass" }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const api = async (p) => (await fetch(BASE + "/api/admin/console/" + p + (p.includes("?") ? "&" : "?") + "accounts=all&days=30", { headers: { cookie } })).json();
let pass = 0, fail = 0;
const same = (label, mine, theirs, tol = 0) => { const ok = mine === theirs || (typeof mine === "number" && typeof theirs === "number" && Math.abs(mine - theirs) <= tol);
  ok ? pass++ : fail++; console.log(`${ok ? "  ✔" : "  ✖"} ${label}: recomputed ${JSON.stringify(mine)} · console ${JSON.stringify(theirs)}`); };
const median = (xs) => { const a = xs.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };

// Catalogue straight from the tables.
const prices = await rows(`select plan_code, currency, amount_minor::float as m, annual_amount_minor::float as a, seat_amount_minor::float as s from plan_prices`);
const price = (code, ccy, cycle) => { const p = prices.find((x) => x.plan_code === code && x.currency === ccy); return p ? (cycle === "annual" && p.a != null ? Math.round(p.a / 12) : p.m) : 0; };
const seat = (code, ccy) => prices.find((x) => x.plan_code === code && x.currency === ccy)?.s || 0;

console.log("\nRevenue");
const orgs = await rows(`select id, plan_code, billing_status, coalesce(billing_currency, 'INR') as ccy, billing_cycle, extra_seats from organizations`);
const paying = orgs.filter((o) => ["active", "past_due"].includes(o.billing_status));
const mrr = paying.reduce((t, o) => { const m = price(o.plan_code, o.ccy, o.billing_cycle) + o.extra_seats * seat(o.plan_code, o.ccy); return t + (o.ccy === "USD" ? Math.round(m * 84) : m); }, 0);
const ov = await api("overview");
same("MRR (INR minor units)", mrr, ov.kpis.mrrInr);
same("Paying organisations", paying.filter((o) => price(o.plan_code, o.ccy, o.billing_cycle) > 0).length, ov.kpis.paying);

console.log("\nUsage depth");
const ws = await rows(`select id, org_id, setup, schedule from workspaces`);
const qOn = (w) => (Array.isArray(w.setup?.questions) ? w.setup.questions.filter((q) => q.on !== false).length : 0);
const ud = await api("usage-depth");
same("Questions tracked", ws.reduce((t, w) => t + qOn(w), 0), ud.kpis.questions);
same("Brands with questions", ws.filter((w) => qOn(w) > 0).length, ud.kpis.configured);
same("Median questions per brand", median(ws.filter((w) => qOn(w) > 0).map(qOn)), ud.kpis.medianQuestions);
same("Daily schedules", ws.filter((w) => w.schedule === "daily").length, ud.schedules.find((s) => s.key === "daily").n);

console.log("\nOutcomes");
const runs = await rows(`select workspace_id, started_at, summary from runs where status = 'done' and summary is not null order by started_at`);
const byWs = {}; for (const r of runs) if (r.summary?.score != null) (byWs[r.workspace_id] ||= []).push(r);
const latest = Object.values(byWs).map((xs) => xs.at(-1).summary.score);
const out = await api("outcomes");
same("Brands with a scored check", Object.keys(byWs).length, out.kpis.brands);
same("Median visibility score (latest)", median(latest), out.kpis.medianScore, 0.5);
const comp = Object.values(byWs).filter((xs) => xs.length >= 2 && new Date(xs.at(-1).started_at) - new Date(xs[0].started_at) >= 7 * 864e5);
const deltas = comp.map((xs) => Math.round(xs.at(-1).summary.score - xs[0].summary.score));
same("Comparable brands", comp.length, out.kpis.comparable);
same("Improving brands (+5)", deltas.filter((d) => d >= 5).length, out.kpis.improving);
same("Declining brands (−5)", deltas.filter((d) => d <= -5).length, out.kpis.declining);
same("Median change", median(deltas), out.kpis.medianDelta);
const ra = await rows(`select result->>'direction' as d from recovery_actions where status = 'result_observed'`);
same("Rechecks improved", ra.filter((x) => x.d === "improved").length, out.rechecks.improved);

console.log("\nUnit costs (30 days)");
const asks = await rows(`select cost_usd::float as c from usage where kind = 'ask' and at > now() - interval '30 days'`);
const uc = await api("unit-costs");
same("Answers", asks.length, uc.totals.answers);
same("Cost per answer (USD)", asks.length ? +(asks.reduce((t, x) => t + x.c, 0) / asks.length).toFixed(5) : null, +uc.totals.perAnswer.toFixed(5), 0.00001);

console.log("\nPlan fit");
const fit = await api("plan-fit");
const starterQs = orgs.filter((o) => o.plan_code === "starter" && o.billing_status !== "trialing").map((o) => ws.filter((w) => w.org_id === o.id).reduce((t, w) => t + qOn(w), 0));
same("Starter: median questions used", median(starterQs), fit.plans.find((p) => p.code === "starter")?.metrics.questions.medianUsed);

console.log(`\n${pass} match, ${fail} differ`);
await db.end(); process.exit(fail ? 1 : 0);
