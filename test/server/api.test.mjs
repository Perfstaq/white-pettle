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
  await sql(`insert into usage (org_id, kind, engine, cost_usd) values ($1, 'ask', 'chatgpt', 1.5)`, [org.id]);
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
  assert.equal((await call("m1", "POST", "/api/write", { kind: "chat", data: { question: big } })).status, 413);
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
