// Live check of the Command Deck's write APIs against a running local server, the way the console calls them.
// Plans (create, read, update, delete), plan assignment, accounts (create, rename, suspend, resume, delete), people (invite, accept,
// change role, hand over ownership, remove, revoke) and operators (add, change, remove). Everything it creates it deletes again;
// the people it signs up use *@demo.test so `seed-console.mjs --clean` removes them too.
//
//   node scripts/verify-console-api.mjs [http://localhost:3210]
// Operator sign-in: the seed's local fixture (scripts/seed-console.mjs).
const BASE = process.argv[2] || "http://localhost:3210";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) { console.error("Refusing: local servers only."); process.exit(1); }
const jars = {};
async function call(who, method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(jars[who] ? { cookie: jars[who] } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie"); if (set) jars[who] = set.split(";")[0];
  let data; try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}
let pass = 0, failN = 0;
const check = (ok, label, got) => { if (ok) { pass++; console.log("  ✔", label); } else { failN++; console.log("  ✖", label, "→", JSON.stringify(got)?.slice(0, 200)); } };
const section = (t) => console.log("\n" + t);
const stamp = Date.now().toString(36), ip = { "x-forwarded-for": "10.77." + (Date.now() % 250) + ".1" };

const login = await call("op", "POST", "/api/auth/login", { email: "founder@demo.test", password: "demo-founder-pass" });
check(login.status === 200, "operator signs in", login);
const C = (m, p, b) => call("op", m, "/api/admin/console/" + p, b);

// A run that stopped half-way leaves its account and plan behind; clear them first (only what this script makes, by its own markers).
const left = await C("GET", "customers-page?accounts=all");
for (const a of (left.data?.accounts || []).filter((a) => /^Verify (Co|Renamed) [0-9a-z]+$/.test(a.name))) {
  await C("DELETE", `accounts/${a.slug}`, { confirm: a.slug, reason: "verify cleanup of an earlier run" });
}
for (const p of ((await call("op", "GET", "/api/admin/plans")).data?.plans || []).filter((p) => p.description === "made by verify-console-api")) {
  await call("op", "DELETE", "/api/admin/plans/" + p.code);
}

section("Plans: create, read, update, delete");
const code = "verify-" + stamp, plan = { name: "Verify plan", description: "made by verify-console-api", public: false, selfServe: false, active: true, aiCapUsd: 12,
  limits: { brands: 2, questions: 40, seats: 3, drafts: 20, checks: 8 }, engines: ["chatgpt", "gemini"], schedules: ["off", "weekly"], integrations: ["bing"], prices: { INR: { amount: 149900 } } };
let r = await call("op", "PUT", "/api/admin/plans/" + code, plan); check(r.status === 200 && r.data.plan.code === code, "create a plan", r);
r = await call("op", "GET", "/api/admin/plans"); const got = r.data.plans.find((p) => p.code === code);
check(got && got.prices.INR.amount === 149900 && got.limits.brands === 2 && got.limits.checks === 8, "read it back with prices and limits", got);
r = await call("op", "PUT", "/api/admin/plans/" + code, { ...plan, limits: { ...plan.limits, brands: 4 }, prices: { INR: { amount: 199900 } } });
check(r.status === 200 && r.data.plan.limits.brands === 4 && r.data.plan.prices.INR.amount === 199900, "update limits and price", r.data?.plan);
r = await call("op", "PUT", "/api/admin/plans/Bad Code", plan); check(r.status === 400, "bad plan code refused", r);
r = await call("op", "PUT", "/api/admin/plans/" + code, { ...plan, prices: { INR: { amount: -5 } } }); check(r.status === 400, "negative price refused", r);
r = await call("op", "PUT", "/api/admin/plans/" + code, { ...plan, engines: ["nope"] }); check(r.status === 400, "unknown engine refused", r);
r = await call("op", "DELETE", "/api/admin/plans/legacy"); check(r.status === 400, "built-in plan can't be deleted", r);

section("Accounts: create, rename, suspend, resume");
const owner = `owner-${stamp}@demo.test`;
r = await C("POST", "accounts", { name: "Verify Co " + stamp, ownerEmail: owner, start: "new" });
check(r.status === 200 && r.data.invite?.link, "create an account and invite its owner", r);
const slug = r.data.account.slug, ownerToken = r.data.invite.link.split("#invite=")[1];
r = await C("POST", "accounts", { name: "x", ownerEmail: owner }); check(r.status === 400, "too-short name refused", r);
r = await C("POST", "accounts", { name: "Valid", ownerEmail: "not-an-email" }); check(r.status === 400, "bad owner email refused", r);
r = await C("GET", `customers/${slug}`); check(r.status === 200 && r.data.org.billing_status === "new" && r.data.invites.length === 1, "account exists, waiting on a plan, owner invite pending", r.data?.org);
r = await C("PATCH", `accounts/${slug}`, { name: "Verify Renamed " + stamp }); check(r.status === 200 && r.data.account.name.startsWith("Verify Renamed"), "rename", r);
r = await C("PATCH", `accounts/${slug}`, { suspended: true }); check(r.status === 400, "suspend needs a reason", r);
r = await C("PATCH", `accounts/${slug}`, { suspended: true, reason: "verify run" }); check(r.status === 200 && r.data.account.paused_at, "suspend", r);

section("People: owner accepts, invite, change role, hand over, remove, revoke");
r = await call("own", "POST", "/api/auth/signup", { email: owner, password: "verify-pass-1", invite: ownerToken }, ip); check(r.status === 200, "owner accepts the invite by signing up", r);
r = await call("own", "POST", "/api/workspaces", { name: "Should fail" }).catch(() => null);
r = await call("own", "PUT", "/api/workspaces/should-fail", { name: "Should fail", setup: {} }); check(r.status === 403 && r.data?.code === "suspended", "a suspended account can't create a brand (403 suspended, no upgrade prompt)", r);
r = await C("PATCH", `accounts/${slug}`, { suspended: false, reason: "verify run done" }); check(r.status === 200 && !r.data.account.paused_at, "resume", r);
const mate = `mate-${stamp}@demo.test`;
r = await C("POST", `accounts/${slug}/people`, { email: mate, role: "editor" }); check(r.status === 200 && r.data.invite.role === "editor", "invite an editor", r);
const mateToken = r.data.invite.link.split("#invite=")[1];
r = await C("POST", `accounts/${slug}/people`, { email: owner, role: "viewer" }); check(r.status === 409, "can't invite someone already in it", r);
r = await C("POST", `accounts/${slug}/people`, { email: "x@demo.test", role: "superuser" }); check(r.status === 400, "unknown role refused", r);
r = await C("POST", `accounts/${slug}/people`, { email: "second-owner@demo.test", role: "owner" }); check(r.status === 409, "a second owner refused", r);
r = await call("mate", "POST", "/api/auth/signup", { email: mate, password: "verify-pass-2", invite: mateToken }, ip); check(r.status === 200, "editor accepts", r);
r = await C("GET", `accounts/${slug}/people`); const ppl = r.data.members, mateRow = ppl.find((m) => m.email === mate), ownerRow = ppl.find((m) => m.email === owner);
check(ppl.length === 2 && mateRow?.role === "editor" && ownerRow?.role === "owner", "two members, right roles", ppl);
r = await C("PATCH", `accounts/${slug}/people/${mateRow.id}`, { role: "admin" }); check(r.status === 200 && r.data.members.find((m) => m.email === mate).role === "admin", "change editor → admin", r);
r = await C("PATCH", `accounts/${slug}/people/${ownerRow.id}`, { role: "viewer" }); check(r.status === 409, "owner can't be demoted without a hand-over", r);
r = await C("PATCH", `accounts/${slug}/people/${mateRow.id}`, { role: "owner" });
check(r.status === 200 && r.data.members.find((m) => m.email === mate).role === "owner" && r.data.members.find((m) => m.email === owner).role === "admin", "hand over ownership (old owner becomes admin)", r.data?.members);
r = await C("DELETE", `accounts/${slug}/people/${mateRow.id}`); check(r.status === 409, "the owner can't be removed", r);
r = await C("DELETE", `accounts/${slug}/people/${ownerRow.id}`); check(r.status === 200 && r.data.members.length === 1, "remove a member", r);
r = await C("POST", `accounts/${slug}/people`, { email: `late-${stamp}@demo.test`, role: "viewer" }); const invId = r.data?.invite?.id;
r = await C("DELETE", `accounts/${slug}/invites/${invId}`); check(r.status === 200 && !r.data.invites.some((i) => i.id === invId), "revoke an invite", r);
r = await C("DELETE", `accounts/${slug}/invites/${invId}`); check(r.status === 404, "revoking twice is a 404", r);

section("Plan assignment (no card) and modification");
const until = new Date(Date.now() + 30 * 864e5).toISOString();
r = await call("op", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: code, status: "active", periodEndsAt: until }); check(r.status === 400, "assignment needs a reason", r);
r = await call("op", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: "nope", status: "active", periodEndsAt: until, reason: "verify" }); check(r.status === 400, "unknown plan refused", r);
r = await call("op", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: code, status: "active", reason: "verify" }); check(r.status === 400, "a paid grant needs an end date", r);
r = await call("op", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: code, status: "active", periodEndsAt: until, reason: "verify contract", overrides: { values: { seats: 9 }, expiresAt: until } });
check(r.status === 200 && r.data.billing.plan.code === code && r.data.billing.limits.seats === 9 && r.data.billing.limits.brands === 4, "assign the plan as a contract with a custom seat limit", r.data?.billing?.limits);
r = await C("GET", `customers/${slug}`); const s = r.data.subscription;
check(s.planCode === code && s.status === "active" && s.payment.startsWith("Invoiced") && s.overrides?.values?.seats === 9 && s.price === 199900, "drawer shows plan, status, payment, price and override", s);
r = await call("op", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: "growth", status: "trialing", trialEndsAt: until, reason: "verify trial" });
check(r.status === 200 && r.data.billing.plan.status === "trialing", "modify: move to a trial", r.data?.billing?.plan);
r = await call("op", "PATCH", `/api/admin/orgs/${slug}/billing`, { plan: "legacy", status: "internal", reason: "verify internal", overrides: null }); check(r.status === 200 && r.data.billing.mode === "write", "modify: internal, unlimited", r.data?.billing);
r = await C("POST", `customers/${slug}/change-plan`, { plan: "agency", reason: "verify" }); check([409, 503].includes(r.status), `change-plan without a Razorpay subscription is refused (${r.status})`, r);
r = await C("POST", `customers/${slug}/cancel`, { reason: "verify" }); check([409, 503].includes(r.status), `cancel without a subscription is refused (${r.status})`, r);
r = await call("op", "DELETE", "/api/admin/plans/" + code); check(r.status === 200, "plan with nobody on it is deleted", r);
r = await call("op", "GET", "/api/admin/plans"); check(!r.data.plans.some((p) => p.code === code), "and is gone", null);

section("Operators: add, change, deactivate, remove");
r = await C("POST", "operators", { email: "nobody-" + stamp + "@demo.test", role: "support" }); check(r.status === 404, "unknown person refused", r);
r = await C("POST", "operators", { email: mate, role: "support" }); check(r.status === 200, "add a support operator (invited people have verified emails)", r);
r = await C("GET", "operators"); const opRow = r.data.operators.find((o) => o.email === mate); check(opRow?.role === "support" && opRow.active, "listed as support", opRow);
r = await call("mate", "GET", "/api/admin/console/me"); check(r.data?.role === "support", "they can open the console as support", r.data);
r = await C("PATCH", `operators/${opRow.id}`, { role: "analyst" }); check(r.status === 200 && r.data.operator.role === "analyst", "change role", r);
r = await C("PATCH", `operators/${opRow.id}`, { active: false }); check(r.status === 200, "deactivate", r);
r = await call("mate", "GET", "/api/admin/console/me"); check(r.status === 404, "deactivated operator gets 404", r);
r = await C("DELETE", `operators/${opRow.id}`); check(r.status === 200, "remove", r);

section("Delete the account");
r = await C("DELETE", `accounts/${slug}`, { reason: "verify" }); check(r.status === 400, "delete needs the typed id", r);
r = await C("DELETE", `accounts/${slug}`, { confirm: slug, reason: "verify cleanup" }); check(r.status === 200 && r.data.deleted === slug, "delete", r);
r = await C("GET", `customers/${slug}`); check(r.status === 404, "it's gone", r);

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
