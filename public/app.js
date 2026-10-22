/* Perfstaq AI Visibility: a visible AI agent.
   Flow: Peec-style setup (scan site → brand profile → market → competitors → topics → prompt focus → prompt set)
   → live AI answers → follow the sources → what AI says about you → insights → drafts → "workspace ready" reveal
   → results dashboard (overview, prompts, chats, sources, gap analysis, actions) with an agent you can ask. */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const host = (u) => { try { return new URL(String(u).includes("://") ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch { return String(u || ""); } };
// A brand tracked per country (meshopcheap.com/in): a page under another country's path (/us/...) is your site but not this
// market. Mirrors api/_markets.js ownUrl (which also checks the segment is a known country).
const localeSeg = (p) => { const x = String(p || "").split("/").filter(Boolean)[0] || ""; return /^[a-z]{2}([-_][a-z]{2})?$/i.test(x) ? x.toLowerCase() : ""; };
const marketPath = (site) => { try { return localeSeg(new URL(String(site).includes("://") ? site : "https://" + site).pathname); } catch { return ""; } };
function ownUrl(u, site) {
  const h = host(u), o = host(site || ""); if (!o || !(h === o || h.endsWith("." + o))) return false;
  const scope = marketPath(site); if (!scope) return true;
  let seg = ""; try { seg = localeSeg(new URL(u).pathname); } catch {} return !seg || seg === scope;
}
const slugify = (s) => norm(s).replace(/ /g, "-").slice(0, 48) || "brand";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const ENG = { chatgpt: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini", groq: "Groq web", aio: "AI Overviews", aimode: "AI Mode" };
const ENGC = { chatgpt: "var(--e-chatgpt)", perplexity: "var(--e-perplexity)", gemini: "var(--e-gemini)", groq: "var(--e-groq)", aio: "var(--e-aio)", aimode: "var(--e-aimode)" };
// Answers are keyed question|engine for the first sample and question|engine|n for repeats (sampling).
const akey = (qid, e, s) => (s ? `${qid}|${e}|${s}` : `${qid}|${e}`);
const answersOf = (M, qid, e) => Object.values(M.answers || {}).filter((a) => a.qid === qid && a.engine === e);
// Recommendation-gap rules live in public/recommendation-model.js (tested); the copy contract in product-language.js.
const RM = window.WP_RECOMMENDATION_MODEL;
const store = {
  get(k, d) { try { const v = localStorage.getItem("wpetal:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("wpetal:" + k, JSON.stringify(v)); } catch { try { for (let i = localStorage.length - 1; i >= 0; i--) { const kk = localStorage.key(i); if (kk && kk.startsWith("wpetal:prev:")) localStorage.removeItem(kk); } localStorage.setItem("wpetal:" + k, JSON.stringify(v)); } catch {} } },
};

/* =================================================================== API */
const APP = { cfg: { engines: [], llm: false, access: false }, code: store.get("code", ""), M: null, ctl: null, running: false };
// Every AI call says which brand it is for, so the organisation's usage meter can split spend by brand.
const aiHeaders = () => ({ "content-type": "application/json", "x-access-code": APP.code || "", "x-wp-brand": APP.M?.slug || "" });
async function post(path, payload, signal) {
  const r = await fetch(path, { method: "POST", headers: aiHeaders(), body: JSON.stringify(payload), signal, cache: "no-store" });
  if (r.status === 401) { if (APP.cfg.db) { APP.user = null; showAuth("signin"); throw new Error("Please sign in again."); } APP.code = ""; store.set("code", ""); APP.cfg.access = true; $("#accessRow").hidden = false; $("#accessCode").value = ""; throw new Error("That access code didn't work. Go back and enter it again (it's ACCESS_CODE in the server's environment)."); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Server error ${r.status}`);
  return d;
}
async function stream(path, payload, on, signal, idleMs = 75000) {
  const ctl = new AbortController(); let idle = false, timer;
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => { idle = true; ctl.abort(); }, idleMs); };
  const onOuter = () => ctl.abort(); signal?.addEventListener("abort", onOuter);
  if (signal?.aborted) ctl.abort();
  kick();
  try { return await streamInner(path, payload, on, ctl.signal, kick); }
  catch (e) { if (idle && !signal?.aborted) throw new Error("The AI went quiet for too long (timed out)."); throw e; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onOuter); }
}
async function streamInner(path, payload, on, signal, kick) {
  const r = await fetch(path, { method: "POST", headers: aiHeaders(), body: JSON.stringify(payload), signal, cache: "no-store" });
  if (r.status === 401) { if (APP.cfg.db) { APP.user = null; showAuth("signin"); throw new Error("Please sign in again."); } APP.code = ""; store.set("code", ""); APP.cfg.access = true; $("#accessRow").hidden = false; $("#accessCode").value = ""; throw new Error("That access code didn't work. Go back and enter it again (it's ACCESS_CODE in the server's environment)."); }
  if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); if (r.status === 402 && (d.code === "plan_limit" || d.code === "billing_read_only")) upgradeModal(d); throw Object.assign(new Error(d.error || `Server error ${r.status}`), { code: d.code, data: d }); }
  const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "", err = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    kick();
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of chunk.split("\n")) { if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
      if (!data) continue; let obj; try { obj = JSON.parse(data); } catch { continue; }
      if (ev === "error") err = new Error(obj.message || "Something failed");
      else if (on[ev]) on[ev](obj);
    }
  }
  if (err) throw err;
}

/* =================================================================== ACCOUNTS + DATA
   With a database (Cloud Run), brands and runs live on the server, per account, and scheduled checks keep adding
   runs. Without one (a plain local run), everything stays in this browser as before. The rest of the app goes
   through DATA and does not care which. */
APP.user = null; APP.prev = null;
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json", "x-wp-brand": APP.M?.slug || "" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin", cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && d.code === "auth") { APP.user = null; showAuth("signin"); throw new Error("Please sign in."); }
  if (!r.ok) { if (r.status === 402 && (d.code === "plan_limit" || d.code === "billing_read_only")) upgradeModal(d); throw Object.assign(new Error(d.error || `Server error ${r.status}`), { code: d.code, data: d }); }
  return d;
}
// A plan limit or a read-only account asks the person to pay, in a pop-up rather than a toast that fades.
let LIMIT_MSG = "";
function upgradeModal(d) {
  if ($(".modal.upsell")) return;
  const next = d.nextPlanName, ro = d.code === "billing_read_only";
  LIMIT_MSG = esc(d.error || "");
  const m = document.createElement("div"); m.className = "modal light upsell";
  m.innerHTML = `<div class="box" role="dialog" aria-modal="true"><h3>${ro ? "Choose a plan to continue" : d.trialDone ? "Your free trial check is done" : "You've reached your plan's limit"}</h3><p>${esc(d.error || "")}</p><div class="row" style="gap:8px"><button class="btn" type="button" data-up>${ro || d.trialDone ? "Choose a plan" : next ? `Upgrade to ${esc(next)}` : "See plans"}</button><button class="btn ghost" type="button" data-x>Not now</button></div></div>`;
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const close = () => { document.removeEventListener("keydown", key, true); m.remove(); };
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-x]")) close(); else if (e.target.closest("[data-up]")) { close(); openBilling(); } });
  document.addEventListener("keydown", key, true); document.body.append(m); m.querySelector("[data-up]").focus();
}
const DATA = {
  list: [],
  server: () => !!(APP.cfg.db && APP.user),
  async refresh() { if (!DATA.server()) return []; DATA.list = (await api("GET", "/api/workspaces")).workspaces || []; return DATA.list; },
  ws: (slug) => DATA.list.find((w) => w.slug === slug) || null,
  company(slug) {
    if (DATA.server()) { const w = DATA.ws(slug); return w && w.setup?.profile ? { slug, ...w.setup, schedule: w.schedule, samples: w.samples, parent: w.parent, market: w.market } : null; }
    return store.get("companies", {})[slug] || null;
  },
  companies() {
    // A brand's markets show under the brand (its market tabs), not as more brands.
    if (DATA.server()) return DATA.list.filter((w) => !w.parent).map((w) => ({ slug: w.slug, profile: w.setup?.profile || { name: w.name, site: w.site }, savedAt: Date.parse(w.updatedAt) || 0, ws: w, markets: DATA.list.filter((x) => x.parent === w.slug) }));
    return Object.values(store.get("companies", {})).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  },
  async saveCompany(c) {
    const cos = store.get("companies", {}); cos[c.slug] = c; store.set("companies", cos);
    if (!DATA.server()) return;
    const { slug, savedAt, schedule, samples, parent, market, ...setup } = c;
    const d = await api("PUT", "/api/workspaces/" + encodeURIComponent(slug), { name: c.profile.name, site: c.profile.site, setup, parent: parent || undefined, market: market || undefined });
    const i = DATA.list.findIndex((w) => w.slug === slug); const w = { ...(DATA.list[i] || {}), ...d.workspace };
    if (i >= 0) DATA.list[i] = w; else DATA.list.unshift(w);
    if (samples && samples !== w.samples) await DATA.patch(slug, { samples });
  },
  async patch(slug, body) {
    const d = await api("PATCH", "/api/workspaces/" + encodeURIComponent(slug), body);
    const i = DATA.list.findIndex((w) => w.slug === slug); if (i >= 0) DATA.list[i] = { ...DATA.list[i], ...d.workspace };
    return d.workspace;
  },
  // The brand's latest run (and the one before it, for "since last check" deltas).
  async open(slug) {
    if (DATA.server()) { const d = await api("GET", `/api/workspaces/${encodeURIComponent(slug)}/runs/latest`); APP.prev = d.prev || null; return d.run || null; }
    APP.prev = store.get("prev:" + slug, null);
    return store.get("mission:" + slug, null);
  },
  _t: 0, _busy: false, _again: false,
  // Live runs are saved to the server as they go (debounced), so another device, or a scheduled check, sees them.
  pushRun(M, now) {
    if (!DATA.server() || !M?.id) return;
    clearTimeout(DATA._t);
    const go = async () => {
      if (DATA._busy) { DATA._again = true; return; }
      DATA._busy = true;
      try { await api("PUT", "/api/runs/" + encodeURIComponent(M.id), { slug: M.slug, data: slim(M) }); DATA._fail = 0; }
      catch (e) {
        console.warn("[sync]", e.message);
        if (M.finishedAt) { if ((DATA._fail = (DATA._fail || 0) + 1) <= 3) DATA._again = true; else { DATA._fail = 0; toast("Couldn't save the finished check to your account. It's kept in this browser and syncs next time you open it."); } }
      }
      DATA._busy = false; if (DATA._again) { DATA._again = false; DATA._t = setTimeout(go, 1500); }
    };
    if (now || M.finishedAt) go(); else DATA._t = setTimeout(go, 4000);
  },
};
// A brand and its markets (country versions of its site), the brand first. Markets need an account; without one, a brand is one market.
function marketsOf(slug) {
  const w = DATA.ws(slug); if (!w) return [];
  const top = w.parent ? DATA.ws(w.parent) || w : w;
  return [top, ...DATA.list.filter((x) => x.parent === top.slug)];
}
const marketLabel = (w) => w?.market?.name || w?.setup?.profile?.market || "Global";
const trendOf = (slug) => (DATA.ws(slug)?.trend || []).map((t) => ({ at: Date.parse(t.started_at), source: t.source, ...t.summary })).filter((t) => t.n);

/* ---------- sign in / sign up / forgot / reset, and invite links ---------- */
let AUTH = { mode: "signup", after: null, invite: null, inviteInfo: null, reset: null };
function showAuth(mode = "signup", after) {
  AUTH.mode = mode; if (after !== undefined) AUTH.after = after;
  screen("auth"); paintAuth(); setTimeout(() => $(AUTH.mode === "signup" && !AUTH.inviteInfo ? "#authName" : AUTH.mode === "reset" ? "#authPass" : "#authEmail")?.focus(), 30);
}
function paintAuth() {
  const m = AUTH.mode, up = m === "signup", inv = AUTH.inviteInfo;
  $("#authTitle").textContent = { signup: inv ? `Join ${inv.org} on Perfstaq` : "Create your Perfstaq account", signin: inv ? `Sign in to join ${inv.org}` : "Sign in to Perfstaq", forgot: "Reset your password", reset: "Choose a new password" }[m];
  $("#authSub").textContent = m === "forgot" ? "We'll email you a link to set a new one." : m === "reset" ? "At least 8 characters. You'll be signed out everywhere else." : AUTH.after?.url ? `Then we'll start on ${host(AUTH.after.url)}.` : up ? "Track how AI search talks about your brand, every week." : "Welcome back.";
  $("#authInvite").hidden = !inv;
  if (inv) $("#authInvite").innerHTML = `${inv.inviter ? `<b>${esc(inv.inviter)}</b> invited <b>${esc(inv.email)}</b>` : `<b>${esc(inv.email)}</b> is invited`} to <b>${esc(inv.org)}</b> as ${esc({ owner: "the owner", admin: "an admin", editor: "an editor", viewer: "a viewer" }[inv.role] || inv.role)}.`;
  $$("#authForm [data-only]").forEach((el) => (el.hidden = !up));
  $("#authEmailRow").hidden = m === "reset";
  $("#authPassRow").hidden = m === "forgot";
  $("#authPassLbl").textContent = m === "reset" ? "New password" : "Password";
  if (inv) { $("#authEmail").value = inv.email; $("#authEmail").readOnly = true; } else $("#authEmail").readOnly = false;
  const g = !!APP.cfg.googleLogin && (m === "signup" || m === "signin");
  $("#authGoogle").hidden = !g; $("#authOr").hidden = !g;
  $("#authGo").textContent = { signup: inv ? "Create account and join" : "Create account", signin: inv ? "Sign in and join" : "Sign in", forgot: "Email me a link", reset: "Save and sign in" }[m];
  $("#authPass").autocomplete = up || m === "reset" ? "new-password" : "current-password";
  $("#authSwitchTxt").textContent = up ? "Already have an account?" : m === "signin" ? "New to Perfstaq?" : "Remembered it?";
  $("#authSwitch").textContent = up ? "Sign in" : m === "signin" ? "Create an account" : "Sign in";
  $("#authSwitch").parentElement.hidden = m === "reset";
  $("#authForgotRow").hidden = m !== "signin";
  $("#authErr").textContent = ""; $("#authOk").textContent = "";
}
$("#authSwitch").addEventListener("click", () => { AUTH.mode = AUTH.mode === "signin" ? "signup" : "signin"; paintAuth(); });
$("#authForgot").addEventListener("click", () => { AUTH.mode = "forgot"; paintAuth(); $("#authEmail").focus(); });
$("#authGoogle").addEventListener("click", () => { location.href = "/api/auth/google/start" + (AUTH.invite ? "?invite=" + encodeURIComponent(AUTH.invite) : ""); });
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const m = AUTH.mode, btn = $("#authGo");
  btn.setAttribute("aria-disabled", "true"); $("#authErr").textContent = ""; $("#authOk").textContent = "";
  try {
    if (m === "forgot") { await api("POST", "/api/auth/forgot", { email: $("#authEmail").value }); $("#authOk").textContent = "If there's an account for that email, a reset link is on its way. It works for an hour."; return; }
    const d = m === "reset" ? await api("POST", "/api/auth/reset", { token: AUTH.reset, password: $("#authPass").value })
      : await api("POST", m === "signup" ? "/api/auth/signup" : "/api/auth/login", { email: $("#authEmail").value, password: $("#authPass").value, name: $("#authName").value, invite: AUTH.invite || undefined });
    APP.user = d.user; $("#authPass").value = "";
    const joined = AUTH.inviteInfo; AUTH.invite = AUTH.inviteInfo = AUTH.reset = null;
    await reloadConfig(); await DATA.refresh();
    if (joined) toast(`You're in ${esc(joined.org)}.`);
    const after = AUTH.after; AUTH.after = null;
    if (await resumeIntent()) return;
    if (await maybeFirstRun()) return;
    if (after?.url && canEdit()) return startOnboarding(after.url);
    return home();
  } catch (err) { $("#authErr").textContent = err.message; }
  finally { btn.removeAttribute("aria-disabled"); }
});
$("#lpAuth").addEventListener("click", () => showAuth("signin", null));
$("#signOut").addEventListener("click", async () => { try { await api("POST", "/api/auth/logout"); } catch {} APP.user = null; APP.org = null; APP.orgs = []; DATA.list = []; APP.M = null; goHome(); });

// The organisation this session works in, and what the person may do there.
APP.org = null; APP.orgs = []; APP.operator = false;
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const roleAtLeast = (r) => !DATA.server() || (ROLE_RANK[APP.org?.role] ?? -1) >= ROLE_RANK[r];
const canEdit = () => roleAtLeast("editor");
const canAdmin = () => roleAtLeast("admin");
async function reloadConfig() {
  try { APP.cfg = await (await fetch("/api/config", { cache: "no-store" })).json(); } catch {}
  APP.user = APP.cfg.user || null; APP.org = APP.cfg.org || null; APP.orgs = APP.cfg.orgs || []; APP.operator = !!APP.cfg.operator;
  if (APP.cfg.budget?.over) toast(APP.cfg.budget.source === "plan" ? "This plan's AI allowance is used up. Upgrade in Plans &amp; payment, or it resets with your next billing period." : "This organisation has used its monthly AI budget. An admin can raise it in Team & keys.");
  else if (APP.cfg.budget?.warn) toast(`This organisation has used ${Math.round((APP.cfg.budget.pct || 0) * 100)}% of its ${APP.cfg.budget.source === "plan" ? "plan's AI allowance" : "monthly AI budget"}.`);
  else billingToast(APP.cfg.billing);
  paintTrialPill();
}
// A payment can land while the tab sits in the background (a webhook converts the trial, a renewal fails): coming back refreshes the
// plan pill, quietly and at most once a minute. The server enforces the real state either way.
let billSeen = 0;
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !APP.user || !billingOn() || Date.now() - billSeen < 60e3) return; billSeen = Date.now();
  try { const c = await (await fetch("/api/config", { cache: "no-store" })).json(); if (c.billing) { APP.cfg.billing = c.billing; paintTrialPill(); } } catch {}
});
// Trial and payment state, said once on load. The server enforces all of it; this only explains.
function billingToast(b) {
  if (!b || !billingOn() || b.plan.status === "new") return; // the plans page opens instead
  const left = b.trialEndsAt ? Math.ceil((new Date(b.trialEndsAt) - Date.now()) / 864e5) : null;
  if (b.mode === "read") toast(b.plan.status === "trialing" ? "Your trial has ended. Choose a plan in Plans &amp; payment to keep running checks. Your reports stay readable." : "This organisation is read-only until the plan is paid. See Plans &amp; payment.");
  else if (b.mode === "manual") toast(`Your last payment failed. Update your payment method by ${new Date(b.graceEndsAt).toLocaleDateString()} to keep scheduled checks running.`);
  else if (b.plan.status === "trialing" && !b.paymentMethod?.connected && left != null && left <= 2 && !PAY_HIDDEN) toast(`Your trial ends ${left <= 0 ? "today" : left === 1 ? "tomorrow" : "in 2 days"}. Choose a plan in Plans &amp; payment to keep going.`); // PAY_HIDDEN: no "choose a plan" reminder
}
// Invite links (#invite=…), password resets (#reset=…) and Google sign-in errors (#auth-error=…).
async function handleAuthHash() {
  const h = location.hash;
  const inv = h.match(/^#invite=([A-Za-z0-9_-]+)/), rst = h.match(/^#reset=([A-Za-z0-9_-]+)/), ae = h.match(/^#auth-error=(.*)$/), ver = h.match(/^#verify=([A-Za-z0-9_-]+)/);
  if (!inv && !rst && !ae && !ver) return false;
  history.replaceState(null, "", location.pathname);
  if (ver) { try { await api("POST", "/api/auth/verify", { token: ver[1] }); await reloadConfig(); toast("Email confirmed. Thanks."); } catch (e) { toast(esc(e.message)); } return false; }
  if (ae) { showAuth("signin", null); $("#authErr").textContent = decodeURIComponent(ae[1]); return true; }
  if (rst) { AUTH.reset = rst[1]; showAuth("reset", null); return true; }
  let info;
  try { info = await api("GET", "/api/invitations/" + inv[1]); }
  catch (e) { showAuth("signin", null); $("#authErr").textContent = e.message; return true; }
  if (APP.user) {
    if (APP.user.email.toLowerCase() !== info.email.toLowerCase()) {
      toast(`That invite is for ${esc(info.email)}, and you're signed in as ${esc(APP.user.email)}. Sign out, then open the link again.`);
      return false;
    }
    try { await api("POST", `/api/invitations/${inv[1]}/accept`); await reloadConfig(); await DATA.refresh(); toast(`You're in ${esc(info.org)}.`); } catch (e) { toast(esc(e.message)); }
    return false;
  }
  AUTH.invite = inv[1]; AUTH.inviteInfo = info;
  showAuth(info.account ? "signin" : "signup", null);
  return true;
}

// Signed in: straight to the most recently used brand. Otherwise the landing page.
async function home() {
  if (DATA.server()) {
    const first = DATA.companies()[0];
    if (first) { const ok = await openBrand(first.slug, { quiet: true }); if (ok) return; }
  }
  goHome();
}
async function openBrand(slug, { quiet } = {}) {
  let run = null;
  try { run = await DATA.open(slug); } catch (e) { if (!quiet) toast(esc(e.message)); return false; }
  // The server's copy lacks the finish (the final save failed or has not landed yet) but this browser has the finished check: use it and send it again,
  // instead of showing a finished analysis as "paused".
  if (DATA.server() && !run?.finishedAt) { const local = store.get("mission:" + slug, null); if (local?.finishedAt && !local.abandoned && (!run || run.id === local.id || (local.startedAt || 0) >= (run.startedAt || 0))) { run = local; DATA.pushRun(local, true); } }
  if (run?.finishedAt && !run.abandoned) { APP.M = run; DASH.page = "overview"; showReport(); return true; }
  // An unfinished check opens paused. Opening a brand never asks AI anything by itself; "Resume" does.
  if (run && run.profile && run.done && !run.finishedAt) { APP.M = run; DASH.page = "overview"; showRunning(); return true; }
  // No saved check yet: setting it up reads the site again (an AI call), so ask first instead of starting on open.
  const c = DATA.company(slug); if (!c || quiet) return false;
  modal(`<span class="status">Not checked yet</span><h3>${esc(c.profile.name)} has no results yet</h3><p class="muted">Setting it up reads ${esc(host(c.profile.site))} again, then asks AI your prompts. It takes a few minutes.</p><div class="ob-btns"><button class="btn" type="button" data-obgo>Set it up now</button></div>`);
  $(".modal:last-of-type [data-obgo]").addEventListener("click", () => startOnboarding(c.profile.site, c));
  return true;
}

/* ---------- landing: signed out it explains; signed in it is your brand list ---------- */
const sparkline = (vals, w = 96, h = 26) => {
  const v = vals.filter((x) => x != null); if (v.length < 2) return "";
  const max = Math.max(0.05, ...v), min = Math.min(...v, 0), step = w / (v.length - 1);
  const pts = v.map((x, i) => `${(i * step).toFixed(1)},${(h - 2 - ((x - min) / (max - min || 1)) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
};
// The account button at the bottom of the sidebar: who is signed in, and which team.
function paintAccount() {
  const signedIn = DATA.server();
  const who = signedIn ? (APP.user.name || APP.user.email.split("@")[0]) : "Not signed in";
  $("#signOut").hidden = !signedIn;
  // The dashboard's one profile control (bottom of the sidebar): who, the plan and where it stands, and the plan card in its menu.
  const st = signedIn ? planLine(APP.cfg.billing) : { text: "", tone: "" }, b = APP.cfg.billing, bill = signedIn && billingOn() && b && (b.plan.status !== "internal" || !!b.checkout?.enabled);
  $("#acctAv").textContent = who.charAt(0).toUpperCase();
  $("#acctName").textContent = who;
  $("#acctEmail").textContent = signedIn ? APP.user.email : "";
  $("#acctEmail").hidden = !signedIn;
  $("#acctOrg").textContent = signedIn && APP.org ? APP.org.name : "";
  const ap = $("#acctPlan"); ap.hidden = !bill;
  if (bill) { ap.className = "pf-plan " + (st.tone || ""); ap.innerHTML = `<div><span class="bl-kicker">Plan</span><b>${esc(b.plan.status === "new" ? "No plan yet" : b.plan.status === "trialing" ? "Free trial" : b.plan.name)}</b><span>${esc(st.detail || st.text)}</span></div>${st.cta ? `<button type="button" class="btn sm" data-pfgo="billing">${esc(st.cta)}</button>` : ""}`; }
}
function paintLanding() {
  const signedIn = DATA.server();
  $("#lpAuth").hidden = !APP.cfg.auth || signedIn;
  paintProfile();
  $("#startForm").hidden = signedIn && !canEdit();
  paintAccount();
  const avail = (APP.cfg.engines || []).map((e) => ENG[e]).filter(Boolean);
  $("#lpEngines").innerHTML = avail.length ? `<span class="muted">Checks</span> ${avail.map((n) => `<span class="eng-pill">${esc(n)}</span>`).join("")}` : "";
  const list = signedIn ? DATA.companies() : [];
  $("#lpBrands").hidden = !list.length;
  $("#lpKicker").textContent = signedIn ? (list.length ? `${APP.org?.name || "Your"} brands` : canEdit() ? "Add your first brand" : "No brands yet") : "AI search visibility";
  $("#lpTitle").innerHTML = signedIn && !canEdit() ? (list.length ? "Your team's brands" : "Nothing to show yet") : signedIn && list.length ? "Add another brand" : "Will AI <em>recommend you?</em>";
  if (signedIn && !canEdit() && !list.length) { $("#lpSub").hidden = false; $("#lpSub").textContent = "You can view this organisation's brands. When an editor adds one, it appears here."; }
  $("#lpSub").hidden = signedIn && list.length > 0;
  $$(".howto").forEach((h) => (h.hidden = signedIn && list.length > 0));
  if (!list.length) return;
  $("#lpBrands").innerHTML = list.map((c) => {
    const w = c.ws || {}, t = (w.trend || []).slice().reverse(), last = t[t.length - 1]?.summary;
    return `<button type="button" class="bcard" data-brand="${esc(c.slug)}">${favImg(host(c.profile.site))}<span class="bc-main"><b>${esc(c.profile.name)}</b><span class="muted">${esc(host(c.profile.site || ""))}</span></span>
      <span class="bc-num"><b>${last ? last.score : "–"}</b><span class="muted">score</span></span><span class="bc-num"><b>${last ? pct(last.visibility, 0) : "–"}</b><span class="muted">visibility</span></span>
      <span class="bc-spark">${sparkline(t.map((x) => x.summary?.visibility))}</span>
      ${c.markets?.length ? `<span class="bc-mk">${c.markets.length + 1} markets</span>` : ""}<span class="bc-sched ${w.schedule && w.schedule !== "off" ? "on" : ""}">${w.schedule && w.schedule !== "off" ? `${w.schedule === "daily" ? "Daily" : "Weekly"} checks` : "Manual"}</span></button>`;
  }).join("");
}
$("#lpBrands").addEventListener("click", (e) => { const b = e.target.closest("[data-brand]"); if (b) openBrand(b.dataset.brand); });

/* =================================================================== LANDING */
function stars() {
  const c = $("#stars"); if (!c) return; const x = c.getContext("2d"); let w, h, pts;
  const init = () => { w = c.width = innerWidth * devicePixelRatio; h = c.height = $("#landing").offsetHeight * devicePixelRatio; c.style.height = $("#landing").offsetHeight + "px";
    pts = Array.from({ length: Math.min(90, Math.round(innerWidth / 14)) }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25, o: Math.random() < .12 })); };
  init(); addEventListener("resize", init);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tick = () => {
    if ($("#landing").hidden) return requestAnimationFrame(tick);
    x.clearRect(0, 0, w, h);
    const d = 150 * devicePixelRatio;
    for (const p of pts) { if (!reduce) { p.x += p.vx; p.y += p.vy; } if (p.x < 0 || p.x > w) p.vx *= -1; if (p.y < 0 || p.y > h) p.vy *= -1; }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j], dd = Math.hypot(a.x - b.x, a.y - b.y);
      if (dd < d) { x.strokeStyle = `rgba(${a.o || b.o ? "255,122,26" : "140,140,146"},${(1 - dd / d) * .22})`; x.lineWidth = devicePixelRatio; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); }
    }
    for (const p of pts) { x.fillStyle = p.o ? "#FF7A1A" : "rgba(242,242,240,.5)"; x.beginPath(); x.arc(p.x, p.y, (p.o ? 2.2 : 1.3) * devicePixelRatio, 0, 7); x.fill(); }
    requestAnimationFrame(tick);
  };
  tick();
}
function unfinished() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith("wpetal:mission:")) continue; const m = JSON.parse(localStorage.getItem(k)); if (m && !m.finishedAt && m.profile && m.done) out.push(m); } } catch {}
  return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
function renderRecent() {
  paintLanding();
  if (DATA.server()) { $("#recent").innerHTML = ""; return; }
  const cos = store.get("companies", {});
  const list = Object.values(cos).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 6);
  const open = unfinished()[0];
  const res = open ? `<div class="resume" style="width:100%;display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap;margin-bottom:6px"><span style="color:var(--ink)">Your check of <b>${esc(open.profile.name)}</b> was interrupted.</span><button type="button" data-resume="${esc(open.slug)}" style="border-color:var(--petal);color:var(--ink)">Resume where it stopped</button><button type="button" data-discard="${esc(open.slug)}">Discard</button></div>` : "";
  $("#recent").innerHTML = res + (list.length ? `<span>Saved companies:</span>` + list.map((c) => `<button type="button" data-slug="${esc(c.slug)}">${esc(c.profile.name)}</button>`).join("") : "");
  // Still running in another tab? Say so instead of calling it interrupted.
  if (open) lockedElsewhere(open.slug).then((busy) => {
    const box = $("#recent .resume"); if (!busy || !box) return;
    box.querySelector("span").innerHTML = `<b>${esc(open.profile.name)}</b> is running in another tab right now.`;
    const r = box.querySelector("[data-resume]"); r.textContent = "Continue here instead"; r.dataset.takeover = "1";
    box.querySelector("[data-discard]")?.remove();
  });
}
$("#startErr").addEventListener("click", (e) => { if (e.target.dataset.takeover) { localStorage.removeItem("wpetal:lock:" + (e.target.dataset.resume || e.target.dataset.slug)); $("#recent").dispatchEvent(new CustomEvent("takeover", { detail: e.target.dataset })); } });
$("#recent").addEventListener("takeover", (e) => { const d = e.detail; const fake = { target: { dataset: { ...d } } }; recentClick(fake); });
$("#recent").addEventListener("click", (e) => recentClick(e));
async function recentClick(e) {
  const s = e.target.dataset.slug, r = e.target.dataset.resume, x = e.target.dataset.discard;
  if (x) { const m = store.get("mission:" + x, null); if (m) { m.finishedAt = m.finishedAt || Date.now(); m.abandoned = true; store.set("mission:" + x, m); } return renderRecent(); }
  const slug = s || r; if (!slug) return;
  if (DATA.server()) return openBrand(slug);
  if (!e.target.dataset.takeover && (await lockedElsewhere(slug))) {
    $("#startErr").innerHTML = `This brand looks busy in another tab. <button type="button" class="linkbtn" style="color:var(--petal);text-decoration:underline" data-takeover="1" data-${r ? "resume" : "slug"}="${esc(slug)}">Continue here instead</button>`;
    return;
  }
  $("#startErr").textContent = "";
  if (e.target.dataset.takeover && BC) { BC.postMessage({ type: "takeover", slug }); await sleep(500); }
  const m = store.get("mission:" + slug, null);
  if (r && m) return resumeMission(m);
  if (m && m.finishedAt && !m.abandoned) { APP.M = m; showReport(); } else { const c = store.get("companies", {})[slug]; if (c) startOnboarding(c.profile.site, c); }
}
$("#startForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#startUrl").value.trim();
  if (!url) return $("#startUrl").focus();
  if (APP.cfg.access) { APP.code = $("#accessCode").value.trim() || APP.code; store.set("code", APP.code); if (!APP.code) { $("#startErr").textContent = "Enter the access code first."; return; } }
  if (APP.cfg.auth && !APP.user) return showAuth("signup", { url });
  if (!APP.cfg.engines.length) { $("#startErr").textContent = "No AI engine is configured on the server. Add GEMINI_API_KEY (free) to the environment variables."; return; }
  startOnboarding(url);
});

/* =================================================================== MISSION UI */
// The counters and phase bars for a run that's already (partly) done: what was saved, without re-asking anything.
function fillHud(M) {
  const fin = Object.values(M.answers || {}).filter((a) => a.status === "yes" || a.status === "no"), done = M.done || {};
  bump("q", M.questions.length); bump("a", fin.length); bump("s", fin.reduce((s, a) => s + Math.max(a.nS || 0, (a.searches || []).length), 0)); bump("src", fin.reduce((s, a) => s + Math.max(a.nSrc || 0, (a.sources || []).length), 0)); bump("p", Object.keys(M.inspections || {}).length); bump("r", Object.keys(rivalCounts(M)).length); bump("d", Object.keys(M.pitches || {}).length + (M.assets ? 1 : 0));
  PHASES.forEach(([k]) => { if (done[{ site: "questions", questions: "questions", ask: "ask", sources: "sources", think: "insights", draft: "draft" }[k]] || k === "site") finishPhase(k); });
}
const PHASES = [["site", "Read site"], ["questions", "Questions"], ["ask", "Ask AI live"], ["sources", "Follow sources"], ["think", "Analyse"], ["draft", "Draft fixes"]];
const CTRS = [["q", "Questions"], ["a", "Answers"], ["s", "Searches"], ["src", "Sources"], ["p", "Pages opened"], ["r", "Rivals seen"], ["c", "Contacts"], ["d", "Drafts"]];
const C = {};
function setupHud() {
  $("#track").innerHTML = PHASES.map(([k, l]) => `<div data-ph="${k}"><span>${l}</span><i style="--p:0%"></i></div>`).join("");
  $("#counters").innerHTML = CTRS.map(([k, l]) => `<div class="ctr" data-c="${k}"><b class="tnum">0</b><span>${l}</span></div>`).join("");
  CTRS.forEach(([k]) => (C[k] = 0));
}
const bumpAt = {};
function bump(k, n = 1) {
  C[k] = (C[k] || 0) + n; const el = $(`[data-c="${k}"]`); if (!el) return;
  el.querySelector("b").textContent = C[k];
  const now = Date.now(); if (now - (bumpAt[k] || 0) < 600) return; bumpAt[k] = now;
  el.classList.remove("bump"); requestAnimationFrame(() => el.classList.add("bump"));
}
function phase(k, pct, label) {
  $$("#track > div").forEach((d) => d.classList.toggle("on", d.dataset.ph === k));
  const el = $(`[data-ph="${k}"] i`); if (el) el.style.setProperty("--p", Math.round(pct) + "%");
  if (label) $("#hudPhase").textContent = label;
}
function finishPhase(k) { const el = $(`[data-ph="${k}"] i`); if (el) el.style.setProperty("--p", "100%"); }
function setRing(v) {
  const arc = $("#ringArc"); arc.style.strokeDashoffset = String(144.5 * (1 - (v || 0) / 100));
  $("#ringV").textContent = v == null ? "–" : v;
}

// ---- feed
let stick = true;
$("#feed").addEventListener("scroll", () => { const f = $("#feed"); stick = f.scrollHeight - f.scrollTop - f.clientHeight < 140; $("#jump").hidden = stick; });
$("#jump").addEventListener("click", () => { stick = true; scrollFeed(); $("#jump").hidden = true; });
function scrollFeed() { if (!stick) return; const f = $("#feed"); f.scrollTop = f.scrollHeight; if (innerWidth <= 980) { /* page scroll on mobile */ } }
function add(html, cls = "") { const d = document.createElement("div"); d.className = "ev " + cls; d.innerHTML = html; $("#feed").append(d); scrollFeed(); return d; }
function thought(text, why) { return add(`${text}${why ? `<span class="why">Why: ${why}</span>` : ""}`, "thought"); }
function stepEl(text, why) {
  const el = add(`<span class="ic"></span><div><span class="tx">${esc(text)}</span>${why ? `<span class="why">${esc(why)}</span>` : ""}</div>`, "step run");
  return { done(t, ok = true) { el.className = "ev step " + (ok ? "ok" : "bad"); el.querySelector(".ic").textContent = ok ? "✓" : "!"; if (t) el.querySelector(".tx").textContent = t; } };
}
let toastT;
// Messages: one at a time, bottom centre. tone: ok | info | warn | bad (a coloured mark), or none.
function toast(html, tone = "") { if (html && html === LIMIT_MSG) { LIMIT_MSG = ""; return; } let t = $(".toast"); if (!t) { t = document.createElement("div"); t.setAttribute("role", "status"); document.body.append(t); } t.className = "toast" + (tone ? " t-" + tone : ""); t.innerHTML = `${tone ? `<i class="t-mark" aria-hidden="true">${icon(tone === "ok" ? "check" : tone === "bad" ? "x" : "info", 13)}</i>` : ""}<span>${html}</span>`; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), Math.max(4200, String(html).length * 55)); }

/* =================================================================== HIGHLIGHT */
function namesFor(M, extra = []) {
  const b = M.profile;
  const you = [b.name, host(b.site || "").split(".")[0]].filter((x) => x && x.length >= 3);
  const rivals = [...new Set([...(b.competitors || []), ...extra])].filter((x) => x && x.length >= 2 && !you.some((y) => norm(y) === norm(x)));
  return { you, rivals };
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function highlight(text, M, extra) {
  const { you, rivals } = namesFor(M, extra);
  let h = esc(text);
  const all = [...you.map((n) => [n, "you"]), ...rivals.map((n) => [n, ""])].sort((a, b) => b[0].length - a[0].length);
  for (const [n, cls] of all) {
    const re = new RegExp(`(?<![\\w>])(${reEsc(esc(n))})(?![\\w<])`, "gi");
    h = h.replace(re, (m, g, off, str) => { const before = str.slice(0, off); return before.lastIndexOf("<mark") > before.lastIndexOf("</mark>") ? m : `<mark class="${cls}">${g}</mark>`; });
  }
  return h;
}
const isYou = (name, M) => { const n = norm(name); return namesFor(M).you.some((y) => { const a = norm(y); return n === a || (" " + n + " ").includes(" " + a + " "); }); };
const textHasYou = (t, M) => { const x = " " + norm(t) + " "; return namesFor(M).you.some((y) => x.includes(" " + norm(y) + " ")); };
function md(t) {
  const lines = esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').split("\n");
  let out = "", list = null, table = null;
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const flush = () => { if (!table) return; const [h, ...rows] = table; out += `<div class="md-tw"><table class="md-t"><thead><tr>${h.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; table = null; };
  for (const l of lines) {
    // Markdown tables (| a | b |), which AI answers use for comparisons; the |---| rule line is dropped.
    if (/^\s*\|.*\|\s*$/.test(l)) { if (list) { out += `</${list}>`; list = null; } if (!/^\s*\|?\s*:?-{2,}/.test(l)) (table = table || []).push(cells(l)); continue; }
    flush();
    const li = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { if (!list) { list = /^\s*\d/.test(l) ? "ol" : "ul"; out += `<${list}>`; } out += `<li>${li[1]}</li>`; continue; }
    if (list) { out += `</${list}>`; list = null; }
    if (/^#{1,4}\s/.test(l)) out += `<h4>${l.replace(/^#{1,4}\s/, "")}</h4>`;
    else if (l.trim()) out += `<p>${l}</p>`;
  }
  flush();
  if (list) out += `</${list}>`;
  return out;
}

/* =================================================================== LIVE MAP (d3) */
const G = { nodes: new Map(), links: new Map(), sim: null, pending: false };
function gInit() {
  const svg = d3.select("#map"); svg.selectAll("*").remove();
  G.nodes.clear(); G.links.clear();
  const root = svg.append("g");
  G.gl = root.append("g"); G.gn = root.append("g");
  svg.call(d3.zoom().scaleExtent([0.3, 4]).on("zoom", (e) => root.attr("transform", e.transform)));
  const box = () => $("#map").getBoundingClientRect();
  G.sim = d3.forceSimulation().alphaDecay(0.045).velocityDecay(0.5)
    .force("charge", d3.forceManyBody().strength((d) => (d.type === "you" ? -1200 : d.type === "rival" ? -420 : d.type === "source" ? -160 : -90)).distanceMax(600))
    .force("link", d3.forceLink().id((d) => d.id).distance((l) => l.dist || 70).strength((l) => l.str ?? 0.35))
    .force("x", d3.forceX(() => box().width / 2).strength(0.025))
    .force("y", d3.forceY(() => box().height / 2).strength(0.03))
    .force("collide", d3.forceCollide((d) => d.r + (d.type === "question" ? 4 : 14)))
    .on("tick", () => {
      G.gl.selectAll("line").attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y).attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      G.gn.selectAll("g.node").attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
  new ResizeObserver(() => G.sim.alpha(0.3).restart()).observe($("#map"));
}
const MAP_CAP = { source: 36, rival: 22, question: 40 };
function gNode(id, type, label, data = {}) {
  let n = G.nodes.get(id);
  if (!n && MAP_CAP[type] && [...G.nodes.values()].filter((x) => x.type === type).length >= MAP_CAP[type]) return { weight: 0 }; // too many to draw; the counters and tables still have everything
  const b = $("#map").getBoundingClientRect();
  if (!n) { n = { id, type, label, x: b.width / 2 + (Math.random() - .5) * 120, y: b.height / 2 + (Math.random() - .5) * 120, weight: 0, ...data }; if (type === "you") { n.fx = null; } G.nodes.set(id, n); }
  else Object.assign(n, data, { label: label || n.label });
  n.r = type === "you" ? 24 : type === "rival" ? Math.min(24, 8 + n.weight * 1.6) : type === "question" ? 6 : Math.min(15, 5 + n.weight * 1.5);
  gSchedule(); gFlash(id); return n;
}
function gLink(a, b, kind, color) {
  const id = a + "→" + b + "|" + kind;
  if (!G.links.has(id)) G.links.set(id, { id, source: a, target: b, kind, color, dist: kind === "cited" ? 90 : kind === "on" ? 110 : 150, str: kind === "named" ? 0.12 : 0.25 });
  gSchedule();
}
function gSchedule() { if (G.pending) return; G.pending = true; setTimeout(() => { G.pending = false; if (!document.hidden) gRender(); else gSchedule(); }, 700); }
function nodeColor(d) {
  if (d.type === "you") return "#FF7A1A";
  if (d.type === "rival") return "#E2483D";
  if (d.type === "question") return d.named ? "#FFC46B" : "#A79BFF";
  return "#3CC9B5";
}
function nodeStroke(d) { if (d.type === "source" && d.inspected) return d.you ? "#45D19A" : d.rivals ? "#E2483D" : "#5A5A5E"; return "#0B0B0C"; }
function gRender() {
  const nodes = [...G.nodes.values()], links = [...G.links.values()].filter((l) => G.nodes.has(l.source.id || l.source) && G.nodes.has(l.target.id || l.target));
  G.gl.selectAll("line").data(links, (d) => d.id).join((en) => en.append("line").attr("class", "link"))
    .attr("stroke", (d) => d.color || "#5A5A5E").attr("stroke-width", (d) => (d.kind === "named" ? 1.4 : 1)).attr("stroke-dasharray", (d) => (d.kind === "cited" ? "3 3" : null));
  const g = G.gn.selectAll("g.node").data(nodes, (d) => d.id).join((en) => {
    const e = en.append("g").attr("class", (d) => "node " + d.type);
    e.append("circle"); e.append("text").attr("dy", (d) => (d.type === "you" ? 40 : d.type === "rival" ? -12 : 18)).attr("text-anchor", "middle");
    e.on("mouseenter", (ev, d) => tip(ev, d)).on("mousemove", (ev) => moveTip(ev)).on("mouseleave", hideTip).on("click", (ev, d) => openDrawer(d));
    e.call(d3.drag().on("start", (ev, d) => { if (!ev.active) G.sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; }).on("end", (ev, d) => { if (!ev.active) G.sim.alphaTarget(0); d.fx = null; d.fy = null; }));
    return e;
  });
  g.select("circle").attr("r", (d) => d.r).attr("fill", nodeColor).attr("stroke", nodeStroke).attr("stroke-width", (d) => (d.type === "source" && d.inspected ? 2.5 : 1.5))
    .attr("fill-opacity", (d) => (d.type === "source" && d.inspected && !d.you && !d.rivals ? 0.45 : 1));
  g.select("text").text((d) => (d.type === "question" ? "" : (d.label || "").slice(0, d.type === "source" ? 22 : 26)));
  G.sim.nodes(nodes); G.sim.force("link").links(links); G.sim.alpha(Math.min(0.45, G.sim.alpha() + 0.25)).restart();
}
function gFlash(id) { setTimeout(() => { const el = G.gn && G.gn.selectAll("g.node").filter((d) => d.id === id).node(); if (el) { el.classList.remove("flash"); void el.getBBox(); el.classList.add("flash"); } }, 200); }
const tipEl = $("#tip");
function tip(ev, d) {
  const M = APP.M; let h = `<b>${esc(d.label)}</b>`;
  if (d.type === "question") h = `<span class="muted">Buyer question</span><br><b>${esc(d.label)}</b>`;
  if (d.type === "rival") h += `<br><span class="muted">Named in ${d.weight} answer${d.weight === 1 ? "" : "s"}${d.pages ? ` · on ${d.pages} cited page${d.pages === 1 ? "" : "s"}` : ""}</span>`;
  if (d.type === "source") h += `<br><span class="muted">Cited ${d.weight}× · ${d.inspected ? (d.you ? "you're on it" : "you're not on it") : "not opened yet"}</span>`;
  if (d.type === "you") h += `<br><span class="muted">Named in ${M ? countNamed(M) : 0} answers</span>`;
  tipEl.innerHTML = h + `<br><span class="muted" style="font-size:.7rem">click for details</span>`; tipEl.hidden = false; moveTip(ev);
}
function moveTip(ev) { tipEl.style.left = Math.min(innerWidth - 290, ev.clientX + 14) + "px"; tipEl.style.top = ev.clientY + 14 + "px"; }
function hideTip() { tipEl.hidden = true; }
function openDrawer(d) {
  const M = APP.M; if (!M) return;
  $$(".drawer").forEach((x) => x.remove());
  const dr = document.createElement("div"); dr.className = "drawer";
  let h = `<button class="linkbtn x" type="button" aria-label="Close">✕</button>`;
  const ans = Object.values(M.answers);
  if (d.type === "question") {
    const q = M.questions.find((x) => "q:" + x.id === d.id);
    h += `<span class="status">Buyer question · ${esc(q?.intent || "")}</span><h3>${esc(d.label)}</h3>`;
    ans.filter((a) => "q:" + a.qid === d.id).forEach((a) => { h += `<div class="card"><div class="hd"><span class="eng"><i style="background:${ENGC[a.engine]}"></i>${ENG[a.engine]}</span><span class="sp"></span>${verdictHtml(a)}</div><div class="answer full">${highlight(a.answer || "", M, a.brands)}</div>${srcChips(a.sources)}</div>`; });
  } else if (d.type === "rival" || d.type === "you") {
    const name = d.label; const qs = ans.filter((a) => (d.type === "you" ? a.named : (a.brands || []).some((b) => norm(b) === norm(name))));
    const pages = Object.values(M.inspections || {}).filter((p) => p.ok && (d.type === "you" ? p.you : (p.rivals || []).some((r) => norm(r) === norm(name))));
    h += `<span class="status">${d.type === "you" ? "You" : "Rival"}</span><h3>${esc(name)}</h3><p class="muted">Named in ${qs.length} of ${ans.filter((a) => a.status !== "run").length} answers. On ${pages.length} of the ${Object.keys(M.inspections || {}).length} cited pages I opened.</p>`;
    if (qs.length) h += `<b style="font-size:.85rem">Named for</b><div class="chips">${[...new Set(qs.map((a) => qText(M, a.qid)))].map((q) => `<span class="chip">${esc(q)}</span>`).join("")}</div>`;
    if (pages.length) h += `<b style="font-size:.85rem">Pages that carry ${d.type === "you" ? "you" : "it"}</b>` + pages.map((p) => `<div class="irow"><span class="chip ${d.type === "you" ? "you" : "rv"}">${esc(p.domain)}</span><div><a href="${esc(safeUrl(p.final) || "#")}" target="_blank" rel="noopener">${esc(p.title || p.final)}</a>${(p.evidence || []).filter((e) => norm(e.name) === norm(name)).map((e) => `<div class="ev2">“${highlight(e.snippet, M)}”</div>`).join("")}</div></div>`).join("");
  } else if (d.type === "source") {
    const dom = d.id.slice(2); const url = d.url;
    const pages = Object.values(M.inspections || {}).filter((x) => host(x.url) === dom);
    const p = pages.find((x) => x.ok) || pages[0];
    const by = ans.filter((a) => (a.sources || []).some((s) => host(s.url) === dom));
    h += `<span class="status">${esc(dom)} · cited ${d.weight}× across answers${pages.length > 1 ? ` · ${pages.length} pages opened` : ""}</span><h3>${esc(p?.title || d.label)}</h3><a href="${esc(safeUrl(url) || "#")}" target="_blank" rel="noopener" style="font-size:.8rem;overflow-wrap:anywhere">${esc(url)}</a>`;
    if (p && p.ok) h += `<div class="chips">${p.you ? '<span class="chip ok">You are on this page</span>' : '<span class="chip no">You are not on this page</span>'}${(p.rivals || []).map((r) => `<span class="chip rv">${esc(r)}</span>`).join("")}</div>${(p.evidence || []).map((e) => `<div class="ev2" style="font-size:.8rem;color:var(--muted)">“${highlight(e.snippet, M)}”</div>`).join("")}${contactHtml(p.contacts)}`;
    else if (p) h += `<p class="muted">Couldn't open it: ${esc(p.reason || "")}</p>`;
    h += `<b style="font-size:.85rem">Cited for</b><div class="chips">${[...new Set(by.map((a) => qText(M, a.qid)))].map((q) => `<span class="chip">${esc(q)}</span>`).join("")}</div>`;
  }
  dr.innerHTML = h; $(".mapwrap").append(dr);
  dr.querySelector(".x").onclick = () => dr.remove();
}
const sidOf = (u) => "s:" + host(u);
const qText = (M, qid) => (M.questions.find((q) => q.id === qid) || {}).text || "";
function srcChips(src) { return `<div class="srcs">${(src || []).slice(0, 12).map((s) => `<a class="src${s.cited ? "" : " weak"}" href="${esc(safeUrl(s.url) || "#")}" target="_blank" rel="noopener" title="${esc(s.title || s.url)}">${esc(host(s.url))}</a>`).join("")}</div>`; }
function contactHtml(c) { if (!c) return ""; const bits = []; if (c.author) bits.push(`Author: <b>${esc(c.author)}</b>`); (c.emails || []).forEach((m) => bits.push(`<span class="mono">${esc(m)}</span>`)); (c.links || []).slice(0, 2).forEach((l) => bits.push(`<a href="${esc(l)}" target="_blank" rel="noopener">${esc(host(l))}${esc((() => { try { return new URL(l).pathname.slice(0, 24); } catch { return ""; } })())}</a>`)); return bits.length ? `<div class="chips" style="font-size:.78rem">${bits.map((b) => `<span class="chip">${b}</span>`).join("")}</div>` : ""; }
function verdictHtml(a) { return a.status === "run" ? '<span class="verdict wait">reading…</span>' : a.status === "err" ? '<span class="verdict wait">failed</span>' : a.named ? `<span class="verdict yes">NAMED${a.rank ? " #" + a.rank : ""}</span>` : '<span class="verdict no">NOT NAMED</span>'; }
function countNamed(M) { return Object.values(M.answers).filter((a) => a.named).length; }

/* =================================================================== MATRIX */
const MX = new Map();
function renderMatrix(el, M, big) { if (MX.has(el)) return; MX.set(el, 1); later(() => { MX.delete(el); renderMatrixNow(el, M, big); }); }
function renderMatrixNow(el, M, big) {
  const engs = M.engines;
  el.style.gridTemplateColumns = `minmax(0,1fr) repeat(${engs.length}, ${big ? "92px" : "56px"})`;
  let h = `<div></div>` + engs.map((e) => `<div class="eh">${ENG[e]}</div>`).join("");
  for (const q of M.questions) {
    h += `<div class="qh" title="${esc(q.text)}" data-q="${esc(q.id)}">${esc(q.text)}</div>`;
    for (const e of engs) {
      const all = answersOf(M, q.id, e), fin = all.filter((a) => (a.status === "yes" || a.status === "no") && !a.absent), named = fin.filter((a) => a.named);
      const ranks = named.map((a) => a.rank).filter(Boolean), first = fin[0] || all[0];
      const cls = !all.length ? "" : all.some((a) => a.status === "run") ? "run" : !fin.length ? (all.some((a) => a.absent) ? "na" : "err") : named.length ? "yes" : "no";
      const label = cls === "na" ? "n/a" : !fin.length ? "" : named.length ? (ranks.length ? "#" + Math.min(...ranks) : "✓") + (fin.length > 1 ? ` ${named.length}/${fin.length}` : "") : fin.length > 1 ? `0/${fin.length}` : "–";
      h += `<div class="cell ${cls}" ${first ? `data-cell="${esc(akey(first.qid, first.engine, first.sample || 0))}"` : ""} title="${cls === "na" ? "Google showed no AI answer for this query" : ""}">${label}</div>`;
    }
  }
  el.innerHTML = h;
}
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-cell]"); if (!c || !APP.M) return;
  const a = APP.M.answers[c.dataset.cell]; if (!a || a.status === "run") return;
  if (!$("#reportWrap").hidden && finished(a)) return openChat(c.dataset.cell);
  modal(`<span class="status">${ENG[a.engine]} · ${esc(a.model || "")}</span><h3>${esc(qText(APP.M, a.qid))}</h3><div>${verdictHtml(a)}</div>${(a.searches || []).length ? `<div class="chips">${a.searches.map((s) => `<span class="search">searched: ${esc(s)}</span>`).join("")}</div>` : ""}<div class="answer full">${highlight(a.answer || a.error || "", APP.M, a.brands)}</div><b style="font-size:.85rem">Sources it used</b>${srcChips(a.sources)}`);
});
function modal(html) { const m = document.createElement("div"); m.className = "modal" + (document.body.classList.contains("is-light") ? " light" : ""); m.innerHTML = `<div class="box">${html}<div><button class="btn ghost sm" type="button">Close</button></div></div>`; m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("button.btn")) m.remove(); }); document.body.append(m); }
addEventListener("keydown", (e) => { if (e.key === "Escape") { $$(".modal,.drawer").forEach((x) => x.remove()); } });

/* =================================================================== MISSION */
function newMission(profile, audit, siteText) {
  return { id: Date.now().toString(36), slug: slugify(profile.name), startedAt: Date.now(), finishedAt: null, profile, audit, siteText, engines: APP.cfg.engines.slice(), questions: [], answers: {}, inspections: {}, perception: null, insights: "", assets: null, pitches: {}, fixpack: "", articles: {}, deck: {}, chat: [], done: {} };
}
let saveT = 0;
function save(now) {
  if (!APP.M || APP.frozen === APP.M.slug) return;
  const run = () => { saveT = 0; APP.M.savedAt = Date.now(); store.set("mission:" + APP.M.slug, slim(APP.M)); if (APP.running) lockTouch(APP.M.slug); DATA.pushRun(APP.M, now); };
  if (now) { clearTimeout(saveT); return run(); }
  if (!saveT) saveT = setTimeout(run, 1500);
}
// Keep what the results need, drop bulk that only bloats storage.
function slim(M) {
  const answers = {};
  for (const [k, a] of Object.entries(M.answers || {})) {
    const src = a.sources || [], cited = src.filter((s) => s.cited), rest = src.filter((s) => !s.cited);
    answers[k] = { ...a, answer: String(a.answer || "").slice(0, 4000), sources: [...cited, ...rest].slice(0, 20), searches: (a.searches || []).slice(0, 6),
      nSrc: Math.max(a.nSrc || 0, src.length), nS: Math.max(a.nS || 0, (a.searches || []).length) };
  }
  const inspections = {};
  for (const [k, p] of Object.entries(M.inspections || {})) inspections[k] = { ...p, excerpt: String(p.excerpt || "").slice(0, 600) };
  return { ...M, answers, inspections, siteText: String(M.siteText || "").slice(0, 6000) };
}
const later = (f) => (document.hidden ? setTimeout(f, 250) : requestAnimationFrame(f));
const throttled = (f) => { let p = 0; return () => { if (!p) p = later(() => { p = 0; f(); }); }; };
const retryable = (e) => /429|rate|limit|quota exceeded|overload|timed out|timeout|temporar|unavailable|502|503|504|network|fetch|stream/i.test(String(e?.message || e));
function rivalCounts(M) { const rc = {}; Object.values(M.answers || {}).forEach((a) => (a.brands || []).forEach((b) => { if (!isYou(b, M)) rc[b] = (rc[b] || 0) + 1; })); return rc; }
// One tab runs a brand at a time; other tabs see it's busy instead of overwriting each other.
const TAB = Math.random().toString(36).slice(2);
function lockTouch(slug) { store.set("lock:" + slug, { tab: TAB, ts: Date.now() }); }
function lockRelease(slug) { const l = store.get("lock:" + slug, null); if (l && l.tab === TAB) { try { localStorage.removeItem("wpetal:lock:" + slug); } catch {} } }
// Ask other open tabs directly whether they are running this brand (no stale locks after a tab closes or navigates).
const BC = "BroadcastChannel" in window ? new BroadcastChannel("wpetal") : null;
if (BC) BC.onmessage = (ev) => {
  const d = ev.data || {}; const mine = APP.running && APP.M && APP.M.slug === d.slug;
  if (d.type === "ping" && mine) BC.postMessage({ type: "pong", slug: d.slug });
  // Another tab took this run over: save, stop here, and say where it went.
  if (d.type === "takeover" && mine) { save(true); clearTimeout(saveT); saveT = 0; APP.frozen = d.slug; APP.handedOff = true; APP.ctl?.abort(); }
};
function lockedElsewhere(slug) {
  if (!BC) { const l = store.get("lock:" + slug, null); return Promise.resolve(!!(l && l.tab !== TAB && Date.now() - l.ts < 25000)); }
  return new Promise((done) => { let got = false; const h = (ev) => { if (ev.data?.type === "pong" && ev.data.slug === slug) got = true; }; BC.addEventListener("message", h); BC.postMessage({ type: "ping", slug }); setTimeout(() => { BC.removeEventListener("message", h); done(got); }, 350); });
}
setInterval(() => { if (APP.running && APP.M) lockTouch(APP.M.slug); }, 8000);

function missionUI(title) {
  screen("mission");
  $("#feed").innerHTML = ""; setupHud(); gInit(); setRing(null); $("#toReport").hidden = false; $("#toReport").textContent = "Overview"; $("#stopBtn").hidden = false;
  $("#liveTag").className = "live"; $("#liveTag").innerHTML = "<i></i>Live"; $("#matrix").innerHTML = "";
  APP.ctl?.abort(); APP.ctl = new AbortController(); APP.running = true; APP.resuming = false; APP.frozen = null; stick = true;
  $("#hudBrand").textContent = title;
  return APP.ctl.signal;
}

async function resumeMission(M) {
  const sig = missionUI(M.profile.name);
  APP.M = M; M.done = M.done || {};
  rebuildMap(M); renderMatrix($("#matrix"), M); setRing(liveScore(M));
  const ans = Object.values(M.answers || {});
  fillHud(M);
  thought(`<b>Picking up where I left off.</b> ${M.questions.length} questions and ${ans.filter((a) => a.status === "yes" || a.status === "no").length} answers are already saved. Nothing gets asked twice.`, "Runs are saved after every step, so leaving the page doesn't lose work.");
  showRunning();
  try { await runPipeline(M, sig); } catch (err) { missionError(err, sig); }
}

function missionError(err, sig) {
  APP.lastError = sig.aborted ? "" : String(err?.message || "");
  if (!$("#ready").hidden && $("#ready").dataset.mode === "run") setTimeout(renderRunning, 50);
  APP.running = false; if (APP.M) lockRelease(APP.M.slug);
  if (APP.resuming) return; // the page came back from the background; resume handles the UI
  const M = APP.M;
  if (sig.aborted) {
    if (APP.handedOff) { APP.handedOff = false; thought("<b>This run moved to another tab.</b> It's continuing there, so this tab has stopped to avoid doing the work twice."); $("#liveTag").className = "live off"; $("#liveTag").innerHTML = "<i></i>Moved"; $("#stopBtn").hidden = true; const row = add(`<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" type="button" data-home>← Back to start</button></div>`); row.querySelector("[data-home]").onclick = goHome; return; }
    thought("<b>Paused.</b> Everything so far is saved. You can resume any time or see results now.");
    if (M) { save(); $("#toReport").hidden = false; }
    const row = add(`<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" type="button" data-resume>Resume the agent</button><button class="btn ghost sm" type="button" data-home>← Back to start</button></div>`);
    row.querySelector("[data-resume]").onclick = () => resumeMission(APP.M);
    row.querySelector("[data-home]").onclick = goHome;
    if (!M) row.querySelector("[data-resume]").remove();
  } else {
    add(`<span class="ic">!</span><div><span class="tx">${esc(err.message)}</span><span class="why">${M ? "Your progress is saved. Fix it and resume, or start again." : "Fix it and start again. Saved companies keep their profile."}</span></div>`, "step bad");
    const row = add(`<div style="display:flex;gap:8px;flex-wrap:wrap">${M ? '<button class="btn sm" type="button" data-resume>Resume</button>' : ""}<button class="btn ghost sm" type="button" data-home>← Back to start</button></div>`);
    row.querySelector("[data-resume]")?.addEventListener("click", () => resumeMission(APP.M));
    row.querySelector("[data-home]").onclick = goHome;
  }
  $("#liveTag").className = "live off"; $("#liveTag").innerHTML = sig.aborted ? "<i></i>Paused" : "<i></i>Stopped"; $("#stopBtn").hidden = true;
}

async function runPipeline(M, sig) {
  M.done = M.done || {};
  const profile = M.profile;
    // ---------- 2. questions
    if (!M.done.questions) {
    M.questions = []; M.answers = {};
    phase("questions", 10, "Writing buyer questions");
    thought(`<b>Writing the questions a buyer types into ChatGPT</b> before choosing a ${esc(profile.category || "solution")}. I leave your name out on purpose.`, "We want to see whether AI brings you up on its own, the way a real buyer would experience it.");
    const qc = add(`<div class="hd"><span>Buyer questions</span><span class="sp"></span><span class="mono qn" style="font-size:.7rem">0</span></div><div class="ql"></div>`, "card hot");
    let buf = "";
    const takeLine = (line) => {
      const m = line.split("|"); if (m.length < 2) return; const intent = m[0].trim().toLowerCase().slice(0, 14), text = m.slice(1).join("|").trim().replace(/^["“]|["”]$/g, "");
      if (!text || M.questions.some((q) => norm(q.text) === norm(text))) return;
      const q = { id: "q" + (M.questions.length + 1), intent, text }; M.questions.push(q);
      qc.querySelector(".ql").insertAdjacentHTML("beforeend", `<div><span>${esc(intent)}</span>${esc(text)}</div>`); qc.querySelector(".qn").textContent = M.questions.length;
      gNode("q:" + q.id, "question", text); bump("q"); phase("questions", Math.min(95, M.questions.length * 8)); scrollFeed();
    };
    await stream("/api/write", { kind: "questions", data: { profile, count: Math.min(12, Math.max(1, PLANL.prompts())) } }, {
      delta: (d) => { buf += d.text; const lines = buf.split("\n"); buf = lines.pop(); lines.forEach(takeLine); },
      final: () => { if (buf.trim()) takeLine(buf); },
    }, sig);
    qc.classList.remove("hot");
    if (!M.questions.length) throw new Error("The AI didn't return any buyer questions. Try again in a minute.");
    M.done.questions = true; save(true);
    }
    finishPhase("questions"); renderMatrix($("#matrix"), M);

    // ---------- 3. ask AI live
    const engs = M.engines;
    const isDone = (a) => a && (a.status === "yes" || a.status === "no");
    const S = Math.max(1, M.samples || 1);
    const jobs = []; for (let s = 0; s < S; s++) for (const q of M.questions) for (const e of engs) if (!isDone(M.answers[akey(q.id, e, s)])) jobs.push([q, e, s]);
    if (!M.done.ask && jobs.length) {
    phase("ask", 2, `Asking ${engs.map((e) => ENG[e]).join(", ")} live`);
    thought(`<b>Asking ${engs.map((e) => ENG[e]).join(", ")} all ${M.questions.length} questions, live, with web search on${S > 1 ? `, ${S} times each so one lucky answer can't skew the numbers` : ""}.</b> ${jobs.length} conversations, 2 at a time. Watch who gets named and which pages they lean on.`, "This is exactly what your buyers see. Every page an engine cites is a lever we can pull.");
    let done = 0; let firstYou = countNamed(M) === 0;
    const runOne = async ([q, e, s = 0]) => {
      if (sig.aborted) return;
      const key = akey(q.id, e, s); const a = (M.answers[key] = { qid: q.id, engine: e, sample: s, status: "run", answer: "", sources: [], brands: [], searches: [] });
      renderMatrix($("#matrix"), M);
      const card = add(`<div class="hd"><span class="eng"><i style="background:${ENGC[e]}"></i>${ENG[e]}</span>${S > 1 ? `<span class="chip">answer ${s + 1} of ${S}</span>` : ""}<span class="sp"></span><span class="vd">${verdictHtml(a)}</span></div><div class="q">${esc(q.text)}</div><div class="status st">Connecting</div><div class="chips sq"></div><div class="answer typing"></div><div class="sr"></div>`, "card hot");
      const ansEl = card.querySelector(".answer"); let raf = 0;
      const paint = () => { raf = 0; ansEl.innerHTML = markHtml(md(a.answer), M); ansEl.classList.toggle("short", a.answer.length < 400); scrollFeed(); };
      for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) { Object.assign(a, { status: "run", answer: "", sources: [], brands: [], searches: [], error: "", nSrc: 0, nS: 0 }); card.querySelector(".st").textContent = `Retrying (attempt ${attempt} of 3)`; card.querySelector(".sq").innerHTML = ""; }
        await stream("/api/ask", { engine: e, question: q.text, brand: profile }, {
          status: (d) => { card.querySelector(".st").textContent = d.text; },
          search: (d) => { a.searches.push(d.query); a.nS = (a.nS || 0) + 1; bump("s"); card.querySelector(".sq").insertAdjacentHTML("beforeend", `<span class="search" title="AI searched the web for this">${esc(d.query)}</span>`); },
          source: (d) => {
            if (!a.sources.some((s) => s.url === d.url)) { a.sources.push(d); a.nSrc = (a.nSrc || 0) + 1; bump("src"); }
            if (!card._srcT) card._srcT = later(() => { card._srcT = 0; card.querySelector(".sr").innerHTML = srcChips(a.sources); });
            const sid = sidOf(d.url);
            const sn = gNode(sid, "source", host(d.url), { url: d.url }); sn.weight = (sn.weight || 0) + 1; gLink("q:" + q.id, sid, "cited", "#3CC9B5");
          },
          delta: (d) => { a.answer += d.text; if (!raf) raf = later(paint); },
          final: (d) => {
            a.answer = d.answer || a.answer; a.sources = d.sources?.length ? d.sources : a.sources; a.brands = d.brands || []; a.model = d.model;
            if (d.present === false) a.absent = true; // Google showed no AI answer for this query: not a miss, excluded from metrics
            const idx = a.brands.findIndex((b) => isYou(b, M));
            a.named = idx >= 0 || textHasYou(a.answer, M); a.rank = idx >= 0 ? idx + 1 : null; a.status = a.named ? "yes" : "no";
          },
        }, sig);
        if (a.status === "run") throw new Error("No answer came back");
        break;
      } catch (err) {
        if (sig.aborted) return;
        a.status = "err"; a.error = err.message; card.querySelector(".st").textContent = err.message;
        if (attempt < 3 && retryable(err)) { await sleep(2500 * attempt + Math.random() * 1500); continue; }
        break;
      }
      }
      raf = 0; paint(); ansEl.classList.remove("typing"); card.classList.remove("hot");
      card.querySelector(".vd").innerHTML = verdictHtml(a);
      card.querySelector(".st").textContent = a.status === "err" ? a.error : `${a.model || ""} · ${a.sources.length} sources · ${a.brands.length} brands named`;
      card.querySelector(".sr").innerHTML = srcChips(a.sources);
      bump("a"); done++; phase("ask", (100 * done) / jobs.length);
      if (a.status !== "err") {
        const qn = G.nodes.get("q:" + q.id); if (qn && a.named) { qn.named = true; }
        for (const b of a.brands) {
          if (isYou(b, M)) { gLink("q:" + q.id, "you", "named", "#FF7A1A"); continue; }
          const rid = "r:" + norm(b); const rn = gNode(rid, "rival", b); rn.weight = (rn.weight || 0) + 1; gLink("q:" + q.id, rid, "named", ({ chatgpt: "#45D19A", perplexity: "#5FA8FF", gemini: "#C9A2FF", groq: "#F5F5F3" })[e] || "#8A8A8E");
          const rc = rivalCounts(M)[b] || 0; if (rc === 1) bump("r");
          if (rc === 4 && !$("#mission").hidden) toast(`<b>${esc(b)}</b> has now been named 4 times. I'll check which pages carry it.`);
        }
        if (a.named && firstYou) { firstYou = false; if (!$("#mission").hidden) toast(`${ENG[e]} named <b>${esc(profile.name)}</b>${a.rank ? " at #" + a.rank : ""} for “${esc(q.text)}”.`); }
        const v = liveScore(M); setRing(v);
      }
      renderMatrix($("#matrix"), M); save();
    };
    const queue = jobs.slice();
    await Promise.all([0, 1].map(async () => { while (queue.length && !sig.aborted) await runOne(queue.shift()); }));
    }
    if (sig.aborted) throw new DOMException("stopped", "AbortError");
    M.done.ask = true; save(true); finishPhase("ask");
    const answered = Object.values(M.answers).filter((a) => a.status !== "err" && a.status !== "run");
    if (!answered.length) throw new Error("None of the AI engines answered. Check your API key and quota, then resume.");
    const top = Object.entries(rivalCounts(M)).sort((a, b) => b[1] - a[1]);
    thought(`<b>${countNamed(M)} of ${answered.length} answers named you.</b> ${top[0] ? `${esc(top[0][0])} was named ${top[0][1]} times${top[1] ? `, ${esc(top[1][0])} ${top[1][1]}` : ""}.` : ""}`);

    // ---------- 3b. sentiment: how positively each answer talks about each brand (0-100, like Peec)
    if (!M.done.sentiment && !sig.aborted) {
      phase("think", 4, "Scoring sentiment");
      const s1 = stepEl("Scoring how positively each answer talks about every brand it names", "Sentiment is one of the core AI-visibility metrics: same mention, very different value if AI warns against you.");
      const items = answered.filter((a) => (a.brands || []).length || a.named).slice(0, 48).map((a, i) => ({ id: "a" + i, key: a.qid + "|" + a.engine, brands: [...new Set([...(a.brands || []).slice(0, 8), ...(a.named ? [profile.name] : [])])], text: String(a.answer || "").slice(0, 900) }));
      let raw = "";
      try {
        await stream("/api/write", { kind: "sentiment", data: { profile: { name: profile.name }, items: items.map(({ id, brands, text }) => ({ id, brands, text })) } }, { delta: (d) => { raw += d.text; } }, sig);
        const j = parseLoose(raw); let n = 0;
        items.forEach((it) => { const sc = j && j[it.id]; if (sc && typeof sc === "object") { M.answers[it.key].sent = sc; n++; } });
        s1.done(`Sentiment scored in ${n} answers`, n > 0);
      } catch (e) { if (sig.aborted) throw new DOMException("stopped", "AbortError"); s1.done("Couldn't score sentiment this time", false); }
      if (!sig.aborted) M.done.sentiment = true; save(true);
    }

    // ---------- 4. follow the sources
    const cites = {};
    for (const a of answered) for (const s of a.sources || []) { const k = s.url; (cites[k] = cites[k] || { url: k, n: 0, qs: new Set(), cited: false }); cites[k].n++; cites[k].qs.add(a.qid); cites[k].cited ||= s.cited; }
    const targets = Object.values(cites).sort((a, b) => b.n - a.n || (b.cited ? 1 : 0) - (a.cited ? 1 : 0)).slice(0, APP.cfg.billing?.limits?.pages > 0 ? APP.cfg.billing.limits.pages : 24).filter((t) => !M.inspections[t.url]); // the plan's "pages" limit, else 24
    if (!M.done.sources && targets.length && !sig.aborted) {
      phase("sources", 3, "Following the sources");
      thought(`<b>AI repeats what the web says.</b> The engines leaned on ${Object.keys(cites).length} pages. I'm opening the ${targets.length} that came up most to see who's on them.`, "If a rival is on the pages AI trusts and you're not, that's why it gets named. Those pages are your outreach list.");
      const ic = add(`<div class="hd"><span>Cited pages, opened</span><span class="sp"></span><span class="mono ipn" style="font-size:.7rem">0 / ${targets.length}</span></div><div class="irows"></div>`, "card hot");
      let k = 0; const q2 = targets.slice();
      await Promise.all([0, 1, 2, 3].map(async () => {
        while (q2.length && !sig.aborted) {
          const t = q2.shift();
          let r; try { r = await post("/api/inspect", { url: t.url, brand: profile }, sig); } catch (e) { r = { ok: false, url: t.url, reason: e.message }; }
          r.n = t.n; r.qs = [...t.qs]; M.inspections[t.url] = r; k++; bump("p");
          ic.querySelector(".ipn").textContent = `${k} / ${targets.length}`; phase("sources", (100 * k) / targets.length);
          const sid = sidOf(t.url);
          const sn = gNode(sid, "source", host(r.final || t.url), { url: t.url, inspected: true, you: !!r.you, rivals: (r.rivals || []).length });
          if (r.ok) {
            if (r.you) gLink(sid, "you", "on", "#FF7A1A");
            (r.rivals || []).forEach((rv) => { const rid = "r:" + norm(rv); const rn = gNode(rid, "rival", rv); rn.pages = (rn.pages || 0) + 1; gLink(sid, rid, "on", "#E2483D"); });
            if ((r.contacts?.emails || []).length || r.contacts?.author || (r.contacts?.links || []).length) bump("c");
          }
          ic.querySelector(".irows").insertAdjacentHTML("beforeend", `<div class="irow"><span class="chip ${!r.ok ? "" : r.you ? "ok" : (r.rivals || []).length ? "no" : ""}">${!r.ok ? "blocked" : r.you ? "you ✓" : "you ✕"}</span><div style="min-width:0"><div class="d">${esc(r.title || host(t.url))} <span class="muted" style="font-weight:400">· cited ${t.n}×</span></div>${r.ok ? `<div class="ev2">${(r.rivals || []).length ? `Rivals here: ${r.rivals.map((x) => `<b>${esc(x)}</b>`).join(", ")}` : "No tracked rivals here"}${r.contacts?.emails?.length ? ` · contact: <span class="mono">${esc(r.contacts.emails[0])}</span>` : r.contacts?.author ? ` · author: ${esc(r.contacts.author)}` : ""}</div>${r.evidence?.[0] ? `<div class="ev2">“${highlight(r.evidence[0].snippet, M)}”</div>` : ""}` : `<div class="ev2">${esc(r.reason || "Couldn't open")}</div>`}</div></div>`);
          scrollFeed(); save();
        }
      }));
      ic.classList.remove("hot"); finishPhase("sources");
      const opened = Object.values(M.inspections).filter((p) => p.ok);
      const onYou = opened.filter((p) => p.you).length; const rc = {};
      opened.forEach((p) => (p.rivals || []).forEach((r) => (rc[r] = (rc[r] || 0) + 1)));
      const tr = Object.entries(rc).sort((a, b) => b[1] - a[1])[0];
      thought(`<b>Found the pattern.</b> You're on ${onYou} of the ${opened.length} pages AI trusts.${tr ? ` ${esc(tr[0])} is on ${tr[1]}.` : ""} ${opened.length - onYou} pages are open targets.`, "Getting listed on these pages is the fastest way to start appearing in answers.");
    } else finishPhase("sources");
    if (sig.aborted) throw new DOMException("stopped", "AbortError");
    M.done.sources = true; save(true);
    if (!M.entity && !sig.aborted) {
      const st = stepEl("Checking whether AI's knowledge sources know who you are (Wikidata, Google Knowledge Graph)", "Models lean on knowledge graphs to decide what a brand is. If you're missing or inconsistent there, AI guesses.");
      try { M.entity = await post("/api/entity", { name: profile.name, site: profile.site, orgSchema: M.audit?.org ?? null }, sig); st.done(`Entity score ${M.entity.score}/100 · ${(M.entity.checks || []).filter((c) => c.pass === false).length} things to fix`); }
      catch (e) { st.done("Couldn't check knowledge graphs this time", false); }
      save();
    }

    // ---------- 5. what AI says about you + insights
    phase("think", 10, "Checking what AI says about you");
    if (!M.done.perception && !sig.aborted) {
      thought(`<b>Now asking ${ENG[engs[0]]} what it knows about ${esc(profile.name)}</b>, then fact-checking every claim against your own site.`, "Wrong or outdated claims cost deals. You can't fix what you haven't seen.");
      const pq = [`What is ${profile.name}?`, `Is ${profile.name} a good choice for ${profile.category || "this"}? What are the alternatives?`];
      const pAns = [];
      // Both questions at once: half the wait.
      await Promise.all(pq.map(async (qq, i) => {
        if (sig.aborted) return;
        const card = add(`<div class="hd"><span class="eng"><i style="background:${ENGC[engs[0]]}"></i>${ENG[engs[0]]}</span><span class="chip you">about you</span></div><div class="q">${esc(qq)}</div><div class="answer typing"></div>`, "card hot");
        const el = card.querySelector(".answer"); let t = ""; const paintP = throttled(() => { el.innerHTML = markHtml(md(t), M); scrollFeed(); });
        try { await stream("/api/ask", { engine: engs[0], question: qq, brand: profile }, { delta: (d) => { t += d.text; paintP(); }, final: (d) => { t = d.answer || t; } }, sig); } catch (e) { t = t || e.message; }
        el.classList.remove("typing"); el.innerHTML = markHtml(md(t), M); card.classList.remove("hot"); pAns[i] = { q: qq, a: t };
      }));
      phase("think", 45);
      const pc = add(`<div class="hd"><span>Fact-check</span><span class="sp"></span><svg class="pq think" viewBox="0 0 56 30" style="height:12px;width:22px;color:var(--muted)"><rect x="0" width="16" height="30" rx="4.5" fill="currentColor" opacity=".55"/><rect x="20" width="16" height="30" rx="4.5" fill="#FF7A1A"/><rect x="40" width="16" height="30" rx="4.5" fill="currentColor" opacity=".55"/></svg></div><div class="body status">Comparing claims with your site</div>`, "card hot");
      let raw = "";
      try { await stream("/api/write", { kind: "perception", data: { profile, answers: pAns.filter(Boolean) } }, { delta: (d) => { raw += d.text; } }, sig); M.perception = parseLoose(raw); } catch { M.perception = null; }
      pc.classList.remove("hot");
      if (!sig.aborted) M.done.perception = true;
      pc.querySelector(".body").outerHTML = M.perception ? `<p style="font-size:.88rem">${esc(M.perception.summary || "")}</p><div class="chips" style="flex-direction:column;align-items:flex-start">${(M.perception.claims || []).map((c) => `<div style="font-size:.84rem"><span class="chip ${c.verdict === "accurate" ? "ok" : c.verdict === "wrong" ? "no" : "rv"}">${esc(c.verdict)}</span> ${esc(c.claim)}</div>`).join("")}</div>` : `<p class="muted">Couldn't complete the fact-check.</p>`;
      save();
    }
    if (!M.done.insights && !sig.aborted) {
      phase("think", 70, "Working out why");
      thought(`<b>Putting it together.</b> Here's my read of everything above.`);
      const ins = add(`<div class="hd"><span>Insights</span></div><div class="md typing"></div>`, "card hot");
      let t = ""; const paintI = throttled(() => { ins.querySelector(".md").innerHTML = md(t); scrollFeed(); });
      await stream("/api/write", { kind: "insights", data: { profile, digest: digest(M) } }, { delta: (d) => { t += d.text; paintI(); } }, sig).catch(() => {});
      ins.querySelector(".md").innerHTML = md(t); M.insights = t; if (t && !sig.aborted) M.done.insights = true; ins.querySelector(".md").classList.remove("typing"); ins.classList.remove("hot"); save();
    }
    finishPhase("think");

    // ---------- 6. drafts
    if (!M.done.draft && !sig.aborted) {
      phase("draft", 5, "Drafting your fixes");
      thought(`<b>Drafting the fixes.</b> Site code first, then personalised pitches for the pages where rivals are listed and you're not. You approve each one on the next screen.`, "Each draft is written for one specific page or gap. Nothing is generic.");
      if (!M.assets) { const s1 = stepEl("Writing llms.txt and company schema for your site");
      let raw = ""; try { await stream("/api/write", { kind: "assets", data: { profile, pages: (M.audit.pages || []).slice(0, 10) } }, { delta: (d) => { raw += d.text; } }, sig); M.assets = parseLoose(raw); bump("d"); s1.done("llms.txt and company schema written"); } catch { s1.done("Couldn't write the site files", false); } }
      phase("draft", 30);
      const gaps = pitchTargets(M).slice(0, 3).filter((t) => !M.pitches[t.url]);
      for (const [i, t] of gaps.entries()) {
        if (sig.aborted) break;
        const card = add(`<div class="hd"><span class="chip rv">pitch</span><span>${esc(t.domain)}</span><span class="sp"></span><span class="mono" style="font-size:.7rem">cited ${t.n}×</span></div><div class="pre typing"></div>`, "card hot");
        let txt = ""; const paintD = throttled(() => { card.querySelector(".pre").textContent = txt; scrollFeed(); }); await stream("/api/write", { kind: "pitch", data: { profile, t: { url: t.final || t.url, title: t.title, author: t.contacts?.author, rivals: t.rivals, questions: t.qs.map((q) => qText(M, q)), excerpt: t.excerpt } } }, { delta: (d) => { txt += d.text; paintD(); } }, sig).catch(() => {});
        card.querySelector(".pre").textContent = txt; if (txt) M.pitches[t.url] = txt; card.querySelector(".pre").classList.remove("typing"); card.classList.remove("hot"); bump("d"); phase("draft", 30 + (i + 1) * 20); save();
      }
      if (!sig.aborted) M.done.draft = true; save();
      finishPhase("draft");
    }
    if (sig.aborted) throw new DOMException("stopped", "AbortError");

    // ---------- done
    lockRelease(M.slug);
    M.finishedAt = Date.now(); save(true);
    const mins = estimateMinutes(M);
    APP.running = false;
    $("#liveTag").className = "live off"; $("#liveTag").innerHTML = "<i></i>Done"; $("#hudPhase").textContent = `Finished · about ${(mins / 60).toFixed(1)} hours of work`;
    $("#stopBtn").hidden = true; $("#toReport").hidden = false;
    const fin = add(`<div class="hd"><span class="chip ok">Mission complete</span></div><div class="q">${C.a} answers read, ${C.p} pages opened, ${C.d} drafts written. That's about ${(mins / 60).toFixed(1)} hours of manual work.</div><div><button class="btn" type="button" id="goResults">See your results →</button></div>`, "card hot");
    fin.querySelector("#goResults").onclick = showReady;
    // Like Peec's reveal: if you're watching the end of the feed, move on to the first results by itself.
    if (!$("#ready").hidden) showReady();
    else setTimeout(() => { if (!$("#mission").hidden && APP.M === M && stick && !document.hidden) showReady(); }, 2600);
}

$("#stopBtn").addEventListener("click", () => APP.ctl?.abort());
$("#toReport").addEventListener("click", () => (APP.M?.finishedAt ? showReady() : showRunning()));
$$(".mobile-tabs button").forEach((b) => b.addEventListener("click", () => { $("#stage").dataset.view = b.dataset.view; $$(".mobile-tabs button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); if (b.dataset.view === "map") G.sim?.alpha(0.5).restart(); }));

function parseLoose(t) {
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const i = t.search(/[[{]/), j = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  return JSON.parse(t.slice(i, j + 1));
}
function liveScore(M) { const done = Object.values(M.answers).filter((a) => a.status === "yes" || a.status === "no"); return done.length ? Math.round((100 * done.filter((a) => a.named).length) / done.length) : null; }
function estimateMinutes(M) { return Object.keys(M.answers).length * 4 + Object.keys(M.inspections).length * 3 + Object.keys(M.pitches).length * 20 + (M.assets ? 30 : 0) + (M.insights ? 60 : 0) + (M.perception ? 20 : 0) + (M.audit?.pages?.length || 0) * 8; }
function pitchTargets(M) {
  return Object.values(M.inspections).filter((p) => p.ok && !p.you && !namesFor(M).rivals.some((r) => norm(p.domain).includes(norm(r).split(" ")[0])))
    .map((p) => ({ ...p, prio: p.n * 2 + (p.rivals || []).length * 3 + (p.listy ? 2 : 0) })).sort((a, b) => b.prio - a.prio);
}
function digest(M) {
  const ans = Object.values(M.answers).filter((a) => a.status === "yes" || a.status === "no");
  const L = [];
  for (const e of M.engines) { const x = ans.filter((a) => a.engine === e); if (x.length) L.push(`${ENG[e]}: named in ${x.filter((a) => a.named).length}/${x.length}`); }
  for (const q of M.questions) { const x = ans.filter((a) => a.qid === q.id); L.push(`- "${q.text}" [${q.intent}]: ${x.map((a) => `${ENG[a.engine]} ${a.named ? "NAMED" + (a.rank ? " #" + a.rank : "") : "missing"} (named: ${(a.brands || []).slice(0, 5).join(", ")})`).join("; ")}`); }
  const rc = {}; ans.forEach((a) => (a.brands || []).forEach((b) => { if (!isYou(b, M)) rc[b] = (rc[b] || 0) + 1; }));
  L.push("Rival mentions: " + Object.entries(rc).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n} ${c}`).join(", "));
  const ins = Object.values(M.inspections).filter((p) => p.ok);
  L.push(`Cited pages opened: ${ins.length}. You are on ${ins.filter((p) => p.you).length}.`);
  ins.slice(0, 18).forEach((p) => L.push(`  page ${p.domain} "${p.title}" cited ${p.n}x: you ${p.you ? "present" : "absent"}; rivals: ${(p.rivals || []).join(", ") || "none"}`));
  const a = M.audit || {}; L.push(`Site: avg AI-readiness ${a.avg}/100; blocked bots: ${Object.entries(a.bots || {}).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"}; llms.txt ${a.llms ? "yes" : "no"}; org schema ${a.orgSchema ? "yes" : "no"}; FAQ schema ${a.faqSchema ? "yes" : "no"}`);
  if (M.perception) L.push("How AI describes them: " + M.perception.summary);
  return L.join("\n").slice(0, 12000);
}

/* =================================================================== REPORT */
$("#viewLog").addEventListener("click", () => {
  screen("mission");
  if (!$("#feed").children.length && APP.M) { setupHud(); gInit(); rebuildMap(APP.M); renderMatrix($("#matrix"), APP.M); fillHud(APP.M); $("#hudPhase").textContent = APP.M.finishedAt ? "Finished" : "Paused"; thought("<b>This is a saved run.</b> The live log isn't kept, but every answer, source and rival is on the map. Click any node, or a cell in the grid below it."); $("#toReport").hidden = false; $("#stopBtn").hidden = true; $("#liveTag").className = "live off"; $("#liveTag").innerHTML = "<i></i>Saved"; $("#hudBrand").textContent = APP.M.profile.name; setRing(liveScore(APP.M)); }
});
function rebuildMap(M) {
  gNode("you", "you", M.profile.name);
  M.questions.forEach((q) => gNode("q:" + q.id, "question", q.text));
  Object.values(M.answers).forEach((a) => {
    (a.sources || []).forEach((s) => { const sid = sidOf(s.url); const n = gNode(sid, "source", host(s.url), { url: s.url }); n.weight = (n.weight || 0) + 1; gLink("q:" + a.qid, sid, "cited", "#3CC9B5"); });
    (a.brands || []).forEach((b) => { if (isYou(b, M)) return gLink("q:" + a.qid, "you", "named", "#FF7A1A"); const rn = gNode("r:" + norm(b), "rival", b); rn.weight = (rn.weight || 0) + 1; gLink("q:" + a.qid, "r:" + norm(b), "named", "#5A5A5E"); });
    if (a.named) { const qn = G.nodes.get("q:" + a.qid); if (qn) qn.named = true; }
  });
  Object.entries(M.inspections).forEach(([u, r]) => { const sid = sidOf(u); gNode(sid, "source", host(r.final || u), { url: u, inspected: true, you: !!r.you, rivals: (r.rivals || []).length }); if (r.you) gLink(sid, "you", "on", "#FF7A1A"); (r.rivals || []).forEach((rv) => gLink(sid, "r:" + norm(rv), "on", "#E2483D")); });
}
// The free trial is one check: once it's done, paying starts the plan today instead of at the trial's end.
const trialDone = (b) => b?.plan?.status === "trialing" && b.limits?.checks != null && (b.used?.checks || 0) >= b.limits.checks;
// Before re-running: a read-only organisation, or a free trial whose one check is done, gets the pay pop-up instead of the prompt editor.
async function runBlocked() {
  if (!DATA.server()) return false; await refreshBilling(); const b = APP.cfg.billing; if (!b) return false;
  if (b.mode === "read") {
    const days = b.trialStartedAt && b.trialEndsAt ? Math.round((new Date(b.trialEndsAt) - new Date(b.trialStartedAt)) / 864e5) : 0; // trial length is per plan
    upgradeModal({ code: "billing_read_only", error: b.plan?.status === "trialing" ? `Your ${days > 0 ? `${days}-day` : "free"} trial has ended. Choose a plan to keep running checks. Your reports stay readable.` : "Choose a plan to run your prompts again. Your reports stay readable." }); return true;
  }
  if (trialDone(b)) { upgradeModal({ code: "plan_limit", trialDone: true, error: "Choose a plan to run your prompts again. Paying now starts your plan today; your reports stay readable." }); return true; }
  return false;
}
$("#rerun").addEventListener("click", async () => { const M = APP.M; if (!M) return; if (await runBlocked()) return; if (await lockedElsewhere(M.slug)) return toast("This brand is running in another tab right now."); startOnboarding(M.profile.site, DATA.company(M.slug) || { profile: M.profile, questions: M.questions.map((q) => ({ ...q, on: true })), engines: M.engines, samples: M.samples }); });
function goHome() { APP.ctl?.abort(); APP.running = false; OB = null; document.body.classList.remove("sheet-open"); if (APP.M) lockRelease(APP.M.slug); toggleAgent(false); screen("landing"); $("#startUrl").value = ""; paintLanding(); renderRecent(); if (DATA.server()) DATA.refresh().then(paintLanding).catch(() => {}); }

/* ---------- action deck ---------- */
let DECK = [], DI = 0;
function buildDeck() {
  const M = APP.M, a = M.audit || {}, as = M.assets || {}, out = [];
  const blocked = Object.entries(a.bots || {}).filter(([, v]) => !v).map(([k]) => k);
  if (blocked.length) out.push({ id: "robots", evidence: { blocked }, kind: "2-minute fix", title: "Let AI crawlers read your site", why: `${blocked.join(", ")} ${blocked.length > 1 ? "are" : "is"} blocked in robots.txt, so ${blocked.length > 1 ? "those assistants" : "that assistant"} can't cite you.`, code: blocked.map((b) => `User-agent: ${b}\nAllow: /`).join("\n\n"), label: "Add to robots.txt" });
  if (!a.llms && as.llms_txt) out.push({ id: "llms", kind: "5-minute fix", title: "Publish llms.txt", why: "A plain-language briefing AI tools read to understand your company. You don't have one yet.", code: as.llms_txt, label: "Save as /llms.txt at your site root" });
  if (!a.orgSchema && as.org_schema) out.push({ id: "org", kind: "5-minute fix", title: "Tell AI exactly who you are", why: "Your homepage has no Organization schema, so AI has to guess your name, URL and description.", code: '<script type="application/ld+json">\n' + JSON.stringify(as.org_schema, null, 2) + "\n</" + "script>", label: "Paste into your homepage <head>" });
  (M.perception?.claims || []).filter((c) => ["wrong", "outdated"].includes(c.verdict)).forEach((c, i) => out.push({ id: "claim" + i, kind: "Correct AI", title: `AI says: “${c.claim}”`, why: c.fix || "Publish a clear correction on your site." }));
  pitchTargets(M).slice(0, 8).forEach((t) => out.push({ id: "pitch:" + t.url, kind: "Get listed", title: `Get named on ${t.domain}`, why: `AI cited this page ${t.n}×${(t.rivals || []).length ? `. ${t.rivals.slice(0, 3).join(", ")} ${t.rivals.length > 1 ? "are" : "is"} already on it` : ""}.`, t }));
  const missing = RM.questionGaps(M, { engines: M.engines, isYou: (b) => isYou(b, M), requireCompetitor: false }).map((g) => M.questions.find((q) => q.id === g.questionId));
  missing.slice(0, 2).forEach((q) => out.push({ id: "article:" + q.id, kind: "Publish a page", title: `Win “${q.text}”`, why: "No engine named you for this. A page built to answer it gives AI something to cite.", q }));
  const weak = (a.pages || [])[0]; if (weak && weak.score < 60) out.push({ id: "fix:" + weak.url, evidence: { score: weak.score }, kind: "Improve a page", title: `Make “${weak.title || host(weak.url)}” quotable`, why: `Scores ${weak.score}/100. Missing: ${(weak.fails || []).slice(0, 3).join(", ")}.`, page: weak });
  DECK = out.filter((x) => !M.deck[x.id]); DI = 0; drawDeck();
}
/* ---------- re-checking one fix (server/recheck.mjs): no AI, so it's free and instant ---------- */
// Fixes a page or a file can confirm. The others (a page that wins a prompt, a corrected claim) show up in the next full check.
const RECHECK = { robots: "robots.txt", llms: "llms.txt", org: "homepage schema", fix: "this page", pitch: "that page" };
const recheckable = (id) => !!RECHECK[String(id).split(":")[0]];
const RA_KIND = { robots: "technical", llms: "technical", org: "technical", fix: "page", pitch: "outreach" };
// The last recheck of each fix, per brand: from the server's recovery plan (kept across checks), else this browser.
APP.checks = {};
const lastCheck = (slug, id) => APP.checks[slug]?.[id] || APP.M?.checks?.[id] || null;
async function loadChecks(slug) {
  if (!DATA.server() || !slug) return;
  try { const d = await api("GET", `/api/workspaces/${encodeURIComponent(slug)}/recovery-actions`); APP.checks[slug] = Object.fromEntries((d.actions || []).filter((a) => a.lastCheck).map((a) => [a.sourceKey, a.lastCheck])); if (APP.M?.slug === slug && DASH.page === "actions") drawDeck(); }
  catch (e) { console.warn("[checks]", e.message); }
}
async function recheckCard(c) {
  const M = APP.M, body = { sourceKey: c.id, kind: RA_KIND[c.id.split(":")[0]], title: c.title, problem: c.why, evidence: c.evidence || {} };
  const d = DATA.server() ? await api("POST", "/api/recheck", { ...body, slug: M.slug }) : await post("/api/recheck", { ...body, site: M.profile.site, brand: { name: M.profile.name, site: M.profile.site, competitors: M.profile.competitors } });
  (APP.checks[M.slug] ||= {})[c.id] = d.check; M.checks = { ...(M.checks || {}), [c.id]: d.check }; save();
  return d.check;
}
const checkLine = (k) => (k ? `<p class="rcheck ${k.pass ? "ok" : "no"}">${icon(k.pass ? "check" : "x", 13)}<span><b>${k.pass ? "Confirmed" : "Not fixed yet"}</b> · checked ${esc(fmtWhen(k.at))}${k.by === "schedule" ? " by the scheduled check" : ""}. ${esc(k.detail || "")}</span></p>` : "");
function drawDeck() {
  const M = APP.M, total = DECK.length, el = $("#deck");
  const doneN = Object.keys(M.deck).length, okN = Object.values(M.deck).filter((v) => v === "verified").length;
  if ($("#navActions")) $("#navActions").textContent = total || "";
  if (!el) return;
  $("#deckCount").innerHTML = `<span>${doneN} done${okN ? ` · ${okN} confirmed` : ""}</span><span class="bar" style="width:90px"><i style="width:${(100 * doneN) / Math.max(1, doneN + total)}%"></i></span><span>${total} left</span>`;
  if (!total) { el.innerHTML = `<div class="dcard"><span class="kind">All clear</span><h4>Nothing left in the deck.</h4><p class="why">Run again next week to see what moved. Mentions on third-party pages usually take 2–6 weeks to show up in AI answers.</p></div>`; return; }
  const c = DECK[0]; let body = "", acts = "";
  if (c.code) { body = `<span class="muted" style="font-size:.78rem">${esc(c.label)}</span><div class="pre code">${esc(c.code)}</div>`; acts = `<button class="btn" type="button" data-act="copy">Copy code</button>`; }
  else if (c.t) {
    const txt = M.pitches[c.t.url]; const to = c.t.contacts?.emails?.[0];
    body = `${contactHtml(c.t.contacts)}<div class="pre ${txt ? "" : "muted"}" id="dkText">${txt ? esc(txt) : "No pitch yet. I'll write one for this exact page."}</div>`;
    acts = txt ? (to ? `<a class="btn" target="_blank" rel="noopener" href="${esc(gmail(to, txt))}" data-act="sent">Send in Gmail</a>` : `<button class="btn" type="button" data-act="copy">Copy pitch</button>`) : `<button class="btn" type="button" data-act="write">Write the pitch</button>`;
    acts += `<a class="btn ghost sm" href="${esc(safeUrl(c.t.final || c.t.url) || "#")}" target="_blank" rel="noopener">Open page</a>`;
  } else if (c.q) { const txt = M.articles[c.q.id]; body = `<div class="pre" id="dkText">${txt ? esc(txt) : "I'll write a 1,000–1,400 word page built to be cited for this question. Proof points I can't verify are marked [TODO]."}</div>`; acts = txt ? `<button class="btn" type="button" data-act="copy">Copy article</button>` : `<button class="btn" type="button" data-act="write">Write the page</button>`; }
  else if (c.page) { const txt = M.fixpack; body = `<div class="pre md" id="dkText">${txt ? md(txt) : "I'll rewrite the opening, add question headings and an FAQ for this page."}</div>`; acts = txt ? `<button class="btn" type="button" data-act="copy">Copy fixes</button>` : `<button class="btn" type="button" data-act="write">Write the fixes</button>`; }
  if (recheckable(c.id) && canEdit()) acts += `<button class="btn ghost sm" type="button" data-act="recheck" title="Reads ${esc(RECHECK[c.id.split(":")[0]])} again now. No AI is asked, so it's free.">${icon("check", 14)}Recheck</button>`;
  el.innerHTML = `<div class="dcard" id="dk"><span class="kind">${esc(c.kind)} · ${Object.keys(M.deck).length + 1} of ${Object.keys(M.deck).length + DECK.length}</span><h4>${esc(c.title)}</h4><p class="why">${esc(c.why)}</p>${body}${checkLine(lastCheck(M.slug, c.id))}<div class="acts">${acts}<span style="flex:1"></span><button class="btn ghost sm" type="button" data-act="skip">Skip <span class="kbd">←</span></button><button class="btn ghost sm" type="button" data-act="done">Done <span class="kbd">→</span></button></div></div><div class="stack-under"></div>`;
}
const gmail = (to, txt) => { const m = txt.match(/^Subject:\s*(.+)\n+([\s\S]*)$/i); return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(m ? m[1] : "")}&body=${encodeURIComponent(m ? m[2] : txt)}`; };
document.addEventListener("click", async (e) => {
  const b = e.target.closest("#deck [data-act]"); if (!b) return; const act = b.dataset.act, c = DECK[0], M = APP.M;
  if (act === "skip" || act === "done") return advance(act);
  if (act === "sent") { setTimeout(() => advance("done"), 500); return; }
  if (act === "recheck") {
    b.setAttribute("aria-disabled", "true"); b.textContent = "Checking…";
    try { const k = await recheckCard(c); toast(`${k.pass ? "Confirmed" : "Not fixed yet"}: ${esc(k.detail)}`, k.pass ? "ok" : "bad"); if (k.pass) return advance("verified"); }
    catch (err) { toast(esc(err.message)); }
    return drawDeck();
  }
  if (act === "copy") { const t = c.code || (c.t ? M.pitches[c.t.url] : c.q ? M.articles[c.q.id] : M.fixpack); try { await navigator.clipboard.writeText(t); b.textContent = "Copied ✓"; } catch { b.textContent = "Select the text to copy"; } return; }
  if (act === "write") {
    b.setAttribute("aria-disabled", "true"); b.innerHTML = `<svg class="pq think" viewBox="0 0 56 30" style="height:12px;width:22px"><rect x="0" width="16" height="30" rx="4.5" fill="currentColor" opacity=".55"/><rect x="20" width="16" height="30" rx="4.5" fill="#111114"/><rect x="40" width="16" height="30" rx="4.5" fill="currentColor" opacity=".55"/></svg> Writing`;
    const out = $("#dkText"); out.classList.remove("muted"); out.classList.add("typing"); let t = "";
    const req = c.t ? { kind: "pitch", data: { profile: M.profile, t: { url: c.t.final || c.t.url, title: c.t.title, author: c.t.contacts?.author, rivals: c.t.rivals, questions: (c.t.qs || []).map((q) => qText(M, q)), excerpt: c.t.excerpt } } }
      : c.q ? { kind: "article", data: { profile: M.profile, question: c.q.text, rivals: [...new Set(M.engines.flatMap((e) => answersOf(M, c.q.id, e).flatMap((a) => a.brands || [])))].filter((x) => !isYou(x, M)), siteText: M.siteText } }
      : { kind: "fixpack", data: { profile: M.profile, page: c.page, text: M.siteText } };
    const paintK = throttled(() => { if (c.page) out.innerHTML = md(t); else out.textContent = t; out.scrollTop = out.scrollHeight; });
    try { await stream("/api/write", req, { delta: (d) => { t += d.text; paintK(); } }); }
    catch (err) { t = t || ""; toast(esc(err.message)); }
    if (c.t) M.pitches[c.t.url] = t; else if (c.q) M.articles[c.q.id] = t; else M.fixpack = t;
    save(); drawDeck();
  }
});
function advance(how) {
  const c = DECK[0]; if (!c) return; APP.M.deck[c.id] = how; save();
  const el = $("#dk"); el?.classList.add(how === "skip" ? "out-l" : "out-r");
  setTimeout(() => { DECK.shift(); if (DASH.page === "actions") dashRender(); else drawDeck(); }, 260);
}
addEventListener("keydown", (e) => {
  if ($("#reportWrap").hidden || $(".modal")) return;
  if (/input|textarea/i.test(document.activeElement?.tagName)) return;
  if (e.key === "/") { e.preventDefault(); toggleAgent(true); return; }
  if (DASH.page !== "actions") return;
  if (e.key === "ArrowRight") advance("done");
  if (e.key === "ArrowLeft") advance("skip");
});

/* ---------- ask the agent ---------- */
function renderSugs() {
  const M = APP.M; const ans = Object.values(M.answers); const rc = {}; ans.forEach((a) => (a.brands || []).forEach((b) => { if (!isYou(b, M)) rc[b] = (rc[b] || 0) + 1; }));
  const top = Object.entries(rc).sort((a, b) => b[1] - a[1])[0];
  const s = ["What should I do first this week?", top ? `Why does ${top[0]} beat us?` : "Which questions am I missing?", "Write a LinkedIn post about what we found", "Summarise this for my boss in 5 bullets", "Which page should I pitch first and why?"];
  $("#sugs").innerHTML = s.map((x) => `<button type="button">${esc(x)}</button>`).join("");
}
$("#sugs").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") ask(e.target.textContent); });
$("#askForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#askIn").value.trim(); if (q) { $("#askIn").value = ""; ask(q); } });
function renderChat() { const M = APP.M; $("#chat").innerHTML = (M.chat || []).map((m) => `<div class="msg ${m.role}">${m.role === "me" ? esc(m.text) : `<div class="md">${md(m.text)}</div>`}</div>`).join(""); }
async function ask(q) {
  const M = APP.M; M.chat = M.chat || []; const hist = M.chat.slice(-8);
  M.chat.push({ role: "me", text: q }); renderChat();
  const el = document.createElement("div"); el.className = "msg ai"; el.innerHTML = `<div class="md typing"></div>`; $("#chat").append(el); el.scrollIntoView({ behavior: "smooth", block: "end" });
  let t = ""; const paintC = throttled(() => { el.firstChild.innerHTML = md(t); el.scrollIntoView({ block: "end" }); });
  try { await stream("/api/write", { kind: "chat", data: { context: digest(M) + (M.insights ? "\n\nINSIGHTS\n" + M.insights : ""), history: hist, question: q } }, { delta: (d) => { t += d.text; paintC(); } }); }
  catch (err) { t = t || "⚠️ " + err.message; }
  M.chat.push({ role: "ai", text: t }); save(); renderChat(); $("#chat").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
}

/* =================================================================== SCREENS */
const SCREENS = ["landing", "auth", "mission", "onboard", "ready", "reportWrap", "team", "billing", "account"];
// Team, Plans & payment and Account are side pages. Remember the screen you opened them from, so Back returns to it. (Going to "home" instead
// opens the most recently saved brand, which can be a different one, even one whose check was never finished.)
const SIDE = ["team", "billing", "account"]; let CAME_FROM = null;
function backFromSide() {
  const from = CAME_FROM; CAME_FROM = null;
  if (from === "reportWrap" && APP.M?.finishedAt) return showReport(DASH.page);
  if ((from === "ready" || from === "mission") && APP.M) return showRunning();
  return from === "landing" ? goHome() : home();
}
function screen(id) {
  if (SIDE.includes(id)) { const cur = SCREENS.find((s) => !$("#" + s).hidden); if (cur && !SIDE.includes(cur)) CAME_FROM = cur; }
  SCREENS.forEach((s) => ($("#" + s).hidden = s !== id));
  document.body.classList.add("is-light"); // every screen is light now; the agent console included
  $$(".modal,.drawer,.ck,.paid,.pf-menu").forEach((x) => x.remove()); document.body.classList.remove("sheet-open");
  scrollTo({ top: 0 });
}
const ICONS = {
  overview: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1 1.2 2.1 1.8 3.5 1.8s2.5-.6 3.5-1.8M9 9.5h.01M15 9.5h.01"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  gap: '<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="M9 12h6"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  rank: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
  chat: '<path d="M5 18l-1 3 4-2c1.2.5 2.6.8 4 .8 4.7 0 8-3.1 8-7.3S16.7 5.2 12 5.2 4 8.3 4 12.5c0 2.1.8 4 2 5.5z"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 9l5 3-5 3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
  research: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  compare: '<path d="M8 4v16M16 4v16M4 8h8M12 16h8"/>',
  action: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.6c2.4-.3 4.3 1 5 3.9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3M14 9l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h3"/>',
};
const icon = (k, s = 16) => `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ""}</svg>`;
function paintIcons(root = document) { $$("i[data-ic]", root).forEach((el) => { el.outerHTML = icon(el.dataset.ic); }); }

// Brand avatars: real favicons for domains, a tinted letter for brand names.
const hue = (s) => [...norm(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const letterAv = (name, cls = "") => `<span class="av ${cls}" style="--h:${hue(name)}">${esc((String(name || "?").trim()[0] || "?").toUpperCase())}</span>`;
const favImg = (d) => `<img class="fav" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64" alt="" loading="lazy" data-l="${esc((d[0] || "•").toUpperCase())}">`;
document.addEventListener("error", (e) => { const t = e.target; if (t?.matches?.("img.fav")) { const s = document.createElement("span"); s.className = "fav l"; s.textContent = t.dataset.l || "•"; t.replaceWith(s); } }, true);

/* =================================================================== ONBOARDING
   Modelled on Peec AI's setup flow: one question at a time under a ghosted preview of the app that fills in as you
   answer, with the detailed reviews (brand profile, prompt focus, prompt set) in full-height sheets.
   scan → brand profile → market → competitors → topics → focus → prompts → review → run. */
const INTENTS = { informational: ["Informational", "var(--i-info)"], commercial: ["Commercial", "var(--i-comm)"], transactional: ["Transactional", "var(--i-trans)"] };
const FOCUS = { research: ["Research", "More emphasis on exploring problems and solutions.", [50, 30, 20]], compare: ["Compare options", "More emphasis on comparisons and recommendations.", [25, 50, 25]], action: ["Take action", "More emphasis on buying, booking, or signing up.", [25, 25, 50]] };
const ENG_KEY = { chatgpt: "OPENAI_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY", aio: "DATAFORSEO_LOGIN", aimode: "DATAFORSEO_LOGIN" };
const ENG_ALL = ["chatgpt", "perplexity", "gemini", "groq", "aio", "aimode"];
const MARKETS = ["Global", "United States", "United Kingdom", "India", "Europe", "Australia"];
// A market's country code from what was picked or typed ("India", "IN"), using the server's country list. null = Global/region.
const countryCode = (t) => { const n = norm(t); return (APP.cfg.countries || []).find(([c, name]) => norm(name) === n || c.toLowerCase() === n)?.[0] || null; };
const countryName = (code) => (APP.cfg.countries || []).find(([c]) => c === code)?.[1] || code;
const OB_BACK = { scan: "home", profile: "home", market: "profile", rivals: "market", topicsGen: "rivals", topics: "rivals", focus: "topics", promptsGen: "focus", promptsReady: "focus", review: "promptsReady" };
let OB = null;
const splitList = (s) => String(s || "").split(/,|;|\/|\band\b/).map((x) => x.trim()).filter((x) => x.length > 1).slice(0, 6);

const billingOn = () => !!APP.cfg.billingUi && DATA.server(); // BILLING_ENABLED: billing screens, reminders and the first-run plan page exist only when it is on
// PAY_HIDDEN (for now): everyone starts on the free trial at sign-up, and the payment side is hidden: the Plans & payment page
// (pricing cards), "Add / Connect payment method" and the payment-method details. Nothing is removed; set false to bring it all back.
const PAY_HIDDEN = true;

/* What the current plan allows, so setup only OFFERS and GENERATES what can be saved. The server enforces the same limits (and stays the
   authority); this keeps people from generating 25 prompts and then being refused at 15. Unlimited without accounts or when the plan has no limit. */
const PLANL = {
  b: () => (DATA.server() ? APP.cfg.billing : null),
  f: () => PLANL.b()?.report?.features || null,
  name: () => (PLANL.b()?.plan?.status === "trialing" ? "free trial" : PLANL.b()?.plan?.name || "current"),
  prompts(active = 0) { const b = PLANL.b(), lim = b?.limits?.questions; if (lim == null) return Infinity; return Math.max(0, lim - Math.max(0, (b.used?.questions || 0) - active)); },
  rivals() { const c = PLANL.f()?.competitors; return c == null ? Infinity : c; },
  samples() { const n = PLANL.f()?.samples; return n == null ? 3 : Math.max(1, Math.min(3, n)); },
  engines(list) { const e = PLANL.f()?.engines; return e ? list.filter((x) => e.includes(x)) : list; },
  schedules() { return PLANL.f()?.schedules || ["off", "weekly", "daily"]; },
};
async function refreshBilling() { if (!DATA.server()) return; try { APP.cfg.billing = await api("GET", "/api/billing"); } catch {} }
const activeOf = (c) => (c?.questions || []).filter((q) => q.on !== false).length;
const promptCap = () => PLANL.prompts(activeOf(OB?.saved));
const promptMsg = () => `Your ${PLANL.name()} plan tracks up to ${promptCap()} prompts. Uncheck one to add another, or upgrade in Plans & payment for more.`;
const perOpts = () => { const cap = promptCap(), T = Math.max(1, OB.topics.length); if (cap === Infinity) return [2, 3, 4, 5]; const f = [1, 2, 3, 4, 5].filter((k) => k * T <= cap); return f.some((k) => k >= 2) ? f.filter((k) => k >= 2) : f; }; // 2 to 5 as before, down to 1 only when the plan leaves no room for 2
const effPer = () => { const o = perOpts(); return o.includes(OB.perTopic) ? OB.perTopic : o.length ? o[o.length - 1] : 1; };

// opts.parent: the brand this is a new market of (another country version of its site).
async function startOnboarding(url, saved, opts = {}) {
  APP.ctl?.abort(); APP.ctl = new AbortController(); const sig = APP.ctl.signal; APP.running = false; await refreshBilling();
  OB = { url, saved, parent: opts.parent || saved?.parent || null, step: "scan", scan: null, checks: [], pages: [], profile: null, rivals: [], topics: [], focus: "action", perTopic: 3, samples: Math.max(1, Math.min(PLANL.samples(), saved?.samples || 1)), questions: [], selTopic: null, engines: PLANL.engines(APP.cfg.engines.filter((e) => e !== "aimode")), gen: false, err: "" };
  screen("onboard"); $("#obSite").textContent = host(url); obRender();
  try {
    let result = null;
    await stream("/api/site", { url }, {
      step: (d) => { OB.checks.push({ id: d.id, text: d.text, state: "run" }); obRender(); },
      done: (d) => { const c = OB.checks.find((x) => x.id === d.id); if (c) { c.state = d.ok === false ? "bad" : "ok"; c.text = d.text || c.text; } obRender(); },
      page: (p) => { OB.pages.push(p); },
      result: (r) => { result = r; },
    }, sig);
    if (!result) throw new Error("The site scan didn't finish.");
    OB.scan = result;
    // The site decides where it sells when it says so (a /in path, lang="en-IN", ₹ prices); otherwise the saved choice stands.
    const p = { ...result.profile, ...(saved?.profile || {}), site: result.profile.site, ...(result.audit?.locale?.country ? { market: result.profile.market, country: result.profile.country } : {}) };
    for (const k of ["identity", "products", "facts"]) p[k] = p[k]?.length ? p[k] : result.profile[k] || [];
    p.personas = p.personas?.length ? p.personas : result.profile.personas?.length ? result.profile.personas : splitList(p.audience);
    OB.profile = p;
    OB.rivals = (p.competitors || []).slice(0, PLANL.rivals()).map((name) => ({ name }));
    if (saved?.questions?.length) {
      OB.questions = saved.questions.map((q) => ({ topic: q.topic || "General", intent: q.intent, persona: q.persona || "", text: q.text, on: q.on !== false }));
      OB.topics = (saved.topics?.length ? saved.topics : [...new Set(OB.questions.map((q) => q.topic))]).map((t) => (typeof t === "string" ? { name: t } : t));
      OB.focus = saved.focus || OB.focus; OB.perTopic = saved.perTopic || OB.perTopic; OB.samples = saved.samples || OB.samples;
      const e = (saved.engines || []).filter((x) => APP.cfg.engines.includes(x)); if (e.length) OB.engines = e;
      OB.step = "promptsReady";
    } else { OB.step = "profile"; OB.sheet = "profile"; }
    obRender();
  } catch (err) { if (sig.aborted) return; OB.err = err.message; obRender(); }
}
function obProfile() {
  const p = OB.profile;
  return { ...p, name: (p.name || "").trim() || host(p.site), competitors: OB.rivals.map((r) => r.name), audience: (p.personas || []).join(", ") || p.audience || "" };
}
function obGo(step) {
  if (!OB) return;
  if (step === "home") { APP.ctl?.abort(); return goHome(); }
  if (step === "market" && !(OB.profile?.name || "").trim()) { toast("Add your company name first."); return $('[data-f="name"]')?.focus(); }
  OB.step = step; OB.sheet = step === "profile" ? "profile" : null; obRender();
  if (step === "topicsGen") obTopics(false);
  if (step === "promptsGen") obPrompts(false);
}
$("#obBack").addEventListener("click", () => obGo(OB ? OB_BACK[OB.step] || "home" : "home"));

/* ---- the ghosted app preview above each question */
const SKNAV = [["Home", ["Overview", "My website"]], ["Brand", ["Competitors", "Insights"]], ["Prompts", ["Topics", "All prompts"]], ["Sources", ["Gap analysis"]]];
function frame(nav, title, main) {
  const p = OB?.profile, d = host(OB?.url || "");
  const brand = `<div class="fr-brand">${p ? favImg(d) : '<span class="sk sq"></span>'}${p ? `<b>${esc(p.name)}</b>${icon("down", 13)}` : '<span class="sk" style="width:90px"></span>'}</div>`;
  const side = SKNAV.map(([g, items]) => nav ? `<div class="fr-g">${g}</div>${items.map((it) => `<div class="fr-i${it === nav ? " on" : ""}">${it}</div>`).join("")}`
    : `<div class="fr-g"><span class="sk" style="width:34px"></span></div>${items.map(() => `<div class="fr-i"><span class="sk sq sm"></span><span class="sk" style="width:${50 + Math.round(Math.random() * 30)}px"></span></div>`).join("")}`).join("");
  return `<div class="fr"><aside class="fr-side">${brand}<div class="fr-nav">${side}</div></aside><div class="fr-main"><div class="fr-top">${icon("side", 15)}${title ? `<b>${esc(title)}</b>` : '<span class="sk" style="width:80px"></span>'}<span class="sp"></span><span class="fr-ib">${icon("chat", 14)}</span><span class="fr-ib">${icon("info", 14)}</span></div>${main || skelChart()}</div></div>`;
}
function skelChart() {
  return `<div class="fr-pad"><div class="fr-chips">${[70, 52, 96, 84].map((w) => `<span class="fr-chip"><span class="sk sq sm"></span><span class="sk" style="width:${w}px"></span></span>`).join("")}</div>
  <span class="sk" style="width:62px;height:12px"></span><span class="sk" style="width:220px;margin-top:8px"></span>
  <div class="fr-card"><span class="sk" style="width:90px"></span><svg viewBox="0 0 600 150" preserveAspectRatio="none" class="fr-curve"><path d="M10 10 C 90 120, 160 150, 230 110 S 380 40, 470 40 S 560 70, 595 130" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></div></div>`;
}
const skRows = (n, cols = [180, 70, 70, 90]) => Array.from({ length: n }, () => `<div class="fr-tr">${cols.map((w, i) => `<span class="sk" style="width:${i ? w : w - Math.round(Math.random() * 60)}px"></span>`).join("")}</div>`).join("");
function listCol(head, items, rm, addForm, addPh, loading) {
  return `<div class="fr-col"><div class="fr-colh">${head}</div>
    ${addForm ? `<form class="fr-add" data-form="${addForm}"><input id="obAdd-${addForm}" placeholder="${esc(addPh)}" aria-label="${esc(addPh)}" autocomplete="off"><button type="submit" aria-label="Add">${icon("plus", 14)}</button></form>` : ""}
    ${items.map((it, i) => `<div class="fr-row">${it}${rm ? `<button type="button" class="fr-x" data-${rm}="${i}" aria-label="Remove">${icon("trash", 14)}</button>` : ""}</div>`).join("")}
    ${loading ? Array.from({ length: 4 }, () => `<div class="fr-row"><span class="sk" style="width:${110 + Math.round(Math.random() * 70)}px"></span></div>`).join("") : ""}</div>`;
}
const intentTag = (i) => { const x = INTENTS[i]; return x ? `<span class="itag"><i style="background:${x[1]}"></i>${x[0]}</span>` : `<span class="itag">${esc(i || "–")}</span>`; };
function promptsTable(qs, opts = {}) {
  return `<div class="fr-table"><div class="fr-th">${opts.check ? `<input type="checkbox" data-pqall ${qs.length && qs.every((q) => q.on) ? "checked" : ""} aria-label="Select all">` : ""}<span>Prompt</span><span>Intent</span><span>Persona</span></div>
    ${qs.map((q) => `<div class="fr-tr${q.on === false ? " off" : ""}">${opts.check ? `<input type="checkbox" data-pq="${OB.questions.indexOf(q)}" ${q.on ? "checked" : ""} aria-label="Track this prompt">` : ""}<span class="t">${esc(q.text)}</span>${intentTag(q.intent)}<span>${q.persona ? `<span class="ptag">${esc(q.persona)}</span>` : "–"}</span></div>`).join("")}
    ${opts.loading ? skRows(3) : ""}</div>`;
}
function obFrame() {
  const s = OB.step;
  if (s === "scan" || s === "profile" || s === "market") return frame(null, "", "");
  if (s === "rivals") {
    const col = `<div class="fr-col"><div class="fr-colh">Competitors <span>${OB.rivals.length}${PLANL.rivals() === Infinity ? "" : ` of ${PLANL.rivals()} on your plan`}</span></div>
      <form class="fr-add" data-form="rival"><input id="obAdd-rival" placeholder="Add competitor" aria-label="Add competitor" autocomplete="off"><button type="submit" aria-label="Add">${icon("plus", 14)}</button></form>
      <div class="fr-row">${letterAv(OB.profile.name, "you")}<span>${esc(OB.profile.name)}</span><span class="youtag">You</span></div>
      ${OB.rivals.map((r, i) => `<div class="fr-row">${letterAv(r.name)}<span>${esc(r.name)}</span><button type="button" class="fr-x" data-rvx="${i}" aria-label="Remove ${esc(r.name)}">${icon("trash", 14)}</button></div>`).join("")}</div>`;
    return frame("Competitors", "Competitors", `<div class="fr-split">${col}<div class="fr-col grow"><div class="fr-th"><span>Brand</span><span>Visibility</span><span>SoV</span><span>Position</span></div>${skRows(6, [150, 60, 60, 60])}</div></div>`);
  }
  if (s === "topicsGen" || s === "topics") return frame("Topics", "Topics", `<div class="fr-split">${listCol("Topics", OB.topics.map((t) => `<span>${esc(t.name)}</span>`), "tpx", s === "topics" ? "topic" : "", "Add topics", OB.gen)}<div class="fr-col grow"><div class="fr-th"><span>Prompt</span><span>Intent</span><span>Persona</span></div>${skRows(5, [220, 80, 90])}</div></div>`);
  if (s === "focus" || s === "promptsGen" || s === "promptsReady" || s === "review") {
    const sel = OB.selTopic && OB.topics.some((t) => t.name === OB.selTopic) ? OB.selTopic : OB.topics[0]?.name;
    const cnt = (t) => OB.questions.filter((q) => q.topic === t).length;
    const col = `<div class="fr-col"><div class="fr-colh">Topics</div>${OB.topics.map((t) => `<button type="button" class="fr-row sel${t.name === sel ? " on" : ""}" data-seltopic="${esc(t.name)}"><span>${esc(t.name)}</span><span class="n">${cnt(t.name) || ""}</span></button>`).join("")}</div>`;
    const qs = OB.questions.filter((q) => q.topic === sel);
    return frame("All prompts", sel || "All prompts", `<div class="fr-split">${col}<div class="fr-col grow">${s === "focus" ? `<div class="fr-th"><span>Prompt</span><span>Intent</span><span>Persona</span></div>${skRows(6, [220, 80, 90])}` : promptsTable(qs, { loading: OB.gen })}</div></div>`);
  }
  return frame(null, "", "");
}

/* ---- the question under the preview */
function pill(form, value, ph, ic, extra = "") {
  return `<form class="pill" data-form="${form}">${ic ? `<span class="pill-ic">${icon(ic, 17)}</span>` : ""}<input id="obPill" value="${esc(value || "")}" placeholder="${esc(ph)}" aria-label="${esc(ph)}" autocomplete="off">${extra}<button class="go" type="submit" aria-label="Continue">${icon("arrow", 16)}</button></form>`;
}
function obAsk() {
  const s = OB.step, p = OB.profile;
  if (s === "scan") {
    if (OB.err) return `<h1>We couldn't read ${esc(host(OB.url))}</h1><p>${esc(OB.err)}</p><div class="ob-btns"><button class="btn ghost" type="button" data-act="home">Use another site</button><button class="btn" type="button" data-act="retry">Try again</button></div>`;
    const done = OB.checks.filter((c) => c.state !== "run").length, cur = [...OB.checks].reverse().find((c) => c.state === "run") || OB.checks[OB.checks.length - 1];
    return `<h1>Reading ${esc(host(OB.url))}<span class="dots"></span></h1><p>${esc(cur?.text || "Connecting to your site")}</p><div class="ob-prog"><i style="width:${Math.min(96, 6 + done * 15)}%"></i></div>`;
  }
  if (s === "profile") return `<h1>Review your brand profile</h1><p>We pulled this from ${esc(host(p.site))}.</p><div class="ob-btns"><button class="btn" type="button" data-act="openProfile">Open profile</button></div>`;
  if (s === "market") { const lc = OB.scan?.audit?.locale, tracked = new Set(OB.parent ? marketsOf(OB.parent).map((w) => w.market?.code) : []), sib = (OB.scan?.audit?.markets || []).filter((x) => !tracked.has(x.code));
    const note = lc?.country ? `<p class="muted sm">We read the ${esc(lc.country.name)} version of ${esc(host(p.site))}${OB.scan.audit.scope ? ` (${esc(OB.scan.audit.scope)})` : ""}${lc.redirectedTo ? ", where the site sent us" : ""}, so we've picked ${esc(lc.country.name)}.${sib.length ? ` It also has ${esc(sib.slice(0, 4).map((x) => x.name).join(", "))}${sib.length > 4 ? ` and ${sib.length - 4} more` : ""}: add ${sib.length > 1 ? "them" : "it"} as markets once this one is set up.` : ""}</p>` : "";
    return `<h1>Where do you sell?</h1><p>The market AI should answer for. We write prompts the way buyers there ask them, and ask each AI from there.</p>${note}${pill("market", p.market, "Search countries or regions", "globe")}<div class="ob-sugs">${[...new Set([p.market, ...MARKETS].filter(Boolean))].slice(0, 6).map((m) => `<button type="button" data-market="${esc(m)}"${norm(m) === norm(p.market) ? ' class="on"' : ""}>${esc(m)}</button>`).join("")}</div>`; }
  if (s === "rivals") return `<h1>Review your competitors</h1><p>Remove any that aren't real rivals, or add your own. Suggested from your brand profile. <button type="button" class="lnk" data-act="openProfile">Edit profile</button></p><div class="ob-btns"><button class="btn ghost" type="button" data-act="focusAdd">Add competitor</button><button class="btn" type="button" data-go="topicsGen">Continue</button></div>`;
  if (s === "topicsGen") return `<h1>Generating topics<span class="dots"></span></h1><p>The themes your buyers research, from your products and services.</p>`;
  if (s === "topics") return `<h1>Review your topics</h1><p>Remove any that do not fit your brand, or add your own. Generated from your brand profile. <button type="button" class="lnk" data-act="openProfile">Edit profile</button></p><div class="ob-btns"><button class="btn ghost" type="button" data-act="focusAdd">Add topics</button><button class="btn" type="button" data-go="focus" ${OB.topics.length ? "" : 'aria-disabled="true"'}>Continue</button></div>`;
  if (s === "focus") return `<h1>What should your prompts focus on?</h1><p>Choose where your buyers are in their journey.</p><div class="ob-btns"><button class="btn" type="button" data-act="openFocus">Choose focus</button></div>`;
  if (s === "promptsGen") return `<h1>Writing your prompts<span class="dots"></span></h1><p>${OB.questions.length} of about ${OB.topics.length * OB.perTopic} written, as your buyers would ask them.</p><div class="ob-prog"><i style="width:${Math.min(96, (100 * OB.questions.length) / Math.max(1, OB.topics.length * OB.perTopic))}%"></i></div>`;
  if (s === "promptsReady" || s === "review") {
    const on = OB.questions.filter((q) => q.on).length;
    return `<h1>Your prompt set is ready</h1><p>${on} prompts across ${OB.topics.length} topics, generated from your brand profile. Your name is left out on purpose, so we see whether AI brings you up on its own.</p><div class="ob-btns"><button class="btn ghost" type="button" data-act="openReview">Review prompts</button><button class="btn" type="button" data-act="launch">Run analysis</button></div>`;
  }
  return "";
}

/* ---- sheets: the detailed reviews */
function chipEditor(key, items, ph) {
  return `<div class="chipin" data-chips="${key}">${(items || []).map((x, i) => `<span class="tag">${esc(x)}<button type="button" data-rm="${key}:${i}" aria-label="Remove ${esc(x)}">${icon("x", 11)}</button></span>`).join("")}<input data-add="${key}" id="chip-${key}" placeholder="${esc(ph)}" aria-label="${esc(ph)}"></div>`;
}
const fld = (label, hint, el, id) => `<div class="field"><label${id ? ` for="${id}"` : ""}>${label} <span class="q" title="${esc(hint)}">${icon("info", 13)}</span></label><span class="hint">${hint}</span>${el}</div>`;
function sheetProfile() {
  const p = OB.profile, a = OB.scan.audit || {};
  return {
    body: `<button type="button" class="sheet-back" data-act="home">${icon("arrow", 14)}Back</button>
    <div class="sheet-narrow"><h2 id="obSheetTitle">Review your brand profile</h2><p class="sub">We pulled this info from ${esc(host(p.site))}. You can change it now or update it later.</p>
      ${fld("Company name", "Exactly as customers say it. This is the name we look for in AI answers.", `<input id="ob-name" data-f="name" value="${esc(p.name)}">`, "ob-name")}
      ${fld("Description", "What your brand does, in a sentence or two.", `<textarea id="ob-offer" data-f="offer" rows="3">${esc(p.offer)}</textarea>`, "ob-offer")}
      ${fld("Category", "The specific niche your brand competes in, not a broad industry.", `<input id="ob-category" data-f="category" value="${esc(p.category)}">`, "ob-category")}
      ${fld("Brand identity", "Adjectives that describe your brand.", chipEditor("identity", p.identity, "Add +"))}
      ${fld("Products and services", "What your brand offers.", chipEditor("products", p.products, "Add +"))}
      ${fld("Personas", "Who your brand is for.", chipEditor("personas", p.personas, "Add +"))}
      ${fld("Facts", "What AI should get right about you. We fact-check AI against these.", chipEditor("facts", p.facts, "Add +"))}
      <div class="sitecheck"><div><span class="k">AI-readiness</span><b>${a.avg ?? "–"}<small>/100</small></b></div>${Object.entries(a.bots || {}).map(([b, ok]) => `<div><span class="k">${esc(b)}</span><span class="pillx ${ok ? "ok" : "no"}">${ok ? "Allowed" : "Blocked"}</span></div>`).join("")}<div><span class="k">llms.txt</span><span class="pillx ${a.llms ? "ok" : "no"}">${a.llms ? "Found" : "Missing"}</span></div></div>
    </div>`,
    foot: `<span class="sp"></span><button class="btn" type="button" data-act="profileOk">Looks good</button>`,
  };
}
function dbar(parts) { return `<div class="dbar">${parts.map(([v, c]) => `<i style="flex:${Math.max(0.0001, v)};background:${c}"></i>`).join("")}</div>`; }
function sheetFocus() {
  const d = FOCUS[OB.focus][2], cap = promptCap(), n = Math.min(OB.topics.length * effPer(), cap), perO = perOpts();
  return {
    body: `<button type="button" class="sheet-back" data-act="closeSheet">${icon("arrow", 14)}Back</button>
    <div class="sheet-narrow"><h2 id="obSheetTitle">What should your prompts focus on?</h2><p class="sub">We'll include a mix of questions, with more emphasis on your selection.</p>
    <div class="focus3">${Object.entries(FOCUS).map(([k, [t, sub]]) => `<button type="button" class="fcard${OB.focus === k ? " on" : ""}" data-focus="${k}"><b>${icon(k, 15)}${t}</b><span>${sub}</span></button>`).join("")}</div>
    <div class="fsec"><b>Non-branded vs branded</b><span>How many prompts name your brand</span></div>
    ${dbar([[100, "var(--line2)"], [0, "var(--i-trans)"]])}
    <div class="dleg"><span><i style="background:var(--line2)"></i>Non-branded <b>100%</b></span><span><i style="background:var(--i-trans)"></i>Branded <b>0%</b></span><span class="muted">Your name is left out, so a mention is earned.</span></div>
    <div class="fsec"><b>Intent distribution</b><span>Where buyers are in their journey</span></div>
    ${dbar([[d[0], "var(--i-info)"], [d[1], "var(--i-comm)"], [d[2], "var(--i-trans)"]])}
    <div class="dleg"><span><i style="background:var(--i-info)"></i>Informational <b>${d[0]}%</b></span><span><i style="background:var(--i-comm)"></i>Commercial <b>${d[1]}%</b></span><span><i style="background:var(--i-trans)"></i>Transactional <b>${d[2]}%</b></span></div>
    <div class="fsec"><b>Prompts per topic</b><span>${OB.topics.length} topics${cap === Infinity ? "" : ` · your ${esc(PLANL.name())} plan tracks up to ${cap} prompts`}</span></div>
    ${perO.length ? `<div class="seg">${perO.map((k) => `<button type="button" data-per="${k}" aria-pressed="${effPer() === k}">${k}</button>`).join("")}</div>` : `<p class="muted">Your ${esc(PLANL.name())} plan tracks up to ${cap} prompts, fewer than your ${OB.topics.length} topics. Go back and remove some topics.</p>`}
    <div class="fsec"><b>Answers per prompt</b><span>AI answers vary run to run. Asking more than once averages the luck out (more cost)</span></div>
    <div class="seg">${[1, 2, 3].filter((k) => k <= PLANL.samples()).map((k) => `<button type="button" data-samples="${k}" aria-pressed="${OB.samples === k}">${k}×</button>`).join("")}</div>
    <div class="fsec"><b>AI engines</b><span>Where the prompts run, live with web search</span></div>
    <div class="engs">${ENG_ALL.map((e) => { const pl = PLANL.engines([e]).length === 1, av = APP.cfg.engines.includes(e) && pl, on = OB.engines.includes(e); return `<label class="engc${av ? "" : " na"}${on ? " on" : ""}"><input type="checkbox" data-eng="${e}" ${on ? "checked" : ""} ${av ? "" : "disabled"}><span class="edot" style="background:${ENGC[e]}"></span><b>${ENG[e]}</b>${av ? "" : !pl ? `<span class="muted">Not on your plan</span>` : `<span class="muted">Add ${ENG_KEY[e]}</span>`}</label>`; }).join("")}</div>
    </div>`,
    foot: `<span class="muted">About ${n} prompts × ${OB.engines.length} engine${OB.engines.length === 1 ? "" : "s"}${OB.samples > 1 ? ` × ${OB.samples}` : ""} = ${n * OB.engines.length * OB.samples} answers per check</span><span class="sp"></span><button class="btn" type="button" data-act="genPrompts" ${n && OB.engines.length ? "" : 'aria-disabled="true"'}>Generate prompts</button>`,
  };
}
function sheetReview() {
  const qs = OB.questions, on = qs.filter((q) => q.on), sel = OB.reviewTopic || "";
  const shown = sel ? qs.filter((q) => q.topic === sel) : qs;
  const pers = [...new Set([...(OB.profile.personas || []), ...qs.map((q) => q.persona).filter(Boolean)])];
  const ic = Object.keys(INTENTS).map((k) => on.filter((q) => q.intent === k).length);
  const tot = Math.max(1, ic.reduce((a, b) => a + b, 0));
  const jobs = on.length * OB.engines.length * OB.samples, cap = promptCap();
  return {
    body: `<h2 id="obSheetTitle">Review your prompt set</h2><p class="sub">Review the prompts generated for your topics. Uncheck any that should not run.</p>
    <div class="rv-grid">
      <div class="rv-card rv-topics"><div class="rv-h">Topics</div>
        <button type="button" class="rv-t${sel ? "" : " on"}" data-rvtopic=""><span>All topics</span><span class="n">${qs.length}</span></button>
        ${OB.topics.map((t) => { const tq = qs.filter((q) => q.topic === t.name); return `<div class="rv-t${sel === t.name ? " on" : ""}"><input type="checkbox" data-tpon="${esc(t.name)}" ${tq.length && tq.every((q) => q.on) ? "checked" : ""} aria-label="Track all prompts in ${esc(t.name)}"><button type="button" data-rvtopic="${esc(t.name)}">${esc(t.name)}</button><span class="n">${tq.length}</span></div>`; }).join("")}
      </div>
      <div class="rv-card rv-main">${promptsTable(shown, { check: true })}
        <form class="rv-add" data-form="prompt">${icon("plus", 14)}<input placeholder="Add your own prompt${sel ? ` to ${esc(sel)}` : ""}" aria-label="Add your own prompt" autocomplete="off"><button class="btn ghost sm" type="submit">Add</button></form></div>
      <div class="rv-card rv-cov"><div class="rv-h">Coverage</div>
        <div class="cov-sec"><b>Personas</b><span class="muted">${pers.filter((x) => on.some((q) => q.persona === x)).length} of ${pers.length} covered</span></div>
        ${pers.map((x) => { const n = on.filter((q) => q.persona === x).length; return `<div class="cov-row"><span>${esc(x)}</span><span class="cov-n${n ? "" : " zero"}">${n}</span></div>`; }).join("")}
        <div class="cov-sec"><b>Intent distribution</b></div>
        ${dbar(Object.values(INTENTS).map((x, i) => [ic[i], x[1]]))}
        ${Object.values(INTENTS).map((x, i) => `<div class="cov-row"><span><i class="dotc" style="background:${x[1]}"></i>${x[0]}</span><b>${Math.round((100 * ic[i]) / tot)}%</b></div>`).join("")}
        <div class="cov-sec"><b>Engines</b></div>
        ${OB.engines.map((e) => `<div class="cov-row"><span><i class="dotc" style="background:${ENGC[e]}"></i>${ENG[e]}</span><b>${on.length}</b></div>`).join("")}
      </div>
    </div>`,
    foot: `<span class="muted">Tracking <b>${on.length}${cap === Infinity ? "" : " of " + cap} prompts</b> · ${jobs} live AI answers per run</span><span class="sp"></span><button class="btn ghost" type="button" data-act="closeSheet">Cancel</button><button class="btn" type="button" data-act="launch" ${jobs && on.length <= cap ? "" : 'aria-disabled="true"'}>Run analysis</button>`,
  };
}

function obRender() {
  if (!OB || $("#onboard").hidden) return;
  const keep = document.activeElement?.id, caret = document.activeElement?.selectionStart;
  $("#obFrame").innerHTML = obFrame();
  $("#obAsk").innerHTML = obAsk();
  const sheet = OB.sheet === "profile" ? sheetProfile() : OB.sheet === "focus" ? sheetFocus() : OB.sheet === "review" ? sheetReview() : null;
  const wasOpen = !$("#obSheet").hidden;
  $("#obSheet").hidden = !sheet;
  document.body.classList.toggle("sheet-open", !!sheet);
  if (sheet) { const sc = $("#obSheetBody").scrollTop; $("#obSheetBody").innerHTML = sheet.body; $("#obSheetFoot").innerHTML = sheet.foot; if (wasOpen) $("#obSheetBody").scrollTop = sc; }
  if (keep) { const el = document.getElementById(keep); if (el) { el.focus(); try { if (caret != null) el.setSelectionRange(caret, caret); } catch {} } }
}
function obSheet(name) { OB.sheet = name; obRender(); $("#obSheetBody").scrollTop = 0; }

/* ---- generation */
async function obTopics(more) {
  if (OB.gen) return; OB.gen = true; if (!more) OB.topics = []; obRender();
  let buf = "";
  const take = (l) => { const t = l.replace(/^[\s\-*•\d.)]+/, "").replace(/["“”*]/g, "").trim(); if (!t || t.length > 60 || OB.topics.some((x) => norm(x.name) === norm(t))) return; OB.topics.push({ name: t }); obRender(); };
  try { await stream("/api/write", { kind: "topics", data: { profile: obProfile(), exclude: more ? OB.topics.map((t) => t.name) : [] } }, { delta: (d) => { buf += d.text; const ls = buf.split("\n"); buf = ls.pop(); ls.forEach(take); }, final: () => { if (buf.trim()) take(buf); } }, APP.ctl.signal); }
  catch (e) { if (APP.ctl.signal.aborted) return; toast(esc(e.message)); }
  OB.gen = false;
  if (!OB.topics.length) { const p = OB.profile; (p.products?.length ? p.products.slice(0, 5) : [p.category || "Your category"]).forEach((name) => OB.topics.push({ name })); }
  if (OB.step === "topicsGen" || OB.step === "topics") { OB.step = "topics"; obRender(); }
}
async function obPrompts(more) {
  if (more && OB.questions.length >= promptCap()) return toast(esc(promptMsg()));
  if (OB.gen) return; OB.gen = true; if (!more) OB.questions = []; OB.selTopic = null; obRender();
  const topics = OB.topics.map((t) => t.name), exclude = OB.questions.map((q) => q.text); let buf = "";
  const pick = (t) => topics.find((x) => norm(x) === norm(t)) || topics.find((x) => norm(t).includes(norm(x)) || norm(x).includes(norm(t))) || topics[0];
  const take = (line) => {
    const m = line.split("|").map((x) => x.trim()); if (m.length < 2) return;
    if (OB.questions.length >= promptCap()) return; // the plan's allowance: generate no more than can be saved
    let q;
    if (m.length >= 4) q = { topic: pick(m[0]), intent: m[1].toLowerCase().replace(/[^a-z]/g, ""), persona: m[2], text: m.slice(3).join(" | ") };
    else q = { topic: m.length === 3 ? pick(m[0]) : topics[0], intent: (m.length === 3 ? m[1] : m[0]).toLowerCase().replace(/[^a-z]/g, ""), persona: "", text: m[m.length - 1] };
    q.text = q.text.replace(/^["“]|["”]$/g, "").trim(); if (!INTENTS[q.intent]) q.intent = "commercial";
    if (!q.text || q.text.length < 8 || OB.questions.some((x) => norm(x.text) === norm(q.text))) return;
    // Exactly what was asked for: the per-topic number chosen and never more than the plan tracks, whatever the AI returns.
    if (OB.questions.filter((x) => x.topic === q.topic).length >= effPer() || OB.questions.filter((x) => x.on !== false).length >= promptCap()) return;
    q.on = true; OB.questions.push(q); if (!OB.selTopic) OB.selTopic = q.topic; obRender();
  };
  try { await stream("/api/write", { kind: "topicQuestions", data: { profile: obProfile(), topics, perTopic: effPer(), focus: OB.focus, exclude } }, { delta: (d) => { buf += d.text; const ls = buf.split("\n"); buf = ls.pop(); ls.forEach(take); }, final: () => { if (buf.trim()) take(buf); } }, APP.ctl.signal); }
  catch (e) { if (APP.ctl.signal.aborted) return; toast(esc(e.message)); }
  OB.gen = false;
  if (!OB.questions.length) { OB.step = "focus"; obRender(); return toast("The AI didn't return any prompts. Try again in a minute."); }
  if (OB.step === "promptsGen") OB.step = "promptsReady";
  obRender();
}

/* ---- events (delegated; all state lives in OB, so re-rendering never loses typing) */
$("#onboard").addEventListener("input", (e) => { const f = e.target.dataset.f; if (f && OB?.profile) OB.profile[f] = e.target.value; });
$("#onboard").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && OB?.sheet && OB.sheet !== "profile") { OB.sheet = null; return obRender(); }
  const k = e.target.dataset.add; if (!k) return;
  if (e.key === "Backspace" && !e.target.value && OB.profile[k]?.length) { OB.profile[k].pop(); return obRender(); }
  if (e.key !== "Enter" && e.key !== ",") return;
  e.preventDefault(); const v = e.target.value.trim(); if (!v) return;
  OB.profile[k] = [...(OB.profile[k] || []), v]; obRender();
});
$("#onboard").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.pq != null) { if (t.checked && OB.questions.filter((q) => q.on).length >= promptCap()) { t.checked = false; return toast(esc(promptMsg())); } OB.questions[+t.dataset.pq].on = t.checked; obRender(); }
  if (t.dataset.pqall != null) { const sel = OB.reviewTopic; let cut = false; OB.questions.filter((q) => !sel || q.topic === sel).forEach((q) => { if (t.checked && !q.on && OB.questions.filter((x) => x.on).length >= promptCap()) { cut = true; return; } q.on = t.checked; }); if (cut) toast(esc(promptMsg())); obRender(); }
  if (t.dataset.tpon != null) { let cut = false; OB.questions.filter((q) => q.topic === t.dataset.tpon).forEach((q) => { if (t.checked && !q.on && OB.questions.filter((x) => x.on).length >= promptCap()) { cut = true; return; } q.on = t.checked; }); if (cut) toast(esc(promptMsg())); obRender(); }
  if (t.dataset.eng) { OB.engines = t.checked ? ENG_ALL.filter((x) => x === t.dataset.eng || OB.engines.includes(x)) : OB.engines.filter((x) => x !== t.dataset.eng); obRender(); }
});
$("#onboard").addEventListener("submit", (e) => {
  e.preventDefault(); const f = e.target.dataset.form, inp = e.target.querySelector("input"), v = inp.value.trim();
  if (f === "market") { if (!v) return inp.focus(); OB.profile.market = v; OB.profile.country = countryCode(v); return obGo("rivals"); }
  if (!v) return inp.focus();
  if (f === "rival" && !OB.rivals.some((r) => norm(r.name) === norm(v))) { if (OB.rivals.length >= PLANL.rivals()) return toast(`Your ${esc(PLANL.name())} plan tracks up to ${PLANL.rivals()} competitors per brand. Remove one to add another, or upgrade in Plans &amp; payment.`); OB.rivals.push({ name: v, added: true }); }
  if (f === "topic" && !OB.topics.some((t) => norm(t.name) === norm(v))) OB.topics.push({ name: v });
  if (f === "prompt" && !OB.questions.some((q) => norm(q.text) === norm(v))) { if (OB.questions.filter((q) => q.on).length >= promptCap()) return toast(esc(promptMsg())); OB.questions.push({ topic: OB.reviewTopic || OB.topics[0]?.name || "General", intent: "commercial", persona: "", text: v, on: true }); }
  inp.value = ""; obRender(); setTimeout(() => (document.getElementById(inp.id) || e.target.querySelector("input"))?.focus(), 0);
});
$("#onboard").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go],[data-act],[data-rm],[data-rvx],[data-tpx],[data-market],[data-focus],[data-per],[data-samples],[data-seltopic],[data-rvtopic]");
  if (!b || b.getAttribute("aria-disabled") === "true") return;
  const d = b.dataset;
  if (d.rm) { const [k, i] = d.rm.split(":"); OB.profile[k].splice(+i, 1); return obRender(); }
  if (d.rvx != null) { OB.rivals.splice(+d.rvx, 1); return obRender(); }
  if (d.tpx != null) { const t = OB.topics.splice(+d.tpx, 1)[0]; OB.questions = OB.questions.filter((q) => q.topic !== t?.name); return obRender(); }
  if (d.market) { OB.profile.market = d.market; OB.profile.country = countryCode(d.market); return obGo("rivals"); }
  if (d.focus) { OB.focus = d.focus; return obRender(); }
  if (d.per) { OB.perTopic = +d.per; return obRender(); }
  if (d.samples) { OB.samples = +d.samples; return obRender(); }
  if (d.seltopic != null) { OB.selTopic = d.seltopic; return obRender(); }
  if (d.rvtopic != null) { OB.reviewTopic = d.rvtopic; return obRender(); }
  if (d.go) return obGo(d.go);
  const a = d.act;
  if (a === "retry") return startOnboarding(OB.url, OB.saved);
  if (a === "home") return obGo("home");
  if (a === "openProfile") return obSheet("profile");
  if (a === "profileOk") { if (!(OB.profile.name || "").trim()) { toast("Add your company name first."); return $("#ob-name")?.focus(); } OB.sheet = null; return obGo(OB.step === "profile" ? "market" : OB.step); }
  if (a === "focusAdd") { const i = $("#obFrame input"); i?.focus(); i?.scrollIntoView({ block: "nearest" }); return; }
  if (a === "openFocus") return obSheet("focus");
  if (a === "genPrompts") { OB.sheet = null; return obGo("promptsGen"); }
  if (a === "openReview") { OB.reviewTopic = ""; return obSheet("review"); }
  if (a === "closeSheet") { OB.sheet = null; return obRender(); }
  if (a === "launch") return obLaunch();
});

async function obLaunch() {
  const profile = obProfile(), qs = OB.questions.filter((q) => q.on), r = OB.scan;
  if (!qs.length) return toast("Pick at least one prompt.");
  if (qs.length > promptCap()) return toast(esc(promptMsg()));
  if (!OB.engines.length) { obSheet("focus"); return toast("Pick at least one AI engine."); }
  // A rerun keeps its own brand (or market); a new market is "<brand>-<country>", e.g. meshopcheap-us.
  const code = profile.country || countryCode(profile.market);
  if (OB.parent && !OB.saved?.slug && !code) { obGo("market"); return toast("Pick the country this market is for."); }
  const slug = OB.saved?.slug || (OB.parent ? `${OB.parent}-${code.toLowerCase()}` : slugify(profile.name));
  const market = code ? { code, path: r.audit?.scope || "" } : null;
  if (await lockedElsewhere(slug)) return toast("This brand is running in another tab right now.");
  OB.sheet = null; document.body.classList.remove("sheet-open");
  const company = { slug, profile, audit: r.audit, siteText: r.siteText, topics: OB.topics.map((t) => t.name), focus: OB.focus, perTopic: OB.perTopic, samples: OB.samples,
    questions: OB.questions.map(({ topic, intent, persona, text, on }) => ({ topic, intent, persona, text, on })), engines: OB.engines.slice(), savedAt: Date.now(), parent: OB.parent || undefined, market: market || undefined };
  try { await DATA.saveCompany(company); } catch (e) { return toast(esc(e.message)); }
  const prev = APP.M?.slug === slug && APP.M.finishedAt ? APP.M : store.get("mission:" + slug, null);
  if (prev?.finishedAt) { store.set("prev:" + slug, prev); APP.prev = prev; }
  APP.M = newMission(profile, r.audit, r.siteText); const M = APP.M; M.slug = slug; M.market = market;
  M.engines = ENG_ALL.filter((e) => OB.engines.includes(e) && APP.cfg.engines.includes(e));
  M.questions = qs.map((q, i) => ({ id: "q" + (i + 1), intent: q.intent, topic: q.topic, persona: q.persona, text: q.text }));
  M.samples = OB.samples; M.done.questions = true; save(true);
  const sig = missionUI(profile.name);
  rebuildMap(M); bump("q", M.questions.length); finishPhase("site"); finishPhase("questions"); renderMatrix($("#matrix"), M);
  thought(`<b>Setup approved for ${esc(profile.name)}.</b> ${M.questions.length} prompts across ${OB.topics.length} topics, ${profile.competitors.length} competitors, ${M.engines.map((e) => ENG[e]).join(", ")}. Saved to your companies.`, "Everything below runs on the profile, rivals and prompts you just approved.");
  add(`<div class="hd"><span>Tracked prompts</span><span class="sp"></span><span class="mono" style="font-size:.7rem">${M.questions.length}</span></div><div class="ql">${M.questions.map((q) => `<div><span class="it it-${esc(q.intent || "")}">${esc(INTENTS[q.intent]?.[0] || q.intent || "")}</span>${esc(q.text)}</div>`).join("")}</div>`, "card");
  showRunning();
  try { await runPipeline(M, sig); } catch (err) { missionError(err, sig); }
}

/* =================================================================== RESULTS DASHBOARD (Peec-style)
   Sidebar workspace, filter chips, KPI strip, visibility chart, brand ranking, sources by domain and type,
   chats with a details panel, gap analysis, and the action deck. All numbers come from this run's answers. */
const DASH = { page: "overview", eng: "all", chatFilter: "all", domFilter: "all" };
const PAGES = { overview: ["Home", "Overview"], site: ["Home", "My website"], insights: ["Brand", "Insights"], perception: ["Brand", "Perception"], prompts: ["Prompts", "All prompts"], domains: ["Sources", "Domains"], gap: ["Sources", "Gap analysis"], actions: ["Optimize", "Actions"], ranking: ["Results", "Ranking"], chats: ["Results", "Chats"], fanouts: ["Results", "Fanouts"] };
const BAR = ["#7AC231", "#9A1AF0", "#1F5FF5", "#1B35B0", "#14B8A6", "#E11D74", "#64748B", "#A16207"];
const TYPEC = { You: "var(--petal)", Competitor: "#E2483D", UGC: "#3B82F6", Reviews: "#8B5CF6", Reference: "#14B8A6", Other: "#9A9AA0" };
const pct = (v, d = 1) => (v == null ? "–" : (100 * v).toFixed(d).replace(/\.0$/, "") + "%");
const finished = (a) => a && (a.status === "yes" || a.status === "no") && !a.absent; // an AI Overview Google did not show is not a miss

function domainType(d, M) {
  const own = host(M.profile.site || "");
  if (own && (d === own || d.endsWith("." + own))) return "You";
  const base = d.split(".").slice(-2, -1)[0] || d;
  if ((M.profile.competitors || []).some((r) => { const k = norm(r).replace(/ /g, ""); return k.length >= 3 && (base.includes(k) || k.includes(base) && base.length >= 4); })) return "Competitor";
  if (/(^|\.)(reddit|youtube|quora|linkedin|medium|x|twitter|facebook|instagram|tiktok|stackoverflow|stackexchange|github|substack|producthunt|news\.ycombinator)\./.test(d + ".") || /ycombinator\.com$/.test(d)) return "UGC";
  if (/(^|\.)(g2|capterra|trustpilot|clutch|gartner|getapp|softwareadvice|yelp|tripadvisor|trustradius|goodfirms|sitejabber|glassdoor)\./.test(d + ".")) return "Reviews";
  if (/(wikipedia|britannica|wikidata)\.|\.gov$|\.gov\.|\.edu$|\.ac\./.test(d)) return "Reference";
  return "Other";
}

function metrics(M, eng = "all") {
  if (!M) return null;
  const A = Object.values(M.answers || {}).filter((a) => finished(a) && (eng === "all" || a.engine === eng));
  const B = new Map(), YOU = "\u0000you";
  const keyOf = (name) => (isYou(name, M) ? YOU : norm(name));
  const get = (name) => { const you = isYou(name, M), k = you ? YOU : norm(name); if (!k) return null; if (!B.has(k)) B.set(k, { name: you ? M.profile.name : String(name).trim(), you, mentions: 0, pos: [], sent: [], tracked: false, qids: new Set() }); return B.get(k); };
  get(M.profile.name); (M.profile.competitors || []).forEach((n) => { const r = get(n); if (r && !r.you) r.tracked = true; });
  let total = 0;
  for (const a of A) {
    const seen = new Set();
    (a.brands || []).forEach((b, i) => { const r = get(b); if (!r) return; const k = keyOf(b); if (seen.has(k)) return; seen.add(k); r.mentions++; r.pos.push(i + 1); r.qids.add(a.qid); total++; });
    if (a.named && !seen.has(YOU)) { const r = B.get(YOU); r.mentions++; if (a.rank) r.pos.push(a.rank); r.qids.add(a.qid); total++; seen.add(YOU); }
    // sentiment: one 0-100 score per brand per answer, scored by the agent after the answers come in
    const done = new Set();
    for (const [n, v] of Object.entries(a.sent || {})) { const k = keyOf(n); if (done.has(k) || !seen.has(k) || typeof v !== "number") continue; done.add(k); B.get(k)?.sent.push(Math.max(0, Math.min(100, v))); }
  }
  const avg = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : null);
  const brands = [...B.values()].map((r) => ({ ...r, vis: A.length ? r.mentions / A.length : 0, sov: total ? r.mentions / total : 0, position: avg(r.pos), sentiment: avg(r.sent), win: A.length ? r.pos.filter((p) => p === 1).length / A.length : 0 }))
    .filter((r) => r.mentions || r.you || r.tracked).sort((a, b) => b.vis - a.vis || (a.position ?? 99) - (b.position ?? 99) || (a.you ? 1 : 0) - (b.you ? 1 : 0));
  const you = brands.find((b) => b.you), rank = brands.indexOf(you) + 1;
  const byEngine = M.engines.map((e) => { const x = Object.values(M.answers || {}).filter((a) => a.engine === e && finished(a)); return { e, n: x.length, vis: x.length ? x.filter((a) => a.named).length / x.length : null }; }).filter((x) => x.n);
  const D = new Map(); let ownAns = 0;
  for (const a of A) {
    const seen = new Set(); let own = false;
    for (const s of a.sources || []) { const d = host(s.url); if (!d) continue; const r = D.get(d) || { d, retr: 0, chats: 0, cited: 0, urls: new Set() }; r.retr++; r.urls.add(s.url); if (s.cited) r.cited++; if (!seen.has(d)) { r.chats++; seen.add(d); } D.set(d, r); if (ownUrl(s.url, M.profile.site)) own = true; }
    if (own) ownAns++;
  }
  const insp = Object.values(M.inspections || {});
  const totalRetr = [...D.values()].reduce((s, d) => s + d.retr, 0);
  const domains = [...D.values()].map((r) => { const pages = insp.filter((p) => host(p.url) === r.d && p.ok); return { ...r, nUrls: r.urls.size, share: totalRetr ? r.retr / totalRetr : 0, type: domainType(r.d, M), youOn: pages.length ? pages.some((p) => p.you) : null, rivalsOn: [...new Set(pages.flatMap((p) => p.rivals || []))] }; }).sort((a, b) => b.retr - a.retr);
  const types = {}; domains.forEach((d) => (types[d.type] = (types[d.type] || 0) + d.retr));
  const opened = insp.filter((p) => p.ok);
  const claims = (M.perception?.claims || []).filter((c) => ["accurate", "wrong", "outdated"].includes(c.verdict));
  const leaderSov = Math.max(you?.sov || 0, ...brands.filter((b) => !b.you).map((b) => b.sov), 0);
  const score = visibilityScore({ vis: you?.vis || 0, sov: you?.sov || 0, leaderSov, position: you?.position, sentiment: you?.sentiment });
  return { A, n: A.length, brands, you, rank, total, byEngine, domains, types, totalRetr, onPages: opened.filter((p) => p.you).length, opened: opened.length, gaps: pitchTargets(M), score,
    usedAsSource: A.length ? ownAns / A.length : null, citationShare: totalRetr ? (types.You || 0) / totalRetr : null,
    accuracy: claims.length ? claims.filter((c) => c.verdict === "accurate").length / claims.length : null, claims: claims.length };
}
function metricsFor(M, pred) { const sub = { ...M, answers: Object.fromEntries(Object.entries(M.answers || {}).filter(([, a]) => pred(a) && (DASH.eng === "all" || a.engine === DASH.eng))) }; return metrics(sub, "all"); }
function prevMetrics(M, eng) { const p = APP.prev?.slug === M.slug && APP.prev.id !== M.id ? APP.prev : store.get("prev:" + M.slug, null); return p && p.answers ? { at: p.startedAt, m: metrics(p, eng) } : null; }
function delta(cur, prev, { inv = false, unit = "pts", scale = 100 } = {}) {
  if (cur == null || prev == null) return "";
  const d = (cur - prev) * scale; if (Math.abs(d) < 0.05) return `<span class="dl">±0</span>`;
  const good = inv ? d < 0 : d > 0;
  return `<span class="dl ${good ? "up" : "down"}">${d > 0 ? "+" : ""}${d.toFixed(1)}${unit === "pts" ? "%" : ""}</span>`;
}
const brandAv = (b, M) => (b.you ? favImg(host(M.profile.site)) : letterAv(b.name));

/* ---- building blocks shared by the dashboard and the "ready" preview */
// Same formula as server/metrics.mjs visibilityScore: 50% visibility, 20% share of voice vs the leader,
// 20% position (#1 full, #6+ none), 10% sentiment. One number to watch, like Surfer's Visibility Score.
function visibilityScore({ vis = 0, sov = 0, leaderSov = 0, position = null, sentiment = null }) {
  const posF = position ? Math.max(0, Math.min(1, (6 - position) / 5)) : 0, sovRel = leaderSov ? Math.min(1, sov / leaderSov) : 0, sent = sentiment == null ? 0.5 : sentiment / 100;
  return Math.round(100 * (0.5 * vis + 0.2 * sovRel + 0.2 * posF + 0.1 * (vis ? sent : 0)));
}
const sentC = (v) => (v == null ? "var(--dim)" : v >= 65 ? "var(--good)" : v >= 45 ? "var(--warn)" : "var(--bad)");
const sentHtml = (v) => (v == null ? '<span class="muted">–</span>' : `<span class="sent"><i style="background:${sentC(v)}"></i>${Math.round(v)}</span>`);
// The metric set the AI-visibility tools report (Peec, Profound, Otterly), with how each one is measured here.
const METRICS = [
  ["Visibility score", "One 0–100 number for how strongly AI recommends you.", "50% visibility + 20% share of voice vs the leader + 20% position (#1 full, #6+ none) + 10% sentiment", "Surfer Visibility Score (similar idea)"],
  ["Visibility", "Share of AI answers that mention your brand.", "Answers naming you ÷ all answers", "Peec Visibility · Profound Visibility Score · Otterly Brand Coverage"],
  ["Share of voice", "Your mentions as a share of every brand mention.", "Your mentions ÷ all brand mentions", "Peec, Profound and Otterly Share of Voice"],
  ["Position", "Your average rank in the answers that mention you. Lower is better.", "Average of your rank (1 = named first)", "Peec Position · Profound Average Position · Otterly Avg. Brand Position"],
  ["Sentiment", "How positively AI talks about you, 0–100. Most brands land between 65 and 85.", "Agent scores the wording about each brand in each answer, averaged", "Peec Sentiment · Profound Sentiment Score · Otterly Brand Sentiment"],
  ["Win rate", "Share of answers where you're named first, ahead of every other brand.", "Answers ranking you #1 ÷ all answers", "Peec Win rate"],
  ["Used as source", "Share of answers that cite a page on your own domain.", "Answers citing your domain ÷ all answers", "Peec Used as source · Otterly Domain Coverage"],
  ["Citation share", "Your domain's share of every citation AI used.", "Citations of your domain ÷ all citations", "Profound Citation Share"],
  ["Accuracy", "Share of checkable claims AI makes about you that are correct.", "Accurate claims ÷ (accurate + wrong + outdated)", "Profound Accuracy Score"],
  ["On cited pages", "Of the pages AI cited that the agent opened, how many mention you.", "Pages naming you ÷ pages opened", "Perfstaq"],
];
function howModal() {
  modal(`<span class="status">Methodology</span><h3>How these numbers are measured</h3><p class="muted">Every number comes from this run's live answers: each prompt asked on each engine with web search on, your name left out of the prompt.</p>
    <table class="tbl"><thead><tr><th>Metric</th><th>What it means</th><th>Formula</th><th>Same as</th></tr></thead><tbody>${METRICS.map(([n, d, f, s]) => `<tr><td><b>${n}</b></td><td>${d}</td><td class="muted">${f}</td><td class="muted sm">${s}</td></tr>`).join("")}</tbody></table>`);
  $(".modal:last-of-type .box").style.maxWidth = "980px";
}
function kpiHtml(M, m, pm) {
  const y = m.you || {}, py = pm?.m?.you, tip = (n) => { const x = METRICS.find((r) => r[0] === n); return x ? esc(`${x[1]} How: ${x[2]}.`) : ""; };
  const eng = m.byEngine.filter((x) => x.vis != null).sort((a, b) => b.vis - a.vis);
  const cell = (label, val, dl = "") => `<div class="kpi"><span class="kl">${label} <span title="${tip(label)}">${icon("info", 12)}</span></span><span class="kv">${val}${dl}</span></div>`;
  const engCell = (label, x) => `<div class="kpi"><span class="kl">${label}</span><span class="kv"><span class="kengine"><i style="background:${ENGC[x.e]}"></i>${ENG[x.e]}</span><small>${pct(x.vis, 0)}</small></span></div>`;
  return `<div class="kpis k8">
    ${cell("Visibility score", `${m.score}<small>/100</small>`, delta(m.score, pm?.m?.score, { unit: "", scale: 1 }))}
    ${cell("Visibility", pct(y.vis), delta(y.vis, py?.vis))}
    ${cell("Share of voice", pct(y.sov), delta(y.sov, py?.sov))}
    ${cell("Position", y.position ? "#" + y.position.toFixed(1) : "–", delta(y.position, py?.position, { inv: true, unit: "", scale: 1 }))}
    ${cell("Sentiment", y.sentiment != null ? `${sentHtml(y.sentiment)}` : "–", delta(y.sentiment, py?.sentiment, { unit: "", scale: 1 }))}
    ${cell("Win rate", pct(y.win), delta(y.win, py?.win))}
    ${cell("Used as source", pct(m.usedAsSource), delta(m.usedAsSource, pm?.m?.usedAsSource))}
    ${eng.length > 1 ? engCell("Strongest engine", eng[0]) : cell("Citation share", pct(m.citationShare))}
  </div>`;
}
function visChartHtml(M, m) {
  const top = m.brands.slice(0, 5); if (m.you && !top.includes(m.you)) top.push(m.you);
  const max = Math.max(0.01, ...top.map((b) => b.vis)); const ceil = Math.min(1, Math.max(0.2, Math.ceil((max * 100) / 20) * 20 / 100));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((t) => t * ceil);
  let ci = 0;
  return `<div class="card"><div class="card-h"><b>Visibility</b><span title="Share of AI answers that mention each brand.">${icon("info", 13)}</span></div>
    <div class="vchart"><div class="vaxis">${ticks.map((t) => `<span>${Math.round(t * 100)}%</span>`).join("")}</div>
    <div class="vplot">${ticks.map(() => "<i></i>").join("")}<div class="vbars">${top.map((b) => `<div class="vcol" title="${esc(b.name)}: ${pct(b.vis)}"><div class="vbar${b.you ? " you" : ""}" style="height:${(100 * b.vis) / ceil}%;${b.you ? "" : `background:${BAR[ci++ % BAR.length]}`}"><span class="vv">${pct(b.vis)}</span></div><div class="vlab">${brandAv(b, M)}</div></div>`).join("")}</div></div></div></div>`;
}
function brandsTableHtml(M, m, limit = 5, title = "Top 5 brands") {
  const rows = m.brands.slice(0, limit); if (m.you && !rows.includes(m.you)) rows.push(m.you);
  return `<div class="card"><div class="card-h"><b>${title}</b><span title="Ranked by visibility across this view's answers.">${icon("info", 13)}</span>${limit < m.brands.length ? `<span class="sp"></span><button class="lnk" type="button" data-page="ranking">Show all</button>` : ""}</div>
    <table class="tbl"><thead><tr><th>#</th><th>Brand</th><th class="r">Visibility</th><th class="r">SoV</th><th class="r">Sentiment</th><th class="r">Position</th></tr></thead><tbody>
    ${rows.map((b) => `<tr class="${b.you ? "you" : ""}"><td class="muted">${m.brands.indexOf(b) + 1}</td><td><span class="bcell">${brandAv(b, M)}<b>${esc(b.name)}</b>${b.you ? '<span class="youtag">You</span>' : ""}</span></td><td class="r">${pct(b.vis)}</td><td class="r">${pct(b.sov)}</td><td class="r">${sentHtml(b.sentiment)}</td><td class="r">${b.position ? b.position.toFixed(1) : '<span class="sk" style="width:28px"></span>'}</td></tr>`).join("")}
    </tbody></table></div>`;
}
function topDomainsHtml(M, m, limit = 6) {
  const top = m.domains.slice(0, limit), max = Math.max(1, ...top.map((d) => d.retr));
  const types = Object.entries(m.types).sort((a, b) => b[1] - a[1]), tmax = Math.max(1, ...types.map((t) => t[1]));
  return `<div class="sec-h"><h3>Top domains</h3><p>The domains AI models retrieved while answering your prompts</p></div>
  <div class="grid2 eq"><div class="card"><div class="card-h"><b>Top</b><span class="sp"></span><span class="muted">Retrievals</span></div>
    ${top.length ? top.map((d) => `<div class="hbar"><span class="hb" style="width:${Math.max(30, (100 * d.retr) / max)}%">${favImg(d.d)}<span>${esc(d.d)}</span></span><span class="hn">${d.retr}</span></div>`).join("") : '<p class="muted pad">No sources yet.</p>'}
    ${m.domains.length > limit ? `<button class="lnk pad" type="button" data-page="domains">All domains ${icon("chev", 12)}</button>` : ""}</div>
  <div class="card"><div class="card-h"><b>Domain types</b><span class="sp"></span><span class="muted">${icon("info", 12)} Total retrievals · ${m.totalRetr}</span></div>
    ${types.map(([t, n]) => `<div class="hbar"><span class="hb" style="width:${Math.max(30, (100 * n) / tmax)}%"><i class="dotc" style="background:${TYPEC[t]}"></i><span>${t}</span></span><span class="hn">${n}</span></div>`).join("")}</div></div>`;
}
function chatCardsHtml(M, m, n = 6) {
  const list = m.A.slice().sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0) || (b.brands || []).length - (a.brands || []).length).slice(0, n);
  return `<div class="card"><div class="card-h"><b>All chats</b><span title="The live AI answers behind these numbers.">${icon("info", 13)}</span><span class="sp"></span><button class="lnk" type="button" data-page="chats">${m.n} chats ${icon("chev", 12)}</button></div>
    <div class="ccards">${list.map((a) => `<button type="button" class="ccard" data-chat="${esc(a.qid + "|" + a.engine)}"><span class="ch">${engDot(a.engine)}<b>${esc(qText(M, a.qid))}</b></span><span class="cs">${esc(String(a.answer || "").replace(/[#*_`>]/g, "").slice(0, 150))}</span><span class="cf">${(a.brands || []).slice(0, 5).map((b) => (isYou(b, M) ? favImg(host(M.profile.site)) : letterAv(b))).join("")}<span class="sp"></span>${a.named ? `<span class="posb">#${a.rank || "–"}</span>` : '<span class="posb no">not named</span>'}</span></button>`).join("")}</div></div>`;
}
const engDot = (e) => `<span class="engd" title="${ENG[e]}"><i style="background:${ENGC[e]}"></i></span>`;

/* ---- READY: Peec's "workspace is almost ready" reveal, with the real numbers in a preview of the app */
function previewApp(M) {
  const m = metrics(M, "all");
  const nav = [["Home", [["overview", "Overview", true], ["globe", "My website"]]], ["Brand", [["doc", "Insights"], ["smile", "Perception"]]], ["Prompts", [["list", "All prompts"]]], ["Sources", [["link", "Domains"], ["gap", "Gap analysis"]]], ["Optimize", [["bolt", "Actions"]]]];
  return `<div class="fr preview"><aside class="fr-side"><div class="fr-brand">${favImg(host(M.profile.site))}<b>${esc(M.profile.name)}</b>${icon("down", 13)}</div><div class="fr-nav">${nav.map(([g, it]) => `<div class="fr-g">${icon("down", 11)}${g}</div>${it.map(([ic, l, on]) => `<div class="fr-i${on ? " on" : ""}">${icon(ic, 14)}${l}</div>`).join("")}`).join("")}</div></aside>
    <div class="fr-main"><div class="fr-top">${icon("side", 15)}<b>Overview</b><span class="sp"></span><span class="fr-ib">${icon("chat", 14)}</span><span class="fr-ib">${icon("info", 14)}</span></div>
    <div class="fr-chips pad">${[70, 52, 96, 84].map((w) => `<span class="fr-chip"><span class="sk sq sm"></span><span class="sk" style="width:${w}px"></span></span>`).join("")}<span class="sp"></span><span class="muted" style="font-size:.78rem">Preview result</span></div>
    <div class="fr-scroll"><div class="grid2">${visChartHtml(M, m)}${brandsTableHtml(M, m)}</div>${chatCardsHtml(M, m)}${topDomainsHtml(M, m)}</div></div></div>`;
}
/* ---- RUNNING: like Peec, the analysis happens under a live preview of the workspace.
   The answers fill the charts as they arrive; the full agent console is one click away. */
let RUNT = 0, RUNSIG = "";
const RUN_STEPS = [["ask", "Ask AI live"], ["sentiment", "Score sentiment"], ["sources", "Open cited pages"], ["perception", "Fact-check"], ["insights", "Work out why"], ["draft", "Draft fixes"]];
function showRunning() {
  if (!APP.M) return;
  if (APP.M.finishedAt) return showReady();
  screen("ready"); $("#ready").dataset.mode = "run"; RUNSIG = ""; $("#readyPreview").classList.remove("calm");
  renderRunning();
  clearInterval(RUNT); RUNT = setInterval(() => { if ($("#ready").hidden || $("#ready").dataset.mode !== "run") { clearInterval(RUNT); return; } renderRunning(); }, 1500);
}
function renderRunning() {
  const M = APP.M; if (!M) return;
  if (M.finishedAt) return showReady();
  const jobs = M.questions.length * M.engines.length * (M.samples || 1), got = Object.values(M.answers || {}).filter((a) => a.status && a.status !== "run").length;
  const cur = RUN_STEPS.find(([k]) => !M.done[k]), stopped = !APP.running;
  const p = Math.round(100 * (Math.min(1, got / Math.max(1, jobs)) * 0.55 + RUN_STEPS.slice(1).filter(([k]) => M.done[k]).length * 0.09));
  $("#readyTitle").innerHTML = stopped ? "The analysis is paused" : `Analysing ${esc(M.profile.name)}<span class="dots"></span>`;
  $("#readySub").textContent = stopped ? APP.lastError || "Everything so far is saved. Pick up where it stopped, or look at the results so far."
    : !M.done.ask ? `Asking ${M.engines.map((e) => ENG[e]).join(", ")} your ${M.questions.length} prompts live, with web search on. ${got} of ${jobs} answers in. The preview fills in as they arrive.`
    : `${$("#hudPhase").textContent || "Working"}. ${got} answers in, ${Object.keys(M.inspections || {}).length} cited pages opened.`;
  $("#readyRun").innerHTML = `<div class="ob-prog wide"><i style="width:${Math.max(3, p)}%"></i></div>
    <div class="runsteps">${RUN_STEPS.map(([k, l]) => `<span class="${M.done[k] ? "ok" : cur && cur[0] === k && !stopped ? "on" : ""}">${M.done[k] ? icon("check", 12) : cur && cur[0] === k && !stopped ? '<i class="spin"></i>' : ""}${l}</span>`).join("")}</div>
    <div class="ob-btns">${stopped ? `<button class="btn ghost" type="button" data-run="results">See results so far</button><button class="btn" type="button" data-run="resume">Resume</button>` : `<button class="btn ghost" type="button" data-run="watch">${icon("play", 15)}Watch the agent live</button><button class="btn ghost" type="button" data-run="stop">Stop</button>`}</div>`;
  $("#readyGo").parentElement.hidden = true;
  const sig = got + "|" + Object.keys(M.inspections || {}).length + "|" + Object.keys(M.done).filter((k) => M.done[k]).join(",");
  if (sig !== RUNSIG) {
    const first = !RUNSIG; RUNSIG = sig;
    const sc = $("#readyPreview .fr-scroll")?.scrollTop || 0;
    $("#readyPreview").innerHTML = previewApp(M);
    const el = $("#readyPreview .fr-scroll"); if (el) el.scrollTop = sc;
    if (first) setTimeout(() => $("#readyPreview").classList.add("calm"), 900); // animate once, then update quietly
  }
}
$("#readyRun").addEventListener("click", (e) => {
  const b = e.target.closest("[data-run]"); if (!b) return; const a = b.dataset.run;
  if (a === "watch") return $("#viewLog").click();
  if (a === "stop") return APP.ctl?.abort();
  if (a === "resume") { resumeMission(APP.M); return; }
  if (a === "results") return showReport("overview");
});
function showReady() {
  const M = APP.M; if (!M) return;
  screen("ready"); $("#ready").dataset.mode = "done"; clearInterval(RUNT); $("#readyRun").innerHTML = ""; $("#readyGo").parentElement.hidden = false; $("#readyPreview").classList.remove("calm");
  const m = metrics(M, "all");
  $("#readyTitle").textContent = `${M.profile.name}'s workspace is ready`;
  $("#readySub").textContent = `Here are your first results: ${m.n} live AI answers, ${m.domains.length} source domains, and ${m.gaps.length} cited pages where rivals are listed and you're not.`;
  $("#readyPreview").innerHTML = previewApp(M);
}
$("#readyGo").addEventListener("click", () => showReport("overview"));
$("#readyBack").addEventListener("click", () => $("#viewLog").click());
$("#readyPreview").addEventListener("click", (e) => { const c = e.target.closest("[data-chat]"); if (c) openChat(c.dataset.chat); });

/* ---- the dashboard */
function showReport(page) {
  const M = APP.M; if (!M) return goHome();
  screen("reportWrap");
  if (page) DASH.page = page; if (DASH.eng !== "all" && !M.engines.includes(DASH.eng)) DASH.eng = "all";
  const mk = DATA.ws(M.slug)?.market; $("#projName").textContent = M.profile.name + (mk && marketsOf(M.slug).length > 1 ? ` · ${mk.name}` : ""); $("#projAv").innerHTML = favImg(host(M.profile.site));
  buildDeck(); renderSugs(); renderChat();
  dashRender();
  if (DATA.server()) { loadInts(M.slug); loadChecks(M.slug); DATA.refresh().then(() => { if (APP.M === M && ["overview", "settings"].includes(DASH.page)) dashRender(); }).catch(() => {}); }
}
function filtersHtml(M) {
  const pm = APP.prev?.slug === M.slug && APP.prev.id !== M.id ? APP.prev : store.get("prev:" + M.slug, null);
  return `<div class="segc">${["all", ...M.engines].map((e) => `<button type="button" data-eng="${e}" aria-pressed="${DASH.eng === e}">${e === "all" ? "All engines" : `<i style="background:${ENGC[e]}"></i>${ENG[e]}`}</button>`).join("")}</div>
    <span class="fchip">${icon("rank", 14)}Run · ${new Date(M.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
    <span class="fchip">${icon("list", 14)}${M.questions.length} prompts</span>
    ${pm ? `<span class="fchip muted">vs ${new Date(pm.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>` : ""}
    <span class="sp"></span><button type="button" class="fchip btnchip" data-howto>${icon("info", 14)}How we measure</button><span class="fchip muted">${esc(M.profile.market || "Global")}</span>`;
}
function dashRender() {
  const M = APP.M; if (!M || $("#reportWrap").hidden) return;
  const [g, t] = PAGES[DASH.page] || PAGES.overview;
  $$("#side [data-page]").forEach((b) => b.classList.toggle("on", b.dataset.page === DASH.page));
  const gapsN = RM.questionGaps(M, { engines: M.engines, isYou: (b) => isYou(b, M) }).length;
  if ($("#navGaps")) $("#navGaps").textContent = gapsN || "";
  $("#crumb").innerHTML = `<span class="muted">${g}</span>${icon("chev", 13)}<b>${t}</b>`;
  $("#filters").innerHTML = filtersHtml(M);
  $("#filters").hidden = ["actions", "site", "perception", "settings"].includes(DASH.page);
  $("#rerun").hidden = !canEdit();
  // Hide what this person's role can't do (the server refuses it anyway): viewers change nothing, editors don't connect tools or delete brands.
  $("#reportWrap").classList.toggle("ro", !canEdit()); $("#reportWrap").classList.toggle("not-admin", !canAdmin());
  $("#navTeam").hidden = !DATA.server(); $("#navConsole").hidden = !APP.cfg.console; $("#navBilling").hidden = !billingOn() || PAY_HIDDEN; /* PAY_HIDDEN: no Plans & payment in the nav */ $("#navAccount").hidden = !billingOn(); paintAccount(); paintTrialPill();
  const m = metrics(M, DASH.eng), pm = prevMetrics(M, DASH.eng);
  $("#pages").innerHTML = `<div class="pg">${marketStrip(M)}${(PAGE[DASH.page] || PAGE.overview)(M, m, pm)}</div>`;
  if (DASH.page === "actions") drawDeck();
  if (DASH.page === "insights") renderMatrix($("#matrixBig"), M, true);
  $(".main").scrollTop = 0; $("#side").classList.remove("open");
}
const head = (h, p) => `<div class="pg-hd"><h2>${h}</h2>${p ? `<p>${p}</p>` : ""}</div>`;
const PAGE = {
  overview(M, m, pm) {
    const y = m.you, lead = m.brands.find((b) => !b.you);
    const h = !y?.mentions ? "AI doesn't recommend you yet" : m.rank === 1 ? "You're #1 in AI visibility" : `You're #${m.rank} in AI visibility`;
    const p = !y?.mentions ? `${lead ? `${esc(lead.name)} appears in ${pct(lead.vis)} of answers. ` : ""}You weren't named in any of the ${m.n} answers.` : m.rank === 1 ? `You appear in more AI answers than any competitor, and are often the default choice.` : `${esc(lead.name)} appears in ${pct(lead.vis)} of answers; you appear in ${pct(y.vis)}.`;
    const acts = DECK.slice(0, 3);
    return head(h, p) + kpiHtml(M, m, pm) + marketsCompare(M) + (trendPoints(M).length < 2 ? trendHtml(M) : "") + referralHtml(M) + `<div class="grid2">${visChartHtml(M, m)}${brandsTableHtml(M, m)}</div>`
      + `<div class="grid2"><div class="card"><div class="card-h"><b>Visibility by engine</b></div>${m.byEngine.map((x) => { const top = metrics(M, x.e).brands.find((b) => !b.you); return `<div class="erow"><span class="en">${engDot(x.e)}${ENG[x.e]}</span><span class="eb"><i style="width:${(100 * (x.vis || 0)).toFixed(0)}%"></i></span><b>${pct(x.vis, 0)}</b><span class="muted el">${top ? `Leader: ${esc(top.name)} ${pct(top.vis, 0)}` : ""}</span></div>`; }).join("")}</div>
        <div class="card"><div class="card-h"><b>Top recommended actions</b><span class="sp"></span><button class="lnk" type="button" data-page="actions">${DECK.length} actions ${icon("chev", 12)}</button></div>${acts.length ? acts.map((c) => `<button type="button" class="arow" data-page="actions" data-card="${esc(c.id)}"><span class="ak">${esc(c.kind)}</span><b>${esc(c.title)}</b><span class="muted">${esc(c.why)}</span></button>`).join("") : '<p class="muted pad">Nothing left to do. Run again next week.</p>'}</div></div>`
      + chatCardsHtml(M, m) + topDomainsHtml(M, m);
  },
  ranking(M, m) {
    const pts = m.brands.filter((b) => b.position != null).slice(0, 12), maxV = Math.max(0.1, ...pts.map((b) => b.vis)), maxP = Math.max(3, ...pts.map((b) => b.position));
    const X = (v) => 48 + (v / maxV) * 450, Y = (p) => 20 + ((p - 1) / (maxP - 1 || 1)) * 200;
    return head("Ranking", "Every brand AI mentioned for your prompts, ranked by visibility.") + `<div class="grid2 rk">
      <div class="card"><div class="card-h"><b>Visibility index</b><span title="Further right: named in more answers. Higher up: named earlier in them. Top right is where buyers look first.">${icon("info", 13)}</span></div>
        <svg class="scatter" viewBox="0 0 600 260" role="img" aria-label="Visibility against average position for each brand">
          <line x1="48" y1="230" x2="580" y2="230" class="ax"/><line x1="48" y1="14" x2="48" y2="230" class="ax"/>
          <text x="580" y="250" text-anchor="end" class="axl">Visibility →</text><text x="40" y="22" text-anchor="end" class="axl">#1</text><text x="40" y="226" text-anchor="end" class="axl">#${maxP.toFixed(0)}</text>
          ${pts.map((b) => `<g transform="translate(${X(b.vis).toFixed(1)},${Y(b.position).toFixed(1)})"><circle r="${b.you ? 8 : 6}" class="${b.you ? "you" : ""}"><title>${esc(b.name)}: ${pct(b.vis)} visibility, position ${b.position.toFixed(1)}</title></circle><text x="11" y="4" class="${b.you ? "you" : ""}">${esc(b.name.slice(0, 18))}</text></g>`).join("")}
        </svg></div>
      <div class="card"><div class="card-h"><b>Head to head</b><span class="muted">How often each rival is named first vs you</span></div>
        ${m.brands.filter((b) => !b.you).slice(0, 7).map((b) => `<div class="erow"><span class="en">${letterAv(b.name)}${esc(b.name)}</span><span class="eb two"><i style="width:${(100 * b.win).toFixed(0)}%;background:#9A9AA0"></i></span><b>${pct(b.win, 0)}</b></div>`).join("")}
        <div class="erow you"><span class="en">${brandAv(m.you || { you: true, name: M.profile.name }, M)}${esc(M.profile.name)}</span><span class="eb"><i style="width:${(100 * (m.you?.win || 0)).toFixed(0)}%"></i></span><b>${pct(m.you?.win, 0)}</b></div></div></div>
      <div class="card"><table class="tbl"><thead><tr><th>#</th><th>Brand</th><th class="r">Visibility</th><th class="r">SoV</th><th class="r">Sentiment</th><th class="r">Position</th><th class="r">Win rate</th><th class="r">Mentions</th><th>Status</th></tr></thead><tbody>
      ${m.brands.map((b, i) => `<tr class="${b.you ? "you" : ""}"><td class="muted">${i + 1}</td><td><span class="bcell">${brandAv(b, M)}<b>${esc(b.name)}</b>${b.you ? '<span class="youtag">You</span>' : ""}</span></td><td class="r"><span class="minibar"><i style="width:${(100 * b.vis).toFixed(0)}%"></i></span>${pct(b.vis)}</td><td class="r">${pct(b.sov)}</td><td class="r">${sentHtml(b.sentiment)}</td><td class="r">${b.position ? b.position.toFixed(1) : "–"}</td><td class="r">${pct(b.win, 0)}</td><td class="r">${b.mentions}</td><td>${b.you ? "" : b.tracked ? '<span class="tagx">Tracked</span>' : '<span class="tagx dim">Discovered</span>'}</td></tr>`).join("")}</tbody></table></div>`;
  },
  prompts(M, m) {
    const groups = {}; M.questions.forEach((q) => (groups[q.topic || TOPIC_OF[q.intent] || "Prompts"] = groups[q.topic || TOPIC_OF[q.intent] || "Prompts"] || []).push(q));
    const engs = DASH.eng === "all" ? M.engines : [DASH.eng];
    return head("All prompts", `${M.questions.length} prompts across ${Object.keys(groups).length} topics. Click one to read the answers.`) + Object.entries(groups).map(([t, qs]) => `<div class="card"><div class="card-h"><b>${esc(t)}</b><span class="muted">${qs.length}</span></div>
      <table class="tbl click"><thead><tr><th>Prompt</th><th>Intent</th><th>${engs.map((e) => engDot(e)).join("")}</th><th class="r">Visibility</th><th class="r">Position</th><th>Top brand</th></tr></thead><tbody>
      ${qs.map((q) => { const as = engs.flatMap((e) => answersOf(M, q.id, e)).filter(finished); const named = as.filter((a) => a.named); const ranks = named.map((a) => a.rank).filter(Boolean); const tb = as.flatMap((a) => (a.brands || []).slice(0, 1)).find((b) => b); const first = as[0];
        return `<tr ${first ? `data-chat="${esc(first.qid + "|" + first.engine)}"` : ""}><td class="pt">${esc(q.text)}</td><td>${intentTag(q.intent)}</td><td><span class="dots3">${engs.map((e) => { const x = answersOf(M, q.id, e).filter(finished), n = x.filter((a) => a.named).length; return `<i class="${!x.length ? "" : n === x.length ? "y" : n ? "h" : "n"}" title="${ENG[e]}: ${!x.length ? "no answer" : `named in ${n} of ${x.length}`}"></i>`; }).join("")}</span></td><td class="r">${as.length ? pct(named.length / as.length, 0) : "–"}</td><td class="r">${ranks.length ? "#" + (ranks.reduce((s, x) => s + x, 0) / ranks.length).toFixed(1) : "–"}</td><td>${tb ? `<span class="bcell sm">${isYou(tb, M) ? favImg(host(M.profile.site)) : letterAv(tb)}${esc(tb)}</span>` : "–"}</td></tr>`; }).join("")}
      </tbody></table></div>`).join("");
  },
  chats(M, m) {
    const f = DASH.chatFilter, list = m.A.filter((a) => f === "all" || (f === "you" ? a.named : !a.named));
    return head("Chats", "The individual AI answers behind your metrics.") + `<div class="segc inl">${[["all", `All · ${m.n}`], ["you", `Mention you · ${m.A.filter((a) => a.named).length}`], ["not", `Don't mention you · ${m.A.filter((a) => !a.named).length}`]].map(([k, l]) => `<button type="button" data-chatf="${k}" aria-pressed="${f === k}">${l}</button>`).join("")}</div>
      <div class="card"><table class="tbl click"><thead><tr><th>Prompt</th><th>Engine</th><th class="r">Your position</th><th class="r">Sentiment</th><th>Brands mentioned</th><th class="r">Sources</th></tr></thead><tbody>
      ${list.map((a) => `<tr data-chat="${esc(a.qid + "|" + a.engine)}"><td class="pt">${esc(qText(M, a.qid))}</td><td><span class="bcell sm">${engDot(a.engine)}${ENG[a.engine]}</span></td><td class="r">${a.named ? `<span class="posb">#${a.rank || "–"}</span>` : '<span class="posb no">–</span>'}</td><td class="r">${(() => { const k = Object.keys(a.sent || {}).find((n) => isYou(n, M)); return a.named && k ? sentHtml(a.sent[k]) : '<span class="muted">–</span>'; })()}</td><td><span class="avs">${(a.brands || []).slice(0, 6).map((b) => (isYou(b, M) ? favImg(host(M.profile.site)) : letterAv(b))).join("")}${(a.brands || []).length > 6 ? `<span class="more">+${a.brands.length - 6}</span>` : ""}</span></td><td class="r">${Math.max(a.nSrc || 0, (a.sources || []).length)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No chats in this view.</td></tr>'}
      </tbody></table></div>`;
  },
  domains(M, m) {
    if (DASH.srcView === "urls") return urlsPage(M, m);
    const f = DASH.domFilter, list = m.domains.filter((d) => f === "all" || (f === "gap" ? d.youOn === false && d.rivalsOn.length : d.type === f));
    return head("Domains", "Which sites AI retrieves when it answers your prompts. Get onto the ones it trusts.") + srcSwitch() + `<div class="segc inl">${[["all", "All"], ["gap", "Rivals on it, you're not"], ...Object.keys(m.types).map((t) => [t, t])].map(([k, l]) => `<button type="button" data-domf="${esc(k)}" aria-pressed="${f === k}">${esc(l)}</button>`).join("")}</div>
      <div class="card"><table class="tbl"><thead><tr><th>Domain</th><th>Type</th><th class="r">Retrieved</th><th class="r">Retrievals</th><th class="r">Cited</th><th>You on it</th><th>Rivals on it</th></tr></thead><tbody>
      ${list.map((d) => `<tr><td><span class="bcell">${favImg(d.d)}<b>${esc(d.d)}</b></span></td><td><span class="itag"><i style="background:${TYPEC[d.type]}"></i>${d.type}</span></td><td class="r">${pct(m.n ? d.chats / m.n : 0, 0)}</td><td class="r">${d.retr}</td><td class="r">${d.cited}</td><td>${d.youOn == null ? '<span class="muted">not opened</span>' : d.youOn ? '<span class="pillx ok">Yes</span>' : '<span class="pillx no">No</span>'}</td><td class="muted ell">${esc(d.rivalsOn.slice(0, 3).join(", "))}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">Nothing here.</td></tr>'}
      </tbody></table></div>`;
  },
  gap(M, m) {
    return head("Gap analysis", `Pages AI cited where rivals are listed and you're not. ${m.gaps.length} open targets. Getting onto these is the fastest way into AI answers.`) + `<div class="card">${m.gaps.length ? m.gaps.map((t) => `<div class="grow2">${favImg(t.domain || host(t.url))}<div class="gm"><a href="${esc(safeUrl(t.final || t.url) || "#")}" target="_blank" rel="noopener"><b>${esc(t.title || t.url)}</b></a><span class="muted">${esc(t.domain || host(t.url))} · cited ${t.n}× · for ${(t.qs || []).length} prompt${(t.qs || []).length === 1 ? "" : "s"}</span><span class="chips">${(t.rivals || []).map((r) => `<span class="tagx red">${esc(r)}</span>`).join("")}${t.contacts?.emails?.[0] ? `<span class="tagx mono">${esc(t.contacts.emails[0])}</span>` : t.contacts?.author ? `<span class="tagx">by ${esc(t.contacts.author)}</span>` : ""}</span></div><button class="btn sm${M.pitches[t.url] ? " ghost" : ""}" type="button" data-pitch="${esc(t.url)}">${M.pitches[t.url] ? "Open pitch" : "Draft pitch"}</button></div>`).join("") : '<p class="muted pad">No gaps found in the pages we opened. Nice.</p>'}</div>`;
  },
  insights(M, m) {
    const topics = [...new Set(M.questions.map((q) => q.topic || TOPIC_OF[q.intent] || "Prompts"))];
    const tm = (t) => { const ids = new Set(M.questions.filter((q) => (q.topic || TOPIC_OF[q.intent] || "Prompts") === t).map((q) => q.id)); return metricsFor(M, (a) => ids.has(a.qid)); };
    const per = topics.map((t) => [t, tm(t)]);
    const cols = m.brands.slice(0, 6); if (m.you && !cols.includes(m.you)) cols.splice(5, 1, m.you);
    const heat = (v) => `background:rgba(242,107,15,${(0.06 + 0.8 * v).toFixed(2)});color:${v > 0.55 ? "#fff" : "var(--ink)"}`;
    const y = m.you || {}, lead = m.brands.find((b) => !b.you);
    return head(!y.mentions ? "AI doesn't recommend you yet" : m.rank === 1 ? "You're #1 in AI visibility" : `You're #${m.rank} in AI visibility`, `${lead ? `${esc(lead.name)} leads with ${pct(lead.vis)} visibility. ` : ""}Where you lead and where you lose, by topic and engine.`) + kpiHtml(M, m, prevMetrics(M, DASH.eng))
      + `<div class="card"><div class="card-h"><b>Performance by topic</b><span class="muted">Your numbers inside each topic</span></div><table class="tbl"><thead><tr><th>Topic</th><th class="r">Prompts</th><th class="r">Visibility</th><th class="r">SoV</th><th class="r">Sentiment</th><th class="r">Position</th><th>Leader</th>${M.engines.map((e) => `<th class="r">${engDot(e)}${ENG[e]}</th>`).join("")}</tr></thead><tbody>
        ${per.map(([t, x]) => { const yy = x.you || {}, ld = x.brands[0]; return `<tr><td><b>${esc(t)}</b></td><td class="r">${M.questions.filter((q) => (q.topic || TOPIC_OF[q.intent] || "Prompts") === t).length}</td><td class="r">${pct(yy.vis)}</td><td class="r">${pct(yy.sov)}</td><td class="r">${sentHtml(yy.sentiment)}</td><td class="r">${yy.position ? yy.position.toFixed(1) : "–"}</td><td>${ld ? `<span class="bcell sm">${brandAv(ld, M)}${esc(ld.name)} <span class="muted">${pct(ld.vis, 0)}</span></span>` : "–"}</td>${M.engines.map((e) => { const v = x.A.filter((a) => a.engine === e); return `<td class="r">${v.length ? pct(v.filter((a) => a.named).length / v.length, 0) : "–"}</td>`; }).join("")}</tr>`; }).join("")}</tbody></table></div>
      <div class="card"><div class="card-h"><b>Performance matrix</b><span class="muted">Visibility of each brand in each topic</span></div><div class="hm-wrap"><table class="tbl hm"><thead><tr><th>Topic</th>${cols.map((b) => `<th class="c"><span class="bcell sm">${brandAv(b, M)}${esc(b.name.slice(0, 14))}</span></th>`).join("")}</tr></thead><tbody>
        ${per.map(([t, x]) => `<tr><td><b>${esc(t)}</b></td>${cols.map((b) => { const r = x.brands.find((z) => (b.you ? z.you : norm(z.name) === norm(b.name))); const v = r ? r.vis : 0; return `<td class="c"><span class="hc${b.you ? " you" : ""}" style="${heat(v)}">${pct(v, 0)}</span></td>`; }).join("")}</tr>`).join("")}</tbody></table></div></div>
      <div class="card"><div class="card-h"><b>Why this is happening</b><span class="muted">The agent's read, with the evidence behind it</span></div><div class="md pad">${M.insights ? md(M.insights) : '<p class="muted">No insights for this run.</p>'}</div></div>
      <div class="card"><div class="card-h"><b>Question by question</b><span class="muted">Each cell is one live AI answer. Click to read it.</span></div><div class="pad"><div class="matrix" id="matrixBig"></div></div></div>`;
  },
  fanouts(M, m) {
    const Q = new Map();
    for (const a of m.A) for (const s of a.searches || []) { const k = norm(s); if (!k) continue; const r = Q.get(k) || { q: s, n: 0, engines: new Set(), qids: new Set() }; r.n++; r.engines.add(a.engine); r.qids.add(a.qid); Q.set(k, r); }
    const list = [...Q.values()].sort((a, b) => b.n - a.n);
    const words = {}; list.forEach((r) => norm(r.q).split(" ").filter((w) => w.length > 3 && !/^(what|which|with|from|that|this|your|best|for|and|the|2024|2025|2026)$/.test(w)).forEach((w) => (words[w] = (words[w] || 0) + r.n)));
    const top = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 14);
    return head("Fanouts", "The web searches AI ran behind the scenes to answer your prompts. These are the queries to rank for.") + `<div class="kpis"><div class="kpi"><span class="kl">Distinct queries</span><span class="kv">${list.length}</span></div><div class="kpi"><span class="kl">Total searches</span><span class="kv">${list.reduce((s, r) => s + r.n, 0)}</span></div><div class="kpi"><span class="kl">Searches per answer</span><span class="kv">${m.n ? (list.reduce((s, r) => s + r.n, 0) / m.n).toFixed(1) : "–"}</span></div></div>
      ${top.length ? `<div class="card"><div class="card-h"><b>Common terms</b></div><div class="chips pad">${top.map(([w, n]) => `<span class="tagx">${esc(w)} <b>${n}</b></span>`).join("")}</div></div>` : ""}
      <div class="card"><table class="tbl"><thead><tr><th>Query</th><th>Engines</th><th>Prompt</th><th class="r">Occurrences</th></tr></thead><tbody>
      ${list.map((r) => `<tr><td><b>${esc(r.q)}</b></td><td>${[...r.engines].map((e) => `<span class="bcell sm">${engDot(e)}${ENG[e]}</span>`).join(" ")}</td><td class="muted ell">${esc(qText(M, [...r.qids][0]))}</td><td class="r">${r.n}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">The engines didn\'t report their searches for this run.</td></tr>'}</tbody></table></div>`;
  },
  perception(M) {
    const P = M.perception;
    const V = { accurate: "ok", unsupported: "warn", wrong: "no", outdated: "no" };
    return head("Perception", "What AI says about you when asked directly, fact-checked against your own site.") + (P ? `<div class="card pad"><p class="lead">${esc(P.summary || "")}</p></div>
      <div class="card"><table class="tbl"><thead><tr><th>What AI claims</th><th>Verdict</th><th>What to publish</th></tr></thead><tbody>${(P.claims || []).map((c) => `<tr><td>${esc(c.claim)}</td><td><span class="pillx ${V[c.verdict] || ""}">${esc(c.verdict)}</span></td><td class="muted">${esc(c.fix || "")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="card pad"><p class="muted">The fact-check didn\'t run for this check.</p></div>');
  },
  site(M) {
    const a = M.audit || {};
    return head("My website", `How readable ${esc(host(M.profile.site))} is for AI crawlers and answer engines.`) + `<div class="kpis"><div class="kpi"><span class="kl">AI-readiness</span><span class="kv">${a.avg ?? "–"}<small>/100</small></span></div><div class="kpi"><span class="kl">llms.txt</span><span class="kv">${a.llms ? "Found" : "Missing"}</span></div><div class="kpi"><span class="kl">Organization schema</span><span class="kv">${a.orgSchema ? "Yes" : "No"}</span></div><div class="kpi"><span class="kl">FAQ schema</span><span class="kv">${a.faqSchema ? "Yes" : "No"}</span></div><div class="kpi"><span class="kl">Sitemap URLs</span><span class="kv">${a.sitemap ?? "–"}</span></div></div>
      <div class="grid2"><div class="card"><div class="card-h"><b>Crawler access</b><span class="muted">robots.txt</span></div><table class="tbl"><tbody>${Object.entries(a.bots || {}).map(([b, ok]) => `<tr><td><b>${esc(b)}</b></td><td class="r"><span class="pillx ${ok ? "ok" : "no"}">${ok ? "Allowed" : "Blocked"}</span></td></tr>`).join("")}</tbody></table></div>
      <div class="card"><div class="card-h"><b>Pages</b><span class="muted">AI-readiness score</span></div><table class="tbl pagetbl"><tbody>${(a.pages || []).map((p) => `<tr><td class="sc"><span class="score ${p.score >= 60 ? "hi" : p.score >= 35 ? "md" : "lo"}">${p.score}</span></td><td><a href="${esc(safeUrl(p.url) || "#")}" target="_blank" rel="noopener">${esc(p.title || host(p.url))}</a><div class="muted sm">${esc((p.fails || []).slice(0, 3).join(" · ") || "Strong page")}</div></td></tr>`).join("")}</tbody></table></div></div>`;
  },
  actions(M) {
    return head("Actions", "Ranked fixes with the evidence behind each one. Work through them one at a time.") + `<div class="grid2 act"><div class="card pad"><div class="deckbar" id="deckCount"></div><p class="muted sm"><span class="kbd">→</span> done · <span class="kbd">←</span> skip</p><div class="deck" id="deck"></div></div>
      <div class="card"><div class="card-h"><b>Up next</b><span class="muted">${Math.max(0, DECK.length - 1)}</span></div>${DECK.slice(1).map((c) => { const k = lastCheck(M.slug, c.id); return `<button type="button" class="arow" data-card="${esc(c.id)}"><span class="ak">${esc(c.kind)}${k ? ` · ${k.pass ? "confirmed" : "not fixed yet"}` : ""}</span><b>${esc(c.title)}</b></button>`; }).join("") || '<p class="muted pad">Nothing queued.</p>'}</div></div>`;
  },
};
const TOPIC_OF = { best: "Best-of lists", alternatives: "Alternatives", comparison: "Comparisons", problem: "Problems to solve", local: "Budget & location", informational: "Research", commercial: "Comparisons", transactional: "Ready to buy" };

/* ---- chat details modal (prev / next through the current list) */
function markHtml(html, M, extra) {
  const { you, rivals } = namesFor(M, extra);
  const all = [...you, ...rivals].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!all.length) return html;
  const re = new RegExp(`(?<![\\w])(${all.map((n) => reEsc(esc(n))).join("|")})(?![\\w])`, "gi");
  return html.split(/(<[^>]+>)/).map((seg) => (seg.startsWith("<") ? seg : seg.replace(re, (m0) => `<mark class="${isYou(m0, M) ? "you" : ""}">${m0}</mark>`))).join("");
}
function openChat(key) {
  const M = APP.M; if (!M) return;
  const list = metrics(M, DASH.eng).A.map((a) => a.qid + "|" + a.engine);
  if (!list.includes(key)) list.unshift(key);
  let i = list.indexOf(key);
  $$(".modal").forEach((x) => x.remove());
  const m = document.createElement("div"); m.className = "modal light cmodal";
  const draw = () => {
    const a = M.answers[list[i]]; if (!a) return;
    m.innerHTML = `<div class="cm" role="dialog" aria-modal="true" aria-label="AI answer">
      <div class="cm-main"><div class="cm-hd"><span class="engchip">${engDot(a.engine)}${ENG[a.engine]}</span>${a.model ? `<span class="muted mono sm">${esc(a.model)}</span>` : ""}<span class="sp"></span>${a.named ? `<span class="posb">Named #${a.rank || "–"}</span>` : '<span class="posb no">Not named</span>'}</div>
        <div class="cm-scroll"><div class="bubble">${esc(qText(M, a.qid))}</div><div class="cm-ans md">${markHtml(md(a.answer || a.error || ""), M, a.brands)}</div></div>
        <div class="cm-nav"><button type="button" class="lnk" data-cm="-1" ${i ? "" : "disabled"}>${icon("arrow", 14)} Previous</button><span class="muted sm">${i + 1} of ${list.length}</span><button type="button" class="lnk" data-cm="1" ${i < list.length - 1 ? "" : "disabled"}>Next ${icon("arrow", 14)}</button></div></div>
      <aside class="cm-side"><div class="cm-sh"><b>Details</b><span class="sp"></span><button type="button" class="iconbtn" data-cm="x" aria-label="Close">${icon("x", 15)}</button></div>
        <div class="cm-sec">${icon("rank", 14)}Brands</div>${(a.brands || []).map((b, j) => `<div class="cm-b${isYou(b, M) ? " you" : ""}">${isYou(b, M) ? favImg(host(M.profile.site)) : letterAv(b)}<span>${esc(b)}</span><span class="sp"></span>${a.sent && a.sent[b] != null ? sentHtml(a.sent[b]) : ""}<span class="muted">#${j + 1}</span></div>`).join("") || '<p class="muted sm">No brands named.</p>'}
        ${(a.searches || []).length ? `<div class="cm-sec">${icon("search", 14)}Searches it ran</div>${a.searches.map((s) => `<p class="cm-q">${esc(s)}</p>`).join("")}` : ""}
        <div class="cm-sec">${icon("link", 14)}Sources</div>${(a.sources || []).map((s) => `<a class="cm-s" href="${esc(safeUrl(s.url) || "#")}" target="_blank" rel="noopener">${favImg(host(s.url))}<span><b>${esc(s.title || host(s.url))}</b><span class="muted">${esc(host(s.url))}</span></span></a>`).join("") || '<p class="muted sm">No sources.</p>'}
      </aside></div>`;
  };
  m.addEventListener("click", (e) => {
    if (e.target === m) return m.remove();
    const b = e.target.closest("[data-cm]"); if (!b) return;
    if (b.dataset.cm === "x") return m.remove();
    i = Math.max(0, Math.min(list.length - 1, i + +b.dataset.cm)); draw();
  });
  m.tabIndex = -1; m.addEventListener("keydown", (e) => { if (e.key === "ArrowRight" && i < list.length - 1) { i++; draw(); } if (e.key === "ArrowLeft" && i > 0) { i--; draw(); } });
  draw(); document.body.append(m); m.focus();
}

/* ---- pitch modal (from gap analysis) */
async function pitchModal(url) {
  const M = APP.M, t = pitchTargets(M).find((x) => x.url === url) || M.inspections[url]; if (!t) return;
  modal(`<span class="status">${esc(t.domain || host(url))} · cited ${t.n}×</span><h3>Get named on “${esc(t.title || url)}”</h3>${contactHtml(t.contacts)}<div class="pre" id="pmText">${M.pitches[url] ? esc(M.pitches[url]) : ""}</div><div class="acts" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" type="button" id="pmCopy">Copy pitch</button>${t.contacts?.emails?.[0] ? `<a class="btn ghost sm" id="pmMail" target="_blank" rel="noopener" href="#">Open in Gmail</a>` : ""}<a class="btn ghost sm" href="${esc(safeUrl(t.final || url) || "#")}" target="_blank" rel="noopener">Open page</a></div>`);
  const box = $(".modal:last-of-type"); box.classList.add("light");
  const out = $("#pmText"); let txt = M.pitches[url] || "";
  const fin = () => { if ($("#pmMail")) $("#pmMail").href = gmail(t.contacts.emails[0], txt); };
  $("#pmCopy").onclick = async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(txt); e.target.textContent = "Copied ✓"; } catch { e.target.textContent = "Select the text to copy"; } };
  if (!txt) {
    out.classList.add("typing");
    const paint = throttled(() => { out.textContent = txt; });
    try { await stream("/api/write", { kind: "pitch", data: { profile: M.profile, t: { url: t.final || url, title: t.title, author: t.contacts?.author, rivals: t.rivals, questions: (t.qs || []).map((q) => qText(M, q)), excerpt: t.excerpt } } }, { delta: (d) => { txt += d.text; paint(); } }); }
    catch (err) { toast(esc(err.message)); }
    out.classList.remove("typing"); out.textContent = txt; if (txt) { M.pitches[url] = txt; save(); }
  }
  fin();
}

/* ---- dashboard events */
$("#nav").addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (b) { DASH.page = b.dataset.page; dashRender(); } });
$("#reportWrap").addEventListener("click", (e) => {
  const t = e.target;
  const pg = t.closest(".main [data-page]"); if (pg) { const id = pg.dataset.card; DASH.page = pg.dataset.page; if (id) focusCard(id); dashRender(); return; }
  const card = t.closest("[data-card]"); if (card && DASH.page === "actions") { focusCard(card.dataset.card); return dashRender(); }
  const ch = t.closest("[data-chat]"); if (ch && !t.closest("a")) return openChat(ch.dataset.chat);
  const en = t.closest("[data-eng]"); if (en) { DASH.eng = en.dataset.eng; return dashRender(); }
  const cf = t.closest("[data-chatf]"); if (cf) { DASH.chatFilter = cf.dataset.chatf; return dashRender(); }
  const df = t.closest("[data-domf]"); if (df) { DASH.domFilter = df.dataset.domf; return dashRender(); }
  const sv = t.closest("[data-srcview]"); if (sv) { DASH.srcView = sv.dataset.srcview; return dashRender(); }
  const ut = t.closest("[data-utype]"); if (ut) { DASH.urlType = ut.dataset.utype; return dashRender(); }
  const pi = t.closest("[data-pitch]"); if (pi) return pitchModal(pi.dataset.pitch);
  if (t.closest("[data-howto]")) return howModal();
});
function focusCard(id) { const i = DECK.findIndex((c) => c.id === id); if (i > 0) DECK.unshift(DECK.splice(i, 1)[0]); }
$("#agentBtn").addEventListener("click", () => toggleAgent());
$("#agentClose").addEventListener("click", () => toggleAgent(false));
function toggleAgent(on) { const p = $("#agentPanel"); const open = on ?? p.hidden; p.hidden = !open; $(".dash").classList.toggle("agent-open", open); $("#agentBtn").setAttribute("aria-pressed", String(open)); if (open) setTimeout(() => $("#askIn").focus(), 50); }
$("#sideToggle").addEventListener("click", () => $("#side").classList.toggle("open"));
$("#projBtn").addEventListener("click", (e) => {
  e.stopPropagation(); const menu = $("#projMenu"), open = menu.hidden;
  if (open) {
    const cos = DATA.companies();
    menu.innerHTML = `<div class="pm-h">Your brands</div>${cos.map((c) => { const at = c.ws ? c.ws.lastRunAt : store.get("mission:" + c.slug, null)?.finishedAt; const sc = c.ws?.trend?.[0]?.summary?.score; return `<button type="button" data-proj="${esc(c.slug)}" class="${APP.M?.slug === c.slug || c.markets?.some((x) => x.slug === APP.M?.slug) ? "on" : ""}">${favImg(host(c.profile.site))}<span>${esc(c.profile.name)}${c.markets?.length ? ` <span class="muted sm">· ${c.markets.length + 1} markets</span>` : ""}</span><span class="sp"></span>${sc != null ? `<span class="pm-score">${sc}</span>` : ""}<span class="muted sm">${at ? new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "set up"}</span></button>`; }).join("")}${!DATA.server() || canEdit() ? `<button type="button" data-proj="__new">${icon("plus", 14)}<span>New brand</span></button>` : ""}`;
  }
  menu.hidden = !open; $("#projBtn").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => { if (!e.target.closest(".proj-wrap")) $("#projMenu").hidden = true; });
// Account menu (bottom of the sidebar): team, the agent log, new brand, sign out. Closes after any choice.
const acctShow = (open) => { $("#acctMenu").hidden = !open; $("#acctBtn").setAttribute("aria-expanded", String(open)); };
$("#acctBtn").addEventListener("click", (e) => { e.stopPropagation(); acctShow($("#acctMenu").hidden); });
$("#acctMenu").addEventListener("click", (e) => { if (e.target.closest("button")) acctShow(false); });
document.addEventListener("click", (e) => { if (!e.target.closest(".acct-wrap")) acctShow(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { acctShow(false); $("#projMenu").hidden = true; } });
$("#projMenu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-proj]"); if (!b) return; $("#projMenu").hidden = true;
  if (b.dataset.proj === "__new") return goHome();
  openBrand(b.dataset.proj);
});

/* =================================================================== MORE OF THE DASHBOARD
   Mention gaps, search rankings, cited URLs by page type, brand settings (schedule, sampling, integrations),
   trends and AI referral traffic. */
Object.assign(PAGES, { gaps: ["Prompts", "Mention gaps"], rankings: ["Sources", "Search rankings"], settings: ["Brand", "Settings"] });
APP.ints = {};
async function loadInts(slug, rerender = true) {
  if (!DATA.server() || !slug) return null;
  try { const d = await api("GET", `/api/workspaces/${encodeURIComponent(slug)}/integrations`); APP.ints[slug] = d; if (rerender && APP.M?.slug === slug && !$("#reportWrap").hidden) dashRender(); return d; }
  catch (e) { console.warn(e.message); return null; }
}
const intData = (M, id) => (APP.ints[M.slug]?.integrations || []).find((i) => i.id === id && i.connected && i.status !== "error")?.data || null;

// What kind of page AI cited. Heuristic on URL + title; good enough to show which formats win (listicles,
// comparisons, reviews...), which is what Peec's URL classification and Surfer's "content types" report show.
function pageType(url, title = "") {
  const u = String(url || "").toLowerCase(), t = String(title || "").toLowerCase(), s = u + " " + t;
  let p = ""; try { p = new URL(url).pathname.toLowerCase(); } catch {}
  if (/reddit\.com|quora\.com|stackexchange|stackoverflow|community\.|forum|news\.ycombinator|discord/.test(u)) return "Forum / UGC";
  if (/youtube\.com|youtu\.be|vimeo\.com|tiktok\.com/.test(u)) return "Video";
  if (/\bvs\.?\b|versus|compar|alternative/.test(s)) return "Comparison";
  if (/\b(best|top)\s*\d*\b|\b\d+\s+(best|top)\b|leading .* (companies|tools|firms|platforms)|list of/.test(t) || /\/(best|top)[-_]/.test(p)) return "Listicle";
  if (/\breview|rating|g2\.com|capterra|trustpilot|clutch\.co|trustradius|getapp/.test(s)) return "Review";
  if (/wikipedia\.org|britannica\.com|wikidata/.test(u)) return "Reference";
  if (/how to|guide|tutorial|what is|explained|\/learn\/|\/guides?\//.test(s)) return "Guide / how-to";
  if (/docs\.|\/docs\/|documentation|developer\./.test(u)) return "Docs";
  if (/pricing|\/products?\/|\/features|\/solutions?\/|\/services?\//.test(p)) return "Product / service";
  if (/\bnews\b|press|\/20\d\d\/\d\d\//.test(s)) return "News";
  if (p === "/" || p === "") return "Homepage";
  return "Article";
}
const TYPE_ORDER = ["Listicle", "Comparison", "Review", "Article", "Guide / how-to", "Product / service", "Homepage", "Forum / UGC", "Reference", "News", "Docs", "Video"];

function urlsOf(M, m) {
  const U = new Map();
  for (const a of m.A) for (const s of a.sources || []) {
    const k = s.url; const r = U.get(k) || { url: k, title: s.title || "", retr: 0, cited: 0, qids: new Set(), engines: new Set() };
    r.retr++; if (s.cited) r.cited++; r.qids.add(a.qid); r.engines.add(a.engine); if (!r.title && s.title) r.title = s.title; U.set(k, r);
  }
  return [...U.values()].map((r) => { const ins = M.inspections?.[r.url]; const title = ins?.title || r.title; return { ...r, title, type: pageType(r.url, title), domain: host(r.url), you: ins?.ok ? !!ins.you : null, rivals: ins?.rivals || [] }; }).sort((a, b) => b.retr - a.retr);
}

/* ---------- trend + referrals (overview) ---------- */
function trendPoints(M) {
  let pts = trendOf(M.slug);
  if (!pts.length) { const p = APP.prev?.slug === M.slug ? APP.prev : store.get("prev:" + M.slug, null); if (p?.answers) { const x = metrics(p, "all"); pts = [{ at: p.startedAt, visibility: x.you?.vis, score: x.score, leader: x.brands.find((b) => !b.you) }]; } }
  const cur = metrics(M, "all");
  if (!pts.some((t) => Math.abs(t.at - M.startedAt) < 120000)) pts.push({ at: M.startedAt, visibility: cur.you?.vis, score: cur.score, leader: { name: cur.brands.find((b) => !b.you)?.name, vis: cur.brands.find((b) => !b.you)?.vis } });
  return pts.sort((a, b) => a.at - b.at).slice(-12);
}
function trendHtml(M) {
  const pts = trendPoints(M);
  if (pts.length < 2) return `<div class="card note"><div class="pad">${icon("rank", 16)} <b>Trends start with your second check.</b> <span class="muted">${DATA.server() ? `Turn on weekly checks in <button type="button" class="lnk" data-page="settings">Settings</button> and Perfstaq re-runs every prompt on its own.` : "Run the check again next week to see what moved."}</span></div></div>`;
  const W = 620, H = 170, L = 36, B = 22, max = Math.max(0.1, ...pts.flatMap((p) => [p.visibility || 0, p.leader?.vis || 0]));
  const top = Math.min(1, Math.ceil(max * 5) / 5);
  const X = (i) => L + (i * (W - L - 10)) / (pts.length - 1), Y = (v) => 8 + (1 - (v || 0) / top) * (H - B - 8);
  const line = (k, cls) => `<polyline class="${cls}" points="${pts.map((p, i) => `${X(i).toFixed(1)},${Y(k(p)).toFixed(1)}`).join(" ")}"/>`;
  const dots = (k, cls) => pts.map((p, i) => `<circle class="${cls}" cx="${X(i).toFixed(1)}" cy="${Y(k(p)).toFixed(1)}" r="3"><title>${new Date(p.at).toLocaleDateString()}: ${pct(k(p), 0)}</title></circle>`).join("");
  const leaderName = pts[pts.length - 1].leader?.name;
  return `<div class="card"><div class="card-h"><b>Visibility over time</b><span class="muted">${pts.length} checks</span><span class="sp"></span><span class="leg"><i class="you"></i>You</span>${leaderName ? `<span class="leg"><i></i>${esc(leaderName)} (leader)</span>` : ""}</div>
    <svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Your visibility over time compared with the leading competitor">
      ${[0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W - 10}" y1="${Y(top * f)}" y2="${Y(top * f)}" class="grid"/><text x="${L - 6}" y="${Y(top * f) + 4}" text-anchor="end">${Math.round(top * f * 100)}%</text>`).join("")}
      ${pts.map((p, i) => (i === 0 || i === pts.length - 1 || pts.length <= 6 ? `<text x="${X(i)}" y="${H - 4}" text-anchor="middle">${new Date(p.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</text>` : "")).join("")}
      ${line((p) => p.leader?.vis, "lead")}${dots((p) => p.leader?.vis, "lead")}${line((p) => p.visibility, "you")}${dots((p) => p.visibility, "you")}
    </svg></div>`;
}
function referralHtml(M) {
  const g = intData(M, "google")?.ga4;
  if (!g || g.error || g.skipped) return "";
  const t = g.totals || {}, by = g.byAssistant || [];
  return `<div class="card"><div class="card-h"><b>Visitors from AI assistants</b><span class="muted">Google Analytics · ${esc(g.dateRange || "last 28 days")}</span></div>
    <div class="kpis k3 flat"><div class="kpi"><span class="kl">Sessions</span><span class="kv">${(t.sessions || 0).toLocaleString()}</span></div><div class="kpi"><span class="kl">Engaged</span><span class="kv">${(t.engagedSessions || 0).toLocaleString()}</span></div><div class="kpi"><span class="kl">Key events</span><span class="kv">${(t.keyEvents || 0).toLocaleString()}</span></div></div>
    ${by.slice(0, 6).map((r) => `<div class="erow"><span class="en">${esc(r.assistant)}</span><span class="eb"><i style="width:${Math.round((100 * r.sessions) / Math.max(1, by[0].sessions))}%"></i></span><b>${r.sessions}</b></div>`).join("") || '<p class="muted pad">No visits from AI assistants in this period yet.</p>'}</div>`;
}

/* ---------- markets: one brand, one tab per country ---------- */
function marketStrip(M) {
  if (!DATA.server()) return "";
  const list = marketsOf(M.slug), found = (M.audit?.markets || []).filter((x) => !list.some((w) => w.market?.code === x.code));
  if (list.length < 2 && !(found.length && canEdit())) return "";
  const last = (w) => (w.trend || [])[0]?.summary;
  return `<div class="mkts" role="tablist" aria-label="Markets">${list.map((w) => `<button type="button" class="mkt" role="tab" data-mkt="${esc(w.slug)}" aria-current="${w.slug === M.slug}">${icon("globe", 13)}<b>${esc(marketLabel(w))}</b>${last(w) ? `<span class="muted">${pct(last(w).visibility, 0)}</span>` : '<span class="muted">not checked</span>'}</button>`).join("")}
    ${canEdit() ? `<button type="button" class="mkt add" data-addmkt>${icon("plus", 13)}Add market${found.length ? ` <span class="muted">${found.length} found</span>` : ""}</button>` : ""}</div>`;
}
// Overview: every market of the brand side by side, from each one's latest check.
function marketsCompare(M) {
  const list = marketsOf(M.slug); if (list.length < 2) return "";
  return `<div class="card"><div class="card-h"><b>By market</b><span class="muted">Each country is checked with its own prompts, from that country</span></div><table class="tbl click"><thead><tr><th>Market</th><th class="r">Score</th><th class="r">Visibility</th><th class="r">Share of voice</th><th>Leader</th><th class="r">Last check</th></tr></thead><tbody>
    ${list.map((w) => { const t = (w.trend || [])[0], x = t?.summary; return `<tr data-mkt="${esc(w.slug)}" class="${w.slug === M.slug ? "you" : ""}"><td><b>${esc(marketLabel(w))}</b> <span class="muted sm">${esc(host(w.site || ""))}${esc(w.market?.path || "")}</span></td><td class="r">${x ? x.score : "–"}</td><td class="r">${x ? pct(x.visibility) : "–"}</td><td class="r">${x ? pct(x.sov) : "–"}</td><td>${x?.leader ? `${esc(x.leader.name)} <span class="muted">${pct(x.leader.vis, 0)}</span>` : "–"}</td><td class="r">${t ? esc(fmtDay(t.started_at)) : "not yet"}</td></tr>`; }).join("")}</tbody></table></div>`;
}
function addMarketModal(M) {
  const list = marketsOf(M.slug), top = list[0], have = new Set(list.map((w) => w.market?.code).filter(Boolean));
  const found = (M.audit?.markets || []).filter((x) => !have.has(x.code));
  const lim = APP.cfg.billing?.limits?.markets;
  modal(`<span class="status">${esc(top.name)}</span><h3>Add a market</h3><p class="muted">Track another country version of ${esc(host(top.site || M.profile.site))}. It gets its own prompts and competitors, is asked from that country, and has its own schedule and report.${lim != null ? ` Your plan tracks up to ${lim} market${lim === 1 ? "" : "s"} per brand (you have ${list.length}).` : ""}</p>
    ${found.length ? `<div class="ob-sugs">${found.map((x) => `<button type="button" data-mkturl="${esc(x.url)}">${esc(x.name)} <span class="muted">${esc(x.path)}</span></button>`).join("")}</div>` : ""}
    <form class="pill" id="mktForm" style="margin-top:12px"><span class="pill-ic">${icon("globe", 17)}</span><input id="mktUrl" placeholder="${esc((M.audit?.origin || host(M.profile.site)) + "/us")}" aria-label="The address of that country's site"><button class="go" type="submit" aria-label="Set it up">${icon("arrow", 16)}</button></form>`);
  const box = $(".modal:last-of-type");
  const go = (url) => { box.remove(); startOnboarding(url, { profile: Object.fromEntries(Object.entries(M.profile).filter(([k]) => ["name", "category", "offer", "identity", "products", "personas", "facts"].includes(k))) }, { parent: top.slug }); };
  box.addEventListener("click", (e) => { const b = e.target.closest("[data-mkturl]"); if (b) go(b.dataset.mkturl); });
  $("#mktForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#mktUrl").value.trim(); if (v) go(v); });
}
$("#reportWrap").addEventListener("click", (e) => {
  const t = e.target.closest("[data-mkt]"); if (t && APP.M && t.dataset.mkt !== APP.M.slug) return openBrand(t.dataset.mkt);
  if (e.target.closest("[data-addmkt]") && APP.M) addMarketModal(APP.M);
});

/* ---------- pages ---------- */
Object.assign(PAGE, {
  gaps(M, m) {
    const engs = DASH.eng === "all" ? M.engines : [DASH.eng];
    const rows = RM.questionGaps(M, { engines: engs, isYou: (b) => isYou(b, M) }).map((g) => ({
      q: M.questions.find((q) => q.id === g.questionId), as: g.answers,
      rivals: g.competitors.map((c) => [c.name, c.mentions]), doms: RM.sourceDomains(g.sources).slice(0, 4).map((d) => [d.domain, d.citedCount]),
    }));
    const fill = {}; rows.forEach((r) => r.rivals.forEach(([n, c]) => (fill[n] = (fill[n] || 0) + c)));
    const top = Object.entries(fill).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return head("Mention gaps", `Prompts where AI recommends a competitor and never you. ${rows.length} of ${M.questions.length} prompts. Each one is a page to publish or a list to get onto.`)
      + (top.length ? `<div class="card"><div class="card-h"><b>Who fills your gaps</b><span class="muted">Mentions in the answers that leave you out</span></div>${top.map(([n, c]) => `<div class="erow"><span class="en">${letterAv(n)}${esc(n)}</span><span class="eb"><i style="width:${Math.round((100 * c) / top[0][1])}%;background:#9A9AA0"></i></span><b>${c}</b></div>`).join("")}</div>` : "")
      + `<div class="card">${rows.length ? rows.map((r) => `<div class="gaprow"><div class="gm"><b>${esc(r.q.text)}</b>
          <span class="chips">${r.rivals.slice(0, 5).map(([n, c]) => `<span class="tagx red">${esc(n)} ${c > 1 ? `×${c}` : ""}</span>`).join("")}</span>
          <span class="muted sm">AI leaned on ${r.doms.map(([d]) => esc(d)).join(", ") || "no pages"} · ${r.as.length} answer${r.as.length === 1 ? "" : "s"} across ${[...new Set(r.as.map((a) => ENG[a.engine]))].join(", ")}</span></div>
          <span class="gacts"><button type="button" class="btn ghost sm" data-chat="${esc(akey(r.as[0].qid, r.as[0].engine, r.as[0].sample || 0))}">Read answer</button><button type="button" class="btn sm" data-article="${esc(r.q.id)}">${M.articles?.[r.q.id] ? "Open page draft" : "Draft a page to win it"}</button></span></div>`).join("")
        : `<p class="pad muted">No gaps: whenever AI recommends someone for your prompts, you're among them.</p>`}</div>`;
  },
  rankings(M, m) {
    const gsc = intData(M, "google")?.gsc, bing = intData(M, "bing");
    const Q = new Map();
    for (const a of m.A) for (const s of a.searches || []) { const k = norm(s); if (!k) continue; const r = Q.get(k) || { q: s, n: 0, engines: new Set(), kind: "AI search" }; r.n++; r.engines.add(a.engine); Q.set(k, r); }
    for (const q of M.questions) if (!Q.has(norm(q.text))) Q.set(norm(q.text), { q: q.text, n: 0, engines: new Set(), kind: "Your prompt" });
    const list = [...Q.values()].sort((a, b) => b.n - a.n).slice(0, 40);
    const own = host(M.profile.site || "");
    const match = (rows, key, q) => { const t = norm(q); return (rows || []).find((r) => { const x = norm(r[key]); return x === t || (x.length > 6 && (t.includes(x) || x.includes(t))); }); };
    M.serp = M.serp || {};
    const cell = (q) => {
      const r = M.serp[norm(q)];
      if (!r) return APP.cfg.serp ? `<button type="button" class="lnk" data-serp="${esc(q)}">Check Google</button>` : '<span class="muted">–</span>';
      if (r.error) return `<span class="muted" title="${esc(r.error)}">failed</span>`;
      const mine = r.results.find((x) => x.domain && own && (x.domain === own || x.domain.endsWith("." + own)));
      return mine ? `<span class="posb">#${mine.position}</span>` : `<span class="posb no">not in top 10</span> <span class="muted sm">${esc(r.results[0]?.domain || "")}</span>`;
    };
    const checked = list.filter((x) => M.serp[norm(x.q)] && !M.serp[norm(x.q)].error), inTop = checked.filter((x) => M.serp[norm(x.q)].results.some((r) => r.domain && (r.domain === own || r.domain.endsWith("." + own))));
    const cta = [];
    if (!gsc) cta.push(`<div class="cta">${icon("link", 16)}<div><b>Connect Google Search Console</b><span class="muted">Free. Shows where you rank on Google for these queries, with clicks.</span></div><button type="button" class="btn ghost sm" data-page="settings">Connect</button></div>`);
    if (!bing) cta.push(`<div class="cta">${icon("link", 16)}<div><b>Connect Bing Webmaster Tools</b><span class="muted">Free. ChatGPT search leans on Bing's index; this shows your Bing positions.</span></div><button type="button" class="btn ghost sm" data-page="settings">Connect</button></div>`);
    if (!APP.cfg.serp) cta.push(`<div class="cta">${icon("info", 16)}<div><b>Live Google top-10 checks are off</b><span class="muted">Ask your Perfstaq admin to turn on live Google checks to see your top-10 position for any query.</span></div></div>`);
    return head("Search rankings", "AI answers start with a web search. These are the searches AI ran for your prompts, and where you rank for them. Ranking on page one is still the biggest single lever for being cited.")
      + (cta.length && DATA.server() ? `<div class="ctas">${cta.join("")}</div>` : "")
      + `<div class="kpis k4"><div class="kpi"><span class="kl">Queries AI searched</span><span class="kv">${Q.size}</span></div><div class="kpi"><span class="kl">Search Console clicks (28d)</span><span class="kv">${gsc?.totals ? gsc.totals.clicks.toLocaleString() : "–"}</span></div><div class="kpi"><span class="kl">Avg Google position</span><span class="kv">${gsc?.totals?.position || "–"}</span></div><div class="kpi"><span class="kl">Top 10 on Google</span><span class="kv">${checked.length ? `${inTop.length}<small>/${checked.length} checked</small>` : "–"}</span></div></div>`
      + `<div class="card"><table class="tbl"><thead><tr><th>Query</th><th>Source</th><th class="r">Times searched</th><th class="r">Google (Search Console)</th><th class="r">Bing</th><th class="r">Live Google top 10</th></tr></thead><tbody>
        ${list.map((x) => { const g = match(gsc?.queries, "query", x.q), b = match(bing?.queries, "query", x.q); return `<tr><td class="pt"><b>${esc(x.q)}</b></td><td><span class="tagx">${x.kind}</span> ${[...x.engines].map((e) => engDot(e)).join("")}</td><td class="r">${x.n || "–"}</td>
          <td class="r">${g ? `#${g.position} <span class="muted sm">${g.clicks} clicks</span>` : gsc ? '<span class="muted">not ranking</span>' : '<span class="muted">–</span>'}</td>
          <td class="r">${b ? `#${b.avgPosition ?? "–"} <span class="muted sm">${b.impressions} impr.</span>` : bing ? '<span class="muted">not ranking</span>' : '<span class="muted">–</span>'}</td><td class="r">${cell(x.q)}</td></tr>`; }).join("")}
      </tbody></table></div>`;
  },
  settings(M) {
    const ws = DATA.ws(M.slug);
    if (!DATA.server()) return head("Settings", "Scheduling, integrations and history need an account.") + `<div class="card pad"><p>This copy of Perfstaq is running without a database, so everything is kept in this browser. Deploy it on Google Cloud (see <code>infra/README</code>) or set <code>DATABASE_URL</code>, and you get accounts, weekly checks that run on their own, trend history and integrations with Search Console, GA4, Bing, Cloudflare and Slack.</p></div>`;
    const d = APP.ints[M.slug]; const ints = d?.integrations || [];
    const sched = ws?.schedule || "off", samples = ws?.samples || 1;
    if (APP.emailPrefs === undefined) { APP.emailPrefs = null; api("GET", "/api/me/email-prefs").then((x) => { APP.emailPrefs = x; if (DASH.page === "settings") dashRender(); }).catch(() => {}); }
    const c = DATA.company(M.slug) || {};
    const prompts = (c.questions || M.questions).filter((q) => q.on !== false).length;
    const moveTo = APP.orgs.filter((o) => o.slug !== APP.org?.slug && ["owner", "admin"].includes(o.role));
    const roleNote = !canEdit() ? `<div class="card note"><div class="pad">${icon("info", 16)} <b>You're a viewer in ${esc(APP.org?.name || "this organisation")}.</b> <span class="muted">You can see everything here; an editor or admin can change it.</span></div></div>` : "";
    const TABS = [["checks", "Checks", "When Perfstaq asks AI again"], ["tracked", "What's tracked", "Prompts and competitors"], ["integrations", "Integrations", d ? `${ints.filter((i) => i.connected).length} connected` : "Search, site, alerts"], ["brand", "Brand", "Move or delete"]];
    const tab = TABS.some((t) => t[0] === DASH.setTab) ? DASH.setTab : "checks";
    const row = (title, hint, ctl) => `<div class="st-row"><div class="st-l"><b>${title}</b>${hint ? `<span>${hint}</span>` : ""}</div><div class="st-c">${ctl}</div></div>`;
    const when = ws?.running ? "A check is running now." : ws?.nextRunAt ? `Next check ${new Date(ws.nextRunAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.` : "No automatic checks scheduled.";
    let body = "";
    if (tab === "checks") body = `<div class="card st-card">
        ${row("Automatic checks", "Re-runs every prompt on the server. You can close the tab.", `<div class="seg">${[["off", "Off"], ["weekly", "Weekly"], ["daily", "Daily"]].map(([k, l]) => `<button type="button" data-sched="${k}" aria-pressed="${sched === k}" ${PLANL.schedules().includes(k) ? "" : `disabled title="Not on your ${esc(PLANL.name())} plan"`}>${l}</button>`).join("")}</div>`)}
        ${row("Answers per prompt", "Asking more than once averages out AI's run-to-run variation.", `<div class="seg">${[1, 2, 3].map((k) => `<button type="button" data-samp="${k}" aria-pressed="${samples === k}" ${k <= PLANL.samples() ? "" : `disabled title="Not on your ${esc(PLANL.name())} plan"`}>${k}×</button>`).join("")}</div>`)}
        ${sched !== "off" ? row("When", `In ${esc(ws?.runTz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")} time. "Any time" runs ${sched === "daily" ? "a day" : "a week"} after the last check.`, `<div class="st-time">${sched === "weekly" ? `<select class="sel" data-rundow aria-label="Day"><option value="">Any day</option>${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => `<option value="${i}" ${ws?.runDow === i ? "selected" : ""}>${d}</option>`).join("")}</select>` : ""}<select class="sel" data-runhour aria-label="Time"><option value="">Any time</option>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${ws?.runHour === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select></div>`) : ""}
        ${canAdmin() ? row("Results email", "After each automatic check: what changed, which fixes are confirmed live, and results after publishing. Sent to owners and admins.", `<label class="tgl"><input type="checkbox" data-emailme ${APP.emailPrefs?.reports === false ? "" : "checked"}> <span>Email me</span></label>`) : ""}
        ${row("Run a check now", `${when}${ws?.lastRunAt ? ` Last check ${new Date(ws.lastRunAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}.` : ""}`, `<button type="button" class="btn ghost sm" data-queue>Queue a check</button>`)}
      </div>
      <p class="st-foot">Each check collects about ${prompts * M.engines.length * samples} AI answers: ${prompts} prompts × ${M.engines.length} engine${M.engines.length === 1 ? "" : "s"} (${M.engines.map((e) => ENG[e]).join(", ")}) × ${samples}.</p>`;
    if (tab === "tracked") body = `<div class="card st-card">
        ${row("Prompts", "The buyer questions we ask AI for you.", `<span class="st-v">${prompts}${(c.topics || []).length ? ` <span class="muted">in ${(c.topics || []).length} topics</span>` : ""}</span>`)}
        ${row("Competitors", esc((M.profile.competitors || []).slice(0, 6).join(", ")) || "None yet", `<span class="st-v">${(M.profile.competitors || []).length}</span>`)}
        ${row("Website", esc(host(M.profile.site || "")), `<button type="button" class="btn ghost sm" data-editsetup>Edit prompts and competitors</button>`)}
      </div>`;
    if (tab === "integrations") {
      const GROUPS = [["Search and traffic", "Where you rank and who visits.", ["google", "bing", "serp"]], ["Your site", "Help AI find and read your pages.", ["cloudflare", "indexnow", "entity"]], ["Alerts", "Hear about changes without opening Perfstaq.", ["slack"]]];
      const seen = new Set();
      const grp = GROUPS.map(([t, h, ids]) => { const list = ints.filter((i) => ids.includes(i.id)); list.forEach((i) => seen.add(i.id)); return list.length ? `<div class="st-grp"><div class="st-gh"><b>${t}</b><span>${h}</span></div><div class="ints">${list.map((i) => intCard(M, i)).join("")}</div></div>` : ""; }).join("");
      const rest = ints.filter((i) => !seen.has(i.id));
      body = (!d ? '<p class="muted pad">Loading…</p>' : grp + (rest.length ? `<div class="st-grp"><div class="st-gh"><b>More</b></div><div class="ints">${rest.map((i) => intCard(M, i)).join("")}</div></div>` : ""))
        + (canAdmin() ? "" : `<p class="st-foot">Connecting and disconnecting is for admins.</p>`);
    }
    if (tab === "brand") body = `<div class="card st-card">
        ${canAdmin() && moveTo.length && !ws?.parent ? row("Move to another organisation", "Brings its history, prompts and integrations along.", `<div class="st-inline"><select id="moveOrg" class="sel">${moveTo.map((o) => `<option value="${esc(o.slug)}">${esc(o.name)}</option>`).join("")}</select><button type="button" class="btn ghost sm" data-move>Move</button></div>`) : ""}
        ${ws?.parent ? row("Delete this market", `Removes ${esc(marketLabel(ws))} from ${esc(M.profile.name)}: its prompts, checks and history. The brand's other markets stay. This can't be undone.`, `<button type="button" class="btn ghost sm st-danger" id="delBrand" data-del>Delete market</button>`)
          : row("Delete this brand", `Removes ${esc(M.profile.name)}, its checks and history${marketsOf(M.slug).length > 1 ? `, and its ${marketsOf(M.slug).length - 1} other market${marketsOf(M.slug).length > 2 ? "s" : ""}` : ""}. This can't be undone.`, `<button type="button" class="btn ghost sm st-danger" id="delBrand" data-del>Delete brand</button>`)}
      </div>`;
    return head("Settings", `How Perfstaq tracks ${esc(M.profile.name)}.`) + roleNote
      + `<div class="st"><nav class="st-nav" aria-label="Settings sections">${TABS.map(([k, l, h]) => `<button type="button" data-settab="${k}" aria-current="${k === tab}"><b>${l}</b><span>${h}</span></button>`).join("")}
          <button type="button" class="st-team" data-openteam>${icon("team", 15)}<span><b>Team &amp; keys</b><span>For every brand in ${esc(APP.org?.name || "this team")}</span></span></button></nav>
        <div class="st-body">${body}</div></div>`;
  },
});

function intCard(M, i) {
  const st = !i.connected ? "" : i.status === "error" ? `<span class="pillx no">Needs attention</span>` : `<span class="pillx ok">Connected</span>`;
  const fields = (i.fields || []).filter((f) => !(i.id === "google")).map((f) => `<label class="af sm"><span>${esc(f.label)}</span><input data-f="${esc(f.key)}" type="${f.secret ? "password" : "text"}" placeholder="${esc(f.secret && i.connected ? "•••••••• (saved)" : f.placeholder || "")}" value="${esc(f.secret ? "" : i.config?.[f.key] || "")}" autocomplete="off"></label>`).join("");
  let body = "";
  if (i.id === "google") {
    if (!i.available) body = `<p class="muted sm">Google sign-in is not set up on this server yet. Ask your Perfstaq admin to turn it on.</p>`;
    else if (!i.connected) body = `<a class="btn sm" href="/api/oauth/google/start?ws=${encodeURIComponent(M.slug)}">Connect with Google</a>`;
    else body = `<div class="gprops" data-gprops><button type="button" class="btn ghost sm" data-loadprops>Choose properties</button><span class="muted sm">Search Console: ${esc(i.config?.gscProperty || "not chosen")} · GA4: ${esc(i.config?.ga4PropertyId || "not chosen")}</span></div>`;
  } else body = `<div class="ifields">${fields}</div>`;
  const extra = i.id === "indexnow" && i.connected ? `<p class="muted sm">Host this key at <code>https://${esc(host(M.profile.site))}/${esc(i.config?.key || "")}.txt</code> (the file contains just the key).</p>` : "";
  const sub = ["indexnow", "bing"].includes(i.id) && i.connected ? `<button type="button" class="btn ghost sm" data-submit="${i.id}">Submit site pages</button>` : "";
  return `<div class="icard" data-int="${esc(i.id)}"><div class="ih"><b>${esc(i.name)}</b>${i.free ? '<span class="tagx">Free</span>' : '<span class="tagx">Paid</span>'}<span class="sp"></span>${st}</div>
    <p class="muted sm">${esc(i.blurb)}</p>${body}${extra}
    ${i.detail ? `<p class="idetail ${i.status === "error" ? "bad" : ""}">${esc(i.detail)}</p>` : ""}
    <div class="iacts">${i.id !== "google" ? `<button type="button" class="btn sm" data-save>${i.connected ? "Update" : "Connect"}</button>` : ""}${i.connected && i.id !== "slack" ? `<button type="button" class="btn ghost sm" data-refresh>Refresh data</button>` : ""}${sub}${i.connected ? `<button type="button" class="lnk sm" data-disconnect>Disconnect</button>` : ""}${i.docs ? `<a class="lnk sm" href="${esc(i.docs)}" target="_blank" rel="noopener">Where to find this</a>` : ""}</div></div>`;
}

/* ---------- actions on these pages ---------- */
$("#reportWrap").addEventListener("change", async (e) => {
  const t = e.target, M = APP.M; if (!M) return;
  try {
    if (t.matches("[data-rundow],[data-runhour]")) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const w = await DATA.patch(M.slug, { [t.matches("[data-rundow]") ? "runDow" : "runHour"]: t.value === "" ? null : +t.value, runTz: tz });
      toast(w.nextRunAt ? `Next check ${esc(new Date(w.nextRunAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}.` : "Saved."); return dashRender();
    }
    if (t.matches("[data-emailme]")) { APP.emailPrefs = await api("PUT", "/api/me/email-prefs", { reports: t.checked }); toast(t.checked ? "You'll get the results email after each automatic check." : "No more results emails for you. Checks keep running."); }
  } catch (err) { toast(esc(err.message)); dashRender(); }
});
$("#reportWrap").addEventListener("click", async (e) => {
  const t = e.target, M = APP.M; if (!M) return;
  const slug = M.slug, card = t.closest("[data-int]"), id = card?.dataset.int;
  const busy = (b, txt) => { b.setAttribute("aria-disabled", "true"); const o = b.textContent; b.textContent = txt; return () => { b.removeAttribute("aria-disabled"); b.textContent = o; }; };
  try {
    if (t.closest("#navSettings")) { DASH.page = "settings"; return dashRender(); }
    const stb = t.closest("[data-settab]"); if (stb) { DASH.setTab = stb.dataset.settab; return dashRender(); }
    if (t.closest("[data-openteam]")) return openTeam();
    const sc = t.closest("[data-sched]"); if (sc) { await DATA.patch(slug, { schedule: sc.dataset.sched }); toast(sc.dataset.sched === "off" ? "Automatic checks are off." : `${sc.dataset.sched === "daily" ? "Daily" : "Weekly"} checks are on.`); return dashRender(); }
    const sp = t.closest("[data-samp]"); if (sp) { await DATA.patch(slug, { samples: +sp.dataset.samp }); return dashRender(); }
    if (t.closest("[data-queue]")) { if (await runBlocked()) return; await DATA.patch(slug, { runNow: true }); toast("Queued. The server starts it within about 10 minutes, so you can close this tab. Results appear here."); return dashRender(); }
    if (t.closest("[data-editsetup]")) { const c = DATA.company(slug); return startOnboarding(M.profile.site, c || { profile: M.profile, questions: M.questions.map((q) => ({ ...q, on: true })), engines: M.engines }); }
    const del = t.closest("[data-del]");
    if (del) { if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "Click again to delete everything"; del.classList.add("danger"); return; } const parent = DATA.ws(slug)?.parent; await api("DELETE", `/api/workspaces/${encodeURIComponent(slug)}`); await DATA.refresh(); APP.M = null; toast(parent ? "Market deleted." : "Brand deleted."); return parent ? openBrand(parent) : home(); }
    const art = t.closest("[data-article]"); if (art) return articleModal(art.dataset.article);
    const mv = t.closest("[data-move]");
    if (mv) { const to = $("#moveOrg").value, name = $("#moveOrg").selectedOptions[0]?.textContent; if (mv.dataset.armed !== "1") { mv.dataset.armed = "1"; mv.textContent = `Click again to move it to ${name}`; return; }
      await api("PATCH", `/api/workspaces/${encodeURIComponent(slug)}`, { moveTo: to }); toast(`${esc(M.profile.name)} moved to ${esc(name)}.`); await switchOrg(to); return; }
    const sq = t.closest("[data-serp]");
    if (sq) { const done = busy(sq, "Checking…"); const q = sq.dataset.serp; M.serp = M.serp || {};
      try { const r = await api("POST", "/api/serp/organic", { query: q, market: M.profile.market, country: M.profile.country }); M.serp[norm(q)] = { results: r.results, at: Date.now() }; }
      catch (err) { M.serp[norm(q)] = { error: err.message }; toast(esc(err.message)); }
      done(); save(true); return dashRender(); }
    if (!id) return;
    if (t.closest("[data-save]")) {
      const b = t.closest("[data-save]"), done = busy(b, "Checking…"), body = {};
      card.querySelectorAll("[data-f]").forEach((inp) => { if (inp.value.trim()) body[inp.dataset.f] = inp.value.trim(); });
      if (id === "bing" && !body.siteUrl && !APP.ints[slug]?.integrations?.find((i) => i.id === "bing")?.config?.siteUrl) body.siteUrl = M.profile.site;
      try { const r = await api("PUT", `/api/workspaces/${encodeURIComponent(slug)}/integrations/${id}`, body); APP.ints[slug] = { ...APP.ints[slug], integrations: r.integrations }; toast(r.ok ? `Connected. ${esc(r.detail || "")}` : esc(r.detail || "Couldn't connect.")); }
      finally { done(); } return dashRender();
    }
    if (t.closest("[data-refresh]")) { const b = t.closest("[data-refresh]"), done = busy(b, "Refreshing…"); try { const r = await api("POST", `/api/workspaces/${encodeURIComponent(slug)}/integrations/${id}/collect`); APP.ints[slug] = { ...APP.ints[slug], integrations: r.integrations }; toast("Updated."); } finally { done(); } return dashRender(); }
    if (t.closest("[data-disconnect]")) { const r = await api("DELETE", `/api/workspaces/${encodeURIComponent(slug)}/integrations/${id}`); APP.ints[slug] = { ...APP.ints[slug], integrations: r.integrations }; return dashRender(); }
    const sub = t.closest("[data-submit]");
    if (sub) { const done = busy(sub, "Submitting…"); const urls = [M.profile.site, ...(M.audit?.pages || []).map((p) => p.url)].filter(Boolean);
      try { const r = await api("POST", `/api/workspaces/${encodeURIComponent(slug)}/integrations/${id}/submit`, { urls }); toast(esc(r.detail || `Submitted ${r.submitted ?? urls.length} pages.`)); } finally { done(); } return; }
    if (t.closest("[data-loadprops]")) {
      const box = card.querySelector("[data-gprops]"); box.innerHTML = '<span class="muted sm">Loading your properties…</span>';
      const p = await api("POST", `/api/workspaces/${encodeURIComponent(slug)}/integrations/google/properties`);
      const cur = APP.ints[slug]?.integrations?.find((i) => i.id === "google")?.config || {};
      box.innerHTML = `<label class="af sm"><span>Search Console property</span><select data-f="gscProperty"><option value="">None</option>${(p.gsc || []).map((s) => `<option ${s === cur.gscProperty ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
        <label class="af sm"><span>GA4 property</span><select data-f="ga4PropertyId"><option value="">None</option>${(p.ga4 || []).map((g) => `<option value="${esc(g.id)}" ${String(g.id) === String(cur.ga4PropertyId) ? "selected" : ""}>${esc(g.name || g.id)}</option>`).join("")}</select></label>
        <button type="button" class="btn sm" data-saveprops>Save</button>`;
      return;
    }
    if (t.closest("[data-saveprops]")) { const body = {}; card.querySelectorAll("[data-f]").forEach((s) => (body[s.dataset.f] = s.value)); const r = await api("PUT", `/api/workspaces/${encodeURIComponent(slug)}/integrations/google`, body); APP.ints[slug] = { ...APP.ints[slug], integrations: r.integrations }; toast(r.ok ? "Saved. Pulling your Search Console and GA4 data." : esc(r.detail)); return dashRender(); }
  } catch (err) { toast(esc(err.message)); }
});

// A page built to win one prompt, written on demand (same writer the action deck uses).
async function articleModal(qid) {
  const M = APP.M, q = M.questions.find((x) => x.id === qid); if (!q) return;
  M.articles = M.articles || {};
  modal(`<span class="status">Mention gap · ${esc(q.intent || "")}</span><h3>A page to win “${esc(q.text)}”</h3><p class="muted sm">Built to be the page AI cites: a direct answer first, question headings, a fair comparison table and an FAQ. Anything the agent can't verify is marked [TODO].</p><div class="pre md" id="amText">${M.articles[qid] ? md(M.articles[qid]) : ""}</div><div style="display:flex;gap:8px"><button class="btn sm" type="button" id="amCopy">Copy</button></div>`);
  $(".modal:last-of-type .box").style.maxWidth = "860px";
  const out = $("#amText"); let txt = M.articles[qid] || "";
  $("#amCopy").onclick = async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(txt); e.target.textContent = "Copied ✓"; } catch { e.target.textContent = "Select the text to copy"; } };
  if (txt) return;
  out.classList.add("typing"); const paint = throttled(() => { out.innerHTML = md(txt); });
  const rivals = [...new Set(M.engines.flatMap((e) => answersOf(M, qid, e).flatMap((a) => a.brands || [])))].filter((x) => !isYou(x, M));
  try { await stream("/api/write", { kind: "article", data: { profile: M.profile, question: q.text, rivals, siteText: M.siteText } }, { delta: (d) => { txt += d.text; paint(); } }); }
  catch (err) { toast(esc(err.message)); }
  out.classList.remove("typing"); out.innerHTML = md(txt); if (txt) { M.articles[qid] = txt; save(true); }
}

/* ---------- sources by URL and content type ---------- */
const srcSwitch = () => `<div class="segc inl">${[["domains", "Domains"], ["urls", "URLs & content types"]].map(([k, l]) => `<button type="button" data-srcview="${k}" aria-pressed="${(DASH.srcView || "domains") === k}">${l}</button>`).join("")}</div>`;
function urlsPage(M, m) {
  const urls = urlsOf(M, m), total = urls.reduce((s, u) => s + u.retr, 0) || 1;
  const T = {}; urls.forEach((u) => { const t = (T[u.type] ||= { type: u.type, retr: 0, urls: 0, you: 0, rivalsOnly: 0 }); t.retr += u.retr; t.urls++; if (u.you) t.you++; else if (u.you === false && u.rivals.length) t.rivalsOnly++; });
  const types = Object.values(T).sort((a, b) => b.retr - a.retr), max = Math.max(1, ...types.map((t) => t.retr));
  const f = DASH.urlType || "all", list = urls.filter((u) => f === "all" || u.type === f);
  const ownTypes = [...new Set(urls.filter((u) => domainType(u.domain, M) === "You").map((u) => u.type))];
  const win = types[0];
  return head("URLs & content types", `The exact pages AI cites, and what kind of page they are. ${win ? `${esc(win.type)} pages earn ${pct(win.retr / total, 0)} of all citations here${ownTypes.includes(win.type) ? "" : ", and AI cites none of yours yet"}.` : ""}`) + srcSwitch()
    + `<div class="grid2"><div class="card"><div class="card-h"><b>Content types AI cites</b><span class="muted">Share of citations</span></div>
        ${types.map((t) => `<div class="hbar"><span class="hb" style="width:${Math.max(30, (100 * t.retr) / max)}%"><span>${esc(t.type)}</span></span><span class="hn">${pct(t.retr / total, 0)}</span></div>`).join("")}</div>
      <div class="card"><div class="card-h"><b>Where you stand by type</b><span class="muted">Pages the agent opened</span></div><table class="tbl"><thead><tr><th>Type</th><th class="r">Cited URLs</th><th class="r">Mention you</th><th class="r">Rivals only</th></tr></thead><tbody>
        ${types.map((t) => `<tr><td>${esc(t.type)}</td><td class="r">${t.urls}</td><td class="r">${t.you || "–"}</td><td class="r">${t.rivalsOnly ? `<span class="pillx no">${t.rivalsOnly}</span>` : "–"}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="segc inl">${["all", ...types.map((t) => t.type)].map((k) => `<button type="button" data-utype="${esc(k)}" aria-pressed="${f === k}">${k === "all" ? `All · ${urls.length}` : esc(k)}</button>`).join("")}</div>
      <div class="card"><table class="tbl"><thead><tr><th>Page</th><th>Type</th><th class="r">Retrievals</th><th class="r">Cited</th><th>You on it</th><th>Rivals on it</th></tr></thead><tbody>
      ${list.slice(0, 150).map((u) => `<tr><td class="pt"><span class="bcell">${favImg(u.domain)}<span><a href="${esc(safeUrl(u.url) || "#")}" target="_blank" rel="noopener"><b>${esc(u.title || u.url)}</b></a><br><span class="muted sm">${esc(u.domain)}</span></span></span></td><td><span class="tagx">${esc(u.type)}</span></td><td class="r">${u.retr}</td><td class="r">${u.cited}</td>
        <td>${u.you == null ? '<span class="muted">not opened</span>' : u.you ? '<span class="pillx ok">Yes</span>' : '<span class="pillx no">No</span>'}</td><td class="muted ell">${esc(u.rivals.slice(0, 3).join(", "))}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No cited pages in this view.</td></tr>'}</tbody></table></div>`;
}

/* ---------- My website: the deeper checks ---------- */
function siteExtra(M) {
  const a = M.audit || {}, pages = a.pages || [], e = M.entity, cf = intData(M, "cloudflare"), bing = intData(M, "bing");
  const fails = {}; pages.forEach((p) => (p.checks || (p.fails || []).map((label) => ({ label, pass: false }))).forEach((c) => { if (!c.pass) fails[c.label] = (fails[c.label] || 0) + 1; }));
  const topFails = Object.entries(fails).sort((x, y) => y[1] - x[1]).slice(0, 8);
  const why = Object.fromEntries(pages.flatMap((p) => (p.checks || []).map((c) => [c.label, c.why])));
  return `<div class="grid2">
    <div class="card"><div class="card-h"><b>Most common page problems</b><span class="muted">${pages.length} pages scored</span></div>
      ${topFails.length ? topFails.map(([l, n]) => `<div class="frow"><div><b>${esc(l)}</b><span class="muted sm">${esc(why[l] || "")}</span></div><span class="pillx ${n === pages.length ? "no" : "warn"}">${n}/${pages.length} pages</span></div>`).join("") : '<p class="muted pad">Every check passes.</p>'}
      ${a.jsOnly ? `<p class="idetail bad pad">${a.jsOnly} page${a.jsOnly === 1 ? "" : "s"} only show their words after JavaScript runs. Most AI crawlers don't run it, so to them these pages are empty. Server-render or pre-render them.</p>` : ""}</div>
    <div class="card"><div class="card-h"><b>Does AI know who you are?</b><span class="muted">Knowledge graphs${e ? ` · ${e.score}/100` : ""}</span><span class="sp"></span><button type="button" class="lnk" data-entity>${e ? "Re-check" : "Check now"}</button></div>
      ${e ? (e.checks || []).map((c) => `<div class="frow"><div><b>${esc(c.label)}</b><span class="muted sm">${esc(c.why || "")}</span></div>${c.pass == null ? '<span class="pillx">n/a</span>' : c.pass ? '<span class="pillx ok">Yes</span>' : '<span class="pillx no">No</span>'}</div>`).join("") : '<p class="muted pad">Checks Wikidata and Google\'s Knowledge Graph, and compares them with the Organization schema on your homepage.</p>'}</div></div>
    <div class="grid2">
    <div class="card"><div class="card-h"><b>AI crawlers visiting</b><span class="muted">${cf ? `Cloudflare · last ${cf.window?.days || 7} days` : "Cloudflare"}</span></div>
      ${cf ? (cf.bots || []).slice(0, 10).map((b) => `<div class="erow"><span class="en">${esc(b.bot || b.name || "")}</span><span class="eb"><i style="width:${Math.round((100 * b.requests) / Math.max(1, cf.bots[0].requests))}%"></i></span><b>${b.requests.toLocaleString()}</b></div>`).join("") || '<p class="muted pad">No AI crawler visits in this window.</p>'
        : `<p class="muted pad">Connect Cloudflare (free) in <button type="button" class="lnk" data-page="settings">Settings</button> to see GPTBot, PerplexityBot, ClaudeBot and others hitting your site, and which pages they read.</p>`}</div>
    <div class="card"><div class="card-h"><b>Bing index</b><span class="muted">ChatGPT search leans on Bing</span></div>
      ${bing?.crawl?.latest ? `<div class="kpis k3 flat"><div class="kpi"><span class="kl">Pages in index</span><span class="kv">${bing.crawl.latest.inIndex.toLocaleString()}</span></div><div class="kpi"><span class="kl">Crawl errors</span><span class="kv">${bing.crawl.latest.crawlErrors}</span></div><div class="kpi"><span class="kl">Blocked by robots</span><span class="kv">${bing.crawl.latest.blockedByRobotsTxt}</span></div></div>`
        : `<p class="muted pad">Connect Bing Webmaster Tools (free) in <button type="button" class="lnk" data-page="settings">Settings</button> to see how much of your site Bing has indexed, and to push new pages to it instantly with IndexNow.</p>`}</div></div>`;
}
const _sitePage = PAGE.site;
PAGE.site = (M, m, pm) => _sitePage(M, m, pm) + siteExtra(M);
$("#reportWrap").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-entity]"); if (!b || !APP.M) return;
  const M = APP.M; b.textContent = "Checking…";
  try { M.entity = await post("/api/entity", { name: M.profile.name, site: M.profile.site, orgSchema: M.audit?.org ?? null }); save(true); } catch (err) { toast(esc(err.message)); }
  dashRender();
});

/* =================================================================== TEAM
   The organisation: people and roles, invites, its own AI keys, the monthly budget and usage, the audit log.
   Operators (the people who run Perfstaq for clients) also create organisations and can open any of them. */
const ROLE_LABEL = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" };
const ROLE_HELP = { admin: "people, keys, integrations, deleting brands", editor: "runs checks, edits prompts, writes drafts", viewer: "sees dashboards and reports, can ask the agent" };
const TEAM = { d: null, audit: null, lastLink: null };
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "–");
const fmtWhen = (d) => (d ? new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");
const usd = (v) => (v == null ? "–" : `$${Number(v).toFixed(2)}`);
/* =================================================================== BILLING + ACCOUNT
   Two screens, on purpose:
   - PLANS & PAYMENT (#billing): only the plans and the payment method. Pick a plan, connect a payment method, change or cancel.
   - ACCOUNT (#account), in the normal app: all the records. Plan and status, usage against the plan (the server's reader compares recorded
     usage with the plan from the database), what is included, and the activity timeline.
   Everything starts with a 7-day free trial and no card. Picking a plan puts the trial on that plan; connecting a payment method during
   the trial costs nothing until it ends, then the plan is charged automatically. The server decides everything; buttons only ask. */
const BILL = { b: null, cat: null, hist: null, admin: null, ccy: null };
const guessCcy = () => (/Kolkata|Calcutta/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || "") ? "INR" : "USD");
const money = (minor, ccy) => new Intl.NumberFormat(undefined, { style: "currency", currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);
// What Razorpay actually charges: the price plus GST for INR (rates from the server), to the paisa.
const taxRate = (ccy) => BILL.cat?.taxRates?.[ccy] || 0;
const charged = (minor, ccy) => Math.round(minor * (1 + taxRate(ccy)));
const moneyExact = (minor, ccy) => new Intl.NumberFormat(undefined, { style: "currency", currency: ccy, minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(minor / 100);
const withGst = (minor, ccy) => taxRate(ccy) ? `${moneyExact(charged(minor, ccy), ccy)} (${money(minor, ccy)} + ${taxRate(ccy) * 100}% GST)` : money(minor, ccy);
const dayDiff = (d) => Math.ceil((new Date(d) - Date.now()) / 864e5);
const SCHED_LABEL = { off: "Manual checks", weekly: "Weekly checks", daily: "Daily checks" };
const INTEG_LABEL = { bing: "Bing", indexnow: "IndexNow", entity: "Entity check", google: "Search Console + GA4", cloudflare: "Cloudflare", slack: "Slack" };
const engLabel = (e) => ENG[e] || ({ claude: "Claude" }[e]) || e;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const planFacts = (e) => [`${plural(e.brands, "brand")}`, `${e.questions} tracked questions`, `${e.competitors} competitors per brand`, `${plural(e.seats, "seat")}`, `${e.drafts} drafted fixes a month`].map((x) => x.replace("null", "Unlimited"));

function billBanners(b) {
  const p = b.plan, out = [], r = b.report, owner = APP.org?.role === "owner" && !APP.org?.operatorVisit;
  const go = owner && !PAY_HIDDEN ? `<button type="button" class="btn sm" data-openbilling>Choose a plan</button>` : ""; // PAY_HIDDEN: no plan button
  const add = (tone, title, text, acts = "") => out.push(`<div class="bl-banner ${tone}"><div class="tx"><b>${title}</b><span>${text}</span></div><div class="acts">${acts}</div></div>`);
  if (b.mode === "read" && p.status === "trialing") add("bad", "Your trial has ended", "New checks, drafts, edits and invites are paused. Your reports stay readable. Choose a plan to carry on.", go);
  else if (b.mode === "read" && p.status === "past_due") add("bad", "Payment failed: the organisation is read-only", "Razorpay emailed the owner a link to fix it. You can also start again with a new plan; the old subscription is cancelled once the new one is confirmed.", owner ? `<button type="button" class="btn ghost sm" data-paylink>Find payment link</button>${go}` : "");
  else if (b.mode === "read") add("bad", "This organisation is read-only", "The plan has ended. Your reports stay readable. Choose a plan to carry on.", go);
  else if (b.mode === "manual") add("warn", "Your last payment failed", `People can keep working, but scheduled checks are paused. Fix it by ${fmtDay(b.graceEndsAt)} to avoid read-only mode.`, owner ? `<button type="button" class="btn ghost sm" data-paylink>Find payment link</button>` : "");
  else if (p.status === "trialing") { const n = dayDiff(b.trialEndsAt); if (n <= 3) add("warn", `Your trial ends ${n <= 0 ? "today" : n === 1 ? "tomorrow" : "in " + n + " days"}`, "Choose a plan before then to keep running checks.", go); }
  if (p.status === "active" && p.cancelAtPeriodEnd) add("info", `Your subscription ends on ${fmtDay(b.periodEnd)}`, "You keep full access until then. Subscribe again any time to carry on.", owner ? `<button type="button" class="btn sm" data-openbilling>Choose a plan</button>` : "");
  if (p.pendingPlan) { const n = BILL.cat?.plans.find((x) => x.code === p.pendingPlan)?.name || p.pendingPlan; add("info", `Moving to ${esc(n)} on ${fmtDay(b.periodEnd)}`, `You keep ${esc(p.name)} until then.`, owner ? `<button type="button" class="btn ghost sm" data-change="${esc(p.code)}">Keep ${esc(p.name)}</button>` : ""); }
  if (r.over.length) add("warn", `You're over your plan's limit on ${r.over.map((k) => r.metrics.find((m) => m.key === k).label.toLowerCase()).join(", ")}`, "Nothing has been deleted. You can't add more until you're back within the limit.", "");
  if (r.ai?.state === "over") add("bad", "This period's AI allowance is used up", `AI checks are paused until ${b.report.period.end ? fmtDay(b.report.period.end) : "the next period"}. Upgrade for a larger allowance.`, go);
  return out.length ? `<div class="bl-banners">${out.join("")}</div>` : "";
}
function billStatus(b) {
  const p = b.plan;
  if (p.status === "internal") return ["Included", ""];
  if (p.status === "new") return ["No plan yet", "warn"];
  if (p.status === "trialing") return b.mode === "write" ? [`Trial · ${Math.max(0, dayDiff(b.trialEndsAt))} days left`, "info"] : ["Trial ended", "bad"];
  if (p.status === "active") return p.cancelAtPeriodEnd ? [`Ends ${fmtDay(b.periodEnd)}`, "warn"] : ["Active", "good"];
  if (p.status === "past_due") return [b.mode === "manual" ? "Payment failed" : "Payment failed · read-only", b.mode === "manual" ? "warn" : "bad"];
  return ["Ended", "bad"];
}
const planName = (c) => BILL.cat?.plans.find((x) => x.code === c)?.name || c;
// The plan, shown one way everywhere (plans page, account page, team page): what you're on, what it costs with GST, what happens
// next, and only the actions that make sense right now. `where` trims it: the plans page has the plans below it, the team page is compact.
function planPanel(b, owner, where = "account") {
  const p = b.plan, [label, tone] = billStatus(b), ccy = p.currency || BILL.ccy, cat = BILL.cat?.plans.find((x) => x.code === p.code);
  const price = cat?.prices?.[ccy], pm = b.paymentMethod, chosen = b.trialChosen, total = price != null ? moneyExact(charged(price, ccy), ccy) : "";
  const name = p.status === "new" ? "No plan yet" : p.status === "trialing" ? "Free trial" : p.name;
  const desc = p.status === "new" ? (b.trialAvailable ? `Pick a plan to start your ${BILL.cat?.trialDays || 7}-day free trial. No card needed.` : "Your free trial has been used. Choose a plan to subscribe.")
    : trialDone(b) && !pm.connected ? "Your free trial check is done. Subscribe and your plan starts today."
    : p.status === "trialing" && PAY_HIDDEN ? `Your free trial runs until ${fmtDay(b.trialEndsAt)}.` // PAY_HIDDEN: no "pick a plan" wording
    : p.status === "trialing" ? (chosen ? `The same trial for every plan. ${p.name} starts when it ends, on ${fmtDay(b.trialEndsAt)}.` : "The same trial for every plan. Pick the plan that starts after it.") : p.description || "";
  const priceHtml = ["active", "past_due"].includes(p.status) && price != null ? `<b>${esc(total)}</b><span>a month${taxRate(ccy) ? ` · ${esc(money(price, ccy))} + ${taxRate(ccy) * 100}% GST` : ""}</span>`
    : p.status === "trialing" ? `<b>Free</b><span>until ${esc(fmtDay(b.trialEndsAt))}${chosen && total && !PAY_HIDDEN /* PAY_HIDDEN: no price after the trial */ ? `, then ${esc(total)} a month incl. GST` : ""}</span>`
    : p.status === "internal" ? `<b>Included</b><span>no charge</span>` : "";
  const meta = [];
  // PAY_HIDDEN: the payment-method and first-charge rows are left out.
  if (p.status === "trialing") meta.push(["Trial ends", fmtDay(b.trialEndsAt)], ...(chosen ? [["Then", p.name]] : []), ...(PAY_HIDDEN ? [] : [["Payment method", pm.connected ? "Connected" : "Not connected", pm.connected ? "good" : "warn"]]));
  if (p.status === "trialing" && pm.connected && !PAY_HIDDEN) meta.push(["First charge", fmtDay(pm.firstChargeAt || b.trialEndsAt)]);
  // Active without a subscription: assigned by the team, or a month paid once. Nothing renews, so no next charge or payment method.
  const renews = !!pm.connected;
  if (p.status === "active") meta.push(renews ? [p.cancelAtPeriodEnd ? "Access until" : "Next charge", fmtDay(b.periodEnd)] : [p.oneTime ? "Paid until" : "Active until", fmtDay(b.periodEnd)], ...(PAY_HIDDEN || !renews ? [] : [["Payment method", "Connected", "good"]]));
  if (p.pendingPlan) meta.push([`From ${fmtDay(b.periodEnd)}`, planName(p.pendingPlan)]);
  if (p.status === "past_due") meta.push(["Fix by", fmtDay(b.graceEndsAt), "bad"]);
  if (p.status === "canceled") meta.push(["Ended", fmtDay(b.periodEnd)]);
  const A = [], L = [];
  if (!owner) L.push(`<span class="muted sm">Only the owner can change the plan.</span>`);
  else {
    if (p.status === "trialing" && chosen && !pm.connected && b.checkout.enabled && !PAY_HIDDEN) A.push(`<button class="btn" type="button" data-buy="${esc(p.code)}">${icon("card", 15)} ${trialDone(b) ? `Subscribe to ${esc(p.name)}` : "Connect payment method"}</button>`);
    if (p.status === "active" && p.cancelAtPeriodEnd) A.push(`<button class="btn" type="button" data-buy="${esc(p.code)}">Keep my subscription</button>`);
    if (p.status === "active" && p.pendingPlan) A.push(`<button class="btn ghost" type="button" data-change="${esc(p.code)}">Keep ${esc(p.name)}</button>`);
    if (p.status === "past_due") A.push(`<button class="btn" type="button" data-paylink>Fix payment</button>`);
    if (where === "plans") { if (p.status === "active" && !p.cancelAtPeriodEnd) A.push(`<button class="btn ghost" type="button" data-scrollplans>Change plan</button>`); }
    else if (!PAY_HIDDEN) A.push(`<button class="btn${A.length ? " ghost" : ""}" type="button" data-openbilling>${p.status === "new" ? "Choose a plan" : "Plans & payment"}</button>`); // PAY_HIDDEN: no link to the payment page
    if (p.status === "trialing" && pm.connected && !PAY_HIDDEN) L.push(`<button class="lnk" type="button" data-rmpay>Remove payment method</button>`);
    if (p.status === "trialing") L.push(`<button class="lnk danger" type="button" data-canceltrial>Cancel free trial</button>`);
    if (p.status === "active" && !p.cancelAtPeriodEnd && renews) L.push(`<button class="lnk" type="button" data-billrefresh>Check with Razorpay</button>`, `<button class="lnk danger" type="button" data-cancelsub>Cancel subscription</button>`);
  }
  const metaHtml = meta.length ? `<dl class="bl-meta">${meta.map(([k, v, t]) => `<div><dt>${esc(k)}</dt><dd${t ? ` class="${t}"` : ""}>${t ? `<i></i>` : ""}${esc(v)}</dd></div>`).join("")}</dl>` : "";
  return `<section class="bl-card bl-plan pp-${where}"><div class="bl-plan-top"><div><span class="bl-kicker">Current plan</span><h2>${esc(name)}</h2>${where === "team" ? "" : `<p class="desc">${esc(desc)}</p>`}</div><span class="bl-status ${tone}">${esc(label)}</span></div>
    ${priceHtml ? `<div class="bl-price">${priceHtml}</div>` : ""}${metaHtml}${A.length || L.length ? `<div class="bl-actions">${A.join("")}${L.length ? `<span class="sp"></span>${L.join("")}` : ""}</div>` : ""}</section>`;
}
function billIncluded(b) {
  const f = b.report.features, all = Object.keys(INTEG_LABEL);
  const chips = (list, label, off = []) => `<div class="bl-chips">${list.map((x) => `<span class="bl-chip">${esc(label(x))}</span>`).join("")}${off.map((x) => `<span class="bl-chip off">${esc(label(x))}</span>`).join("")}</div>`;
  const engines = ["chatgpt", "perplexity", "gemini", "aio", "aimode", "claude", "groq"];
  const ints = f.integrations === "all" ? all : f.integrations;
  return `<section class="bl-card bl-inc"><h3>What's included</h3>
    <div class="bl-grp"><span>AI engines</span>${chips(f.engines, engLabel, engines.filter((e) => !f.engines.includes(e)))}</div>
    <div class="bl-grp"><span>Checks</span>${chips(f.schedules, (s) => SCHED_LABEL[s] || s, ["weekly", "daily"].filter((s) => !f.schedules.includes(s)))}</div>
    <div class="bl-grp"><span>Integrations</span>${ints.length ? chips(ints, (i) => INTEG_LABEL[i] || i, all.filter((i) => !ints.includes(i))) : `<span class="muted sm">None on this plan</span>`}</div>
    <div class="bl-facts"><span><b>${f.competitors ?? "Unlimited"}</b> competitors per brand</span><span><b>${f.samples ?? "Unlimited"}</b> sample${f.samples === 1 ? "" : "s"} per question</span></div></section>`;
}
function billUsage(b) {
  const r = b.report, per = r.period;
  const resets = per.kind === "trial" ? `Trial ends ${fmtDay(per.end)}` : per.kind === "plan" ? `Resets ${fmtDay(per.end)}` : `Resets ${fmtDay(per.end)}`;
  const tile = (m) => {
    const num = `<div class="bl-num"><b>${m.used}</b><span>${m.limit === null ? "Unlimited" : `of ${m.limit}`}</span></div>`;
    const bar = m.limit === null ? "" : `<div class="bl-bar" role="progressbar" aria-label="${esc(m.label)}" aria-valuemin="0" aria-valuemax="${m.limit}" aria-valuenow="${Math.min(m.used, m.limit)}"><i style="width:${Math.round(m.pct * 100)}%"></i></div>`;
    const foot = m.state === "over" ? `${m.used - m.limit} over the limit` : m.state === "full" ? "Limit reached" : m.limit === null ? esc(m.note) : `${m.remaining} left · ${esc(m.note)}`;
    return `<div class="bl-card bl-tile ${m.state}"><div class="bl-tile-h"><span>${esc(m.label)}</span><em>${m.scope === "period" ? "this period" : "right now"}</em></div>${num}${bar}<div class="bl-tile-f">${foot}</div></div>`;
  };
  const ai = r.ai && r.ai.pct != null ? `<div class="bl-card bl-tile ${r.ai.state === "over" ? "over" : r.ai.state === "warn" ? "warn" : ""}"><div class="bl-tile-h"><span>AI allowance</span><em>this period</em></div><div class="bl-num"><b>${Math.round(r.ai.pct * 100)}%</b><span>used</span></div><div class="bl-bar" role="progressbar" aria-label="AI allowance" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(r.ai.pct * 100)}"><i style="width:${Math.round(r.ai.pct * 100)}%"></i></div><div class="bl-tile-f">${r.ai.state === "over" ? "Used up: AI checks are paused" : `${100 - Math.round(r.ai.pct * 100)}% left · checks, engines and writing`}</div></div>` : "";
  return `<div class="bl-sec-h"><h2>Usage</h2><span class="muted">${esc(resets)}</span></div><div class="bl-usage">${r.metrics.map(tile).join("")}${ai}</div>`;
}
const HIST = { "billing.updated": ["Plan changed", "good"], "billing.onetime_paid": ["One month paid", "good"], "billing.onetime_link_sent": ["Payment link sent", "info"], "billing.link_sent": ["Payment link sent", "info"], "billing.checkout_started": ["Started connecting a payment method", "info"], "billing.payment_verified": ["Payment method verified", "good"], "billing.payment_confirmed": ["Confirmed with Razorpay", "good"], "billing.authenticated": ["Payment method connected", "good"], "billing.trial_plan_chosen": ["Trial plan chosen", "info"], "billing.payment_method_removed": ["Payment method removed", "warn"], "billing.activated": ["Subscription started", "good"], "billing.charged": ["Payment received", "good"],
  "billing.pending": ["A payment failed", "bad"], "billing.halted": ["Payments stopped after retries", "bad"], "billing.paused": ["Subscription paused", "warn"], "billing.cancelled": ["Subscription ended", "warn"], "billing.completed": ["Subscription completed", "warn"], "billing.resumed": ["Subscription resumed", "good"],
  "billing.cancel_requested": ["Cancellation requested", "warn"], "billing.upgrade_requested": ["Upgrade requested", "info"], "billing.downgrade_scheduled": ["Downgrade scheduled", "info"], "billing.downgrade_withdrawn": ["Downgrade withdrawn", "info"], "billing.reconciled": ["Synced with Razorpay", ""], "billing.operator_set": ["Plan set by Perfstaq", "info"] };
function billHistory() {
  if (!BILL.hist) return "";
  const rows = BILL.hist.map((e) => { const [t, tone] = HIST[e.action] || [e.action.replace("billing.", "").replace(/_/g, " "), ""], d = e.detail || {};
    const planName = (c) => BILL.cat?.plans.find((x) => x.code === c)?.name, sub = [planName(e.target) ? esc(planName(e.target)) : "", d.to?.plan && d.to.plan !== e.target && planName(d.to.plan) ? `now ${esc(planName(d.to.plan))}` : "", d.reason ? esc(d.reason) : "", e.who ? `by ${esc(e.who)}` : ""].filter(Boolean).join(" · ");
    return `<li class="${tone}"><span class="w">${esc(t)}${sub ? `<small>${sub}</small>` : ""}</span><time datetime="${esc(e.at)}">${esc(fmtWhen(e.at))}</time></li>`; });
  return `<div class="bl-sec-h"><h2>Activity</h2><span class="muted">Plan and payment events</span></div><section class="bl-card">${rows.length ? `<ul class="bl-tl">${rows.join("")}</ul>` : `<div class="bl-empty">Nothing yet. Plan changes and payments will show up here.</div>`}</section>`;
}


/* ---- the payment page: plans and the payment method, nothing else ---- */
function payPlans(b, owner) {
  const cat = BILL.cat, p = b.plan, locked = !!p.currency, ccy = locked ? p.currency : BILL.ccy, open = b.checkout.enabled;
  // Monthly or annual: offered when some plan has a yearly price in this currency; a paying subscription keeps its own cycle.
  const annualOn = cat.plans.some((x) => x.annualPrices?.[ccy] != null), cyc = locked && p.status === "active" ? p.cycle || "monthly" : annualOn ? BILL.cycle || "monthly" : "monthly";
  const priceOf = (x) => (cyc === "annual" ? x.annualPrices?.[ccy] : x.prices[ccy]);
  const trialing = p.status === "trialing", connected = b.paymentMethod.connected, chosen = b.trialChosen, subscribed = p.status === "active" && !p.cancelAtPeriodEnd;
  const cur = cat.plans.find((x) => x.code === p.code);
  const cycSeg = annualOn && !(locked && p.status === "active") ? `<div class="bl-seg" role="group" aria-label="Billing">${[["monthly", "Monthly"], ["annual", "Annual"]].map(([v, l]) => `<button type="button" data-cycle="${v}" aria-pressed="${v === cyc}">${l}</button>`).join("")}</div>` : locked && p.status === "active" && annualOn ? `<span class="muted">Billed ${cyc === "annual" ? "yearly" : "monthly"}</span>` : "";
  const seg = cycSeg + (locked ? `<span class="muted">Billed in ${esc(ccy)}</span>` : cat.currencies.length > 1 ? `<div class="bl-seg" role="group" aria-label="Currency">${cat.currencies.map((c) => `<button type="button" data-ccy="${esc(c)}" aria-pressed="${c === ccy}">${esc(c)}</button>`).join("")}</div>` : "");
  const card = (x) => {
    const price = priceOf(x), avail = (cyc === "annual" ? cat.availableAnnual?.[x.code]?.[ccy] : cat.available?.[x.code]?.[ccy] !== false) && price != null, mine = x.code === p.code && (subscribed || (trialing && chosen));
    const up = price > ((cur && priceOf(cur)) || 0), td = x.trialDays ?? cat.trialDays ?? 7; let action;
    if (!x.selfServe) action = cat.contact ? `<a class="btn ghost" href="mailto:${esc(cat.contact)}?subject=${encodeURIComponent("Perfstaq " + x.name)}">Talk to us</a>` : `<div class="bl-pill">Talk to us</div>`;
    else if (!owner) action = `<div class="bl-pill">${mine ? "Your plan" : "Ask the owner"}</div>`;
    else if (!open && !(trialing && !connected)) action = `<div class="bl-pill">${mine ? "Your plan" : "Opening soon"}</div>`;
    else if (p.status === "new") action = b.trialAvailable && td > 0
      ? `<button type="button" class="btn ${x.featured ? "" : "ghost"}" data-trial="${esc(x.code)}">Start ${esc(String(td))}-day free trial</button>`
      : avail ? `<button type="button" class="btn ${x.featured ? "" : "ghost"}" data-buy="${esc(x.code)}">Subscribe to ${esc(x.name)}</button>` : `<div class="bl-pill">Not available yet</div>`;
    else if (trialing && trialDone(b) && !connected) action = avail && open ? `<button type="button" class="btn ${mine || (x.featured && !chosen) ? "" : "ghost"}" data-buy="${esc(x.code)}">Subscribe to ${esc(x.name)}</button>` : `<div class="bl-pill">Not available yet</div>`;
    else if (trialing) {
      if (mine && connected) action = `<div class="bl-pill">Connected · first charge ${esc(fmtDay(b.trialEndsAt))}</div>`;
      else if (mine) action = avail && open ? `<button type="button" class="btn" data-buy="${esc(x.code)}">Start ${esc(x.name)} now</button>` : `<div class="bl-pill">Starts after your trial · ${esc(fmtDay(b.trialEndsAt))}</div>`;
      else if (connected) action = avail && open ? `<button type="button" class="btn ghost" data-buy="${esc(x.code)}">Switch and reconnect</button>` : `<div class="bl-pill">Not available yet</div>`;
      else if (td === 0) action = avail && open ? `<button type="button" class="btn ghost" data-buy="${esc(x.code)}">Subscribe to ${esc(x.name)}</button>` : `<div class="bl-pill">No free trial</div>`;
      else action = `<button type="button" class="btn ${x.featured && !chosen ? "" : "ghost"}" data-trial="${esc(x.code)}">${chosen ? `Switch to ${esc(x.name)}` : `Start ${esc(String(td))}-day free trial`}</button>`;
    }
    else if (p.pendingPlan === x.code) action = `<div class="bl-pill">Starts ${esc(fmtDay(b.periodEnd))}</div>`;
    else if (!avail) action = `<div class="bl-pill">Not available in ${esc(ccy)} yet</div>`;
    else if (mine && p.pendingPlan) action = `<button type="button" class="btn ghost" data-change="${esc(x.code)}">Keep ${esc(x.name)}</button>`;
    else if (mine) action = `<div class="bl-pill">Your plan</div>`;
    else if (subscribed) action = `<button type="button" class="btn ${up ? "" : "ghost"}" data-change="${esc(x.code)}">${up ? "Upgrade" : "Downgrade"}</button>`;
    else action = `<button type="button" class="btn ${x.featured ? "" : "ghost"}" data-buy="${esc(x.code)}">Subscribe to ${esc(x.name)}</button>`;
    const noUpi = x.selfServe && ccy === "INR" && price > 0 && (cyc === "annual" || (cat.upiMax && charged(price, ccy) > cat.upiMax));
    const saving = cyc === "annual" && price > 0 && x.prices[ccy] > 0 ? Math.round((1 - price / (x.prices[ccy] * 12)) * 100) : 0;
    const priceHtml = (!x.selfServe && !(price > 0) ? `<b>Custom</b>` : price != null ? `<b>${esc(money(price, ccy))}</b><span>/ ${cyc === "annual" ? "year" : "month"}${ccy === "INR" ? " + GST" : ""}</span>` : cyc === "annual" ? `<b>–</b><span>monthly only</span>` : `<b>–</b>`)
      + (saving > 0 ? `<em class="bl-save">${esc(money(Math.round(price / 12), ccy))} / month · save ${saving}%</em>` : "");
    const upiNote = noUpi ? `<p class="muted sm" style="margin:-4px 0 0">Card or net banking (no UPI)</p>` : "";
    return `<article class="bl-card bl-pc ${mine ? "cur" : ""} ${x.featured ? "feat" : ""}">${x.featured ? '<span class="badge">Most popular</span>' : ""}<h3>${esc(x.name)}</h3><p class="pd">${esc(x.description || "")}</p><div class="pr">${priceHtml}</div>${upiNote}
      <ul>${planFacts(x.entitlements).map((l) => `<li>${esc(l)}</li>`).join("")}<li>${esc(x.entitlements.engines.length > 3 ? "All AI engines" : x.entitlements.engines.map(engLabel).join(", "))}</li></ul>${action}</article>`;
  };
  return `<div class="bl-sec-h" id="billPlans"><h2>Plans</h2>${seg}</div><div class="bl-plans">${cat.plans.map(card).join("")}</div>`;
}
function paintBilling(opts = {}) {
  const b = BILL.b, owner = APP.org?.role === "owner" && !APP.org?.operatorVisit, first = opts.firstRun !== undefined ? opts.firstRun : BILL.first;
  BILL.first = first;
  const fresh = b.plan.status === "new";
  const head = first ? `<div class="bl-hero-t"><span class="bl-kicker">Welcome to Perfstaq</span><h1>${fresh && !b.trialAvailable ? "Choose your plan" : `Start your ${BILL.cat.trialDays}-day free trial`}</h1><p>${fresh && !b.trialAvailable ? "Your free trial has been used. Pick the plan that fits and subscribe." : `Everyone gets the same free trial: ${BILL.cat.trialDays} days, 20 prompts, no card. Pick the plan that starts after it, and add a payment method any time before then.`}</p></div>`
    : `<div class="bl-head"><div><span class="bl-kicker">${esc(APP.org?.name || "Organisation")}</span><h1>Plans &amp; payment</h1></div><button type="button" class="btn ghost sm" data-openaccount>Usage &amp; records</button></div>`;
  $("#billBody").innerHTML = `${head}${first && fresh ? "" : planPanel(b, owner, "plans")}${payPlans(b, owner)}
    ${first && !fresh ? `<div class="bl-first-f"><button type="button" class="btn ${b.trialChosen ? "" : "ghost"}" data-skipfirst>${!b.trialChosen ? "Skip for now" : DATA.list.length ? "Continue to the dashboard" : "Add your first website"}</button></div>` : ""}`;
  billHint(b);
}
// What used to be a paragraph under the plans is now said once, as a toast, when it matters (once per session and state).
function billHint(b) {
  const p = b.plan, pm = b.paymentMethod; let key = "", msg = "", tone = "info";
  if (trialDone(b) && !pm.connected) { key = "trial-done"; msg = "Your free trial check is done. Subscribe to run your prompts again: your plan starts today."; }
  else if (p.status === "trialing" && b.trialChosen && !pm.connected) { key = "trial-nocard"; msg = `Free until ${esc(fmtDay(b.trialEndsAt))}. Connect a payment method before then so ${esc(p.name)} carries on without a break.`; }
  else if (p.status === "trialing" && pm.connected) { key = "trial-card"; msg = `You're all set. Nothing is charged until ${esc(fmtDay(b.trialEndsAt))}.`; tone = "ok"; }
  else if (p.status === "active" && p.cancelAtPeriodEnd) { key = "ending"; msg = `Your subscription ends on ${esc(fmtDay(b.periodEnd))}. You keep full access until then.`; tone = "warn"; }
  else if (p.status === "past_due") { key = "pastdue"; msg = `Your last payment didn't go through. Fix it by ${esc(fmtDay(b.graceEndsAt))} to keep everything running.`; tone = "bad"; }
  if (!key) return;
  const k = `wp_hint_${key}_${APP.org?.id || ""}`; try { if (sessionStorage.getItem(k)) return; } catch {}
  setTimeout(() => { if ($(".toast") || $("#billing").hidden) return; try { sessionStorage.setItem(k, "1"); } catch {} toast(msg, tone); }, 400);
}
async function loadBill(extra = {}) {
  [BILL.b, BILL.cat] = await Promise.all([api("GET", "/api/billing"), fetch("/api/billing/plans").then((r) => r.json())]);
  BILL.ccy = BILL.ccy || guessCcy(); if (!BILL.cat.currencies.includes(BILL.ccy)) BILL.ccy = BILL.cat.currencies[0];
  if (extra.history) BILL.hist = canAdmin() ? (await api("GET", "/api/billing/history")).events : null;
}
async function openBilling(opts = {}) {
  if (!billingOn()) return home();
  if (PAY_HIDDEN) return openAccount(); // PAY_HIDDEN: the plans/payment page is hidden; anything that opens it lands on Account & usage
  screen("billing"); paintProfile();
  $("#billBody").innerHTML = `<p class="muted pad">Loading…</p>`;
  try { await loadBill(); } catch (e) { $("#billBody").innerHTML = `<p class="err pad">${esc(e.message)}</p>`; return; }
  paintBilling({ firstRun: !!opts.firstRun });
}
/* ---- the account page: the records ---- */
async function openAccount() {
  if (!billingOn()) return home();
  screen("account"); paintProfile();
  $("#accBody").innerHTML = `<p class="muted pad">Loading…</p>`;
  try { await loadBill({ history: true }); } catch (e) { $("#accBody").innerHTML = `<p class="err pad">${esc(e.message)}</p>`; return; }
  const b = BILL.b, owner = APP.org?.role === "owner" && !APP.org?.operatorVisit;
  $("#accBody").innerHTML = `<div class="bl-head"><div><span class="bl-kicker">${esc(APP.org?.name || "Organisation")}</span><h1>Account &amp; usage</h1></div></div>
    ${billBanners(b)}<div class="bl-hero">${planPanel(b, owner, "account")}${billIncluded(b)}</div>${billUsage(b)}${billHistory()}`;
}
/* ---- shared actions (payment page, account page, team page) ---- */
async function billAction(t) {
  if (t.closest("[data-openbilling]")) { await openBilling(); return true; }
  if (t.closest("[data-openaccount]")) { await openAccount(); return true; }
  const cc = t.closest("[data-ccy]"); if (cc) { BILL.ccy = cc.dataset.ccy; paintBilling(); return true; }
  const cy = t.closest("[data-cycle]"); if (cy) { BILL.cycle = cy.dataset.cycle; paintBilling(); return true; }
  const tr = t.closest("[data-trial]"); if (tr) { await chooseTrialPlan(tr.dataset.trial); return true; }
  const buy = t.closest("[data-buy]"); if (buy) { await buyPlan(buy.dataset.buy); return true; }
  const chg = t.closest("[data-change]"); if (chg) { await changePlan(chg.dataset.change); return true; }
  if (t.closest("[data-cancelsub]")) { await cancelSub(); return true; }
  if (t.closest("[data-canceltrial]")) { await cancelTrial(); return true; }
  if (t.closest("[data-rmpay]")) { await removePaymentMethod(); return true; }
  if (t.closest("[data-billrefresh]")) { await api("POST", "/api/billing/refresh"); await openBilling({ firstRun: BILL.first }); toast("Up to date with Razorpay.", "ok"); return true; }
  if (t.closest("[data-scrollplans]")) { $("#billPlans")?.scrollIntoView({ behavior: "smooth", block: "start" }); return true; }
  if (t.closest("[data-paylink]")) { const r = await api("GET", "/api/billing/payment-link"); r.url ? window.open(r.url, "_blank", "noopener") : toast("No link is available from here. Check the email Razorpay sent, or choose a plan above to start again."); return true; }
  if (t.closest("[data-skipfirst]")) { try { sessionStorage.setItem("wp_skip_plan", "1"); } catch {} await home(); if (!DATA.list.length) $("#startUrl")?.focus(); return true; }
  return false;
}
async function chooseTrialPlan(plan) {
  const b = await api("POST", "/api/billing/start-trial", { plan });
  BILL.b = b; await loadBill(); paintBilling(); toast(`Your free trial runs until ${esc(fmtDay(b.trialEndsAt))}. <b>${esc(planName(plan))}</b> starts after it.`, "ok");
  APP.cfg.billing = BILL.b; paintTrialPill();
}
// An in-app confirm instead of the browser's: resolves true on the main button, false on Cancel, Escape or a click outside.
// `body` is HTML, so the caller escapes anything that came from outside. Fields with a name come back as { name: value } on confirm.
function confirmBox({ title, body = "", ok = "Confirm", cancel = "Cancel", danger = false, icon: ic = "", tone = "", safe = false, sub = "" }) {
  return new Promise((res) => {
    const m = document.createElement("div"); m.className = "modal light cbox";
    const yes = `<button class="btn${danger ? " danger" : ""}${safe ? " ghost" : ""}" type="button" data-y>${esc(ok)}</button>`, no = cancel ? `<button class="btn${safe ? "" : " ghost"}" type="button" data-n>${esc(cancel)}</button>` : "";
    m.innerHTML = `<div class="box sheet ${tone ? "s-" + tone : ""}" role="alertdialog" aria-modal="true" aria-labelledby="askT">${ic ? `<span class="sh-ic" aria-hidden="true">${icon(ic, 20)}</span>` : ""}<div class="sh-t"><h3 id="askT">${esc(title)}</h3>${sub ? `<p>${sub}</p>` : ""}</div><div class="sh-b">${body}</div><div class="sh-f">${safe ? `${yes}${no}` : `${no}${yes}`}</div></div>`;
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
    const done = (v) => { const f = Object.fromEntries([...m.querySelectorAll("[name]")].map((i) => [i.name, i.value.trim()])); document.removeEventListener("keydown", key, true); m.remove(); res(v && f); };
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-n]")) done(false); else if (e.target.closest("[data-y]")) done(true); });
    document.addEventListener("keydown", key, true); document.body.append(m); (m.querySelector("[name]") || m.querySelector("[data-y]")).focus();
  });
}
const PLANS_LABEL = (c) => ({ legacy: "Legacy (unlimited, no billing)", trial: "Trial" })[c] || (c[0].toUpperCase() + c.slice(1));
const field = (label, input) => `<label style="display:grid;gap:4px;margin-top:10px"><span class="muted sm">${label}</span>${input}</label>`;
// Building blocks for the plan sheets: before → after, what happens when, and the money.
const shCompare = (a, b) => `<div class="sh-cmp"><div><span>${esc(a.k)}</span><b>${esc(a.name)}</b><em>${a.price}</em></div><i aria-hidden="true">${icon("arrow", 16)}</i><div class="to"><span>${esc(b.k)}</span><b>${esc(b.name)}</b><em>${b.price}</em></div></div>`;
const shSteps = (rows) => `<ol class="sh-steps">${rows.map(([when, what, t = ""]) => `<li class="${t}"><b>${esc(when)}</b><span>${what}</span></li>`).join("")}</ol>`;
const shMoney = (minor, ccy, per = "month") => `<dl class="sh-money">${taxRate(ccy) ? `<div><dt>Plan price</dt><dd>${esc(money(minor, ccy))}</dd></div><div><dt>GST ${taxRate(ccy) * 100}%</dt><dd>${esc(moneyExact(charged(minor, ccy) - minor, ccy))}</dd></div>` : ""}<div class="t"><dt>Every ${per}</dt><dd>${esc(moneyExact(charged(minor, ccy), ccy))}</dd></div></dl>`;
const perMonth = (minor, ccy) => `${esc(moneyExact(charged(minor, ccy), ccy))}<small>/mo</small>`;
const askList = (items) => `<ul style="margin:8px 0 0;padding-left:18px">${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
async function removePaymentMethod() {
  const b = BILL.b;
  if (!(await confirmBox({ title: "Remove your payment method?", icon: "card", tone: "warn", ok: "Remove it", cancel: "Keep it", danger: true, safe: true, sub: "Nothing has been charged, and nothing will be.",
    body: shSteps([["Now", "Your trial carries on as it is."], [fmtDay(b.trialEndsAt), "Without a payment method the account becomes read-only. Your reports stay readable.", "warn"]]) }))) return;
  await api("POST", "/api/billing/remove-payment-method"); await loadBill(); paintBilling(); toast("Payment method removed. You can connect one again any time.", "info");
}
$("#billing").addEventListener("click", async (e) => { try { await billAction(e.target); } catch (err) { toast(esc(err.message), "bad"); } });
$("#account").addEventListener("click", async (e) => { try { await billAction(e.target); } catch (err) { toast(esc(err.message), "bad"); } });
$("#navBilling").addEventListener("click", () => openBilling());
$("#navAccount").addEventListener("click", () => openAccount());
$("#billBack").addEventListener("click", () => backFromSide());
$("#accBack").addEventListener("click", () => backFromSide());


/* The profile menu, top right on every screen: who you are, your plan and where it stands, and the account pages. It replaces
   the separate trial pill, Account and Team buttons and the email, so the corner always looks the same. */
const initialsOf = (s) => (String(s).trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
function planLine(b) {
  if (!b || !billingOn() || (b.plan.status === "internal" && !b.checkout?.enabled)) return { text: APP.org?.name || "", tone: "", cta: "" };
  // An organisation from before paid plans (no limits), now able to buy one.
  if (b.plan.status === "internal") return { text: "Legacy plan", tone: "", cta: "Choose a plan", detail: "Made before paid plans: no limits, no charge." };
  const p = b.plan, n = Math.max(0, dayDiff(b.trialEndsAt)), name = b.trialChosen ? p.name : "Free trial";
  if (p.status === "new") return { text: "Choose a plan", tone: "warn", cta: "Choose a plan", detail: b.trialAvailable ? `Start your ${BILL.cat?.trialDays || 7}-day free trial.` : "Your free trial has been used." };
  if (b.mode === "read") return { text: p.status === "trialing" ? "Trial ended" : "Payment needed", tone: "bad", cta: "Choose a plan", detail: "Reports stay readable. Pick a plan to carry on." };
  if (p.status === "past_due") return { text: "Payment failed", tone: "bad", cta: "Fix payment", detail: `Fix it by ${fmtDay(b.graceEndsAt)} to keep everything running.` };
  // PAY_HIDDEN: the trial line has no plan/payment button and no "pick a plan" wording.
  if (p.status === "trialing" && PAY_HIDDEN) return { text: `Free trial · ${n} day${n === 1 ? "" : "s"} left`, tone: n <= 2 ? "warn" : "info", cta: "", detail: `Free until ${fmtDay(b.trialEndsAt)}.` };
  if (p.status === "trialing") return { text: `Free trial · ${n} day${n === 1 ? "" : "s"} left`, tone: n <= 2 ? "warn" : "info", cta: !b.trialChosen ? "Choose a plan" : b.paymentMethod.connected ? "Manage plan" : "Add payment method",
    detail: !b.trialChosen ? `Free until ${fmtDay(b.trialEndsAt)}. Pick the plan that starts after.` : `${p.name} starts ${fmtDay(b.trialEndsAt)}.${b.paymentMethod.connected ? "" : " No card yet."}` };
  if (p.status === "active") return p.cancelAtPeriodEnd ? { text: `${p.name} · ends ${fmtDay(b.periodEnd)}`, tone: "warn", cta: "Keep my plan", detail: `Full access until ${fmtDay(b.periodEnd)}.` }
    : b.paymentMethod?.connected ? { text: p.name, tone: "good", cta: "Manage plan", detail: `Next charge ${fmtDay(b.periodEnd)}.` }
    // Assigned by the team (no card) or a one-time month: nothing renews, so say until when it runs.
    : { text: p.name, tone: "good", cta: "", detail: b.periodEnd ? `${b.plan.oneTime ? "Paid for one month" : "Active"} until ${fmtDay(b.periodEnd)}. It doesn't renew by itself.` : "Active." };
  return { text: p.name, tone: "", cta: "Manage plan", detail: "" };
}
function paintProfile() {
  paintAccount();
  const slots = ["#lpUser", "#teamUser", "#billUser", "#accUser", "#obProfile", "#readyProfile"].map((s) => $(s)).filter(Boolean);
  if (!DATA.server()) { slots.forEach((el) => (el.innerHTML = "")); return; }
  const who = APP.user.name || APP.user.email.split("@")[0], st = planLine(APP.cfg.billing);
  const html = `<div class="pf"><button type="button" class="pf-btn" data-pf aria-haspopup="menu" aria-expanded="false" aria-label="Account menu for ${esc(who)}"><span class="pf-av ${st.tone}">${esc(initialsOf(who))}</span><span class="pf-tx"><b>${esc(who)}</b>${st.text ? `<span class="${st.tone}">${esc(st.text)}</span>` : ""}</span>${icon("down", 14)}</button></div>`;
  slots.forEach((el) => (el.innerHTML = html));
}
const paintTrialPill = paintProfile; // the older name, still called after billing changes
function openProfileMenu(btn) {
  closeProfileMenu();
  const who = APP.user.name || APP.user.email.split("@")[0], b = APP.cfg.billing, st = planLine(b), bill = billingOn() && b && (b.plan.status !== "internal" || !!b.checkout?.enabled);
  const m = document.createElement("div"); m.className = "pf-menu"; m.setAttribute("role", "menu");
  m.innerHTML = `<div class="pf-h"><span class="pf-av lg ${st.tone}">${esc(initialsOf(who))}</span><div><b>${esc(who)}</b><span>${esc(APP.user.email)}</span>${APP.org ? `<em>${esc(APP.org.name)}</em>` : ""}</div></div>
    ${bill ? `<div class="pf-plan ${st.tone}"><div><span class="bl-kicker">Plan</span><b>${esc(b.plan.status === "new" ? "No plan yet" : b.plan.status === "trialing" ? "Free trial" : b.plan.name)}</b><span>${esc(st.detail || st.text)}</span></div>${st.cta ? `<button type="button" class="btn sm" data-pfgo="billing">${esc(st.cta)}</button>` : ""}</div>` : ""}
    <div class="pf-items">${bill ? `<button type="button" class="navlike" role="menuitem" data-pfgo="account">${icon("overview", 15)}Account &amp; usage</button>${PAY_HIDDEN ? "" : `<button type="button" class="navlike" role="menuitem" data-pfgo="billing">${icon("card", 15)}Plans &amp; payment</button>`}` : ""}
    <button type="button" class="navlike" role="menuitem" data-pfgo="team">${icon("team", 15)}Team &amp; keys</button>${APP.cfg.console ? `<a class="navlike" role="menuitem" href="/console/">${icon("overview", 15)}Command Deck</a>` : ""}${DATA.list.length ?`<button type="button" class="navlike" role="menuitem" data-pfgo="brands">${icon("list", 15)}Your brands</button>` : ""}</div>
    <button type="button" class="navlike pf-out" role="menuitem" data-pfgo="out">${icon("out", 15)}Sign out</button>`;
  btn.closest(".pf").append(m); btn.setAttribute("aria-expanded", "true"); m.querySelector("button")?.focus();
}
function closeProfileMenu() { $$(".pf-menu").forEach((x) => x.remove()); $$("[data-pf]").forEach((x) => x.setAttribute("aria-expanded", "false")); }
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-pf]");
  if (btn) { const open = btn.getAttribute("aria-expanded") === "true"; return open ? closeProfileMenu() : openProfileMenu(btn); }
  const go = e.target.closest("[data-pfgo]");
  if (go) { closeProfileMenu(); const k = go.dataset.pfgo;
    if (k === "billing") return openBilling(); if (k === "account") return openAccount(); if (k === "team") return openTeam(); if (k === "brands") return goHome(); if (k === "out") return $("#signOut").click(); }
  if (!e.target.closest(".pf-menu")) closeProfileMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $(".pf-menu")) { closeProfileMenu(); $("[data-pf]")?.focus(); } });

const loadRazorpay = () => (window.Razorpay ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://checkout.razorpay.com/v1/checkout.js"; s.onload = ok; s.onerror = () => no(new Error("Couldn't load the payment window. Check your connection and try again.")); document.head.append(s); }));
// Subscribing, connecting a card, or approving a new mandate opens a full-page checkout first: the plan, the money with GST, what
// happens today and on which date, and how they can pay. "Continue to secure payment" then hands over to Razorpay.
function buyPlan(plan, { switching = false } = {}) {
  const b = BILL.b, p = b.plan, x = BILL.cat.plans.find((y) => y.code === plan), ccy = p.currency || BILL.ccy;
  const cycle = p.status === "active" && p.currency ? p.cycle || "monthly" : BILL.cycle === "annual" && x.annualPrices?.[ccy] != null ? "annual" : "monthly", yearly = cycle === "annual";
  const price = yearly ? x.annualPrices[ccy] : x.prices[ccy];
  const later = (t) => t && new Date(t).getTime() - Date.now() > 30 * 60e3;
  // Buying during the free trial starts the plan today (the trial ends); only a cancelled, still paid-up plan waits for its end.
  const starts = p.status === "active" && (p.cancelAtPeriodEnd || switching) && later(b.periodEnd) ? "resume" : "now";
  const on = starts === "trial" ? b.trialEndsAt : starts === "resume" ? b.periodEnd : null, upi = !yearly && ccy === "INR" && charged(price, ccy) <= (BILL.cat.upiMax || 0);
  const title = starts === "trial" ? "Connect a payment method" : switching ? `Switch to ${x.name}` : starts === "resume" ? (plan === p.code ? "Keep your subscription" : `Continue on ${x.name}`) : `Subscribe to ${x.name}`;
  const lede = starts === "trial" ? `Your trial stays free until ${esc(fmtDay(on))}. Connect a payment method now so ${esc(x.name)} carries on without a break.`
    : starts === "resume" ? `You've already paid until ${esc(fmtDay(on))}. Nothing more is charged until then.` : `${esc(x.name)} starts as soon as the payment goes through.`;
  const amt = `<b>${esc(moneyExact(charged(price, ccy), ccy))}</b>`;
  const steps = starts === "now" ? [["Today", `Razorpay charges ${amt} and ${esc(x.name)} starts.`, "go"], [yearly ? "Every year" : "Every month", `${amt} again, until you cancel. Cancel any time.`]]
    : [["Today", `A refundable ₹5 check confirms your payment method. ${starts === "trial" ? "Your trial carries on." : `You stay on ${esc(p.name)}.`}`, "go"], [fmtDay(on), `First charge of ${amt}, then ${yearly ? "yearly" : "monthly"}. Cancel before then and you pay nothing.`]];
  const methods = [["UPI Autopay", upi], ["Cards", true], ["Net banking", ccy === "INR"]];
  const m = document.createElement("div"); m.className = "ck light"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-label", title);
  m.innerHTML = `<aside class="ck-side"><div class="ck-brand">${$(".ob-logo svg")?.outerHTML || ""}<span>Perfstaq</span></div>
      <div class="ck-plan"><span class="bl-kicker">${x.featured ? "Most popular" : "Your plan"}</span><h2>${esc(x.name)}</h2><p>${esc(x.description || "")}</p>
      <ul>${planFacts(x.entitlements).map((l) => `<li>${esc(l)}</li>`).join("")}<li>${esc(x.entitlements.engines.length > 3 ? "All AI engines" : x.entitlements.engines.map(engLabel).join(", "))}</li></ul></div>
      <p class="ck-safe">${icon("lock", 14)} Billed by Perfstaq. Payments are handled by Razorpay; we never see your card or bank details.</p></aside>
    <main class="ck-main"><button type="button" class="pillbtn ck-back" data-ckback>${icon("arrow", 14)} Back to plans</button>
      <div class="ck-body"><span class="bl-kicker">Checkout</span><h1>${esc(title)}</h1><p class="ck-lede">${lede}</p>
      ${shSteps(steps)}${shMoney(price, ccy, yearly ? "year" : "month")}
      <div class="ck-pay"><span>Pay with</span>${methods.map(([n, ok]) => `<em class="${ok ? "" : "off"}">${esc(n)}</em>`).join("")}</div>
      ${!upi && ccy === "INR" ? `<p class="ck-note">${yearly ? `A yearly payment of ${esc(moneyExact(charged(price, ccy), ccy))} is above UPI Autopay's limit, so it` : `UPI Autopay covers payments up to ₹15,000 a month, so ${esc(x.name)}`} is paid by card or net banking.</p>` : ""}
      <button type="button" class="btn ck-go" data-ckgo>${icon("lock", 15)} Continue to secure payment</button>
      <p class="ck-fine">You'll confirm on Razorpay's secure page and come straight back here.</p></div></main>`;
  const close = () => { document.removeEventListener("keydown", key, true); m.remove(); document.body.classList.remove("sheet-open"); };
  const key = (e) => { if (e.key === "Escape" && !document.querySelector(".razorpay-container")) { e.stopPropagation(); close(); } };
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-ckback]")) return close();
    const go = e.target.closest("[data-ckgo]"); if (!go || go.getAttribute("aria-disabled")) return;
    go.setAttribute("aria-disabled", "true"); go.innerHTML = "Opening secure payment…";
    try { await payWithRazorpay(plan, switching, cycle); }
    catch (err) { toast(esc(err.message), "bad"); }
    finally { go.removeAttribute("aria-disabled"); go.innerHTML = `${icon("lock", 15)} Continue to secure payment`; }
  });
  $(".toast")?.remove(); // the checkout says it all; no leftover message on top of it
  document.addEventListener("keydown", key, true); document.body.append(m); document.body.classList.add("sheet-open"); m.querySelector("[data-ckgo]").focus();
}
async function payWithRazorpay(plan, switching, cycle = "monthly") {
  const c = await api("POST", "/api/billing/checkout", { plan, currency: BILL.b?.plan?.currency || BILL.ccy || guessCcy(), cycle, switch: switching });
  await loadRazorpay();
  const starts = c.starts || (c.startsAt ? "trial" : "now"), trial = starts === "trial"; // trial / resume: nothing is charged until the covered time ends
  const per = c.cycle === "annual" ? "yearly" : "monthly";
  const description = starts === "trial" ? `${c.name} · free until ${fmtDay(c.startsAt)}, then ${per}` : starts === "resume" ? `${c.name} · from ${fmtDay(c.startsAt)}, ${per}` : `${c.name} · ${per}`;
  // UPI only up to the ₹15,000 recurring limit (the server decides): larger plans are offered card and net banking.
  const config = c.upi === false ? { display: { hide: [{ method: "upi" }], preferences: { show_default_blocks: true } } } : undefined;
  // After paying, Razorpay posts back to /api/billing/callback, which brings the person back here (?billing=…).
  try { sessionStorage.setItem("wp_pay", JSON.stringify({ plan, trial, resumeAt: starts === "resume" ? c.startsAt : null })); } catch {}
  new window.Razorpay({ key: c.keyId, subscription_id: c.subscriptionId, name: "Perfstaq", description: `AI Visibility · ${description}`, prefill: { email: APP.user.email }, theme: { color: "#E8742A" }, ...(config ? { config } : {}),
    ...(c.callbackUrl ? { callback_url: c.callbackUrl, redirect: true } : {}),
    handler: async (r) => { try { await api("POST", "/api/billing/verify", r); } catch (e) { toast(esc(e.message), "bad"); } $(".ck")?.remove(); document.body.classList.remove("sheet-open"); confirmPayment(plan, trial, starts === "resume" ? c.startsAt : null); },
    modal: { ondismiss: () => toast("Payment window closed. Nothing was charged.", "info") } }).open();
}
async function confirmPayment(plan, trial = false, resumeAt = null) {
  toast(trial || resumeAt ? "Connecting your payment method…" : "Confirming your payment with Razorpay…", "info");
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const b = await api(i % 2 ? "POST" : "GET", i % 2 ? "/api/billing/refresh" : "/api/billing").catch(() => null);
    const done = b && ((resumeAt && b.plan.status === "active" && !b.plan.cancelAtPeriodEnd && (b.plan.pendingPlan === plan || (b.plan.code === plan && !b.plan.pendingPlan)))
      || (trial && b.plan.code === plan && b.paymentMethod.connected) || (!trial && !resumeAt && b.plan.code === plan && b.plan.status === "active"));
    if (done) { await reloadConfig(); $(".toast")?.remove(); return paySuccess(b, plan, trial ? "trial" : resumeAt ? "resume" : "paid"); }
  }
  toast(trial ? "Still connecting. It shows here as soon as Razorpay confirms it." : "Still confirming. If you were charged, your plan updates as soon as Razorpay confirms it. Contact us if it doesn't.", "warn");
}
// The moment it's done: a full page that says so, what happens next, and one obvious way on. Someone who hasn't checked a
// website yet goes to add one; anyone with brands goes back to their dashboard.
function paySuccess(b, plan, kind) {
  $$(".ck,.paid").forEach((x) => x.remove());
  const x = BILL.cat?.plans.find((y) => y.code === plan), name = x?.name || b.plan.name, ccy = b.plan.currency || BILL.ccy, price = x?.prices?.[ccy];
  const amt = price != null ? moneyExact(charged(price, ccy), ccy) : "";
  const title = kind === "trial" ? "You're all set" : kind === "resume" ? "Your subscription continues" : b.plan.status === "active" && plan === b.plan.code ? `Welcome to ${name}` : "Payment received";
  const lede = kind === "trial" ? `Your payment method is connected. ${esc(name)} stays free until ${esc(fmtDay(b.trialEndsAt))}.`
    : kind === "resume" ? `Nothing more is charged until ${esc(fmtDay(b.periodEnd))}.` : `${esc(name)} is active and its limits apply right away.`;
  const rows = [["Plan", esc(name)], ...(amt ? [["Every month", `${esc(amt)}${taxRate(ccy) ? ` <small>incl. ${taxRate(ccy) * 100}% GST</small>` : ""}`]] : []),
    [kind === "trial" ? "First charge" : "Next charge", esc(fmtDay(kind === "trial" ? b.trialEndsAt : b.periodEnd))], ["Payments by", "Razorpay"]];
  const hasBrands = DATA.list.length > 0;
  const m = document.createElement("div"); m.className = "paid light"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-labelledby", "paidT");
  m.innerHTML = `<div class="paid-card"><div class="paid-mark" aria-hidden="true">${icon("check", 30)}</div><span class="bl-kicker">${kind === "trial" ? "Payment method connected" : "Payment confirmed"}</span><h1 id="paidT">${esc(title)}</h1><p>${lede}</p>
    <dl class="paid-sum">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
    <button type="button" class="btn paid-go" data-paidgo>${hasBrands ? "Go to your dashboard" : "Add your website"} ${icon("arrow", 15)}</button>
    <button type="button" class="lnk" data-paidplan>View plan &amp; usage</button>
    <p class="paid-fine">Razorpay emails a confirmation to ${esc(APP.user.email)}. You can cancel any time from Plans &amp; payment.</p></div>`;
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-paidgo]")) { m.remove(); document.body.classList.remove("sheet-open"); if (hasBrands) return home(); goHome(); return setTimeout(() => $("#startUrl")?.focus(), 50); }
    if (e.target.closest("[data-paidplan]")) { m.remove(); document.body.classList.remove("sheet-open"); return openAccount(); }
  });
  document.body.append(m); document.body.classList.add("sheet-open"); m.querySelector("[data-paidgo]").focus();
}
async function changePlan(plan) {
  const cat = BILL.cat, b = BILL.b, ccy = b.plan.currency, name = cat.plans.find((x) => x.code === plan)?.name || plan;
  if (plan === b.plan.code) { await api("POST", "/api/billing/change-plan", { plan }); await openBilling(); return toast(`You're staying on <b>${esc(name)}</b>. The scheduled change is cancelled.`, "ok"); }
  const now = cat.plans.find((x) => x.code === b.plan.code), to = cat.plans.find((x) => x.code === plan), up = to.prices[ccy] > (now?.prices[ccy] || 0);
  const price = `<b>${esc(withGst(to.prices[ccy], ccy))}</b> a month`;
  const cmp = shCompare({ k: "Now", name: now?.name || b.plan.name, price: perMonth(now?.prices[ccy] || 0, ccy) }, { k: up ? "Upgrade to" : "Moving to", name, price: perMonth(to.prices[ccy], ccy) });
  const okd = await confirmBox(up
    ? { title: `Upgrade to ${name}`, icon: "spark", tone: "up", ok: "Upgrade now", cancel: "Not now", sub: "More room for brands, questions and fixes, straight away.",
        body: cmp + shSteps([["Today", `${esc(name)}'s limits switch on. Razorpay charges the difference for the rest of this period to your saved payment method.`, "go"], [fmtDay(b.periodEnd), `Renews at ${perMonth(to.prices[ccy], ccy)}, then monthly. Your renewal date doesn't change.`]]) }
    : { title: `Move to ${name}`, icon: "down", tone: "down", ok: "Schedule the change", cancel: "Keep my plan", safe: true, sub: "Nothing changes until your renewal.",
        body: cmp + shSteps([["Today", `Nothing is charged or refunded. You keep everything in ${esc(now?.name || "your plan")}.`, "go"], [fmtDay(b.periodEnd), `You move to ${esc(name)} at ${perMonth(to.prices[ccy], ccy)}. You can undo it any time before then.`]]) + `<p class="sh-note">${icon("info", 14)} Your usage has to fit ${esc(name)}'s limits. We check that now.</p>` });
  if (!okd) return;
  try { await api("POST", "/api/billing/change-plan", { plan }); }
  catch (err) {
    if (err.code === "needs_new_mandate") {
      const go = await confirmBox({ title: `Switch to ${name} at your renewal`, icon: "card", tone: "info", ok: "Approve a new mandate", cancel: "Not now", sub: esc(err.message),
        body: cmp + shSteps([["Today", `Nothing is charged. You keep ${esc(now?.name || "your plan")}.`, "go"], [fmtDay(b.periodEnd), `${esc(name)} starts at ${perMonth(to.prices[ccy], ccy)} and your old mandate stops.`]]) });
      if (go) await buyPlan(plan, { switching: true }); return;
    }
    const over = err.code === "over_plan" && err.data?.blockers?.length;
    await confirmBox({ title: over ? `A little too much for ${name}` : up ? "Couldn't upgrade" : "Couldn't make that change", icon: over ? "info" : "x", tone: "bad", ok: over ? "Got it" : "OK", cancel: "",
      sub: over ? `Nothing is deleted for you. Trim these first, then come back to move to ${esc(name)}:` : esc(err.message), body: over ? `<ul class="sh-list">${err.data.blockers.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "" }); return;
  }
  if (up) return confirmPayment(plan);
  await openBilling(); toast(`Done. You'll move to <b>${esc(name)}</b> on ${esc(fmtDay(b.periodEnd))}.`, "ok");
}
async function cancelTrial() {
  const b = BILL.b || (await api("GET", "/api/billing")), card = b.paymentMethod?.connected;
  if (!(await confirmBox({ title: "Cancel your free trial?", icon: "x", tone: "bad", ok: "Cancel free trial", cancel: "Keep my trial", danger: true, safe: true,
    sub: card ? "Your payment method is removed too. Nothing has been charged, and nothing will be." : "Nothing has been charged, and nothing will be.",
    body: `<div class="sh-two"><div><b>Stays</b><ul class="sh-list ok">${["Your reports and past checks stay readable", "Subscribe any time to pick up where you left off"].map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div><b>Ends now</b><ul class="sh-list no">${["New checks, drafts and invites", "The trial can't be started again"].map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>` }))) return;
  try { await api("POST", "/api/billing/cancel-trial"); } catch (err) { await confirmBox({ title: "Couldn't cancel", icon: "x", tone: "bad", sub: esc(err.message), ok: "OK", cancel: "" }); return; }
  await refreshBilling(); await openBilling(); toast("Free trial cancelled. Your reports stay readable.", "warn");
}
async function cancelSub() {
  const b = BILL.b, end = fmtDay(b.periodEnd);
  if (!(await confirmBox({ title: "Cancel your subscription?", icon: "x", tone: "bad", ok: "Cancel subscription", cancel: `Keep ${b.plan.name}`, danger: true, safe: true, sub: "You won't be charged again. Before you go, here's what changes.",
    body: `<div class="sh-two"><div><b>Until ${esc(end)}</b><ul class="sh-list ok">${["Everything in " + b.plan.name + " keeps working", "Scheduled checks keep running", "Your team keeps its access"].map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div><b>After ${esc(end)}</b><ul class="sh-list no">${["Reports stay readable", "New checks, drafts and invites are paused", "Subscribe again any time to pick up where you left off"].map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>` }))) return;
  try { await api("POST", "/api/billing/cancel"); } catch (err) { await confirmBox({ title: "Couldn't cancel", icon: "x", tone: "bad", sub: esc(err.message), ok: "OK", cancel: "" }); return; }
  await openBilling(); toast(`Subscription cancelled. You keep full access until ${esc(end)}.`, "warn");
}

function billingLink() {
  const b = TEAM.bill; if (!b || !billingOn() || (b.plan.status === "internal" && !b.checkout.enabled)) return "";
  return planPanel(b, TEAM.d?.org?.role === "owner" && !TEAM.d?.org?.operatorVisit, "team");
}
async function openTeam(focus) {
  if (!DATA.server()) return;
  screen("team"); paintProfile();
  $("#teamBody").innerHTML = `<p class="muted pad">Loading…</p>`;
  try {
    TEAM.d = await api("GET", "/api/org");
    TEAM.bill = await api("GET", "/api/billing"); if (!BILL.cat) BILL.cat = await fetch("/api/billing/plans").then((r) => r.json());
    if (!BILL.ccy || !BILL.cat.currencies.includes(BILL.ccy)) BILL.ccy = BILL.cat.currencies.includes(guessCcy()) ? guessCcy() : BILL.cat.currencies[0];
    TEAM.audit = canAdmin() ? (await api("GET", "/api/org/audit")).log : null;
  } catch (e) { $("#teamBody").innerHTML = `<p class="err pad">${esc(e.message)}</p>`; return; }
  paintTeam();
  if (focus) setTimeout(() => $(focus)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
}
function paintTeam() {
  const d = TEAM.d, o = d.org, admin = ["owner", "admin"].includes(o.role), owner = o.role === "owner" && !o.operatorVisit;
  const switcher = APP.orgs.length > 1 || APP.operator ? `<div class="seg team-switch">${APP.orgs.map((x) => `<button type="button" data-org="${esc(x.slug)}" aria-pressed="${x.slug === o.slug}">${esc(x.name)}</button>`).join("")}</div>` : "";
  const memberRows = d.members.map((m) => {
    const self = m.id === d.me, editable = admin && m.role !== "owner" && !self;
    const roleCell = editable ? `<select class="sel" data-role="${esc(m.id)}">${["admin", "editor", "viewer"].map((r) => `<option value="${r}" ${m.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}${owner ? `<option value="owner">Make owner…</option>` : ""}</select>` : `<span class="pillx ${m.role === "owner" ? "ok" : ""}">${ROLE_LABEL[m.role]}</span>`;
    const act = editable ? `<button type="button" class="lnk sm" data-remove="${esc(m.id)}">Remove</button>` : self && m.role !== "owner" ? `<button type="button" class="lnk sm" data-remove="${esc(m.id)}" data-self="1">Leave</button>` : "";
    return `<tr><td><b>${esc(m.name || m.email.split("@")[0])}</b>${self ? ' <span class="tagx">You</span>' : ""}<div class="muted sm">${esc(m.email)}</div></td><td>${roleCell}</td><td class="muted sm hide-sm">${fmtDay(m.joined_at)}</td><td class="muted sm hide-sm">${m.last_login_at ? fmtDay(m.last_login_at) : "never"}</td><td class="r">${act}</td></tr>`;
  }).join("");
  const invites = admin ? `<div class="card" id="teamInvite"><div class="card-h"><b>Invite someone</b><span class="muted">The link works for 7 days, once</span></div><div class="pad set">
      <form class="team-inv" id="inviteForm"><input class="inp" id="invEmail" type="email" placeholder="name@company.com" required autocomplete="off"><select class="sel" id="invRole">${["editor", "viewer", "admin"].map((r) => `<option value="${r}">${ROLE_LABEL[r]}: ${ROLE_HELP[r]}</option>`).join("")}</select><button class="btn sm" type="submit">Send invite</button></form>
      ${TEAM.lastLink ? `<div class="team-link"><span class="muted sm">${TEAM.lastLink.emailed ? `Emailed to ${esc(TEAM.lastLink.email)}. You can also share this link:` : `Email isn't set up yet, so share this link with ${esc(TEAM.lastLink.email)} yourself:`}</span><div class="srow"><code class="ell">${esc(TEAM.lastLink.link)}</code><button type="button" class="btn ghost sm" data-copy="${esc(TEAM.lastLink.link)}">Copy link</button></div></div>` : ""}
      ${d.invites.length ? `<table class="tbl"><thead><tr><th>Waiting for</th><th>Role</th><th>Expires</th><th></th></tr></thead><tbody>${d.invites.map((i) => `<tr><td>${esc(i.email)}<div class="muted sm">invited by ${esc(i.invited_by || "–")}</div></td><td><span class="pillx">${ROLE_LABEL[i.role]}</span></td><td class="muted sm">${fmtDay(i.expires_at)}</td><td class="r"><button type="button" class="lnk sm" data-revoke="${esc(i.id)}">Cancel</button></td></tr>`).join("")}</tbody></table>` : ""}
    </div></div>` : "";
  const keys = d.keys ? `<div class="card" id="teamKeys"><div class="card-h">${icon("key", 15)}<b>AI keys</b><span class="muted">${o.allowPlatformKeys ? "Keys you add here are used first; the rest fall back to Perfstaq's" : "Checks run on these keys only, so the spend is on your accounts"}</span></div><div class="pad set">
      <table class="tbl"><thead><tr><th>Service</th><th>Status</th><th>New value</th><th></th></tr></thead><tbody>${d.keys.map((k) => `<tr><td><b>${esc(k.label)}</b><div class="muted sm"><code>${esc(k.name)}</code></div></td><td>${k.set ? `<span class="pillx ok">Set ${esc(k.hint)}</span>` : k.platform ? `<span class="pillx">Using Perfstaq's</span>` : `<span class="pillx no">Not set</span>`}</td><td><input class="inp" type="password" autocomplete="off" data-key="${esc(k.name)}" placeholder="${k.set ? "Paste to replace" : "Paste key"}"></td><td class="r">${k.set ? `<button type="button" class="lnk sm" data-clearkey="${esc(k.name)}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table>
      <div class="srow"><span class="muted sm">Keys are encrypted at rest and never shown again in full. ChatGPT needs OpenAI; Gemini is free at aistudio.google.com/apikey.</span><button type="button" class="btn sm" data-savekeys>Save keys</button></div>
    </div></div>` : "";
  const u = d.usage || {}, cap = u.cap || {};
  const meter = cap.cap ? `<div class="meter ${cap.over ? "over" : cap.warn ? "warn" : ""}"><i style="width:${Math.round((cap.pct || 0) * 100)}%"></i></div><p class="muted sm">${usd(cap.spent)} of ${usd(cap.cap)} this month${cap.over ? " · budget reached: new checks are paused until next month or a higher budget" : cap.warn ? " · over 80%" : ""}</p>` : `<p class="muted sm">${usd(cap.spent)} this month · no monthly limit set</p>`;
  const usageTbl = (rows, label) => rows?.length ? `<table class="tbl"><thead><tr><th>${label}</th><th class="r">Calls</th><th class="r">Est. cost</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(ENG[r.name] || r.name)}</td><td class="r">${r.calls.toLocaleString()}</td><td class="r">${usd(r.usd)}</td></tr>`).join("")}</tbody></table>` : "";
  const budget = admin ? `<div class="card" id="teamBudget"><div class="card-h"><b>Budget and usage</b><span class="muted">Estimated from list prices; your providers' bills are the real numbers</span></div><div class="pad set">
      ${meter}
      <div class="srow"><span>Monthly AI budget (USD)</span><span class="team-cap"><input class="inp" id="capIn" type="number" min="0" step="1" placeholder="No limit" value="${o.monthlyCapUsd ?? ""}"><button type="button" class="btn ghost sm" data-savecap>Save</button></span></div>
      <div class="grid2">${usageTbl(u.byEngine, "Engine or task")}${usageTbl(u.byPerson, "Person")}</div>${usageTbl(u.byBrand, "Brand")}
    </div></div>` : `<div class="card"><div class="card-h"><b>Budget</b></div><div class="pad set">${cap.cap ? meter : `<p class="muted sm">No monthly limit set.</p>`}</div></div>`;
  const audit = TEAM.audit ? `<div class="card"><div class="card-h"><b>Activity</b><span class="muted">Who changed what</span></div><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${TEAM.audit.slice(0, 60).map((a) => `<tr><td class="muted sm">${fmtWhen(a.at)}</td><td class="sm">${esc(a.who || "Perfstaq")}</td><td class="sm">${esc(auditWords(a))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Nothing yet.</td></tr>`}</tbody></table></div>` : "";
  const verify = APP.user && !APP.user.verified ? `<div class="card note"><div class="pad">${icon("info", 16)} <b>Confirm your email.</b> <span class="muted">We sent a link to ${esc(APP.user.email)} when you signed up. Some things, like operator access, wait for it.</span><button type="button" class="btn ghost sm" data-sendverify>Send it again</button></div></div>` : "";
  $("#teamBody").innerHTML = verify + `<div class="team-head"><div><span class="lp-kicker">Organisation</span><h1>${esc(o.name)}</h1><p class="muted">You're ${o.operatorVisit ? "visiting as a Perfstaq operator (logged)" : `${{ owner: "the owner", admin: "an admin", editor: "an editor", viewer: "a viewer" }[o.role]}`} · ${d.members.length} ${d.members.length === 1 ? "person" : "people"}</p></div>${switcher}</div>
    <div class="card"><div class="card-h">${icon("team", 15)}<b>People</b><span class="muted">Owner and admins manage people and keys; editors do the work; viewers watch</span></div><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th class="hide-sm">Joined</th><th class="hide-sm">Last sign-in</th><th></th></tr></thead><tbody>${memberRows}</tbody></table></div>
    ${billingLink()}${invites}${keys}${budget}${audit}`;
}
const AUDIT_WORDS = { "org.created": "created the organisation", "invite.sent": "invited", "invite.accepted": "joined", "invite.revoked": "cancelled the invite for", "role.changed": "changed the role of", "owner.transferred": "handed ownership to", "member.removed": "removed", "member.left": "left", "keys.changed": "changed AI keys:", "org.updated": "changed settings", "brand.deleted": "deleted the brand", "brand.moved_in": "moved in the brand", "brand.moved_out": "moved out the brand", "integration.saved": "connected", "integration.removed": "disconnected", "check.queued": "queued a check of", "check.skipped": "skipped a scheduled check of", "operator.visit": "opened the organisation as an operator" };
function auditWords(a) {
  const d = a.detail || {};
  const extra = a.action === "role.changed" ? ` (${ROLE_LABEL[d.from] || d.from} → ${ROLE_LABEL[d.to] || d.to})` : a.action === "invite.sent" || a.action === "invite.accepted" ? ` as ${ROLE_LABEL[d.role] || d.role || ""}` : a.action === "check.skipped" ? ": monthly budget reached" : a.action === "org.updated" ? `: ${Object.keys(d).join(", ").replace("monthly_cap_usd", "monthly budget")}` : "";
  if (HIST[a.action]) return HIST[a.action][0] + (BILL.cat?.plans.some((x) => x.code === a.target) ? ` · ${planName(a.target)}` : ""); // plan and payment events, in words
  return [AUDIT_WORDS[a.action] || a.action, a.action === "operator.visit" ? "" : a.target || ""].filter(Boolean).join(" ") + extra;
}
async function switchOrg(slug) {
  await api("POST", `/api/orgs/${encodeURIComponent(slug)}/switch`);
  await reloadConfig(); APP.M = null; await DATA.refresh();
  toast(`Now in ${esc(APP.org?.name || slug)}.`);
  return home();
}
$("#team").addEventListener("click", async (e) => {
  const t = e.target;
  try {
    const org = t.closest("[data-org]"); if (org) return switchOrg(org.dataset.org);
    if (await billAction(t)) return;
    if (t.closest("[data-sendverify]")) { const r = await api("POST", "/api/auth/verify/send"); return toast(r.already ? "Your email is already confirmed." : r.emailed ? `Sent to ${esc(APP.user.email)}.` : "Email isn't set up on this server yet, so the link is in the server log."); }
    const cp = t.closest("[data-copy]"); if (cp) { await navigator.clipboard.writeText(cp.dataset.copy).catch(() => {}); return toast("Link copied."); }
    const rv = t.closest("[data-revoke]"); if (rv) { TEAM.d.invites = (await api("DELETE", `/api/org/invitations/${rv.dataset.revoke}`)).invites; return paintTeam(); }
    const rm = t.closest("[data-remove]");
    if (rm) {
      if (rm.dataset.armed !== "1") { rm.dataset.armed = "1"; rm.textContent = rm.dataset.self ? "Click again to leave" : "Click again to remove"; return; }
      const r = await api("DELETE", `/api/org/members/${rm.dataset.remove}`);
      if (r.left) { await reloadConfig(); await DATA.refresh(); toast("You left the organisation."); return home(); }
      TEAM.d.members = r.members; return paintTeam();
    }
    const ck = t.closest("[data-clearkey]"); if (ck) { TEAM.d.keys = (await api("PUT", "/api/org/keys", { keys: { [ck.dataset.clearkey]: null } })).keys; await reloadConfig(); toast("Key removed."); return paintTeam(); }
    if (t.closest("[data-savekeys]")) {
      const keys = {}; $$("#teamKeys [data-key]").forEach((i) => { if (i.value.trim()) keys[i.dataset.key] = i.value.trim(); });
      if (!Object.keys(keys).length) return toast("Paste at least one key first.");
      const r = await api("PUT", "/api/org/keys", { keys }); TEAM.d.keys = r.keys; await reloadConfig();
      toast(`Saved. Engines now available: ${(APP.cfg.engines || []).map((x) => ENG[x]).join(", ") || "none"}.`); return paintTeam();
    }
    if (t.closest("[data-savecap]")) { const v = $("#capIn").value.trim(); await api("PATCH", "/api/org", { monthlyCapUsd: v === "" ? null : Number(v) }); toast(v === "" ? "No monthly limit." : `Monthly budget set to $${v}.`); return openTeam(); }
  } catch (err) { toast(esc(err.message)); }
});
$("#team").addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-role]"); if (!sel) return;
  const to = sel.value, m = TEAM.d.members.find((x) => x.id === sel.dataset.role);
  if (to === "owner" && !confirmOwner(m)) { sel.value = m.role; return; }
  try { TEAM.d.members = (await api("PATCH", `/api/org/members/${sel.dataset.role}`, { role: to })).members; if (to === "owner") { await reloadConfig(); return openTeam(); } toast(`${esc(m.email)} is now ${ROLE_LABEL[to].toLowerCase()}.`); paintTeam(); }
  catch (err) { toast(esc(err.message)); sel.value = m.role; }
});
// Handing over ownership is the one change that takes power away from the person making it: ask twice.
function confirmOwner(m) { const ok = TEAM.ownerArmed === m.id; TEAM.ownerArmed = ok ? null : m.id; if (!ok) toast(`Choose “Make owner…” again to hand ownership to ${esc(m.email)}. You'll stay on as an admin.`); return ok; }
$("#team").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (e.target.id === "inviteForm") {
      const r = await api("POST", "/api/org/invitations", { email: $("#invEmail").value, role: $("#invRole").value });
      TEAM.lastLink = { link: r.invite.link, email: r.invite.email, emailed: r.invite.emailed }; TEAM.d.invites = r.invites;
      TEAM.audit = (await api("GET", "/api/org/audit")).log; paintTeam();
      return toast(r.invite.emailed ? `Invite emailed to ${esc(r.invite.email)}.` : "Invite created. Copy the link and send it.");
    }
  } catch (err) { toast(esc(err.message)); }
});
$("#teamBack").addEventListener("click", () => backFromSide());

$("#navTeam").addEventListener("click", () => openTeam());
document.addEventListener("click", (e) => { if (e.target.id === "toTeamKeys") openTeam("#teamKeys"); });

// A link opened in a tab that already has the app (same page, new #hash): handle it without a reload.
addEventListener("hashchange", async () => { if (/^#(invite|reset|verify|auth-error)=/.test(location.hash) && !(await handleAuthHash())) home(); });

/* =================================================================== LEAVING & COMING BACK */
// No "leave site?" prompt: the run is saved continuously and this tab picks it back up by itself when you return.
const AUTO = "wpetal:auto";
addEventListener("pagehide", () => {
  if (!APP.M) return;
  if (APP.running) { save(true); try { sessionStorage.setItem(AUTO, APP.M.slug); } catch {} }
  try { localStorage.removeItem("wpetal:lock:" + APP.M.slug); } catch {}
});
addEventListener("pageshow", (e) => {
  // Restored from the back/forward cache: open connections were cut while away, so resume from the saved state.
  if (e.persisted && APP.running && APP.M) { try { sessionStorage.removeItem(AUTO); } catch {} APP.resuming = true; APP.ctl?.abort(); setTimeout(() => resumeMission(store.get("mission:" + APP.M.slug, APP.M)), 80); }
  else if (e.persisted) renderRecent();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (APP.running) save(true); return; }
  if (!$("#mission").hidden) { G.sim?.alpha(0.3).restart(); if (APP.M) renderMatrix($("#matrix"), APP.M); scrollFeed(); }
});

/* Pricing-page links (/?plan=growth&currency=INR[&trial=1]) are remembered across sign-up or Google sign-in, then acted on once. */
const INTENT = "wp_intent";
function captureIntent() {
  const p = new URLSearchParams(location.search), plan = p.get("plan"); if (!plan) return;
  try { sessionStorage.setItem(INTENT, JSON.stringify({ plan, currency: (p.get("currency") || "").toUpperCase(), trial: p.get("trial") === "1" })); } catch {}
  history.replaceState(null, "", location.pathname + location.hash);
}
const readIntent = () => { try { return JSON.parse(sessionStorage.getItem(INTENT) || "null"); } catch { return null; } };
async function resumeIntent() {
  const it = readIntent(); if (!it || !APP.user || !billingOn()) return false;
  try { sessionStorage.removeItem(INTENT); } catch {}
  if (PAY_HIDDEN) return false; // PAY_HIDDEN: a ?plan= link from the pricing site no longer opens plans or checkout; the trial already started at sign-up
  if (!["starter", "growth", "agency"].includes(it.plan)) return false;
  const owner = APP.org?.role === "owner" && !APP.org?.operatorVisit; if (!owner) return false;
  BILL.ccy = null; await openBilling({ firstRun: true });
  const b = BILL.b; if (!b) return true;
  if (it.currency && BILL.cat?.currencies?.includes(it.currency) && !b.plan.currency) { BILL.ccy = it.currency; paintBilling(); }
  // From the pricing page: the trial starts on the plan they clicked. They can connect a payment method now or later.
  if ((b.plan.status === "trialing" && !b.paymentMethod.connected) || (b.plan.status === "new" && b.trialAvailable)) await chooseTrialPlan(it.plan).catch((e) => toast(esc(e.message)));
  else if (b.checkout.enabled && b.plan.status !== "active") await buyPlan(it.plan).catch((e) => toast(esc(e.message)));
  return true;
}
// Everyone starts with a 7-day free trial. Right after signing up, until they have picked a plan, the plans page comes first
// (once per session: "Skip for now" keeps it out of the way, and the dashboard pill still reminds them).
// Back from Razorpay's full-page checkout (?billing=ok|failed): land on the plans page and finish what was started.
async function payReturn() {
  const q = new URLSearchParams(location.search), r = q.get("billing"); if (!r) return false;
  history.replaceState(null, "", location.pathname + location.hash);
  let s = null; try { s = JSON.parse(sessionStorage.getItem("wp_pay") || "null"); sessionStorage.removeItem("wp_pay"); } catch {}
  if (!APP.user || !billingOn()) return false;
  await openBilling();
  if (r === "ok") { if (s) confirmPayment(s.plan, s.trial, s.resumeAt); else toast("Payment received. Updating your plan…", "info"); }
  else { const why = q.get("why"); toast(why && why !== "unverified" ? `Payment didn't go through: ${esc(why)}` : "Payment didn't go through. Nothing was charged.", "bad"); }
  return true;
}
async function maybeFirstRun() {
  // PAY_HIDDEN: no first-run plans page; the trial starts at sign-up. An owner who signed up before that (still waiting on a
  // plan, trial unused) gets the default trial started here instead of the plans page.
  if (PAY_HIDDEN) {
    const w = APP.cfg.billing, own = APP.org?.role === "owner" && !APP.org?.operatorVisit;
    if (w && billingOn() && own && w.plan.status === "new" && w.trialAvailable) try { APP.cfg.billing = await api("POST", "/api/billing/start-trial", {}); paintProfile(); } catch {}
    return false;
  }
  const b = APP.cfg.billing; if (!b || !billingOn() || !["new", "trialing"].includes(b.plan.status) || b.trialChosen) return false;
  if (!(APP.org?.role === "owner" && !APP.org?.operatorVisit)) return false;
  if (b.plan.status !== "new") try { if (sessionStorage.getItem("wp_skip_plan")) return false; } catch {}
  await openBilling({ firstRun: true }); return true;
}

/* =================================================================== BOOT */
(async () => {
  paintIcons();
  $$(".wordmark .pq").forEach((m) => m.classList.add("anim"));
  try { const r = await fetch("/api/config", { cache: "no-store" }); if (!r.ok) throw 0; } catch { $("#startErr").textContent = "Can't reach the server."; }
  captureIntent();
  await reloadConfig();
  if (APP.cfg.access) { $("#accessRow").hidden = false; $("#accessCode").value = APP.code || ""; }
  paintLanding();
  if (DATA.server()) { try { await DATA.refresh(); } catch {} }
  if (await handleAuthHash()) return;
  if (readIntent() && !APP.user && APP.cfg.auth) return showAuth("signup"); // coming from the pricing page: sign up first
  if (await payReturn()) return;
  if (await resumeIntent()) return;
  if (await maybeFirstRun()) return;
  if (APP.cfg.engines && !APP.cfg.engines.length) $("#startErr").innerHTML = DATA.server() ? (canAdmin() ? `This organisation has no AI keys yet. Add them in <button type="button" class="lnk" id="toTeamKeys">Team &amp; keys</button>.` : "This organisation has no AI keys yet. Ask an admin to add them in Team & keys.") : "The server has no AI keys yet. Add GEMINI_API_KEY (free) in the environment variables.";
  // This tab was running a check when it navigated away or reloaded: carry on without asking.
  let auto = null; try { auto = sessionStorage.getItem(AUTO); sessionStorage.removeItem(AUTO); } catch {}
  const m = auto && store.get("mission:" + auto, null);
  if (m && !m.finishedAt && m.profile && m.done && APP.cfg.engines?.length && !(await lockedElsewhere(auto))) return resumeMission(m);
  // A link back from Google sign-in lands on the brand's settings.
  const hm = location.hash.match(/^#settings\/([^?]+)(?:\?(.*))?/);
  if (hm && DATA.server()) { history.replaceState(null, "", location.pathname); if (await openBrand(decodeURIComponent(hm[1]), { quiet: true })) { DASH.page = "settings"; dashRender(); if (/google=connected/.test(hm[2] || "")) toast("Google connected. Choose your Search Console and GA4 properties."); return; } }
  // Links from our emails: #plans opens Plans & payment, #brand/<slug> opens that brand's report.
  if (DATA.server() && location.hash === "#plans") { history.replaceState(null, "", location.pathname); return openBilling(); }
  const hb = location.hash.match(/^#brand\/(.+)/);
  if (hb && DATA.server()) { history.replaceState(null, "", location.pathname); if (await openBrand(decodeURIComponent(hb[1]), { quiet: true })) return; }
  if (DATA.server() && DATA.list.length) return home();
  renderRecent(); $("#startUrl").focus();
})();
/* Presence: tells the server which page of the app this person is on (for the operators' Live view and feature analytics).
   Only a page name from our own navigation and the brand slug are sent, every 45 s while the tab is visible and at once on a change. */
(() => {
  const SECTIONS = ["mission", "onboard", "ready", "reportWrap", "team", "billing", "account", "auth", "landing"];
  const current = () => {
    const sec = SECTIONS.find((id) => { const el = document.getElementById(id); return el && !el.hidden; }) || "landing";
    const page = sec === "reportWrap" ? String(DASH.page || "overview") : sec === "mission" ? "running-check" : sec === "onboard" ? "setup" : sec;
    return { page: page.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 30), brand: ["reportWrap", "mission"].includes(sec) ? APP.M?.slug || null : null };
  };
  let last = "", sentAt = 0;
  const beat = () => {
    if (!APP.user || !DATA.server() || document.visibilityState !== "visible") return;
    const now = current(), key = now.page + "|" + now.brand;
    if (key === last && Date.now() - sentAt < 45000) return;
    last = key; sentAt = Date.now();
    fetch("/api/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(now), credentials: "same-origin", keepalive: true }).catch(() => {});
  };
  setInterval(beat, 3000);
  document.addEventListener("visibilitychange", beat);
})();
/* Instant hover hints. Any element with a title (or data-tip) shows its text in a small bubble as soon as the
   pointer rests on it. The title moves to data-tip on first hover so the browser's own tooltip doesn't double up. */
(() => {
  const el = $("#hint"); let cur = null;
  const place = (t) => {
    const r = t.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    let x = r.left + r.width / 2 - w / 2, y = r.top - h - 8;
    if (y < 8) y = r.bottom + 8;
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    el.style.left = x + "px"; el.style.top = y + "px";
  };
  const hide = () => { cur = null; el.classList.remove("on"); el.hidden = true; };
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest?.("[title],[data-tip]");
    if (!t || t === cur) return;
    if (t.hasAttribute("title")) { const v = t.getAttribute("title"); t.removeAttribute("title"); if (v) t.dataset.tip = v; else return; }
    const txt = t.dataset.tip; if (!txt) return hide();
    cur = t; el.textContent = txt; el.hidden = false; place(t); requestAnimationFrame(() => el.classList.add("on"));
  });
  document.addEventListener("mouseout", (e) => { if (cur && !cur.contains(e.relatedTarget)) hide(); });
  addEventListener("scroll", hide, true); addEventListener("blur", hide);
})();
})();
