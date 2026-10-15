// The real HTTP app against a real Postgres. Skipped unless TEST_DATABASE_URL is set (CI sets it; see ci.yml).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { fakes, WS } from "./_fake.mjs";

const DB = process.env.TEST_DATABASE_URL;
let app, base;
const jar = {};
const mails = [];
async function call(who, method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const set = r.headers.get("set-cookie"); if (set) jar[who] = set.split(";")[0];
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

before(async () => {
  if (!DB) return;
  const c = new pg.Client({ connectionString: DB }); await c.connect(); await c.query("drop schema if exists whitepetal cascade"); await c.end();
  Object.assign(process.env, { DATABASE_URL: DB, CRON_SECRET: "tick-secret", APP_SECRET: "test", OPENAI_API_KEY: "fake", GEMINI_API_KEY: "fake", ACCESS_CODE: "", PLATFORM_OPERATORS: "op@x.co, boss@x.co", RESEND_API_KEY: "" });
  (await import("../../server/mail.mjs")).setSender(async (m) => { mails.push(m); return { sent: true }; });
  (await import("../../server/runner.mjs")).setHandlers(fakes);
  app = await (await import("../../server/app.mjs")).start({ port: 0, quiet: true });
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => { if (app) await app.stop(); });

test("accounts, brands, runs, schedules and isolation", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  assert.equal((await call("a", "GET", "/api/health")).data.db, true);
  assert.equal((await call("a", "POST", "/api/auth/signup", { email: "a@x.co", password: "short" })).status, 400);
  assert.equal((await call("a", "POST", "/api/auth/signup", { email: "a@x.co", password: "longenough1" })).status, 200);
  assert.equal((await call("a", "POST", "/api/auth/signup", { email: "A@x.co", password: "longenough1" })).status, 409);
  assert.equal((await call("a", "GET", "/api/me")).data.user.email, "a@x.co");

  assert.equal((await call("a", "PUT", "/api/workspaces/acme", { name: WS.name, site: WS.site, setup: WS.setup })).status, 200);
  const pat = await call("a", "PATCH", "/api/workspaces/acme", { schedule: "weekly", samples: 2, runNow: true });
  assert.equal(pat.data.workspace.schedule, "weekly"); assert.equal(pat.data.workspace.samples, 2);

  // someone else cannot see or touch it
  await call("b", "POST", "/api/auth/signup", { email: "b@x.co", password: "longenough2" });
  assert.equal((await call("b", "GET", "/api/workspaces/acme/runs")).status, 404);
  assert.equal((await call("b", "GET", "/api/workspaces")).data.workspaces.length, 0);

  // the scheduler: wrong secret refused, right secret runs the due brand end to end
  assert.equal((await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "nope" })).status, 401);
  const t = await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  assert.equal(t.status, 200); assert.equal(t.data.ran.length, 1); assert.equal(t.data.ran[0].slug, "acme");
  const runs = (await call("a", "GET", "/api/workspaces/acme/runs")).data.runs;
  assert.equal(runs[0].source, "scheduled"); assert.equal(runs[0].status, "done"); assert.ok(runs[0].summary.n > 0);
  const latest = (await call("a", "GET", "/api/workspaces/acme/runs/latest")).data;
  assert.equal(Object.keys(latest.run.answers).length, 2 * 2 * 2);
  const ws = (await call("a", "GET", "/api/workspaces")).data.workspaces[0];
  assert.ok(new Date(ws.nextRunAt) > Date.now() + 6 * 864e5); // next week
  assert.equal(ws.trend.length, 1);
  // nothing due now, so a second tick does nothing
  assert.equal((await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" })).data.ran.length, 0);

  // a live run saved by the browser
  const live = { id: "live1", slug: "acme", startedAt: Date.now(), finishedAt: Date.now(), profile: WS.setup.profile, answers: { "q1|chatgpt": { status: "yes", named: true, rank: 1, engine: "chatgpt", brands: ["Acme AI"] } } };
  assert.equal((await call("a", "PUT", "/api/runs/live1", { slug: "acme", data: live })).data.status, "done");
  assert.equal((await call("b", "GET", "/api/runs/live1")).status, 404);
  assert.equal((await call("b", "PUT", "/api/runs/live1", { slug: "acme", data: live })).status, 404);

  // integrations listing hides the platform-level SERP account and marks Google unavailable without OAuth keys
  const ints = (await call("a", "GET", "/api/workspaces/acme/integrations")).data.integrations;
  assert.ok(ints.find((i) => i.id === "bing")); assert.ok(!ints.find((i) => i.id === "serp"));
  assert.equal(ints.find((i) => i.id === "google").available, false);

  // AI routes need a session
  assert.equal((await call("nobody", "POST", "/api/ask", { engine: "chatgpt", question: "x" })).status, 401);
  assert.equal((await call("a", "POST", "/api/auth/logout")).status, 200);
  assert.equal((await call("a", "GET", "/api/me")).data.user, null);
  assert.equal((await call("a", "DELETE", "/api/workspaces/acme")).status, 401);
});

// ── organisations: a client organisation run by the operator, with an owner, editors and viewers ──
const tokenFrom = (link) => decodeURIComponent(String(link).split("#invite=")[1] || String(link).split("#reset=")[1] || "");
// Record usage the way the server does (event + the period's counters), for the organisation's current billing period.
async function useUp(orgId, { kind = "ask", sub = null, engine = null, n = 1, costUsd = null } = {}) {
  const { record } = await import("../../server/usage.mjs"); const { periodStart } = await import("../../server/billing.mjs");
  const org = (await sql(`select billing_status, trial_started_at, current_period_start from organizations where id = $1`, [orgId]))[0];
  const start = periodStart(org);
  for (let i = 0; i < n; i++) await record({ orgId, periodStart: start, kind, sub, engine });
  if (costUsd != null) { // top up the spend to an exact figure
    await sql(`insert into usage_counters (org_id, period_start, metric, used) values ($1, $2, 'ai_usd', $3) on conflict (org_id, period_start, metric) do update set used = usage_counters.used + $3`, [orgId, start, costUsd]);
  }
}
async function clearUsage(orgId) { await sql(`delete from usage where org_id = $1`, [orgId]); await sql(`delete from usage_counters where org_id = $1`, [orgId]); }
async function sql(text, params) { const c = new pg.Client({ connectionString: DB }); await c.connect(); try { await c.query("set search_path to whitepetal, public"); return (await c.query(text, params)).rows; } finally { await c.end(); } }

test("organisations: invites, roles, own keys, budget, scheduler, audit", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  // The operator signs up (gets a personal organisation on the platform keys) and creates a client organisation for Rahul.
  // Typing an operator's address at sign-up gives nothing until the address is proved.
  assert.equal((await call("evil", "POST", "/api/auth/signup", { email: "boss@x.co", password: "evil-pass-123" })).status, 200);
  assert.equal((await call("evil", "GET", "/api/config")).data.operator, false);
  assert.equal((await call("evil", "GET", "/api/admin/orgs")).status, 404);
  assert.equal((await call("evil", "POST", "/api/orgs", { name: "Grab" })).status, 403);
  assert.equal((await call("op", "POST", "/api/auth/signup", { email: "op@x.co", password: "operator-pass1", name: "Sathvik" })).status, 200);
  assert.equal((await call("op", "GET", "/api/config")).data.operator, false);
  const verify = mails.filter((m) => m.to === "op@x.co").at(-1);
  assert.match(verify.text, /#verify=/);
  assert.equal((await call("op", "POST", "/api/auth/verify", { token: verify.text.match(/#verify=([\w-]+)/)[1] })).status, 200);
  assert.equal((await call("op", "POST", "/api/auth/verify", { token: verify.text.match(/#verify=([\w-]+)/)[1] })).status, 400); // once
  let cfg = (await call("op", "GET", "/api/config")).data;
  assert.equal(cfg.user.verified, true);
  assert.equal(cfg.operator, true); assert.deepEqual(cfg.engines.sort(), ["chatgpt", "gemini"]); // platform keys
  const made = await call("op", "POST", "/api/orgs", { name: "AI Xccelerate", ownerEmail: "rahul@ax.co" });
  assert.equal(made.status, 200); assert.equal(made.data.org.slug, "ai-xccelerate"); assert.equal(made.data.org.role, "admin");
  assert.ok(made.data.invite.link.includes("#invite=")); assert.equal(mails.at(-1).to, "rahul@ax.co");
  cfg = (await call("op", "GET", "/api/config")).data;
  assert.deepEqual(cfg.engines, []); // a client organisation brings its own keys; the platform's are not used
  // Nobody else may create organisations
  await call("b2", "POST", "/api/auth/signup", { email: "b2@x.co", password: "longenough3" });
  assert.equal((await call("b2", "POST", "/api/orgs", { name: "Mine" })).status, 403);

  // Rahul opens the link, sees what it is, signs up with it and is the owner.
  const rToken = tokenFrom(made.data.invite.link);
  const look = await call("anon", "GET", "/api/invitations/" + rToken);
  assert.equal(look.data.org, "AI Xccelerate"); assert.equal(look.data.role, "owner"); assert.equal(look.data.account, false);
  assert.equal((await call("rahul", "POST", "/api/auth/signup", { email: "someone@else.co", password: "rahul-pass-1", invite: rToken })).status, 403); // wrong email
  assert.equal((await call("rahul", "POST", "/api/auth/signup", { email: "rahul@ax.co", password: "rahul-pass-1", name: "Rahul", invite: rToken })).status, 200);
  let me = (await call("rahul", "GET", "/api/me")).data;
  assert.equal(me.org.slug, "ai-xccelerate"); assert.equal(me.org.role, "owner"); assert.equal(me.orgs.length, 1);
  assert.equal((await call("anon", "GET", "/api/invitations/" + rToken)).status, 404); // used once

  // Rahul invites two marketers (editors) and a viewer.
  for (const [who, role] of [["m1", "editor"], ["m2", "editor"], ["v1", "viewer"]]) {
    const inv = await call("rahul", "POST", "/api/org/invitations", { email: `${who}@ax.co`, role });
    assert.equal(inv.status, 200); assert.equal(inv.data.invite.role, role);
    assert.equal((await call(who, "POST", "/api/auth/signup", { email: `${who}@ax.co`, password: "member-pass-1", invite: tokenFrom(inv.data.invite.link) })).status, 200);
  }
  assert.equal((await call("rahul", "POST", "/api/org/invitations", { email: "m1@ax.co", role: "viewer" })).status, 409); // already in
  assert.equal((await call("m1", "POST", "/api/org/invitations", { email: "z@ax.co", role: "viewer" })).status, 403); // editors can't invite
  const team = (await call("v1", "GET", "/api/org")).data;
  assert.equal(team.members.length, 5); assert.equal(team.keys, null); assert.deepEqual(team.invites, []); // viewers don't see keys or invites

  // Brands: editors create and change, viewers only read, deleting is for admins.
  assert.equal((await call("m1", "PUT", "/api/workspaces/aix", { name: "AI Xccelerate", site: "https://aixccelerate.com", setup: WS.setup })).status, 200);
  assert.equal((await call("v1", "GET", "/api/workspaces")).data.workspaces.length, 1);
  assert.equal((await call("v1", "PUT", "/api/workspaces/aix", { name: "x", setup: WS.setup })).status, 403);
  assert.equal((await call("v1", "PATCH", "/api/workspaces/aix", { runNow: true })).data.code, "role");
  assert.equal((await call("m2", "DELETE", "/api/workspaces/aix")).status, 403);
  assert.equal((await call("m1", "PUT", "/api/workspaces/aix/integrations/bing", { apiKey: "x" })).status, 403);
  assert.equal((await call("v1", "POST", "/api/ask", { engine: "chatgpt", question: "x" })).data.code, "role");
  // ...but a viewer can ask the agent about a run; this organisation has no keys yet, so the stream says so.
  const chat = await call("v1", "POST", "/api/write", { kind: "chat", data: { question: "hi" } });
  assert.equal(chat.status, 200); assert.match(String(chat.data), /No AI key configured/);
  // Other accounts can't see the brand.
  assert.equal((await call("b2", "GET", "/api/workspaces/aix/runs")).status, 404);

  // Keys: owner adds Gemini; status shows only the last 4 characters; engines follow the organisation's keys.
  assert.equal((await call("m1", "PUT", "/api/org/keys", { keys: { GEMINI_API_KEY: "gem-123456" } })).status, 403);
  const k = await call("rahul", "PUT", "/api/org/keys", { keys: { GEMINI_API_KEY: "gem-123456" } });
  const gem = k.data.keys.find((x) => x.name === "GEMINI_API_KEY");
  assert.equal(gem.set, true); assert.equal(gem.hint, "••••3456"); assert.ok(!JSON.stringify(k.data).includes("gem-123456"));
  assert.deepEqual((await call("m1", "GET", "/api/config")).data.engines, ["gemini"]);
  assert.deepEqual((await call("op", "GET", "/api/config")).data.engines, ["gemini"]); // the operator is in AI Xccelerate right now

  // Budget: over the cap, AI calls and scheduled checks stop.
  assert.equal((await call("rahul", "PATCH", "/api/org", { monthlyCapUsd: 1 })).status, 200);
  const [org] = await sql(`select id from organizations where slug = 'ai-xccelerate'`);
  await useUp(org.id, { kind: "ask", engine: "chatgpt", costUsd: 1.5 - 0.0145 });
  const capped = await call("m1", "POST", "/api/ask", { engine: "gemini", question: "x" });
  assert.equal(capped.status, 402); assert.equal(capped.data.code, "cap");
  assert.equal((await call("m1", "GET", "/api/config")).data.budget.over, true);
  assert.equal((await call("m1", "PATCH", "/api/workspaces/aix", { schedule: "weekly", runNow: true })).status, 200);
  assert.equal((await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" })).data.ran.length, 0);
  // Raise the cap: the next tick runs the brand on the organisation's own keys (Gemini only, not the platform's OpenAI).
  assert.equal((await call("rahul", "PATCH", "/api/org", { monthlyCapUsd: null })).status, 200);
  await sql(`update workspaces set next_run_at = now() where slug = 'aix'`);
  const t = await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  assert.equal(t.data.ran.length, 1); assert.equal(t.data.ran[0].slug, "aix");
  const run = (await call("v1", "GET", "/api/workspaces/aix/runs/latest")).data.run;
  assert.deepEqual(run.engines, ["gemini"]);
  const usage = (await call("rahul", "GET", "/api/org")).data.usage;
  assert.ok(usage.byEngine.find((x) => x.name === "gemini" && x.calls >= 2));

  // Roles: admins can't touch the owner; the owner can hand over ownership and stays an admin.
  const ids = Object.fromEntries((await call("rahul", "GET", "/api/org")).data.members.map((m) => [m.email.split("@")[0], m.id]));
  assert.equal((await call("op", "PATCH", "/api/org/members/" + ids.rahul, { role: "viewer" })).status, 403);
  assert.equal((await call("op", "PATCH", "/api/org/members/" + ids.op, { role: "owner" })).status, 403);
  assert.equal((await call("rahul", "PATCH", "/api/org/members/" + ids.m2, { role: "viewer" })).status, 200);
  assert.equal((await call("m2", "PUT", "/api/workspaces/aix", { name: "x", setup: WS.setup })).status, 403);
  assert.equal((await call("rahul", "PATCH", "/api/org/members/" + ids.op, { role: "owner" })).status, 200);
  assert.equal((await call("rahul", "GET", "/api/me")).data.org.role, "admin");
  assert.equal((await call("op", "PATCH", "/api/org/members/" + ids.rahul, { role: "owner" })).status, 200); // and back

  // Removing someone cuts them off at once.
  assert.equal((await call("rahul", "DELETE", "/api/org/members/" + ids.v1)).status, 200);
  assert.equal((await call("v1", "GET", "/api/workspaces")).data.code, "no_org");
  assert.equal((await call("rahul", "DELETE", "/api/org/members/" + ids.rahul)).status, 403); // the owner can't leave

  // Revoked invites stop working; the audit log has the story.
  const inv = await call("rahul", "POST", "/api/org/invitations", { email: "late@ax.co", role: "viewer" });
  assert.equal((await call("rahul", "DELETE", "/api/org/invitations/" + inv.data.invite.id)).status, 200);
  assert.equal((await call("anon", "GET", "/api/invitations/" + tokenFrom(inv.data.invite.link))).status, 404);
  const log = (await call("rahul", "GET", "/api/org/audit")).data.log.map((x) => x.action);
  for (const a of ["org.created", "invite.sent", "invite.accepted", "keys.changed", "org.updated", "check.skipped", "role.changed", "owner.transferred", "member.removed", "invite.revoked"]) assert.ok(log.includes(a), a);
  assert.equal((await call("m1", "GET", "/api/org/audit")).status, 403);

  // Operators can open any organisation (logged); others can't switch into one they're not in.
  assert.equal((await call("b2", "POST", "/api/orgs/ai-xccelerate/switch")).status, 404);
  const bOrg = (await call("b2", "GET", "/api/me")).data.org.slug;
  assert.equal((await call("op", "POST", `/api/orgs/${bOrg}/switch`)).data.org.operatorVisit, true);
  assert.ok((await sql(`select 1 from audit_log where action = 'operator.visit'`)).length);
  assert.equal((await call("op", "POST", "/api/orgs/ai-xccelerate/switch")).data.org.role, "admin");

  // Moving a brand from the operator's own organisation into the client's.
  const own = (await call("op", "GET", "/api/me")).data.orgs.find((o) => o.slug !== "ai-xccelerate").slug;
  await call("op", "POST", `/api/orgs/${own}/switch`);
  assert.equal((await call("op", "PUT", "/api/workspaces/pilot", { name: "Pilot", setup: WS.setup })).status, 200);
  assert.equal((await call("op", "PATCH", "/api/workspaces/pilot", { moveTo: "ai-xccelerate" })).data.moved.to, "ai-xccelerate");
  assert.equal((await call("m1", "GET", "/api/workspaces")).data.workspaces.length, 2);

  // AI routes check who is asking before reading the body, and cap its size.
  const big = "x".repeat(3 * 1024 * 1024);
  assert.equal((await call("nobody2", "POST", "/api/ask", { pad: big })).status, 401);
  // The server stops reading at the limit and closes the connection, so a client still uploading may see the socket close (EPIPE /
  // ECONNRESET) before it reads the 413. Both are the refusal.
  const tooBig = await call("m1", "POST", "/api/write", { kind: "chat", data: { question: big } }).then((r) => r.status, (e) => e.cause?.code);
  assert.ok([413, "EPIPE", "ECONNRESET"].includes(tooBig), `refused, got ${tooBig}`);
});

test("passwords: forgot and reset by email", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  mails.length = 0;
  assert.equal((await call("anon", "POST", "/api/auth/forgot", { email: "nobody@x.co" })).status, 200); // same answer, no email
  await new Promise((r) => setTimeout(r, 100)); assert.equal(mails.length, 0);
  assert.equal((await call("anon", "POST", "/api/auth/forgot", { email: "m1@ax.co" })).status, 200);
  for (let i = 0; i < 50 && !mails.length; i++) await new Promise((r) => setTimeout(r, 20)); // sent after the answer
  assert.equal(mails.length, 1); assert.match(mails[0].text, /#reset=/);
  const token = tokenFrom(mails[0].text.match(/https?:\S+/)[0]);
  assert.equal((await call("m1r", "POST", "/api/auth/reset", { token, password: "short" })).status, 400);
  assert.equal((await call("m1r", "POST", "/api/auth/reset", { token, password: "brand-new-pass" })).status, 200);
  assert.equal((await call("m1r", "POST", "/api/auth/reset", { token, password: "brand-new-pass" })).status, 400); // once
  assert.equal((await call("m1", "GET", "/api/me")).data.user, null); // old sessions ended
  assert.equal((await call("m1x", "POST", "/api/auth/login", { email: "m1@ax.co", password: "member-pass-1" })).status, 401);
  assert.equal((await call("m1x", "POST", "/api/auth/login", { email: "m1@ax.co", password: "brand-new-pass" })).status, 200);
});

// ── Recovery plan: durable recovery actions (06-DATA-STATE-CONTRACTS.md) ──
test("recovery actions: roles, isolation, sync upsert, lifecycle", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const R = "/api/workspaces/rec/recovery-actions";
  // An owner (personal organisation) with a brand, an editor and a viewer; and someone in another organisation.
  assert.equal((await call("ra", "POST", "/api/auth/signup", { email: "ra@rec.co", password: "recovery-pass1" }, { "x-forwarded-for": "10.0.0.7" })).status, 200);
  assert.equal((await call("ra", "PUT", "/api/workspaces/rec", { name: "Rec", site: "https://rec.co", setup: WS.setup })).status, 200);
  for (const [who, role] of [["re", "editor"], ["rv", "viewer"]]) {
    const inv = await call("ra", "POST", "/api/org/invitations", { email: `${who}@rec.co`, role });
    assert.equal((await call(who, "POST", "/api/auth/signup", { email: `${who}@rec.co`, password: "member-pass-1", invite: tokenFrom(inv.data.invite.link) })).status, 200);
  }
  assert.equal((await call("rx", "POST", "/api/auth/signup", { email: "rx@other.co", password: "other-pass-12" }, { "x-forwarded-for": "10.0.0.7" })).status, 200);
  assert.equal((await call("rx", "PUT", "/api/workspaces/rec", { name: "Other rec", setup: WS.setup })).status, 200); // same slug, other org

  // Runs: r1 (the source check, two days ago), r0 (another org's), r2 later (after publication).
  const at = (ms) => ({ startedAt: Date.now() - ms, finishedAt: Date.now() - ms + 1000, answers: {} });
  assert.equal((await call("re", "PUT", "/api/runs/rec-r1", { slug: "rec", data: { id: "rec-r1", slug: "rec", ...at(2 * 864e5) } })).status, 200);
  assert.equal((await call("rx", "PUT", "/api/runs/rec-x1", { slug: "rec", data: { id: "rec-x1", slug: "rec", ...at(1000) } })).status, 200);

  const suggestion = (over = {}) => ({ sourceKey: "question:q1:chatgpt", kind: "article", title: "Answer the bank question", problem: "ChatGPT did not name you in 0 of 3 answers.",
    rationale: "Competitors are cited on clutch.co.", evidence: { namedCount: 0, completedAnswerCount: 3 }, gapType: "decision", questionId: "q1", engine: "chatgpt", confidence: "high", ...over });

  // Viewers read but cannot sync; nobody outside the organisation sees anything.
  assert.equal((await call("rv", "GET", R)).status, 200);
  assert.deepEqual((await call("rv", "GET", R)).data.actions, []);
  const vs = await call("rv", "POST", R + "/sync", { runId: "rec-r1", actions: [suggestion()] });
  assert.equal(vs.status, 403); assert.equal(vs.data.code, "role");
  assert.equal((await call("nobody", "GET", R)).status, 401);

  // Editor syncs two suggestions from r1.
  let s = await call("re", "POST", R + "/sync", { runId: "rec-r1", actions: [suggestion(), suggestion({ sourceKey: "robots:GPTBot", kind: "fix", title: "Allow GPTBot", gapType: null, questionId: null, engine: null, confidence: "medium" })] });
  assert.equal(s.status, 200, JSON.stringify(s.data)); assert.equal(s.data.created, 2); assert.equal(s.data.updated, 0);
  assert.equal(s.data.actions.length, 2);
  const a1 = s.data.actions.find((a) => a.sourceKey === "question:q1:chatgpt");
  assert.equal(a1.status, "suggested"); assert.equal(a1.sourceRunId, "rec-r1"); assert.equal(a1.gapType, "decision"); assert.equal(a1.evidence.namedCount, 0);
  // Sync validation: missing fields, bad enums, a run from another organisation.
  assert.equal((await call("re", "POST", R + "/sync", { actions: [suggestion({ sourceKey: "" })] })).status, 400);
  assert.equal((await call("re", "POST", R + "/sync", { actions: [suggestion({ gapType: "panic" })] })).status, 400);
  assert.equal((await call("re", "POST", R + "/sync", { actions: [suggestion({ confidence: "certain" })] })).status, 400);
  assert.equal((await call("re", "POST", R + "/sync", { runId: "rec-x1", actions: [suggestion()] })).status, 400);
  assert.equal((await call("re", "POST", R + "/sync", { actions: "nope" })).status, 400);

  // Organisation isolation: the other org's same-slug brand has none of these; patching by id from there is a 404.
  assert.deepEqual((await call("rx", "GET", R)).data.actions, []);
  assert.equal((await call("rx", "PATCH", `${R}/${a1.id}`, { status: "drafting" })).status, 404);
  assert.equal((await call("re", "PATCH", `${R}/not-a-uuid`, { status: "drafting" })).status, 404);
  assert.equal((await call("rv", "PATCH", `${R}/${a1.id}`, { status: "drafting" })).status, 403);

  // Lifecycle: no skipping ahead; then suggested → drafting → ready_for_review → approved.
  let p = await call("re", "PATCH", `${R}/${a1.id}`, { status: "published" });
  assert.equal(p.status, 400); assert.match(p.data.error, /suggested/i);
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "done" })).status, 400);
  const ids = Object.fromEntries((await call("ra", "GET", "/api/org")).data.members.map((m) => [m.email.split("@")[0], m.id]));
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { ownerId: "00000000-0000-0000-0000-000000000000" })).status, 400); // not a member
  p = await call("re", "PATCH", `${R}/${a1.id}`, { status: "drafting", ownerId: ids.re, dueAt: "2026-11-01T00:00:00Z", output: { draft: "v1" } });
  assert.equal(p.status, 200, JSON.stringify(p.data)); assert.equal(p.data.action.status, "drafting"); assert.equal(p.data.action.ownerId, ids.re);
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { dueAt: "next tuesday" })).status, 400);
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "approved" })).status, 400); // drafting → approved skips review
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "ready_for_review" })).data.action.status, "ready_for_review");
  p = await call("re", "PATCH", `${R}/${a1.id}`, { status: "approved" });
  assert.equal(p.data.action.status, "approved"); assert.ok(p.data.action.approvedAt);

  // Published needs an explicit http(s) URL and an ISO date; never inferred.
  p = await call("re", "PATCH", `${R}/${a1.id}`, { status: "published" });
  assert.equal(p.status, 400); assert.match(p.data.error, /URL/);
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "published", publishedUrl: "javascript:alert(1)", publishedAt: new Date().toISOString() })).status, 400);
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "published", publishedUrl: "https://rec.co/guide" })).status, 400); // no date
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "published", publishedUrl: "https://rec.co/guide", publishedAt: "yesterday" })).status, 400);
  const pubAt = new Date(Date.now() - 3600e3).toISOString();
  p = await call("re", "PATCH", `${R}/${a1.id}`, { status: "published", publishedUrl: "https://rec.co/guide", publishedAt: pubAt });
  assert.equal(p.status, 200, JSON.stringify(p.data)); assert.equal(p.data.action.publishedUrl, "https://rec.co/guide");
  assert.equal(new Date(p.data.action.publishedAt).toISOString(), pubAt);

  // A rerun's sync refreshes evidence (same row, no duplicate) but never the status, owner, dates or publication.
  s = await call("re", "POST", R + "/sync", { runId: "rec-r1", actions: [suggestion({ title: "Answer the bank question (refreshed)", evidence: { namedCount: 1, completedAnswerCount: 3 }, confidence: "medium" })] });
  assert.equal(s.data.created, 0); assert.equal(s.data.updated, 1);
  let all = (await call("rv", "GET", R)).data.actions;
  assert.equal(all.length, 2);
  let got = all.find((a) => a.id === a1.id);
  assert.equal(got.evidence.namedCount, 1); assert.equal(got.title, "Answer the bank question (refreshed)"); assert.equal(got.confidence, "medium");
  assert.equal(got.status, "published"); assert.equal(got.ownerId, ids.re); assert.equal(got.publishedUrl, "https://rec.co/guide");
  assert.ok(got.dueAt); assert.ok(got.approvedAt); assert.deepEqual(got.output, { draft: "v1" });
  assert.equal((await sql(`select count(*)::int as n from recovery_actions where source_key = 'question:q1:chatgpt'`))[0].n, 1);

  // Published → recheck scheduled → result observed, which needs a later comparable run in this workspace.
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "result_observed", result: { comparisonRunId: "rec-r1" } })).status, 400); // skips recheck
  p = await call("re", "PATCH", `${R}/${a1.id}`, { status: "recheck_scheduled", recheckAt: new Date(Date.now() + 864e5).toISOString() });
  assert.equal(p.data.action.status, "recheck_scheduled"); assert.ok(p.data.action.recheckAt);
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "result_observed" })).status, 400); // no result
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "result_observed", result: { comparisonRunId: "rec-r1" } })).status, 400); // before publication
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "result_observed", result: { comparisonRunId: "rec-x1" } })).status, 400); // other org's run
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "result_observed", result: { comparisonRunId: "nope" } })).status, 400);
  assert.equal((await call("re", "PUT", "/api/runs/rec-r2", { slug: "rec", data: { id: "rec-r2", slug: "rec", ...at(1000) } })).status, 200);
  assert.equal((await call("re", "PATCH", `${R}/${a1.id}`, { status: "result_observed", result: { comparisonRunId: "rec-r2", direction: "skyrocketed" } })).status, 400);
  p = await call("re", "PATCH", `${R}/${a1.id}`, { status: "result_observed", result: { comparisonRunId: "rec-r2", comparable: true, before: { named: 0, total: 3 }, after: { named: 1, total: 3 }, direction: "improved" } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.action.status, "result_observed"); assert.equal(p.data.action.result.comparisonRunId, "rec-r2"); assert.ok(p.data.action.result.observedAt);
  assert.match(p.data.action.result.note, /causality/i);

  // Archive from any state keeps the previous one; restoring returns to it. Sync leaves archived actions archived.
  const a2 = all.find((a) => a.sourceKey === "robots:GPTBot");
  p = await call("re", "PATCH", `${R}/${a2.id}`, { status: "archived" });
  assert.equal(p.data.action.status, "archived"); assert.equal(p.data.action.result.previousStatus, "suggested");
  await call("re", "POST", R + "/sync", { actions: [suggestion({ sourceKey: "robots:GPTBot", kind: "fix", title: "Allow GPTBot", evidence: { bot: "GPTBot", allowed: false } })] });
  got = (await call("rv", "GET", R)).data.actions.find((a) => a.id === a2.id);
  assert.equal(got.status, "archived"); assert.equal(got.evidence.bot, "GPTBot"); assert.equal(got.result.previousStatus, "suggested");
  assert.equal((await call("re", "PATCH", `${R}/${a2.id}`, { status: "approved" })).status, 400); // only back to where it was
  p = await call("re", "PATCH", `${R}/${a2.id}`, { status: "suggested" });
  assert.equal(p.data.action.status, "suggested"); assert.equal(p.data.action.result.previousStatus, undefined);
  p = await call("re", "PATCH", `${R}/${a1.id}`, { status: "archived" });
  assert.equal(p.data.action.result.previousStatus, "result_observed"); assert.equal(p.data.action.result.comparisonRunId, "rec-r2");

  // Outreach reaches "published" with an explicit sent timestamp instead of a URL.
  s = await call("re", "POST", R + "/sync", { actions: [suggestion({ sourceKey: "source:https://clutch.co/ai", kind: "outreach", title: "Pitch clutch.co" })] });
  const o = s.data.actions.find((a) => a.kind === "outreach");
  for (const st of ["drafting", "ready_for_review", "approved"]) await call("re", "PATCH", `${R}/${o.id}`, { status: st });
  assert.equal((await call("re", "PATCH", `${R}/${o.id}`, { status: "published" })).status, 400);
  p = await call("re", "PATCH", `${R}/${o.id}`, { status: "published", sentAt: new Date().toISOString() });
  assert.equal(p.status, 200, JSON.stringify(p.data)); assert.equal(p.data.action.status, "published"); assert.ok(p.data.action.publishedAt);

  // No DELETE: archive instead. Material transitions are in the organisation's audit log.
  assert.equal((await call("ra", "DELETE", `${R}/${a1.id}`)).status, 404);
  const log = (await call("ra", "GET", "/api/org/audit")).data.log;
  assert.ok(log.find((x) => x.action === "recovery.synced"));
  assert.ok(log.find((x) => x.action === "recovery.status" && x.detail.to === "published"));
  assert.ok(log.find((x) => x.action === "recovery.status" && x.detail.to === "archived" && x.detail.from === "result_observed"));
});

// ── paid plans: limits are enforced on the server, per organisation ──
test("plans: limits, trial expiry, read-only, seats, integrations, engines, drafts, scheduler", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  process.env.BILLING_ENABLED = "operators"; // limits apply whenever billing is not "0"
  assert.equal((await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" })).status, 200);
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  const setPlan = (set, ...p) => sql(`update organizations set ${set} where id = $1`, [org, ...p]);
  const qs = (n) => Array.from({ length: n }, (_, i) => ({ text: `question ${i}`, on: true }));
  const put = (slug, n, extra = {}) => call("pl", "PUT", `/api/workspaces/${slug}`, { name: slug, setup: { profile: { name: slug, competitors: [] }, questions: qs(n), ...extra } });
  const code = (r) => r.data?.code;

  // Legacy (every existing organisation): unlimited, exactly as before.
  assert.equal((await put("one", 2)).status, 200); assert.equal((await put("two", 2)).status, 200); assert.equal((await put("three", 2)).status, 200);
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.plan.code, "legacy");
  await call("pl", "DELETE", "/api/workspaces/three");

  // Starter, active: 1 brand, 15 questions, 3 competitors, weekly at most, 1 seat, three engines, basic integrations, 10 drafts.
  await setPlan(`plan_code = 'starter', billing_status = 'active', current_period_start = now(), current_period_end = now() + interval '30 days'`);
  let r = await put("three", 1); assert.equal(r.status, 402); assert.equal(code(r), "plan_limit"); assert.equal(r.data.capability, "brands"); assert.equal(r.data.nextPlan, "growth");
  assert.equal((await put("one", 2)).status, 200); // editing an existing brand is not a new brand
  r = await put("one", 14); assert.equal(r.status, 402, "14 + 2 on the other brand is 16 > 15"); assert.equal(r.data.capability, "questions");
  assert.equal((await put("one", 13)).status, 200); // 13 + 2 = 15
  assert.equal((await put("one", 5)).status, 200);  // trimming is always allowed
  r = await put("one", 5, { profile: { name: "one", competitors: ["a", "b", "c", "d"] } }); assert.equal(r.data.capability, "competitors");
  assert.equal((await call("pl", "PATCH", "/api/workspaces/one", { schedule: "daily" })).data.capability, "schedule");
  assert.equal((await call("pl", "PATCH", "/api/workspaces/one", { schedule: "weekly" })).status, 200);
  assert.equal((await call("pl", "PATCH", "/api/workspaces/one", { samples: 3 })).data.capability, "samples");
  assert.equal((await call("pl", "PUT", "/api/workspaces/one/integrations/google", { propertyId: "x" })).data.capability, "integrations");
  assert.equal((await call("pl", "POST", "/api/org/invitations", { email: "second@x.co", role: "viewer" })).data.capability, "seats");
  assert.equal((await call("pl", "POST", "/api/ask", { engine: "aio", question: "x" })).data.capability, "engines");
  // Drafted fixes: 10 pitches/articles/fixpacks a period; chat and other writes are not drafts.
  await useUp(org, { kind: "write", sub: "pitch", n: 10 });
  r = await call("pl", "POST", "/api/write", { kind: "pitch", data: {} }); assert.equal(r.status, 402); assert.equal(r.data.capability, "drafts");
  assert.equal((await call("pl", "POST", "/api/write", { kind: "article", data: {} })).data.capability, "drafts");
  await clearUsage(org); // a new period starts again from zero
  const sum = (await call("pl", "GET", "/api/me")).data.billing; assert.equal(sum.used.drafts, 0); assert.equal(sum.limits.questions, 15);
  assert.ok(!JSON.stringify(sum).includes("capUsd"));

  // The plan's AI-cost allowance caps spend: an organisation over it is refused.
  await useUp(org, { kind: "ask", costUsd: 5.5 });
  assert.equal((await call("pl", "POST", "/api/write", { kind: "pitch", data: {} })).data.code, "cap");
  await clearUsage(org);

  // Trial that has ended: read-only. Reports stay readable; new work, edits and scheduled runs are refused.
  await setPlan(`plan_code = 'trial', billing_status = 'trialing', trial_started_at = now() - interval '8 days', trial_ends_at = now() - interval '1 day'`);
  await sql(`update workspaces set schedule = 'weekly', next_run_at = now() - interval '1 minute' where org_id = $1 and slug = 'one'`, [org]);
  r = await put("one", 1); assert.equal(r.status, 402); assert.equal(code(r), "billing_read_only"); assert.match(r.data.error, /trial has ended/i);
  assert.equal((await call("pl", "POST", "/api/write", { kind: "chat", data: {} })).data.code, "billing_read_only");
  assert.equal((await call("pl", "PATCH", "/api/workspaces/one", { runNow: true })).data.code, "billing_read_only");
  assert.equal((await call("pl", "GET", "/api/workspaces")).status, 200);
  assert.equal((await call("pl", "GET", "/api/workspaces/one/runs")).status, 200);
  await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  const skipped = (await call("pl", "GET", "/api/org/audit")).data.log.find((x) => x.action === "check.skipped");
  assert.match(skipped.detail.reason, /billing trialing/);

  // A live trial gets the standard trial limits, the same for every plan (1 brand, 20 questions, no integrations).
  await setPlan(`trial_ends_at = now() + interval '3 days'`);
  assert.equal((await put("one", 19)).data.capability, "questions"); // 19 + 2 on the other brand > 20
  assert.equal((await put("one", 18)).status, 200);
  assert.equal((await call("pl", "PUT", "/api/workspaces/one/integrations/bing", { apiKey: "x" })).data.capability, "integrations");

  // Past due inside the grace period: people may still work, scheduled spend is paused.
  await setPlan(`plan_code = 'growth', billing_status = 'past_due', grace_ends_at = now() + interval '2 days', current_period_start = now() - interval '30 days'`);
  assert.equal((await put("one", 10)).status, 200);
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "manual");
  await sql(`update workspaces set next_run_at = now() - interval '1 minute' where org_id = $1`, [org]);
  const before = (await sql(`select count(*)::int as n from runs r join workspaces w on w.id = r.workspace_id where w.org_id = $1`, [org]))[0].n;
  await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  assert.equal((await sql(`select count(*)::int as n from runs r join workspaces w on w.id = r.workspace_id where w.org_id = $1`, [org]))[0].n, before);
  await setPlan(`grace_ends_at = now() - interval '1 day'`);
  assert.equal((await put("one", 10)).data.code, "billing_read_only");

  // Two brands created at the same instant on a one-brand plan: only one wins (the organisation row is locked).
  await setPlan(`plan_code = 'starter', billing_status = 'active', current_period_end = now() + interval '30 days'`);
  await sql(`delete from workspaces where org_id = $1`, [org]);
  const both = await Promise.all([put("race-a", 1), put("race-b", 1)]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 402]);

  // Another organisation is untouched by all of this.
  assert.equal((await call("b", "GET", "/api/me")).data.billing.plan.code, "legacy");
  delete process.env.BILLING_ENABLED;
});

// ── Razorpay: checkout, signed webhooks and the subscription lifecycle (against a fake Razorpay) ──
test("razorpay: checkout, signed webhook, idempotency, ordering, failed renewal, cancellation", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const { setClient } = await import("../../server/razorpay.mjs");
  const created = []; setClient({ createSubscription: async (a) => { created.push(a); return { id: "sub_1" }; } });
  const SECRET = "whsec_test";
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: SECRET, RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR", RAZORPAY_PLAN_GROWTH_USD: "plan_G_USD", RAZORPAY_PLAN_STARTER_INR: "plan_S_INR" });
  delete process.env.BILLING_ENABLED;

  // Sign-ups are rate limited per address, so reuse the plans test's user (or create one when run alone).
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  await sql(`update organizations set plan_code = 'legacy', billing_status = 'internal', billing_currency = null, razorpay_subscription_id = null, razorpay_checkout_subscription_id = null, razorpay_customer_id = null,
             current_period_start = null, current_period_end = null, grace_ends_at = null, billing_event_at = null, pending_plan_code = null where id = $1`, [org]);
  await sql(`delete from billing_events`);
  const row = async () => (await sql(`select * from organizations where id = $1`, [org]))[0];
  let T = Math.floor(Date.now() / 1000);
  const sub = (event, extra = {}, planId = "plan_G_INR", subId = "sub_1") => ({ event, created_at: ++T, payload: { subscription: { entity: { id: subId, plan_id: planId, status: "active", current_start: T, current_end: T + 30 * 86400, ...extra } } } });
  const hook = async (evt, { id = "evt_" + Math.random().toString(36).slice(2), sig } = {}) => {
    const raw = JSON.stringify(evt);
    const r = await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-event-id": id, "x-razorpay-signature": sig ?? crypto.createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw });
    return { status: r.status, data: await r.json().catch(() => ({})), id };
  };

  // The catalogue is public and exposes no provider ids; checkout is off until billing is enabled.
  const cat = await call("x", "GET", "/api/billing/plans");
  assert.equal(cat.status, 200); assert.ok(!/plan_G|rzp_|sk|razorpay/i.test(JSON.stringify(cat.data)));
  assert.equal(cat.data.available.growth.INR, true); assert.equal(cat.data.available.agency.INR, false);
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).data.code, "billing_disabled");
  process.env.BILLING_ENABLED = "1";

  // Checkout: owner only, validated, mapped to a configured plan id on the server. It grants nothing.
  assert.equal((await call("nobody", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).status, 401);
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "enterprise", currency: "INR" })).data.code, "bad_plan");
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "EUR" })).data.code, "bad_currency");
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "agency", currency: "INR" })).data.code, "plan_unavailable");
  const co = await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR", amount: 1, planId: "evil" });
  assert.equal(co.status, 200); assert.equal(co.data.subscriptionId, "sub_1"); assert.equal(co.data.amount, 1179882); assert.equal(co.data.testMode, true); assert.equal(co.data.upi, true, "Growth with GST is under the ₹15,000 UPI limit");
  assert.equal(created.length, 1); assert.equal(created[0].planId, "plan_G_INR"); assert.equal(created[0].orgId, org);
  assert.equal((await row()).plan_code, "legacy", "checkout alone must not change the plan");

  // Signature: wrong or missing is refused and recorded nowhere.
  assert.equal((await hook(sub("subscription.activated"), { sig: "0".repeat(64) })).status, 401);
  assert.equal((await hook(sub("subscription.activated"), { sig: "" })).status, 401);
  assert.equal((await sql(`select count(*)::int as n from billing_events`))[0].n, 0);

  // A valid signed activation moves the organisation onto the plan, once.
  const act = await hook(sub("subscription.activated", { customer_id: "cust_1" }), { id: "evt_act" });
  assert.equal(act.status, 200); assert.equal(act.data.status, "processed");
  let o = await row(); assert.equal(o.plan_code, "growth"); assert.equal(o.billing_status, "active"); assert.equal(o.billing_currency, "INR");
  assert.equal(o.razorpay_customer_id, "cust_1"); assert.ok(new Date(o.current_period_end) > Date.now());
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.plan.code, "growth");
  assert.equal((await call("pl", "GET", "/api/billing")).data.limits.brands, 1);
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).data.code, "has_subscription");

  // Idempotent: the same event id again, and two identical deliveries at once, change state once.
  const dupEvt = sub("subscription.charged");
  assert.equal((await hook(dupEvt, { id: "evt_act" })).data.duplicate, true);
  const pair = await Promise.all([hook(dupEvt, { id: "evt_pair" }), hook(dupEvt, { id: "evt_pair" })]);
  assert.deepEqual(pair.map((p) => !!p.data.duplicate).sort(), [false, true]);
  assert.equal((await sql(`select count(*)::int as n from billing_events where event_id in ('evt_act','evt_pair')`))[0].n, 2);

  // Out of order: an older event can't undo a newer state.
  const old = sub("subscription.halted"); old.created_at = T - 500;
  const ig = await hook(old); assert.equal(ig.data.status, "ignored"); assert.equal((await row()).billing_status, "active");

  // Unknown subscription, unknown plan id, unused events: acknowledged, recorded as ignored, nothing changes.
  assert.equal((await hook(sub("subscription.charged", {}, "plan_G_INR", "sub_other"))).data.ignored, true);
  assert.equal((await hook(sub("subscription.charged", {}, "plan_UNKNOWN"))).data.status, "ignored");
  assert.equal((await hook({ event: "payment.captured", created_at: ++T, payload: { payment: { entity: { id: "pay_1" } } } })).data.status, "ignored");
  assert.equal((await row()).plan_code, "growth");

  // Only identifiers and statuses are stored, never card or contact details.
  const leaky = sub("subscription.charged", { notes: { email: "secret@x.co" } }); leaky.payload.payment = { entity: { card: { last4: "4242" }, email: "secret@x.co", contact: "+919999999999" } };
  await hook(leaky, { id: "evt_leaky" });
  const stored = JSON.stringify((await sql(`select payload from billing_events where event_id = 'evt_leaky'`))[0].payload);
  assert.ok(!/4242|secret@x\.co|9999999999|card/.test(stored), stored);

  // Failed renewal: past due with a 3-day grace (people can work, scheduled spend pauses); retries don't extend it;
  // halted makes it read-only; a successful charge restores it.
  await hook(sub("subscription.pending"));
  o = await row(); assert.equal(o.billing_status, "past_due");
  const grace = new Date(o.grace_ends_at).getTime(); assert.ok(grace > Date.now() + 2.5 * 864e5 && grace < Date.now() + 3.5 * 864e5);
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "manual");
  await hook(sub("subscription.pending")); assert.equal(new Date((await row()).grace_ends_at).getTime(), grace);
  await hook(sub("subscription.halted"));
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "read");
  assert.equal((await call("pl", "POST", "/api/write", { kind: "chat", data: {} })).data.code, "billing_read_only");
  await hook(sub("subscription.charged"));
  o = await row(); assert.equal(o.billing_status, "active"); assert.equal(o.grace_ends_at, null);
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "write");

  // subscription.updated is Razorpay saying a plan change happened (an upgrade only after its difference was charged; a downgrade
  // when the cycle turns), so it applies either way. A change that is only scheduled does not.
  await hook(sub("subscription.updated", { has_scheduled_changes: true }, "plan_S_INR")); assert.equal((await row()).plan_code, "growth", "a scheduled change is not applied early");
  await hook(sub("subscription.updated", { has_scheduled_changes: false }, "plan_S_INR")); assert.equal((await row()).plan_code, "starter");
  await hook(sub("subscription.updated", {}, "plan_G_INR")); assert.equal((await row()).plan_code, "growth", "an upgrade lands on its updated event, no charged event needed");

  // Cancellation: access to the end of the paid period, then read-only.
  await hook(sub("subscription.cancelled", { current_end: T + 5 * 86400 }));
  o = await row(); assert.equal(o.billing_status, "canceled"); assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "write");
  await hook(sub("subscription.cancelled", { current_end: T - 86400 }));
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "read");

  // The audit log records plan changes; another organisation is untouched.
  assert.ok((await call("pl", "GET", "/api/org/audit")).data.log.find((x) => x.action === "billing.activated"));
  if (jar.b) assert.equal((await call("b", "GET", "/api/me")).data.billing.plan.code, "legacy");
  delete process.env.BILLING_ENABLED; setClient(null);
});

test("razorpay: change plan, downgrade blockers, withdraw, cancel, resubscribe, reconciliation", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const { setClient } = await import("../../server/razorpay.mjs");
  const calls = []; let remote = {};
  setClient({
    createSubscription: async (a) => { calls.push(["create", a.planId]); return { id: "sub_new" }; },
    updateSubscription: async (id, a) => { calls.push(["update", id, a.planId, a.at]); return {}; },
    cancelSubscription: async (id, a) => { calls.push(["cancel", id, a.atCycleEnd]); return {}; },
    cancelScheduledChanges: async (id) => { calls.push(["unschedule", id]); return {}; },
    fetchSubscription: async () => remote,
  });
  const SECRET = "whsec_test";
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: SECRET,
    RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR", RAZORPAY_PLAN_STARTER_INR: "plan_S_INR", RAZORPAY_PLAN_AGENCY_INR: "plan_A_INR", RAZORPAY_PLAN_GROWTH_USD: "plan_G_USD" });
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  const row = async () => (await sql(`select * from organizations where id = $1`, [org]))[0];
  const set = (s, ...p) => sql(`update organizations set ${s} where id = $1`, [org, ...p]);
  await sql(`delete from workspaces where org_id = $1`, [org]);
  await set(`plan_code = 'growth', billing_status = 'active', billing_currency = 'INR', razorpay_subscription_id = 'sub_2', razorpay_checkout_subscription_id = null, pending_plan_code = null, cancel_at_period_end = false,
             grace_ends_at = null, billing_event_at = null, billing_reconciled_at = now(), current_period_start = now() - interval '5 days', current_period_end = now() + interval '25 days', entitlement_overrides = '{}'`);
  let T = Math.floor(Date.now() / 1000);
  const hook = async (event, planId, subId = "sub_2") => {
    const raw = JSON.stringify({ event, created_at: ++T, payload: { subscription: { entity: { id: subId, plan_id: planId, current_start: T, current_end: T + 30 * 86400 } } } });
    return (await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "e" + Math.random(), "x-razorpay-signature": crypto.createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw })).status;
  };
  const cp = (plan, extra = {}) => call("pl", "POST", "/api/billing/change-plan", { plan, ...extra });

  // Upgrade: Razorpay is told "now" in the subscription's own currency (a USD request is ignored); the plan waits for the charge.
  assert.equal((await call("nobody", "POST", "/api/billing/change-plan", { plan: "agency" })).status, 401);
  assert.equal((await cp("enterprise")).data.code, "bad_plan");
  let r = await cp("agency", { currency: "USD" }); assert.equal(r.status, 200); assert.equal(r.data.upgrade, true);
  assert.deepEqual(calls.at(-1), ["update", "sub_2", "plan_A_INR", "now"]);
  assert.equal((await row()).plan_code, "growth"); assert.equal((await row()).pending_plan_code, null);
  assert.equal(await hook("subscription.charged", "plan_A_INR"), 200); assert.equal((await row()).plan_code, "agency");
  assert.equal((await cp("agency")).data.code, "same_plan");

  // Downgrade is refused while usage is over the cheaper plan; nothing is deleted for them.
  const brand = (s) => call("pl", "PUT", `/api/workspaces/${s}`, { name: s, setup: { profile: { name: s, competitors: [] }, questions: [{ text: "q", on: true }] } });
  assert.equal((await brand("b1")).status, 200); assert.equal((await brand("b2")).status, 200);
  r = await cp("growth"); assert.equal(r.status, 409); assert.equal(r.data.code, "over_plan"); assert.match(r.data.blockers.join(), /2 brands/);
  const nCalls = calls.length; assert.equal((await cp("growth")).status, 409); assert.equal(calls.length, nCalls, "no Razorpay call when blocked");
  await call("pl", "DELETE", "/api/workspaces/b2");
  r = await cp("growth"); assert.equal(r.status, 200); assert.equal(r.data.upgrade, false); assert.equal(r.data.pendingPlan, "growth");
  assert.deepEqual(calls.at(-1), ["update", "sub_2", "plan_G_INR", "cycle_end"]);
  assert.equal((await row()).pending_plan_code, "growth"); assert.equal((await row()).plan_code, "agency", "a downgrade does not apply until the cycle ends");
  assert.equal((await call("pl", "GET", "/api/billing")).data.plan.pendingPlan, "growth");

  // Choosing the current plan withdraws the scheduled downgrade.
  assert.equal((await cp("agency")).status, 200); assert.deepEqual(calls.at(-1), ["unschedule", "sub_2"]); assert.equal((await row()).pending_plan_code, null);

  // Cancel: at cycle end, idempotent, access continues; resubscribing is allowed and old-subscription events are then ignored.
  r = await call("pl", "POST", "/api/billing/cancel"); assert.equal(r.status, 200);
  assert.deepEqual(calls.at(-1), ["cancel", "sub_2", true]); assert.equal((await row()).cancel_at_period_end, true);
  const n2 = calls.length; await call("pl", "POST", "/api/billing/cancel"); assert.equal(calls.length, n2);
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "write");
  assert.equal((await cp("growth")).data.code, "cancelling");
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).status, 200);
  let o0 = await row(); assert.equal(o0.razorpay_subscription_id, "sub_2", "an unpaid checkout never replaces the paying subscription"); assert.equal(o0.razorpay_checkout_subscription_id, "sub_new");
  assert.equal(await hook("subscription.authenticated", "plan_G_INR", "sub_new"), 200); assert.equal((await row()).razorpay_subscription_id, "sub_2");
  // Paying the new subscription adopts it and retires the old one upstream, so the customer is never billed twice.
  assert.equal(await hook("subscription.activated", "plan_G_INR", "sub_new"), 200);
  o0 = await row(); assert.equal(o0.razorpay_subscription_id, "sub_new"); assert.equal(o0.razorpay_checkout_subscription_id, null); assert.equal(o0.cancel_at_period_end, false); assert.equal(o0.plan_code, "growth");
  assert.deepEqual(calls.at(-1), ["cancel", "sub_2", false]);
  assert.equal(await hook("subscription.cancelled", "plan_A_INR", "sub_2"), 200); assert.equal((await row()).billing_status, "active", "the old subscription no longer matches");

  // Reconciliation: a missed "halted" webhook is applied from Razorpay's state; a recovery likewise; both leave billing_event_at alone.
  await set(`razorpay_subscription_id = 'sub_r', razorpay_checkout_subscription_id = null, cancel_at_period_end = false, billing_event_at = to_timestamp($2), billing_reconciled_at = null`, T);
  remote = { id: "sub_r", status: "halted", plan_id: "plan_A_INR", has_scheduled_changes: false };
  await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  let o = await row(); assert.equal(o.billing_status, "past_due"); assert.ok(new Date(o.grace_ends_at) <= new Date());
  assert.equal(Math.floor(new Date(o.billing_event_at).getTime() / 1000), T); assert.ok(o.billing_reconciled_at);
  assert.ok((await call("pl", "GET", "/api/org/audit")).data.log.find((x) => x.action === "billing.reconciled"));
  await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" }); // at most once a day: still past due, no second call
  await set(`billing_reconciled_at = null`); remote = { id: "sub_r", status: "active", plan_id: "plan_A_INR", current_start: T, current_end: T + 86400 * 30, has_scheduled_changes: false };
  await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  o = await row(); assert.equal(o.billing_status, "active"); assert.equal(o.grace_ends_at, null);

  delete process.env.BILLING_ENABLED; setClient(null);
});

test("self-serve: anyone signs up with no invite code; with billing open, choosing a plan starts their one 7-day trial", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const ip = { "x-forwarded-for": "10.7.7.7" }; // sign-ups are rate limited per address
  // There is no sign-up code: ACCESS_CODE only guards the AI endpoints when there is no database.
  process.env.ACCESS_CODE = "letmein"; delete process.env.BILLING_ENABLED;
  assert.equal((await call("so", "POST", "/api/auth/signup", { email: "open-signup@x.co", password: "longenough1" }, ip)).status, 200);
  assert.ok(!("invite" in (await call("x", "GET", "/api/config")).data));
  process.env.BILLING_ENABLED = "1";
  const s = await call("st", "POST", "/api/auth/signup", { email: "trial@x.co", password: "longenough1" }, ip); assert.equal(s.status, 200);
  // Signing up starts the 7-day free trial straight away, with no plan picked yet.
  let me = (await call("st", "GET", "/api/me")).data;
  assert.equal(me.billing.plan.status, "trialing"); assert.equal(me.billing.mode, "write"); assert.equal(me.billing.trialChosen, false);
  const days = (new Date(me.billing.trialEndsAt) - Date.now()) / 864e5; assert.ok(days > 6.9 && days < 7.1, String(days));
  // Picking a plan puts the running trial on that plan; switching keeps the same window.
  let r = await call("st", "POST", "/api/billing/start-trial", { plan: "growth" }); assert.equal(r.status, 200); assert.equal(r.data.plan.status, "trialing"); assert.equal(r.data.mode, "write");
  assert.equal(r.data.trialEndsAt, me.billing.trialEndsAt);
  r = await call("st", "POST", "/api/billing/start-trial", { plan: "starter" }); assert.equal(r.data.plan.code, "starter"); assert.equal(r.data.trialEndsAt, (await call("st", "GET", "/api/me")).data.billing.trialEndsAt);
  me = (await call("st", "GET", "/api/me")).data; const window = me.billing.trialEndsAt;
  assert.equal(me.billing.limits.brands, 1);
  const brand = (slug) => call("st", "PUT", `/api/workspaces/${slug}`, { name: slug, setup: { questions: [] } });
  assert.equal((await brand("first")).status, 200); assert.equal((await brand("second")).data.capability, "brands");
  // One trial per person: another organisation of theirs joins the same window instead of getting a fresh week...
  const uid = me.user.id, other = (await sql(`insert into organizations (name, slug, plan_code, billing_status) values ('Second', 'second-trial-org', 'trial', 'new') returning id`))[0].id;
  await sql(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [other, uid]);
  const { beginTrial } = await import("../../server/billing.mjs");
  await beginTrial(other, uid, 7); assert.equal(new Date((await sql(`select trial_ends_at from organizations where id = $1`, [other]))[0].trial_ends_at).toISOString(), new Date(window).toISOString());
  // ...and once that window has passed there is no trial left: they subscribe instead.
  await sql(`update users set trial_ends_at = now() - interval '1 minute' where id = $1`, [uid]); await sql(`update organizations set billing_status = 'new' where id = $1`, [other]);
  await assert.rejects(beginTrial(other, uid, 7), (e) => e.extra?.code === "trial_used" || /already used your free trial/.test(e.message));
  assert.equal((await sql(`select billing_status from organizations where id = $1`, [other]))[0].billing_status, "new");
  await sql(`delete from organizations where id = $1`, [other]);
  // An organisation from before the trial began at sign-up (still waiting on a plan): starting with no plan gives the default trial, once.
  assert.equal((await call("st", "POST", "/api/billing/start-trial", {})).data.code, "not_new", "a running trial isn't restarted");
  await sql(`update users set trial_started_at = null, trial_ends_at = null where id = $1`, [uid]);
  await sql(`update organizations set plan_code = 'trial', billing_status = 'new', trial_started_at = null, trial_ends_at = null where id = $1`, [me.org.id]);
  r = await call("st", "POST", "/api/billing/start-trial", {}); assert.equal(r.status, 200); assert.equal(r.data.plan.status, "trialing"); assert.equal(r.data.trialChosen, false); assert.equal(r.data.mode, "write");
  // Existing and operator-created organisations are never turned into trials.
  assert.equal((await call("b", "GET", "/api/me")).data.billing.plan.code, "legacy");
  process.env.ACCESS_CODE = ""; delete process.env.BILLING_ENABLED;
});

test("flag: 0 is a kill switch, operators gates checkout, an expired trial can buy and is restored", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const { setClient } = await import("../../server/razorpay.mjs");
  setClient({ createSubscription: async () => ({ id: "sub_t" }) });
  const SECRET = "whsec_test";
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: SECRET, RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR" });
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  await sql(`update organizations set plan_code = 'trial', billing_status = 'trialing', billing_currency = null, razorpay_subscription_id = null, razorpay_checkout_subscription_id = null, trial_started_at = now() - interval '9 days',
             trial_ends_at = now() - interval '2 days', current_period_start = null, current_period_end = null, grace_ends_at = null, billing_event_at = null, pending_plan_code = null, cancel_at_period_end = false where id = $1`, [org]);
  await sql(`delete from workspaces where org_id = $1`, [org]);
  const put = (n) => call("pl", "PUT", "/api/workspaces/flagged", { name: "flagged", setup: { questions: Array.from({ length: n }, (_, i) => ({ text: "q" + i, on: true })) } });
  const me = async () => (await call("pl", "GET", "/api/me")).data.billing;

  // BILLING_ENABLED=0: whatever the data says (an ended trial), nobody is limited or locked, and checkout is closed.
  delete process.env.BILLING_ENABLED;
  assert.equal((await put(50)).status, 200); assert.equal((await me()).mode, "write"); assert.equal((await me()).limits.brands, null);
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).data.code, "billing_disabled");

  // operators: the ended trial is enforced again, and only a platform operator can start checkout.
  process.env.BILLING_ENABLED = "operators";
  assert.equal((await me()).mode, "read"); assert.equal((await put(5)).data.code, "billing_read_only");
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).data.code, "billing_disabled");
  await sql(`update users set email_verified_at = now() where email = 'plans@x.co'`);
  process.env.PLATFORM_OPERATORS += ",plans@x.co";
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).status, 200);

  // The signed activation turns the ended trial into a paid plan, and write access returns.
  const raw = JSON.stringify({ event: "subscription.activated", created_at: Math.floor(Date.now() / 1000), payload: { subscription: { entity: { id: "sub_t", plan_id: "plan_G_INR", current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 30 * 86400 } } } });
  const h = await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "evt_trial_to_paid", "x-razorpay-signature": crypto.createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw });
  assert.equal(h.status, 200);
  const after = await me(); assert.equal(after.plan.code, "growth"); assert.equal(after.plan.status, "active"); assert.equal(after.mode, "write");
  assert.equal((await put(5)).status, 200);
  process.env.PLATFORM_OPERATORS = process.env.PLATFORM_OPERATORS.replace(",plans@x.co", "");
  delete process.env.BILLING_ENABLED; setClient(null);
});

test("razorpay hardening: callback signature, abandoned and duplicate checkouts, past-due restart, request limits", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const { setClient } = await import("../../server/razorpay.mjs");
  const calls = []; let n = 0, remote = {};
  setClient({
    createSubscription: async (a) => { calls.push(["create", a.planId]); return { id: "sub_c" + ++n }; },
    cancelSubscription: async (id, a) => { calls.push(["cancel", id, a.atCycleEnd]); return {}; },
    fetchSubscription: async (id) => remote[id] || { id, status: "created" },
  });
  const KEY_SECRET = "sk", WH = "whsec_test";
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WH, RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR", RAZORPAY_PLAN_STARTER_INR: "plan_S_INR" });
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  const row = async () => (await sql(`select * from organizations where id = $1`, [org]))[0];
  const reset = () => sql(`update organizations set plan_code = 'legacy', billing_status = 'internal', billing_currency = null, razorpay_subscription_id = null, razorpay_checkout_subscription_id = null,
    current_period_start = null, current_period_end = null, grace_ends_at = null, billing_event_at = null, pending_plan_code = null, cancel_at_period_end = false where id = $1`, [org]);
  await reset(); await sql(`delete from billing_events`);
  let T = Math.floor(Date.now() / 1000);
  const evt = (event, planId, subId, extra = {}) => ({ event, created_at: ++T, payload: { subscription: { entity: { id: subId, plan_id: planId, status: "active", current_start: T, current_end: T + 30 * 86400, ...extra } } } });
  const hook = async (e, id = "e" + Math.random()) => { const raw = JSON.stringify(e); return (await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": id, "x-razorpay-signature": crypto.createHmac("sha256", WH).update(raw).digest("hex") }, body: raw })).data; };
  const post = async (e) => { const raw = JSON.stringify(e); const r = await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "e" + Math.random(), "x-razorpay-signature": crypto.createHmac("sha256", WH).update(raw).digest("hex") }, body: raw }); return { status: r.status, data: await r.json() }; };
  const checkout = (plan = "growth") => call("pl", "POST", "/api/billing/checkout", { plan, currency: "INR" });
  const sig = (pay, sid, key = KEY_SECRET) => crypto.createHmac("sha256", key).update(`${pay}|${sid}`).digest("hex");
  const verify = (b) => call("pl", "POST", "/api/billing/verify", b);

  // An abandoned checkout leaves the organisation exactly as it was, and its currency unlocked.
  assert.equal((await checkout()).status, 200); let o = await row();
  assert.equal(o.razorpay_checkout_subscription_id, "sub_c1"); assert.equal(o.razorpay_subscription_id, null); assert.equal(o.billing_currency, null); assert.equal(o.plan_code, "legacy");
  // A second checkout cancels the first unpaid one upstream, so two payment windows can't both be paid.
  assert.equal((await checkout("starter")).status, 200); o = await row();
  assert.deepEqual(calls.filter((c) => c[0] === "cancel").at(-1), ["cancel", "sub_c1", false]); assert.equal(o.razorpay_checkout_subscription_id, "sub_c2");
  // Money for the replaced checkout would be unattributed: it is recorded as ignored and the error log raises an alert, never applied.
  assert.equal((await post(evt("subscription.charged", "plan_G_INR", "sub_c1"))).data.status, "ignored"); assert.equal((await row()).plan_code, "legacy");

  // The checkout callback: a wrong signature, someone else's subscription, and a missing field are all refused and change nothing.
  assert.equal((await verify({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_c2", razorpay_signature: "0".repeat(64) })).data.code, "bad_signature");
  assert.equal((await verify({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_c2", razorpay_signature: sig("pay_1", "sub_c2", "other-secret") })).data.code, "bad_signature");
  assert.equal((await verify({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_other", razorpay_signature: sig("pay_1", "sub_other") })).data.code, "bad_subscription");
  assert.equal((await verify({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_c2" })).data.code, "bad_signature");
  assert.equal((await call("nobody", "POST", "/api/billing/verify", {})).status, 401);
  assert.equal((await row()).plan_code, "legacy");
  // A genuine callback with Razorpay saying it is paid (the webhook has not arrived yet): the plan comes from Razorpay's own record.
  remote.sub_c2 = { id: "sub_c2", status: "active", plan_id: "plan_S_INR", current_start: T, current_end: T + 30 * 86400, has_scheduled_changes: false };
  const ok = await verify({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_c2", razorpay_signature: sig("pay_1", "sub_c2") });
  assert.equal(ok.status, 200); assert.equal(ok.data.verified, true); assert.equal(ok.data.plan.code, "starter"); assert.equal(ok.data.plan.status, "active");
  o = await row(); assert.equal(o.razorpay_subscription_id, "sub_c2"); assert.equal(o.razorpay_checkout_subscription_id, null); assert.equal(o.billing_currency, "INR");
  // The webhook for the same payment then arrives: nothing changes twice.
  assert.equal((await post(evt("subscription.activated", "plan_S_INR", "sub_c2"))).data.status, "processed"); assert.equal((await row()).plan_code, "starter");
  // A genuine callback while Razorpay still says "authenticated" (not charged yet) grants nothing.
  await reset(); await sql(`update organizations set razorpay_checkout_subscription_id = 'sub_c9' where id = $1`, [org]);
  remote.sub_c9 = { id: "sub_c9", status: "authenticated", plan_id: "plan_G_INR" };
  assert.equal((await verify({ razorpay_payment_id: "pay_9", razorpay_subscription_id: "sub_c9", razorpay_signature: sig("pay_9", "sub_c9") })).data.plan.code, "legacy");

  // A second subscription paid while one is already active is stopped upstream and never applied.
  await reset(); await sql(`update organizations set plan_code = 'starter', billing_status = 'active', razorpay_subscription_id = 'sub_live', current_period_end = now() + interval '20 days' where id = $1`, [org]);
  const dup = await post(evt("subscription.activated", "plan_G_INR", "sub_dup", { notes: { white_petal_org_id: org } }));
  assert.equal(dup.data.status, "ignored"); assert.deepEqual(calls.at(-1), ["cancel", "sub_dup", false]); o = await row(); assert.equal(o.plan_code, "starter"); assert.equal(o.razorpay_subscription_id, "sub_live");

  // Past due and read-only: the owner may start over; paying the new subscription restores access and retires the failed one.
  await sql(`update organizations set billing_status = 'past_due', grace_ends_at = now() - interval '1 day' where id = $1`, [org]);
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "read");
  assert.equal((await checkout()).status, 200); const pend = (await row()).razorpay_checkout_subscription_id;
  assert.equal((await post(evt("subscription.charged", "plan_G_INR", pend))).data.status, "processed");
  o = await row(); assert.equal(o.billing_status, "active"); assert.equal(o.plan_code, "growth"); assert.equal(o.razorpay_subscription_id, pend); assert.equal(o.grace_ends_at, null);
  assert.deepEqual(calls.at(-1), ["cancel", "sub_live", false]);
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "write");

  // The payment link: a url when Razorpay has one, null (not an error) when it does not.
  remote[pend] = { id: pend, status: "active", short_url: "https://rzp.io/i/abc" };
  assert.equal((await call("pl", "GET", "/api/billing/payment-link")).data.url, "https://rzp.io/i/abc");
  remote[pend] = { id: pend, status: "halted", short_url: null };
  assert.equal((await call("pl", "GET", "/api/billing/payment-link")).data.url, null);

  // Request limits: a flood of bad webhook signatures is throttled; the rest of the API is unaffected.
  const bad = async () => (await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-signature": "bad", "x-forwarded-for": "10.9.9.9" }, body: "{}" })).status;
  const codes = []; for (let i = 0; i < 24; i++) codes.push(await bad());
  assert.ok(codes.slice(0, 20).every((c) => c === 401)); assert.ok(codes.slice(20).every((c) => c === 429));
  assert.equal((await call("pl", "GET", "/api/billing")).status, 200);
  delete process.env.BILLING_ENABLED; setClient(null);
});

test("operators: set a plan by hand with a reason; trial is once per person", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  process.env.BILLING_ENABLED = "operators";
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const slug = (await call("pl", "GET", "/api/me")).data.org.slug, org = (await call("pl", "GET", "/api/me")).data.org.id;
  await sql(`update organizations set plan_code = 'legacy', billing_status = 'internal', razorpay_subscription_id = null, razorpay_checkout_subscription_id = null, entitlement_overrides = '{}', current_period_end = null where id = $1`, [org]);
  const set = (b) => call("pl", "PATCH", `/api/admin/orgs/${slug}/billing`, b);
  assert.equal((await set({ plan: "enterprise" })).status, 404, "not an operator");
  await sql(`update users set email_verified_at = now() where email = 'plans@x.co'`); process.env.PLATFORM_OPERATORS += ",plans@x.co";
  const soon = new Date(Date.now() + 40 * 864e5).toISOString();
  assert.equal((await set({ plan: "enterprise", status: "active", periodEndsAt: soon })).status, 400, "a reason is required");
  assert.equal((await set({ plan: "gold", reason: "x test" })).status, 400);
  assert.equal((await set({ plan: "enterprise", status: "active", reason: "invoiced contract" })).status, 400, "a grant needs its end date");
  assert.equal((await set({ plan: "enterprise", status: "active", periodEndsAt: "not a date", reason: "invoiced contract" })).status, 400);
  assert.equal((await set({ plan: "enterprise", status: "active", periodEndsAt: soon, reason: "invoiced contract", overrides: { values: { seats: 7, secret: 1 } } })).status, 400);
  let r = await set({ plan: "enterprise", status: "active", periodEndsAt: soon, reason: "invoiced contract", overrides: { values: { seats: 7 }, expiresAt: soon } });
  assert.equal(r.status, 200); assert.equal(r.data.billing.plan.code, "enterprise"); assert.equal(r.data.billing.mode, "write"); assert.equal(r.data.billing.limits.seats, 7); assert.equal(r.data.billing.limits.brands, 20);
  const log = (await call("pl", "GET", "/api/org/audit")).data.log.find((x) => x.action === "billing.operator_set");
  assert.equal(log.detail.reason, "invoiced contract"); assert.equal(log.detail.before.plan, "legacy"); assert.equal(log.detail.after.plan, "enterprise");
  // The grant ends on its date: access stops, reports stay readable.
  await sql(`update organizations set current_period_end = now() - interval '1 hour' where id = $1`, [org]);
  assert.equal((await call("pl", "GET", "/api/me")).data.billing.mode, "read");
  // Extending a trial by hand.
  r = await set({ plan: "trial", status: "trialing", trialEndsAt: soon, reason: "extra week for demo" }); assert.equal(r.data.billing.mode, "write");
  // Not allowed while a live Razorpay subscription exists.
  await sql(`update organizations set billing_status = 'active', razorpay_subscription_id = 'sub_live2' where id = $1`, [org]);
  assert.equal((await set({ plan: "starter", status: "active", periodEndsAt: soon, reason: "should be refused" })).status, 409);
  await sql(`update organizations set plan_code = 'legacy', billing_status = 'internal', razorpay_subscription_id = null where id = $1`, [org]);

  // One trial per person: an extra organisation they create inherits the first one's window, it does not start a fresh week.
  process.env.PLATFORM_OPERATORS = process.env.PLATFORM_OPERATORS.replace(",plans@x.co", ""); // operators are exempt; this is a normal user now
  process.env.ORG_CREATION = "open"; process.env.BILLING_ENABLED = "1";
  await sql(`update organizations set plan_code = 'trial', billing_status = 'trialing', trial_started_at = now() - interval '6 days', trial_ends_at = now() + interval '1 day' where id = $1`, [org]);
  await sql(`update users set trial_started_at = now() - interval '6 days', trial_ends_at = now() + interval '1 day' where email = 'plans@x.co'`); // the person's one trial window
  const made = await call("pl", "POST", "/api/orgs", { name: "Second org" }); assert.equal(made.status, 200);
  const second = (await sql(`select trial_started_at, trial_ends_at, plan_code from organizations where slug = $1`, [made.data.created.slug]))[0];
  assert.equal(second.plan_code, "trial"); assert.ok(new Date(second.trial_ends_at) - Date.now() < 1.1 * 864e5, "inherits the remaining day, not a new week");
  delete process.env.ORG_CREATION; delete process.env.BILLING_ENABLED;
});

// ── Sign in with Google, end to end, with Google's token endpoint stubbed ──
test("google sign-in: start, callback, linking, takeover protection, trial and the invite wall", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret" });
  const realFetch = globalThis.fetch; let claims = null, tokenCalls = [];
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/")) {
      tokenCalls.push(Object.fromEntries(new URLSearchParams(init.body)));
      if (!claims) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ access_token: "at", id_token: `h.${b64(claims)}.s`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  };
  try {
    const cookieOf = (r, name) => (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith(name + "="));
    // One full sign-in: /start (state cookie + redirect to Google), then /callback with Google's code and the same state.
    async function google(c, { invite = "", tamper = false, cancelled = false } = {}) {
      claims = c;
      const st = await fetch(`${base}/api/auth/google/start${invite ? "?invite=" + invite : ""}`, { redirect: "manual", headers: { "x-forwarded-for": "10.5.5.5" } });
      const to = new URL(st.headers.get("location")), state = to.searchParams.get("state");
      const cb = await fetch(`${base}/api/auth/google/callback?${cancelled ? "error=access_denied&" : ""}code=authcode&state=${tamper ? "forged" : state}`, { redirect: "manual", headers: { cookie: cookieOf(st, "wp_gstate") } });
      return { start: st, to, cb, loc: decodeURIComponent(cb.headers.get("location") || ""), session: cookieOf(cb, "wp_session") };
    }
    const me = async (session) => (await (await fetch(base + "/api/me", { headers: { cookie: session } })).json());
    const good = (o = {}) => ({ sub: "g-100", email: "goog@x.co", email_verified: true, name: "Goog Person", ...o });

    // Offered only when the server has the credentials; the start redirect carries our client id, redirect URI, scopes and a fresh state.
    assert.equal((await (await fetch(base + "/api/config")).json()).googleLogin, true);
    process.env.ACCESS_CODE = "letmein"; delete process.env.BILLING_ENABLED; // billing off; the code plays no part in sign-up
    const s1 = await google(good({ sub: "g-099", email: "goog-open@x.co" }));
    assert.equal(s1.start.status, 302); assert.equal(s1.to.origin + s1.to.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(s1.to.searchParams.get("client_id"), "cid.apps.googleusercontent.com"); assert.equal(s1.to.searchParams.get("redirect_uri"), `${base}/api/auth/google/callback`);
    assert.equal(s1.to.searchParams.get("scope"), "openid email profile"); assert.equal(s1.to.searchParams.get("response_type"), "code"); assert.ok(s1.to.searchParams.get("state").length >= 16);
    assert.match(s1.start.headers.get("set-cookie"), /HttpOnly/);

    // No invite code: a stranger with no invite gets a verified account straight away.
    assert.equal(s1.loc, "/"); assert.ok(s1.session);
    assert.equal((await sql(`select count(*)::int as n from users where email = 'goog-open@x.co' and email_verified_at is not null`))[0].n, 1);

    // Billing open (self-serve): the same person signs up and gets a verified account and a personal organisation on the free trial.
    process.env.BILLING_ENABLED = "1";
    const s2 = await google(good());
    assert.equal(s2.loc, "/"); assert.ok(s2.session); assert.equal(tokenCalls.at(-1).grant_type, "authorization_code"); assert.equal(tokenCalls.at(-1).redirect_uri, `${base}/api/auth/google/callback`);
    let m = await me(s2.session); assert.equal(m.user.email, "goog@x.co"); assert.equal(m.user.verified, true); assert.equal(m.user.name, "Goog Person");
    assert.equal(m.billing.plan.status, "trialing"); assert.equal(m.billing.trialAvailable, true); assert.equal(m.org.role, "owner");
    // Signing in again is the same user and the same organisation, not a second trial.
    const s3 = await google(good()); const m3 = await me(s3.session); assert.equal(m3.user.id, m.user.id); assert.equal(m3.org.id, m.org.id);
    assert.equal((await sql(`select count(*)::int as n from organizations o join memberships x on x.org_id = o.id where x.user_id = $1`, [m.user.id]))[0].n, 1);

    // Refusals, each leaving no session: forged state, the user cancelling, an unverified Google email, Google rejecting the code.
    assert.match((await google(good(), { tamper: true })).loc, /auth-error=.*expired/i);
    const cancelled = await google(good(), { cancelled: true }); assert.match(cancelled.loc, /auth-error=.*cancelled/i); assert.equal(cancelled.session, undefined);
    const unverified = await google(good({ sub: "g-200", email: "nover@x.co", email_verified: false })); assert.match(unverified.loc, /auth-error=.*verified/i); assert.equal(unverified.session, undefined);
    assert.equal((await sql(`select count(*)::int as n from users where email = 'nover@x.co'`))[0].n, 0);
    const rejected = await google(null); assert.match(rejected.loc, /auth-error/); assert.equal(rejected.session, undefined);

    // The same email under a different Google account is not the same person.
    const other = await google(good({ sub: "g-999" })); assert.match(other.loc, /different Google account/i); assert.equal(other.session, undefined);

    // An existing verified password account is linked to Google (no duplicate), and keeps working with its password.
    await sql(`insert into users (email, name, pw_hash, email_verified_at) values ('pw@x.co', 'Pw', 'x', now())`);
    const link = await google(good({ sub: "g-300", email: "pw@x.co", name: "Pw Google" }));
    assert.ok(link.session); assert.equal((await sql(`select count(*)::int as n from users where email = 'pw@x.co'`))[0].n, 1);
    assert.equal((await sql(`select google_sub from users where email = 'pw@x.co'`))[0].google_sub, "g-300");

    // Takeover protection: a password account nobody ever verified loses its password and sessions once Google proves the address.
    await sql(`insert into users (email, name, pw_hash) values ('squat@x.co', 'Squatter', 'x')`);
    const uid = (await sql(`select id from users where email = 'squat@x.co'`))[0].id;
    await sql(`insert into sessions (id, user_id, expires_at) values ('old-session-hash', $1, now() + interval '1 day')`, [uid]);
    const owner = await google(good({ sub: "g-400", email: "squat@x.co" })); assert.ok(owner.session);
    const sq = (await sql(`select pw_hash, google_sub, email_verified_at from users where id = $1`, [uid]))[0];
    assert.equal(sq.pw_hash, null); assert.equal(sq.google_sub, "g-400"); assert.ok(sq.email_verified_at);
    assert.equal((await sql(`select count(*)::int as n from sessions where id = 'old-session-hash'`))[0].n, 0);

    // An invite is only accepted by the address it was sent to, and with Google joins the inviting organisation, no trial of its own.
    const inviter = (await call("pl", "GET", "/api/me")).data; assert.ok(inviter.org, "plans user exists from earlier tests");
    const inv = await call("pl", "POST", "/api/org/invitations", { email: "invitee@x.co", role: "editor" });
    if (inv.status === 200) {
      const token = decodeURIComponent(inv.data.invite.link.split("#invite=")[1]);
      assert.match((await google(good({ sub: "g-500", email: "wrong@x.co" }), { invite: token })).loc, /invite is for invitee@x\.co/i);
      const joined = await google(good({ sub: "g-501", email: "invitee@x.co" }), { invite: token }); assert.ok(joined.session);
      assert.equal((await me(joined.session)).org.id, inviter.org.id);
    }
  } finally { globalThis.fetch = realFetch; delete process.env.GOOGLE_OAUTH_CLIENT_ID; delete process.env.GOOGLE_OAUTH_CLIENT_SECRET; process.env.ACCESS_CODE = ""; delete process.env.BILLING_ENABLED; }
});

// ── usage tracking: real requests are counted per person, kind and plan period, and the limits trip at the boundary ──
test("usage: real calls are metered per person and kind, remaining shrinks, limits trip exactly at the allowance", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  process.env.BILLING_ENABLED = "operators";
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const me0 = (await call("pl", "GET", "/api/me")).data, org = me0.org.id;
  await sql(`update organizations set plan_code = 'starter', billing_status = 'active', billing_currency = 'INR', razorpay_subscription_id = 'sub_usage', razorpay_checkout_subscription_id = null,
    current_period_start = now() - interval '1 day', current_period_end = now() + interval '29 days', cancel_at_period_end = false, grace_ends_at = null, pending_plan_code = null, entitlement_overrides = '{}', monthly_cap_usd = null where id = $1`, [org]);
  await clearUsage(org);
  const bill = async () => (await call("pl", "GET", "/api/billing")).data;
  const pitch = () => call("pl", "POST", "/api/write", { kind: "pitch", data: { profile: { name: "A" }, t: { url: "https://x.example" } } });
  assert.equal((await bill()).used.drafts, 0); assert.equal((await bill()).limits.drafts, 10);

  // Each real request is counted when it is made, whatever the provider then does with it; chat and other writes are not drafted fixes.
  for (let i = 1; i <= 3; i++) { await pitch(); assert.equal((await bill()).used.drafts, i, `after ${i} drafts`); }
  await call("pl", "POST", "/api/write", { kind: "chat", data: { question: "hi" } });
  await call("pl", "POST", "/api/write", { kind: "insights", data: { profile: { name: "A" }, digest: "d" } });
  assert.equal((await bill()).used.drafts, 3, "chat and insights are not drafted fixes");
  await call("pl", "POST", "/api/ask", { engine: "chatgpt", question: "best ai partner", brand: { name: "A" } });
  await call("pl", "POST", "/api/ask", { engine: "gemini", question: "best ai partner", brand: { name: "A" } });

  // What was recorded: kind, engine, write type, who, and a cost estimate that feeds the plan's AI allowance.
  const rows = await sql(`select kind, engine, sub, n, cost_usd::float as cost, user_id from usage where org_id = $1 order by id`, [org]);
  assert.deepEqual(rows.map((r) => [r.kind, r.engine, r.sub]), [["write", null, "pitch"], ["write", null, "pitch"], ["write", null, "pitch"], ["write", null, "chat"], ["write", null, "insights"], ["ask", "chatgpt", null], ["ask", "gemini", null]]);
  assert.ok(rows.every((r) => r.user_id === me0.user.id && r.n === 1 && r.cost > 0));
  const ai = (await bill()).ai; assert.ok(ai.pct > 0 && ai.pct < 1 && ai.over === false, JSON.stringify(ai)); // starter: $5 allowance
  // Who used what, for admins: per person, per engine and kind.
  const usage = (await call("pl", "GET", "/api/org")).data.usage;
  assert.equal(usage.byPerson.find((x) => x.name === "plans@x.co").calls, 7);
  assert.ok(usage.byEngine.find((x) => x.name === "chatgpt")); assert.ok(usage.byEngine.find((x) => x.name === "gemini"));

  // The allowance: the 10th drafted fix is allowed, the 11th is refused with the numbers, and nothing is counted for a refusal.
  for (let i = 4; i <= 10; i++) { const r = await pitch(); assert.notEqual(r.status, 402, `draft ${i} must be allowed`); }
  assert.equal((await bill()).used.drafts, 10);
  const over = await pitch(); assert.equal(over.status, 402); assert.equal(over.data.code, "plan_limit"); assert.equal(over.data.capability, "drafts"); assert.equal(over.data.used, 10); assert.equal(over.data.limit, 10); assert.equal(over.data.nextPlan, "growth");
  assert.equal((await bill()).used.drafts, 10, "a refused request is not counted");
  assert.equal((await sql(`select count(*)::int as n from usage where org_id = $1 and sub = 'pitch'`, [org]))[0].n, 10);

  // A new billing period starts the count again; usage before the period start is not counted.
  await sql(`update organizations set current_period_start = now() + interval '1 second' where id = $1`, [org]); await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await bill()).used.drafts, 0); assert.notEqual((await pitch()).status, 402); assert.equal((await bill()).used.drafts, 1);

  // The AI allowance is a hard stop: once the plan's dollars are spent every AI call is refused, whoever makes it.
  await useUp(org, { kind: "ask", costUsd: 5 });
  const stop = await call("pl", "POST", "/api/ask", { engine: "chatgpt", question: "x", brand: { name: "A" } }); assert.equal(stop.status, 402); assert.equal(stop.data.code, "cap"); assert.equal(stop.data.source, "plan"); assert.match(stop.data.error, /Upgrade/);
  assert.equal((await bill()).ai.over, true);
  await clearUsage(org); delete process.env.BILLING_ENABLED;
});

test("usage: a burst of simultaneous drafts never passes the allowance (check and count are one locked step)", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  process.env.BILLING_ENABLED = "operators";
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  await sql(`update organizations set plan_code = 'starter', billing_status = 'active', razorpay_subscription_id = 'sub_burst', current_period_start = now() - interval '1 day', current_period_end = now() + interval '29 days',
    cancel_at_period_end = false, grace_ends_at = null, entitlement_overrides = '{}', monthly_cap_usd = null where id = $1`, [org]);
  await clearUsage(org);
  const pitch = () => call("pl", "POST", "/api/write", { kind: "pitch", data: { profile: { name: "A" }, t: { url: "https://x.example" } } });
  const results = await Promise.all(Array.from({ length: 25 }, pitch));
  const allowed = results.filter((r) => r.status !== 402).length;
  console.log(`# burst of 25 simultaneous drafts against an allowance of 10: ${allowed} allowed`);
  assert.equal(allowed, 10, "exactly the allowance, however many arrive at once");
  assert.equal((await sql(`select coalesce(sum(n), 0)::int as n from usage where org_id = $1 and sub = 'pitch'`, [org]))[0].n, 10);
  assert.equal((await pitch()).status, 402, "once the burst has settled nothing more is allowed");

  // The AI-cost allowance is in the same locked step: $4.98 spent of $5 leaves room for the call that crosses the line, and no more.
  await clearUsage(org); await useUp(org, { n: 0, costUsd: 4.98 }); // exactly $4.98 spent of the $5 allowance
  const asks = await Promise.all(Array.from({ length: 20 }, () => call("pl", "POST", "/api/ask", { engine: "chatgpt", question: "q", brand: { name: "A" } })));
  assert.equal(asks.filter((r) => r.status !== 402).length, 2, "0.0145 each: the first leaves 0.0055 under the cap, the second crosses it");
  assert.ok(asks.filter((r) => r.status === 402).every((r) => r.data.code === "cap"));
  await clearUsage(org); delete process.env.BILLING_ENABLED;
});

// ── the plan catalogue lives in the database ──
test("catalogue: the database seed matches the code defaults; operators edit it live; every change is validated and audited", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const { DEFAULT_PLANS, catalogueFlat, PLANS, planIdFor: _x } = await import("../../server/plans.mjs");
  const { planIdFor, planOf } = await import("../../server/razorpay.mjs");
  delete process.env.RAZORPAY_KEY_ID; // no keys: saving a plan id must not try to reach Razorpay (keys left by earlier tests would)
  const strip = (p) => JSON.parse(JSON.stringify({ ...p, prices: Object.fromEntries(Object.entries(p.prices).map(([c, v]) => [c, { amount: v.amount, razorpayPlanId: v.razorpayPlanId }])) }));
  // The migration's seed and server/plans.mjs DEFAULT_PLANS describe the same catalogue (the live view was loaded from the database at boot).
  assert.deepEqual(catalogueFlat().map(strip), DEFAULT_PLANS.map(strip), "migration 004 seed and DEFAULT_PLANS have drifted apart");
  assert.equal((await sql(`select count(*)::int as n from plans`))[0].n, 6); assert.equal((await sql(`select limit_value from plan_limits where plan_code = 'agency' and metric = 'brands'`))[0].limit_value, "5");

  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  process.env.BILLING_ENABLED = "operators";
  const edit = (code, b) => call("pl", "PUT", `/api/admin/plans/${code}`, b);
  assert.equal((await call("pl", "GET", "/api/admin/plans")).status, 404, "not an operator"); assert.equal((await edit("growth", { name: "X" })).status, 404);
  await sql(`update users set email_verified_at = now() where email = 'plans@x.co'`); process.env.PLATFORM_OPERATORS += ",plans@x.co";
  const list = (await call("pl", "GET", "/api/admin/plans")).data;
  assert.equal(list.plans.length, 6); assert.ok(list.options.engines.includes("chatgpt")); assert.ok(list.organisations.legacy >= 1);

  // An edit changes the limit the server enforces, straight away, without a deploy.
  await sql(`update organizations set plan_code = 'growth', billing_status = 'active', razorpay_subscription_id = 'sub_cat', current_period_start = now() - interval '1 day', current_period_end = now() + interval '29 days', cancel_at_period_end = false, grace_ends_at = null, entitlement_overrides = '{}' where id = $1`, [org]);
  await sql(`delete from workspaces where org_id = $1`, [org]); await clearUsage(org);
  const brand = (n) => call("pl", "PUT", `/api/workspaces/cat-${n}`, { name: "c" + n, setup: { questions: [] } });
  assert.equal((await brand(1)).status, 200); assert.equal((await brand(2)).data.capability, "brands", "Growth allows one brand");
  let r = await edit("growth", { limits: { brands: 2, drafts: 50 }, description: "Edited in the app" });
  assert.equal(r.status, 200); assert.equal(r.data.plan.limits.brands, 2); assert.equal(r.data.plan.limits.drafts, 50); assert.equal(r.data.plan.limits.seats, 5, "unmentioned limits are kept");
  assert.equal((await brand(2)).status, 200, "the new limit applies at once"); assert.equal((await brand(3)).data.capability, "brands");
  const bill = (await call("pl", "GET", "/api/billing")).data; assert.equal(bill.limits.brands, 2); assert.equal(bill.report.metrics.find((m) => m.key === "drafts").limit, 50);
  assert.equal((await sql(`select limit_value from plan_limits where plan_code = 'growth' and metric = 'brands'`))[0].limit_value, "2");
  assert.equal((await sql(`select description from plans where code = 'growth'`))[0].description, "Edited in the app");
  const aud = (await call("pl", "GET", "/api/org/audit")).data; // catalogue edits are org-less: look in the table
  const logged = (await sql(`select detail from audit_log where action = 'plan.catalogue_edited' and target = 'growth' order by id desc limit 1`))[0].detail;
  assert.equal(logged.before.limits.brands, 1); assert.equal(logged.after.limits.brands, 2);

  // Validation: nothing is written for a bad edit.
  for (const [b, re] of [[{ limits: { brands: -1 } }, /whole number/], [{ engines: ["bard"] }, /not one of/], [{ prices: { INR: { amount: 5, razorpayPlanId: "oops" } } }, /plan_/], [{ aiCapUsd: -1 }, /AI allowance/]]) {
    const bad = await edit("growth", b); assert.equal(bad.status, 400); assert.match(bad.data.error, re);
  }
  assert.equal((await sql(`select limit_value from plan_limits where plan_code = 'growth' and metric = 'brands'`))[0].limit_value, "2");
  assert.equal((await edit("legacy", { public: true })).status, 400); assert.equal((await edit("trial", { selfServe: true })).status, 400);
  assert.equal((await edit("growth", { active: false })).status, 409, "organisations are paying on it");

  // Razorpay ids are entered here, not in Terraform; a replaced id is retired so existing subscribers still resolve.
  r = await edit("growth", { prices: { INR: { amount: 999900, razorpayPlanId: "plan_GrowthINR001" }, USD: { amount: 9900, razorpayPlanId: "plan_GrowthUSD001" } } });
  assert.equal(r.status, 200); assert.equal(planIdFor("growth", "INR", {}), "plan_GrowthINR001"); assert.deepEqual(planOf("plan_GrowthUSD001", {}), { plan: "growth", currency: "USD", cycle: "monthly" });
  assert.equal((await call("x", "GET", "/api/billing/plans")).data.available.growth.USD, true);
  r = await edit("growth", { prices: { INR: { amount: 1099900, razorpayPlanId: "plan_GrowthINR002" }, USD: { amount: 9900, razorpayPlanId: "plan_GrowthUSD001" } } });
  assert.equal(planIdFor("growth", "INR", {}), "plan_GrowthINR002"); assert.deepEqual(planOf("plan_GrowthINR001", {}), { plan: "growth", currency: "INR", cycle: "monthly" }, "the retired id still maps to Growth");
  assert.deepEqual((await sql(`select retired_plan_ids from plan_prices where plan_code = 'growth' and currency = 'INR'`))[0].retired_plan_ids, ["plan_GrowthINR001"]);
  assert.ok(!JSON.stringify((await call("x", "GET", "/api/billing/plans")).data).includes("plan_Growth"), "the public catalogue never shows provider ids");

  // Featuring one plan un-features the others; a new plan can be added and used.
  r = await edit("agency", { featured: true }); assert.equal(r.status, 200);
  assert.deepEqual((await sql(`select code from plans where featured`)).map((x) => x.code), ["agency"]);
  r = await edit("partner", { name: "Partner", description: "Custom", sort: 6, public: false, selfServe: false, limits: { brands: 3, questions: 50, competitors: 5, seats: 4, drafts: 20, samples: 1 }, engines: ["chatgpt"], schedules: ["off", "weekly"], integrations: ["bing"] });
  assert.equal(r.status, 200); assert.ok(PLANS.partner);
  const set = await call("pl", "PATCH", `/api/admin/orgs/${(await call("pl", "GET", "/api/me")).data.org.slug}/billing`, { plan: "partner", status: "trialing", trialEndsAt: new Date(Date.now() + 864e5).toISOString(), reason: "partner test" });
  assert.equal(set.status, 409, "this org has a live Razorpay subscription");
  await sql(`update organizations set plan_code = 'legacy', billing_status = 'internal', razorpay_subscription_id = null where id = $1`, [org]);
  // put the catalogue back for the rest of the suite
  await edit("agency", { featured: false }); await edit("growth", { featured: true, limits: { brands: 1, drafts: 30 }, description: "Growing brands running a weekly visibility loop", prices: { INR: { amount: 999900, razorpayPlanId: null }, USD: { amount: 9900, razorpayPlanId: null } } });
  await sql(`delete from plans where code = 'partner'`); const { loadCatalogue } = await import("../../server/plans.mjs"); const { q } = await import("../../server/db.mjs"); await loadCatalogue(q);
  delete process.env.BILLING_ENABLED; process.env.PLATFORM_OPERATORS = process.env.PLATFORM_OPERATORS.replace(",plans@x.co", "");
});

test("recorder: an event and its counters are written together or not at all; the reader returns what is left", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const { record, readCounters } = await import("../../server/usage.mjs"); const { tx } = await import("../../server/db.mjs");
  process.env.BILLING_ENABLED = "operators";
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const me = (await call("pl", "GET", "/api/me")).data, org = me.org.id, start = new Date("2026-03-01T00:00:00Z");
  await clearUsage(org);
  // one transaction: success commits both, a failure after the event rolls both back
  await tx(async (c) => { await record({ c, orgId: org, periodStart: start, userId: me.user.id, kind: "write", sub: "pitch", n: 2 }); });
  assert.deepEqual(await readCounters(org, start), { ai_usd: 0.004, calls: 2, write: 2, drafts: 2 });
  await assert.rejects(tx(async (c) => { await record({ c, orgId: org, periodStart: start, kind: "ask", engine: "chatgpt" }); throw new Error("boom"); }), /boom/);
  assert.equal((await sql(`select count(*)::int as n from usage where org_id = $1`, [org]))[0].n, 1); assert.equal((await readCounters(org, start)).ask, undefined);
  // periods are separate keys: a new period starts at zero with nothing to reset
  const next = new Date("2026-04-01T00:00:00Z"); await record({ orgId: org, periodStart: next, kind: "write", sub: "article" });
  assert.equal((await readCounters(org, next)).drafts, 1); assert.equal((await readCounters(org, start)).drafts, 2);
  assert.deepEqual(await readCounters(org, new Date("2026-05-01T00:00:00Z")), {});
  // counters and events agree
  const ev = (await sql(`select sum(n)::int as n, round(sum(cost_usd)::numeric, 5)::float as c from usage where org_id = $1 and period_start = $2`, [org, start]))[0];
  assert.equal(ev.n, 2); assert.equal(ev.c, 0.004);
  // the reader through the API: used, limit, remaining and state per metric, from counters and live counts
  await sql(`update organizations set plan_code = 'starter', billing_status = 'active', razorpay_subscription_id = 'sub_rd', current_period_start = now() - interval '1 day', current_period_end = now() + interval '29 days', cancel_at_period_end = false, grace_ends_at = null, entitlement_overrides = '{}' where id = $1`, [org]);
  await clearUsage(org); await useUp(org, { kind: "write", sub: "pitch", n: 8 }); await useUp(org, { kind: "write", sub: "chat", n: 3 });
  const rep = (await call("pl", "GET", "/api/billing")).data.report, d = rep.metrics.find((m) => m.key === "drafts");
  assert.deepEqual([d.used, d.limit, d.remaining, d.state, d.scope], [8, 10, 2, "warn", "period"]); assert.equal(rep.period.kind, "plan"); assert.ok(rep.ai.pct > 0);
  assert.deepEqual(rep.features.engines, ["chatgpt", "perplexity", "gemini"]); assert.deepEqual(rep.features.schedules, ["off", "weekly"]);
  const hist = (await call("pl", "GET", "/api/billing/history")).data.events; assert.ok(Array.isArray(hist));
  await sql(`update organizations set plan_code = 'legacy', billing_status = 'internal', razorpay_subscription_id = null where id = $1`, [org]); await clearUsage(org); delete process.env.BILLING_ENABLED;
});

test("migration 004 on an existing database: usage history becomes counters, organisations become legacy", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const fs = await import("node:fs"), path = await import("node:path");
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  try {
    await c.query("drop schema if exists bf_test cascade"); await c.query("create schema bf_test"); await c.query("set search_path to bf_test, public");
    const dir = path.join(process.cwd(), "server", "migrations"), files = fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
    for (const f of files.filter((f) => f < "004")) await c.query(fs.readFileSync(path.join(dir, f), "utf8"));
    // an organisation with history from two months, as production has today
    const org = (await c.query(`insert into organizations (slug, name) values ('hist', 'Hist') returning id`)).rows[0].id;
    const ins = (kind, engine, n, cost, at) => c.query(`insert into usage (org_id, kind, engine, n, cost_usd, at) values ($1, $2, $3, $4, $5, $6)`, [org, kind, engine, n, cost, at]);
    await ins("ask", "chatgpt", 1, 0.0145, "2026-09-03T10:00:00Z"); await ins("ask", "gemini", 2, 0.008, "2026-09-20T10:00:00Z"); await ins("write", null, 1, 0.002, "2026-09-30T23:59:59Z");
    await ins("ask", "chatgpt", 1, 0.0145, "2026-10-01T00:00:01Z");
    await c.query(fs.readFileSync(path.join(dir, "004_billing.sql"), "utf8"));
    const cnt = Object.fromEntries((await c.query(`select to_char(period_start at time zone 'UTC', 'YYYY-MM') as m, metric, used::float as u from usage_counters where org_id = $1`, [org])).rows.map((r) => [r.m + " " + r.metric, r.u]));
    assert.deepEqual(cnt, { "2026-09 ai_usd": 0.0245, "2026-09 calls": 4, "2026-09 ask": 3, "2026-09 write": 1, "2026-10 ai_usd": 0.0145, "2026-10 calls": 1, "2026-10 ask": 1 });
    assert.equal((await c.query(`select count(*)::int as n from usage where period_start is null`)).rows[0].n, 0);
    const o = (await c.query(`select plan_code, billing_status from organizations where id = $1`, [org])).rows[0]; assert.deepEqual(o, { plan_code: "legacy", billing_status: "internal" });
    assert.equal((await c.query(`select count(*)::int as n from plans`)).rows[0].n, 6);
    await assert.rejects(c.query(`update organizations set plan_code = 'nonexistent' where id = $1`, [org]), /foreign key|violates/, "an organisation can only be on a plan that exists");
  } finally { await c.query("drop schema if exists bf_test cascade").catch(() => {}); await c.end(); }
});

// ── the free trial: pick a plan, connect a payment method, first charge when the trial ends ──
test("trial: choose the plan, connect a payment method (first charge at the trial's end), switch, remove, convert", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const { setClient } = await import("../../server/razorpay.mjs");
  const calls = []; let n = 0;
  setClient({ createSubscription: async (a) => { calls.push(["create", a.planId, a.startAt]); return { id: "sub_t" + ++n }; }, cancelSubscription: async (id, a) => { calls.push(["cancel", id, a.atCycleEnd]); return {}; }, fetchSubscription: async (id) => ({ id, status: "created" }) });
  const WH = "whsec_test";
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: WH, RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR", RAZORPAY_PLAN_AGENCY_INR: "plan_A_INR", RAZORPAY_PLAN_STARTER_INR: "plan_S_INR" });
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  const reset = (trialEnds = "now() + interval '5 days'") => sql(`update organizations set plan_code = 'trial', billing_status = 'trialing', billing_currency = null, razorpay_subscription_id = null, razorpay_checkout_subscription_id = null,
    trial_started_at = now() - interval '2 days', trial_ends_at = ${trialEnds}, current_period_start = null, current_period_end = null, grace_ends_at = null, billing_event_at = null, pending_plan_code = null, cancel_at_period_end = false, entitlement_overrides = '{}' where id = $1`, [org]);
  await reset(); await sql(`delete from workspaces where org_id = $1`, [org]); await sql(`delete from billing_events`);
  const row = async () => (await sql(`select *, floor(extract(epoch from trial_ends_at))::int as trial_unix from organizations where id = $1`, [org]))[0];
  const bill = async () => (await call("pl", "GET", "/api/billing")).data;
  let T = Math.floor(Date.now() / 1000);
  const hook = async (event, planId, subId, extra = {}) => { const raw = JSON.stringify({ event, created_at: ++T, payload: { subscription: { entity: { id: subId, plan_id: planId, ...extra } } } });
    const r = await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "e" + Math.random(), "x-razorpay-signature": crypto.createHmac("sha256", WH).update(raw).digest("hex") }, body: raw }); return (await r.json()); };
  const checkout = (plan) => call("pl", "POST", "/api/billing/checkout", { plan, currency: "INR" });

  // Nothing chosen yet: the placeholder trial plan, no payment method.
  let b = await bill(); assert.equal(b.plan.code, "trial"); assert.equal(b.trialChosen, false); assert.equal(b.paymentMethod.connected, false); assert.equal(b.mode, "write");
  // Choosing a plan puts the trial on THAT plan's limits and leaves the trial window alone.
  const before = await row();
  assert.equal((await call("pl", "POST", "/api/billing/start-trial", { plan: "enterprise" })).data.code, "bad_plan"); assert.equal((await call("nobody", "POST", "/api/billing/start-trial", { plan: "agency" })).status, 401);
  let r = await call("pl", "POST", "/api/billing/start-trial", { plan: "agency" }); assert.equal(r.status, 200); assert.equal(r.data.plan.code, "agency"); assert.equal(r.data.plan.status, "trialing"); assert.equal(r.data.trialChosen, true);
  assert.deepEqual([r.data.limits.brands, r.data.limits.questions], [1, 20], "the trial is the same for every plan; Agency's limits start after it");
  const after = await row(); assert.equal(after.trial_unix, before.trial_unix, "the trial window is unchanged"); assert.deepEqual(after.trial_started_at, before.trial_started_at);
  assert.equal((await call("pl", "POST", "/api/billing/start-trial", { plan: "starter" })).data.limits.brands, 1, "and it can be switched freely until a payment method is connected");
  await call("pl", "POST", "/api/billing/start-trial", { plan: "growth" });

  // Buying during the trial now charges at once (no start_at): the plan starts when that charge lands, not at the trial's end.
  r = await checkout("growth"); assert.equal(r.status, 200); assert.equal(calls.at(-1)[2], null, "no deferred start"); assert.equal(r.data.startsAt ?? null, null);
  assert.equal((await row()).plan_code, "growth", "paying for it changes nothing yet");
  // Subscriptions connected before that change still start at the trial's end. Razorpay authorises one: it becomes the organisation's
  // subscription, the trial carries on, access is unchanged.
  const startAt = after.trial_unix;
  assert.equal((await hook("subscription.authenticated", "plan_G_INR", "sub_t1", { start_at: startAt })).status, "processed");
  let o = await row(); assert.equal(o.razorpay_subscription_id, "sub_t1"); assert.equal(o.razorpay_checkout_subscription_id, null); assert.equal(o.billing_status, "trialing"); assert.equal(o.billing_currency, "INR"); assert.equal(o.trial_unix, startAt);
  b = await bill(); assert.equal(b.paymentMethod.connected, true); assert.ok(new Date(b.paymentMethod.firstChargeAt) > Date.now()); assert.equal(b.mode, "write");
  assert.equal((await call("pl", "POST", "/api/billing/start-trial", { plan: "agency" })).data.code, "has_payment_method");
  assert.equal((await call("pl", "POST", "/api/billing/cancel")).status, 409, "no subscription to cancel yet: it hasn't started");

  // The trial's end with the first charge still on its way: a day's grace, then (if it never lands) read-only.
  await sql(`update organizations set trial_ends_at = now() - interval '1 hour' where id = $1`, [org]); assert.equal((await bill()).mode, "write");
  await sql(`update organizations set trial_ends_at = now() - interval '2 days' where id = $1`, [org]); assert.equal((await bill()).mode, "read");
  await sql(`update organizations set trial_ends_at = to_timestamp($2) where id = $1`, [org, startAt]);

  // Switching plans means connecting again on the new one: the new subscription replaces the old, which is cancelled upstream.
  assert.equal((await checkout("agency")).status, 200); const sw = calls.filter((c) => c[0] === "create").at(-1); assert.equal(sw[1], "plan_A_INR"); assert.equal(sw[2], null);
  assert.equal((await hook("subscription.authenticated", "plan_A_INR", "sub_t2", { start_at: startAt })).status, "processed");
  o = await row(); assert.equal(o.razorpay_subscription_id, "sub_t2"); assert.equal(o.plan_code, "agency"); assert.equal(o.billing_status, "trialing"); assert.deepEqual(calls.at(-1), ["cancel", "sub_t1", false]);

  // Removing the payment method cancels it upstream (nothing was charged) and the trial carries on.
  r = await call("pl", "POST", "/api/billing/remove-payment-method"); assert.equal(r.status, 200); assert.equal(r.data.paymentMethod.connected, false); assert.deepEqual(calls.at(-1), ["cancel", "sub_t2", false]);
  o = await row(); assert.equal(o.razorpay_subscription_id, null); assert.equal(o.billing_status, "trialing"); assert.equal((await call("pl", "POST", "/api/billing/remove-payment-method")).status, 409);
  assert.equal((await hook("subscription.cancelled", "plan_A_INR", "sub_t2")).ignored, true, "the cancelled event for the removed subscription matches nothing");
  assert.equal((await bill()).mode, "write");

  // A payment method revoked from the bank's side: the trial is not cut short.
  await checkout("growth"); await hook("subscription.authenticated", "plan_G_INR", "sub_t3", { start_at: startAt });
  assert.equal((await row()).razorpay_subscription_id, "sub_t3");
  assert.equal((await hook("subscription.cancelled", "plan_G_INR", "sub_t3", { start_at: startAt })).status, "processed");
  o = await row(); assert.equal(o.billing_status, "trialing"); assert.equal(o.razorpay_subscription_id, null); assert.equal((await bill()).mode, "write");

  // Within the last half hour of the trial there is nothing to wait for: the subscription simply starts.
  await sql(`update organizations set trial_ends_at = now() + interval '10 minutes' where id = $1`, [org]);
  await checkout("growth"); assert.equal(calls.filter((c) => c[0] === "create").at(-1)[2], null);
  await hook("subscription.authenticated", "plan_G_INR", "sub_t4", { start_at: Math.floor(Date.now() / 1000) - 5 });
  await sql(`update organizations set trial_ends_at = to_timestamp($2) where id = $1`, [org, startAt]);

  // The first charge after the trial fails: that is a failed payment (grace, then read-only), not a payment method going away.
  await sql(`update organizations set razorpay_subscription_id = 'sub_fail', razorpay_checkout_subscription_id = null, billing_event_at = null, trial_ends_at = now() - interval '1 hour' where id = $1`, [org]);
  assert.equal((await hook("subscription.pending", "plan_G_INR", "sub_fail")).status, "processed");
  o = await row(); assert.equal(o.billing_status, "past_due"); assert.ok(new Date(o.grace_ends_at) > Date.now() + 2 * 864e5); assert.equal(o.razorpay_subscription_id, "sub_fail"); assert.equal((await bill()).mode, "manual");
  await sql(`update organizations set billing_status = 'trialing', grace_ends_at = null, billing_event_at = null, trial_ends_at = to_timestamp($2) where id = $1`, [org, startAt]);

  // Conversion: when the trial ends and the first charge succeeds the organisation becomes a paying one on that plan.
  await sql(`update organizations set razorpay_subscription_id = null, razorpay_checkout_subscription_id = null where id = $1`, [org]);
  await checkout("growth"); const pend = (await row()).razorpay_checkout_subscription_id;
  await hook("subscription.authenticated", "plan_G_INR", pend, { start_at: startAt });
  assert.equal((await row()).billing_status, "trialing");
  const cs = startAt, ce = startAt + 30 * 86400;
  await hook("subscription.activated", "plan_G_INR", pend, { start_at: startAt, current_start: cs, current_end: ce }); await hook("subscription.charged", "plan_G_INR", pend, { current_start: cs, current_end: ce });
  o = await row(); assert.equal(o.billing_status, "active"); assert.equal(o.plan_code, "growth"); assert.equal(o.razorpay_subscription_id, pend); assert.equal(Math.floor(new Date(o.current_period_end).getTime() / 1000), ce);
  b = await bill(); assert.equal(b.plan.status, "active"); assert.equal(b.mode, "write"); assert.equal((await call("pl", "POST", "/api/billing/remove-payment-method")).status, 409, "a paying subscription is cancelled, not removed");
  const log = (await sql(`select action from audit_log where org_id = $1 and action like 'billing.%'`, [org])).map((x) => x.action);
  for (const a of ["billing.trial_plan_chosen", "billing.checkout_started", "billing.payment_method_removed", "billing.activated"]) assert.ok(log.includes(a), a);
  delete process.env.BILLING_ENABLED; setClient(null);
});

test("billing: a missed trial-end webhook is caught by the sync, and subscribing again after a cancel isn't charged twice", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto"); const { setClient } = await import("../../server/razorpay.mjs"); const { reconcile } = await import("../../server/billing-routes.mjs");
  const remote = {}, calls = []; let n = 0;
  setClient({ createSubscription: async (a) => { calls.push(["create", a.planId, a.startAt]); const id = "sub_r" + ++n; remote[id] = { id, status: "created", plan_id: a.planId }; return { id }; },
    cancelSubscription: async (id, a) => { calls.push(["cancel", id, a.atCycleEnd]); return {}; }, fetchSubscription: async (id) => remote[id] || { id, status: "created" } });
  const WH = "whsec_test";
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: WH, RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR", RAZORPAY_PLAN_STARTER_INR: "plan_S_INR" });
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  const row = async () => (await sql(`select * from organizations where id = $1`, [org]))[0];
  const now = Math.floor(Date.now() / 1000);

  // The trial ended an hour ago with a card connected; Razorpay charged it but the webhook never came. The sync finds and fixes it.
  await sql(`update organizations set plan_code = 'growth', billing_status = 'trialing', billing_currency = 'INR', razorpay_subscription_id = 'sub_missed', razorpay_checkout_subscription_id = null,
    trial_ends_at = now() - interval '1 hour', billing_reconciled_at = now() - interval '2 hours', billing_event_at = null, cancel_at_period_end = false, pending_plan_code = null where id = $1`, [org]);
  remote.sub_missed = { id: "sub_missed", status: "active", plan_id: "plan_G_INR", current_start: now - 3600, current_end: now + 30 * 86400 };
  await reconcile({ limit: 50, log: () => {} });
  let o = await row(); assert.equal(o.billing_status, "active", "a paying customer is not locked out by a missed webhook"); assert.equal(Math.floor(new Date(o.current_period_end).getTime() / 1000), now + 30 * 86400);

  // Cancelled but paid up for 10 more days: subscribing again starts when that period ends, so nothing is charged twice.
  const end = now + 10 * 86400;
  await sql(`update organizations set cancel_at_period_end = true, current_period_end = to_timestamp($2), billing_event_at = null where id = $1`, [org, end]);
  const r = await call("pl", "POST", "/api/billing/checkout", { plan: "starter", currency: "INR" }); assert.equal(r.status, 200); assert.equal(r.data.starts, "resume");
  assert.equal(calls.filter((c) => c[0] === "create").at(-1)[2], end, "start_at is the end of the paid period");
  const pend = r.data.subscriptionId;
  const raw = JSON.stringify({ event: "subscription.authenticated", created_at: now + 5, payload: { subscription: { entity: { id: pend, plan_id: "plan_S_INR", status: "authenticated", start_at: end } } } });
  const h = await (await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "e_resume", "x-razorpay-signature": crypto.createHmac("sha256", WH).update(raw).digest("hex") }, body: raw })).json();
  assert.equal(h.status, "processed");
  o = await row(); assert.equal(o.razorpay_subscription_id, pend); assert.equal(o.cancel_at_period_end, false, "it no longer ends"); assert.equal(o.plan_code, "growth", "the paid-for plan runs to the period end");
  assert.equal(o.pending_plan_code, "starter", "the new plan starts with its first charge"); assert.ok(calls.some((c) => c[0] === "cancel" && c[1] === "sub_missed"), "the old subscription is stopped upstream");

  // UPI / e-mandate: Razorpay can't update the plan. Change-plan says so (no Razorpay update attempted), and the switch is a new
  // mandate that starts at the renewal: nothing charged today, the old one stopped once the new one is approved.
  const hookAs = async (event, id, plan, extra) => { const raw = JSON.stringify({ event, created_at: Math.floor(Date.now() / 1000) + 10, payload: { subscription: { entity: { id, plan_id: plan, ...extra } } } });
    return (await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "e_" + Math.random(), "x-razorpay-signature": crypto.createHmac("sha256", WH).update(raw).digest("hex") }, body: raw })).json(); };
  const pEnd = now + 12 * 86400;
  await sql(`update organizations set plan_code = 'starter', billing_status = 'active', billing_currency = 'INR', razorpay_subscription_id = 'sub_upi', razorpay_checkout_subscription_id = null,
    cancel_at_period_end = false, pending_plan_code = null, current_period_end = to_timestamp($2), billing_event_at = null where id = $1`, [org, pEnd]);
  remote.sub_upi = { id: "sub_upi", status: "active", plan_id: "plan_S_INR", payment_method: "upi" };
  const nUpd = calls.length;
  let cp = await call("pl", "POST", "/api/billing/change-plan", { plan: "growth" }); assert.equal(cp.status, 409); assert.equal(cp.data.code, "needs_new_mandate"); assert.match(cp.data.error, /UPI/);
  assert.equal(calls.length, nUpd, "nothing is asked of Razorpay that it would refuse");
  assert.equal((await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).data.code, "has_subscription", "an ordinary second checkout is still refused");
  cp = await call("pl", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR", switch: true }); assert.equal(cp.status, 200); assert.equal(cp.data.starts, "resume");
  assert.equal(calls.filter((c) => c[0] === "create").at(-1)[2], pEnd, "the new mandate's first charge is the renewal");
  assert.equal((await row()).razorpay_subscription_id, "sub_upi", "an unapproved switch changes nothing");
  assert.equal((await hookAs("subscription.authenticated", cp.data.subscriptionId, "plan_G_INR", { status: "authenticated", start_at: pEnd })).status, "processed");
  o = await row(); assert.equal(o.razorpay_subscription_id, cp.data.subscriptionId); assert.equal(o.plan_code, "starter", "the paid plan runs to the renewal"); assert.equal(o.pending_plan_code, "growth");
  assert.ok(calls.some((c) => c[0] === "cancel" && c[1] === "sub_upi"), "the old mandate is stopped");
  // A downgrade through the same path is still refused while usage is over the cheaper plan.
  await sql(`update organizations set plan_code = 'growth', razorpay_subscription_id = 'sub_upi', pending_plan_code = null where id = $1`, [org]);
  await sql(`insert into workspaces (org_id, slug, name) values ($1, 'upi-a', 'A'), ($1, 'upi-b', 'B')`, [org]);
  const dn = await call("pl", "POST", "/api/billing/checkout", { plan: "starter", currency: "INR", switch: true }); assert.equal(dn.data.code, "over_plan");
  await sql(`delete from workspaces where org_id = $1 and slug in ('upi-a','upi-b')`, [org]);
  // A second subscription that is actually *charged* while one is active is still refused and stopped (no double billing).
  const extra = await hookAs("subscription.charged", "sub_stray", "plan_G_INR", { notes: { white_petal_org_id: org }, status: "active" }); assert.equal(extra.ignored, true);
  await sql(`update organizations set billing_status = 'internal', plan_code = 'legacy', razorpay_subscription_id = null, cancel_at_period_end = false, pending_plan_code = null where id = $1`, [org]);
  delete process.env.BILLING_ENABLED; setClient(null);
});

test("razorpay plans: create from the catalogue, verify against Razorpay, and refuse a mismatched id", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const { setClient } = await import("../../server/razorpay.mjs"); const { loadCatalogue, PLANS } = await import("../../server/plans.mjs"); const { q } = await import("../../server/db.mjs");
  const created = [], rzPlans = {}; let n = 0;
  setClient({
    createPlan: async (a) => { created.push(a); const id = "plan_Created" + ++n + "Abcdef"; rzPlans[id] = { id, period: "monthly", interval: 1, item: { name: a.name, amount: a.amount, currency: a.currency } }; return rzPlans[id]; },
    fetchPlan: async (id) => { if (!rzPlans[id]) throw Object.assign(new Error("Razorpay 400: The ID provided is invalid or could not be found."), { status: 400 }); return rzPlans[id]; },
  });
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: "wh", BILLING_ENABLED: "operators" });
  await sql(`update plan_prices set razorpay_plan_id = null, retired_plan_ids = '{}'`);
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const act = (code, b) => call("pl", "POST", `/api/admin/plans/${code}/razorpay`, b);
  const edit = (code, b) => call("pl", "PUT", `/api/admin/plans/${code}`, b);
  assert.equal((await act("growth", { currency: "INR", action: "create" })).status, 404, "operators only");
  await sql(`update users set email_verified_at = now() where email = 'plans@x.co'`); process.env.PLATFORM_OPERATORS += ",plans@x.co";
  await sql(`update plan_prices set razorpay_plan_id = null, retired_plan_ids = '{}'`); await loadCatalogue(q);

  // Create: Razorpay is asked for a MONTHLY plan at exactly the catalogue price, and the returned id is stored.
  let r = await act("growth", { currency: "INR", action: "create" }); assert.equal(r.status, 200); assert.equal(r.data.created, true);
  assert.deepEqual([created[0].amount, created[0].currency, created[0].name], [1179882, "INR", "Growth (INR monthly, incl. 18% GST)"], "Razorpay charges the price with 18% GST");
  assert.equal((await sql(`select razorpay_plan_id from plan_prices where plan_code = 'growth' and currency = 'INR'`))[0].razorpay_plan_id, r.data.razorpayPlanId); assert.equal(PLANS.growth.razorpayIds.INR, r.data.razorpayPlanId);
  assert.equal((await act("growth", { currency: "INR", action: "create" })).status, 409, "never a second plan for the same price");
  assert.equal((await act("growth", { currency: "CAD", action: "create" })).data.code, "no_price"); assert.equal((await act("nope", { currency: "INR", action: "create" })).status, 404); assert.equal((await act("growth", { currency: "INR", action: "explode" })).status, 400);

  // Verify: matches now; after the catalogue price changes it reports exactly what differs.
  r = await act("growth", { currency: "INR", action: "verify" }); assert.equal(r.data.ok, true); assert.deepEqual(r.data.mismatches, []);
  await edit("growth", { prices: { INR: { amount: 1099900, razorpayPlanId: PLANS.growth.razorpayIds.INR }, USD: { amount: 9900, razorpayPlanId: null } } });
  r = await act("growth", { currency: "INR", action: "verify" }); assert.equal(r.data.ok, false); assert.match(r.data.mismatches[0], /its amount is 11798.82, the catalogue price with tax is 12978.82/);

  // Saving an id that Razorpay doesn't know, or whose amount/currency/cycle differ, is refused; a matching one is accepted.
  r = await edit("agency", { prices: { INR: { amount: 2499900, razorpayPlanId: "plan_DoesNotExist01" }, USD: { amount: 24900, razorpayPlanId: null } } }); assert.equal(r.status, 400); assert.match(r.data.error, /doesn't know the plan/);
  rzPlans.plan_WrongAmount001 = { id: "plan_WrongAmount001", period: "monthly", interval: 1, item: { amount: 100, currency: "INR" } };
  r = await edit("agency", { prices: { INR: { amount: 2499900, razorpayPlanId: "plan_WrongAmount001" }, USD: { amount: 24900, razorpayPlanId: null } } }); assert.equal(r.status, 400); assert.match(r.data.error, /its amount is 1, the catalogue price with tax is 29498.82/);
  rzPlans.plan_Yearly000001 = { id: "plan_Yearly000001", period: "yearly", interval: 1, item: { amount: 2499900, currency: "INR" } };
  assert.match((await edit("agency", { prices: { INR: { amount: 2499900, razorpayPlanId: "plan_Yearly000001" }, USD: { amount: 24900, razorpayPlanId: null } } })).data.error, /not monthly/);
  rzPlans.plan_WrongCcy00001 = { id: "plan_WrongCcy00001", period: "monthly", interval: 1, item: { amount: 2499900, currency: "USD" } };
  assert.match((await edit("agency", { prices: { INR: { amount: 2499900, razorpayPlanId: "plan_WrongCcy00001" }, USD: { amount: 24900, razorpayPlanId: null } } })).data.error, /is in USD, not INR/);
  assert.equal((await sql(`select razorpay_plan_id from plan_prices where plan_code = 'agency' and currency = 'INR'`))[0].razorpay_plan_id, null, "nothing was saved");
  // An authentication problem is not "unknown plan": it can't be verified, so it is not blocked as one.
  const real = { fetchPlan: async () => { throw Object.assign(new Error("Razorpay 400: Authentication failed"), { status: 400 }); } }; setClient({ ...real, createPlan: async () => ({}) });
  assert.equal((await edit("agency", { prices: { INR: { amount: 2499900, razorpayPlanId: "plan_AuthFailed0001" }, USD: { amount: 24900, razorpayPlanId: null } } })).status, 200);
  setClient({ createPlan: async (a) => { created.push(a); const id = "plan_Created" + ++n + "Abcdef"; rzPlans[id] = { id, period: "monthly", interval: 1, item: { name: a.name, amount: a.amount, currency: a.currency } }; return rzPlans[id]; }, fetchPlan: async (id) => { if (!rzPlans[id]) throw Object.assign(new Error("Razorpay 400: The ID provided is invalid or could not be found."), { status: 400 }); return rzPlans[id]; } });
  rzPlans.plan_Right0000001A = { id: "plan_Right0000001A", period: "monthly", interval: 1, item: { amount: 2949882, currency: "INR" } };
  assert.equal((await edit("agency", { prices: { INR: { amount: 2499900, razorpayPlanId: "plan_Right0000001A" }, USD: { amount: 24900, razorpayPlanId: null } } })).status, 200);

  // put the catalogue back for the rest of the suite
  await edit("growth", { prices: { INR: { amount: 999900, razorpayPlanId: null }, USD: { amount: 9900, razorpayPlanId: null } } }); await edit("agency", { prices: { INR: { amount: 2499900, razorpayPlanId: null }, USD: { amount: 24900, razorpayPlanId: null } } });
  await sql(`update plan_prices set razorpay_plan_id = null, retired_plan_ids = '{}'`); await loadCatalogue(q);
  delete process.env.BILLING_ENABLED; process.env.PLATFORM_OPERATORS = process.env.PLATFORM_OPERATORS.replace(",plans@x.co", ""); setClient(null);
});

test("razorpay plans: sync-all creates only what is missing, and billing status reports it", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const { setClient } = await import("../../server/razorpay.mjs"); const { loadCatalogue, PLANS, SELF_SERVE } = await import("../../server/plans.mjs"); const { q } = await import("../../server/db.mjs");
  const rz = {}; let n = 0;
  setClient({ createPlan: async (a) => (rz["plan_Sync" + ++n + "Abcdefg"] = { id: "plan_Sync" + n + "Abcdefg", period: "monthly", interval: 1, item: { amount: a.amount, currency: a.currency } }), fetchPlan: async (id) => rz[id], listPlans: async () => ({ items: Object.values(rz) }) });
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: "wh", BILLING_ENABLED: "operators", PUBLIC_ORIGIN: "https://app.example.com" });
  await sql(`update plan_prices set razorpay_plan_id = null, retired_plan_ids = '{}'`); await loadCatalogue(q);
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  await sql(`update users set email_verified_at = now() where email = 'plans@x.co'`);
  const had = process.env.PLATFORM_OPERATORS; process.env.PLATFORM_OPERATORS = (had || "") + ",plans@x.co";
  const sync = (action) => call("pl", "POST", "/api/admin/billing/sync-plans", { action });
  const status = async () => (await call("pl", "GET", "/api/admin/billing/status")).data;
  const total = SELF_SERVE.reduce((t, c) => t + Object.values(PLANS[c].prices).filter((v) => v > 0).length, 0);
  assert.ok(total >= 6, "three self-serve plans in INR and USD");
  let st = await status(); assert.equal(st.checks.find((c) => /have no Razorpay plan/.test(c.label)).level, "error"); assert.equal(st.razorpay.mode, "test"); assert.equal(st.webhookUrl, "https://app.example.com/api/webhooks/razorpay");
  // A plan someone already made by hand in the dashboard (same monthly cycle, amount, currency) is linked, not duplicated.
  rz.plan_ByHand0000001 = { id: "plan_ByHand0000001", period: "monthly", interval: 1, item: { amount: 589882, currency: "INR" } };
  rz.plan_NoGst00000001 = { id: "plan_NoGst00000001", period: "monthly", interval: 1, item: { amount: 999900, currency: "INR" } }; // a hand-made plan without GST is never linked
  rz.plan_WrongAmt00001 = { id: "plan_WrongAmt00001", period: "monthly", interval: 1, item: { amount: 123, currency: "INR" } };
  let r = await sync("create"); assert.equal(r.status, 200); assert.equal(r.data.rows.length, total);
  assert.equal(r.data.rows.find((x) => x.plan === "starter" && x.currency === "INR").razorpayPlanId, "plan_ByHand0000001"); assert.equal(r.data.rows.find((x) => x.plan === "starter" && x.currency === "INR").status, "linked");
  assert.ok(r.data.rows.filter((x) => x.status === "created").length === total - 1 && r.data.rows.every((x) => x.razorpayPlanId), "the rest are created");
  r = await sync("create"); assert.ok(r.data.rows.every((x) => x.status === "exists"), "a second run creates nothing"); assert.equal(Object.keys(rz).length, total - 1 + 3, "one linked, so one fewer created, plus the three hand-made");
  r = await sync("verify"); assert.ok(r.data.rows.every((x) => x.status === "ok"));
  st = await status(); assert.match(st.checks.find((c) => /Razorpay plan/.test(c.label)).label, /All \d+ prices have a Razorpay plan/);
  await sql(`update plan_prices set razorpay_plan_id = 'plan_Gone00000000X' where plan_code = 'starter' and currency = 'USD'`); await loadCatalogue(q); rz.plan_Gone00000000X = { id: "plan_Gone00000000X", period: "monthly", interval: 1, item: { amount: 1, currency: "USD" } };
  assert.equal((await sync("verify")).data.rows.find((x) => x.plan === "starter" && x.currency === "USD").status, "mismatch", "a wrong amount is reported, not hidden");
  await sql(`update plan_prices set razorpay_plan_id = null, retired_plan_ids = '{}'`); await loadCatalogue(q);
  delete process.env.BILLING_ENABLED; delete process.env.PUBLIC_ORIGIN; process.env.PLATFORM_OPERATORS = had; setClient(null);
  assert.equal((await call("pl", "GET", "/api/admin/billing/status")).status, 404, "operators only");
});

test("the billing switch: billing screens are offered to the browser only when billing is open", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const ui = async () => (await call("pl", "GET", "/api/config")).data.billingUi;
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  delete process.env.BILLING_ENABLED; assert.equal(await ui(), false, "0 (the default): nothing billing-related is shown");
  process.env.BILLING_ENABLED = "garbage"; assert.equal(await ui(), false, "an unknown value means off");
  process.env.BILLING_ENABLED = "operators"; assert.equal(await ui(), false, "operators: a normal user sees nothing");
  await sql(`update users set email_verified_at = now() where email = 'plans@x.co'`); process.env.PLATFORM_OPERATORS += ",plans@x.co";
  assert.equal(await ui(), true, "operators: an operator sees it, to test before launch");
  process.env.PLATFORM_OPERATORS = process.env.PLATFORM_OPERATORS.replace(",plans@x.co", "");
  process.env.BILLING_ENABLED = "1"; assert.equal(await ui(), true, "1: everyone (the app also needs a signed-in user before it shows anything)");
  delete process.env.BILLING_ENABLED;
});

test("billing: Razorpay's full-page return is verified by its signature (no session needed) and lands back in the app", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto"); const { setClient } = await import("../../server/razorpay.mjs");
  const synced = []; setClient({ fetchSubscription: async (id) => { synced.push(id); return { id, status: "created" }; } });
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk_cb", RAZORPAY_WEBHOOK_SECRET: "wh" });
  if (!jar.pl) await call("pl", "POST", "/api/auth/signup", { email: "plans@x.co", password: "longenough1" });
  const org = (await call("pl", "GET", "/api/me")).data.org.id;
  await sql(`update organizations set razorpay_checkout_subscription_id = 'sub_CbTest0001' where id = $1`, [org]);
  const post = (form, q = "?sub=sub_CbTest0001") => fetch(base + "/api/billing/callback" + q, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const sig = crypto.createHmac("sha256", "sk_cb").update("pay_1|sub_CbTest0001").digest("hex");
  let r = await post({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_CbTest0001", razorpay_signature: sig });
  assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/?billing=ok"); assert.deepEqual(synced, ["sub_CbTest0001"], "the plan is taken from Razorpay, not the form");
  r = await post({ razorpay_payment_id: "pay_1", razorpay_signature: sig }); assert.equal(r.headers.get("location"), "/?billing=ok", "the subscription id can come from our own callback URL");
  r = await post({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_CbTest0001", razorpay_signature: "0".repeat(64) }); assert.equal(r.headers.get("location"), "/?billing=failed&why=unverified");
  r = await post({ "error[code]": "BAD_REQUEST_ERROR", "error[description]": "Payment declined by bank" }); assert.match(r.headers.get("location"), /^\/\?billing=failed&why=Payment%20declined/);
  await sql(`update organizations set razorpay_checkout_subscription_id = null where id = $1`, [org]);
  delete process.env.BILLING_ENABLED; setClient(null);
});

test("trial: one check of the prompts; then asking is refused and paying starts the plan today", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const { setClient } = await import("../../server/razorpay.mjs");
  const calls = []; setClient({ createSubscription: async (a) => { calls.push(a.startAt); return { id: "sub_one" + calls.length }; }, cancelSubscription: async () => ({}), fetchSubscription: async (id) => ({ id, status: "created" }) });
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: "whsec_test", RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR", RAZORPAY_PLAN_STARTER_INR: "plan_S_INR", RAZORPAY_PLAN_AGENCY_INR: "plan_A_INR" });
  assert.equal((await call("one", "POST", "/api/auth/signup", { email: "onecheck@x.co", password: "longenough1" }, { "x-forwarded-for": "10.8.8.8" })).status, 200);
  assert.equal((await call("one", "POST", "/api/billing/start-trial", { plan: "growth" })).status, 200);
  assert.equal((await call("one", "PUT", "/api/workspaces/solo", { name: "Solo", setup: { profile: { name: "Solo" }, questions: [{ id: "q1", text: "best solo tool" }] } })).status, 200);
  const ask = () => call("one", "POST", "/api/ask", { engine: "chatgpt", question: "best solo tool" });
  let b = (await call("one", "GET", "/api/billing")).data;
  assert.deepEqual([b.limits.checks, b.used.checks], [1, 0]); assert.ok(b.report.metrics.some((m) => m.key === "checks"));
  assert.notEqual((await ask()).data?.code, "plan_limit", "the first check asks freely");
  // The check in progress is saved as it goes and never counts against itself; once it is done, it is the trial's one check.
  const at = Date.now();
  await call("one", "PUT", "/api/runs/one1", { slug: "solo", data: { id: "one1", slug: "solo", startedAt: at } });
  assert.notEqual((await ask()).data?.code, "plan_limit", "a running check keeps asking");
  await call("one", "PUT", "/api/runs/one1", { slug: "solo", data: { id: "one1", slug: "solo", startedAt: at, finishedAt: Date.now() } });
  const r = await ask(); assert.equal(r.status, 402); assert.equal(r.data.code, "plan_limit"); assert.equal(r.data.capability, "checks"); assert.equal(r.data.trialDone, true);
  b = (await call("one", "GET", "/api/billing")).data; assert.equal(b.used.checks, 1); assert.equal(b.mode, "write", "reports stay readable and drafts still work");
  // Paying now doesn't wait for the trial's end date.
  const c = await call("one", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" });
  assert.equal(c.status, 200); assert.equal(c.data.starts, "now"); assert.equal(calls.at(-1), null);
  // Paid plans have no limit on checks.
  const growth = (await import("../../server/plans.mjs")).PLANS.growth; assert.equal(growth.entitlements.checks, Infinity);
  delete process.env.BILLING_ENABLED; setClient(null);
});

test("every plan: each limit allows exactly its allowance and refuses one more (trial, Starter, Growth, Agency)", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const { PLANS } = await import("../../server/plans.mjs");
  process.env.BILLING_ENABLED = "1";
  for (const code of ["trial", "starter", "growth", "agency"]) {
    const who = "every-" + code, e = PLANS[code].entitlements;
    assert.equal((await call(who, "POST", "/api/auth/signup", { email: `${who}@x.co`, password: "longenough1" }, { "x-forwarded-for": "10.9.9." + code.length })).status, 200);
    const org = (await call(who, "GET", "/api/me")).data.org.id;
    await sql(code === "trial"
      ? `update organizations set plan_code = 'growth', billing_status = 'trialing', trial_started_at = now(), trial_ends_at = now() + interval '7 days' where id = $1`
      : `update organizations set plan_code = '${code}', billing_status = 'active', current_period_start = now(), current_period_end = now() + interval '30 days', razorpay_subscription_id = 'sub_every_${code}' where id = $1`, [org]);
    const qs = (n) => Array.from({ length: n }, (_, i) => ({ text: `q ${i}`, on: true }));
    const put = (slug, n, rivals = []) => call(who, "PUT", `/api/workspaces/${slug}`, { name: slug, setup: { profile: { name: slug, competitors: rivals }, questions: qs(n) } });
    const cap = (r) => r.data?.capability, msg = `${code}`;
    // brands: up to the limit, then refused
    for (let i = 0; i < e.brands; i++) assert.equal((await put("b" + i, 1)).status, 200, `${msg}: brand ${i + 1}`);
    assert.equal(cap(await put("bx", 1)), "brands", `${msg}: one brand too many`);
    // questions are pooled across the organisation's brands
    const others = e.brands - 1;
    assert.equal((await put("b0", e.questions - others)).status, 200, `${msg}: exactly ${e.questions} questions`);
    assert.equal(cap(await put("b0", e.questions - others + 1)), "questions", `${msg}: one question too many`);
    await put("b0", 1);
    // competitors per brand
    const rivals = (n) => Array.from({ length: n }, (_, i) => "rival" + i);
    assert.equal((await put("b0", 1, rivals(e.competitors))).status, 200, `${msg}: ${e.competitors} competitors`);
    assert.equal(cap(await put("b0", 1, rivals(e.competitors + 1))), "competitors", `${msg}: one competitor too many`);
    // samples and schedule
    assert.equal(cap(await call(who, "PATCH", "/api/workspaces/b0", { samples: e.samples + 1 })), "samples", msg);
    for (const s of ["weekly", "daily"]) { const r = await call(who, "PATCH", "/api/workspaces/b0", { schedule: s }); assert.equal(e.schedule.includes(s) ? r.status : cap(r), e.schedule.includes(s) ? 200 : "schedule", `${msg}: schedule ${s}`); }
    await call(who, "PATCH", "/api/workspaces/b0", { schedule: "off" });
    // engines
    for (const eng of ["chatgpt", "aio"]) { const r = await call(who, "POST", "/api/ask", { engine: eng, question: "x" }); assert.equal(cap(r) === "engines", !e.engines.includes(eng), `${msg}: engine ${eng}`); }
    // integrations
    for (const p of ["bing", "google"]) { const ok = e.integrations === "all" || e.integrations.includes(p); const r = await call(who, "PUT", `/api/workspaces/b0/integrations/${p}`, { apiKey: "x", propertyId: "x" }); assert.equal(cap(r) === "integrations", !ok, `${msg}: integration ${p}`); }
    // drafted fixes for the period
    await useUp(org, { kind: "write", sub: "pitch", n: e.drafts - 1 });
    assert.notEqual(cap(await call(who, "POST", "/api/write", { kind: "pitch", data: {} })), "drafts", `${msg}: last draft allowed`);
    assert.equal(cap(await call(who, "POST", "/api/write", { kind: "pitch", data: {} })), "drafts", `${msg}: one draft too many`);
    await clearUsage(org);
    // checks: only the free trial has a limit (one)
    await call(who, "PUT", "/api/runs/" + who, { slug: "b0", data: { id: who, slug: "b0", startedAt: Date.now(), finishedAt: Date.now() } });
    assert.equal(cap(await call(who, "POST", "/api/ask", { engine: "chatgpt", question: "x" })) === "checks", code === "trial", `${msg}: re-run after one check`);
    // seats: members plus open invites (the owner is one)
    for (let i = 1; i < e.seats; i++) assert.equal((await call(who, "POST", "/api/org/invitations", { email: `s${i}-${code}@x.co`, role: "viewer" })).status, 200, `${msg}: seat ${i + 1}`);
    assert.equal(cap(await call(who, "POST", "/api/org/invitations", { email: `over-${code}@x.co`, role: "viewer" })), "seats", `${msg}: one seat too many`);
    // the summary the app shows matches the catalogue
    const lim = (await call(who, "GET", "/api/billing")).data.limits;
    for (const k of ["brands", "questions", "competitors", "seats", "drafts", "samples"]) assert.equal(lim[k], e[k], `${msg}: ${k} shown`);
  }
  delete process.env.BILLING_ENABLED;
});

test("trial: the owner can cancel the free trial; a connected card is cancelled at Razorpay; the trial can't restart", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const { setClient } = await import("../../server/razorpay.mjs");
  const cancelled = []; setClient({ cancelSubscription: async (id, a) => { cancelled.push([id, a.atCycleEnd]); return {}; }, fetchSubscription: async (id) => ({ id, status: "authenticated" }), createSubscription: async () => ({ id: "sub_ct" }) });
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: "whsec_test", RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR" });
  assert.equal((await call("ct", "POST", "/api/auth/signup", { email: "canceltrial@x.co", password: "longenough1" }, { "x-forwarded-for": "10.6.6.6" })).status, 200);
  assert.equal((await call("ct", "POST", "/api/billing/start-trial", { plan: "growth" })).status, 200);
  const org = (await call("ct", "GET", "/api/me")).data.org.id;
  await sql(`update organizations set razorpay_subscription_id = 'sub_card' where id = $1`, [org]);
  assert.equal((await call("nobody", "POST", "/api/billing/cancel-trial")).status, 401);
  const r = await call("ct", "POST", "/api/billing/cancel-trial"); assert.equal(r.status, 200);
  assert.deepEqual(cancelled, [["sub_card", false]], "the card is cancelled now: nothing was charged");
  assert.equal(r.data.plan.status, "new"); assert.equal(r.data.mode, "read"); assert.equal(r.data.trialAvailable, false); assert.equal(r.data.paymentMethod.connected, false);
  assert.equal((await call("ct", "POST", "/api/billing/start-trial", { plan: "growth" })).data.code, "trial_used");
  assert.equal((await call("ct", "GET", "/api/workspaces")).status, 200, "reports stay readable");
  assert.match((await call("ct", "PUT", "/api/workspaces/after", { name: "after", setup: { questions: [] } })).data.error, /free trial has ended/);
  assert.ok((await sql(`select 1 from audit_log where org_id = $1 and action = 'billing.trial_cancelled'`, [org])).length);
  delete process.env.BILLING_ENABLED; setClient(null);
});

test("emails: every account and billing notice goes to the owner once, with a link back into the app", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const N = await import("../../server/notify.mjs");
  const { setClient } = await import("../../server/razorpay.mjs");
  setClient({ createSubscription: async () => ({ id: "sub_mail" }), cancelSubscription: async () => ({}), fetchSubscription: async (id) => ({ id, status: "active", payment_method: "card" }),
    updateSubscription: async () => ({}), cancelScheduledChanges: async () => ({}) });
  const WH = "whsec_test";
  Object.assign(process.env, { BILLING_ENABLED: "1", PUBLIC_ORIGIN: "https://app.example", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: WH,
    RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR", RAZORPAY_PLAN_STARTER_INR: "plan_S_INR", RAZORPAY_PLAN_AGENCY_INR: "plan_A_INR" });
  const email = "mailowner@x.co", mine = () => mails.filter((m) => m.to === email);
  const settle = async (n) => { for (let i = 0; i < 50 && mine().length < n; i++) await new Promise((r) => setTimeout(r, 20)); return mine(); };
  const last = () => mine().at(-1);
  assert.equal((await call("ml", "POST", "/api/auth/signup", { email, password: "longenough1" }, { "x-forwarded-for": "10.5.5.5" })).status, 200);
  const org = (await call("ml", "GET", "/api/me")).data.org.id;

  // Trial started at sign-up, once (picking or switching the plan inside the trial doesn't send it again).
  for (let i = 0; i < 50 && !mine().some((m) => m.subject === "Your Perfstaq free trial has started"); i++) await new Promise((r) => setTimeout(r, 20));
  const started = mine().filter((m) => m.subject === "Your Perfstaq free trial has started");
  assert.equal(started.length, 1); assert.match(started[0].html, /https:\/\/app\.example\//); assert.match(started[0].text, /one check of up to 20 prompts/); assert.doesNotMatch(started[0].text, /payment method/);
  mails.splice(0, mails.length, started[0]); // keep only the trial email, so the counts below go 1, 2, 3, 4
  await call("ml", "POST", "/api/billing/start-trial", { plan: "growth" }); await call("ml", "POST", "/api/billing/start-trial", { plan: "starter" });
  await new Promise((r) => setTimeout(r, 100)); assert.equal(mine().length, 1);
  // The trial's one check is done.
  await call("ml", "PUT", "/api/workspaces/mailco", { name: "Mailco", setup: { profile: { name: "Mailco" }, questions: [{ text: "q" }] } });
  await call("ml", "PUT", "/api/runs/mail1", { slug: "mailco", data: { id: "mail1", slug: "mailco", startedAt: Date.now(), finishedAt: Date.now() } });
  await call("ml", "PUT", "/api/runs/mail1", { slug: "mailco", data: { id: "mail1", slug: "mailco", startedAt: Date.now(), finishedAt: Date.now() } }); // saved twice
  await settle(2); assert.equal(last().subject, "Your free trial check is done"); assert.match(last().html, /#plans/);
  // Trial ending soon, then ended (from the scheduler sweep), each once however often it runs.
  await sql(`update organizations set trial_ends_at = now() + interval '1 day' where id = $1`, [org]);
  await N.trialSweep(); await N.trialSweep(); assert.equal((await settle(3)).length, 3); assert.match(last().subject, /^Your Perfstaq trial ends /);
  await sql(`update organizations set trial_ends_at = now() - interval '1 hour' where id = $1`, [org]);
  await N.trialSweep(); await N.trialSweep(); assert.equal((await settle(4)).length, 4); assert.equal(last().subject, "Your Perfstaq trial has ended");

  // Paid: a webhook makes it active -> welcome; an upgrade lands -> plan changed; a failed charge -> payment failed; it ends -> ended.
  await sql(`update organizations set billing_status = 'trialing', plan_code = 'growth', razorpay_subscription_id = 'sub_mail' where id = $1`, [org]);
  let T = Math.floor(Date.now() / 1000);
  const hook = async (event, planId, extra = {}) => { const raw = JSON.stringify({ event, created_at: ++T, payload: { subscription: { entity: { id: "sub_mail", plan_id: planId, ...extra } } } });
    await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "m" + Math.random(), "x-razorpay-signature": crypto.createHmac("sha256", WH).update(raw).digest("hex") }, body: raw }); };
  const end = Math.floor(Date.now() / 1000) + 30 * 864e2;
  await hook("subscription.activated", "plan_G_INR", { current_start: T, current_end: end }); await hook("subscription.charged", "plan_G_INR", { current_start: T, current_end: end });
  await settle(5); assert.equal(last().subject, "Welcome to Perfstaq Growth"); assert.match(last().text, /₹11,798\.82 a month including GST/);
  await hook("subscription.updated", "plan_A_INR", { has_scheduled_changes: false });
  await settle(6); assert.equal(last().subject, "You're now on Perfstaq Agency");
  await hook("subscription.pending", "plan_A_INR"); await hook("subscription.pending", "plan_A_INR");
  await settle(7); assert.equal(last().subject, "Your Perfstaq payment didn't go through"); assert.match(last().text, /Update your payment method by/);
  await hook("subscription.charged", "plan_A_INR", { current_start: T, current_end: end }); // paid again: back to active, no second welcome for the same plan
  await new Promise((r) => setTimeout(r, 150)); assert.equal(mine().length, 7);
  // Owner actions: downgrade scheduled, then cancel.
  assert.equal((await call("ml", "POST", "/api/billing/change-plan", { plan: "growth" })).status, 200);
  await settle(8); assert.equal(last().subject, "Your move to Perfstaq Growth is scheduled");
  assert.equal((await call("ml", "POST", "/api/billing/cancel")).status, 200);
  await settle(9); assert.equal(last().subject, "Your Perfstaq subscription is cancelled"); assert.match(last().text, /You won't be charged again/);
  await hook("subscription.cancelled", "plan_A_INR", { current_end: end });
  await settle(10); assert.equal(last().subject, "Your Perfstaq subscription has ended");

  // Weekly results go to the owner and admins; trial cancelled goes to the owner.
  await N.notify(org, "weekly_results", "run-w1", { brand: "Mailco", slug: "mailco", s: { visibility: 0.4, score: 51, sov: 0.1, leader: { name: "Rival", vis: 0.6 } }, prev: { visibility: 0.3 } }, { admins: true });
  assert.equal(last().subject, "Mailco: your weekly AI visibility"); assert.match(last().text, /Visibility 40% \(up 10 points\)/); assert.match(last().html, /#brand\/mailco/);
  assert.equal((await N.notify(org, "weekly_results", "run-w1", {}, { admins: true })).reason, "already sent");
  await sql(`update organizations set billing_status = 'trialing', razorpay_subscription_id = null, trial_ends_at = now() + interval '2 days' where id = $1`, [org]);
  await call("ml", "POST", "/api/billing/cancel-trial"); await settle(12); assert.equal(last().subject, "Your Perfstaq trial is cancelled");
  // Every kind has a template, and every one was logged as sent.
  const kinds = (await sql(`select kind, status from email_log where org_id = $1`, [org]));
  assert.deepEqual([...new Set(kinds.map((k) => k.kind))].sort(), [...N.KINDS].sort()); assert.ok(kinds.every((k) => k.status === "sent"));
  delete process.env.BILLING_ENABLED; delete process.env.PUBLIC_ORIGIN; setClient(null);
});

test("queue a check: refused once the trial's check is used; runs even with automatic checks off; emails link to the live app", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  process.env.BILLING_ENABLED = "1";
  assert.equal((await call("qc", "POST", "/api/auth/signup", { email: "queue@x.co", password: "longenough1" }, { "x-forwarded-for": "10.4.4.4" })).status, 200);
  await call("qc", "POST", "/api/billing/start-trial", { plan: "growth" });
  const org = (await call("qc", "GET", "/api/me")).data.org.id;
  await call("qc", "PUT", "/api/workspaces/queued", { name: "Queued", setup: { profile: { name: "Queued", site: "https://queued.example" }, questions: [{ text: "best queue tool" }] } });
  // Before the trial's check: queueing is allowed, and a brand with automatic checks off still gets picked up by the scheduler.
  assert.equal((await call("qc", "PATCH", "/api/workspaces/queued", { runNow: true })).status, 200);
  await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  const runs = await sql(`select r.source, r.status from runs r join workspaces w on w.id = r.workspace_id where w.org_id = $1`, [org]);
  assert.ok(runs.some((r) => r.source === "scheduled"), "the queued check ran although the schedule is off");
  assert.equal((await sql(`select next_run_at from workspaces where org_id = $1`, [org]))[0].next_run_at, null, "and nothing more is scheduled");
  // That was the trial's one check: queueing another is refused.
  const r = await call("qc", "PATCH", "/api/workspaces/queued", { runNow: true });
  assert.equal(r.status, 402); assert.equal(r.data.capability, "checks");
  // Email buttons open the live app, even when sent from a local server.
  const N = await import("../../server/notify.mjs");
  process.env.PUBLIC_ORIGIN = "http://localhost:3055"; assert.match(N.preview("trial_ended").link, /^https:\/\/os\.perfstaq\.com\/#plans$/);
  process.env.APP_URL = "https://app.perfstaq.com"; assert.match(N.preview("trial_ended").link, /^https:\/\/app\.perfstaq\.com\//);
  delete process.env.APP_URL; delete process.env.PUBLIC_ORIGIN; delete process.env.BILLING_ENABLED;
});

test("console: operator-only guard; env operators are founders, table operators get their role, inactive ones get 404", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const ip = { "x-forwarded-for": "10.9.9.9" }; // sign-ups are rate limited per address
  for (const [who, email] of [["cs", "console-user@x.co"], ["cb", "console-boss@x.co"]]) assert.equal((await call(who, "POST", "/api/auth/signup", { email, password: "longenough1" }, ip)).status, 200);
  assert.equal((await call("nobody3", "GET", "/api/admin/console/me")).status, 401);
  assert.equal((await call("cs", "GET", "/api/admin/console/me")).status, 404, "a customer can't see it exists");
  await sql(`update users set email_verified_at = now() where email in ('console-user@x.co', 'console-boss@x.co')`);
  assert.equal((await call("cs", "GET", "/api/admin/console/me")).status, 404, "verified but not an operator");
  await sql(`insert into operators (user_id, role) select id, 'support' from users where email = 'console-user@x.co'`);
  const me = (await call("cs", "GET", "/api/admin/console/me")).data;
  assert.equal(me.role, "support"); assert.equal(me.email, "console-user@x.co"); assert.ok(Array.isArray(me.groups));
  await sql(`update operators set active = false`);
  assert.equal((await call("cs", "GET", "/api/admin/console/me")).status, 404, "deactivated");
  process.env.PLATFORM_OPERATORS += ",console-boss@x.co";
  assert.equal((await call("cb", "GET", "/api/admin/console/me")).data.role, "founder");
});

test("console: pages answer, roles narrow them, a subscription link stays pending until Razorpay's webhook confirms it", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const { setClient } = await import("../../server/razorpay.mjs");
  const SECRET = "whsec_console";
  const created = [], cancelled = [];
  setClient({ createSubscription: async (a) => { created.push(a); return { id: "sub_link_" + created.length, short_url: "https://rzp.io/i/abc" + created.length }; },
    cancelSubscription: async (id) => { cancelled.push(id); return {}; } });
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: SECRET, RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR" });
  // cb is a founder (PLATFORM_OPERATORS) from the guard test; cs becomes support.
  await sql(`update operators set active = true, role = 'support'`);
  for (const p of ["overview", "customers", "platform"]) assert.equal((await call("cb", "GET", "/api/admin/console/" + p)).status, 200, p);
  assert.equal((await call("cs", "GET", "/api/admin/console/revenue")).status, 403, "support can't see revenue");
  assert.equal((await call("cs", "GET", "/api/admin/console/subscriptions")).status, 200);
  assert.equal((await call("cc", "POST", "/api/auth/signup", { email: "console-customer@x.co", password: "longenough1" }, { "x-forwarded-for": "10.9.9.10" })).status, 200);
  assert.equal((await call("cc", "GET", "/api/admin/console/overview")).status, 404, "customers never see it");

  const slug = (await call("cs", "GET", "/api/me")).data.org.slug, org = (await call("cs", "GET", "/api/me")).data.org.id;
  await sql(`update organizations set plan_code = 'legacy', billing_status = 'internal', razorpay_subscription_id = null, razorpay_checkout_subscription_id = null where id = $1`, [org]);
  const send = (who, b) => call(who, "POST", `/api/admin/console/customers/${slug}/subscription`, b);
  assert.equal((await send("cs", { plan: "growth", currency: "INR", reason: "agreed" })).status, 403, "support can't create subscriptions");
  assert.equal((await send("cb", { plan: "growth", currency: "INR" })).status, 400, "a reason is required");
  assert.equal((await send("cb", { plan: "growth", currency: "EUR", reason: "agreed" })).status, 400, "no Razorpay plan for that price");
  let r = await send("cb", { plan: "growth", currency: "INR", reason: "agreed on call" });
  assert.equal(r.status, 200); assert.equal(r.data.url, "https://rzp.io/i/abc1"); assert.equal(r.data.sentTo, "console-user@x.co");
  assert.equal(created[0].planId, "plan_G_INR"); assert.equal(created[0].notifyEmail, "console-user@x.co"); assert.equal(created[0].orgId, org);
  let o = (await sql(`select * from organizations where id = $1`, [org]))[0];
  assert.equal(o.razorpay_checkout_subscription_id, "sub_link_1"); assert.equal(o.plan_code, "legacy", "nothing changes before Razorpay confirms");
  // A second link replaces the first unpaid one.
  r = await send("cb", { plan: "growth", currency: "INR", reason: "resend" });
  assert.deepEqual(cancelled, ["sub_link_1"]);
  const log = (await call("cs", "GET", "/api/org/audit")).data.log.filter((x) => x.action === "billing.link_sent");
  assert.equal(log.length, 2); assert.equal(log[0].detail.reason, "resend");
  // Razorpay's signed activation adopts the pending subscription.
  const raw = JSON.stringify({ event: "subscription.activated", created_at: Math.floor(Date.now() / 1000) + 5, payload: { subscription: { entity: { id: "sub_link_2", plan_id: "plan_G_INR", status: "active", current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 30 * 86400 } } } });
  const h = await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "evt_console_1", "x-razorpay-signature": crypto.createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw });
  assert.equal(h.status, 200);
  o = (await sql(`select * from organizations where id = $1`, [org]))[0];
  assert.equal(o.razorpay_subscription_id, "sub_link_2"); assert.equal(o.plan_code, "growth"); assert.equal(o.billing_status, "active");
  assert.equal((await send("cb", { plan: "growth", currency: "INR", reason: "again" })).status, 409, "already paying");
  // The console now counts it.
  const ov = (await call("cb", "GET", "/api/admin/console/overview")).data;
  assert.ok(ov.kpis.mrrInr >= 999900); assert.ok(ov.kpis.paying >= 1);
  // Notes and the attention feed.
  assert.equal((await call("cs", "POST", `/api/admin/console/customers/${slug}/notes`, { body: "Called, happy" })).status, 200);
  assert.equal((await call("cb", "GET", `/api/admin/console/customers/${slug}`)).data.notes[0].body, "Called, happy");
  assert.equal((await call("cs", "POST", "/api/admin/console/attention", { key: `payment_failed:${slug}`, days: 2 })).status, 200);
  assert.equal((await call("cs", "POST", "/api/admin/console/attention", { key: "x; drop table", days: 2 })).status, 400);
  setClient(null);
  for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_PLAN_GROWTH_INR"]) delete process.env[k];
});

test("console billing: finance runs the catalogue and assigns plans; change plan, cancel, invoices and refunds go through Razorpay with a reason", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const { setClient } = await import("../../server/razorpay.mjs");
  const calls = [];
  const invoices = { items: [{ id: "inv_1", payment_id: "pay_ok", amount: 1179882, amount_paid: 1179882, currency: "INR", status: "paid", issued_at: 1790000000, short_url: "https://rzp.io/i/inv1" }] };
  setClient({ fetchSubscription: async () => ({ status: "active", payment_method: "card" }), updateSubscription: async (id, a) => { calls.push(["update", id, a]); return {}; },
    cancelScheduledChanges: async () => ({}), cancelSubscription: async (id, a) => { calls.push(["cancel", id, a]); return {}; },
    listInvoices: async (sid) => { calls.push(["invoices", sid]); return invoices; }, refundPayment: async (id, a) => { calls.push(["refund", id, a]); return { id: "rfnd_1", amount: a.amount ?? 1179882, status: "processed" }; } });
  Object.assign(process.env, { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: "wh", RAZORPAY_PLAN_GROWTH_INR: "plan_G_INR", RAZORPAY_PLAN_AGENCY_INR: "plan_A_INR", RAZORPAY_PLAN_STARTER_INR: "plan_S_INR", BILLING_ENABLED: "1" });
  // cs is a table operator: support can't touch plans, finance can.
  await sql(`update operators set role = 'support', active = true`);
  assert.equal((await call("cs", "GET", "/api/admin/plans")).status, 404);
  await sql(`update operators set role = 'finance'`);
  assert.equal((await call("cs", "GET", "/api/admin/plans")).status, 200);
  // Create a custom plan and assign it (no card) with a custom seat limit.
  const plan = { name: "Acme Custom", description: "", public: false, selfServe: false, active: true, aiCapUsd: 40, limits: { brands: 8, seats: 25, questions: 150 }, engines: ["chatgpt"], schedules: ["off", "weekly"], integrations: [], prices: { INR: { amount: 3000000 } } };
  assert.equal((await call("cs", "PUT", "/api/admin/plans/acme-custom", plan)).status, 200);
  const slug = (await call("cc", "GET", "/api/me")).data.org.slug, org = (await call("cc", "GET", "/api/me")).data.org.id;
  const until = new Date(Date.now() + 30 * 864e5).toISOString();
  assert.equal((await call("cs", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: "acme-custom", status: "active", periodEndsAt: until, reason: "annual contract", overrides: { values: { seats: 30 }, expiresAt: until } })).status, 200);
  const me = (await call("cc", "GET", "/api/me")).data.billing;
  assert.equal(me.plan.code, "acme-custom"); assert.equal(me.limits.seats, 30); assert.equal(me.limits.brands, 8);
  const cust = (await call("cs", "GET", "/api/admin/console/customers")).data.orgs.find((o) => o.slug === slug);
  assert.equal(cust.mrr, 3000000); assert.equal(cust.contracted, true);

  // Now the organisation pays by Razorpay on Growth: change, cancel, invoices, refund.
  await sql(`update organizations set plan_code = 'growth', billing_status = 'active', billing_currency = 'INR', razorpay_subscription_id = 'sub_cc', cancel_at_period_end = false, pending_plan_code = null,
             current_period_end = now() + interval '20 days', entitlement_overrides = '{}' where id = $1`, [org]);
  const post = (path, b) => call("cs", "POST", `/api/admin/console/customers/${slug}/${path}`, b);
  assert.equal((await post("change-plan", { plan: "agency" })).status, 400, "reason required");
  let r = await post("change-plan", { plan: "agency", reason: "needs 5 brands" });
  assert.equal(r.status, 200); assert.equal(r.data.upgrade, true); assert.deepEqual(calls.at(-1), ["update", "sub_cc", { planId: "plan_A_INR", at: "now" }]);
  r = await post("change-plan", { plan: "starter", reason: "budget" });
  assert.equal(r.data.pendingPlan, "starter"); assert.equal(calls.at(-1)[2].at, "cycle_end", "downgrades wait for the period end");
  assert.equal((await post("cancel", { now: true, reason: "fraud", confirm: "wrong" })).status, 400, "ending now needs the slug typed");
  r = await post("cancel", { reason: "moving to annual invoice" });
  assert.equal(r.status, 200); assert.deepEqual(calls.at(-1), ["cancel", "sub_cc", { atCycleEnd: true }]);
  assert.equal((await sql(`select cancel_at_period_end from organizations where id = $1`, [org]))[0].cancel_at_period_end, true);
  const inv = (await call("cs", "GET", `/api/admin/console/customers/${slug}/invoices`)).data.invoices;
  assert.equal(inv[0].paymentId, "pay_ok"); assert.equal(inv[0].url, "https://rzp.io/i/inv1");
  assert.equal((await post("refund", { paymentId: "pay_someone_else", confirm: slug, reason: "dup" })).status, 400, "only this subscription's payments");
  assert.equal((await post("refund", { paymentId: "pay_ok", confirm: slug, reason: "dup", amount: 99999999 })).status, 400, "not more than charged");
  assert.equal((await post("refund", { paymentId: "pay_ok", reason: "dup" })).status, 400, "confirmation required");
  r = await post("refund", { paymentId: "pay_ok", confirm: slug, reason: "charged twice", amount: 100000 });
  assert.equal(r.status, 200); assert.equal(r.data.refundId, "rfnd_1"); assert.equal(calls.at(-1)[2].amount, 100000);
  const log = (await call("cc", "GET", "/api/org/audit")).data.log.map((x) => x.action);
  for (const a of ["billing.operator_set", "billing.upgrade_requested", "billing.downgrade_scheduled", "billing.cancel_requested", "billing.refund_issued"]) assert.ok(log.includes(a), a);
  // Support can read invoices but not change money.
  await sql(`update operators set role = 'support'`);
  assert.equal((await post("refund", { paymentId: "pay_ok", confirm: slug, reason: "x y z" })).status, 403);
  assert.equal((await call("cs", "GET", `/api/admin/console/customers/${slug}/invoices`)).status, 200);
  // Active users: today's activity is counted.
  const act = (await call("cb", "GET", "/api/admin/console/activity?days=30")).data;
  assert.equal(act.series.length, 30); assert.ok(act.now.dau >= 1); assert.ok(act.now.mau >= act.now.wau && act.now.wau >= act.now.dau);
  setClient(null);
  for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_PLAN_GROWTH_INR", "RAZORPAY_PLAN_AGENCY_INR", "RAZORPAY_PLAN_STARTER_INR", "BILLING_ENABLED"]) delete process.env[k];
});

test("presence, live stream, insights and plan delete", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  // Presence: signed in only, page names only, one page view per page change.
  assert.equal((await call("nobody4", "POST", "/api/presence", { page: "overview" })).status, 401);
  assert.equal((await call("cc", "POST", "/api/presence", { page: "../etc/passwd" })).status, 400);
  assert.equal((await call("cc", "POST", "/api/presence", { page: "overview", brand: "Bad Brand!" })).status, 400);
  const uid = (await sql(`select id from users where email = 'console-customer@x.co'`))[0].id;
  await sql(`delete from page_views where user_id = $1`, [uid]); await sql(`delete from presence where user_id = $1`, [uid]);
  for (const page of ["overview", "overview", "prompts"]) assert.equal((await call("cc", "POST", "/api/presence", { page, brand: "acme" }, { "user-agent": "Mozilla/5.0 (iPhone) Mobile" })).status, 200);
  assert.deepEqual((await sql(`select page from page_views where user_id = $1 order by id`, [uid])).map((r) => r.page), ["overview", "prompts"]);
  const pr = (await sql(`select page, brand, device from presence where user_id = $1`, [uid]))[0];
  assert.deepEqual({ ...pr }, { page: "prompts", brand: "acme", device: "mobile" });

  // Live: operator-only SSE; the first snapshot shows this person online on that page.
  assert.equal((await fetch(base + "/api/admin/console/live", { headers: { cookie: jar.cc } })).status, 404);
  const ctl = new AbortController(), r = await fetch(base + "/api/admin/console/live", { headers: { cookie: jar.cb }, signal: ctl.signal });
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const reader = r.body.getReader(); let buf = "";
  while (!buf.includes("\n\n")) buf += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  const snap = JSON.parse(buf.split("\n").find((l) => l.startsWith("data: ")).slice(6));
  assert.ok(snap.online.some((x) => x.email === "console-customer@x.co" && x.page === "prompts"));
  assert.equal(snap.perMinute.length, 60); assert.ok(snap.today >= 1);

  // Insights answer and carry findings.
  const ins = (await call("cb", "GET", "/api/admin/console/engagement")).data;
  assert.ok(ins.adoption.some((x) => x.page === "prompts")); assert.ok(Array.isArray(ins.cohorts)); assert.ok(Array.isArray(ins.findings));
  assert.equal(ins.northStar.length, 12);

  // Plan delete: built-ins and plans in use are refused; an unused plan goes, audited.
  assert.equal((await call("cb", "DELETE", "/api/admin/plans/legacy")).status, 400);
  await sql(`update operators set role = 'finance'`);
  const plan = { name: "Spare", public: false, selfServe: false, active: true, limits: {}, engines: ["chatgpt"], schedules: ["off"], integrations: [], prices: {} };
  assert.equal((await call("cs", "PUT", "/api/admin/plans/spare-plan", plan)).status, 200);
  const org = (await call("cc", "GET", "/api/me")).data.org.id;
  await sql(`update organizations set pending_plan_code = 'spare-plan' where id = $1`, [org]);
  assert.equal((await call("cs", "DELETE", "/api/admin/plans/spare-plan")).status, 409, "someone is moving onto it");
  await sql(`update organizations set pending_plan_code = null where id = $1`, [org]);
  assert.equal((await call("cs", "DELETE", "/api/admin/plans/spare-plan")).status, 200);
  assert.ok(!(await call("cs", "GET", "/api/admin/plans")).data.plans.some((p) => p.code === "spare-plan"));
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'plan.catalogue_deleted' and target = 'spare-plan'`))[0].n, 1);
  await sql(`update operators set role = 'support'`);
  assert.equal((await call("cs", "DELETE", "/api/admin/plans/acme-custom")).status, 404, "support can't touch the catalogue");
});

test("founder command: account groups scope every figure; every page answers; the drawer carries plan and subscription", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const get = (p) => call("cb", "GET", "/api/admin/console/" + p);
  const cust = (await call("cc", "GET", "/api/me")).data.org;
  const accounts = async (qs = "") => (await get("customers-page" + qs)).data.accounts.map((a) => a.slug);
  assert.ok((await accounts()).includes(cust.slug));
  // Groups: an internal group leaves its organisations out of "customers only" (not out of "all"); a demo group hides with the switch.
  await sql(`update operators set role = 'analyst'`);
  assert.equal((await call("cs", "POST", "/api/admin/console/groups", { name: "Nope" })).status, 403, "analysts can't change groups");
  let g = (await call("cb", "POST", "/api/admin/console/groups", { name: "Founding team", kind: "internal" })).data.group;
  assert.equal((await call("cb", "PATCH", `/api/admin/console/groups/${g.id}`, { add: [cust.slug, "../bad slug"] })).status, 200);
  assert.ok(!(await accounts()).includes(cust.slug), "left out of customers only");
  assert.ok((await accounts("?accounts=all")).includes(cust.slug), "kept in all accounts");
  assert.deepEqual(await accounts(`?accounts=group:${g.id}`), [cust.slug], "a group view shows only its members");
  assert.equal((await get("pulse")).data.scope.label.startsWith("customers only"), true);
  await call("cb", "PATCH", `/api/admin/console/groups/${g.id}`, { leaveOut: false });
  assert.ok((await accounts()).includes(cust.slug), "unticking leave-out counts it again");
  const demo = (await call("cb", "POST", "/api/admin/console/groups", { name: "Demo", kind: "demo" })).data.group;
  await call("cb", "PATCH", `/api/admin/console/groups/${demo.id}`, { add: [cust.slug] });
  assert.ok((await accounts()).includes(cust.slug)); assert.ok(!(await accounts("?demo=hide")).includes(cust.slug), "demo hides with the switch");
  assert.equal((await call("cb", "PATCH", `/api/admin/console/groups/${g.id}`, { name: "" })).status, 400);
  assert.ok((await get("me")).data.groups.some((x) => x.id === g.id));
  for (const id of [g.id, demo.id]) assert.equal((await call("cb", "DELETE", `/api/admin/console/groups/${id}`)).status, 200);
  assert.ok((await accounts()).includes(cust.slug));

  // Every Founder Command page answers with its provenance.
  for (const p of ["pulse", "value", "customers-page", "customers-page?health=blocked", "plans-subs", "operations", "operations?status=failed", "ai", "integrations", "releases"]) {
    const res = await get(p); assert.equal(res.status, 200, p); assert.ok(res.data.scope && res.data.asOf, p + " carries scope and as-of");
  }
  const pulse = (await get("pulse")).data;
  assert.equal(pulse.weeks.length, 12); assert.ok(pulse.kpis.brands >= 1); assert.ok(Array.isArray(pulse.watch)); assert.ok(pulse.funnel.onboarded >= pulse.funnel.checked);
  const ps = (await get("plans-subs")).data;
  assert.ok(ps.plans.some((p) => p.code === "growth" && p.prices.INR.withTax === 1179882), "price shown with GST");
  // The account drawer: plan and subscription block and group membership.
  const acct = (await get(`customers/${cust.slug}`)).data;
  assert.ok(acct.subscription && acct.subscription.plan && "payment" in acct.subscription && Array.isArray(acct.subscription.history)); assert.ok(Array.isArray(acct.groups));
  await sql(`update operators set role = 'support'`);
});

test("business in product units: outcomes, plan fit, unit costs and usage depth read one known account right", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const C = (m, p, b) => call("cb", m, "/api/admin/console/" + p, b);
  // One Starter account (15 questions, 3 competitors) with one brand: 13 questions on and 1 off, 3 competitors, two engines, weekly.
  const slug = (await C("POST", "accounts", { name: "Units Co", ownerEmail: "units-owner@x.co" })).data.account.slug;
  assert.equal((await call("cb", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: "starter", status: "active", periodEndsAt: new Date(Date.now() + 20 * 864e5).toISOString(), reason: "test" })).status, 200);
  const org = (await sql(`select id from organizations where slug = $1`, [slug]))[0].id;
  const questions = [...Array.from({ length: 13 }, (_, i) => ({ text: `Q${i}`, intent: i < 5 ? "transactional" : "commercial", on: true })), { text: "off", intent: "informational", on: false }];
  const ws = (await sql(`insert into workspaces (org_id, slug, name, setup, schedule, samples) values ($1, 'units', 'Units Brand', $2, 'weekly', 1) returning id`,
    [org, { profile: { name: "Units Brand", competitors: ["Rival Co", "B", "C"] }, questions, engines: ["chatgpt", "gemini"] }]))[0].id;
  const summary = (score, vis) => ({ score, visibility: vis, rank: 2, brands: 4, leader: { name: "Rival Co" }, engines: { chatgpt: vis, gemini: vis / 2 } });
  await sql(`insert into runs (id, workspace_id, status, started_at, summary) values ('units-1', $1, 'done', now() - interval '20 days', $2), ('units-2', $1, 'done', now() - interval '1 day', $3)`,
    [ws, summary(40, 0.3), summary(55, 0.5)]);
  await sql(`insert into usage (org_id, workspace_id, kind, engine, cost_usd, at) select $1, $2, 'ask', e, 0.01, now() - interval '2 days' from unnest(array['chatgpt', 'chatgpt', 'gemini', 'gemini']) e`, [org, ws]);
  await sql(`insert into usage (org_id, workspace_id, kind, sub, cost_usd) values ($1, $2, 'write', 'pitch', 0.02)`, [org, ws]);
  const g = (await C("POST", "groups", { name: "Units", kind: "custom" })).data.group;
  await C("PATCH", `groups/${g.id}`, { add: [slug] });
  const get = async (p) => { const r = await C("GET", `${p}?accounts=group:${g.id}`); assert.equal(r.status, 200, p); return r.data; };

  const out = await get("outcomes");
  assert.equal(out.kpis.brands, 1); assert.equal(out.kpis.comparable, 1, "two checks 19 days apart compare");
  assert.equal(out.kpis.improving, 1); assert.equal(out.kpis.medianDelta, 15); assert.equal(out.kpis.medianScore, 55);
  assert.deepEqual(out.rivals, [{ name: "Rival Co", n: 1 }]); assert.equal(out.engines.find((e) => e.engine === "chatgpt").visibility, 50);
  assert.equal(out.improvers[0].visDelta, 20);

  const fit = await get("plan-fit");
  assert.equal(fit.plans.length, 1); const st = fit.plans[0];
  assert.equal(st.code, "starter"); assert.equal(st.metrics.questions.medianUsed, 13, "the switched-off question isn't counted");
  assert.equal(st.metrics.questions.near, 1); assert.equal(st.metrics.questions.atCap, 0); assert.equal(st.metrics.competitors.atCap, 1);
  assert.equal(st.metrics.brands.near, 0, "a cap of 1 is the plan's shape, not an expansion signal");
  assert.deepEqual(fit.expansion.find((a) => a.slug === slug).near, ["questions", "competitors"]);
  assert.equal(st.metrics.drafts.medianUsed, 1);

  const uc = await get("unit-costs");
  assert.equal(uc.totals.answers, 4); assert.ok(Math.abs(uc.totals.perAnswer - 0.01) < 1e-9);
  assert.deepEqual(uc.engines.map((e) => [e.engine, e.answers]).sort(), [["chatgpt", 2], ["gemini", 2]]);
  const proj = uc.projected.find((b) => b.slug === "units");
  assert.equal(proj.answersPerMonth, Math.round(13 * 2 * 1 * 4.3), "questions × engines × samples × weekly checks"); assert.equal(proj.projectedUsd, 1.12);

  const ud = await get("usage-depth");
  assert.equal(ud.kpis.questions, 13); assert.equal(ud.kpis.configured, 1); assert.equal(ud.kpis.medianCompetitors, 3);
  assert.equal(ud.schedules.find((s) => s.key === "weekly").n, 1);
  assert.deepEqual(ud.intents, [{ key: "Consideration (compare)", n: 8 }, { key: "Decision (act)", n: 5 }]);

  // Pricing and cost pages are for founders, finance and analysts; support reads customers, not margins.
  await sql(`update operators set role = 'support'`);
  for (const p of ["plan-fit", "unit-costs"]) assert.equal((await call("cs", "GET", "/api/admin/console/" + p)).status, 403, p);
  assert.equal((await call("cs", "GET", "/api/admin/console/outcomes")).status, 200);
  await C("DELETE", `groups/${g.id}`);
  assert.equal((await C("DELETE", `accounts/${slug}`, { confirm: slug, reason: "test" })).status, 200);
});

test("limits on the current plan: raise questions, brands and website pages for one account; paying accounts too; back to the plan", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const C = (m, p, b) => call("cb", m, "/api/admin/console/" + p, b);
  const slug = (await C("POST", "accounts", { name: "Limits Co", ownerEmail: "limits-owner@x.co" })).data.account.slug;
  const org = (await sql(`select id from organizations where slug = $1`, [slug]))[0].id;
  // On Starter and paying through Razorpay: the old route refuses (it rewrites the plan), the limits route doesn't touch billing.
  await sql(`update organizations set plan_code = 'starter', billing_status = 'active', billing_currency = 'INR', razorpay_subscription_id = 'sub_limits_test', current_period_end = now() + interval '20 days' where id = $1`, [org]);
  assert.equal((await call("cb", "PATCH", `/api/admin/orgs/${slug}/billing`, { overrides: { values: { questions: 40 } }, reason: "x y z" })).status, 409);
  assert.equal((await C("PUT", `customers/${slug}/limits`, { values: { questions: 40 } })).status, 400, "a reason is required");
  assert.equal((await C("PUT", `customers/${slug}/limits`, { values: { nope: 4 }, reason: "test" })).data.code, "bad_limit");
  assert.equal((await C("PUT", `customers/${slug}/limits`, { values: { questions: -1 }, reason: "test" })).status, 400);
  assert.equal((await C("PUT", `customers/${slug}/limits`, { values: { questions: 40 }, expiresAt: "2000-01-01", reason: "test" })).status, 400, "the end date must be ahead");
  let r = await C("PUT", `customers/${slug}/limits`, { values: { questions: 40, brands: 3, pages: 40 }, reason: "agreed on a call" });
  assert.equal(r.status, 200);
  const row = (k) => r.data.subscription.limitRows.find((x) => x.key === k);
  assert.deepEqual([row("questions").plan, row("questions").now, row("questions").custom], [15, 40, 40]);
  assert.deepEqual([row("brands").now, row("pages").now, row("pages").plan], [3, 40, null], "pages: empty on the plan = the product default");
  const st = (await sql(`select plan_code, billing_status, razorpay_subscription_id, entitlement_overrides from organizations where id = $1`, [org]))[0];
  assert.deepEqual([st.plan_code, st.billing_status, st.razorpay_subscription_id], ["starter", "active", "sub_limits_test"], "plan and subscription untouched");
  const { billingState } = await import("../../server/billing.mjs");
  process.env.BILLING_ENABLED = "1";
  let ent = (await billingState(org)).ent; assert.deepEqual([ent.questions, ent.brands, ent.pages, ent.competitors], [40, 3, 40, 3], "the account's limits apply; the rest stay the plan's");
  // Changing one keeps the others; null puts one back to the plan's.
  r = await C("PUT", `customers/${slug}/limits`, { values: { brands: null, questions: 50 }, reason: "more questions" });
  ent = (await billingState(org)).ent; assert.deepEqual([ent.questions, ent.brands, ent.pages], [50, 1, 40]);
  // An end date survives a change that doesn't mention one; null removes it.
  const later = new Date(Date.now() + 30 * 864e5).toISOString(), ends = async () => (await sql(`select entitlement_overrides->>'expiresAt' as e from organizations where id = $1`, [org]))[0].e;
  await C("PUT", `customers/${slug}/limits`, { values: { questions: 50 }, expiresAt: later, reason: "for a month" });
  await C("PUT", `customers/${slug}/limits`, { values: { pages: 45 }, reason: "one more page" });
  assert.equal(await ends(), later, "changing one limit keeps the end date");
  await C("PUT", `customers/${slug}/limits`, { values: { pages: 40 }, expiresAt: null, reason: "permanent now" });
  assert.equal(await ends(), null);
  // Back to the plan's limits entirely.
  r = await C("PUT", `customers/${slug}/limits`, { values: { questions: null, pages: null }, reason: "back to plan" });
  assert.equal(r.data.subscription.overrides, null); ent = (await billingState(org)).ent; assert.equal(ent.questions, 15);
  delete process.env.BILLING_ENABLED;
  assert.equal((await sql(`select count(*)::int as n from audit_log where org_id = $1 and action = 'billing.limits_set'`, [org]))[0].n, 6);
  await sql(`update operators set role = 'support'`);
  assert.equal((await call("cs", "PUT", `/api/admin/console/customers/${slug}/limits`, { values: { questions: 99 }, reason: "test" })).status, 403, "support can't change limits");
  await sql(`update organizations set razorpay_subscription_id = null where id = $1`, [org]);
  assert.equal((await C("DELETE", `accounts/${slug}`, { confirm: slug, reason: "test" })).status, 200);
});

test("who is on a plan and what they pay; integrations show platform services without ever exposing a key", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const C = (m, p, b) => call("cb", m, "/api/admin/console/" + p, b);
  // Two accounts on Growth in a group of their own: one paying monthly in INR with 2 extra seats, one on an annual plan in USD.
  const a = (await C("POST", "accounts", { name: "Plan One Co", ownerEmail: "plan-one@x.co" })).data.account.slug, b = (await C("POST", "accounts", { name: "Plan Two Co", ownerEmail: "plan-two@x.co" })).data.account.slug;
  await sql(`update organizations set plan_code = 'growth', billing_status = 'active', billing_currency = 'INR', billing_cycle = 'monthly', extra_seats = 2, current_period_end = now() + interval '10 days' where slug = $1`, [a]);
  const { PLANS } = await import("../../server/plans.mjs");
  const seat = PLANS.growth.seatPrices?.INR ?? 0, usdYear = PLANS.growth.annualPrices?.USD ?? null;
  await sql(`update organizations set plan_code = 'growth', billing_status = 'active', billing_currency = 'USD', billing_cycle = $2, current_period_end = now() + interval '300 days' where slug = $1`, [b, usdYear ? "annual" : "monthly"]);
  const g = (await C("POST", "groups", { name: "Plan test", kind: "custom" })).data.group; await C("PATCH", `groups/${g.id}`, { add: [a, b] });
  const d = (await C("GET", `plans/growth/accounts?accounts=group:${g.id}`)).data;
  assert.equal(d.kpis.accounts, 2); assert.equal(d.kpis.paying, 2); assert.equal(d.kpis.viaContract, 2);
  const one = d.rows.find((r) => r.slug === a);
  assert.equal(one.recurring, 999900 + 2 * seat, "monthly price plus extra seats"); assert.equal(one.mrrInr, 999900 + 2 * seat);
  const two = d.rows.find((r) => r.slug === b);
  if (usdYear) { assert.equal(two.recurring, usdYear, "an annual account pays the yearly price"); assert.equal(two.mrrInr, Math.round(Math.round(usdYear / 12) * 84)); }
  else { assert.equal(two.recurring, PLANS.growth.prices.USD); assert.equal(two.mrrInr, PLANS.growth.prices.USD * 84, "USD at the console's rate"); }
  assert.equal(d.kpis.mrrInr, one.mrrInr + two.mrrInr); assert.equal(d.kpis.arrInr, d.kpis.mrrInr * 12);
  assert.equal((await C("GET", "plans/no-such-plan/accounts")).status, 404);
  // Integrations: platform services listed by state; a key's value never appears anywhere in the answer.
  const it = (await C("GET", "integrations")).data;
  assert.ok(it.platform.some((x) => x.key === "chatgpt" && x.state !== "off"), "OPENAI_API_KEY is set in the tests");
  assert.ok(it.platform.some((x) => x.key === "razorpay")); assert.ok(it.ownKeys && Array.isArray(it.ownKeys.byKey));
  const raw = JSON.stringify(it);
  for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "APP_SECRET", "CRON_SECRET"]) if (process.env[k] && process.env[k].length > 3) assert.ok(!raw.includes(process.env[k]) || ["fake", "test"].includes(process.env[k]), k);
  for (const s of [a, b]) await C("DELETE", `accounts/${s}`, { confirm: s, reason: "test" });
  await C("DELETE", `groups/${g.id}`);
});

test("filters: the Active brands card and its list agree; Growth's people and engagement follow the Accounts and Period filters", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const C = (p) => call("cb", "GET", "/api/admin/console/" + p);
  for (const q of ["accounts=all&days=30", "accounts=customers&days=7"]) {
    const card = (await C("pulse?" + q)).data.kpis.active7, list = (await C("customers-page?health=active&" + q)).data;
    assert.equal(list.kpis.matching, card, q); assert.ok(list.health.rows.every((r) => r.lastAction?.what === "Active"));
  }
  // An empty group: Growth shows nobody, whatever the platform has.
  const g = (await call("cb", "POST", "/api/admin/console/groups", { name: "Empty", kind: "custom" })).data.group;
  const a = (await C(`activity?accounts=group:${g.id}&days=90`)).data, e = (await C(`engagement?accounts=group:${g.id}`)).data;
  assert.equal(a.days, 90, "the Period filter sets the window"); assert.equal(a.now.users, 0); assert.equal(a.now.mau, 0); assert.equal(e.activation.orgs, 0); assert.deepEqual(e.adoption, []);
  assert.ok((await C("activity?accounts=all&days=90")).data.now.users > 0, "everyone, without the group");
  assert.equal((await C("activity?accounts=all&days=365")).data.days, 365);
  await call("cb", "DELETE", `/api/admin/console/groups/${g.id}`);
});

test("delete a user: shows what goes with them, refuses while they own a shared account or one paying by Razorpay, removes them everywhere", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const C = (m, p, b) => call("cb", m, "/api/admin/console/" + p, b);
  // A person with their own account (only them in it) who is also an editor in a shared one.
  const mine = (await C("POST", "accounts", { name: "Solo Co", ownerEmail: "solo-user@x.co" })).data;
  assert.equal((await call("su", "POST", "/api/auth/signup", { email: "solo-user@x.co", password: "longenough1", invite: mine.invite.link.split("#invite=")[1] }, { "x-forwarded-for": "10.21.0.1" })).status, 200);
  const shared = (await C("POST", "accounts", { name: "Shared Co", ownerEmail: "shared-owner@x.co" })).data;
  assert.equal((await call("so2", "POST", "/api/auth/signup", { email: "shared-owner@x.co", password: "longenough1", invite: shared.invite.link.split("#invite=")[1] }, { "x-forwarded-for": "10.21.0.2" })).status, 200);
  const inv = (await C("POST", `accounts/${shared.account.slug}/people`, { email: "solo-user@x.co", role: "editor" })).data.invite;
  assert.equal((await call("su", "POST", "/api/auth/login", { email: "solo-user@x.co", password: "longenough1", invite: inv.link.split("#invite=")[1] })).status, 200);
  const uid = (await sql(`select id from users where email = 'solo-user@x.co'`))[0].id, ownerId = (await sql(`select id from users where email = 'shared-owner@x.co'`))[0].id;

  let d = (await C("GET", `users/${uid}/deletion`)).data;
  assert.deepEqual(d.orgs.map((o) => [o.slug, o.deleted]).sort(), [[mine.account.slug, true], [shared.account.slug, false]].sort());
  assert.deepEqual(d.blockers, []);
  // The owner of a shared account can't go until they hand it over.
  d = (await C("GET", `users/${ownerId}/deletion`)).data; assert.equal(d.blockers.length, 1); assert.match(d.blockers[0], /hand ownership over/);
  assert.equal((await C("DELETE", `users/${ownerId}`, { confirm: "shared-owner@x.co", reason: "test" })).status, 409);
  // Their own account paying through Razorpay blocks it too.
  await sql(`update organizations set razorpay_subscription_id = 'sub_x', billing_status = 'active' where slug = $1`, [mine.account.slug]);
  assert.match((await C("GET", `users/${uid}/deletion`)).data.blockers.join(" "), /cancel its subscription/);
  await sql(`update organizations set razorpay_subscription_id = null, billing_status = 'new' where slug = $1`, [mine.account.slug]);
  // Typed email, reason, founders only.
  assert.equal((await C("DELETE", `users/${uid}`, { confirm: "wrong@x.co", reason: "test" })).data.code, "confirm");
  assert.equal((await C("DELETE", `users/${uid}`, { confirm: "solo-user@x.co" })).status, 400, "a reason is required");
  await sql(`update operators set role = 'support'`);
  assert.equal((await call("cs", "DELETE", `/api/admin/console/users/${uid}`, { confirm: "solo-user@x.co", reason: "test" })).status, 403);
  const me = (await C("GET", "me")).data; assert.match((await C("GET", `users/${me.id}/deletion`)).data.blockers.join(" "), /yourself/);
  const r = await C("DELETE", `users/${uid}`, { confirm: "solo-user@x.co", reason: "asked us to delete their data" });
  assert.equal(r.status, 200); assert.deepEqual(r.data.organisationsDeleted, [mine.account.slug]);
  assert.equal((await sql(`select count(*)::int as n from users where id = $1`, [uid]))[0].n, 0);
  assert.equal((await sql(`select count(*)::int as n from organizations where slug = $1`, [mine.account.slug]))[0].n, 0, "the account only they were in went with them");
  assert.deepEqual((await C("GET", `accounts/${shared.account.slug}/people`)).data.members.map((m) => m.email), ["shared-owner@x.co"], "the shared account stays, without them");
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'user.deleted' and target = 'solo-user@x.co'`))[0].n, 1);
  assert.equal((await C("DELETE", `accounts/${shared.account.slug}`, { confirm: shared.account.slug, reason: "test" })).status, 200);
});

test("console accounts: create with an owner invite, people CRUD, suspend makes it read-only, operators CRUD, delete", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const C = (m, p, b) => call("cb", m, "/api/admin/console/" + p, b);
  await sql(`update operators set role = 'analyst'`);
  assert.equal((await call("cs", "POST", "/api/admin/console/accounts", { name: "Nope Co", ownerEmail: "nope@x.co" })).status, 403, "analysts can't create accounts");
  let r = await C("POST", "accounts", { name: "Client Co", ownerEmail: "client-owner@x.co" });
  assert.equal(r.status, 200); const slug = r.data.account.slug, token = r.data.invite.link.split("#invite=")[1];
  assert.equal((await sql(`select count(*)::int as n from memberships m join organizations o on o.id = m.org_id where o.slug = $1`, [slug]))[0].n, 0, "no operator membership");
  assert.equal((await sql(`select billing_status from organizations where slug = $1`, [slug]))[0].billing_status, "new");
  assert.equal((await call("co", "POST", "/api/auth/signup", { email: "client-owner@x.co", password: "longenough1", invite: token }, { "x-forwarded-for": "10.9.9.11" })).status, 200);
  // The owner's organisation is waiting on a plan, but the team can still invite people into it.
  r = await C("POST", `accounts/${slug}/people`, { email: "client-mate@x.co", role: "editor" }); assert.equal(r.status, 200);
  assert.equal((await call("cm", "POST", "/api/auth/signup", { email: "client-mate@x.co", password: "longenough1", invite: r.data.invite.link.split("#invite=")[1] }, { "x-forwarded-for": "10.9.9.12" })).status, 200);
  let people = (await C("GET", `accounts/${slug}/people`)).data.members;
  const mate = people.find((m) => m.email === "client-mate@x.co"), own = people.find((m) => m.role === "owner");
  const seen = JSON.stringify((await call("cs", "GET", `/api/admin/console/customers/${slug}`)).data);
  assert.ok(!seen.includes("@") && !seen.includes("client-mate"), "analysts see no emails or people's names: " + (seen.match(/.{40}@.{20}/) || [""])[0]);
  // Support and finance can't hand out admin or owner, add themselves, lower an admin or owner, or make internal accounts.
  await sql(`update operators set role = 'support'`);
  const S = (m, p, b) => call("cs", m, "/api/admin/console/" + p, b);
  assert.equal((await S("POST", `accounts/${slug}/people`, { email: "helper@x.co", role: "admin" })).status, 403, "support can't grant admin");
  assert.equal((await S("POST", `accounts/${slug}/people`, { email: "console-user@x.co", role: "viewer" })).data.code, "self");
  assert.equal((await S("PATCH", `accounts/${slug}/people/${own.id}`, { role: "viewer" })).status, 403, "support can't lower the owner");
  assert.equal((await S("POST", "accounts", { name: "Inside Co", ownerEmail: "in@x.co", start: "internal" })).status, 403);
  await sql(`update operators set role = 'analyst'`);
  assert.equal((await C("PATCH", `accounts/${slug}/people/${own.id}`, { role: "viewer" })).status, 409, "owner can't be lowered without a hand-over");
  people = (await C("PATCH", `accounts/${slug}/people/${mate.id}`, { role: "owner" })).data.members;
  assert.equal(people.find((m) => m.id === mate.id).role, "owner"); assert.equal(people.find((m) => m.id === own.id).role, "admin");
  assert.equal((await C("DELETE", `accounts/${slug}/people/${mate.id}`)).status, 409, "the owner can't be removed");
  assert.equal((await C("DELETE", `accounts/${slug}/people/${own.id}`)).data.members.length, 1);
  // Suspension: read-only with its own message (not an upgrade prompt), and it holds even with billing switched off.
  await call("cb", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: "legacy", status: "internal", reason: "test" });
  assert.equal((await C("PATCH", `accounts/${slug}`, { suspended: true })).status, 400, "a reason is required");
  assert.equal((await C("PATCH", `accounts/${slug}`, { suspended: true, reason: "abuse report" })).status, 200);
  delete process.env.BILLING_ENABLED;
  r = await call("cm", "PUT", "/api/workspaces/blocked", { name: "Blocked", setup: WS.setup });
  assert.equal(r.status, 403); assert.equal(r.data.code, "suspended");
  assert.equal((await C("PATCH", `accounts/${slug}`, { suspended: false, reason: "resolved" })).status, 200);
  assert.equal((await call("cm", "PUT", "/api/workspaces/allowed", { name: "Allowed", setup: WS.setup })).status, 200);
  // Operators: add (must exist and be verified), change, turn off (loses access at once), remove; founders can't lock themselves out.
  assert.equal((await C("POST", "operators", { email: "ghost@x.co", role: "support" })).status, 404);
  assert.equal((await C("POST", "operators", { email: "client-mate@x.co", role: "support" })).status, 200);
  assert.equal((await call("cm", "GET", "/api/admin/console/me")).data.role, "support");
  const opId = (await C("GET", "operators")).data.operators.find((o) => o.email === "client-mate@x.co").id;
  assert.equal((await C("PATCH", `operators/${opId}`, { active: false })).status, 200);
  assert.equal((await call("cm", "GET", "/api/admin/console/me")).status, 404);
  assert.equal((await C("DELETE", `operators/${opId}`)).status, 200);
  const me = (await C("GET", "me")).data;
  assert.equal((await C("PATCH", `operators/${me.id}`, { active: false })).status, 409);
  // Delete: founders only, typed id, record kept.
  await sql(`update operators set role = 'finance', active = true`);
  assert.equal((await call("cs", "DELETE", `/api/admin/console/accounts/${slug}`, { confirm: slug, reason: "x y z" })).status, 403, "finance can't delete accounts");
  assert.equal((await C("DELETE", `accounts/${slug}`, { confirm: "nope", reason: "test" })).status, 400);
  // An unpaid Razorpay link must be withdrawn first, so nobody pays into a deleted organisation (no keys here to withdraw it).
  await sql(`update organizations set razorpay_checkout_subscription_id = 'sub_pending' where slug = $1`, [slug]);
  assert.equal((await C("DELETE", `accounts/${slug}`, { confirm: slug, reason: "test cleanup" })).data.code, "pending_link");
  await sql(`update organizations set razorpay_checkout_subscription_id = null where slug = $1`, [slug]);
  assert.equal((await C("DELETE", `accounts/${slug}`, { confirm: slug, reason: "test cleanup" })).status, 200);
  assert.equal((await C("GET", `customers/${slug}`)).status, 404);
  assert.equal((await sql(`select count(*)::int as n from audit_log where action = 'org.deleted' and target = $1`, [slug]))[0].n, 1);
  await sql(`update operators set role = 'support'`);
});

test("plan parameters: annual checkout and renewal, per-plan trial length, extra seats invoiced or billed through Razorpay", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const { setClient } = await import("../../server/razorpay.mjs");
  const SECRET = "wh_cycles", calls = [];
  setClient({ createSubscription: async (a) => { calls.push(["sub", a]); return { id: "sub_year" }; }, cancelSubscription: async () => ({}), fetchSubscription: async () => ({ status: "active", payment_method: "card" }),
    updateSubscription: async (id, a) => { calls.push(["update", a]); return {}; }, cancelScheduledChanges: async () => ({}), createAddon: async (id, a) => { calls.push(["addon", id, a]); return { id: "ao_" + calls.length }; }, deleteAddon: async (id) => { calls.push(["delete_addon", id]); return {}; } });
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: SECRET });
  await sql(`update operators set role = 'finance', active = true`);
  // Catalogue: Growth gets an annual price + yearly Razorpay plan, a 14-day trial, and extra seats at ₹500 up to 10; Starter has no trial.
  const plans = (await call("cs", "GET", "/api/admin/plans")).data.plans, g = plans.find((p) => p.code === "growth"), st = plans.find((p) => p.code === "starter");
  const up = (code, f, patch) => call("cs", "PUT", `/api/admin/plans/${code}`, { ...f, ...patch });
  assert.equal((await up("growth", g, { trialDays: 14, maxExtraSeats: 10, prices: { ...g.prices, INR: { ...g.prices.INR, razorpayPlanId: "plan_GrowMonth01", annualAmount: 9999000, annualRazorpayPlanId: "plan_GrowYear001", seatAmount: 50000 } } })).status, 200);
  assert.equal((await up("starter", st, { trialDays: 0, prices: { ...st.prices, INR: { ...st.prices.INR, razorpayPlanId: "plan_StarMonth1" } } })).status, 200);
  const pub = (await call("x", "GET", "/api/billing/plans")).data;
  const gp = pub.plans.find((p) => p.code === "growth");
  assert.equal(gp.annualPrices.INR, 9999000); assert.equal(gp.trialDays, 14); assert.equal(gp.seatPrices.INR, 50000); assert.equal(pub.availableAnnual.growth.INR, true);

  // Per-plan trial: no trial on Starter; Growth's 14 days stretch a 7-day trial from its start, never past what it should be.
  const sig = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  assert.equal((await call("x", "POST", "/api/auth/signup", { email: "cycles@x.co", password: "longenough1" }, { "x-forwarded-for": "10.9.9.20" })).status, 200);
  const me = (await call("x", "GET", "/api/me")).data, org = me.org.id, slug = me.org.slug;
  let o = (await sql(`select trial_started_at, trial_ends_at, billing_status from organizations where id = $1`, [org]))[0];
  assert.equal(o.billing_status, "trialing");
  assert.equal((await call("x", "POST", "/api/billing/start-trial", { plan: "starter" })).data.code, "no_trial");
  assert.equal((await call("x", "POST", "/api/billing/start-trial", { plan: "growth" })).status, 200);
  const after = (await sql(`select trial_ends_at from organizations where id = $1`, [org]))[0].trial_ends_at;
  assert.equal(Math.round((new Date(after) - new Date(o.trial_started_at)) / 864e5), 14, "stretched to Growth's 14 days");

  // Annual checkout: the yearly Razorpay plan, ten cycles; the webhook adopts it as annual; MRR counts a twelfth.
  await sql(`update organizations set trial_ends_at = now() - interval '1 minute', billing_status = 'trialing' where id = $1`, [org]);
  let r = await call("x", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR", cycle: "annual" });
  assert.equal(r.status, 200); assert.equal(r.data.cycle, "annual"); assert.equal(r.data.amount, Math.round(9999000 * 1.18)); assert.equal(r.data.upi, false, "yearly payments are above UPI's limit");
  const subCall = calls.find((x) => x[0] === "sub")[1]; assert.equal(subCall.planId, "plan_GrowYear001"); assert.equal(subCall.cycle, "annual");
  assert.equal((await call("x", "POST", "/api/billing/checkout", { plan: "starter", currency: "INR", cycle: "annual" })).data.code, "no_annual");
  const T = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ event: "subscription.charged", created_at: T + 5, payload: { subscription: { entity: { id: "sub_year", plan_id: "plan_GrowYear001", status: "active", current_start: T, current_end: T + 365 * 86400 } } } });
  assert.equal((await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "evt_year_1", "x-razorpay-signature": sig(raw) }, body: raw })).status, 200);
  o = (await sql(`select plan_code, billing_status, billing_cycle from organizations where id = $1`, [org]))[0];
  assert.deepEqual({ ...o }, { plan_code: "growth", billing_status: "active", billing_cycle: "annual" });
  const sub = (await call("cb", "GET", `/api/admin/console/customers/${slug}`)).data.subscription;
  assert.equal(sub.cycleKey, "annual"); assert.equal(sub.price, 9999000); assert.equal(sub.monthly, 833250);
  assert.equal((await call("x", "GET", "/api/me")).data.billing.plan.cycle, "annual");

  // Extra seats: capped by the plan; invoiced ones only raise the limit; Razorpay ones go on the next invoice and again at each renewal.
  const seats = (b) => call("cs", "POST", `/api/admin/console/customers/${slug}/seats`, { reason: "agreed", ...b });
  assert.equal((await seats({ extraSeats: 11 })).data.code, "seat_cap");
  const before = (await call("x", "GET", "/api/me")).data.billing.limits.seats;
  r = await seats({ extraSeats: 3 }); assert.equal(r.status, 200); assert.equal(r.data.charged, null);
  assert.equal((await call("x", "GET", "/api/me")).data.billing.limits.seats, before + 3);
  r = await seats({ extraSeats: 5, billing: "razorpay" });
  assert.equal(r.data.charged.seats, 2, "only the added seats are charged for this cycle"); assert.equal(r.data.charged.months, 12);
  assert.equal(calls.at(-1)[0], "addon"); assert.equal(calls.at(-1)[2].amount, Math.round(50000 * 2 * 12 * 1.18));
  const renew = JSON.stringify({ event: "subscription.charged", created_at: T + 50, payload: { subscription: { entity: { id: "sub_year", plan_id: "plan_GrowYear001", status: "active", current_start: T + 365 * 86400, current_end: T + 730 * 86400 } } } });
  await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "evt_year_2", "x-razorpay-signature": sig(renew) }, body: renew });
  assert.equal(calls.at(-1)[2].amount, Math.round(50000 * 5 * 12 * 1.18), "renewal bills all 5 seats for the next year");
  const n = calls.filter((x) => x[0] === "addon").length;
  await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": "evt_year_2", "x-razorpay-signature": sig(renew) }, body: renew });
  assert.equal(calls.filter((x) => x[0] === "addon").length, n, "a repeated webhook doesn't charge twice");
  const cust = (await call("cb", "GET", "/api/admin/console/customers")).data.orgs.find((x) => x.slug === slug);
  assert.equal(cust.mrr, 833250 + 5 * 50000, "MRR: a twelfth of the year plus the seats");
  // Seats added mid-cycle pay only for what is left of it; lowering them withdraws that not-yet-invoiced add-on, not the renewal's.
  await sql(`update organizations set current_period_end = now() + interval '6 months' where id = $1`, [org]);
  r = await seats({ extraSeats: 7, billing: "razorpay" });
  const full = 50000 * 2 * 12, half = r.data.charged.amount / 1.18;
  assert.ok(half > full * 0.45 && half < full * 0.55, `about half a year for 2 seats, got ${half} of ${full}`);
  const raiseId = (await sql(`select detail->>'addonId' as id from audit_log where org_id = $1 and action = 'billing.seats_charged' order by id desc limit 1`, [org]))[0].id;
  r = await seats({ extraSeats: 5, billing: "razorpay" });
  assert.equal(r.data.withdrawn.withdrawn, 2); assert.equal(r.data.withdrawn.recharged, null);
  assert.deepEqual(calls.at(-1), ["delete_addon", raiseId], "the mid-cycle raise is withdrawn");
  assert.equal(calls.filter((x) => x[0] === "delete_addon").length, 1, "the renewal's add-on is left alone");
  // A plan change keeps the yearly cycle.
  const ag = plans.find((p) => p.code === "agency");
  await up("agency", ag, { prices: { ...ag.prices, INR: { ...ag.prices.INR, razorpayPlanId: "plan_AgenMonth1", annualAmount: 24999000, annualRazorpayPlanId: "plan_AgenYear01" } } });
  r = await call("cs", "POST", `/api/admin/console/customers/${slug}/change-plan`, { plan: "agency", reason: "more brands" });
  assert.equal(r.status, 200); assert.equal(calls.at(-1)[1].planId, "plan_AgenYear01");
  // Clean up the catalogue for the tests after this one.
  await up("growth", g, {}); await up("starter", st, {}); await up("agency", ag, {});
  setClient(null);
  for (const k of ["BILLING_ENABLED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) delete process.env[k];
  await sql(`update operators set role = 'support'`);
});

test("upgrading from a trial is immediate; one-month payment links activate a plan, stack, reset usage and stay out of MRR", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  const crypto = await import("node:crypto");
  const { setClient } = await import("../../server/razorpay.mjs");
  const { PLANS, withTax } = await import("../../server/plans.mjs");
  const SECRET = "wh_onetime", calls = []; let linkStatus = "created";
  setClient({ createSubscription: async (a) => { calls.push(["sub", a]); return { id: "sub_now_" + calls.length }; }, cancelSubscription: async (id) => { calls.push(["cancel_sub", id]); return {}; },
    fetchSubscription: async () => ({ status: "created" }), createPaymentLink: async (a) => { calls.push(["plink", a]); return { id: "plink_" + calls.length, short_url: "https://rzp.io/l/t" + calls.length }; },
    fetchPaymentLink: async () => ({ status: linkStatus }), cancelPaymentLink: async (id) => { calls.push(["cancel_link", id]); return {}; } });
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "sk", RAZORPAY_WEBHOOK_SECRET: SECRET });
  await sql(`update operators set role = 'finance', active = true`);
  const plans = (await call("cs", "GET", "/api/admin/plans")).data.plans, g = plans.find((p) => p.code === "growth");
  await call("cs", "PUT", "/api/admin/plans/growth", { ...g, prices: { ...g.prices, INR: { ...g.prices.INR, razorpayPlanId: "plan_GrowNow001" } } });
  const sig = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  const hook = (id, body) => { const raw = JSON.stringify(body); return fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-event-id": id, "x-razorpay-signature": sig(raw) }, body: raw }); };
  const T = Math.floor(Date.now() / 1000);
  const signup = async (who, email, ip) => { assert.equal((await call(who, "POST", "/api/auth/signup", { email, password: "longenough1" }, { "x-forwarded-for": ip })).status, 200); const me = (await call(who, "GET", "/api/me")).data; return { id: me.org.id, slug: me.org.slug }; };

  // Self-serve: buying during a running trial charges now (no start_at); the card's authorisation alone changes nothing, the charge does.
  const a = await signup("ua", "upgrade-now@x.co", "10.9.9.40");
  let r = await call("ua", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" });
  assert.equal(r.status, 200); assert.equal(calls.at(-1)[0], "sub"); assert.equal(calls.at(-1)[1].startAt, null, "no deferred start during the trial"); assert.equal(r.data.startsAt ?? null, null);
  const sid = calls.at(-1)[1] && (await sql(`select razorpay_checkout_subscription_id as s from organizations where id = $1`, [a.id]))[0].s;
  const subEvt = (event, extra = {}) => ({ event, created_at: T + 1, payload: { subscription: { entity: { id: sid, plan_id: "plan_GrowNow001", status: "active", current_start: T, current_end: T + 30 * 86400, notes: { white_petal_org_id: a.id }, ...extra } } } });
  await hook("evt_now_auth", subEvt("subscription.authenticated", { status: "authenticated", start_at: T }));
  assert.equal((await sql(`select billing_status from organizations where id = $1`, [a.id]))[0].billing_status, "trialing", "authorised only: still on the trial");
  await hook("evt_now_charged", subEvt("subscription.charged"));
  let bl = (await call("ua", "GET", "/api/me")).data.billing;
  assert.deepEqual([bl.plan.status, bl.plan.code, bl.limits.questions], ["active", "growth", PLANS.growth.entitlements.questions], "the plan and its limits start at once");

  // Console subscription link during a trial: also charged at once.
  const c = await signup("uc", "link-now@x.co", "10.9.9.41");
  r = await call("cs", "POST", `/api/admin/console/customers/${c.slug}/subscription`, { plan: "growth", currency: "INR", reason: "agreed on a call" });
  assert.equal(r.status, 200); assert.equal(calls.at(-1)[1].startAt, null); assert.equal(r.data.startsAt, null);

  // One month, paid once.
  const o = await signup("uo", "one-time@x.co", "10.9.9.42");
  assert.equal((await call("uo", "PUT", "/api/workspaces/once", { name: "once", setup: { profile: { name: "once", competitors: [] }, questions: [{ text: "q", on: true }] } })).status, 200);
  await sql(`insert into runs (id, workspace_id, status, started_at, finished_at, updated_at) select 'run_before_pay', id, 'done', now(), now(), now() from workspaces where org_id = $1`, [o.id]);
  assert.equal((await call("uo", "GET", "/api/me")).data.billing.used.checks, 1, "the trial's check is used");
  assert.equal((await call("cs", "POST", `/api/admin/console/customers/${o.slug}/one-time`, { plan: "starter", currency: "INR" })).status, 400, "a reason is required");
  r = await call("cs", "POST", `/api/admin/console/customers/${o.slug}/one-time`, { plan: "starter", currency: "INR", reason: "pays by link" });
  assert.equal(r.status, 200); const link1 = r.data.linkId;
  assert.equal(calls.at(-1)[1].amount, withTax(PLANS.starter.prices.INR, "INR"), "the catalogue's monthly price with tax"); assert.equal(calls.at(-1)[1].email, "one-time@x.co");
  r = await call("cs", "POST", `/api/admin/console/customers/${o.slug}/one-time`, { plan: "starter", currency: "INR", reason: "sent again" });
  const link2 = r.data.linkId; assert.deepEqual(calls.at(-2), ["cancel_link", link1], "a new link cancels the unpaid one");
  assert.equal((await sql(`select status from payment_links where id = $1`, [link1]))[0].status, "cancelled");
  const paid = (id, link, amount) => hook(id, { event: "payment_link.paid", created_at: T + 5, payload: { payment_link: { entity: { id: link, status: "paid", amount, amount_paid: amount, notes: { white_petal_org_id: o.id } } }, payment: { entity: { id: "pay_" + id, amount } } } });
  const amt = withTax(PLANS.starter.prices.INR, "INR");
  await paid("evt_short", link2, amt - 100);
  assert.equal((await sql(`select billing_status from organizations where id = $1`, [o.id]))[0].billing_status, "trialing", "paid less: ignored");
  assert.equal((await sql(`select status from billing_events where event_id = 'evt_short'`))[0].status, "ignored");
  await paid("evt_paid", link2, amt);
  let row = (await sql(`select billing_status, plan_code, razorpay_subscription_id, current_period_start, current_period_end from organizations where id = $1`, [o.id]))[0];
  assert.deepEqual([row.billing_status, row.plan_code, row.razorpay_subscription_id], ["active", "starter", null]);
  const days = (new Date(row.current_period_end) - new Date(row.current_period_start)) / 864e5; assert.ok(days >= 28 && days <= 31, `one month, got ${days}`);
  bl = (await call("uo", "GET", "/api/me")).data.billing;
  assert.equal(bl.plan.oneTime, true); assert.equal(bl.mode, "write"); assert.equal(bl.used.checks, 0, "usage counts from the new period");
  assert.equal(bl.limits.questions, PLANS.starter.entitlements.questions, "Starter's limits, not the trial's");
  await paid("evt_paid", link2, amt); // a repeated delivery
  assert.equal((await sql(`select count(*)::int as n from audit_log where org_id = $1 and action = 'billing.onetime_paid'`, [o.id]))[0].n, 1, "applied once");
  let cust = (await call("cb", "GET", "/api/admin/console/customers")).data.orgs.find((x) => x.slug === o.slug);
  assert.equal(cust.mrr, 0, "a one-time month is not MRR");
  assert.equal((await call("cb", "GET", "/api/admin/console/revenue")).data.oneTime.count >= 1, true);
  // Paying another month adds to the running one.
  r = await call("cs", "POST", `/api/admin/console/customers/${o.slug}/one-time`, { plan: "starter", currency: "INR", reason: "second month" });
  await paid("evt_paid_2", r.data.linkId, amt);
  const row2 = (await sql(`select current_period_start, current_period_end from organizations where id = $1`, [o.id]))[0];
  assert.equal(String(row2.current_period_start), String(row.current_period_start), "same period start: counters aren't reset mid-month");
  assert.ok((new Date(row2.current_period_end) - new Date(row.current_period_end)) / 864e5 >= 28, "a second month after the first");
  // When the paid month is over: read-only, no renewal.
  await sql(`update organizations set current_period_end = now() - interval '1 minute' where id = $1`, [o.id]);
  assert.equal((await call("uo", "GET", "/api/me")).data.billing.mode, "read");
  // Not while a subscription is live; an open link is cancelled when the organisation is deleted.
  await sql(`update organizations set razorpay_subscription_id = 'sub_live', billing_status = 'active' where id = $1`, [a.id]);
  assert.equal((await call("cs", "POST", `/api/admin/console/customers/${a.slug}/one-time`, { plan: "starter", currency: "INR", reason: "x y z" })).data.code, "has_subscription");
  r = await call("cs", "POST", `/api/admin/console/customers/${c.slug}/one-time`, { plan: "starter", currency: "INR", reason: "then deleted" });
  assert.equal(calls.filter((x) => x[0] === "cancel_sub").length >= 1, true, "the open subscription link was withdrawn for the one-time link");
  await sql(`update operators set role = 'founder'`);
  assert.equal((await call("cs", "DELETE", `/api/admin/console/accounts/${c.slug}`, { confirm: c.slug, reason: "test cleanup" })).status, 200);
  assert.deepEqual(calls.at(-1), ["cancel_link", r.data.linkId], "deleting the organisation cancels its unpaid link");

  await call("cs", "PUT", "/api/admin/plans/growth", g);
  setClient(null);
  for (const k of ["BILLING_ENABLED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) delete process.env[k];
  await sql(`update operators set role = 'support'`);
});
