// JSON API for accounts, organisations, brands (workspaces), runs, integrations and the scheduler.
// The AI routes (ask, site, write, inspect) are the original api/*.js handlers; server/app.mjs mounts both.
//
// Every brand belongs to an organisation. A request works in the session's current organisation, and each route
// names the lowest role it needs (viewer < editor < admin < owner; see server/orgs.mjs).
import { q, one, hasDb, tx } from "./db.mjs";
import { hashPassword, verifyPassword, newToken, tokenId, randomId, seal, unseal, limited, safeEqual } from "./security.mjs";
import { fail, sendJson, redirect, readJson, cookies, cookie, clientIp, origin } from "./http.mjs";
import { listMeta, getProvider, secretFields } from "./integrations/index.mjs";
import * as google from "./integrations/google.mjs";
import * as serp from "./integrations/serp.mjs";
import * as entity from "./integrations/entity.mjs";
import * as slack from "./integrations/slack.mjs";
import { serpConfig, env, engines as availableEngines } from "../api/_lib.js";
import { summarize, hostOf, changesBetween, norm, finished } from "./metrics.mjs";
import { recheck, checkType } from "./recheck.mjs";
import { runCheck } from "./runner.mjs";
import { serpWhere } from "../api/ask.js";
import { countryByCode, localePath } from "../api/_markets.js";
import { slugify, emailOk, normEmail } from "./util.mjs";
import * as O from "./orgs.mjs";
import * as B from "./billing.mjs";
import { makeBillingRoutes, reconcile } from "./billing-routes.mjs";
import { makeConsoleRoutes } from "./console-routes.mjs";
import * as N from "./notify.mjs";
import { billingConfig } from "./razorpay.mjs";
import { PLANS, LIMIT_METRICS } from "./plans.mjs";
import * as mail from "./mail.mjs";

const SESSION = "wp_session";
const GSTATE = "wp_gstate";
const DAY = 864e5;
// When the next scheduled check is due. Without a chosen time: one period after `from`, as always. With one (`at`: { dow 0-6,
// hour 0-23, tz }): the first such slot, on the hour in the brand's own time zone, at least a day (weekly) or an hour (daily)
// after `from`, so a check that just ran isn't repeated straight away. Quarter-hour steps find :30 and :45 time zones.
const TZ_FMT = new Map();
const localParts = (d, tz) => {
  let f = TZ_FMT.get(tz); if (!f) TZ_FMT.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })));
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), hour: Number(p.hour) % 24, minute: Number(p.minute) };
};
export const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); return true; } catch { return false; } };
export function nextRun(schedule, from = Date.now(), at = {}) {
  if (schedule !== "daily" && schedule !== "weekly") return null;
  const from0 = new Date(from).getTime();
  if (at.hour == null && at.dow == null) return new Date(from0 + (schedule === "daily" ? DAY : 7 * DAY));
  const tz = at.tz && validTz(at.tz) ? at.tz : "UTC", hour = at.hour ?? 9, dow = schedule === "weekly" ? at.dow ?? null : null;
  const Q = 15 * 60000; let t = Math.ceil((from0 + (schedule === "weekly" ? DAY : 3600e3)) / Q) * Q;
  for (let i = 0; i < 9 * 96; i++, t += Q) { const p = localParts(new Date(t), tz); if (p.minute === 0 && p.hour === hour && (dow == null || p.dow === dow)) return new Date(t); }
  return new Date(from0 + (schedule === "daily" ? DAY : 7 * DAY));
}
const runAt = (w) => ({ dow: w.run_dow, hour: w.run_hour, tz: w.run_tz });
// Self-serve (BILLING_ENABLED=1): anyone may sign up; a new personal organisation chooses a plan first, which starts the trial.
export const selfServe = () => billingConfig().enabled === "1";
async function newPersonalOrg(u) {
  const org = await O.createOrg({ name: personalOrgName(u), by: u.id, allowPlatformKeys: platformKeysForSignups() });
  if (selfServe()) { // the free trial starts at sign-up
    const ends = await B.startDefaultTrial(org.id, u.id, billingConfig().trialDays);
    if (ends) void N.notify(org.id, "trial_started", "trial", { plan: "trial", ends });
  }
  return org;
}
const personalOrgName = (u) => `${(u.name || "").trim() || u.email.split("@")[0]}'s brands`;
const platformKeysForSignups = () => process.env.PLATFORM_KEYS_FOR_SIGNUPS !== "0";

// ── sessions and context ────────────────────────────────────────────────────
export async function currentUser(req) {
  if (!hasDb()) return null;
  const t = cookies(req)[SESSION]; if (!t) return null;
  return one(`select u.id, u.email, u.name, u.email_verified_at, s.id as sid, s.org_id as session_org from sessions s join users u on u.id = s.user_id where s.id = $1 and s.expires_at > now()`, [tokenId(t)]);
}
async function startSession(req, userId, orgId = null) {
  const t = newToken();
  await q(`insert into sessions (id, user_id, org_id, expires_at) values ($1, $2, $3, now() + interval '30 days')`, [tokenId(t), userId, orgId]);
  await q(`delete from sessions where user_id = $1 and expires_at < now()`, [userId]);
  return cookie(req, SESSION, t, { maxAge: 30 * 86400 });
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, verified: !!u.email_verified_at });
async function needUser(req) { const u = await currentUser(req); if (!u) fail(401, "Please sign in.", { code: "auth" }); return u; }
export async function needCtx(req, min = "viewer") {
  const ctx = await O.context(await needUser(req));
  if (!ctx.org) fail(403, "You're not in an organisation yet. Ask an admin to invite you.", { code: "no_org" });
  O.needRole(ctx, min);
  return ctx;
}
async function needWorkspace(ctx, slug, min = "viewer") {
  O.needRole(ctx, min);
  const w = await one(`select * from workspaces where org_id = $1 and slug = $2`, [ctx.org.id, slug]);
  if (!w) fail(404, "That brand doesn't exist in this organisation.");
  return w;
}
const setSessionOrg = (u, orgId) => q(`update sessions set org_id = $2 where id = $1`, [u.sid, orgId]);
async function meOut(u) {
  const ctx = await O.context(u);
  const cap = ctx.org ? await O.capState(ctx.org.id) : null;
  return { user: publicUser(u), operator: ctx.operator, org: O.orgOut(ctx), orgs: ctx.orgs.map((o) => ({ slug: o.slug, name: o.name, role: o.role })),
    budget: cap ? { warn: cap.warn, over: cap.over, pct: cap.pct, source: cap.source } : null, billing: ctx.org ? await B.billingSummary(ctx.org.id) : null };
}
const wsOut = (w, extra = {}) => ({ slug: w.slug, name: w.name, site: w.site, schedule: w.schedule, samples: w.samples, nextRunAt: w.next_run_at, lastRunAt: w.last_run_at, running: !!w.running_at && Date.now() - new Date(w.running_at) < 40 * 60000, createdAt: w.created_at, updatedAt: w.updated_at,
  parent: w.parent_slug || null, market: w.market || null, runDow: w.run_dow ?? null, runHour: w.run_hour ?? null, runTz: w.run_tz || null, ...extra });
const withParent = async (w) => (w.parent_id && !w.parent_slug ? { ...w, parent_slug: (await one(`select slug from workspaces where id = $1`, [w.parent_id]))?.slug || null } : w);
// A market as the browser sends it: { code: "IN", path: "/in" }. The name comes from the code, so it is always a real country.
function marketIn(m) {
  if (m == null || m === "") return null;
  const c = countryByCode(m?.code); if (!c) fail(400, "That market isn't a country we know (send its two-letter code, like IN).");
  return { code: c.code, name: c.name, path: localePath(m.path || "") || null };
}

// Who may spend AI credits. With a database: a member with at least `min` (editor by default), inside the monthly
// budget; the request then runs on the organisation's keys (see app.mjs). Without one: the access code, as before.
// A request from this same machine to a dev server (npm run dev) is the owner testing: no access code needed.
export function isLocalDev(req) {
  if (process.env.NODE_ENV === "production" || req.headers["x-forwarded-for"]) return false;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
}
// Two steps, so the AI routes can check who is asking before reading a (possibly large) body:
// aiAuth (signed in, or the access code without a database), then aiAllow (role, budget, which brand).
export async function aiAuth(req) {
  if (!hasDb()) {
    if (process.env.ACCESS_CODE && !isLocalDev(req) && req.headers["x-access-code"] !== process.env.ACCESS_CODE) fail(401, "Access code required", { code: "access" });
    return null;
  }
  return needCtx(req, "viewer");
}
export async function aiAllow(ctx, req, min = "editor") {
  if (!ctx) return null;
  O.needRole(ctx, min);
  await B.needWrite(ctx.org.id);
  await O.needBudget(ctx.org.id);
  const slug = String(req.headers["x-wp-brand"] || "").slice(0, 60);
  ctx.workspaceId = slug ? (await one(`select id from workspaces where org_id = $1 and slug = $2`, [ctx.org.id, slug]))?.id || null : null;
  return ctx;
}
export async function aiContext(req, min = "editor") { return aiAllow(await aiAuth(req), req, min); }
export const gate = (req) => aiContext(req, "editor");

// ── one-time email links (password reset, email verification) ─────────────────
async function emailLink(req, user, purpose) {
  const t = newToken();
  await q(`insert into user_tokens (token_hash, user_id, purpose, expires_at) values ($1, $2, $3, now() + $4::interval)`, [tokenId(t), user.id, purpose, purpose === "reset" ? "1 hour" : "3 days"]);
  const link = `${origin(req)}/#${purpose}=${t}`;
  return purpose === "reset" ? mail.resetEmail({ to: user.email, link }) : mail.verifyEmail({ to: user.email, link });
}
async function useToken(token, purpose) {
  const r = await one(`update user_tokens set used_at = now() where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now() returning user_id`, [tokenId(String(token || "")), purpose]);
  if (r) await q(`update user_tokens set used_at = now() where user_id = $1 and purpose = $2 and used_at is null`, [r.user_id, purpose]); // older links die too
  return r?.user_id || null;
}

// ── invitations ─────────────────────────────────────────────────────────────
async function sendInvite(req, by, org, email, role) {
  const { invite, token } = await O.createInvite({ orgId: org.id, email, role, by: by.id });
  const link = `${origin(req)}/#invite=${token}`;
  const r = await mail.inviteEmail({ to: email, orgName: org.name, role, inviter: by.name || by.email, link });
  await O.audit(org.id, by.id, "invite.sent", email, { role, emailed: r.sent });
  // The link goes back to the admin too, so an invite still works before email is set up (or lands in spam).
  return { ...invite, link, emailed: r.sent };
}

// ── integrations helpers ────────────────────────────────────────────────────
async function integrationCfg(ws, provider) {
  const row = await one(`select * from integrations where workspace_id = $1 and provider = $2`, [ws.id, provider]);
  if (!row) return null;
  const cfg = { ...(row.config || {}), ...unseal(row.secret) };
  if (provider === "google") Object.assign(cfg, { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET });
  return { row, cfg };
}
async function saveIntegration(ws, provider, cfg, patch = {}) {
  const secretKeys = new Set([...secretFields(provider), "accessToken", "refreshToken"]);
  const pub = {}, sec = {};
  for (const [k, v] of Object.entries(cfg)) { if (["clientId", "clientSecret"].includes(k) || v == null || v === "") continue; (secretKeys.has(k) ? sec : pub)[k] = v; }
  await q(`insert into integrations (workspace_id, provider, config, secret, status, detail, data, collected_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, now())
           on conflict (workspace_id, provider) do update set config = excluded.config, secret = excluded.secret,
             status = coalesce($5, integrations.status), detail = coalesce($6, integrations.detail),
             data = coalesce($7, integrations.data), collected_at = coalesce($8, integrations.collected_at), updated_at = now()`,
    [ws.id, provider, pub, seal(sec), patch.status || null, patch.detail ?? null, patch.data ?? null, patch.collectedAt || null]);
}
function ctxFor(ws, extra = {}) {
  const s = ws.setup || {}, p = s.profile || {};
  const site = ws.site || p.site || "";
  return { site, host: hostOf(site), brand: ws.name, competitors: p.competitors || [], queries: (s.questions || []).filter((x) => x.on !== false).map((x) => x.text), urls: (s.audit?.pages || []).map((x) => x.url), orgSchema: s.orgSchema, ...extra };
}
async function collectOne(ws, provider) {
  const got = await integrationCfg(ws, provider); if (!got) fail(404, "Not connected.");
  const mod = getProvider(provider);
  const ctx = ctxFor(ws, { onToken: async (t) => { Object.assign(got.cfg, t); await saveIntegration(ws, provider, got.cfg); } });
  try {
    const data = await mod.collect(got.cfg, ctx);
    await saveIntegration(ws, provider, got.cfg, { status: "connected", detail: "", data, collectedAt: new Date() });
    return data;
  } catch (e) {
    await saveIntegration(ws, provider, got.cfg, { status: "error", detail: String(e.message || e).slice(0, 300) });
    throw e;
  }
}
async function integrationsFor(ws) {
  const rows = await q(`select provider, config, status, detail, data, collected_at, updated_at from integrations where workspace_id = $1`, [ws.id]);
  const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
  return listMeta().filter((m) => m.id !== "serp").map((m) => {
    const r = by[m.id];
    return { ...m, connected: !!r, status: r?.status || null, detail: r?.detail || null, config: r?.config || {}, data: r?.data || null, collectedAt: r?.collected_at || null,
      available: m.id !== "google" || !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) };
  });
}

// ── scheduled checks ────────────────────────────────────────────────────────
// One tick: claim due brands one at a time (FOR UPDATE SKIP LOCKED, so overlapping ticks never double-run one),
// run each on its organisation's keys, save, refresh connected tools, alert. Stops claiming new work with ~5
// minutes left of the budget, because Cloud Scheduler gives up on an HTTP target after 30 minutes.
export async function tick({ budgetMs = 25 * 60000, log = console.log } = {}) {
  const until = Date.now() + budgetMs, done = [];
  // Billing drift first: a small batch, each subscription at most once a day.
  await reconcile({ limit: 20, log }).catch((e) => log(`[reconcile] ${e.message}`));
  await N.trialSweep().catch((e) => log(`[notify] ${e.message}`)); // trial ending soon / ended emails
  while (Date.now() < until - 5 * 60000) {
    const ws = await one(`update workspaces set running_at = now()
      where id = (select id from workspaces where next_run_at <= now() and (running_at is null or running_at < now() - interval '45 minutes')
                  order by next_run_at limit 1 for update skip locked)
      returning *`);
    if (!ws) break;
    const budget = await O.capState(ws.org_id);
    if (budget.over) {
      log(`[tick ${ws.slug}] skipped: monthly AI budget reached`);
      await q(`update workspaces set running_at = null, next_run_at = now() + interval '1 day' where id = $1`, [ws.id]);
      await O.audit(ws.org_id, null, "check.skipped", ws.name, { reason: "monthly AI budget reached", spent: budget.spent, cap: budget.cap });
      continue;
    }
    // Unattended spend needs a paid-up plan that includes this schedule; otherwise look again tomorrow.
    const bs = await B.billingState(ws.org_id, { usage: "checks" });
    const noChecks = bs.ent.checks !== Infinity && bs.used.checks >= bs.ent.checks;
    if (bs.mode !== "write" || !bs.ent.schedule.includes(ws.schedule) || noChecks) {
      log(`[tick ${ws.slug}] skipped: plan`);
      await q(`update workspaces set running_at = null, next_run_at = now() + interval '1 day' where id = $1`, [ws.id]);
      await O.audit(ws.org_id, null, "check.skipped", ws.name, { reason: bs.mode !== "write" ? "billing " + bs.org.billing_status : noChecks ? "no checks left" : "schedule not in plan", plan: bs.org.plan_code });
      continue;
    }
    const prev = await one(`select data from runs where workspace_id = $1 and status = 'done' order by started_at desc limit 1`, [ws.id]);
    const prevSummary = prev?.data ? summarize(prev.data) : null;
    let M = null, err = null;
    try {
      const keys = O.envFor(await O.orgKeys(ws.org_id));
      // Stop asking once this run's estimated cost would pass what's left of the monthly budget.
      const budgetUsd = budget.cap == null ? null : Math.max(0, budget.cap - budget.spent);
      M = await O.withEnv(keys, () => runCheck(ws, { prev: prev?.data, deadline: until - 60000, budgetUsd, pages: Number.isFinite(bs.ent.pages) ? bs.ent.pages : null, engines: availableEngines().filter((e) => bs.ent.engines.includes(e)), costOf: O.costOf, log: (m) => log(`[tick ${ws.slug}] ${m}`) }));
    } catch (e) { err = String(e.message || e); log(`[tick ${ws.slug}] failed: ${err}`); }
    if (M) {
      const s = summarize(M);
      await q(`insert into runs (id, workspace_id, source, status, started_at, finished_at, summary, data) values ($1, $2, 'scheduled', 'done', to_timestamp($3 / 1000.0), now(), $4, $5)`, [M.id, ws.id, M.startedAt, s, M]);
      await meterRun(ws, M);
      // The site was read again for this check: keep that reading as the brand's current one (integrations use its pages).
      if (M.audit && !M.audit.stale) await q(`update workspaces set setup = jsonb_set(setup, '{audit}', $2::jsonb) where id = $1`, [ws.id, JSON.stringify(M.audit)]).catch(() => {});
      for (const p of ["google", "bing", "cloudflare", "entity"]) { if (await one(`select 1 from integrations where workspace_id = $1 and provider = $2`, [ws.id, p])) await collectOne(ws, p).catch(() => {}); }
      const fixes = await recheckOpenFixes(ws, M).catch((e) => { log(`[tick ${ws.slug}] rechecks: ${e.message}`); return []; });
      const observed = await observeDueResults(ws, M).catch((e) => { log(`[tick ${ws.slug}] results: ${e.message}`); return []; });
      const report = { brand: brandLabel(ws), slug: ws.slug, schedule: ws.schedule, s, prev: prevSummary, changes: changesBetween(prev?.data || null, M), fixes, observed };
      await notifySlack(ws, report).catch(() => {});
      await N.notify(ws.org_id, "weekly_results", M.id, report, { admins: true });
      done.push({ slug: ws.slug, visibility: s.visibility, score: s.score, fixesVerified: fixes.filter((f) => f.pass).length, resultsObserved: observed.length });
    }
    await q(`update workspaces set running_at = null, last_run_at = case when $2 then now() else last_run_at end, next_run_at = $3, updated_at = now() where id = $1`,
      [ws.id, !!M, nextRun(ws.schedule, Date.now(), runAt(ws)) || null]);
    if (err) await q(`insert into runs (id, workspace_id, source, status, error, finished_at) values ($1, $2, 'scheduled', 'failed', $3, now())`, [randomId(9), ws.id, err]);
  }
  return done;
}
// A scheduled run calls the engines in-process, so its usage is counted from the finished run.
async function meterRun(ws, M) {
  const by = {}; for (const a of Object.values(M.answers || {})) by[a.engine] = (by[a.engine] || 0) + 1;
  const base = { orgId: ws.org_id, workspaceId: ws.id };
  for (const [engine, n] of Object.entries(by)) await O.meter({ ...base, kind: "ask", engine, n });
  if (M.perception) await O.meter({ ...base, kind: "ask", engine: M.engines.find((e) => !["aio", "aimode"].includes(e)) || M.engines[0], n: 2 });
  await O.meter({ ...base, kind: "inspect", n: Object.keys(M.inspections || {}).length });
  await O.meter({ ...base, kind: "write", n: 3 });
}
// "MeShopCheap" for a brand tracked once; "MeShopCheap (India)" for one of its markets, so reports for each country are told apart.
const brandLabel = (ws) => (ws.market?.name ? `${ws.name} (${ws.market.name})` : ws.name);
async function notifySlack(ws, r) {
  const got = await integrationCfg(ws, "slack"); if (!got) return;
  const { s, prev, changes: c = {} } = r;
  const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`), d = (a, b) => (b == null || a == null ? "" : ` (${a >= b ? "▲" : "▼"} ${Math.abs(Math.round((a - b) * 100))} pts)`);
  const lines = [`*Visibility* ${pct(s.visibility)}${d(s.visibility, prev?.visibility)}`, `*Score* ${s.score}/100 · *Share of voice* ${pct(s.sov)} · *Position* ${s.position ? "#" + s.position.toFixed(1) : "–"}`, s.leader ? `*Leader* ${s.leader.name} at ${pct(s.leader.vis)}` : ""];
  for (const o of c.overtook || []) lines.push(`:warning: *${o.name}* passed you: named in ${pct(o.vis)} of answers.`);
  if (c.gained?.length) lines.push(`*Now named for:* ${c.gained.slice(0, 3).map((x) => `“${x.text}”`).join(", ")}`);
  if (c.lost?.length) lines.push(`*No longer named for:* ${c.lost.slice(0, 3).map((x) => `“${x.text}”`).join(", ")}`);
  const ok = (r.fixes || []).filter((f) => f.pass); if (ok.length) lines.push(`*Fixes confirmed live:* ${ok.map((f) => f.title).slice(0, 4).join("; ")}`);
  await slack.notify(got.cfg, { title: `${brandLabel(ws)}: ${ws.schedule === "daily" ? "daily" : "weekly"} AI visibility`, lines: lines.filter(Boolean), url: process.env.PUBLIC_ORIGIN || undefined });
}

// ── fixes re-checked on their own ───────────────────────────────────────────
// Free checks (server/recheck.mjs) of the fixes a brand hasn't confirmed yet, after each scheduled check. Archived ones and
// those already confirmed are left alone. Returns what was checked, for the report.
async function recheckOpenFixes(ws, M) {
  const rows = await q(`select * from recovery_actions where workspace_id = $1 and status <> 'archived' and coalesce(last_check->>'pass', 'false') <> 'true'
      and (source_key in ('robots', 'llms', 'org') or source_key like 'fix:%' or source_key like 'pitch:%') order by updated_at desc limit 25`, [ws.id]);
  const out = [];
  for (const a of rows) {
    const check = await recheck(a.source_key, { site: ws.site || ws.setup?.profile?.site, brand: M.profile, evidence: a.evidence || {} });
    await saveCheck(a.id, { ...check, by: "schedule" });
    out.push({ title: a.title, sourceKey: a.source_key, pass: check.pass, detail: check.detail });
  }
  return out;
}
const saveCheck = (id, check) => q(`update recovery_actions set last_check = $2, checked_at = now(), updated_at = now() where id = $1`, [id, check]);
// Published fixes whose recheck date has come: this finished check is the later, comparable run the lifecycle asks for, so
// the result is recorded here (before and after for the fix's prompt and engine), instead of waiting for someone to do it.
async function observeDueResults(ws, M) {
  const due = await q(`select * from recovery_actions where workspace_id = $1 and status = 'recheck_scheduled' and recheck_at <= now() and published_at < to_timestamp($2 / 1000.0) limit 50`, [ws.id, M.startedAt]);
  const out = [];
  for (const a of due) {
    const src = a.source_run_id ? await one(`select data from runs where id = $1 and workspace_id = $2`, [a.source_run_id, ws.id]) : null;
    const text = src?.data?.questions?.find((x) => x.id === a.question_id)?.text;
    const count = (R, qtext) => {
      const qq = (R?.questions || []).find((x) => norm(x.text) === norm(qtext)); if (!qq) return null;
      const A = Object.values(R.answers || {}).filter((x) => x.qid === qq.id && finished(x) && (!a.engine || x.engine === a.engine));
      return { named: A.filter((x) => x.named).length, total: A.length };
    };
    const before = text ? count(src.data, text) : null, after = text ? count(M, text) : null;
    const comparable = !!(before?.total && after?.total);
    const rate = (x) => x.named / x.total;
    const direction = !comparable ? "incomparable" : rate(after) > rate(before) ? "improved" : rate(after) < rate(before) ? "regressed" : "unchanged";
    const result = { comparisonRunId: M.id, comparable, before: before || undefined, after: after || undefined, direction, note: RESULT_NOTE, observedAt: new Date().toISOString(), by: "schedule" };
    await q(`update recovery_actions set status = 'result_observed', result = $2, updated_at = now() where id = $1 and status = 'recheck_scheduled'`, [a.id, result]);
    await O.audit(ws.org_id, null, "recovery.status", `${ws.name}: ${a.title}`, { id: a.id, from: "recheck_scheduled", to: "result_observed", direction, by: "schedule" });
    out.push({ title: a.title, direction, before, after, question: text || null, engine: a.engine });
  }
  return out;
}

// ── recovery plan ───────────────────────────────────────────────────────────
// Durable recovery actions (06-DATA-STATE-CONTRACTS.md). The browser derives suggestions from a run and syncs them by
// a deterministic source_key; people then move each one through the lifecycle below. A drafted or published action is
// not a recovered recommendation: only a later finished check of the same brand can record a result.
const RA_STATUSES = ["suggested", "drafting", "ready_for_review", "approved", "published", "recheck_scheduled", "result_observed", "archived"];
const RA_NEXT = { suggested: ["drafting"], drafting: ["suggested", "ready_for_review"], ready_for_review: ["approved", "drafting"], approved: ["published", "drafting"],
  published: ["recheck_scheduled"], recheck_scheduled: ["result_observed"], result_observed: [] };
const RA_LIVE = ["published", "recheck_scheduled", "result_observed"]; // states that need publication evidence
// Who may approve. Editors for now; raise it here when a stricter approval policy is wanted.
const RA_APPROVE_ROLE = "editor";
const GAP_TYPES = ["discovery", "consideration", "decision"], CONFIDENCE = ["low", "medium", "high"], DIRECTIONS = ["improved", "unchanged", "regressed", "incomparable"];
const RESULT_NOTE = "Observed after publication; causality is not established.";
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
function isoDate(v, label) {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(s))) fail(400, `${label} must be an ISO 8601 date, like 2026-10-11T10:30:00Z.`);
  return new Date(s);
}
function httpUrl(v, label) {
  let u; try { u = new URL(String(v)); } catch { u = null; }
  if (!u || !["http:", "https:"].includes(u.protocol) || String(v).length > 2000) fail(400, `${label} must be a full http(s) URL.`);
  return u.href;
}
function oneOf(v, list, label) {
  if (v == null || v === "") return null;
  if (!list.includes(v)) fail(400, `${label} must be one of: ${list.join(", ")}.`);
  return v;
}
const clip = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
const actionOut = (r) => ({ id: r.id, sourceKey: r.source_key, sourceRunId: r.source_run_id, questionId: r.question_id, engine: r.engine, gapType: r.gap_type, kind: r.kind,
  title: r.title, problem: r.problem, rationale: r.rationale, evidence: r.evidence, output: r.output, status: r.status, ownerId: r.owner_id, dueAt: r.due_at,
  approvedAt: r.approved_at, publishedUrl: r.published_url, publishedAt: r.published_at, recheckAt: r.recheck_at, result: r.result, confidence: r.confidence,
  lastCheck: r.last_check && Object.keys(r.last_check).length ? r.last_check : null, checkedAt: r.checked_at || null, createdAt: r.created_at, updatedAt: r.updated_at });
const listActions = async (wsId) => (await q(`select * from recovery_actions where workspace_id = $1 order by updated_at desc, created_at desc limit 1000`, [wsId])).map(actionOut);
// One suggestion from the browser, checked. Only these fields are ever written by a sync.
function suggestionIn(a, i) {
  if (!isObj(a)) fail(400, `actions[${i}] must be an object.`);
  const sourceKey = clip(a.sourceKey, 500), kind = clip(a.kind, 40), title = clip(a.title, 300), problem = clip(a.problem, 2000);
  if (!sourceKey) fail(400, `actions[${i}] needs a sourceKey.`);
  if (!kind || !title || !problem) fail(400, `actions[${i}] needs a kind, a title and a problem.`);
  if (a.evidence != null && !isObj(a.evidence)) fail(400, `actions[${i}].evidence must be an object.`);
  return { sourceKey, kind, title, problem, rationale: clip(a.rationale, 4000), evidence: a.evidence || {}, gapType: oneOf(a.gapType, GAP_TYPES, `actions[${i}].gapType`),
    questionId: clip(a.questionId, 200), engine: clip(a.engine, 40), confidence: oneOf(a.confidence, CONFIDENCE, `actions[${i}].confidence`) };
}
function counts(v, label) {
  if (v == null) return undefined;
  const ok = isObj(v) && Number.isInteger(v.named) && Number.isInteger(v.total) && v.named >= 0 && v.total >= 0 && v.named <= v.total;
  if (!ok) fail(400, `${label} must be { named, total } with whole numbers, named no more than total.`);
  return { named: v.named, total: v.total };
}
// A result needs a later, finished check of the same brand that started after publication.
async function observedResult(c, w, publishedAt, r) {
  if (!isObj(r) || !r.comparisonRunId) fail(400, "Result observed needs a result with comparisonRunId: a later check of this brand.");
  const run = (await c.query(`select id, status, started_at from runs where id = $1 and workspace_id = $2`, [String(r.comparisonRunId), w.id])).rows[0];
  if (!run) fail(400, "comparisonRunId isn't one of this brand's checks.");
  if (run.status !== "done") fail(400, "The comparison check hasn't finished.");
  if (!publishedAt || new Date(run.started_at) <= new Date(publishedAt)) fail(400, "The comparison check must have started after the action was published.");
  if (r.comparable != null && typeof r.comparable !== "boolean") fail(400, "result.comparable must be true or false.");
  const comparable = r.comparable === true;
  const direction = oneOf(r.direction, DIRECTIONS, "result.direction") || (comparable ? null : "incomparable");
  if (!direction) fail(400, "A comparable result needs a direction: improved, unchanged or regressed.");
  if (!comparable && direction !== "incomparable") fail(400, "Only a comparable result can say improved, unchanged or regressed.");
  return { comparisonRunId: run.id, comparable, before: counts(r.before, "result.before"), after: counts(r.after, "result.after"), direction,
    note: clip(r.note, 1000) || RESULT_NOTE, observedAt: (isoDate(r.observedAt, "result.observedAt") || new Date()).toISOString() };
}

const needDb = () => { if (!hasDb()) fail(400, "Accounts need a database (DATABASE_URL)."); };
const roleOk = (r) => O.ROLES.includes(r);

// ── route table ─────────────────────────────────────────────────────────────
// [method, pattern, handler(req, res, params, url)]. Patterns use :name segments.
export const ROUTES = [
  // ── billing (first, so the webhook is matched before anything generic) ──
  ...makeBillingRoutes({ needCtx, needUser }),
  ...makeConsoleRoutes({ needUser }),
  // ── accounts ──
  ["POST", "/api/auth/signup", async (req, res) => {
    needDb();
    const b = await readJson(req, 20000); const email = normEmail(b.email);
    // Open sign-ups are rate limited per address; invited ones are already gated by their one-time token.
    if (limited(b.invite ? "signup-invite:" + clientIp(req) : "signup:" + clientIp(req), b.invite ? 60 : 8, 3600e3)) fail(429, "Too many sign-ups from here. Try again later.");
    if (!emailOk(email)) fail(400, "Enter a valid email address.");
    if (String(b.password || "").length < 8) fail(400, "Use a password of at least 8 characters.");
    const inv = b.invite ? await O.findInvite(String(b.invite)) : null;
    if (b.invite && !inv) fail(400, "This invite link has expired or was already used. Ask for a new one.", { code: "invite_gone" });
    if (inv && normEmail(inv.email) !== email) fail(403, `This invite is for ${inv.email}.`, { code: "invite_email" });
    if (await one(`select 1 from users where email = $1`, [email])) fail(409, "There's already an account with that email. Sign in instead.");
    const pw = await hashPassword(b.password), name = String(b.name || "").trim().slice(0, 80) || null;
    let u, orgId;
    if (inv) {
      // The account and its membership are made together: if the invite can't be accepted, no orphan account is left.
      ({ u, orgId } = await tx(async (c) => {
        const u = (await c.query(`insert into users (email, name, pw_hash, last_login_at) values ($1, $2, $3, now()) returning id, email, name`, [email, name, pw])).rows[0];
        return { u, orgId: (await O.acceptInvite(inv, u, c)).orgId };
      }));
      u.email_verified_at = new Date();
    } else {
      u = await one(`insert into users (email, name, pw_hash, last_login_at) values ($1, $2, $3, now()) returning id, email, name, email_verified_at`, [email, name, pw]);
      orgId = (await newPersonalOrg(u)).id;
      emailLink(req, u, "verify").catch((e) => console.warn("[verify]", e.message));
    }
    sendJson(res, 200, { user: publicUser(u) }, { "set-cookie": await startSession(req, u.id, orgId) });
  }],
  ["POST", "/api/auth/login", async (req, res) => {
    needDb();
    const b = await readJson(req, 20000); const email = normEmail(b.email);
    if (limited("login:" + clientIp(req), 10) || limited("login:" + email, 10)) fail(429, "Too many attempts. Wait a minute and try again.");
    const u = await one(`select * from users where email = $1`, [email]);
    // Same answer for an unknown email, a Google-only account and a wrong password, so the form can't find accounts.
    if (!u || !u.pw_hash || !(await verifyPassword(b.password, u.pw_hash))) fail(401, "That email and password don't match. If you signed up with Google, use Continue with Google.");
    await q(`update users set last_login_at = now() where id = $1`, [u.id]);
    let orgId = null;
    if (b.invite) { const inv = await O.findInvite(String(b.invite)); if (inv) orgId = (await O.acceptInvite(inv, u)).orgId; }
    sendJson(res, 200, { user: publicUser(u) }, { "set-cookie": await startSession(req, u.id, orgId) });
  }],
  ["POST", "/api/auth/logout", async (req, res) => {
    const t = cookies(req)[SESSION]; if (t && hasDb()) await q(`delete from sessions where id = $1`, [tokenId(t)]);
    sendJson(res, 200, { ok: true }, { "set-cookie": cookie(req, SESSION, "", { maxAge: 0 }) });
  }],
  // Password reset: the same answer whether or not the email has an account.
  ["POST", "/api/auth/forgot", async (req, res) => {
    needDb();
    if (limited("forgot:" + clientIp(req), 5, 3600e3)) fail(429, "Too many requests from here. Try again later.");
    const b = await readJson(req, 5000); const email = normEmail(b.email);
    if (!emailOk(email)) fail(400, "Enter a valid email address.");
    const u = await one(`select id, email from users where email = $1`, [email]);
    // Not awaited, so the answer takes the same time whether or not the account exists.
    if (u && !limited("forgot:" + email, 3, 3600e3)) emailLink(req, u, "reset").catch((e) => console.warn("[reset]", e.message));
    sendJson(res, 200, { ok: true });
  }],
  ["POST", "/api/auth/reset", async (req, res) => {
    needDb();
    if (limited("reset:" + clientIp(req), 10)) fail(429, "Too many attempts. Wait a minute and try again.");
    const b = await readJson(req, 5000);
    if (String(b.password || "").length < 8) fail(400, "Use a password of at least 8 characters.");
    const userId = await useToken(b.token, "reset");
    if (!userId) fail(400, "This reset link has expired or was already used. Ask for a new one.");
    // The emailed link also proves the address.
    await q(`update users set pw_hash = $2, last_login_at = now(), email_verified_at = coalesce(email_verified_at, now()) where id = $1`, [userId, await hashPassword(b.password)]);
    await q(`delete from sessions where user_id = $1`, [userId]); // signed out everywhere else
    const u = await one(`select id, email, name, email_verified_at from users where id = $1`, [userId]);
    sendJson(res, 200, { user: publicUser(u) }, { "set-cookie": await startSession(req, u.id) });
  }],
  // Email verification: a link is sent at sign-up; it can be sent again while signed in.
  ["POST", "/api/auth/verify", async (req, res) => {
    needDb();
    if (limited("verify:" + clientIp(req), 20)) fail(429, "Too many attempts. Wait a minute and try again.");
    const b = await readJson(req, 5000);
    const userId = await useToken(b.token, "verify");
    if (!userId) fail(400, "This verification link has expired or was already used. Send a new one from Team & keys.");
    await q(`update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1`, [userId]);
    sendJson(res, 200, { ok: true });
  }],
  ["POST", "/api/auth/verify/send", async (req, res) => {
    const u = await needUser(req);
    if (u.email_verified_at) return sendJson(res, 200, { ok: true, already: true });
    if (limited("verify-send:" + u.id, 3, 3600e3)) fail(429, "We've sent a few already. Check your inbox (and spam), or try again in an hour.");
    const r = await emailLink(req, u, "verify");
    sendJson(res, 200, { ok: true, emailed: r.sent });
  }],
  // Sign in with Google (identity only). The state lives in a short-lived cookie with the invite token, if any.
  ["GET", "/api/auth/google/start", async (req, res, p, url) => {
    needDb();
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) fail(400, "Google sign-in isn't set up on this server.");
    const state = randomId(18), inv = String(url.searchParams.get("invite") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
    redirect(res, google.loginUrl({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, redirectUri: `${origin(req)}/api/auth/google/callback`, state }),
      { "set-cookie": cookie(req, GSTATE, `${state}.${inv}`, { maxAge: 600 }) });
  }],
  ["GET", "/api/auth/google/callback", async (req, res, p, url) => {
    needDb();
    const clear = cookie(req, GSTATE, "", { maxAge: 0 });
    const back = (msg) => redirect(res, `/#auth-error=${encodeURIComponent(msg)}`, { "set-cookie": clear });
    const [state, invToken] = String(cookies(req)[GSTATE] || "").split(".");
    if (!state || !safeEqual(state, url.searchParams.get("state"))) return back("That Google sign-in expired. Try again.");
    if (url.searchParams.get("error")) return back("Google sign-in was cancelled.");
    let g;
    try { g = await google.exchangeLogin({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${origin(req)}/api/auth/google/callback`, code: url.searchParams.get("code") || "" }); }
    catch (e) { return back(e.message); }
    if (!g.emailVerified) return back("Google hasn't verified that email address.");
    const invite = invToken ? await O.findInvite(invToken) : null;
    let u = await one(`select id, email, name, google_sub, email_verified_at from users where google_sub = $1`, [g.sub]);
    if (!u) {
      u = await one(`select id, email, name, google_sub, email_verified_at from users where email = $1`, [g.email]);
      // Same address, different Google account (say, a mailbox deleted and recreated): not the same person.
      if (u?.google_sub && u.google_sub !== g.sub) return back("This email is linked to a different Google account. Sign in with that one, or with your password.");
      // A password account nobody ever proved owns this address may have been registered by someone else first.
      // Google has now proved it: the address owner takes the account over, and the unproven password and sessions go.
      if (u && !u.email_verified_at) { await q(`update users set pw_hash = null where id = $1`, [u.id]); await q(`delete from sessions where user_id = $1`, [u.id]); }
    }
    let orgId = null;
    if (u) await q(`update users set google_sub = coalesce(google_sub, $2), email_verified_at = coalesce(email_verified_at, now()), last_login_at = now() where id = $1`, [u.id, g.sub]);
    else {
      if (invite && normEmail(invite.email) !== g.email) return back(`This invite is for ${invite.email}, but you signed in to Google as ${g.email}.`);
      if (invite) {
        try { ({ u, orgId } = await tx(async (c) => { const u = (await c.query(`insert into users (email, name, google_sub, email_verified_at, last_login_at) values ($1, $2, $3, now(), now()) returning id, email, name`, [g.email, g.name, g.sub])).rows[0]; return { u, orgId: (await O.acceptInvite(invite, u, c)).orgId }; })); }
        catch (e) { return back(e.message); }
      } else {
        u = await one(`insert into users (email, name, google_sub, email_verified_at, last_login_at) values ($1, $2, $3, now(), now()) returning id, email, name`, [g.email, g.name, g.sub]);
        orgId = (await newPersonalOrg(u)).id;
      }
    }
    if (invite && !orgId) { try { orgId = (await O.acceptInvite(invite, u)).orgId; } catch (e) { return back(e.message); } }
    const sc = await startSession(req, u.id, orgId);
    res.writeHead(302, { location: "/", "cache-control": "no-store", "set-cookie": [sc, clear] }); res.end();
  }],
  ["GET", "/api/me", async (req, res) => {
    const u = await currentUser(req); if (!u) return sendJson(res, 200, { user: null });
    sendJson(res, 200, await meOut(u));
  }],

  // ── organisations ──
  ["GET", "/api/orgs", async (req, res) => { sendJson(res, 200, await meOut(await needUser(req))); }],
  // New organisations: platform operators (for clients), or anyone when ORG_CREATION=open. With ownerEmail, the
  // operator becomes an admin and the client's owner gets an invite.
  ["POST", "/api/orgs", async (req, res) => {
    const u = await needUser(req); const b = await readJson(req, 20000);
    const operator = O.isOperator(u);
    if (!operator && process.env.ORG_CREATION !== "open") fail(403, "Only the Perfstaq team can create organisations. Ask for an invite instead.");
    const name = String(b.name || "").trim(); if (name.length < 2) fail(400, "Give the organisation a name.");
    const ownerEmail = b.ownerEmail ? normEmail(b.ownerEmail) : null;
    if (ownerEmail && !emailOk(ownerEmail)) fail(400, "Enter a valid email for the owner.");
    const selfOwner = !ownerEmail || ownerEmail === normEmail(u.email);
    const org = await O.createOrg({ name, by: u.id, role: selfOwner ? "owner" : "admin", allowPlatformKeys: operator && !!b.allowPlatformKeys });
    if (selfServe() && !operator) await B.startDefaultTrial(org.id, u.id, billingConfig().trialDays); // its trial is the person's one trial (joined, not restarted)
    await O.audit(org.id, u.id, "org.created", org.name, { owner: ownerEmail || u.email });
    const invite = selfOwner ? null : await sendInvite(req, u, org, ownerEmail, "owner");
    await setSessionOrg(u, org.id);
    sendJson(res, 200, { created: { slug: org.slug, name: org.name }, invite, ...(await meOut({ ...u, session_org: org.id })) });
  }],
  ["POST", "/api/orgs/:org/switch", async (req, res, p) => {
    const u = await needUser(req);
    const o = await one(`select id from organizations where slug = $1`, [p.org]);
    const m = o && (await one(`select role from memberships where org_id = $1 and user_id = $2`, [o.id, u.id]));
    if (!o || (!m && !O.isOperator(u))) fail(404, "That organisation doesn't exist, or you're not in it.");
    await setSessionOrg(u, o.id);
    if (!m) await O.audit(o.id, u.id, "operator.visit", u.email);
    sendJson(res, 200, await meOut({ ...u, session_org: o.id }));
  }],
  // An operator sets an organisation's plan by hand: an invoiced Enterprise contract, a longer trial, custom limits. Every change is
  // audited with before and after. It refuses an organisation that has a live Razorpay subscription (cancel that first).
  ["PATCH", "/api/admin/orgs/:slug/billing", async (req, res, p) => {
    const u = await O.needBillingAdmin(await needUser(req));
    const b = await readJson(req, 5000);
    const org = await one(`select id, name, plan_code, billing_status, razorpay_subscription_id, trial_ends_at, current_period_end, entitlement_overrides from organizations where slug = $1`, [p.slug]);
    if (!org) fail(404, "Not found");
    const reason = String(b.reason || "").trim(); if (reason.length < 3) fail(400, "Say why (a few words): it goes in the audit log.");
    if (org.razorpay_subscription_id && ["active", "past_due"].includes(org.billing_status)) fail(409, "This organisation has a Razorpay subscription. Cancel it first.");
    const plan = String(b.plan || org.plan_code), status = String(b.status || (plan === "legacy" ? "internal" : org.billing_status));
    if (!PLANS[plan]) fail(400, "Unknown plan.");
    if (!["internal", "trialing", "active", "canceled"].includes(status)) fail(400, "Status must be internal, trialing, active or canceled.");
    const when = (v, label) => { const d = new Date(v); if (Number.isNaN(d.getTime())) fail(400, `${label} must be a date.`); return d; };
    const trialEnds = b.trialEndsAt ? when(b.trialEndsAt, "trialEndsAt") : null, periodEnds = b.periodEndsAt ? when(b.periodEndsAt, "periodEndsAt") : null;
    if (status === "trialing" && !trialEnds) fail(400, "A trial needs trialEndsAt.");
    if (["active", "canceled"].includes(status) && !periodEnds) fail(400, "A granted plan needs periodEndsAt, the date its access ends.");
    let overrides = org.entitlement_overrides;
    if ("overrides" in b) {
      if (b.overrides === null) overrides = {};
      else {
        const keys = LIMIT_METRICS, v = b.overrides?.values || {};
        for (const [k, n] of Object.entries(v)) if (!keys.includes(k) || !Number.isInteger(n) || n < 0) fail(400, `Custom limits can set ${keys.join(", ")} to whole numbers.`);
        overrides = { values: v, expiresAt: b.overrides.expiresAt ? when(b.overrides.expiresAt, "expiresAt").toISOString() : null, reason, by: u.email };
      }
    }
    await q(`update organizations set plan_code = $2, billing_status = $3, trial_started_at = case when $3 = 'trialing' then coalesce(trial_started_at, now()) else trial_started_at end,
             trial_ends_at = coalesce($4::timestamptz, trial_ends_at), current_period_start = case when $5::timestamptz is not null then now() else current_period_start end,
             current_period_end = coalesce($5::timestamptz, current_period_end), grace_ends_at = null, pending_plan_code = null, cancel_at_period_end = false,
             entitlement_overrides = $6, updated_at = now() where id = $1`, [org.id, plan, status, trialEnds, periodEnds, overrides]);
    await O.audit(org.id, u.id, "billing.operator_set", org.name, { reason, before: { plan: org.plan_code, status: org.billing_status, trialEndsAt: org.trial_ends_at, periodEnd: org.current_period_end, overrides: org.entitlement_overrides }, after: { plan, status, trialEndsAt: trialEnds, periodEnd: periodEnds, overrides } });
    sendJson(res, 200, { billing: await B.billingSummary(org.id) });
  }],
  ["GET", "/api/admin/orgs", async (req, res) => {
    const u = await needUser(req); if (!O.isOperator(u)) fail(404, "Not found");
    const orgs = await q(`select o.slug, o.name, o.allow_platform_keys, o.monthly_cap_usd, o.created_at, o.plan_code, o.billing_status, o.trial_ends_at, o.current_period_end,
        (select count(*)::int from memberships m where m.org_id = o.id) as members,
        (select count(*)::int from workspaces w where w.org_id = o.id and w.parent_id is null) as brands,
        (select u.email from memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner') as owner,
        (select round(coalesce(sum(cost_usd), 0)::numeric, 2)::float from usage x where x.org_id = o.id and x.at >= date_trunc('month', now())) as spent
      from organizations o order by o.created_at desc limit 500`);
    sendJson(res, 200, { orgs });
  }],

  // The current organisation: people, invites, keys, budget and usage.
  ["GET", "/api/org", async (req, res) => {
    const ctx = await needCtx(req, "viewer"); const id = ctx.org.id, admin = O.can(ctx.role, "admin");
    const o = await one(`select slug, name, monthly_cap_usd, allow_platform_keys, created_at from organizations where id = $1`, [id]);
    sendJson(res, 200, {
      org: { slug: o.slug, name: o.name, role: ctx.role, operatorVisit: ctx.operatorVisit, monthlyCapUsd: o.monthly_cap_usd == null ? null : Number(o.monthly_cap_usd), allowPlatformKeys: o.allow_platform_keys, createdAt: o.created_at },
      me: ctx.user.id, operator: ctx.operator,
      members: await O.members(id),
      invites: admin ? await O.pendingInvites(id) : [],
      keys: admin ? O.keyStatus(await O.orgKeys(id)) : null,
      usage: admin ? await O.usageSummary(id) : { cap: await O.capState(id) },
    });
  }],
  ["PATCH", "/api/org", async (req, res) => {
    const ctx = await needCtx(req, "admin"); const b = await readJson(req, 20000); const changes = {};
    if (b.name != null) { const n = String(b.name).trim(); if (n.length < 2) fail(400, "Give the organisation a name."); changes.name = n.slice(0, 80); }
    if ("monthlyCapUsd" in b) { const v = b.monthlyCapUsd === null || b.monthlyCapUsd === "" ? null : Number(b.monthlyCapUsd); if (v != null && (!Number.isFinite(v) || v < 0 || v > 100000)) fail(400, "Enter a monthly budget in dollars, or leave it empty for no limit."); changes.monthly_cap_usd = v; }
    if ("allowPlatformKeys" in b) { if (!ctx.operator) fail(403, "Only the Perfstaq team can change this."); changes.allow_platform_keys = !!b.allowPlatformKeys; }
    const keys = Object.keys(changes);
    if (keys.length) {
      await q(`update organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [ctx.org.id, ...keys.map((k) => changes[k])]);
      await O.audit(ctx.org.id, ctx.user.id, "org.updated", null, changes);
    }
    sendJson(res, 200, { ok: true });
  }],
  ["PUT", "/api/org/keys", async (req, res) => {
    const ctx = await needCtx(req, "admin"); const b = await readJson(req, 20000);
    const changed = await O.setKeys(ctx.org.id, b.keys || {});
    if (changed.length) await O.audit(ctx.org.id, ctx.user.id, "keys.changed", changed.join(", "));
    sendJson(res, 200, { keys: O.keyStatus(await O.orgKeys(ctx.org.id)), changed });
  }],
  ["POST", "/api/org/invitations", async (req, res) => {
    const ctx = await needCtx(req, "admin"); const b = await readJson(req, 20000);
    const email = normEmail(b.email), role = String(b.role || "viewer");
    if (!emailOk(email)) fail(400, "Enter a valid email address.");
    if (!roleOk(role)) fail(400, "Pick a role: admin, editor or viewer.");
    if (role === "owner") {
      const hasOwner = await one(`select 1 from memberships where org_id = $1 and role = 'owner'`, [ctx.org.id]);
      if (hasOwner || !ctx.operator) fail(403, "An organisation has one owner. The owner can hand over ownership from the member list.");
    }
    if (await one(`select 1 from memberships m join users u on u.id = m.user_id where m.org_id = $1 and u.email = $2`, [ctx.org.id, email])) fail(409, `${email} is already in this organisation.`);
    if (limited("invite:" + ctx.org.id, 30, 3600e3)) fail(429, "That's a lot of invites in an hour. Try again later.");
    await B.assertSeat(ctx.org.id);
    sendJson(res, 200, { invite: await sendInvite(req, ctx.user, ctx.org, email, role), invites: await O.pendingInvites(ctx.org.id) });
  }],
  ["DELETE", "/api/org/invitations/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "admin");
    const r = await one(`update invitations set revoked_at = now() where id::text = $2 and org_id = $1 and accepted_at is null and revoked_at is null returning email`, [ctx.org.id, p.id]);
    if (r) await O.audit(ctx.org.id, ctx.user.id, "invite.revoked", r.email);
    sendJson(res, 200, { invites: await O.pendingInvites(ctx.org.id) });
  }],
  ["PATCH", "/api/org/members/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const b = await readJson(req, 5000); const role = String(b.role || "");
    if (!roleOk(role)) fail(400, "Unknown role.");
    // In one transaction with both memberships locked, so a removal racing a hand-over can't leave no owner.
    await tx(async (c) => {
      const m = (await c.query(`select m.role, u.email from memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.user_id::text = $2 for update of m`, [ctx.org.id, p.id])).rows[0];
      if (!m) fail(404, "That person isn't in this organisation.");
      if (m.role === role) return;
      if (role === "owner") {
        // Handing over ownership: only the owner, and they stay on as an admin.
        if (ctx.role !== "owner" || ctx.operatorVisit) fail(403, "Only the owner can hand over ownership.");
        const me = (await c.query(`select role from memberships where org_id = $1 and user_id = $2 for update`, [ctx.org.id, ctx.user.id])).rows[0];
        if (me?.role !== "owner") fail(403, "Only the owner can hand over ownership.");
        await c.query(`update memberships set role = 'admin' where org_id = $1 and user_id = $2`, [ctx.org.id, ctx.user.id]);
        await c.query(`update memberships set role = 'owner' where org_id = $1 and user_id::text = $2`, [ctx.org.id, p.id]);
        await c.query(`insert into audit_log (org_id, user_id, action, target) values ($1, $2, 'owner.transferred', $3)`, [ctx.org.id, ctx.user.id, m.email]);
      } else {
        if (m.role === "owner") fail(403, "The owner's role can't be changed. The owner can hand over ownership first.");
        if (p.id === ctx.user.id) fail(403, "Ask another admin to change your role.");
        await c.query(`update memberships set role = $3 where org_id = $1 and user_id::text = $2`, [ctx.org.id, p.id, role]);
        await c.query(`insert into audit_log (org_id, user_id, action, target, detail) values ($1, $2, 'role.changed', $3, $4)`, [ctx.org.id, ctx.user.id, m.email, { from: m.role, to: role }]);
      }
    });
    sendJson(res, 200, { members: await O.members(ctx.org.id) });
  }],
  // Remove someone (admin), or leave (anyone but the owner). Their sessions stop working in this organisation at once.
  ["DELETE", "/api/org/members/:id", async (req, res, p) => {
    const self = (await needUser(req)).id === p.id;
    const ctx = await needCtx(req, self ? "viewer" : "admin");
    // Deleted only if they are not the owner at that moment (a hand-over may have just happened).
    const m = await one(`delete from memberships m using users u where u.id = m.user_id and m.org_id = $1 and m.user_id::text = $2 and m.role <> 'owner' returning m.role, u.email`, [ctx.org.id, p.id]);
    if (!m) {
      const still = await one(`select role from memberships where org_id = $1 and user_id::text = $2`, [ctx.org.id, p.id]);
      fail(still ? 403 : 404, still ? "The owner can't be removed. Hand over ownership first." : "That person isn't in this organisation.");
    }
    await q(`update sessions set org_id = null where org_id = $1 and user_id::text = $2`, [ctx.org.id, p.id]);
    await O.audit(ctx.org.id, ctx.user.id, self ? "member.left" : "member.removed", m.email, { role: m.role });
    sendJson(res, 200, self ? { left: true } : { members: await O.members(ctx.org.id) });
  }],
  ["GET", "/api/org/audit", async (req, res) => {
    const ctx = await needCtx(req, "admin");
    sendJson(res, 200, { log: await O.auditLog(ctx.org.id) });
  }],
  // Invite links: what it is (public, so the page can say who invited you), and accepting it once signed in.
  ["GET", "/api/invitations/:token", async (req, res, p) => {
    needDb();
    if (limited("invlook:" + clientIp(req), 30)) fail(429, "Too many requests.");
    const inv = await O.findInvite(p.token);
    if (!inv) fail(404, "This invite link has expired or was already used. Ask for a new one.");
    const account = !!(await one(`select 1 from users where email = $1`, [normEmail(inv.email)]));
    sendJson(res, 200, { org: inv.org_name, email: inv.email, role: inv.role, inviter: inv.inviter_name || inv.inviter_email, account, expiresAt: inv.expires_at });
  }],
  ["POST", "/api/invitations/:token/accept", async (req, res, p) => {
    const u = await needUser(req);
    const inv = await O.findInvite(p.token);
    if (!inv) fail(404, "This invite link has expired or was already used. Ask for a new one.");
    const r = await O.acceptInvite(inv, u);
    await setSessionOrg(u, r.orgId);
    sendJson(res, 200, await meOut({ ...u, session_org: r.orgId }));
  }],

  // ── brands ──
  // Brands in the current organisation, with their recent trend, for the switcher and the brand list. A brand's markets (its
  // country versions) come back as workspaces too, each naming its brand in `parent`.
  ["GET", "/api/workspaces", async (req, res) => {
    const ctx = await needCtx(req, "viewer");
    const rows = await q(`select w.*, (select slug from workspaces p where p.id = w.parent_id) as parent_slug,
                             (select coalesce(json_agg(t order by t.started_at), '[]') from (select id, started_at, source, summary from runs r where r.workspace_id = w.id and r.status = 'done' order by r.started_at desc limit 12) t) as trend
                           from workspaces w where org_id = $1 order by updated_at desc`, [ctx.org.id]);
    sendJson(res, 200, { workspaces: rows.map((w) => wsOut(w, { trend: w.trend, setup: w.setup })), org: O.orgOut(ctx) });
  }],
  // Create or update a brand. With `parent` (a brand's slug) it is one of that brand's markets: another country version of
  // its site, counted against the plan's markets per brand instead of its brands.
  ["PUT", "/api/workspaces/:slug", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const b = await readJson(req);
    const slug = slugify(p.slug), name = String(b.name || b.setup?.profile?.name || slug).slice(0, 120);
    const setup = b.setup || {}, market = marketIn(b.market);
    const w = await B.guarded(ctx.org.id, async (c, st) => {
      B.assertWrite(st);
      const prev = (await c.query(`select id, setup, parent_id from workspaces where org_id = $1 and slug = $2`, [ctx.org.id, slug])).rows[0];
      let parent = null;
      if (b.parent && !prev) {
        parent = (await c.query(`select id, name from workspaces where org_id = $1 and slug = $2`, [ctx.org.id, slugify(b.parent)])).rows[0];
        if (!parent) fail(404, "That brand doesn't exist in this organisation.");
        const top = (await c.query(`select parent_id from workspaces where id = $1`, [parent.id])).rows[0];
        if (top.parent_id) fail(400, "Add the market to the brand itself, not to one of its markets.");
        if (!market) fail(400, "A market needs a country.");
        const same = (await c.query(`select name from workspaces where (id = $1 or parent_id = $1) and market->>'code' = $2`, [parent.id, market.code])).rows[0];
        if (same) fail(409, `${parent.name} already tracks ${market.name}.`);
        B.assertMarketCreate(st, 1 + (await c.query(`select count(*)::int as n from workspaces where parent_id = $1`, [parent.id])).rows[0].n);
      } else if (!prev) B.assertBrandCreate(st); // the brand limit counts only a genuinely new brand: this route is an upsert
      await B.assertSetup(st, c, setup, prev?.setup, prev?.id);
      return (await c.query(`insert into workspaces (org_id, owner_id, slug, name, site, setup, parent_id, market) values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (org_id, slug) do update set name = excluded.name, site = excluded.site, setup = excluded.setup, market = coalesce(excluded.market, workspaces.market), updated_at = now() returning *`,
        [ctx.org.id, ctx.user.id, slug, name, b.site || setup.profile?.site || null, setup, parent?.id || null, market])).rows[0];
    });
    if (w.parent_id && b.parent) await O.audit(ctx.org.id, ctx.user.id, "market.saved", `${w.name}: ${market?.name}`, { slug });
    sendJson(res, 200, { workspace: wsOut(await withParent(w), { setup: w.setup }) });
  }],
  ["PATCH", "/api/workspaces/:slug", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const w = await needWorkspace(ctx, p.slug); const b = await readJson(req, 200000);
    // Move a brand (with its markets) to another organisation, for example from your own into a client's: admin on both sides.
    if (b.moveTo) {
      O.needRole(ctx, "admin");
      if (w.parent_id) fail(400, "Move the brand itself. Its markets move with it.");
      const to = await one(`select id, slug, name from organizations where slug = $1`, [String(b.moveTo)]);
      const mine = to && (await one(`select role from memberships where org_id = $1 and user_id = $2`, [to.id, ctx.user.id]));
      if (!to || !((mine && O.can(mine.role, "admin")) || ctx.operator)) fail(403, "You need to be an admin in the organisation you're moving it to.");
      const clash = await one(`select t.slug from workspaces t where t.org_id = $1 and t.slug in (select slug from workspaces where id = $2 or parent_id = $2)`, [to.id, w.id]);
      if (clash) fail(409, `${to.name} already has a brand called ${clash.slug}.`);
      await B.guarded(to.id, async (c, st) => {
        B.assertWrite(st); B.assertBrandCreate(st);
        const n = (await c.query(`select count(*)::int as n from workspaces where parent_id = $1`, [w.id])).rows[0].n;
        if (n) B.assertMarketCreate(st, n);
        await c.query(`update workspaces set org_id = $2, updated_at = now() where id = $1 or parent_id = $1`, [w.id, to.id]);
      });
      await O.audit(ctx.org.id, ctx.user.id, "brand.moved_out", w.name, { to: to.slug });
      await O.audit(to.id, ctx.user.id, "brand.moved_in", w.name, { from: ctx.org.slug });
      return sendJson(res, 200, { moved: { slug: w.slug, to: to.slug } });
    }
    const schedule = ["off", "daily", "weekly"].includes(b.schedule) ? b.schedule : w.schedule;
    const samples = b.samples != null ? Math.max(1, Math.min(5, Number(b.samples) || 1)) : w.samples;
    const setup = b.setup ? { ...w.setup, ...b.setup } : w.setup;
    // The time of day (and weekday) checks run, in the brand's time zone. null clears it: back to "a period after the last one".
    const at = { dow: w.run_dow, hour: w.run_hour, tz: w.run_tz };
    if ("runDow" in b) at.dow = b.runDow == null || b.runDow === "" ? null : Number.isInteger(+b.runDow) && +b.runDow >= 0 && +b.runDow <= 6 ? +b.runDow : fail(400, "runDow is a weekday, 0 (Sunday) to 6.");
    if ("runHour" in b) at.hour = b.runHour == null || b.runHour === "" ? null : Number.isInteger(+b.runHour) && +b.runHour >= 0 && +b.runHour <= 23 ? +b.runHour : fail(400, "runHour is an hour, 0 to 23.");
    if ("runTz" in b) at.tz = b.runTz == null || b.runTz === "" ? null : validTz(b.runTz) ? String(b.runTz).slice(0, 60) : fail(400, "runTz must be a time zone like Asia/Kolkata.");
    const timing = "runDow" in b || "runHour" in b || "runTz" in b;
    // A new or changed schedule (or time) starts from now: the next run is the next slot, or "soon" if asked (runNow).
    const next = b.runNow ? new Date() : schedule === w.schedule && !timing && w.next_run_at ? w.next_run_at : nextRun(schedule, Date.now(), at);
    const out = await B.guarded(ctx.org.id, async (c, st) => {
      B.assertWrite(st); B.assertSchedule(st, schedule, samples, w); await B.assertSetup(st, c, setup, w.setup, w.id); if (b.runNow) B.assertCheck(st);
      return (await c.query(`update workspaces set schedule = $2, samples = $3, setup = $4, next_run_at = $5, name = coalesce($6, name), run_dow = $7, run_hour = $8, run_tz = $9, updated_at = now() where id = $1 returning *`,
        [w.id, schedule, samples, setup, schedule === "off" && !b.runNow ? null : next, b.name || null, at.dow, at.hour, at.tz])).rows[0];
    });
    if (b.runNow) await O.audit(ctx.org.id, ctx.user.id, "check.queued", w.name);
    sendJson(res, 200, { workspace: wsOut(await withParent(out), { setup: out.setup }) });
  }],
  // Deleting a brand deletes its markets too (they are its country versions); deleting a market deletes only that market.
  ["DELETE", "/api/workspaces/:slug", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, p.slug, "admin");
    await q(`delete from workspaces where id = $1`, [w.id]);
    await O.audit(ctx.org.id, ctx.user.id, w.parent_id ? "market.deleted" : "brand.deleted", w.name, w.market ? { market: w.market.name } : null);
    sendJson(res, 200, { ok: true });
  }],

  // Runs: the browser saves its live run as it goes; scheduled runs arrive from the tick.
  ["GET", "/api/workspaces/:slug/runs", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer"); const w = await needWorkspace(ctx, p.slug);
    const runs = await q(`select id, source, status, started_at, finished_at, summary, error from runs where workspace_id = $1 order by started_at desc limit 60`, [w.id]);
    sendJson(res, 200, { runs });
  }],
  ["GET", "/api/workspaces/:slug/runs/latest", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer"); const w = await needWorkspace(ctx, p.slug);
    const r = await one(`select id, source, status, data from runs where workspace_id = $1 and data is not null order by (status = 'done') desc, started_at desc limit 1`, [w.id]);
    const prev = r ? await one(`select data from runs where workspace_id = $1 and status = 'done' and id <> $2 and data is not null order by started_at desc limit 1`, [w.id, r.id]) : null;
    sendJson(res, 200, { run: r?.data || null, status: r?.status || null, prev: prev?.data || null });
  }],
  ["GET", "/api/runs/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer");
    const r = await one(`select r.data, r.status from runs r join workspaces w on w.id = r.workspace_id where r.id = $1 and w.org_id = $2`, [p.id, ctx.org.id]);
    if (!r) fail(404, "Run not found."); sendJson(res, 200, { run: r.data, status: r.status });
  }],
  ["PUT", "/api/runs/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const b = await readJson(req, 12 * 1024 * 1024);
    const w = await needWorkspace(ctx, slugify(b.slug || b.data?.slug), "editor");
    const data = b.data || {}; const status = data.finishedAt ? "done" : b.status === "stopped" ? "stopped" : "running";
    const owner = await one(`select workspace_id from runs where id = $1`, [p.id]);
    if (owner && owner.workspace_id !== w.id) fail(409, "That run id belongs to another brand.");
    await q(`insert into runs (id, workspace_id, source, status, started_at, finished_at, summary, data, started_by, updated_at)
             values ($1, $2, 'live', $3, to_timestamp($4 / 1000.0), $5, $6, $7, $8, now())
             on conflict (id) do update set status = excluded.status, finished_at = excluded.finished_at, summary = excluded.summary, data = excluded.data, updated_at = now()`,
      [p.id, w.id, status, data.startedAt || Date.now(), data.finishedAt ? new Date(data.finishedAt) : null, status === "done" ? summarize(data) : null, data, ctx.user.id]);
    if (status === "done" && (await B.trialUsedUp(ctx.org.id))) void N.notify(ctx.org.id, "trial_check_used", "trial", { plan: (await one(`select plan_code from organizations where id = $1`, [ctx.org.id]))?.plan_code });
    if (status === "done") await q(`update workspaces set last_run_at = now(), updated_at = now(), next_run_at = $2 where id = $1`, [w.id, nextRun(w.schedule, Date.now(), runAt(w))]);
    sendJson(res, 200, { ok: true, status });
  }],

  // Recovery plan, per brand. Viewers read; editors sync suggestions and move actions along. No delete: archive.
  ["GET", "/api/workspaces/:slug/recovery-actions", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer"); const w = await needWorkspace(ctx, p.slug);
    sendJson(res, 200, { actions: await listActions(w.id) });
  }],
  // Upsert by (brand, source_key). A rerun refreshes the evidence and wording only; status, owner, dates, drafts,
  // publication and result stay as people left them, and archived actions stay archived.
  ["POST", "/api/workspaces/:slug/recovery-actions/sync", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const w = await needWorkspace(ctx, p.slug, "editor"); const b = await readJson(req, 4 * 1024 * 1024);
    if (!Array.isArray(b.actions)) fail(400, "Send the suggestions as a list in `actions`.");
    if (b.actions.length > 500) fail(400, "Sync at most 500 suggestions at a time.");
    const items = b.actions.map(suggestionIn);
    const runId = b.runId == null || b.runId === "" ? null : String(b.runId);
    if (runId && !(await one(`select 1 from runs where id = $1 and workspace_id = $2`, [runId, w.id]))) fail(400, "runId isn't one of this brand's checks.");
    const n = await tx(async (c) => {
      let created = 0, updated = 0;
      for (const a of items) {
        const r = (await c.query(`insert into recovery_actions (workspace_id, source_key, source_run_id, question_id, engine, gap_type, kind, title, problem, rationale, evidence, confidence)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            on conflict (workspace_id, source_key) do update set source_run_id = coalesce(excluded.source_run_id, recovery_actions.source_run_id),
              question_id = excluded.question_id, engine = excluded.engine, gap_type = excluded.gap_type, title = excluded.title, problem = excluded.problem,
              rationale = excluded.rationale, evidence = excluded.evidence, confidence = excluded.confidence, updated_at = now()
            returning (xmax = 0) as created`,
          [w.id, a.sourceKey, runId, a.questionId, a.engine, a.gapType, a.kind, a.title, a.problem, a.rationale, a.evidence, a.confidence])).rows[0];
        if (r.created) created++; else updated++;
      }
      return { created, updated };
    });
    await O.audit(ctx.org.id, ctx.user.id, "recovery.synced", w.name, { ...n, runId });
    sendJson(res, 200, { ...n, actions: await listActions(w.id) });
  }],
  // Edit content and move through the lifecycle. Published needs explicit evidence (URL + date, or a sent time for
  // outreach); a result needs a later finished check. Archive works from any state and remembers where it was.
  ["PATCH", "/api/workspaces/:slug/recovery-actions/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const w = await needWorkspace(ctx, p.slug, "editor"); const b = await readJson(req, 2 * 1024 * 1024);
    const { row, from } = await tx(async (c) => {
      const a = (await c.query(`select * from recovery_actions where id::text = $1 and workspace_id = $2 for update`, [p.id, w.id])).rows[0];
      if (!a) fail(404, "That recovery action doesn't exist for this brand.");
      const set = {};
      for (const [k, max] of [["title", 300], ["problem", 2000]]) if (k in b) { set[k] = clip(b[k], max); if (!set[k]) fail(400, `${k} can't be empty.`); }
      if ("rationale" in b) set.rationale = clip(b.rationale, 4000);
      if ("output" in b) { if (!isObj(b.output)) fail(400, "output must be an object."); set.output = b.output; }
      if ("confidence" in b) set.confidence = oneOf(b.confidence, CONFIDENCE, "confidence");
      if ("ownerId" in b) {
        const id = b.ownerId == null || b.ownerId === "" ? null : String(b.ownerId);
        if (id && !(await c.query(`select 1 from memberships where org_id = $1 and user_id::text = $2`, [ctx.org.id, id])).rows.length) fail(400, "The owner must be a member of this organisation.");
        set.owner_id = id;
      }
      if ("dueAt" in b) set.due_at = isoDate(b.dueAt, "dueAt");
      if ("recheckAt" in b) set.recheck_at = isoDate(b.recheckAt, "recheckAt");
      if ("approvedAt" in b) set.approved_at = isoDate(b.approvedAt, "approvedAt");
      if ("publishedUrl" in b) set.published_url = b.publishedUrl == null || b.publishedUrl === "" ? null : httpUrl(b.publishedUrl, "publishedUrl");
      if ("publishedAt" in b) set.published_at = isoDate(b.publishedAt, "publishedAt");
      if ("sentAt" in b) { if (a.kind !== "outreach") fail(400, "sentAt is for outreach. Use publishedUrl and publishedAt."); set.published_at = isoDate(b.sentAt, "sentAt"); }

      const to = b.status == null || b.status === a.status ? a.status : String(b.status);
      if (to !== a.status) {
        if (!RA_STATUSES.includes(to)) fail(400, `Unknown status "${to}". Use one of: ${RA_STATUSES.join(", ")}.`);
        const result = { ...(a.result || {}) };
        if (to === "archived") set.result = { ...result, previousStatus: a.status };
        else if (a.status === "archived") {
          if (to !== result.previousStatus) fail(400, result.previousStatus ? `An archived action can only be restored to ${result.previousStatus}.` : "This archived action has no previous status to restore.");
          delete result.previousStatus; set.result = result;
        } else {
          const next = RA_NEXT[a.status] || [];
          if (!next.includes(to)) fail(400, `Can't move from ${a.status} to ${to}. From ${a.status} the next step is ${next.join(" or ") || "none"} (or archived).`);
          if (to === "approved") { O.needRole(ctx, RA_APPROVE_ROLE); if (!("approvedAt" in b)) set.approved_at = new Date(); }
          if (to === "result_observed") set.result = await observedResult(c, w, "published_at" in set ? set.published_at : a.published_at, b.result);
        }
        set.status = to;
      } else if ("result" in b) fail(400, "A result is recorded only when moving to result_observed.");

      // Published (and everything after it) needs explicit publication evidence: never inferred from a copied draft.
      const pubUrl = "published_url" in set ? set.published_url : a.published_url, pubAt = "published_at" in set ? set.published_at : a.published_at;
      if (RA_LIVE.includes(to) && (!pubAt || (!pubUrl && a.kind !== "outreach")))
        fail(400, a.kind === "outreach" ? "Published needs the time it was sent (sentAt)." : "Published needs the live URL (publishedUrl, http or https) and the date it went live (publishedAt).");

      const keys = Object.keys(set);
      if (!keys.length) return { row: a, from: a };
      const row = (await c.query(`update recovery_actions set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1 returning *`, [a.id, ...keys.map((k) => set[k])])).rows[0];
      return { row, from: a };
    });
    if (row.status !== from.status) await O.audit(ctx.org.id, ctx.user.id, "recovery.status", `${w.name}: ${row.title}`, { id: row.id, from: from.status, to: row.status, publishedUrl: row.published_url || undefined });
    if (row.owner_id !== from.owner_id) await O.audit(ctx.org.id, ctx.user.id, "recovery.assigned", `${w.name}: ${row.title}`, { id: row.id, owner: row.owner_id });
    sendJson(res, 200, { action: actionOut(row) });
  }],

  // Integrations, per brand. Connecting and disconnecting is for admins; refreshing and submitting for editors.
  ["GET", "/api/workspaces/:slug/integrations", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer"); const w = await needWorkspace(ctx, p.slug);
    sendJson(res, 200, { integrations: await integrationsFor(w), platform: { serp: !!(await O.withOrgKeys(ctx.org.id, () => serpConfig())), googleOAuth: !!process.env.GOOGLE_OAUTH_CLIENT_ID } });
  }],
  ["PUT", "/api/workspaces/:slug/integrations/:provider", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, p.slug, "admin"); const mod = getProvider(p.provider);
    if (!mod || p.provider === "serp") fail(404, "Unknown integration.");
    await B.assertIntegration(ctx.org.id, p.provider);
    const b = await readJson(req, 50000);
    const prev = (await integrationCfg(w, p.provider))?.cfg || {};
    const cfg = { ...prev };
    for (const f of mod.meta.fields) if (b[f.key] != null && String(b[f.key]).trim() !== "") cfg[f.key] = String(b[f.key]).trim();
    if (p.provider === "indexnow") { const { ensureKey } = await import("./integrations/indexnow.mjs"); ensureKey(cfg); }
    const t = await mod.test(cfg, ctxFor(w));
    if (t.key && !cfg.key) cfg.key = t.key;
    await saveIntegration(w, p.provider, cfg, { status: t.ok ? "connected" : "error", detail: t.detail });
    await O.audit(ctx.org.id, ctx.user.id, "integration.saved", `${w.name}: ${p.provider}`, { ok: t.ok });
    let data = null; if (t.ok && p.provider !== "slack") data = await collectOne(w, p.provider).catch(() => null);
    sendJson(res, 200, { ok: t.ok, detail: t.detail, data, integrations: await integrationsFor(w) });
  }],
  ["DELETE", "/api/workspaces/:slug/integrations/:provider", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, p.slug, "admin");
    await q(`delete from integrations where workspace_id = $1 and provider = $2`, [w.id, p.provider]);
    await O.audit(ctx.org.id, ctx.user.id, "integration.removed", `${w.name}: ${p.provider}`);
    sendJson(res, 200, { integrations: await integrationsFor(w) });
  }],
  ["POST", "/api/workspaces/:slug/integrations/:provider/collect", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const w = await needWorkspace(ctx, p.slug, "editor");
    sendJson(res, 200, { data: await collectOne(w, p.provider), integrations: await integrationsFor(w) });
  }],
  // Push changed pages to Bing (and so ChatGPT search) right away: IndexNow and/or Bing's URL submission.
  ["POST", "/api/workspaces/:slug/integrations/:provider/submit", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const w = await needWorkspace(ctx, p.slug, "editor"); const b = await readJson(req, 200000);
    if (!["indexnow", "bing"].includes(p.provider)) fail(400, "This tool can't submit URLs.");
    const got = await integrationCfg(w, p.provider); if (!got) fail(404, "Not connected.");
    const urls = (b.urls || []).map(String).filter((x) => /^https?:\/\//.test(x)).slice(0, 500);
    if (!urls.length) fail(400, "No URLs to submit.");
    const r = await getProvider(p.provider).submitUrls(got.cfg, urls, ctxFor(w));
    if (p.provider === "indexnow") { got.cfg.lastSubmit = r; await saveIntegration(w, "indexnow", got.cfg); }
    sendJson(res, 200, r);
  }],
  ["POST", "/api/workspaces/:slug/integrations/google/properties", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, p.slug, "admin");
    const got = await integrationCfg(w, "google"); if (!got) fail(404, "Connect Google first.");
    const props = await google.listProperties(got.cfg, ctxFor(w, { onToken: async (t) => { Object.assign(got.cfg, t); await saveIntegration(w, "google", got.cfg); } }));
    sendJson(res, 200, props);
  }],

  // Google OAuth (Search Console + GA4). The state row ties the callback to this user and brand, once.
  ["GET", "/api/oauth/google/start", async (req, res, p, url) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, url.searchParams.get("ws") || "", "admin");
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) fail(400, "Google sign-in isn't configured on this server (GOOGLE_OAUTH_CLIENT_ID).");
    const state = randomId(18);
    await q(`insert into oauth_states (state, user_id, workspace_id) values ($1, $2, $3)`, [state, ctx.user.id, w.id]);
    await q(`delete from oauth_states where created_at < now() - interval '1 hour'`);
    redirect(res, google.oauthUrl({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, redirectUri: `${origin(req)}/api/oauth/google/callback`, state }));
  }],
  ["GET", "/api/oauth/google/callback", async (req, res, p, url) => {
    const u = await needUser(req);
    const st = await one(`delete from oauth_states where state = $1 and user_id = $2 and created_at > now() - interval '1 hour' returning workspace_id`, [url.searchParams.get("state") || "", u.id]);
    if (!st) fail(400, "This Google sign-in link expired. Start again from Settings.");
    const w = await one(`select * from workspaces where id = $1`, [st.workspace_id]);
    // Still an admin of that brand's organisation? (Someone removed while the Google screen was open is not.)
    const m = w && (await one(`select role from memberships where org_id = $1 and user_id = $2`, [w.org_id, u.id]));
    if (!w || !((m && O.can(m.role, "admin")) || O.isOperator(u))) fail(403, "Only an admin of this brand's organisation can connect Google.");
    if (url.searchParams.get("error")) return redirect(res, `/#settings/${w.slug}?google=denied`);
    const tok = await google.exchangeCode({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${origin(req)}/api/oauth/google/callback`, code: url.searchParams.get("code") || "" });
    await saveIntegration(w, "google", tok, { status: "connected", detail: `Signed in as ${tok.email || "Google user"}. Choose your properties.` });
    await O.audit(w.org_id, u.id, "integration.saved", `${w.name}: google`, { ok: true });
    redirect(res, `/#settings/${w.slug}?google=connected`);
  }],

  // Live checks the browser pipeline needs from the server (keys stay server-side, the organisation's own).
  ["POST", "/api/serp/organic", async (req, res) => {
    const ctx = await aiContext(req, "editor");
    const run = async () => {
      const cfg = serpConfig(); if (!cfg) fail(400, "Google rank checks need a DataForSEO login or a SerpApi key (Team & keys).");
      const b = await readJson(req, 20000);
      const query = String(b.query || "").slice(0, 300); if (!query) fail(400, "No query.");
      const r = await serp.organic({ ...cfg, ...serpWhere({ market: b.market, country: b.country }) }, query);
      if (ctx) await O.meter({ orgId: ctx.org.id, workspaceId: ctx.workspaceId, userId: ctx.user.id, kind: "serp" });
      sendJson(res, 200, { query, results: r.results || [] });
    };
    return ctx ? O.withOrgKeys(ctx.org.id, run) : run();
  }],
  ["POST", "/api/entity", async (req, res) => {
    const ctx = await aiContext(req, "editor");
    const b = await readJson(req, 100000);
    const run = async () => sendJson(res, 200, await entity.collect({ googleApiKey: env("GOOGLE_API_KEY") }, { brand: String(b.name || ""), host: hostOf(b.site || ""), site: b.site, orgSchema: b.orgSchema }));
    return ctx ? O.withOrgKeys(ctx.org.id, run) : run();
  }],

  // Re-check ONE fix (robots.txt, llms.txt, schema, a page, a listing) without re-running the analysis. No AI is asked, so it
  // doesn't use a check or the AI budget; it still needs an editor and a writable plan. With a database the outcome is kept on
  // the brand's recovery action (made from the deck card if it isn't one yet), so it shows next time and in the report.
  ["POST", "/api/recheck", async (req, res) => {
    const ctx = await aiAuth(req); const b = await readJson(req, 200000);
    const sourceKey = clip(b.sourceKey, 2100);
    if (!checkType(sourceKey)) fail(400, "This fix can't be re-checked on its own. The next full check measures it.");
    if (!ctx) {
      if (limited("recheck:" + clientIp(req), 60, 3600e3)) fail(429, "That's a lot of rechecks in an hour. Try again later.");
      return sendJson(res, 200, { check: await recheck(sourceKey, { site: String(b.site || ""), brand: isObj(b.brand) ? b.brand : {}, evidence: isObj(b.evidence) ? b.evidence : {} }) });
    }
    O.needRole(ctx, "editor"); await B.needWrite(ctx.org.id);
    const w = await needWorkspace(ctx, slugify(b.slug || ""), "editor");
    if (limited("recheck:" + w.id, 120, 3600e3)) fail(429, "That's a lot of rechecks in an hour. Try again later.");
    const a = suggestionIn({ sourceKey, kind: b.kind, title: b.title, problem: b.problem, evidence: b.evidence }, 0);
    const profile = w.setup?.profile || {};
    const check = { ...(await recheck(sourceKey, { site: w.site || profile.site, brand: profile, evidence: a.evidence })), by: "person" };
    const row = await one(`insert into recovery_actions (workspace_id, source_key, kind, title, problem, evidence, last_check, checked_at) values ($1, $2, $3, $4, $5, $6, $7, now())
        on conflict (workspace_id, source_key) do update set title = excluded.title, problem = excluded.problem, evidence = excluded.evidence, last_check = excluded.last_check, checked_at = now(), updated_at = now() returning *`,
      [w.id, a.sourceKey, a.kind, a.title, a.problem, a.evidence, check]);
    await O.audit(ctx.org.id, ctx.user.id, "recovery.rechecked", `${w.name}: ${a.title}`, { id: row.id, pass: check.pass });
    sendJson(res, 200, { check, action: actionOut(row) });
  }],

  // The scheduled report's unsubscribe link (signed per person and kind, so it works without signing in), and one-click
  // unsubscribe for mail apps (RFC 8058 POST). Turning it back on is in Settings.
  ...["GET", "POST"].map((m) => [m, "/api/email/unsubscribe", async (req, res, p, url) => {
    needDb();
    const u = String(url.searchParams.get("u") || ""), k = String(url.searchParams.get("k") || "");
    if (!N.OPT_OUT_KINDS.includes(k) || !safeEqual(url.searchParams.get("t"), N.unsubToken(u, k))) fail(400, "This unsubscribe link isn't valid. Turn the report off in Settings instead.");
    await q(`insert into email_optouts (user_id, kind) select id, $2 from users where id::text = $1 on conflict do nothing`, [u, k]);
    if (m === "POST") return sendJson(res, 200, { ok: true });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#1D1A17"><h1 style="font-size:20px">You won't get these reports any more</h1><p>Perfstaq still runs your scheduled checks, and the results stay in the app. To get the email again, open a brand's Settings and turn on the results email.</p><p><a href="/">Open Perfstaq</a></p></body>`);
  }]),
  ["GET", "/api/me/email-prefs", async (req, res) => {
    const u = await needUser(req);
    const off = new Set((await q(`select kind from email_optouts where user_id = $1`, [u.id])).map((r) => r.kind));
    sendJson(res, 200, { reports: !off.has("weekly_results") });
  }],
  ["PUT", "/api/me/email-prefs", async (req, res) => {
    const u = await needUser(req); const b = await readJson(req, 2000);
    if (typeof b.reports !== "boolean") fail(400, "Send { reports: true } or { reports: false }.");
    if (b.reports) await q(`delete from email_optouts where user_id = $1 and kind = 'weekly_results'`, [u.id]);
    else await q(`insert into email_optouts (user_id, kind) values ($1, 'weekly_results') on conflict do nothing`, [u.id]);
    sendJson(res, 200, { reports: b.reports });
  }],

  // Cloud Scheduler → here, every 10 minutes, with the shared secret. Runs due brands before answering (see tick()).
  ["POST", "/api/cron/tick", async (req, res) => {
    if (!process.env.CRON_SECRET || !safeEqual(req.headers["x-cron-secret"], process.env.CRON_SECRET)) fail(401, "Bad cron secret.");
    if (!hasDb()) fail(400, "No database.");
    sendJson(res, 200, { ran: await tick() });
  }],
];
