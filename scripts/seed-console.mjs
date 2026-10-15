// Local demo data for the Command Deck: ~36 organisations across every billing state, with checks, AI usage, recovery
// actions and billing history over the last 6 months. Local databases only. Everything it makes has a slug starting
// "demo-" (and users at *demo.test), so `node scripts/seed-console.mjs --clean` removes exactly that.
//
//   DATABASE_URL=postgres://wp@127.0.0.1:54329/whitepetal_dev node scripts/seed-console.mjs
//   ... --live 10   then keeps simulating people using the app for 10 minutes (presence, page views, AI calls, checks) for the Live page.
//
// Operator sign-in it creates (local fixture, never a real account): founder@demo.test / demo-founder-pass
import { connect, migrate, q, one, close } from "../server/db.mjs";
import { hashPassword } from "../server/security.mjs";

const url = process.env.DATABASE_URL || "";
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) { console.error("Refusing: DATABASE_URL must point at a local database."); process.exit(1); }
connect(url); await migrate();

const OPERATOR = { email: "founder@demo.test", password: "demo-founder-pass" };
await q(`delete from organizations where slug like 'demo-%'`);
await q(`delete from users where email like '%demo.test'`);
await q(`delete from console_attention_state where key like '%:demo-%'`);
await q(`delete from account_groups where name in ('Founding team', 'Demo accounts')`);
if (process.argv.includes("--clean")) { console.log("Removed demo data."); await close(); process.exit(0); }

// Deterministic randomness, so two runs give the same picture.
let seed = 42; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const days = (n) => new Date(Date.now() - n * 864e5);
const ENGINES = ["chatgpt", "perplexity", "gemini", "groq", "aio"];
const NAMES = ["Northwind Foods", "Kiln & Co", "Lumen Legal", "Acme Retail", "Brightpath Health", "Fernhill Studio", "Saffron Kitchens", "Orbit Fintech", "Tealeaf Travel",
  "Copperline Steel", "Monsoon Apparel", "Quill Learning", "Harbor Logistics", "Verdant Agro", "Pixelnest Media", "Bluebird Insurance", "Cedar Dental", "Atlas Realty",
  "Nimbus Cloud", "Marigold Weddings", "Ironclad Security", "Juniper Wellness", "Summit Outdoors", "Lotus Spa", "Granite Builders", "Echo Audio", "Zephyr Mobility",
  "Paperplane HR", "Indigo Textiles", "Riverbend Schools", "Crescent Pharma", "Nova Robotics", "Opal Jewellers", "Banyan Capital", "Sprout Organics", "Tandem Bikes"];
// [status, plan, currency, count] — a believable small-SaaS mix.
const MIX = [["active", "starter", "INR", 8], ["active", "growth", "INR", 7], ["active", "agency", "INR", 3], ["active", "growth", "USD", 2], ["active", "enterprise", "INR", 1],
  ["past_due", "growth", "INR", 2], ["past_due", "starter", "INR", 1], ["trialing", "trial", null, 6], ["new", "legacy", null, 2], ["canceled", "starter", "INR", 3], ["internal", "legacy", null, 1]];

const pw = await hashPassword(OPERATOR.password);
const op = await one(`insert into users (email, name, pw_hash, email_verified_at, last_login_at) values ($1, 'Demo Founder', $2, now(), now()) returning id`, [OPERATOR.email, pw]);
await q(`insert into operators (user_id, role) values ($1, 'founder') on conflict (user_id) do update set role = 'founder', active = true`, [op.id]);

let i = 0;
for (const [status, plan, ccy, count] of MIX) for (let k = 0; k < count; k++, i++) {
  const name = NAMES[i % NAMES.length], slug = "demo-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
  const age = Math.floor(10 + rnd() * 170), created = days(age);
  const owner = await one(`insert into users (email, name, pw_hash, email_verified_at, created_at, last_login_at) values ($1, $2, $3, now(), $4, $5) returning id`,
    [`owner@${slug.slice(5)}.demo.test`, name + " owner", pw, created, days(Math.floor(rnd() * (status === "canceled" ? 60 : 12)))]);
  const trialEnds = status === "trialing" ? new Date(Date.now() + (k < 3 ? (k + 0.5) * 864e5 : (3 + k) * 864e5)) : null;
  const periodEnd = ["active", "past_due"].includes(status) ? new Date(Date.now() + Math.floor(1 + rnd() * 29) * 864e5) : null;
  const org = await one(`insert into organizations (slug, name, created_by, created_at, plan_code, billing_status, billing_currency, trial_started_at, trial_ends_at,
      current_period_start, current_period_end, razorpay_subscription_id, billing_reconciled_at, cancel_at_period_end, allow_platform_keys, monthly_cap_usd)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
    [slug, name, owner.id, created, plan, status, ccy, trialEnds ? days(7 - (trialEnds - Date.now()) / 864e5) : null, trialEnds,
      periodEnd ? new Date(periodEnd - 30 * 864e5) : null, periodEnd,
      ["active", "past_due"].includes(status) && !(plan === "enterprise") ? "sub_demo_" + i : null,
      ["active", "past_due"].includes(status) ? days(i % 5 === 0 ? 5 : 0.2) : null,
      status === "active" && k === 1 && plan === "starter", i % 9 === 0, i % 4 === 0 ? 14 : null]);
  await q(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [org.id, owner.id]);
  // Team members beside the owner, within the plan's seats (Starter and the trial are one seat: the owner alone).
  const seats = { legacy: 3, trial: 1, starter: 1, growth: 5, agency: 20, enterprise: 100 }[plan];
  for (let m = 0; m < Math.min(Math.floor(rnd() * 3), seats - 1); m++) {
    const u = await one(`insert into users (email, pw_hash, email_verified_at, last_login_at, created_at) values ($1, $2, now(), $3, $4) returning id`, [`member${m}@${slug.slice(5)}.demo.test`, pw, days(rnd() * 20), days(Math.max(1, age - 3 - m))]);
    await q(`insert into memberships (org_id, user_id, role) values ($1, $2, $3)`, [org.id, u.id, pick(["editor", "viewer", "admin"])]);
  }
  // Brands, checks and AI usage. Busy organisations check often; dormant ones barely.
  const busy = status === "canceled" || status === "new" ? 0.1 : status === "trialing" && k < 3 ? (k === 0 ? 0 : 0.3) : 0.5 + rnd() * 0.5;
  const nBrands = plan === "agency" ? 3 : 1;
  // What the plan allows (the code defaults the database is seeded from), so setups stay inside their caps.
  const LIM = { legacy: [9, 40, 5, 4], trial: [1, 20, 3, 3], starter: [1, 15, 3, 3], growth: [1, 30, 5, 6], agency: [5, 100, 5, 6], enterprise: [20, 300, 20, 6] }[plan]; // brands, questions, competitors, engines
  // How much of the question cap this account uses: some near the cap (expansion), most mid, a few barely (risk).
  const fill = status === "canceled" ? 0.2 : i % 7 === 0 ? 0.95 : i % 5 === 0 ? 0.18 : 0.45 + rnd() * 0.4;
  const RIVALS = ["Northstar AI", "Brightline", "Kestrel", "Lumio", "Orbitly", "Pinewood", "Vantage Labs", "Zenith Co", "Cobalt", "Meridian"];
  const INTENTS = [["informational", 0.35], ["commercial", 0.45], ["transactional", 0.2]];
  const ENGS = ["chatgpt", "perplexity", "gemini", "aio", "aimode", "groq"];
  for (let b = 0; b < nBrands; b++) {
    const brandName = b ? `${name} ${["Pro", "Labs"][b - 1]}` : name, profiled = status !== "new" && rnd() < 0.9;
    const nq = Math.max(3, Math.floor((LIM[1] / nBrands) * fill)), engines = ENGS.slice(0, plan === "trial" || plan === "starter" ? 3 : 3 + Math.floor(rnd() * (LIM[3] - 2)));
    const rivals = [...RIVALS].sort(() => rnd() - 0.5).slice(0, Math.max(2, Math.min(LIM[2], 2 + Math.floor(rnd() * LIM[2]))));
    const questions = Array.from({ length: nq }, (_, k) => { let r = rnd(), intent = "commercial"; for (const [it, w] of INTENTS) { if ((r -= w) <= 0) { intent = it; break; } }
      return { text: `${["best", "top", "how to choose", "alternatives to", "is it worth", "where to buy"][k % 6]} ${brandName.split(" ")[0].toLowerCase()} ${["for teams", "in India", "under budget", "for beginners", "near me", "2026"][k % 6]} #${k + 1}`, intent, on: true }; });
    const setup = profiled ? { profile: { name: brandName, site: `https://${slug.slice(5)}.example`, competitors: rivals,
      category: rnd() < 0.85 ? pick(["Skincare", "Food & beverages", "Fintech", "B2B software", "Health & wellness", "Travel", "Education", "Home & kitchen", "Fashion & apparel"]) : "" }, questions, engines } : {};
    const schedule = ["active", "past_due"].includes(status) ? (plan === "enterprise" || (plan === "agency" && b === 0) ? "daily" : "weekly") : "off";
    const ws = await one(`insert into workspaces (org_id, owner_id, slug, name, site, schedule, samples, created_at, last_run_at, next_run_at, setup)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [org.id, owner.id, `brand-${b}`, brandName, `https://${slug.slice(5)}.example`, schedule, plan === "enterprise" ? 2 : 1, created,
        busy ? days(rnd() * 6) : null, schedule !== "off" ? new Date(Date.now() + (i % 11 === 0 ? -2 : 3) * 864e5) : null, setup]);
    if (i % 4 === 1) await q(`insert into integrations (workspace_id, provider, status, detail, collected_at) values ($1, 'bing', $2, $3, $4)`,
      [ws.id, i % 12 === 5 ? "error" : "connected", i % 12 === 5 ? "Bing returned 401: the API key was revoked." : "", i % 8 === 1 ? days(4) : days(rnd())]);
    if (i % 5 === 2) await q(`insert into integrations (workspace_id, provider, status, collected_at) values ($1, 'google', 'connected', $2)`, [ws.id, days(rnd() * 1.5)]);
    if (!profiled) continue;
    // The outcome: a starting visibility score, and a trend that follows how engaged the account is (engaged ones improve).
    const start = 12 + rnd() * 40, trend = busy >= 0.75 ? 0.35 + rnd() * 0.6 : busy >= 0.5 ? rnd() * 0.3 - 0.05 : -0.1 - rnd() * 0.3;
    const leader = pick(rivals), engRate = Object.fromEntries(engines.map((e) => [e, Math.max(0, Math.min(1, (start / 100) * (e === "perplexity" ? 1.3 : e === "aio" ? 0.6 : 1) + (rnd() - 0.5) * 0.2))]));
    for (let d = Math.min(age, 45); d >= 0; d--) {
      if (rnd() > busy * (schedule === "daily" ? 0.9 : 0.35)) continue;
      const failed = rnd() < (i % 10 === 3 ? 0.6 : 0.05), started = days(Math.max(0.02, d - rnd() * 0.9)), elapsed = Math.min(age, 45) - d;
      const score = Math.max(2, Math.min(96, start + trend * elapsed + (rnd() - 0.5) * 6)), vis = Math.max(0, Math.min(1, score / 110 + (rnd() - 0.5) * 0.05));
      const n = nq * engines.length * (plan === "enterprise" ? 2 : 1);
      const summary = failed ? null : { n, visibility: vis, sov: vis * (0.35 + rnd() * 0.2), position: Math.max(1, 5.5 - score / 22 + rnd()), sentiment: 55 + rnd() * 30, win: vis * 0.6, mentions: Math.round(vis * n),
        usedAsSource: vis * 0.4, rank: Math.max(1, Math.round(rivals.length + 1 - (score / 100) * (rivals.length + 1))), brands: rivals.length + 1,
        leader: { name: score > 70 ? brandName : leader, vis: Math.min(1, vis + 0.15) }, engines: Object.fromEntries(engines.map((e) => [e, Math.max(0, Math.min(1, engRate[e] + trend * elapsed / 110))])), score: Math.round(score) };
      await q(`insert into runs (id, workspace_id, source, status, started_at, finished_at, error, started_by, summary) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`demo_${i}_${b}_${d}`, ws.id, schedule === "off" || rnd() < 0.35 ? "live" : "scheduled", failed ? "failed" : "done", started, new Date(+started + (60 + n * 4 + rnd() * 300) * 1000),
          failed ? pick(["perplexity: 429 rate limited", "gemini: request timed out after 60000 ms", "openai: 401 invalid api key", "inspect: page fetch failed (403)"]) : null, owner.id, summary]);
      // One AI call per question × engine (× samples), priced roughly like the providers; plus a few writing calls.
      for (const e of engines) await q(`insert into usage (org_id, workspace_id, user_id, kind, engine, n, cost_usd, at, sub)
          select $1, $2, $3, 'ask', $4, 1, $5::numeric * (0.7 + random() * 0.6) * case when $8::int = 13 and $9::int < 1 then 20 else 1 end, $6::timestamptz + (g * interval '2 seconds'), null from generate_series(1, $7::int) g`,
        [org.id, ws.id, owner.id, e, e === "perplexity" ? 0.012 : e === "chatgpt" ? 0.008 : e === "aio" || e === "aimode" ? 0.004 : 0.002, started, nq * (plan === "enterprise" ? 2 : 1), i % 13 === 5 ? 13 : 0, d]);
      if (!failed && rnd() < 0.5) for (const sub of ["pitch", "article", "fixpack", "chat"].filter(() => rnd() < 0.4))
        await q(`insert into usage (org_id, workspace_id, user_id, kind, engine, n, cost_usd, at, sub) values ($1, $2, $3, 'write', null, 1, $4, $5, $6)`, [org.id, ws.id, owner.id, 0.02 + rnd() * 0.05, started, sub]);
    }
    // Gaps turned into recovery actions; engaged accounts move them further, and some rechecks report a result.
    const GAP = ["discovery", "consideration", "decision"];
    for (let a = 0; a < Math.floor(busy * 8); a++) {
      const st = busy >= 0.75 ? pick(["approved", "published", "recheck_scheduled", "result_observed", "result_observed", "drafting"]) : pick(["suggested", "suggested", "drafting", "ready_for_review", "approved"]);
      const dir = trend > 0.3 ? pick(["improved", "improved", "unchanged"]) : trend > 0 ? pick(["improved", "unchanged", "regressed"]) : pick(["unchanged", "regressed", "incomparable"]);
      await q(`insert into recovery_actions (workspace_id, source_key, kind, title, problem, status, gap_type, updated_at, published_at, result) values ($1, $2, $3, $4, 'Rivals are named instead of you', $5, $6, $7, $8, $9)`,
        [ws.id, `demo:${a}`, pick(["pitch", "article", "fixpack", "page"]), `Fix evidence ${a + 1}`, st, pick(GAP), days(rnd() * 12), ["published", "recheck_scheduled", "result_observed"].includes(st) ? days(14 + rnd() * 10) : null,
          st === "result_observed" ? { direction: dir, comparable: dir !== "incomparable", before: { named: 0 }, after: { named: dir === "improved" ? 2 : 0 } } : {}]);
    }
  }
  // Billing history in the audit log, the way the webhook writes it.
  if (["active", "past_due", "canceled"].includes(status)) await q(`insert into audit_log (org_id, action, target, at) values ($1, 'billing.activated', $2, $3)`, [org.id, plan, days(Math.max(1, age - 7))]);
  if (status === "canceled") await q(`insert into audit_log (org_id, action, target, at) values ($1, 'billing.cancelled', $2, $3)`, [org.id, plan, days(Math.floor(rnd() * 60))]);
  if (status === "past_due") await q(`insert into audit_log (org_id, action, target, at) values ($1, 'billing.pending', $2, $3)`, [org.id, plan, days(2)]);
  await q(`insert into audit_log (org_id, user_id, action, target, at) values ($1, $2, 'brand.created', $3, $4)`, [org.id, owner.id, name, created]);
}
// Account groups, as in Founder Command: our own team's organisations are left out of customer figures; demo ones hide with the switch.
const team = await one(`insert into account_groups (name, kind, leave_out, created_by) values ('Founding team', 'internal', true, $1) returning id`, [op.id]);
await q(`insert into account_group_members (group_id, org_id) select $1, id from organizations where slug in ('demo-nova-robotics', 'demo-sprout-organics', 'demo-tandem-bikes')`, [team.id]);
const demoG = await one(`insert into account_groups (name, kind, leave_out, created_by) values ('Demo accounts', 'demo', true, $1) returning id`, [op.id]);
await q(`insert into account_group_members (group_id, org_id) select $1, id from organizations where slug in ('demo-opal-jewellers', 'demo-banyan-capital')`, [demoG.id]);

// Page views (feature analytics, retention) and devices, weighted like a real dashboard: overview and prompts most, settings least.
const PAGES = [["overview", 30], ["prompts", 16], ["gaps", 12], ["actions", 11], ["chats", 8], ["site", 7], ["domains", 6], ["insights", 5], ["perception", 4],
  ["rankings", 3], ["gap", 3], ["fanouts", 2], ["ranking", 2], ["settings", 2], ["team", 2], ["billing", 1], ["account", 1]];
const wpick = () => { let r = rnd() * PAGES.reduce((t, [, w]) => t + w, 0); for (const [p, w] of PAGES) if ((r -= w) <= 0) return p; return "overview"; };
const people = await q(`select u.id, u.created_at, m.org_id, o.billing_status from users u join memberships m on m.user_id = u.id join organizations o on o.id = m.org_id where o.slug like 'demo-%'`);
for (const u of people) {
  const device = rnd() < 0.78 ? "desktop" : rnd() < 0.8 ? "mobile" : "tablet", keen = u.billing_status === "canceled" ? 0.04 : u.billing_status === "new" ? 0.02 : 0.15 + rnd() * 0.45;
  const age = Math.min(60, Math.floor((Date.now() - new Date(u.created_at)) / 864e5));
  for (let d = age; d >= 0; d--) {
    if (rnd() > keen * (d > age - 7 ? 1.6 : 1)) continue; // a little keener in their first week
    const views = 1 + Math.floor(rnd() * 6);
    for (let v = 0; v < views; v++) await q(`insert into page_views (user_id, org_id, page, device, at) values ($1, $2, $3, $4, $5)`, [u.id, u.org_id, v === 0 ? "overview" : wpick(), device, days(d + rnd() * 0.5)]);
  }
}
await q(`insert into billing_events (event_id, event_type, status, received_at, error) values ('demo_evt_fail', 'subscription.charged', 'failed', now() - interval '3 hours', 'no organisation for this subscription')
         on conflict do nothing`);
console.log(`Seeded ${i} demo organisations. Operator sign-in: ${OPERATOR.email} (password in this script).`);

// --live N: simulate N minutes of people using the app, so the Live page moves.
const li = process.argv.indexOf("--live");
if (li > 0) {
  const until = Date.now() + Number(process.argv[li + 1] || 10) * 60e3, active = people.filter((p) => !["canceled", "new"].includes(p.billing_status));
  const brands = await q(`select w.id, w.slug, w.org_id from workspaces w join organizations o on o.id = w.org_id where o.slug like 'demo-%'`);
  console.log(`Simulating live use until ${new Date(until).toLocaleTimeString()} (Ctrl-C to stop).`);
  let n = 0;
  while (Date.now() < until) {
    const online = active.filter(() => rnd() < 0.3).slice(0, 14);
    for (const u of online) {
      const page = wpick(), b = brands.find((x) => x.org_id === u.org_id);
      const r = await one(`insert into presence (user_id, org_id, page, brand, device) values ($1, $2, $3, $4, $5)
          on conflict (user_id) do update set page = excluded.page, brand = excluded.brand, at = now(),
            since = case when presence.page = excluded.page then presence.since else now() end returning since = at as changed`, [u.id, u.org_id, rnd() < 0.7 ? (await one(`select page from presence where user_id = $1`, [u.id]))?.page || page : page, b?.slug || null, rnd() < 0.8 ? "desktop" : "mobile"]);
      if (r.changed) await q(`insert into page_views (user_id, org_id, page) values ($1, $2, (select page from presence where user_id = $1))`, [u.id, u.org_id]);
      if (rnd() < 0.25) await q(`insert into usage (org_id, workspace_id, user_id, kind, engine, n, cost_usd, sub) values ($1, $2, $3, $4, $5, 1, $6, $7)`,
        [u.org_id, b?.id || null, u.id, rnd() < 0.7 ? "ask" : "write", pick(ENGINES), 0.01 + rnd() * 0.2, rnd() < 0.3 ? pick(["pitch", "article", "chat"]) : null]);
      if (b && rnd() < 0.04) await q(`insert into runs (id, workspace_id, source, status, started_at, started_by) values ($1, $2, 'live', 'running', now(), $3)`, [`demo_live_${Date.now()}_${n++}`, b.id, u.id]);
    }
    await q(`update runs set status = case when random() < 0.9 then 'done' else 'failed' end, finished_at = now() where id like 'demo_live_%' and status = 'running' and started_at < now() - interval '40 seconds' and random() < 0.3`);
    await new Promise((ok) => setTimeout(ok, 2500));
  }
}
await close();
