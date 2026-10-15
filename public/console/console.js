/* Command Deck in the Founder Command design: one page per hash (#pulse, #growth, #value, #customers, #subscriptions, #revenue, #margin,
   #subscriptions, #platform, #audit), drawn with the results dashboard's own classes from app.css. */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICONS = {
  today: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  rupee: '<path d="M7 5h10M7 9h10M9 5c3.5 0 5 1.6 5 4s-1.5 4-5 4H7l7 6"/>',
  margin: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.6c2.4-.3 4.3 1 5 3.9"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h3"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  live: '<circle cx="12" cy="12" r="2.2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  insight: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  growth: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
  value: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  ops: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  spark: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3M14 9l2 2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};
const icon = (k, s = 16) => `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ""}</svg>`;
const paintIcons = (root = document) => $$("i[data-ic]", root).forEach((el) => { el.outerHTML = icon(el.dataset.ic); });

/* ── formatting ── */
const nf = new Intl.NumberFormat("en-IN");
const inr = (minor, exact) => {
  const r = (minor || 0) / 100;
  if (!exact && r >= 1e7) return "₹" + (r / 1e7).toFixed(2) + " Cr";
  if (!exact && r >= 1e5) return "₹" + (r / 1e5).toFixed(2) + " L";
  return "₹" + nf.format(Math.round(r));
};
const money = (minor, ccy) => (ccy === "USD" ? "$" + nf.format(Math.round(minor / 100)) : inr(minor, true));
const usd = (n, d = 2) => "$" + Number(n || 0).toFixed(d);
const pct = (n) => (n == null ? "—" : n + "%");
const num = (n) => nf.format(n || 0);
const count = (n, one, many = one + "s") => `${num(n)} ${n === 1 ? one : many}`;
const dt = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const dtm = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const ago = (d) => {
  if (!d) return "never";
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
};
const until = (d) => { if (!d) return "—"; const days = Math.ceil((new Date(d) - Date.now()) / 864e5); return days < 0 ? `${-days} d ago` : days === 0 ? "today" : `in ${days} d`; };
const STATUS = { active: ["Active", "good"], trialing: ["Trial", "info"], past_due: ["Past due", "bad"], canceled: ["Cancelled", ""], new: ["No plan yet", "warn"], internal: ["Internal", ""] };
const status = (s) => { const [l, t] = STATUS[s] || [s, ""]; return `<span class="cd-st ${t}">${esc(l)}</span>`; };
const RUN = { done: "good", failed: "bad", running: "info", stopped: "" };
const BAND = { Thriving: "var(--good)", Steady: "var(--src)", "At risk": "var(--warn)", Dormant: "var(--bad)" };
const healthChip = (score, band) => `<span class="cd-h" title="${esc(band)}"><i><b style="width:${score}%;background:${BAND[band] || "var(--muted)"}"></b></i>${score}</span>`;
const marginTone = (m) => (m == null ? "" : m < 0 ? "bad" : m < 60 ? "warn" : "good");

/* ── data ── */
// Every console read carries the global filter bar (accounts, period, demo) so each page answers for the same cohort.
const SCOPE = (() => { try { return { accounts: "customers", days: 30, demo: false, ...JSON.parse(localStorage.getItem("cd.scope") || "{}") }; } catch { return { accounts: "customers", days: 30, demo: false }; } })();
const scopeQs = () => `accounts=${encodeURIComponent(SCOPE.accounts)}&days=${SCOPE.days}${SCOPE.demo ? "&demo=hide" : ""}`;
async function api(method, path, body) {
  const own = !path.startsWith("/"), url = (own ? "/api/admin/console/" + path : path) + (own && method === "GET" ? (path.includes("?") ? "&" : "?") + scopeQs() : "");
  const r = await fetch(url, { method, credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = "/#signin"; throw new Error("Please sign in."); }
  if (!r.ok) throw Object.assign(new Error(d.error || `Server error ${r.status}`), { status: r.status });
  if (d.scope) STATE.meta = { scope: d.scope, asOf: d.asOf || new Date().toISOString() };
  return d;
}
function toast(msg) {
  let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.append(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ── charts: small SVGs that use the theme tokens ── */
function areaChart(rows, key, { h = 180, fmt = num } = {}) {
  const w = 1000, pad = { l: 44, r: 12, t: 12, b: 24 }, vals = rows.map((r) => Number(r[key]) || 0);
  const max = Math.max(1, ...vals), step = (w - pad.l - pad.r) / Math.max(1, rows.length - 1);
  const x = (i) => pad.l + i * step, y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const ticks = [0, max / 2, max];
  const labels = rows.map((r, i) => ({ i, d: r.day })).filter((r) => r.i % 7 === 0 || r.i === rows.length - 1);
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(key)} over the last ${rows.length} days">
    <g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
    <g class="ax">${ticks.map((t) => `<text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`).join("")}
      ${labels.map((l) => `<text x="${x(l.i)}" y="${h - 6}" text-anchor="middle">${esc(new Date(l.d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }))}</text>`).join("")}</g>
    <path class="area" d="M${pts[0]} L${pts.join(" L")} L${x(rows.length - 1)},${y(0)} L${x(0)},${y(0)} Z"/>
    <path class="ln" d="M${pts.join(" L")}"/>
    <circle class="end" cx="${x(rows.length - 1)}" cy="${y(vals.at(-1))}" r="3.5"/></svg>`;
}
function lineChart(rows, series, { h = 220, dates = true } = {}) {
  const lab = (r, o) => (dates ? new Date(r.day).toLocaleDateString("en-IN", o) : String(r.day));
  const w = 1000, pad = { l: 40, r: 12, t: 12, b: 24 }, max = Math.max(1, ...rows.flatMap((r) => series.map((x) => Number(r[x.key]) || 0)));
  const step = (w - pad.l - pad.r) / Math.max(1, rows.length - 1), x = (i) => pad.l + i * step, y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max], every = Math.max(1, Math.round(rows.length / 6));
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(series.map((x) => x.label).join(", "))} per day">
    <g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
    <g class="ax">${ticks.map((t) => `<text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}
      ${rows.map((r, i) => (i % every && i !== rows.length - 1 ? "" : `<text x="${x(i)}" y="${h - 6}" text-anchor="middle">${esc(lab(r, { day: "numeric", month: "short" }))}</text>`)).join("")}</g>
    <g class="hit">${rows.map((r, i) => `<rect x="${(x(i) - step / 2).toFixed(1)}" y="${pad.t}" width="${Math.max(1, step).toFixed(1)}" height="${h - pad.t - pad.b}" data-tip="${esc(lab(r, { weekday: "short", day: "numeric", month: "short" }) + " · " + series.map((sr) => `${sr.label} ${r[sr.key] ?? 0}`).join(" · "))}"/>`).join("")}</g>
    ${series.map((sr) => { const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(Number(r[sr.key]) || 0).toFixed(1)}`);
      return `<path class="ml ${sr.cls}" d="M${pts.join(" L")}"/><circle class="me ${sr.cls}" cx="${x(rows.length - 1)}" cy="${y(Number(rows.at(-1)?.[sr.key]) || 0)}" r="3.5"><title>${esc(sr.label)}: ${rows.at(-1)?.[sr.key]}</title></circle>`; }).join("")}</svg>
    <div class="cd-legend">${series.map((sr) => `<span><i class="${sr.cls}"></i>${esc(sr.label)}</span>`).join("")}</div>`;
}

/* Heat cells: one hue (the petal), intensity = value. Text flips to light on the darker half. */
const heat = (v, max = 100) => { const t = Math.max(0, Math.min(1, (v || 0) / (max || 1))); return `style="background:color-mix(in srgb, var(--petal) ${Math.round(8 + t * 82)}%, #fff);${t > 0.72 ? "color:#fff;" : ""}"`; };
/* Vertical bars with a highlighted last item and a value tooltip on every bar. */
function columns(rows, key, label, { h = 180, fmt = num, last = true } = {}) {
  const w = 1000, pad = { l: 36, r: 8, t: 14, b: 24 }, max = Math.max(1, ...rows.map((r) => r[key] || 0)), gw = (w - pad.l - pad.r) / rows.length, bw = Math.min(46, gw * 0.62);
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max), ticks = [0, Math.round(max / 2), max];
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
    <g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
    <g class="ax">${ticks.map((t) => `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}${rows.map((r, i) => `<text x="${pad.l + gw * i + gw / 2}" y="${h - 7}" text-anchor="middle">${esc(r.week || r.month || "")}</text>`).join("")}</g>
    ${rows.map((r, i) => { const v = r[key] || 0, x0 = pad.l + gw * i + (gw - bw) / 2; return `<rect class="col${last && i === rows.length - 1 ? " now" : ""}" x="${x0}" y="${y(v)}" width="${bw}" height="${Math.max(0, y(0) - y(v))}" rx="4" data-tip="${esc((r.week || r.month || "") + " · " + label + ": " + fmt(v))}"/>`; }).join("")}</svg>`;
}
function spark(vals) {
  if (!vals.length) return "";
  const w = 120, h = 28, max = Math.max(1, ...vals), step = w / Math.max(1, vals.length - 1);
  const p = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (h - 4) * (v / max)).toFixed(1)}`);
  return `<svg class="cd-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="M${p.join(" L")} L${w},${h} L0,${h} Z"/><path class="l" d="M${p.join(" L")}"/></svg>`;
}
function groupedBars(rows, keys, labels, { h = 200 } = {}) {
  const w = 1000, pad = { l: 36, r: 8, t: 10, b: 26 }, max = Math.max(1, ...rows.flatMap((r) => keys.map((k) => r[k] || 0)));
  const gw = (w - pad.l - pad.r) / rows.length, bw = Math.min(22, (gw - 12) / keys.length);
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(labels.join(", "))} by month">
    <g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
    <g class="ax">${ticks.map((t) => `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}
      ${rows.map((r, i) => `<text x="${pad.l + gw * i + gw / 2}" y="${h - 7}" text-anchor="middle">${esc(r.month)}</text>`).join("")}</g>
    ${rows.map((r, i) => keys.map((k, j) => { const v = r[k] || 0, x0 = pad.l + gw * i + (gw - bw * keys.length) / 2 + j * bw;
      return `<rect class="bar s${j}" x="${x0 + 1}" y="${y(v)}" width="${bw - 2}" height="${Math.max(0, y(0) - y(v))}" rx="3"><title>${esc(labels[j])}: ${v}</title></rect>`; }).join("")).join("")}</svg>
    `;
}
const bars = (rows, label, value, fmt, cls = "") => {
  const max = Math.max(1e-9, ...rows.map(value));
  return rows.length ? `<div class="cd-bars">${rows.map((r) => `<div class="cd-bar"><span title="${esc(label(r))}">${esc(label(r))}</span><span class="cd-track ${cls}"><i style="width:${(100 * value(r)) / max}%"></i></span><span class="v">${esc(fmt(r))}</span></div>`).join("")}</div>`
    : `<div class="cd-empty">Nothing yet.</div>`;
};
// Section card: optional mono eyebrow, description and provenance footer, as in Founder Command.
const card = (title, body, extra = "", o = {}) => `<section class="card"${o.id ? ` id="${o.id}"` : ""}><div class="card-h"><div>${o.eyebrow ? `<span class="eyebrow">${esc(o.eyebrow)}</span>` : ""}<b>${title}</b>${o.desc ? `<p>${o.desc}</p>` : ""}</div>${extra}</div>${body}${o.foot ? `<div class="fc-foot">${o.foot}</div>` : ""}</section>`;
const fcSpark = (vals) => { if (!vals?.length) return ""; const w = 74, h = 26, max = Math.max(1, ...vals), st = w / Math.max(1, vals.length - 1), p = vals.map((v, i) => `${(i * st).toFixed(1)},${(h - 3 - (h - 6) * (v / max)).toFixed(1)}`);
  return `<svg class="fc-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="l" d="M${p.join(" L")}"/><circle cx="${w}" cy="${p.at(-1).split(",")[1]}" r="2.5"/></svg>`; };
const delta = (now, before) => { if (!before) return ""; const v = Math.round(((now - before) / before) * 100); return `<span class="fc-delta ${v > 0 ? "" : v < 0 ? "down" : "flat"}" title="Last 7 days against the 7 before">${v > 0 ? "▲ +" : v < 0 ? "▼ " : ""}${v}%</span>`; };
// Stat card: label, big number, sub-line; optional delta pill (top right), sparkline (bottom right), dark or lime variant.
// o.go: the whole card opens that page (hash), e.g. the list behind the number.
const kpi = (label, value, sub = "", tip = "", o = {}) => `<div class="kpi${o.cls ? " " + o.cls : ""}${o.go ? " go" : ""}"${o.go ? ` data-go="${esc(o.go)}" role="link" tabindex="0" aria-label="${esc(label)}: open the list"` : ""}><span class="kl">${esc(label)}${tip ? `<button type="button" class="kpi-i" data-info="${esc(tip)}" aria-label="What is ${esc(label)}?" aria-expanded="false">${icon("info", 13)}</button>` : ""}${o.go ? `<span class="kpi-go" aria-hidden="true">View →</span>` : ""}</span><span class="kv">${value}</span>${sub ? `<span class="dl">${sub}</span>` : ""}${o.delta || ""}${o.spark ? fcSpark(o.spark) : ""}</div>`;
const table = (cols, rows, { click } = {}) => rows.length
  ? `<div class="cd-scroll"><table class="tbl${click ? " click" : ""}"><thead><tr>${cols.map((c) => `<th${c.r ? ' class="r"' : ""}>${esc(c.h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr${click ? ` data-go="${esc(click(r))}" tabindex="0"` : ""}>${cols.map((c) => `<td${c.r ? ' class="r"' : ""}>${c.v(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
  : `<div class="cd-empty">No rows for this selection.</div>`;
// Pages the Accounts / Period / demo filters don't apply to say what they do cover instead.
const UNSCOPED = { live: "everyone in White Petal right now · filters don't apply", releases: "whole platform · filters don't apply", team: "whole platform · filters don't apply" };
// Page header: eyebrow (the nav group), title, purpose, and the provenance line every Founder Command page carries.
const pageHead = (title, sub, chips = "") => { const m = STATE.meta, grp = GROUP[STATE.page] || "Company";
  return `<div class="pg-hd"><div><span class="eyebrow">${icon(PAGE_ICON[STATE.page] || "pulse", 13)}${esc(grp)}</span><h2>${esc(title)}</h2><p>${sub}</p></div>
    <div class="fc-prov">${m ? `<span>As of <b>${esc(new Date(m.asOf).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }))} UTC</b> · ${esc((STATE.me?.env || "").toLowerCase())} · ${esc(UNSCOPED[STATE.page] || m.scope.label)}</span>` : ""}${chips ? `<span class="fc-chips">${chips}</span>` : ""}</div></div>`; };
const GROUP = { fit: "Revenue", pulse: "Company", growth: "Company", value: "Company", customers: "Company", subscriptions: "Revenue", revenue: "Revenue", margin: "Revenue", plans: "Revenue",
  live: "Platform", operations: "Platform", ai: "Platform", integrations: "Platform", releases: "Platform", team: "Platform" };
const PAGE_ICON = { fit: "margin", pulse: "pulse", growth: "growth", value: "value", customers: "team", subscriptions: "card", revenue: "rupee", margin: "margin", plans: "doc", live: "live", operations: "ops", ai: "spark", integrations: "link", releases: "flag", team: "team" };
const A = (slug) => `${STATE.page}?account=${slug}`; // open an account's drawer over the current page
const wk = (d, i, n) => (i === n - 1 ? "This wk" : new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }));
const hrs = (h) => (h == null ? "—" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} d`);
const ratio = (n, of) => (of ? `${Math.round((1000 * n) / of) / 10}%` : "—");
const chip = (text, tone = "") => `<span class="fc-chip"><i class="${tone}"></i>${esc(text)}</span>`;
// Stacked weekly bars with the total above each week (Founder Command's product-engine chart).
function stackWeeks(rows, keys, labels, { h = 220 } = {}) {
  const w = 1000, pad = { l: 34, r: 8, t: 22, b: 26 }, tot = (r) => keys.reduce((t, k) => t + (r[k] || 0), 0), max = Math.max(1, ...rows.map(tot));
  const gw = (w - pad.l - pad.r) / rows.length, bw = Math.min(54, gw * 0.62), y = (v) => (h - pad.t - pad.b) * (v / max), ticks = [0, Math.round(max / 2), max];
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(labels.join(", "))} per week">
    <g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b - y(t)}" y2="${h - pad.b - y(t)}"/>`).join("")}</g>
    <g class="ax">${ticks.map((t) => `<text x="${pad.l - 6}" y="${h - pad.b - y(t) + 4}" text-anchor="end">${t}</text>`).join("")}${rows.map((r, i) => `<text x="${pad.l + gw * i + gw / 2}" y="${h - 7}" text-anchor="middle">${esc(wk(r.week, i, rows.length))}</text>`).join("")}</g>
    ${rows.map((r, i) => { let base = h - pad.b; const x0 = pad.l + gw * i + (gw - bw) / 2, tip = `${wk(r.week, i, rows.length)} · ` + keys.map((k, j) => `${labels[j]} ${r[k] || 0}`).join(" · ");
      return keys.map((k, j) => { const hh = y(r[k] || 0); base -= hh; return hh ? `<rect class="stk s${j}" x="${x0}" y="${base}" width="${bw}" height="${hh}" rx="3" data-tip="${esc(tip)}"/>` : ""; }).join("")
        + `<text class="val" x="${x0 + bw / 2}" y="${base - 6}" text-anchor="middle">${tot(r)}</text><rect class="hitm" x="${x0}" y="${pad.t}" width="${bw}" height="${h - pad.t - pad.b}" data-tip="${esc(tip)}"/>`; }).join("")}</svg>`;
}
// "Show as a table" under a chart.
const asTable = (cols, rows) => `<button class="fc-tablebtn" type="button" data-tbl>Show as a table</button><div hidden>${table(cols, rows)}</div>`;
const funnel = (steps, outs, base) => `<div class="fc-funnel">${steps.map(([l, v], i) => `<div class="fc-fstep${i ? "" : " base"}"><span>${esc(l)}</span><b>${num(v)}<small>${i ? ratio(v, base) : ""}</small></b><span class="bar"><i style="width:${base ? (100 * v) / base : 0}%"></i></span></div>`).join("")}
  ${outs ? `<div class="fc-divider">Outcomes (branches, not steps)</div>${outs.map(([l, v]) => `<div class="fc-fstep out"><span>${esc(l)}</span><b>${num(v)}<small>${ratio(v, base)}</small></b><span class="bar"><i style="width:${base ? (100 * v) / base : 0}%"></i></span></div>`).join("")}` : ""}</div>`;
const watchTable = (rows) => rows.length ? table([
  { h: "Brand", v: (b) => `<b>${esc(b.name)}</b><div class="muted cd-sm">${esc(b.org)}</div>` },
  { h: "Stage", v: (b) => `<span class="fc-dot ${b.stageTone}">${esc(b.stage)}</span>` },
  { h: "Last value action", v: (b) => (b.lastAction ? `${esc(ago(b.lastAction.at))} <span class="muted cd-sm">${esc(b.lastAction.what)}</span>` : '<span class="cd-mute">never</span>') },
  { h: "Blocker / evidence", v: (b) => (b.blockers.length ? `<span class="fc-evs">${b.blockers.map((x) => `<span class="fc-ev ${x.tone === "bad" ? "bad" : x.tone === "info" ? "info" : ""}">${icon("alert", 12)}${esc(x.text)}</span>`).join("")}</span>` : '<span class="cd-mute">—</span>') },
], rows, { click: (b) => A(b.org_slug) }) : `<div class="cd-empty"><b>No brands to watch</b>No repeated failures, broken connections, stale data or stuck work.</div>`;

/* ── pages ── */
const PAGES = {
  pulse: { title: "Company Pulse", async draw() {
    const [d, out] = await Promise.all([api("GET", "pulse"), api("GET", "outcomes")]), k = d.kpis, h = d.hero, r = d.revenue, e = d.engine, wks = d.weeks, ok = out.kpis;
    $("#navAttn").textContent = d.attention.reduce((t, a) => t + a.n, 0) || "";
    const sentence = h.brandsThisWeek
      ? `<em>${num(h.brandsThisWeek)} brand${h.brandsThisWeek > 1 ? "s" : ""}</em> ran checks this week, ${num(h.actionsThisWeek)} recovery action${h.actionsThisWeek === 1 ? "" : "s"} moved and ${num(h.draftsThisWeek)} draft${h.draftsThisWeek === 1 ? "" : "s"} were written.${h.needs ? ` ${num(h.needs)} item${h.needs > 1 ? "s" : ""} need you.` : " Nothing needs you."}`
      : "No brand activity in this cohort yet — nothing to report, and nothing estimated.";
    const outcomeLine = ok.comparable ? ` Customers' median AI visibility score is <em>${ok.medianScore}</em>, ${ok.medianDelta >= 0 ? "up" : "down"} ${Math.abs(ok.medianDelta)} points since their first check.` : "";
    const fails = d.watch.filter((b) => b.blockers.some((x) => x.key === "blocked")).length;
    return `${pageHead("Company Pulse", "The investor snapshot: who is active, what they get from White Petal, what needs attention.", chip("Live records", "") + chip(fails ? `${fails} blocked brand${fails > 1 ? "s" : ""}` : "No blocked brands", fails ? "warn" : ""))}
      <section class="fc-hero"><div><span class="eyebrow">This week at White Petal</span><h3>${sentence}${outcomeLine}</h3></div>
        <div class="fc-rev"><span class="eyebrow">Revenue</span><b>${inr(r.mrrInr)}</b><p>Monthly recurring revenue from ${num(r.paying)} paying organisation${r.paying === 1 ? "" : "s"}, before tax. ${r.contractedInr ? `${inr(r.contractedInr)} of it is invoiced contracts.` : ""}</p>
          <dl><div><dt>ARR run rate</dt><dd>${inr(r.arrInr)}</dd></div><div><dt>On trial</dt><dd>${num(r.trials)}</dd></div><div><dt>Past due</dt><dd>${num(r.pastDue)}</dd></div></dl></div></section>
      <div class="kpis">
        ${kpi("Active brands", num(k.active7), `last 7 days · of ${num(k.brands)} brands in cohort`, "Brands with a check, AI call or recovery-action update in the last 7 days. Open the card for the list.", { delta: delta(k.active7, k.prev7), spark: k.activeSpark, go: "customers?health=active" })}
        ${kpi("Median visibility score", ok.medianScore == null ? "—" : `${ok.medianScore}<small>/100</small>`, ok.comparable ? `first check ${ok.medianFirst} → now ${ok.medianLatestComparable} · ${num(ok.brands)} brands` : `${num(ok.brands)} brands with a scored check`,
          "The 0–100 score of each brand's latest check (named in answers 50%, share of voice 20%, position 20%, sentiment 10%), middle value across brands.", { delta: ok.comparable ? `<span class="fc-delta ${ok.medianDelta >= 0 ? "" : "down"}" title="Median change from each brand's first check">${ok.medianDelta >= 0 ? "▲ +" : "▼ "}${ok.medianDelta} pts</span>` : "", spark: out.weekly.map((w) => w.median ?? 0) })}
        ${kpi("Brands improving", `${num(ok.improving)} <small>of ${num(ok.comparable)}</small>`, `${num(ok.flat)} flat · ${num(ok.declining)} declining · score ±5 over 7+ days`, "Brands with two checks at least 7 days apart; improving = latest score 5+ points above the first.", { cls: "lime" })}
        ${kpi("Activation within 7 days", ratio(k.activation.n, k.activation.of), `${num(k.activation.n)} of ${num(k.activation.of)}`, "Brands at least 7 days old whose first completed check came within 7 days of creation.")}
        ${kpi("Week-1 retention", ratio(k.retention.n, k.retention.of), `${num(k.retention.n)} of ${num(k.retention.of)}`, "Brands that checked again in the week after their first-check week. Only fully observed weeks count.")}
        ${kpi("Time to first check", hrs(k.firstCheckH), `median · ${num(k.activation.n)} of ${num(k.brands)} brands activated`)}
      </div>
      ${card("Checks and drafts", `<div class="kpis">
          ${kpi("Checks completed · all time", num(e.checksAll), e.since ? `since ${dt(e.since)}` : "", "", { cls: "dark" })}
          ${kpi("Checks this week", num(e.checksWeek), `${num(e.brandsWeek)} brands · vs ${num(e.checksLastSame)} by this point last week`, "", { delta: delta(e.checksWeek, e.checksLastSame) })}
          ${kpi("Drafts this week", num(e.draftsWeek), "pitches, articles and fix packs")}
          ${kpi("Draft rate", e.checksWeek ? (e.draftsWeek / e.checksWeek).toFixed(1) : "—", e.checksWeek ? "drafts per completed check" : "No checks this week yet")}
          ${kpi("Recovery actions moved", num(e.actionsWeek), "this week: drafting, review, approval, publish, recheck", "", { cls: "lime" })}
        </div>
        <div class="cd-legend"><span><i class="s0"></i>Live checks</span><span><i class="s1"></i>Scheduled checks</span><span><i class="s2"></i>Drafts</span><span class="muted">Weeks start Monday, UTC</span></div>
        <div class="cd-chart">${stackWeeks(wks, ["live", "scheduled", "drafts"], ["Live checks", "Scheduled checks", "Drafts"])}</div>
        ${asTable([{ h: "Week", v: (w) => esc(dt(w.week)) }, { h: "Live checks", r: 1, v: (w) => num(w.live) }, { h: "Scheduled", r: 1, v: (w) => num(w.scheduled) }, { h: "Drafts", r: 1, v: (w) => num(w.drafts) }], wks)}`,
        `<span class="cd-st good">Complete</span><button class="linkbtn" type="button" data-go="value">Product Value ${icon("arrow", 14)}</button>`,
        { eyebrow: "Product engine", desc: "Completed checks (not attempts) and drafted fixes per week. Scheduled checks are stacked under live ones; drafts on top in lime.", foot: `<span>Source <b>White Petal records · runs, usage</b></span><span>Definition <b>v1</b></span>` })}
      ${card("Growth and value", `<div class="cd-chart">${lineChart(wks.map((w) => ({ ...w, day: w.week })), [{ key: "active", label: "Active brands", cls: "c2" }, { key: "checking", label: "Checking brands", cls: "c4" }, { key: "value", label: "Value-producing brands", cls: "c3" }], { h: 230 })}</div>
        ${asTable([{ h: "Week", v: (w) => esc(dt(w.week)) }, { h: "Active", r: 1, v: (w) => num(w.active) }, { h: "Checking", r: 1, v: (w) => num(w.checking) }, { h: "Value-producing", r: 1, v: (w) => num(w.value) }], wks)}`, "",
        { eyebrow: "Weekly, brands", desc: "Brands with qualifying activity, brands that completed a check, and brands whose recovery work was published or rechecked, per Monday-start week (UTC)." })}
      ${card("Value funnel", funnel([["Onboarded", d.funnel.onboarded], ["Profile ready", d.funnel.profiled], ["First check", d.funnel.checked], ["First draft", d.funnel.drafted], ["First approved action", d.funnel.approved]],
          [["Published", d.outcomes.published], ["Recheck scheduled", d.outcomes.recheck], ["Result observed", d.outcomes.observed]], d.funnel.onboarded)
        + `<p class="cd-foot muted">Share of onboarded brands. Outcomes are the brand's current furthest state, so they overlap rather than nest.</p>`, "", { eyebrow: "Distinct brands, all time to report", desc: "Absolute counts over the cohort. Each bar uses onboarded brands as its denominator." })}
      ${card("Needs attention", `<div class="fc-attn">${d.attention.length ? d.attention.map((a) => `<button type="button" class="fc-arow ${a.level === "bad" ? "bad" : ""}" data-go="customers">${icon("alert", 18)}<div><b>${esc(a.title)}</b><p>${esc(a.detail)}</p></div><span class="n">${num(a.n)}</span>${icon("chev", 14)}</button>`).join("") : ""}</div>
        <div class="fc-healthy">${d.healthy.map((t) => `<span>${icon("check", 14)} ${esc(t)}</span>`).join("")}</div>`, "", { eyebrow: "Exceptions first", desc: "Problems that need a founder, with the evidence and where to act. Healthy checks fold into one line." })}
      ${card("Brands to watch", watchTable(d.watch), "", { eyebrow: "Evidence, not a score", desc: "Ordered by blocker: repeated check failures, broken connections, stale data, no check after 7 days, approved work unused — then most recently active." })}`;
  } },

  growth: { title: "Growth", async draw(arg) {
    const [p, g, a, u] = await Promise.all([api("GET", "pulse"), api("GET", "engagement"), api("GET", "activity"), api("GET", "usage-depth")]), k = p.kpis, n = a.now, act = g.activation || {}, uk = u.kpis;
    return `${pageHead("Growth", "Activation, funnel, retention and weekly movement.")}
      <div class="cd-findings">${g.findings.map((f) => `<article class="cd-finding ${f.tone}"><b>${esc(f.title)}</b><p>${esc(f.body)}</p></article>`).join("")}</div>
      <div class="kpis">
        ${kpi("Active brands", num(k.active7), `last 7 days · of ${num(k.brands)} brands in cohort`, "", { delta: delta(k.active7, k.prev7), spark: k.activeSpark })}
        ${kpi("Activation within 7 days", ratio(k.activation.n, k.activation.of), `${num(k.activation.n)} of ${num(k.activation.of)}`)}
        ${kpi("Week-1 retention", ratio(k.retention.n, k.retention.of), `${num(k.retention.n)} of ${num(k.retention.of)}`)}
        ${kpi("Time to first check", hrs(k.firstCheckH), `median · p90 ${hrs(k.firstCheckP90H)}`)}
      </div>
      <div class="grid2">
        ${card("Cohort funnel (distinct brands)", funnel([["Onboarded", p.funnel.onboarded], ["Profile ready", p.funnel.profiled], ["First check", p.funnel.checked], ["First draft", p.funnel.drafted], ["First approved action", p.funnel.approved]],
            [["Published", p.outcomes.published], ["Result observed", p.outcomes.observed]], p.funnel.onboarded), "", { eyebrow: "All time to report", desc: "Independent milestone counts over the same cohort. Outcomes branch rather than nest." })}
        ${card("Time to value", `<dl class="cd-dl cd-ttv">
            <div><dt>Median time to first check</dt><dd>${hrs(act.h_to_check)}</dd></div><div><dt>Median time to first draft</dt><dd>${hrs(act.h_to_draft)}</dd></div>
            <div><dt>Checked on day one</dt><dd>${ratio(act.checked_1d || 0, act.orgs)}</dd></div><div><dt>Checked in week one</dt><dd>${ratio(act.checked_7d || 0, act.orgs)}</dd></div>
            <div><dt>Median days to first payment</dt><dd>${act.d_to_paid ?? "—"}</dd></div><div><dt>New organisations, 90 days</dt><dd>${num(act.orgs || 0)}</dd></div></dl>`, "",
            { eyebrow: "Organisations created in 90 days", foot: `<span>Source <b>White Petal records</b></span><span>Among organisations that reached each step; non-activators are not in the medians.</span>` })}
      </div>
      ${card("Usage depth", `<div class="kpis">
          ${kpi("Questions tracked", num(uk.questions), `${num(uk.configured)} of ${num(uk.brands)} brands set up`, "", { cls: "dark" })}
          ${kpi("Questions per brand", num(uk.medianQuestions), `median · p90 ${num(uk.p90Questions)}`)}
          ${kpi("Engines per brand", num(uk.medianEngines), `median · ${num(uk.medianCompetitors)} competitors`)}
          ${kpi("Answers collected", num(uk.answers12w), "last 12 weeks")}
        </div>
        <div class="cd-chart">${stackWeeks(u.weekly, ["answers"], ["Answers"])}</div>`, "", { eyebrow: "What customers track", desc: "Questions × engines × answers per question × check frequency: the volume White Petal delivers, and what plans are priced on." })}
      <div class="grid2">
        ${card("Question intent", bars(u.intents, (x) => x.key, (x) => x.n, (x) => num(x.n), "p"), "", { eyebrow: "Tracked questions", desc: "Which buying stage customers watch. Decision questions are closest to revenue." })}
        ${card("Questions per brand", bars(u.questionsHist, (x) => x.key, (x) => x.n, (x) => `${num(x.n)} brands`), "", { eyebrow: "Distribution" })}
      </div>
      <div class="grid2">
        ${card("Engines tracked", bars(u.engines, (x) => x.engine, (x) => x.brands, (x) => `${num(x.brands)} brands`, "p"), "", { eyebrow: "Brands per engine" })}
        ${card("Automatic checks", bars(u.schedules, (x) => (x.key === "off" ? "Off (live only)" : x.key[0].toUpperCase() + x.key.slice(1)), (x) => x.n, (x) => `${num(x.n)} brands`), "", { eyebrow: "Schedule mix", desc: "Daily costs about 7× weekly; brands with no schedule only check when someone runs one." })}
      </div>
      ${card("Weekly movement", `<div class="cd-chart">${lineChart(p.weeks.map((w) => ({ ...w, day: w.week })), [{ key: "active", label: "Active brands", cls: "c2" }, { key: "checking", label: "Checking brands", cls: "c4" }, { key: "value", label: "Value-producing brands", cls: "c3" }], { h: 230 })}</div>`, "",
        { eyebrow: "12 weeks · Monday-start, UTC", desc: "Active, checking and value-producing brands." })}
      ${card("Active people", `<div class="kpis">${kpi("Daily", num(n.dau), "today")}${kpi("Weekly", num(n.wau), "last 7 days")}${kpi("Monthly", num(n.mau), `of ${count(n.users, "account")}`)}${kpi("Stickiness", pct(n.stickiness), "daily ÷ monthly")}</div>
        <div class="cd-chart">${lineChart(a.series, [{ key: "mau", label: "Monthly active", cls: "c3" }, { key: "wau", label: "Weekly active", cls: "c2" }, { key: "dau", label: "Daily active", cls: "c1" }])}</div>`,
        "", { eyebrow: `People, not brands · last ${a.days} days`, desc: "Signed in, ran a check, used the AI or changed anything. Weekly and monthly are rolling windows ending that day. Follows the Period and Accounts filters." })}
      ${card("Retention by sign-up week", g.cohorts.length ? `<div class="cd-scroll"><table class="cd-heat"><thead><tr><th>Cohort</th><th class="r">People</th>${Array.from({ length: 8 }, (_, i) => `<th>W${i}</th>`).join("")}</tr></thead><tbody>
          ${g.cohorts.map((c) => `<tr><td>${esc(c.cohort)}</td><td class="r">${c.size}</td>${Array.from({ length: 8 }, (_, i) => (i < c.weeks.length ? `<td ${heat(c.weeks[i])} data-tip="${esc(`${c.cohort} cohort, week ${i}: ${c.weeks[i]}% active`)}">${c.weeks[i]}%</td>` : '<td class="na"></td>')).join("")}</tr>`).join("")}</tbody></table></div>`
        : '<div class="cd-empty">No sign-ups in the last 8 weeks.</div>', "", { eyebrow: "Cohorts", desc: "Share of each week's new sign-ups who did anything in the app in each following week." })}
      <div class="grid2">
        ${card("Feature adoption", bars(g.adoption.slice(0, 12), (x) => x.page, (x) => x.pct, (x) => `${x.pct}% · ${num(x.users)}`, "p"), "", { eyebrow: "30 days", desc: "Share of active people who opened each page." })}
        ${card("Depth per active organisation", `<div class="cd-chart">${lineChart(g.depth.map((x) => ({ ...x, day: x.week })), [{ key: "ai_calls", label: "AI calls", cls: "c1" }, { key: "checks", label: "Checks", cls: "c4" }], { h: 200, dates: false })}</div>`, "", { eyebrow: "Per week" })}
      </div>`;
  } },

  value: { title: "Product Value", async draw() {
    const d = await api("GET", "value"), c = d.checks, ap = d.approval, pe = d.period, st = d.actionsByStatus, days = STATE.meta?.scope?.days || 30;
    const flow = [["Suggested", st.suggested], ["Drafting", st.drafting], ["Ready for review", st.ready_for_review], ["Approved", st.approved], ["Published", st.published], ["Recheck scheduled", st.recheck_scheduled], ["Result observed", st.result_observed], ["Archived", st.archived]];
    const o = await api("GET", "outcomes"), ok = o.kpis, rc = o.rechecks, GAPN = { decision: "Decision (act)", consideration: "Consideration (compare)", discovery: "Discovery (research)" };
    const brandRow = [{ h: "Brand", v: (b) => `<b>${esc(b.name)}</b><div class="muted cd-sm">${esc(b.org)} · ${esc(b.plan)}</div>` }, { h: "First", r: 1, v: (b) => num(Math.round(b.firstScore)) },
      { h: "Now", r: 1, v: (b) => `<b>${num(Math.round(b.score))}</b>` }, { h: "Change", r: 1, v: (b) => `<span class="cd-st ${b.delta >= 5 ? "good" : b.delta <= -5 ? "bad" : ""}">${b.delta > 0 ? "+" : ""}${b.delta}</span>` },
      { h: "Rank", r: 1, v: (b) => (b.rank ? `#${b.rank}${b.brands ? ` of ${b.brands}` : ""}` : "—") }, { h: "Leader", v: (b) => (b.youLead ? '<span class="cd-st lime">them</span>' : esc(b.leader || "—")) }];
    return `${pageHead("Product Value", "Whether customers get the outcome they pay for — named more often, higher, in AI answers — and the work that gets them there.")}
      ${card("Customer outcomes", `<div class="kpis">
          ${kpi("Median visibility score", ok.medianScore == null ? "—" : `${ok.medianScore}<small>/100</small>`, `latest check · ${num(ok.brands)} brands`, "", { cls: "dark", spark: o.weekly.map((w) => w.median ?? 0) })}
          ${kpi("Median change", ok.medianDelta == null ? "—" : `${ok.medianDelta > 0 ? "+" : ""}${ok.medianDelta}<small> pts</small>`, `first check ${ok.medianFirst ?? "—"} → now ${ok.medianLatestComparable ?? "—"} · ${num(ok.comparable)} comparable brands`)}
          ${kpi("Improving / flat / declining", `${num(ok.improving)} / ${num(ok.flat)} / ${num(ok.declining)}`, "±5 points, checks 7+ days apart", "", { cls: "lime" })}
          ${kpi("Rechecks that improved", rc.rate == null ? "—" : `${rc.rate}%`, `${num(rc.improved)} of ${num(rc.total - rc.incomparable)} comparable · ${num(rc.regressed)} regressed`, "A later comparable check after a published fix. Reported as observed change, never as caused by the fix.")}
          ${kpi("Leading their category", num(ok.leading), "named first or ranked #1 in the latest check")}
        </div>
        <div class="cd-chart">${lineChart(o.weekly.map((w) => ({ ...w, day: w.week, median: w.median ?? 0 })), [{ key: "median", label: "Median visibility score (latest check per brand in the trailing 4 weeks)", cls: "c1" }], { h: 200 })}</div>`, "",
        { eyebrow: "The outcome customers pay for", desc: "From each brand's first and latest scored check. Visibility score = named in answers 50%, share of voice against the leader 20%, position 20%, sentiment 10% (server/metrics.mjs).",
          foot: `<span>Source <b>runs.summary</b></span><span>Comparable <b>2+ checks, 7+ days apart</b></span><span>${num(ok.stale)} brands not checked in 21 days</span>` })}
      <div class="grid2">
        ${card("Where AI names customers, by engine", bars(o.engines, (x) => x.engine, (x) => x.visibility, (x) => `${x.visibility}% · ${num(x.brands)} brands`, "p"), "", { eyebrow: "Latest checks", desc: "Average share of answers naming the brand, per engine. Low engines are where recovery work pays most." })}
        ${card("Rivals that lead most often", o.rivals.length ? bars(o.rivals, (x) => x.name, (x) => x.n, (x) => `${num(x.n)} brands`) : '<div class="cd-empty">No rival leads a customer brand.</div>', "", { eyebrow: "Competitive pressure", desc: "Across customers, the brand AI names first instead of them in their latest check." })}
      </div>
      <div class="grid2">
        ${card("Score distribution", bars(o.distribution, (x) => x.band, (x) => x.n, (x) => `${num(x.n)} brands`, "p"), "", { eyebrow: "Latest check" })}
        ${card("Recommendation gaps", table([{ h: "Gap", v: (g) => esc(GAPN[g.gap] || g.gap) }, { h: "Open", r: 1, v: (g) => num(g.open) }, { h: "Closed (improved)", r: 1, v: (g) => (g.closed ? `<span class="cd-st good">${num(g.closed)}</span>` : "0") }, { h: "Total", r: 1, v: (g) => num(g.total) }], o.gaps), "",
          { eyebrow: "Recovery actions by gap type", desc: "Decision gaps (people ready to buy) are worth the most; discovery gaps the least." })}
      </div>
      <div class="grid2">
        ${card("Most improved", table(brandRow, o.improvers, { click: (b) => A(b.org_slug) }), "", { eyebrow: "Since first check" })}
        ${card("Losing ground", o.decliners.length ? table(brandRow, o.decliners, { click: (b) => A(b.org_slug) }) : '<div class="cd-empty"><b>No brand is losing ground</b>Every comparable brand is flat or up.</div>', "", { eyebrow: "Since first check" })}
      </div>
      ${card("Checks", `<div class="kpis">${kpi("Completed checks", num(c.done), `${num(c.brands)} brands checking`, "", { cls: "dark" })}${kpi("Live", num(c.live), "started by a person")}${kpi("Scheduled", num(c.scheduled), "run by the scheduler")}
          ${kpi("Failed", num(c.failed), c.done + c.failed ? `${ratio(c.failed, c.done + c.failed)} of terminal checks` : "")}${kpi("Stopped", num(c.stopped), "stopped by a person")}</div>`, "",
        { eyebrow: "Selected period", desc: `Completed checks in the last ${days} days. A check asks every tracked question on every chosen engine.` })}
      <div class="grid2">
        ${card("Drafted work", bars(d.drafts, (x) => x.kind, (x) => x.n, (x) => `${num(x.n)} · ${num(x.brands)} brands`, "p"), "", { eyebrow: "Selected period", desc: "AI writing by kind. Pitches, articles and fix packs count as drafts; chat and insights do not." })}
        ${card("Approval", `<div class="kpis">${kpi("Approved now", num(ap.approved), "approved, published or rechecked")}${kpi("Archived now", num(ap.rejected), "decided against")}${kpi("Approval rate", ap.rate == null ? "—" : ap.rate + "%", `${num(ap.approved)} of ${num(ap.decided)} decided`, "", { cls: "lime" })}${kpi("Waiting", num(ap.pending), "suggested, drafting or in review")}</div>`, "",
          { eyebrow: "Current state", desc: "Latest state of every recovery action. Pending actions are excluded from the rate." })}
      </div>
      ${card("Recovery actions by state", bars(flow.map(([key, n]) => ({ key, n: n || 0 })), (x) => x.key, (x) => x.n, (x) => num(x.n)), "", { eyebrow: "All time", desc: "Where every recovery action stands now." })}
      ${card("Outcomes", `<div class="kpis">${kpi("Value moves", num(pe.value_moves), "published, rechecked or result observed")}${kpi("Published", num(pe.published), "")}${kpi("Results observed", num(pe.observed), "a later comparable check reported back")}${kpi("Value-producing brands", num(pe.value_brands), "", "", { cls: "lime" })}</div>
        <p class="cd-foot muted">A published fix is self-reported. A later check reports what changed; it never claims the action caused it.</p>`, "", { eyebrow: "Selected period" })}
      ${card("Value outcomes by brand", table([
          { h: "Brand", v: (b) => `<b>${esc(b.name)}</b><div class="muted cd-sm">${esc(b.org)}</div>` }, { h: "Checks", r: 1, v: (b) => num(b.checks) }, { h: "Drafts", r: 1, v: (b) => num(b.drafts) },
          { h: "Approved", r: 1, v: (b) => num(b.approved) }, { h: "Value", r: 1, v: (b) => (b.value ? `<span class="cd-st lime">${num(b.value)}</span>` : "0") }, { h: "Last value action", v: (b) => esc(b.last_value ? ago(b.last_value) : "never") },
        ], d.byBrand, { click: (b) => A(b.org_slug) }), "", { eyebrow: "Overview section", desc: "Brands whose approved work was published or rechecked: the value definition behind the Pulse figure." })}`;
  } },

  customers: { title: "Customers", async draw() {
    const f = STATE.health || "", d = await api("GET", "customers-page" + (f ? "?health=" + f : "")), k = d.kpis;
    STATE.cust = d; STATE.seg ||= "plan";
    const FIL = [["", "All brands"], ["active", "Active in 7 days"], ["blocked", "Blocked"], ["no_first_check", "No check after 7 days"], ["unused_approved", "Unused approved work"], ["stale_integration", "Stale integration"]];
    return `${pageHead("Customers", "Who uses White Petal: segments, accounts, stages and evidence.")}
      <div class="kpis">
        ${kpi("Accounts", num(k.accounts), "in this environment and view")}
        ${kpi("With a brand", `${num(k.withBrand)} <small>of ${num(k.accounts)}</small>`, "brand coverage")}
        ${kpi("Brands with a category", `${num(k.withCategory)} <small>of ${num(k.brands)}</small>`, "brand profile coverage")}
        ${kpi("Brands matching health filter", num(k.matching), FIL.find(([v]) => v === f)[1])}
      </div>
      ${card("Segments", `<div class="fc-seg"><div class="fc-seg-tabs" role="tablist">${Object.entries(d.segmentNames).map(([key, label]) => `<button type="button" data-seg="${key}" aria-pressed="${STATE.seg === key}"><b>${esc(label)}</b><span>Top: ${esc(d.segments[key][0]?.key || "—")}</span></button>`).join("")}</div><div class="fc-rank" id="segRank"></div></div>`, "",
        { eyebrow: "Who they are", desc: "One ranking at a time, largest first. Follows the Accounts and demo filters." })}
      ${["founder", "finance", "support"].includes(STATE.me.role) ? card("New account", `<form id="acctForm" class="cd-pad cd-pf-grid" hidden>
          <label>Organisation name<input id="naName" required minlength="2" maxlength="80" placeholder="e.g. Acme Retail"></label>
          <label>Owner's email<input id="naOwner" type="email" required placeholder="owner@company.com"></label>
          <label>Starts as<select id="naStart"><option value="new">Customer: picks a plan, then the ${esc(String(STATE.trialDefault || 7))}-day trial starts</option><option value="internal">Internal: unlimited, for our team and tests</option></select></label>
          <div class="wide cd-form-row"><button class="btn sm" type="submit">Create and invite the owner</button><span role="status" id="naOut"></span></div></form>`,
        `<button class="btn sm" type="button" id="newAcct">New account</button>`, { eyebrow: "For a client", desc: "Creates the organisation with no one from our team in it, and emails its owner an invite. Assign a plan from its drawer afterwards." }) : ""}
      ${card("Account groups", `<div class="fc-groups" id="groups">${groupsHtml(d.groups)}</div>`, `<button class="btn sm" type="button" id="newGroup">New group</button>`,
        { eyebrow: "Keep your own accounts out", desc: "Put your own, your team's and test organisations in a group. With Accounts set to “Customers only”, every figure in the console leaves internal groups out; “Hide demo accounts” leaves demo groups out; pick a group in the Accounts filter to see only it." })}
      ${card("Accounts", `<div class="cd-tools"><input type="search" id="fq" placeholder="Search company, owner, brand or plan…" aria-label="Search accounts"><span class="muted" id="fcount"></span><span class="sp"></span>
          <span id="pick" hidden><span class="muted" id="pickN"></span> <select id="pickGroup" aria-label="Group">${d.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select> <button class="btn sm" type="button" id="pickAdd">Add to group</button></span></div>
        <div id="acctTable"></div>`, "", { eyebrow: count(d.accounts.length, "account"), desc: "Tick accounts to add them to a group; open a row for the account drawer." })}
      ${card("Brand health", `<div class="cd-tools"><span class="segc">${FIL.map(([v, l]) => `<button type="button" data-health="${v}" aria-pressed="${v === f}">${l}</button>`).join("")}</span></div>${watchTable(d.health.rows)}`, "",
        { eyebrow: "Evidence, not a score", id: "brand-health", desc: "Each brand's evidence — repeated failures, broken or stale connections, no check after 7 days, approved work unused — for the founder to judge." })}`;
  }, after() {
    const d = STATE.cust;
    const paintSeg = () => { const rows = d.segments[STATE.seg] || [], tot = rows.reduce((t, r) => t + r.n, 0), max = Math.max(1, ...rows.map((r) => r.n));
      $("#segRank").innerHTML = `<p>${esc(d.segmentNames[STATE.seg])}, ${STATE.seg === "category" || STATE.seg === "schedule" ? "by brand" : "by account"}.</p>` + (rows.map((r, i) => `<div><span class="i">${i + 1}</span><span>${esc(r.key)}</span><b>${num(r.n)}<small>${ratio(r.n, tot)}</small></b><span class="bar"><i style="width:${(100 * r.n) / max}%"></i></span></div>`).join("") || '<div class="cd-empty">No data.</div>');
      $$("[data-seg]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.seg === STATE.seg)); };
    $$("[data-seg]").forEach((b) => b.addEventListener("click", () => { STATE.seg = b.dataset.seg; paintSeg(); }));
    paintSeg();
    const picked = new Set();
    const paint = () => {
      const qv = $("#fq").value.trim().toLowerCase(), rows = d.accounts.filter((a) => !qv || [a.name, a.owner, a.plan, ...a.brands.map((b) => b.name)].some((x) => String(x || "").toLowerCase().includes(qv)));
      $("#fcount").textContent = `${rows.length}/${d.accounts.length}`;
      $("#acctTable").innerHTML = table([
        { h: "", v: (a) => `<input type="checkbox" data-pick="${esc(a.slug)}" aria-label="Select ${esc(a.name)}"${picked.has(a.slug) ? " checked" : ""}>` },
        { h: "Company", v: (a) => `<b>${esc(a.name)}</b>` }, { h: "Owner", v: (a) => esc(a.owner || "—") },
        { h: "Plan", v: (a) => esc(a.plan) }, { h: "Status", v: (a) => status(a.status) },
        { h: "Brands", v: (a) => (a.brands.length ? a.brands.map((b) => `${esc(b.name)} <span class="muted">· ${esc(b.category || "—")}</span>`).join("<br>") : '<span class="cd-mute">—</span>') },
        { h: "Stage", v: (a) => esc(a.stage) }, { h: "Signed up", v: (a) => esc(dt(a.signedUp)) }, { h: "Last active", v: (a) => esc(a.lastActive ? ago(a.lastActive) : "never") },
        { h: "MRR", r: 1, v: (a) => (a.mrr ? money(a.mrr, a.currency) : '<span class="cd-mute">—</span>') },
      ], rows, { click: (a) => A(a.slug) });
    };
    $("#fq").addEventListener("input", paint); paint();
    $("#acctTable").addEventListener("click", (e) => { const c = e.target.closest("[data-pick]"); if (!c) return; e.stopPropagation(); c.checked ? picked.add(c.dataset.pick) : picked.delete(c.dataset.pick);
      $("#pick").hidden = !picked.size || !d.groups.length; $("#pickN").textContent = `${picked.size} ticked`; }, true);
    $("#pickAdd")?.addEventListener("click", async () => { try { await api("PATCH", `groups/${$("#pickGroup").value}`, { add: [...picked] }); toast("Added to the group."); route(); } catch (err) { toast(err.message); } });
    $$("[data-health]").forEach((b) => b.addEventListener("click", () => { STATE.health = b.dataset.health; route().then(() => $("#brand-health")?.scrollIntoView({ block: "start" })); }));
    bindGroups();
    $("#newAcct")?.addEventListener("click", () => { $("#acctForm").hidden = false; $("#naName").focus(); });
    $("#acctForm")?.addEventListener("submit", async (e) => {
      e.preventDefault(); const out = $("#naOut"); out.textContent = "Creating…";
      try { const r = await api("POST", "accounts", { name: $("#naName").value, ownerEmail: $("#naOwner").value, start: $("#naStart").value });
        out.innerHTML = `<span class="cd-ok">Created. ${r.invite.emailed ? "Invite emailed." : "Email isn't set up here, so copy the invite link:"}</span>${r.invite.emailed ? "" : ` <code>${esc(r.invite.link)}</code>`}`;
        STATE.drawn = null; setTimeout(() => { location.hash = `customers?account=${r.account.slug}`; }, r.invite.emailed ? 600 : 4000);
      } catch (err) { out.innerHTML = `<span class="cd-err">${esc(err.message)}</span>`; }
    });
  } },

  subscriptions: { title: "Plans & Subscriptions", async draw() {
    const d = await api("GET", "plans-subs"), k = d.kpis, can = ["founder", "finance"].includes(STATE.me.role);
    const pay = (s) => (s.razorpay ? "Razorpay" : s.contracted ? "Contract" : s.status === "trialing" ? "Trial" : "None");
    return `${pageHead("Plans & Subscriptions", "Every plan, who is on it, what they pay and what changes next. Prices are monthly, before tax.")}
      <div class="kpis">
        ${kpi("MRR", inr(k.mrrInr), `${num(k.paying)} paying · ARPA ${inr(k.arpaInr)}`, "Monthly price before tax of organisations that are active or past due. USD converts at ₹" + k.usdInr + ".", { cls: "dark" })}
        ${kpi("ARR run rate", inr(k.arrInr), "MRR × 12")}
        ${kpi("On trial", num(k.trials), "free trials running")}
        ${kpi("Past due", num(k.pastDue), "renewal not paid", "", k.pastDue ? { delta: `<span class="fc-delta down">act now</span>` } : {})}
        ${kpi("New, 30 days", num(k.new30), "subscriptions activated", "", { cls: "lime" })}
        ${kpi("Churned, 30 days", num(k.churn30), `${num(k.cancelling)} more set to cancel · ${num(k.annual)} paying yearly · ${num(k.extraSeats)} extra seats`)}
      </div>
      ${card("Plans", `<div class="fc-plans">${d.plans.map((p) => `<article class="fc-plan${p.featured ? " feat" : ""}${p.active ? "" : " off"}"${can ? ` data-go="plans/${esc(p.code)}"` : ""}>
          <span class="badge">${p.featured ? '<span class="cd-st info">Most popular</span>' : !p.active ? '<span class="cd-st">Archived</span>' : p.selfServe ? '<span class="cd-st lime">Self-serve</span>' : p.public ? '<span class="cd-st violet">Talk to us</span>' : '<span class="cd-st">Hidden</span>'}</span>
          <h4>${esc(p.name)}</h4>
          <div class="price">${p.prices.INR ? inr(p.prices.INR.amount, true) : p.prices.USD ? money(p.prices.USD.amount, "USD") : "Free"}<small>${p.prices.INR || p.prices.USD ? " / mo + tax" : ""}</small></div>
          ${(() => { const c = p.prices.INR ? "INR" : "USD", x = p.prices[c]; if (!x?.annual) return ""; const sv = Math.round((1 - x.annual / (x.amount * 12)) * 100);
            return `<div class="fc-annual">${money(x.annual, c)} / year${sv > 0 ? ` <span class="cd-st lime">save ${sv}%</span>` : ""}</div>`; })()}
          <ul><li>${p.limits.brands == null ? "Unlimited" : num(p.limits.brands)} brand${p.limits.brands === 1 ? "" : "s"} · ${p.limits.questions == null ? "unlimited" : num(p.limits.questions)} questions</li>
            <li>${p.limits.seats == null ? "Unlimited" : num(p.limits.seats)} seat${p.limits.seats === 1 ? "" : "s"} · ${p.limits.drafts == null ? "unlimited" : num(p.limits.drafts)} drafts / period</li>
            <li>AI cap ${p.capUsd == null ? "none" : usd(p.capUsd, 0) + " / mo"}${p.prices.USD && p.prices.INR ? ` · also ${money(p.prices.USD.amount, "USD")}` : ""}</li>
            <li>Free trial: ${p.trialDays === 0 ? "none" : `${p.trialDays ?? STATE.trialDefault ?? 7} days${p.trialDays == null ? " (default)" : ""}`}</li>
            <li>Extra seats: ${p.maxExtraSeats === 0 ? "not sold" : (() => { const c = p.prices.INR ? "INR" : "USD", seat = p.prices[c]?.seat; return `${seat != null ? money(seat, c) + " / seat / mo" : "no price"}${p.maxExtraSeats != null ? ` · up to ${num(p.maxExtraSeats)}` : ""}`; })()}</li>
            <li>Razorpay: ${Object.entries(p.prices).filter(([, v]) => v.amount > 0).map(([c, v]) => `${c} ${v.razorpay ? "✓" : "missing"}${v.annual ? ` · ${c}/yr ${v.annualRazorpay ? "✓" : "missing"}` : ""}`).join(" · ") || "not sold by card"}</li></ul>
          <div class="stats"><div><b>${num(p.orgs)}</b>on plan</div><div><b>${num(p.paying)}</b>paying${p.annualSubs ? ` · ${num(p.annualSubs)} yearly` : ""}</div><div><b>${inr(p.mrrInr)}</b>MRR</div></div></article>`).join("")}</div>`,
        can ? `<button class="btn sm" type="button" data-go="plans/new">New plan</button><button class="btn ghost sm" type="button" data-go="plans">Plan catalogue</button>` : "",
        { eyebrow: "Catalogue", desc: "Live from the database: what each plan costs, allows and earns. Open a plan to edit it, archive it or create its Razorpay plan." })}
      ${card("Subscriptions", table([
          { h: "Organisation", v: (s) => `<b>${esc(s.name)}</b><div class="muted cd-sm">${esc(s.owner || "")}</div>` },
          { h: "Plan", v: (s) => esc(s.plan) + (s.pendingPlan ? ` <span class="muted">→ ${esc(s.pendingPlan)}</span>` : "") },
          { h: "Status", v: (s) => status(s.status) + (s.cancelAtEnd ? ' <span class="cd-st warn">cancels</span>' : "") },
          { h: "Cycle", v: (s) => (s.cycle === "annual" ? '<span class="cd-st violet">Annual</span>' : "Monthly") + (s.extraSeats ? ` <span class="cd-st">+${num(s.extraSeats)} seats</span>` : "") },
          { h: "Price", r: 1, v: (s) => (s.price ? `${money(s.price, s.currency)} <span class="muted">/ ${s.cycle === "annual" ? "yr" : "mo"}</span><div class="muted cd-sm">${money(s.priceWithTax, s.currency)} with tax${s.mrr && s.cycle === "annual" ? ` · ${money(s.mrr, s.currency)} / mo` : ""}</div>` : '<span class="cd-mute">—</span>') },
          { h: "Payment", v: (s) => esc(pay(s)) },
          { h: "Renews / ends", v: (s) => esc(s.status === "trialing" ? `trial ${until(s.trialEnds)}` : s.renews ? `${dt(s.renews)} · ${until(s.renews)}` : "—") },
          { h: "Charges", r: 1, v: (s) => num(s.charges) }, { h: "Customer since", v: (s) => esc(s.since ? dt(s.since) : "—") },
          { h: "Synced", v: (s) => (s.razorpay ? esc(ago(s.reconciled)) : '<span class="cd-mute">—</span>') },
        ], d.subs, { click: (s) => A(s.slug) }), "", { eyebrow: `${num(d.subs.length)} organisations on a plan`, desc: "Open a row for the account drawer: plan and subscription details, change plan, cancel, invoices and refunds, send a Razorpay link, or assign a plan without a card." })}
      ${card("Billing events", d.events.length ? `<div class="cd-tl">${d.events.map((e) => `<div><time>${esc(dtm(e.at))}</time><span><b>${esc(e.name)}</b> <code>${esc(e.action.replace("billing.", ""))}</code> ${esc(e.target || "")}${e.who ? ` <span class="muted">· ${esc(e.who)}</span>` : ""}</span></div>`).join("")}</div>` : '<div class="cd-empty">No billing events yet.</div>', "",
        { eyebrow: "Newest first", desc: "Activations, renewals, plan changes, cancellations, links sent and operator grants, as the audit log recorded them." })}`;
  } },

  fit: { title: "Plan fit", async draw() {
    const d = await api("GET", "plan-fit"), CAPN = { brands: "Brands", questions: "Questions", competitors: "Competitors per brand", seats: "Seats", drafts: "Drafted fixes (month)" };
    const pct = (v) => (v == null ? '<span class="cd-mute">—</span>' : `<span class="cd-st ${v >= 100 ? "bad" : v >= 80 ? "warn" : ""}">${v}%</span>`);
    const capCell = (c) => (c.cap == null ? "∞" : num(c.cap));
    const acct = [{ h: "Account", v: (a) => `<b>${esc(a.name)}</b><div class="muted cd-sm">${esc(a.plan)}</div>` }, { h: "MRR", r: 1, v: (a) => (a.mrrInr ? inr(a.mrrInr, true) : '<span class="cd-mute">—</span>') },
      { h: "Questions", r: 1, v: (a) => `${num(a.caps.questions.used)}${a.caps.questions.cap ? ` / ${num(a.caps.questions.cap)}` : ""}` }, { h: "Brands", r: 1, v: (a) => `${num(a.caps.brands.used)}${a.caps.brands.cap ? ` / ${num(a.caps.brands.cap)}` : ""}` },
      { h: "Seats", r: 1, v: (a) => `${num(a.caps.seats.used)}${a.caps.seats.cap ? ` / ${num(a.caps.seats.cap)}` : ""}` }];
    return `${pageHead("Plan fit", "Plans cap questions, brands, competitors, seats and drafts. How much of each cap customers use, which cap binds, and what serving them costs.")}
      ${d.plans.map((p) => card(`${esc(p.name)} <span class="muted">· ${count(p.accounts, "account")}, ${num(p.paying)} paying</span>`, `
        <div class="cd-scroll"><table class="tbl"><thead><tr><th>Cap</th><th class="r">Plan allows</th><th class="r">Median used</th><th class="r">p90 used</th><th class="r">Median use</th><th class="r">≥ 80%</th><th class="r">At cap</th></tr></thead><tbody>
          ${Object.entries(p.metrics).map(([k, m]) => `<tr><td>${esc(CAPN[k])}${p.binding === k ? ' <span class="cd-st warn">binds</span>' : ""}</td><td class="r">${capCell(m)}</td><td class="r">${num(m.medianUsed)}</td><td class="r">${num(m.p90Used)}</td><td class="r">${pct(m.medianPct)}</td><td class="r">${num(m.near)}</td><td class="r">${num(m.atCap)}</td></tr>`).join("")}
        </tbody></table></div>`, p.paying ? `<span class="fc-chip">AI ${usd(p.medianAiUsd)} / mo per paying account · margin ${p.medianMargin ?? "—"}%</span>` : "",
        { eyebrow: p.binding ? `Binding cap: ${CAPN[p.binding]}` : "No cap is binding", desc: p.binding ? `${num(p.metrics[p.binding].near)} of ${count(p.accounts, "account")} ${p.metrics[p.binding].near === 1 ? "is" : "are"} at 80% or more of ${CAPN[p.binding].toLowerCase()}: the reason they'd upgrade.` : "" })).join("")}
      <div class="grid2">
        ${card("Ready to expand", table([...acct, { h: "Near cap on", v: (a) => a.near.map((k) => `<span class="cd-st warn">${esc(CAPN[k])}</span>`).join(" ") }], d.expansion, { click: (a) => A(a.slug) }), "",
          { eyebrow: "At 80%+ of a cap", desc: "Highest revenue first. Offer the next plan, extra seats, or a custom limit." })}
        ${card("At risk", table([...acct, { h: "Why", v: (a) => (a.checks14 === 0 ? '<span class="cd-st bad">no check in 14 days</span>' : '<span class="cd-st warn">uses under 25% of questions</span>') }], d.atRisk, { click: (a) => A(a.slug) }), "",
          { eyebrow: "Paying, low use", desc: "Paying accounts that stopped checking or track far fewer questions than they pay for." })}
      </div>`;
  } },

  operations: { title: "Operations", async draw(arg) {
    const sf = ["failed", "running", "done"].includes(arg) ? arg : "all";
    const [d, log] = await Promise.all([api("GET", "operations?status=" + sf), ["founder", "finance"].includes(STATE.me.role) ? api("GET", "audit") : Promise.resolve({ log: [] })]), r = d.recon, qd = d.quality;
    const ok = !r.ledger_mismatch && !r.unsynced && !r.hooks_failed && !r.stuck_runs;
    return `${pageHead("Operations", "Checks, reconciliation, data quality, audit and founder actions.")}
      ${card("Recent checks", `<div class="cd-tools"><span class="segc">${[["all", "All"], ["failed", "Failed"], ["running", "In flight"], ["done", "Done"]].map(([v, l]) => `<button type="button" data-go="operations/${v}" aria-pressed="${v === sf}">${l}</button>`).join("")}</span></div>
        ${table([{ h: "When (UTC)", v: (x) => `<span class="nw">${esc(new Date(x.started_at).toISOString().slice(0, 16).replace("T", " "))}</span>` }, { h: "Brand", v: (x) => `<b>${esc(x.brand)}</b><div class="muted cd-sm">${esc(x.org)}</div>` },
          { h: "Check", v: (x) => esc(x.source === "live" ? "Live check" : "Scheduled check") }, { h: "Status", v: (x) => `<span class="cd-st ${RUN[x.status] || ""}">${esc(x.status)}</span>` },
          { h: "Timing", r: 1, v: (x) => esc(dur(x.secs)) }, { h: "Requested by", v: (x) => `<span class="cd-sm">${esc(x.by || "scheduler")}</span>` }, { h: "Failure", v: (x) => (x.error ? `<span class="muted">${esc(x.error)}</span>` : "") }], d.runs, { click: (x) => A(x.org_slug) })}`, "",
        { eyebrow: "Latest 50 checks · every brand · newest first", desc: "Failure text is the product's own error, never a prompt or a key." })}
      <div class="grid2">
        ${card("Reconciliation", `<div class="kpis">${kpi("Accounts checked", num(r.accounts))}${kpi("Usage ledger mismatches", num(r.ledger_mismatch), "counter ≠ sum of usage rows")}${kpi("Unsynced subscriptions", num(r.unsynced), "not checked with Razorpay in 2 days")}${kpi("Failed webhooks", num(r.hooks_failed), "last 7 days")}${kpi("Stuck checks", num(r.stuck_runs), "running over 2 hours")}</div>`,
          ok ? '<span class="cd-st good">Reconciles</span>' : '<span class="cd-st warn">Needs a look</span>', { eyebrow: "Money and usage" })}
        ${card("Data quality", `<dl class="fc-kv"><div><dt>Oldest unprocessed payment event</dt><dd>${esc(qd.oldest_unprocessed ? ago(qd.oldest_unprocessed) : "none")}</dd></div>
          <div><dt>Latest AI call</dt><dd>${esc(ago(qd.last_usage))}</dd></div><div><dt>Latest page view</dt><dd>${esc(ago(qd.last_view))}</dd></div><div><dt>Latest heartbeat</dt><dd>${esc(ago(qd.last_presence))}</dd></div>
          <div><dt>Organisations without an owner</dt><dd>${num(qd.no_owner)}</dd></div><div><dt>AI calls with no person</dt><dd>${num(qd.usage_unattributed)} <span class="muted">(scheduled checks)</span></dd></div></dl>`, "", { eyebrow: "Coverage and freshness" })}
      </div>
      ${card("Recent founder actions", log.log.length ? `<div class="cd-tl">${log.log.slice(0, 40).map((a) => `<div><time>${esc(dtm(a.at))}</time><span><code>${esc(a.action)}</code> ${esc(a.target || "")} ${a.org ? `<span class="muted">· ${esc(a.org)}</span>` : ""} <span class="muted">· ${esc(a.who || "system")}</span></span></div>`).join("")}</div>` : '<div class="cd-empty">Visible to founder and finance operators.</div>', "",
        { eyebrow: "Audit trail", desc: "Every operator action and every billing change, written to the audit log with who, what and why." })}
      ${card("Plans and billing actions", `<p class="cd-pad muted">Kept apart from analytics on purpose. Open an account (Customers or Plans &amp; Subscriptions) to assign a plan, send a Razorpay link, change plan, cancel or refund; edit plans in the Plan catalogue. Every action needs a reason and is written to the audit log.</p>`,
        `<button class="btn ghost sm" type="button" data-go="subscriptions">Plans &amp; Subscriptions</button>`, { eyebrow: "Changes money · founder actions" })}`;
  } },

  ai: { title: "AI & Cost", async draw() {
    const [d, u] = await Promise.all([api("GET", "ai"), api("GET", "unit-costs").catch(() => null)]), r = d.reliability, l = d.latency, c = d.cost, secs = (s) => (s == null ? "—" : dur(Math.round(s)));
    const t = u?.totals, usd4 = (v) => (v == null ? "—" : v < 0.1 ? "$" + v.toFixed(4) : usd(v));
    return `${pageHead("AI & Cost", "What it costs to answer customers' questions, per answer, question and brand, against what they pay.")}
      ${u ? card("Cost in product units", `<div class="kpis">
          ${kpi("Per answer", usd4(t.perAnswer), `${num(t.answers)} answers in 30 days`, "One answer = one question asked to one engine once. The unit everything else multiplies.", { cls: "dark" })}
          ${kpi("Per question tracked", usd4(t.perQuestion), `a month · ${num(t.activeQuestions)} active questions`)}
          ${kpi("Per active brand", usd4(t.perBrand), `a month, all AI · ${num(t.activeBrands)} brands`)}
          ${kpi("AI cost, 30 days", usd(t.usd), `${usd(t.askUsd)} on answers · rest writing and pages`)}
        </div>
        ${table([{ h: "Engine", v: (e) => `<b>${esc(e.engine)}</b>` }, { h: "Answers", r: 1, v: (e) => num(e.answers) }, { h: "Cost", r: 1, v: (e) => usd(e.usd) }, { h: "Per answer", r: 1, v: (e) => usd4(e.perAnswer) }], u.engines)}`, "",
        { eyebrow: "The unit economics", desc: "A brand's month costs questions × engines × answers per question × checks a month × cost per answer. A daily schedule is about 7× a weekly one." }) : ""}
      ${u ? card("Projected monthly AI cost per brand", table([{ h: "Brand", v: (b) => `<b>${esc(b.name)}</b><div class="muted cd-sm">${esc(b.org)} · ${esc(b.plan_code)}</div>` },
          { h: "Setup", v: (b) => `<span class="cd-sm">${num(b.questions)} q × ${num(b.engines)} engines × ${num(b.samples)} · ${esc(b.schedule)}</span>` }, { h: "Answers / mo", r: 1, v: (b) => num(b.answersPerMonth) },
          { h: "Projected", r: 1, v: (b) => usd(b.projectedUsd) }, { h: "Actual, 30 d", r: 1, v: (b) => usd(b.usd30) },
          { h: "Price / mo", r: 1, v: (b) => (b.priceInr ? inr(b.priceInr, true) : '<span class="cd-mute">—</span>') },
          { h: "Cost / price", r: 1, v: (b) => { if (!b.priceInr || b.projectedUsd == null) return '<span class="cd-mute">—</span>'; const pc = Math.round((100 * b.projectedUsd * t.usdInr * 100) / b.priceInr); return `<span class="cd-st ${pc >= 40 ? "bad" : pc >= 20 ? "warn" : "good"}">${pc}%</span>`; } }],
          u.projected, { click: (b) => A(b.org_slug) }), "", { eyebrow: "From each brand's own setup", desc: "Uses the period's average cost per answer. Brands with no schedule use their actual checks in the last 30 days." }) : ""}
      ${card("Reliability", `<div class="kpis">${kpi("Check success rate", r.rate == null ? "—" : r.rate + "%", `${num(r.done)} of ${num(r.terminal)} terminal checks`, "", { cls: "dark" })}${kpi("Failed", num(r.failed))}${kpi("Stopped", num(r.stopped), "excluded from the rate")}${kpi("Running", num(r.running), "still in flight")}</div>`, "",
        { eyebrow: "Terminal checks in the period", desc: "Success over completed + failed; stopped and running are reported separately.", foot: `<span>Source <b>White Petal records · runs</b></span><span>Last <b>${d.days} days</b></span>` })}
      ${card("Latency", `<div class="kpis">${kpi("Check time p50", secs(l.p50), `n = ${num(l.n)}`)}${kpi("Check time p95", secs(l.p95), `n = ${num(l.n)}`)}${l.bySource.map((x) => kpi(`${x.source === "live" ? "Live" : "Scheduled"} p50 / p95`, `${secs(x.p50)}`, `p95 ${secs(x.p95)} · n = ${num(x.n)}`)).join("")}</div>`, "",
        { eyebrow: "Start to finish", desc: "From the check starting to its last answer, completed checks only." })}
      ${card("Cost and unit economics", `<div class="kpis">${kpi("AI cost", usd(c.totalUsd), "estimated at list prices")}${kpi("Per completed check", c.perCheck == null ? "—" : usd(c.perCheck), "")}${kpi("Per approved action", c.perApproved == null ? "—" : usd(c.perApproved), `${num(c.approved)} approved in the period`, "", { cls: "lime" })}${kpi("Calls with no cost", num(c.zeroCostCalls), "unknown is not zero")}</div>`, "",
        { eyebrow: "Known spend only", desc: "Every AI call is metered at the provider's list price when it is made. Calls recorded without a cost are counted, never priced at zero in the averages.", foot: `<span>Source <b>usage</b></span><span>Currency <b>USD</b></span>` })}
      ${card("By engine", table([{ h: "Engine", v: (e) => `<b>${esc(e.engine)}</b>` }, { h: "Calls", r: 1, v: (e) => num(e.calls) }, { h: "Cost", r: 1, v: (e) => usd(e.usd) }, { h: "Per call", r: 1, v: (e) => (e.perCall == null ? "—" : usd(e.perCall, 4)) }, { h: "Share of cost", r: 1, v: (e) => `${e.share}%` }], d.engines), "", { eyebrow: "Selected period" })}
      <div class="grid2">
        ${card("By kind of call", table([{ h: "Kind", v: (x) => esc(x.kind + (x.sub ? " · " + x.sub : "")) }, { h: "Calls", r: 1, v: (x) => num(x.calls) }, { h: "Cost", r: 1, v: (x) => usd(x.usd) }], d.kinds), "", { eyebrow: "Selected period" })}
        ${card("Failures by reason", d.failures.length ? `<div class="fc-rank cd-pad">${d.failures.map((f, i) => `<div><span class="i">${i + 1}</span><span>${esc(f.reason)}</span><b>${num(f.n)}</b><span class="bar"><i style="width:${(100 * f.n) / d.failures[0].n}%"></i></span></div>`).join("")}</div>` : '<div class="cd-empty">No failed checks in the period.</div>', "",
          { eyebrow: "Grouped", desc: "Numbers and ids are folded so the same error groups together." })}
      </div>`;
  } },

  integrations: { title: "Integrations", async draw() {
    const d = await api("GET", "integrations"), t = d.totals, P = d.platform || [];
    const ST = { live: ["good", "Live"], ready: ["info", "Ready, not used lately"], off: ["", "Not set up"], problem: ["bad", "Problem"] };
    const live = P.filter((x) => x.state === "live").length, problems = P.filter((x) => x.state === "problem").length, off = P.filter((x) => x.state === "off").length;
    const groups = [...new Set(P.map((x) => x.group))];
    const conn = (x) => `<div class="fc-conn ${x.state}"><header><b>${esc(x.name)}</b><span class="cd-st ${ST[x.state][0]}">${ST[x.state][1]}</span></header>
        <p class="muted cd-sm">${esc(x.detail || "")}</p>
        ${((u) => (u.length ? `<p class="cd-sm">${u.join(" · ")}</p>` : ""))([x.day != null ? `${num(x.day)} today` : "", x.month != null ? `${num(x.month)} in 30 days` : "", x.usd ? usd(x.usd) : "", x.last ? `last ${esc(ago(x.last))}` : ""].filter(Boolean))}
        ${x.error ? `<p class="cd-err cd-sm">${esc(x.error)}</p>` : ""}${x.note ? `<p class="cd-sm cd-warnline">${esc(x.note)}</p>` : ""}</div>`;
    const k = d.ownKeys || { accounts: 0, byKey: [], platformAllowed: 0 };
    return `${pageHead("Integrations", "What White Petal is connected to (your keys and services), and what customers have connected on their side.")}
      <div class="kpis">${kpi("Platform services live", `${num(live)} <span class="muted">of ${num(P.length)}</span>`, "set up and used in the last 7 days", "", { cls: "lime" })}${kpi("Need attention", num(problems), problems ? "failing: see below" : "nothing failing")}${kpi("Not set up", num(off), "add the key to turn it on")}${kpi("Customer connections", num(t.total), `${num(t.error)} broken · ${num(t.stale)} stale`)}</div>
      ${card("Platform connections", `<div class="cd-pad">${groups.map((g) => `<div class="fc-conn-group"><span class="eyebrow">${esc(g)}</span><div class="fc-conns">${P.filter((x) => x.group === g).map(conn).join("")}</div></div>`).join("")}</div>`, "",
        { eyebrow: "Your side", desc: "The services this server's keys connect it to. Keys live in the environment (.env.local here, Secret Manager on Cloud Run); only whether one is set is shown." })}
      ${card("Customers' own AI keys", k.byKey.length ? table([{ h: "Provider", v: (x) => `<b>${esc(x.label)}</b>` }, { h: "Accounts with their own key", r: 1, v: (x) => num(x.accounts) }], k.byKey)
          : '<div class="cd-empty"><b>No account has its own AI key</b>Every check runs on the platform\'s keys (accounts allowed to use them).</div>', "",
        { eyebrow: "Their side", desc: `${count(k.accounts, "account")} bring their own keys; ${count(k.platformAllowed, "account")} may fall back to the platform's. Calls on a customer's own key still count in AI cost (see the metrics doc).` })}
      ${card("Brand integrations", table([{ h: "Provider", v: (p) => `<b>${esc(p.provider)}</b>` }, { h: "Connections", r: 1, v: (p) => num(p.total) }, { h: "Connected", r: 1, v: (p) => num(p.connected) }, { h: "Broken", r: 1, v: (p) => (p.error ? `<span class="cd-st bad">${num(p.error)}</span>` : "0") },
          { h: "Stale >48 h", r: 1, v: (p) => (p.stale ? `<span class="cd-st warn">${num(p.stale)}</span>` : "0") }, { h: "Never synced", r: 1, v: (p) => num(p.never) }, { h: "Last sync", v: (p) => esc(p.last_sync ? ago(p.last_sync) : "never") }], d.byProvider), "",
        { eyebrow: "Their side", desc: `What customers connected to their brands: Bing, IndexNow, Google Search Console + GA4, Cloudflare, entity checks, Slack. ${num(d.brandsWith.n)} of ${num(d.brandsWith.of)} brands have at least one.` })}
      ${d.broken.length ? card("Needs reconnecting or a sync", table([{ h: "Brand", v: (x) => `<b>${esc(x.brand)}</b><div class="muted cd-sm">${esc(x.org)}</div>` }, { h: "Provider", v: (x) => esc(x.provider) }, { h: "State", v: (x) => `<span class="cd-st ${x.status === "error" ? "bad" : "warn"}">${esc(x.status === "error" ? "broken" : "stale")}</span>` },
          { h: "Detail", v: (x) => `<span class="muted">${esc(x.detail || "")}</span>` }, { h: "Last sync", v: (x) => esc(x.collected_at ? ago(x.collected_at) : "never") }], d.broken, { click: (x) => A(x.org_slug) }), "", { eyebrow: "Exceptions first" }) : ""}`;
  } },

  team: { title: "Team & access", async draw() {
    const d = await api("GET", "operators"), ROLE_NOTE = { founder: "Everything, including plans, refunds, deleting accounts and this page", finance: "Revenue, plans and billing actions; no deleting accounts", support: "Accounts, people, notes and subscriptions; no revenue or plan edits", analyst: "Read-only figures; customer emails are hidden" };
    return `${pageHead("Team & access", "Who can open the Command Deck, and what each role may do.")}
      ${card("Roles", `<dl class="fc-kv">${d.roles.map((r) => `<div><dt><b>${r[0].toUpperCase() + r.slice(1)}</b></dt><dd>${esc(ROLE_NOTE[r])}</dd></div>`).join("")}</dl>`, "", { eyebrow: "What each role can do" })}
      ${card("Operators", `${table([{ h: "Person", v: (o) => `<b>${esc(o.name || o.email)}</b>${o.name ? `<div class="muted cd-sm">${esc(o.email)}</div>` : ""}` },
          { h: "Role", v: (o) => (o.id === STATE.me.id ? esc(o.role) : `<select data-op-role="${esc(o.id)}" aria-label="Role for ${esc(o.email)}">${d.roles.map((r) => `<option${r === o.role ? " selected" : ""}>${r}</option>`).join("")}</select>`) },
          { h: "Status", v: (o) => (o.active ? '<span class="cd-st good">Active</span>' : '<span class="cd-st">Off</span>') }, { h: "Last login", v: (o) => esc(ago(o.last_login_at)) },
          { h: "", v: (o) => (o.id === STATE.me.id ? '<span class="muted cd-sm">you</span>' : `<button class="linkbtn cd-sm" type="button" data-op-toggle="${esc(o.id)}" data-on="${o.active}">${o.active ? "Turn off" : "Turn on"}</button> · <button class="linkbtn cd-sm" type="button" data-op-del="${esc(o.id)}">Remove</button>`) }], d.operators)}
        <form class="cd-note" id="opForm"><input type="email" id="opEmail" required placeholder="Their White Petal email (they must have signed up)" aria-label="Operator email"><select id="opRole" aria-label="Role">${d.roles.map((r) => `<option${r === "support" ? " selected" : ""}>${r}</option>`).join("")}</select><button class="btn sm" type="submit">Add operator</button></form><p class="cd-foot muted" id="opOut" role="status"></p>`,
        "", { eyebrow: "Console access", desc: "Added here, stored in the database, effective at once. Every change is audited." })}
      ${card("Founders from the server", table([{ h: "Email", v: (o) => esc(o.email) }, { h: "Role", v: () => "founder" }, { h: "Set in", v: (o) => `<code>${esc(o.source)}</code>` }], d.env), "",
        { eyebrow: "Read-only", desc: "PLATFORM_OPERATORS emails are always founders. Change them in the server's environment." })}`;
  }, after() {
    const box = $("#pages .pg"); // rendered fresh each time, so these listeners never pile up
    box.addEventListener("change", async (e) => { const s = e.target.closest("[data-op-role]"); if (!s) return; try { await api("PATCH", `operators/${s.dataset.opRole}`, { role: s.value }); toast("Role changed."); STATE.drawn = null; route(); } catch (er) { toast(er.message); } });
    box.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-op-toggle]"), d = e.target.closest("[data-op-del]");
      try {
        if (t) { await api("PATCH", `operators/${t.dataset.opToggle}`, { active: t.dataset.on !== "true" }); toast("Updated."); STATE.drawn = null; route(); }
        if (d) { if (d.dataset.sure !== "1") { d.dataset.sure = "1"; d.textContent = "Click again to remove"; return; } await api("DELETE", `operators/${d.dataset.opDel}`); toast("Removed."); STATE.drawn = null; route(); }
      } catch (er) { toast(er.message); }
    });
    $("#opForm").addEventListener("submit", async (e) => { e.preventDefault();
      try { await api("POST", "operators", { email: $("#opEmail").value, role: $("#opRole").value }); toast("Operator added."); STATE.drawn = null; route(); } catch (er) { $("#opOut").innerHTML = `<span class="cd-err">${esc(er.message)}</span>`; } });
  } },

  releases: { title: "Releases & Feedback", async draw() {
    const d = await api("GET", "releases");
    return `${pageHead("Releases & Feedback", "Flags and server switches. Read-only.", chip("Revision " + d.revision))}
      ${card("Server switches", table([{ h: "Switch", v: (x) => `<code>${esc(x.key)}</code>` }, { h: "Value", v: (x) => `<b>${esc(x.value)}</b>` }, { h: "What it does", v: (x) => `<span class="muted">${esc(x.note)}</span>` }], d.env), "",
        { eyebrow: "Read-only", desc: "Set in the environment (Secret Manager in production); changing one needs a deploy." })}
      ${card("Platform flags", d.flags.length ? table([{ h: "Flag", v: (x) => `<code>${esc(x.key)}</code>` }, { h: "Value", v: (x) => `<code>${esc(JSON.stringify(x.value))}</code>` }, { h: "Changed", v: (x) => esc(`${ago(x.updated_at)}${x.by ? " · " + x.by : ""}`) }], d.flags)
        : '<div class="cd-empty"><b>No flags set</b>Flags stored in the database appear here with who changed them and when.</div>', "", { eyebrow: "Every flag", desc: "Evaluated on the server; a missing flag falls back to off." })}`;
  } },
  revenue: { title: "Revenue", async draw() {
    const d = await api("GET", "revenue"), f = d.funnel || {};
    const steps = [["Signed up", f.signups], ["Added a brand", f.brand], ["Completed a check", f.checked], ["Started a trial", f.trial], ["Paying by card", f.paid]];
    return `${pageHead("Revenue", `Recurring revenue, plan mix and the sign-up funnel. USD converts at ₹${d.usdInr}.`)}
      <div class="kpis cdk">
        ${kpi("MRR", inr(d.mrrInr), "before tax, active and past due", "", { cls: "dark" })}${kpi("ARR run rate", inr(d.mrrInr * 12), "MRR × 12")}${kpi("Average per paying org", inr(d.arpaInr), "ARPA")}${d.oneTime ? kpi("One-time payments", inr(d.oneTime.inr), `${num(d.oneTime.count)} paid in ${d.oneTime.days} days · with tax`, "One-month payment links. Revenue, but not in MRR: they don't renew.") : ""}
        ${kpi("Past due", num(d.status.past_due || 0), "renewal not paid")}${kpi("Trials", num(d.status.trialing || 0), "running now")}${kpi("Cancelled", num(d.status.canceled || 0), "subscription ended")}
      </div>
      <div class="grid2">
        ${card("MRR by plan", bars(d.byPlan, (r) => `${r.plan} · ${r.orgs}`, (r) => r.mrrInr, (r) => inr(r.mrrInr), "p"), "", { eyebrow: "Now", desc: "Plan, number of paying organisations, monthly revenue." })}
        ${card("Sign-up funnel", bars(steps.map(([l, v]) => ({ l, v: v || 0 })), (r) => r.l, (r) => r.v, (r) => `${num(r.v)}${f.signups ? ` · ${Math.round((100 * r.v) / f.signups)}%` : ""}`), "", { eyebrow: "Last 90 days", desc: "Owners who signed up, and how far their organisation got." })}
      </div>
      ${card("Sign-ups, activations and cancellations", `<div class="cd-chart">${groupedBars(d.months, ["signups", "activations", "cancellations"], ["New organisations", "Subscriptions activated", "Subscriptions cancelled"])}</div>
        <div class="cd-legend"><span><i style="background:var(--ink)"></i>New organisations</span><span><i style="background:var(--petal)"></i>Subscriptions activated</span><span><i style="background:var(--rival)"></i>Subscriptions cancelled</span></div>`, "", { eyebrow: "6 months" })}
      ${card("Billing events", table([
        { h: "When", v: (r) => esc(dtm(r.at)) }, { h: "Organisation", v: (r) => esc(r.name) }, { h: "Event", v: (r) => `<code>${esc(r.action)}</code>` },
      ], d.events, { click: (r) => A(r.slug) }), "", { eyebrow: "Newest first" })}`;
  } },

  margin: { title: "Margin", async draw() {
    const d = await api("GET", "margin");
    const rows = d.rows;
    return `${pageHead("Margin", "Price against estimated AI cost this month, per organisation. AI is our cost of goods, so this is where a plan stops paying for itself.")}
      <div class="kpis cdk">
        ${kpi("Organisations below 60%", num(rows.filter((r) => r.margin != null && r.margin < 60).length), "gross margin this month")}
        ${kpi("Negative margin", num(rows.filter((r) => r.margin != null && r.margin < 0).length), "AI cost above the price")}
        ${kpi("AI cost on our keys", usd(d.platformKeysUsd), "this month", "Organisations allowed to fall back to the platform's AI keys. We pay for these calls.")}
        ${kpi("AI cost, month", usd(d.byEngine.reduce((t, r) => t + r.usd, 0)), "estimated at list prices", "", { cls: "dark" })}
      </div>
      ${card("Per organisation", table([
        { h: "Organisation", v: (r) => `<b>${esc(r.name)}</b>${r.platformKeys ? ' <span class="cd-st warn">our keys</span>' : ""}` },
        { h: "Plan", v: (r) => esc(r.plan) },
        { h: "Price / mo", r: 1, v: (r) => (r.mrrInr ? inr(r.mrrInr, true) : '<span class="cd-mute">—</span>') },
        { h: "AI cost", r: 1, v: (r) => usd(r.spentUsd) },
        { h: "Cost vs cap", v: (r) => { const p = r.capUsd ? Math.min(100, (100 * r.spentUsd) / r.capUsd) : 0; return r.capUsd ? `<span class="cd-mbar" title="${usd(r.spentUsd)} of ${usd(r.capUsd)} cap"><i class="${p >= 100 ? "bad" : p >= 80 ? "warn" : ""}" style="width:${p}%"></i></span>` : '<span class="cd-mute">no cap</span>'; } },
        { h: "Margin", r: 1, v: (r) => (r.margin == null ? '<span class="cd-mute">no revenue</span>' : `<span class="cd-st ${marginTone(r.margin)}">${r.margin}%</span>`) },
      ], rows, { click: (r) => A(r.slug) }), "", { eyebrow: "This month, lowest margin first", desc: "Price before tax against estimated AI cost; the bar is cost against the plan's AI cap." })}
      <div class="grid2">
        ${card("Cost by engine", bars(d.byEngine, (r) => r.engine, (r) => r.usd, (r) => `${usd(r.usd)} · ${num(r.calls)} calls`, "p"), "", { eyebrow: "This month" })}
        ${card("Cost by kind of call", bars(d.byKind, (r) => r.kind, (r) => r.usd, (r) => `${usd(r.usd)} · ${num(r.calls)}`), "", { eyebrow: "This month" })}
      </div>`;
  } },

  live: { title: "Live", async draw() {
    return `${pageHead("Live", "Who is in White Petal right now and what is happening. Updates every 5 seconds.", '<span class="fc-chip"><span class="cd-pulse" aria-hidden="true"></span><span id="liveAge" aria-live="polite">Connecting…</span></span>')}
      <div class="kpis cdk cd-live-kpis" id="liveKpis">${["People online", "Active today", "Organisations online", "Checks running", "Events, last minute", "AI spend, last hour"].map((l) => kpi(l, "—")).join("")}</div>
      ${card("Activity, last 60 minutes", `<div class="cd-chart" id="liveMinutes"></div><div class="cd-legend"><span><i class="c2"></i>Page views</span><span><i class="c1"></i>AI calls</span><span><i class="c3"></i>Checks started</span></div>`)}
      <div class="grid2 act">
        ${card(`Online now <span class="muted" id="onlineCount"></span>`, `<div id="liveOnline"><div class="cd-empty">Waiting for the first update…</div></div>`)}
        <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
          ${card("Where they are", `<div id="liveWhere"><div class="cd-empty">—</div></div>`)}
          ${card("Checks running", `<div id="liveRuns"><div class="cd-empty">—</div></div>`)}
        </div>
      </div>
      ${card("Live feed <span class=\"muted\">· last 30 minutes</span>", `<div class="cd-feedlive" id="liveFeed"><div class="cd-empty">—</div></div>`)}`;
  }, after() { startLive(); } },

  plans: { title: "Plans", async draw(arg) {
    const [d, ps] = await Promise.all([api("GET", "/api/admin/plans"), api("GET", "plans-subs").catch(() => null)]);
    STATE.plans = d; const st = Object.fromEntries((ps?.plans || []).map((x) => [x.code, x]));
    const price = (p, c) => (p.prices[c] ? money(p.prices[c].amount, c) : "—");
    return `${pageHead("Plans", "The plan catalogue: prices, limits and the Razorpay plan behind each price. Edits apply at once; every change is audited.")}
      <div class="cd-form-row"><button class="btn sm" type="button" data-go="plans/new">New plan</button><button class="btn ghost sm" type="button" id="syncPlans">Create missing Razorpay plans</button><span class="muted" id="syncPlansOut"></span></div>
      ${card("Catalogue", table([
        { h: "Plan", v: (p) => `<b>${esc(p.name)}</b> <code>${esc(p.code)}</code>${p.featured ? ' <span class="cd-st info">most popular</span>' : ""}${p.active ? "" : ' <span class="cd-st">inactive</span>'}<div class="muted" style="font-size:.78rem">${esc(p.description)}</div>` },
        { h: "Sold as", v: (p) => (p.selfServe ? "Self-serve" : p.public ? "Talk to us" : "Hidden") },
        { h: "INR / mo", r: 1, v: (p) => price(p, "INR") }, { h: "USD / mo", r: 1, v: (p) => price(p, "USD") },
        { h: "Razorpay", v: (p) => Object.entries(p.prices).filter(([, v]) => v.amount > 0).map(([c, v]) => `<span class="cd-st ${v.razorpayPlanId ? "good" : "warn"}">${c}</span>`).join(" ") || '<span class="cd-mute">—</span>' },
        { h: "Brands / questions / seats", v: (p) => [p.limits.brands, p.limits.questions, p.limits.seats].map((x) => (x == null ? "∞" : x)).join(" / ") },
        { h: "AI cap", r: 1, v: (p) => (p.aiCapUsd == null ? "none" : usd(p.aiCapUsd, 0)) },
        { h: "Accounts", r: 1, v: (p) => `${num(st[p.code]?.orgs ?? d.organisations[p.code] ?? 0)}${st[p.code]?.paying ? ` <span class="muted cd-sm">${num(st[p.code].paying)} paying</span>` : ""}` },
        { h: "People", r: 1, v: (p) => num(st[p.code]?.people || 0) },
        { h: "MRR", r: 1, v: (p) => (st[p.code]?.mrrInr ? `<b>${inr(st[p.code].mrrInr, true)}</b>` : '<span class="cd-mute">—</span>') },
        { h: "", r: 1, v: (p) => (["legacy", "trial"].includes(p.code) ? '<span class="muted cd-sm">built in</span>' : `<button class="btn ghost sm cd-danger-ghost" type="button" data-delplan="${esc(p.code)}">${d.organisations[p.code] ? "Archive" : "Delete"}</button>`) },
      ], d.plans, { click: (p) => "plans/" + p.code }))}`;
  }, after() {
    $("#pages").onclick = (e) => { const b = e.target.closest("[data-delplan]"); if (!b) return; e.stopPropagation(); deletePlanModal(b.dataset.delplan); };
    $("#syncPlans")?.addEventListener("click", async () => {
      $("#syncPlansOut").textContent = "Talking to Razorpay…";
      try { const r = await api("POST", "/api/admin/billing/sync-plans", { action: "create" }); $("#syncPlansOut").textContent = r.rows.map((x) => `${x.plan} ${x.currency}: ${x.status}`).join(" · ") || "Nothing to create."; }
      catch (e) { $("#syncPlansOut").textContent = e.message; }
    });
  } },
};

/* ── Account groups ── */
function groupsHtml(groups) {
  const KIND = { internal: "Internal · left out", demo: "Demo · hidden with the switch", custom: "Custom · counted" };
  return (groups.length ? groups.map((g) => `<div class="fc-group ${g.kind}" data-group="${g.id}"><header><b>${esc(g.name)}</b><span class="muted">${g.members.length} account${g.members.length === 1 ? "" : "s"}</span>
      <span class="tag">${g.kind === "internal" && !g.leave_out ? "Internal · counted" : KIND[g.kind]}</span></header>
      <div class="fc-members">${g.members.map((m) => `<span>${esc(m.name)}${m.owner ? ` <span class="muted cd-sm">${esc(m.owner)}</span>` : ""}<button type="button" data-unpick="${esc(m.slug)}" aria-label="Remove ${esc(m.name)}">✕</button></span>`).join("") || '<span class="muted cd-sm">No accounts yet: tick them in Accounts below.</span>'}</div>
      <div class="fc-gacts">${g.kind !== "custom" ? `<label><input type="checkbox" data-leave${g.leave_out ? " checked" : ""}>Leave out of customer metrics</label>` : ""}
        <button type="button" data-view>View only this group</button><button type="button" data-rename>Rename</button><button type="button" data-del>Delete</button></div></div>`).join("")
    : '<div class="cd-empty"><b>No groups yet</b>Create one for your team and test accounts so they stay out of the figures.</div>')
    + `<form id="groupForm" class="cd-form-row" hidden><input id="gName" placeholder="Group name, e.g. Founding team" maxlength="60" aria-label="Group name"><select id="gKind" aria-label="Kind"><option value="internal">Internal (left out)</option><option value="demo">Demo (hidden with the switch)</option><option value="custom">Custom (counted)</option></select><button class="btn sm" type="submit">Create</button></form>`;
}
function bindGroups() {
  const box = $("#groups"); if (!box) return;
  $("#newGroup")?.addEventListener("click", () => { $("#groupForm").hidden = false; $("#gName").focus(); });
  box.addEventListener("submit", async (e) => { if (e.target.id !== "groupForm") return; e.preventDefault();
    try { await api("POST", "groups", { name: $("#gName").value, kind: $("#gKind").value }); toast("Group created."); await refreshMe(); route(); } catch (err) { toast(err.message); } });
  box.addEventListener("click", async (e) => {
    const g = e.target.closest("[data-group]"); if (!g) return; const id = g.dataset.group;
    try {
      if (e.target.closest("[data-unpick]")) { await api("PATCH", `groups/${id}`, { remove: [e.target.closest("[data-unpick]").dataset.unpick] }); toast("Removed from the group."); return route(); }
      if (e.target.closest("[data-view]")) { setScope({ accounts: "group:" + id }); return; }
      if (e.target.closest("[data-del]")) { if (g.dataset.confirm !== "1") { g.dataset.confirm = "1"; e.target.textContent = "Click again to delete"; return; } await api("DELETE", `groups/${id}`); toast("Group deleted."); await refreshMe(); return route(); }
      if (e.target.closest("[data-rename]")) { const b = g.querySelector("header b"); b.innerHTML = `<input value="${esc(b.textContent)}" maxlength="60" aria-label="New name" data-newname>`; b.querySelector("input").focus(); return; }
    } catch (err) { toast(err.message); }
  });
  box.addEventListener("keydown", async (e) => { const i = e.target.closest("[data-newname]"); if (!i || e.key !== "Enter") return; e.preventDefault();
    try { await api("PATCH", `groups/${i.closest("[data-group]").dataset.group}`, { name: i.value }); toast("Renamed."); await refreshMe(); route(); } catch (err) { toast(err.message); } });
  box.addEventListener("change", async (e) => { const c = e.target.closest("[data-leave]"); if (!c) return;
    try { await api("PATCH", `groups/${c.closest("[data-group]").dataset.group}`, { leaveOut: c.checked }); toast(c.checked ? "Left out of customer metrics." : "Counted in customer metrics."); route(); } catch (err) { toast(err.message); } });
}

/* ── Account drawer ── */
async function openAccount(slug) {
  const sheet = $("#sheet"); sheet.hidden = false; $("#sheetTitle").textContent = "Loading…"; $("#sheetBody").innerHTML = '<p class="muted cd-pad">Loading…</p>';
  try {
    const d = await api("GET", "customers/" + encodeURIComponent(slug)), o = d.org, s = d.subscription;
    if (["founder", "finance"].includes(STATE.me.role)) STATE.allPlans = (await api("GET", "/api/admin/plans").catch(() => ({ plans: [] }))).plans;
    $("#sheetTitle").innerHTML = `${esc(o.name)}${o.paused_at ? ' <span class="cd-st bad">Suspended</span>' : ""}`;
    $("#sheetBody").innerHTML = drawAccount(d);
    paintIcons($("#sheetBody")); bindNotes(slug); bindBilling(slug, () => openAccount(slug)); bindAccount(slug); bindLimits(slug);
    $("#openInApp")?.addEventListener("click", async () => { try { await api("POST", `/api/orgs/${encodeURIComponent(slug)}/switch`); location.href = "/"; } catch (err) { toast(err.message); } });
    $("#acctGroupAdd")?.addEventListener("click", async () => { try { await api("PATCH", `groups/${$("#acctGroup").value}`, { add: [slug] }); toast("Added to the group."); await refreshMe(); STATE.drawn = null; openAccount(slug); route(); } catch (err) { toast(err.message); } });
    $$("[data-ungroup]", $("#sheetBody")).forEach((b) => b.addEventListener("click", async () => { try { await api("PATCH", `groups/${b.dataset.ungroup}`, { remove: [slug] }); toast("Removed from the group: counted as a customer unless another group leaves it out."); await refreshMe(); STATE.drawn = null; openAccount(slug); route(); } catch (err) { toast(err.message); } }));
  } catch (e) { $("#sheetBody").innerHTML = `<div class="cd-err">${esc(e.status === 403 ? "Your operator role can't open accounts." : e.message)}</div>`; }
}
function closeAccount() { $("#sheet").hidden = true; const [h] = location.hash.slice(1).split("?"); if (location.hash.includes("account=")) history.replaceState(null, "", "#" + h); }
const ROLES = ["owner", "admin", "editor", "viewer"], canPeople = () => ["founder", "finance", "support"].includes(STATE.me.role);
function peopleCard(d) {
  const can = canPeople(), roleSel = (m) => (can ? `<select data-role-of="${esc(m.id)}" aria-label="Role for ${esc(m.email)}">${ROLES.map((r) => `<option${r === m.role ? " selected" : ""}>${r}</option>`).join("")}</select>` : esc(m.role));
  return card(`People <span class="muted">· ${d.members.length}</span>`, `${table([
      { h: "Person", v: (m) => `<b>${esc(m.name || m.email)}</b>${m.name ? `<div class="muted cd-sm">${esc(m.email)}</div>` : ""}${m.verified ? "" : ' <span class="cd-st warn">unverified</span>'}` },
      { h: "Role", v: roleSel }, { h: "Last login", v: (m) => esc(ago(m.last_login_at)) },
      { h: "", v: (m) => [can && m.role !== "owner" ? `<button class="linkbtn cd-sm" type="button" data-remove="${esc(m.id)}">Remove</button>` : "",
          STATE.me.role === "founder" && m.id !== STATE.me.id ? `<button class="linkbtn cd-sm cd-danger-ghost" type="button" data-deluser="${esc(m.id)}">Delete user</button>` : ""].filter(Boolean).join(" · ") }], d.members)}
    ${d.invites.length ? `<div class="cd-tl">${d.invites.map((i) => `<div><time>Invited ${esc(ago(i.created_at))}</time><span>${esc(i.email)} <span class="cd-st">${esc(i.role)}</span> <span class="muted cd-sm">expires ${esc(until(i.expires_at))}</span>${can ? ` <button class="linkbtn cd-sm" type="button" data-revoke="${esc(i.id)}">Revoke</button>` : ""}</span></div>`).join("")}</div>` : ""}
    ${can ? `<form class="cd-note" id="inviteForm"><input type="email" id="invEmail" required placeholder="Invite by email" aria-label="Email to invite"><select id="invRole" aria-label="Role">${ROLES.map((r) => `<option${r === "editor" ? " selected" : ""}>${r}</option>`).join("")}</select><button class="btn sm" type="submit">Invite</button></form><p class="cd-foot muted" id="invOut" role="status">Making someone owner hands ownership over; the previous owner stays as an admin.</p>` : ""}`,
    "", { eyebrow: "Members and invites" });
}
function settingsCard(d) {
  const o = d.org, can = canPeople(), founder = STATE.me.role === "founder";
  if (!can) return "";
  return card("Account settings", `<div class="cd-bill">
      <form class="cd-form-row" id="renameForm"><input id="rnName" value="${esc(o.name)}" maxlength="80" aria-label="Organisation name"><button class="btn ghost sm" type="submit">Rename</button></form>
      <details class="cd-act"${o.paused_at ? " open" : ""}><summary>${o.paused_at ? "Resume this account" : "Suspend this account"}</summary><form class="cd-form" id="suspendForm">
        <p class="muted">${o.paused_at ? `Suspended ${esc(ago(o.paused_at))}. Resuming lets its people run checks and make changes again.` : "Suspending makes the account read-only straight away: reports stay readable, checks, drafts, edits and scheduled runs stop. Billing is not touched."}</p>
        <label for="spReason">Reason</label><input id="spReason" maxlength="200" required><button class="btn sm${o.paused_at ? "" : " cd-danger"}" type="submit">${o.paused_at ? "Resume" : "Suspend"}</button><div role="status"></div></form></details>
      ${founder ? `<details class="cd-act"><summary>Delete this account</summary><form class="cd-form" id="deleteForm">
        <p class="muted">Removes the organisation and everything in it: brands, checks, usage, notes. It can't be undone. Refused while a Razorpay subscription is live.</p>
        <label for="delConfirm">Type <code>${esc(o.slug)}</code> to confirm</label><input id="delConfirm" autocomplete="off"><label for="delReason">Reason</label><input id="delReason" maxlength="200">
        <button class="btn sm cd-danger" type="submit">Delete account</button><div role="status"></div></form></details>` : ""}
    </div>`, o.paused_at ? '<span class="cd-st bad">Suspended</span>' : "", { eyebrow: "Changes the account" });
}
function bindAccount(slug) {
  const S = encodeURIComponent(slug), again = (msg) => { toast(msg); STATE.drawn = null; openAccount(slug); route(); };
  const body = $("#sheetBody"), err = (sel, e) => { const o = $(sel); if (o) o.innerHTML = `<p class="cd-err">${esc(e.message)}</p>`; else toast(e.message); };
  body.onchange = async (e) => { const sel = e.target.closest("[data-role-of]"); if (!sel) return;
    try { await api("PATCH", `accounts/${S}/people/${sel.dataset.roleOf}`, { role: sel.value }); again(sel.value === "owner" ? "Ownership handed over." : "Role changed."); } catch (er) { toast(er.message); openAccount(slug); } };
  body.onclick = async (e) => {
    const rm = e.target.closest("[data-remove]"), rv = e.target.closest("[data-revoke]"), du = e.target.closest("[data-deluser]");
    if (du) return deleteUserModal(du.dataset.deluser, slug);
    try {
      if (rm) { if (rm.dataset.sure !== "1") { rm.dataset.sure = "1"; rm.textContent = "Click again to remove"; return; } await api("DELETE", `accounts/${S}/people/${rm.dataset.remove}`); again("Removed."); }
      if (rv) { await api("DELETE", `accounts/${S}/invites/${rv.dataset.revoke}`); again("Invite revoked."); }
    } catch (er) { toast(er.message); }
  };
  $("#inviteForm")?.addEventListener("submit", async (e) => { e.preventDefault();
    try { const r = await api("POST", `accounts/${S}/people`, { email: $("#invEmail").value, role: $("#invRole").value });
      toast(r.invite.emailed ? "Invite emailed." : "Invite created."); await openAccount(slug);
      if (!r.invite.emailed) $("#invOut").innerHTML = `Email isn't set up here, so send ${esc(r.invite.email)} this link: <code>${esc(r.invite.link)}</code>`;
    } catch (er) { err("#invOut", er); } });
  $("#renameForm")?.addEventListener("submit", async (e) => { e.preventDefault(); try { await api("PATCH", `accounts/${S}`, { name: $("#rnName").value }); again("Renamed."); } catch (er) { toast(er.message); } });
  $("#suspendForm")?.addEventListener("submit", async (e) => { e.preventDefault(); const paused = !!e.target.querySelector(".btn:not(.cd-danger)");
    try { await api("PATCH", `accounts/${S}`, { suspended: !paused, reason: $("#spReason").value }); again(paused ? "Resumed." : "Suspended: the account is read-only."); } catch (er) { err("#suspendForm [role=status]", er); } });
  $("#deleteForm")?.addEventListener("submit", async (e) => { e.preventDefault();
    try { await api("DELETE", `accounts/${S}`, { confirm: $("#delConfirm").value.trim(), reason: $("#delReason").value }); toast("Account deleted."); STATE.drawn = null; closeAccount(); route(); }
    catch (er) { err("#deleteForm [role=status]", er); } });
}
function drawAccount(d) {
  const o = d.org, s = d.subscription, groups = STATE.me.groups || [];
  const kv = (rows) => `<dl class="fc-kv">${rows.filter(Boolean).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const timeline = [...d.audit.map((a) => ({ at: a.at, t: `<code>${esc(a.action)}</code> ${esc(a.target || "")}`, who: a.who })),
    ...d.runs.map((r) => ({ at: r.started_at, t: `Check on <b>${esc(r.brand)}</b> <span class="cd-st ${RUN[r.status] || ""}">${esc(r.status)}</span> <span class="muted">${esc(r.source)}</span>` })),
    ...d.emails.map((e) => ({ at: e.created_at, t: `Email <code>${esc(e.kind)}</code> ${esc(e.status || "")}` }))].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30);
  return `
    ${((inG, canG, free) => card("Account groups", `<div class="cd-pad">${inG.length ? `<p class="cd-form-row">${inG.map((g) => `<span class="fc-chip ${g.kind}">${esc(g.name)} <span class="muted cd-sm">${esc({ internal: "internal", demo: "demo", custom: "custom" }[g.kind] || "")}</span>${canG ? `<button type="button" data-ungroup="${g.id}" aria-label="Remove from ${esc(g.name)}" title="Remove from ${esc(g.name)}">✕</button>` : ""}</span>`).join("")}</p>`
        : '<p class="muted">In no group: counted as a customer.</p>'}
      ${canG && free.length ? `<div class="cd-form-row" style="margin-top:10px"><select id="acctGroup" aria-label="Group">${free.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select><button class="btn ghost sm" type="button" id="acctGroupAdd">Add</button></div>` : ""}</div>`,
      "", { eyebrow: "Account type", desc: "Internal and demo groups keep founders' and test accounts out of the customer figures. Remove an account from a group to count it as a customer again." }))(d.groups || [], STATE.me.role !== "analyst", groups.filter((g) => !(d.groups || []).some((x) => x.id === g.id)))}
    ${card("Account", kv([["Owner", esc(o.owner || "—")], ["Status", status(o.billing_status)], ["Brands", d.brands.length ? d.brands.map((b) => esc(b.name)).join(", ") : "No brand yet"], ["People", num(d.members.length)],
      ["Health", `${healthChip(o.health, o.band)} <span class="muted">${esc(o.band)}</span>`], ["AI this month", `${usd(o.spent_usd)}${o.capUsd ? ` of ${usd(o.capUsd)} cap` : ""}`], ["Signed up", esc(dtm(o.created_at))],
      ["Last check", esc(o.last_run ? `${dtm(o.last_run)} · ${ago(o.last_run)}` : "never")], ["Account id", `<code>${esc(o.slug)}</code>`]])
      + (STATE.me.canVisit ? `<div class="cd-pad cd-form-row"><button class="btn ghost sm" type="button" id="openInApp">Open in the app</button><span class="muted cd-sm">See White Petal as this account does. The visit is written to its activity log.</span></div>` : ""))}
    ${card("Plan and subscription", kv([["Plan", `<b>${esc(s.plan)}</b> <code>${esc(s.planCode)}</code>`], ["Status", status(s.status)],
        ["Price", s.price ? `${money(s.price, s.currency)} / ${s.cycleKey === "annual" ? "year" : "mo"} <span class="muted">· ${money(s.priceWithTax, s.currency)} with tax · ${esc(s.currency)}</span>` : '<span class="muted">No price</span>'],
        ["Billing cycle", `${esc(s.cycle)}${s.cycleKey === "annual" && s.monthly ? ` <span class="muted">· ${money(s.monthly, s.currency)} / mo equivalent</span>` : ""}${s.cycleKey === "monthly" && s.annualOffer ? ` <span class="muted">· annual offered at ${money(s.annualOffer, s.currency)} / yr</span>` : ""}`],
        ["Payment", esc(s.payment)], ["MRR counted", s.mrrInr ? `${inr(s.mrrInr, true)}${s.extraSeats && s.seatPrice ? ` <span class="muted">incl. ${num(s.extraSeats)} extra seat${s.extraSeats > 1 ? "s" : ""}</span>` : ""}` : '<span class="muted">—</span>'],
        ["Extra seats", s.extraSeats ? `<b>${num(s.extraSeats)}</b> <span class="muted">· ${s.seatBilling === "razorpay" ? "billed through Razorpay each renewal" : "invoiced"}${s.seatPrice != null ? ` · ${money(s.seatPrice, s.currency)} / seat / mo` : ""}</span>` : `None${s.maxExtraSeats === 0 ? ' <span class="muted">(not sold on this plan)</span>' : ""}`],
        ["Free trial on this plan", s.trialDays === 0 ? "None" : `${s.trialDays ?? STATE.trialDefault ?? 7} days`],
        ["Customer since", esc(s.started ? dt(s.started) : "—")], s.trialEnds ? ["Trial", esc(`${s.trialStarted ? dt(s.trialStarted) + " → " : ""}${dt(s.trialEnds)} (${until(s.trialEnds)})`)] : null,
        s.periodEnd ? ["Current period", esc(`${s.periodStart ? dt(s.periodStart) + " → " : ""}${dt(s.periodEnd)} (${until(s.periodEnd)})`)] : null,
        s.graceEnds ? ["Grace ends", esc(dt(s.graceEnds))] : null, ["Cancels at period end", s.cancelAtEnd ? '<span class="cd-st warn">Yes</span>' : "No"],
        s.pendingPlan ? ["Scheduled change", `→ <b>${esc(s.pendingPlan)}</b> at the period end`] : null,
        ["Razorpay subscription", s.razorpay ? `<code>${esc(s.razorpay)}</code>` : s.pendingLink ? `<code>${esc(s.pendingLink)}</code> <span class="muted">link sent, not paid</span>` : '<span class="muted">none</span>'],
        s.razorpay ? ["Last synced", esc(s.reconciled ? ago(s.reconciled) : "never")] : null, ["Charges recorded", num(s.charges)], ["AI cap", s.capUsd == null ? "None" : `${usd(s.capUsd, 0)} / month`],
        ]),
      `<span class="cd-st ${s.status === "active" ? "good" : s.status === "past_due" ? "bad" : "info"}">${esc(s.plan)}</span>`,
      { eyebrow: "Billing", desc: "What this organisation is on, what it pays, and when that changes. Only Razorpay's confirmation moves a card subscription." })}
    ${limitsCard(d)}
    ${card("Billing actions", billingActions(d), "", { eyebrow: "Changes money", desc: "Every action needs a reason and is written to the audit log." })}
    ${s.history.length ? card("Subscription history", `<div class="cd-tl">${s.history.map((h) => `<div><time>${esc(dtm(h.at))}</time><span><code>${esc(h.action.replace("billing.", ""))}</code> ${esc(h.target || "")}${h.detail?.reason ? ` <span class="muted">· “${esc(h.detail.reason)}”</span>` : ""}${h.who ? ` <span class="muted">· ${esc(h.who)}</span>` : ""}</span></div>`).join("")}</div>`) : ""}
    ${card("Brands", table([{ h: "Brand", v: (b) => `<b>${esc(b.name)}</b><div class="muted cd-sm">${esc(b.site || "")}</div>` }, { h: "Schedule", v: (b) => esc(b.schedule) }, { h: "Last check", v: (b) => esc(ago(b.last_run_at)) }, { h: "Open actions", r: 1, v: (b) => num(b.actions) }], d.brands))}
    ${peopleCard(d)}
    ${card("Timeline", timeline.length ? `<div class="cd-tl">${timeline.map((x) => `<div><time>${esc(dtm(x.at))}</time><span>${x.t}${x.who ? ` <span class="muted">· ${esc(x.who)}</span>` : ""}</span></div>`).join("")}</div>` : '<div class="cd-empty">No activity yet.</div>')}
    ${card(`Notes <span class="muted">· internal</span>`, `<form class="cd-note" id="noteForm"><textarea id="noteIn" maxlength="4000" placeholder="Add a note only operators can see" aria-label="New note"></textarea><button class="btn sm" type="submit">Add</button></form>
      <div class="cd-tl" id="notes">${d.notes.map((n) => `<div><time>${esc(dtm(n.at))}</time><span>${esc(n.body)} <span class="muted">· ${esc(n.by || "")}</span></span></div>`).join("") || '<div class="cd-empty">No notes yet.</div>'}</div>`)}
    ${settingsCard(d)}
    ${card("AI usage this month", bars(d.usage, (u) => `${u.kind}${u.engine ? " · " + u.engine : ""}`, (u) => u.usd, (u) => `${usd(u.usd, 3)} · ${num(u.calls)}`, "p"))}`;
}

/* ── global filters ── */
function setScope(patch) { Object.assign(SCOPE, patch); try { localStorage.setItem("cd.scope", JSON.stringify(SCOPE)); } catch {} paintFilters(); route(); }
function paintFilters() {
  const sel = $("#fAccounts"), groups = STATE.me?.groups || [];
  sel.innerHTML = `<option value="customers">Customers only</option><option value="all">All accounts</option>${groups.length ? `<optgroup label="Only this group">${groups.map((g) => `<option value="group:${g.id}">${esc(g.name)} (${g.n})</option>`).join("")}</optgroup>` : ""}`;
  if (![...sel.options].some((o) => o.value === SCOPE.accounts)) SCOPE.accounts = "customers";
  sel.value = SCOPE.accounts; $("#fDays").value = String(SCOPE.days); $("#fDemo").checked = !!SCOPE.demo;
}
async function refreshMe() { STATE.me = await api("GET", "me"); STATE.trialDefault = STATE.me.trialDays; paintFilters(); }

const LIMITS = [["brands", "Brands"], ["questions", "Questions tracked"], ["competitors", "Competitors per brand"], ["seats", "Seats"], ["drafts", "Drafted fixes / period"], ["samples", "Answers per question"], ["checks", "Checks / period"], ["pages", "Website pages read per check"]];
function planEditor(p, d) {
  const o = d.options, isNew = !p, f = p || { code: "", name: "", description: "", sort: 50, public: false, selfServe: false, featured: false, active: true, aiCapUsd: null, limits: {}, engines: ["chatgpt", "perplexity", "gemini"], schedules: ["off", "weekly"], integrations: [], prices: {} };
  const ck = (name, list, on) => list.map((x) => `<label class="cd-ck"><input type="checkbox" name="${name}" value="${esc(x)}"${on.includes(x) || on.includes("*") ? " checked" : ""}>${esc(x)}</label>`).join("");
  const mon = (v) => (v == null || v === "" ? "" : v / 100);
  const save = (pr) => (pr?.amount > 0 && pr?.annualAmount > 0 ? Math.round((1 - pr.annualAmount / (pr.amount * 12)) * 100) : null);
  const rzBtn = (c, cycle, pr, id) => (!isNew && (cycle === "annual" ? pr?.annualAmount : pr?.amount) && !id ? `<button class="btn ghost sm" type="button" data-rzp="${c}" data-cycle="${cycle}">Create in Razorpay</button>` : "");
  const priceRow = (c) => { const pr = f.prices[c], sv = save(pr);
    return `<div class="fc-price"><b class="ccy">${c}</b>
      <div class="fc-price-row"><span class="lbl">Monthly</span><input id="pr_${c}" type="number" min="0" step="1" value="${mon(pr?.amount)}" placeholder="price / month" aria-label="${c} monthly price">
        <input id="rz_${c}" value="${esc(pr?.razorpayPlanId || "")}" placeholder="Razorpay plan id" aria-label="${c} monthly Razorpay plan id">${rzBtn(c, "monthly", pr, pr?.razorpayPlanId)}</div>
      <div class="fc-price-row"><span class="lbl">Annual</span><input id="pa_${c}" type="number" min="0" step="1" value="${mon(pr?.annualAmount)}" placeholder="price / year (optional)" aria-label="${c} annual price">
        <input id="ra_${c}" value="${esc(pr?.annualRazorpayPlanId || "")}" placeholder="yearly Razorpay plan id" aria-label="${c} annual Razorpay plan id">${rzBtn(c, "annual", pr, pr?.annualRazorpayPlanId)}
        ${sv != null ? `<span class="cd-st ${sv > 0 ? "lime" : "warn"}">${sv > 0 ? `saves ${sv}%` : "no saving"} vs 12 × monthly</span>` : ""}</div>
      <div class="fc-price-row"><span class="lbl">Extra seat</span><input id="ps_${c}" type="number" min="0" step="1" value="${mon(pr?.seatAmount)}" placeholder="price / seat / month (optional)" aria-label="${c} extra seat price"></div></div>`; };
  return { title: isNew ? "New plan" : f.name,
    sub: isNew ? "A plan for one customer (a custom deal) or for everyone. Prices are before tax; Razorpay charges INR with 18% GST added. Annual prices are billed once a year." : `Plan code <code>${esc(f.code)}</code> · ${count(d.organisations[f.code] || 0, "organisation")} on it`,
    html: `<form id="planForm" class="cd-pf" data-code="${esc(f.code)}">
      <div class="cd-pf-grid">
        <label>Code<input id="pf_code" required pattern="[a-z][a-z0-9_\\-]{1,30}" value="${esc(f.code)}"${isNew ? "" : " readonly"} placeholder="e.g. acme-custom"></label>
        <label>Name<input id="pf_name" required maxlength="60" value="${esc(f.name)}"></label>
        <label class="wide">Description<input id="pf_desc" maxlength="200" value="${esc(f.description)}"></label>
        <label>AI cost cap, USD / month<input id="pf_cap" type="number" min="0" step="1" value="${f.aiCapUsd ?? ""}" placeholder="empty = none"></label>
        <label>Order<input id="pf_sort" type="number" min="0" max="1000" value="${f.sort}"></label>
      </div>
      <fieldset><legend>Who can see and buy it</legend>
        <label class="cd-ck"><input type="checkbox" id="pf_public"${f.public ? " checked" : ""}>Shown on the pricing page</label>
        <label class="cd-ck"><input type="checkbox" id="pf_self"${f.selfServe ? " checked" : ""}>Can be bought by card</label>
        <label class="cd-ck"><input type="checkbox" id="pf_feat"${f.featured ? " checked" : ""}>Most popular</label>
        <label class="cd-ck"><input type="checkbox" id="pf_active"${f.active ? " checked" : ""}>Active</label></fieldset>
      <fieldset><legend>Limits (empty = unlimited)</legend><div class="cd-pf-grid">${LIMITS.map(([k, l]) => `<label>${l}<input id="lim_${k}" type="number" min="0" step="1" value="${f.limits[k] ?? ""}"></label>`).join("")}</div></fieldset>
      <fieldset><legend>AI engines</legend>${ck("engines", o.engines, f.engines)}</fieldset>
      <fieldset><legend>Automatic checks</legend>${ck("schedules", o.schedules, f.schedules)}</fieldset>
      <fieldset><legend>Integrations</legend>${ck("integrations", o.integrations, f.integrations)}</fieldset>
      <fieldset><legend>Trial and extra seats</legend><div class="cd-pf-grid">
        <label>Free trial (days)<input id="pf_trial" type="number" min="0" max="90" step="1" value="${f.trialDays ?? ""}" placeholder="empty = default (${esc(String(STATE.trialDefault || 7))})"></label>
        <label>Most extra seats<input id="pf_xseats" type="number" min="0" step="1" value="${f.maxExtraSeats ?? ""}" placeholder="empty = no cap, 0 = not sold"></label>
        <p class="wide muted cd-sm">A trial of 0 days means this plan has no free trial: people subscribe to start it. Picking a plan with a longer trial during a trial stretches it; a shorter one never cuts it. Extra seats are added to an account from its drawer and billed at the seat price below.</p></div></fieldset>
      <fieldset><legend>Prices (before tax)</legend>${["INR", "USD"].map(priceRow).join("")}</fieldset>
      <div class="cd-form-row"><button class="btn sm" type="submit">${isNew ? "Create plan" : "Save changes"}</button>
        ${isNew ? "" : `<button class="btn ghost sm" type="button" id="pfCopy">Duplicate</button>`}<span id="pfOut" role="status"></span></div>
    </form>
    ${isNew || ["legacy", "trial"].includes(f.code) ? "" : card("Delete plan", (d.organisations[f.code] || 0)
      ? `<div class="cd-pad"><p class="muted">${num(d.organisations[f.code])} organisation(s) are on this plan, so it can't be deleted. To archive it, untick <b>Active</b> above: nobody new can choose it, and current customers keep it.</p></div>`
      : `<form id="pfDel" class="cd-form cd-pad"><p class="muted">Nobody is on this plan. Deleting removes it from the catalogue for good (any Razorpay plan stays in Razorpay, unused).</p>
         <label for="pfDelConfirm">Type <code>${esc(f.code)}</code> to confirm</label><input id="pfDelConfirm" autocomplete="off"><button class="btn sm cd-danger" type="submit">Delete plan</button><div role="status"></div></form>`)}` };
}
// The plan editor opens as a pop-up over the catalogue; #plans/new and #plans/<code> still link straight to it.
let modalReturn = null;
function openPlanModal(arg) {
  const d = STATE.plans, p = arg === "new" ? null : d?.plans.find((x) => x.code === arg);
  if (!d || (arg !== "new" && !p)) { toast("No such plan."); closePlanModal(); return; }
  const m = planEditor(p, d), wrap = $("#modal");
  if (wrap.hidden) modalReturn = document.activeElement;
  $("#modalEyebrow").textContent = arg === "new" ? "Plan catalogue" : "Edit plan";
  $("#modalTitle").textContent = m.title; $("#modalSub").innerHTML = m.sub; $("#modalBody").innerHTML = m.html;
  wrap.hidden = false; paintIcons(wrap); bindPlanEditor();
  ($("#pf_code:not([readonly])") || $("#pf_name"))?.focus({ preventScroll: true });
  if (p) planOnIt(p.code);
}
// Who is on this plan and what each pays, at the top of the plan pop-up.
async function planOnIt(code) {
  const box = document.createElement("section"); box.className = "fc-onplan"; box.innerHTML = '<p class="muted cd-sm">Loading who is on this plan…</p>';
  $("#modalBody").prepend(box);
  let d; try { d = await api("GET", `plans/${encodeURIComponent(code)}/accounts`); } catch (err) { box.innerHTML = `<p class="cd-err">${esc(err.message)}</p>`; return; }
  if (!document.contains(box)) return;
  const k = d.kpis, per = (r) => (r.cycle === "annual" ? "yr" : "mo");
  box.innerHTML = `<span class="eyebrow">On this plan</span>
    <div class="fc-onplan-k"><div><b>${num(k.accounts)}</b><span>accounts</span></div><div><b>${num(k.people)}</b><span>people</span></div><div><b>${num(k.paying)}</b><span>paying${k.paying ? ` · ${num(k.viaRazorpay)} Razorpay, ${num(k.viaContract)} contract` : ""}</span></div>
      <div><b>${num(k.trials)}</b><span>on a trial</span></div><div><b>${k.mrrInr ? inr(k.mrrInr, true) : "—"}</b><span>MRR · ${k.arrInr ? inr(k.arrInr, true) : "—"} ARR</span></div></div>
    ${d.rows.length ? table([
      { h: "Account", v: (r) => `<b>${esc(r.name)}</b><div class="muted cd-sm">${esc(r.owner || "")}</div>` },
      { h: "Status", v: (r) => status(r.status) + (r.status === "trialing" && !r.trial ? ' <span class="cd-st warn">ended</span>' : "") },
      { h: "People", r: 1, v: (r) => num(r.people) + (r.extraSeats ? ` <span class="muted cd-sm">+${num(r.extraSeats)} seats</span>` : "") },
      { h: "Recurring payment", r: 1, v: (r) => (r.recurring ? `<b>${money(r.recurring, r.currency)}</b> / ${per(r)}<div class="muted cd-sm">${money(r.recurringWithTax, r.currency)} with GST</div>` : '<span class="cd-mute">—</span>') },
      { h: "MRR", r: 1, v: (r) => (r.mrrInr ? inr(r.mrrInr, true) : '<span class="cd-mute">—</span>') },
      { h: "Next charge", v: (r) => esc(r.nextCharge ? dt(r.nextCharge) : r.endsAt ? `ends ${dt(r.endsAt)}` : "—") },
      { h: "Pays by", v: (r) => esc(r.payment) }], d.rows, { click: (r) => A(r.slug) }) : '<div class="cd-empty">Nobody is on this plan yet.</div>'}
    <p class="muted cd-sm">Recurring payment = the plan's price for their billing cycle plus extra seats, before GST (with GST below it). MRR is that per month, in rupees. Follows the Accounts filter at the top.</p>`;
}
// Delete (nobody on it) or archive (accounts on it) straight from the catalogue, in the same pop-up.
function deletePlanModal(code) {
  const d = STATE.plans, p = d?.plans.find((x) => x.code === code); if (!p) return;
  const n = d.organisations[code] || 0, wrap = $("#modal");
  modalReturn = document.activeElement;
  $("#modalEyebrow").textContent = n ? "Archive plan" : "Delete plan"; $("#modalTitle").textContent = p.name;
  $("#modalSub").innerHTML = `Plan code <code>${esc(code)}</code> · ${count(n, "organisation")} on it`;
  $("#modalBody").innerHTML = n
    ? `<form id="pdForm" class="cd-form"><p>${count(n, "organisation")} ${n === 1 ? "is" : "are"} on this plan, so it can't be deleted: their subscriptions and limits point at it.
         <b>Archiving</b> takes it off the pricing page and out of checkout; the ${n === 1 ? "account keeps it" : "accounts keep it"} until moved. You can unarchive it from the plan's editor (tick Active).</p>
         ${p.active ? `<div class="cd-form-row"><button class="btn sm" type="submit">Archive plan</button><button class="btn ghost sm" type="button" data-mclose>Keep it</button></div>` : '<p class="muted">It is already archived.</p>'}<div role="status"></div></form>`
    : `<form id="pdForm" class="cd-form"><p>Nobody is on this plan. Deleting removes it from the catalogue for good.${Object.values(p.prices).some((x) => x.razorpayPlanId || x.annualRazorpayPlanId) ? " Its Razorpay plan stays in Razorpay (Razorpay plans can't be deleted) and simply goes unused." : ""}</p>
         <label for="pdConfirm">Type <code>${esc(code)}</code> to confirm</label><input id="pdConfirm" autocomplete="off">
         <div class="cd-form-row"><button class="btn sm cd-danger" type="submit">Delete plan</button><button class="btn ghost sm" type="button" data-mclose>Cancel</button></div><div role="status"></div></form>`;
  wrap.hidden = false; ($("#pdConfirm") || $("#pdForm button"))?.focus();
  $("#pdForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const out = $("#pdForm [role=status]");
    try {
      if (n) {
        // Hidden from new customers first; switched off too unless someone is paying on it (the server refuses that, and they keep it).
        const hidden = { ...p, public: false, selfServe: false, featured: false }, url = "/api/admin/plans/" + encodeURIComponent(code);
        let off = true; try { await api("PUT", url, { ...hidden, active: false }); } catch (err) { if (err.status !== 409) throw err; off = false; await api("PUT", url, hidden); }
        toast(off ? `${p.name} archived.` : `${p.name} hidden from new customers; paying accounts keep it.`);
      }
      else { if ($("#pdConfirm").value.trim() !== code) { out.innerHTML = '<p class="cd-err">Type the plan code exactly.</p>'; return; } await api("DELETE", "/api/admin/plans/" + encodeURIComponent(code)); toast(`${p.name} deleted.`); }
      closePlanModal(false); STATE.drawn = null; route();
    } catch (err) { out.innerHTML = `<p class="cd-err">${esc(err.message)}</p>`; }
  });
}
// Delete a person everywhere, after showing exactly what goes with them.
async function deleteUserModal(id, fromSlug) {
  const wrap = $("#modal"); modalReturn = document.activeElement;
  $("#modalEyebrow").textContent = "Delete user"; $("#modalTitle").textContent = "Loading…"; $("#modalSub").innerHTML = ""; $("#modalBody").innerHTML = "";
  wrap.hidden = false;
  let d; try { d = await api("GET", `users/${encodeURIComponent(id)}/deletion`); } catch (err) { $("#modalTitle").textContent = "Can't delete"; $("#modalBody").innerHTML = `<p class="cd-err">${esc(err.message)}</p>`; return; }
  $("#modalTitle").textContent = d.name || d.email; $("#modalSub").innerHTML = `${esc(d.email)} · in ${count(d.orgs.length, "organisation")}`;
  const gone = d.orgs.filter((o) => o.deleted), stay = d.orgs.filter((o) => !o.deleted);
  $("#modalBody").innerHTML = `<form id="duForm" class="cd-form">
    <p>Deletes this person's sign-in and removes them from every organisation. Their past activity stays in the audit log without their name. It can't be undone.</p>
    ${gone.length ? `<p><b>Also deleted</b>, because nobody else is in ${gone.length === 1 ? "it" : "them"}:</p><ul class="cd-list">${gone.map((o) => `<li><b>${esc(o.name)}</b> <code>${esc(o.slug)}</code> · ${count(o.brands, "brand")} and all their checks</li>`).join("")}</ul>` : ""}
    ${stay.length ? `<p><b>Removed from</b> (the organisation stays):</p><ul class="cd-list">${stay.map((o) => `<li>${esc(o.name)} <span class="muted">· was ${esc(o.role)}</span></li>`).join("")}</ul>` : ""}
    ${d.blockers.length ? `<div class="cd-err">${d.blockers.map((b) => `<p>${esc(b)}</p>`).join("")}</div><div class="cd-form-row"><button class="btn ghost sm" type="button" data-mclose>Close</button></div>`
      : `<label for="duConfirm">Type <code>${esc(d.email)}</code> to confirm</label><input id="duConfirm" autocomplete="off">
         <label for="duReason">Reason</label><input id="duReason" maxlength="200" placeholder="e.g. asked us to delete their data">
         <div class="cd-form-row"><button class="btn sm cd-danger" type="submit">Delete user</button><button class="btn ghost sm" type="button" data-mclose>Cancel</button></div><div role="status"></div>`}</form>`;
  ($("#duConfirm") || $("#duForm button"))?.focus();
  $("#duForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const out = $("#duForm [role=status]");
    try {
      const r = await api("DELETE", `users/${encodeURIComponent(id)}`, { confirm: $("#duConfirm").value.trim(), reason: $("#duReason").value });
      closePlanModal(false); toast(`${r.deleted} deleted${r.organisationsDeleted.length ? `, with ${count(r.organisationsDeleted.length, "organisation")}` : ""}.`);
      STATE.drawn = null;
      if (fromSlug && r.organisationsDeleted.includes(fromSlug)) closeAccount(); else if (fromSlug) openAccount(fromSlug);
      route();
    } catch (err) { out.innerHTML = `<p class="cd-err">${esc(err.message)}</p>`; }
  });
}
// Closing goes back to the catalogue address, so the browser's Back button and links stay in step with what is shown.
function closePlanModal(nav = true) {
  const wrap = $("#modal"); if (wrap.hidden) return;
  wrap.hidden = true; $("#modalBody").innerHTML = "";
  if (nav && location.hash.startsWith("#plans/")) location.hash = "plans";
  modalReturn?.focus?.({ preventScroll: true }); modalReturn = null;
}
function bindPlanEditor() {
  const form = $("#planForm"); if (!form) return;
  const vals = (n) => $$(`input[name="${n}"]:checked`, form).map((x) => x.value);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("#pf_code").value.trim(), prices = {};
    const minor = (id) => ($(id).value === "" ? null : Math.round(Number($(id).value) * 100));
    for (const c of ["INR", "USD"]) { if ($("#pr_" + c).value === "") continue;
      prices[c] = { amount: minor("#pr_" + c), razorpayPlanId: $("#rz_" + c).value.trim() || null, annualAmount: minor("#pa_" + c), annualRazorpayPlanId: $("#ra_" + c).value.trim() || null, seatAmount: minor("#ps_" + c) }; }
    const body = { name: $("#pf_name").value, description: $("#pf_desc").value, sort: Number($("#pf_sort").value || 50), public: $("#pf_public").checked, selfServe: $("#pf_self").checked,
      featured: $("#pf_feat").checked, active: $("#pf_active").checked, aiCapUsd: $("#pf_cap").value === "" ? null : Number($("#pf_cap").value),
      limits: Object.fromEntries(LIMITS.map(([k]) => [k, $("#lim_" + k).value === "" ? null : Number($("#lim_" + k).value)])),
      engines: vals("engines"), schedules: vals("schedules"), integrations: vals("integrations"), prices,
      trialDays: $("#pf_trial").value === "" ? null : Number($("#pf_trial").value), maxExtraSeats: $("#pf_xseats").value === "" ? null : Number($("#pf_xseats").value) };
    try { await api("PUT", "/api/admin/plans/" + encodeURIComponent(code), body); toast("Plan saved."); location.hash = "plans/" + code; if (location.hash === "#plans/" + code) route(); }
    catch (err) { $("#pfOut").innerHTML = `<span class="cd-err">${esc(err.message)}</span>`; }
  });
  $("#pfCopy")?.addEventListener("click", () => {
    $("#pf_code").readOnly = false; $("#pf_code").value = (form.dataset.code + "-copy").slice(0, 31); $("#pf_name").value += " (copy)";
    for (const c of ["INR", "USD"]) { $("#rz_" + c).value = ""; $("#ra_" + c).value = ""; } // a Razorpay plan belongs to one catalogue price
    $("#pf_feat").checked = false; // only one plan is "most popular": a copy must not take the badge from the original
    $$("[data-rzp]", form).forEach((x) => x.remove()); form.dataset.code = ""; $("button[type=submit]", form).textContent = "Create plan";
    $("#pf_code").focus(); $("#pfOut").textContent = "Copied. Change the code and name, then create.";
  });
  $("#pfDel")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const out = $("#pfDel [role=status]");
    if ($("#pfDelConfirm").value.trim() !== form.dataset.code) { out.innerHTML = `<p class="cd-err">Type the plan code exactly.</p>`; return; }
    try { await api("DELETE", "/api/admin/plans/" + encodeURIComponent(form.dataset.code)); toast("Plan deleted."); STATE.drawn = null; closePlanModal(false); location.hash = "plans"; route(); }
    catch (err) { out.innerHTML = `<p class="cd-err">${esc(err.message)}</p>`; }
  });
  form.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-rzp]"); if (!b) return;
    b.setAttribute("aria-disabled", "true");
    try { const r = await api("POST", `/api/admin/plans/${encodeURIComponent(form.dataset.code)}/razorpay`, { currency: b.dataset.rzp, cycle: b.dataset.cycle, action: "create" }); toast(`Razorpay ${b.dataset.cycle} plan ${r.razorpayPlanId || ""} ready.`); STATE.drawn = null; route(); }
    catch (err) { $("#pfOut").innerHTML = `<span class="cd-err">${esc(err.message)}</span>`; b.removeAttribute("aria-disabled"); }
  });
}
// Limits on the plan this account already has: raise questions, brands, website pages read per check and the rest for this one
// organisation without changing its plan or what it pays. Empty = the plan's own.
function limitsCard(d) {
  const s = d.subscription, can = ["founder", "finance"].includes(STATE.me.role), L = Object.fromEntries(LIMITS);
  const show = (v, k) => (v == null ? (k === "pages" ? "default (24 live / 18 scheduled)" : "Unlimited") : num(v));
  const rows = (s.limitRows || []).map((r) => `<tr${r.custom != null ? ' class="on"' : ""}><td>${esc(L[r.key] || r.key)}</td><td class="r">${show(r.plan, r.key)}</td>
      <td class="r">${r.custom != null ? `<b>${show(r.now, r.key)}</b> <span class="cd-st violet">custom</span>` : show(r.now, r.key)}</td>
      <td class="r">${r.used == null ? '<span class="muted">—</span>' : `${num(r.used)}${r.now != null && r.used > r.now ? ' <span class="cd-st warn">over</span>' : ""}`}</td>
      ${can ? `<td><input type="number" min="0" max="1000000" step="1" data-lim="${r.key}" value="${r.custom ?? ""}" placeholder="plan" aria-label="New ${esc(L[r.key] || r.key)} limit"></td>` : ""}</tr>`).join("");
  const ends = s.overrides?.expiresAt ? String(s.overrides.expiresAt).slice(0, 10) : "";
  return card("Limits", `<form id="limForm" class="cd-form cd-pad"><div class="cd-scroll"><table class="tbl cd-lim"><thead><tr><th>Limit</th><th class="r">Plan</th><th class="r">Now</th><th class="r">Used</th>${can ? "<th>New value</th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>
    ${can ? `<p class="muted cd-sm">Type a number to raise (or lower) a limit for this account only; leave it empty for the plan's own. Lowering never deletes what they already have, it only stops new additions.</p>
      <label for="limEnds">Custom limits end (optional)</label><input id="limEnds" type="date" value="${esc(ends)}" min="${new Date(Date.now() + 864e5).toISOString().slice(0, 10)}">
      <label for="limReason">Reason</label><input id="limReason" maxlength="200" placeholder="e.g. agreed 40 questions on the call">
      <div class="cd-form-row"><button class="btn sm" type="submit">Save limits</button>${s.overrides ? '<button class="btn ghost sm" type="button" id="limReset">Back to plan limits</button>' : ""}</div><div role="status"></div>` : ""}</form>`,
    s.overrides ? '<span class="cd-st violet">custom limits</span>' : "", { eyebrow: "On the current plan", desc: `${esc(s.plan)}'s limits, and any raised for this account. Nothing here changes the price or the Razorpay subscription.` });
}
function bindLimits(slug) {
  const f = $("#limForm"); if (!f || !$("#limReason")) return;
  const send = async (values, msg) => {
    const out = $("#limForm [role=status]"); out.innerHTML = "";
    const ends = $("#limEnds").value;
    try { await api("PUT", `customers/${encodeURIComponent(slug)}/limits`, { values, reason: $("#limReason").value, expiresAt: ends ? new Date(ends + "T23:59:59+05:30").toISOString() : null }); toast(msg); openAccount(slug); }
    catch (err) { out.innerHTML = `<p class="cd-err">${esc(err.message)}</p>`; }
  };
  f.addEventListener("submit", (e) => { e.preventDefault(); const values = {}; for (const i of $$("[data-lim]", f)) values[i.dataset.lim] = i.value === "" ? null : Number(i.value); send(values, "Limits saved."); });
  $("#limReset")?.addEventListener("click", () => { const values = {}; for (const i of $$("[data-lim]", f)) values[i.dataset.lim] = null; send(values, "Back to the plan's limits."); });
}
function billingActions(d) {
  const o = d.org, can = ["founder", "finance"].includes(STATE.me.role), rzp = d.billingReady;
  const paying = o.razorpay_subscription_id && ["active", "past_due"].includes(o.billing_status);
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const opt = (x) => `<option value="${esc(x.plan)}|${esc(x.currency)}|${esc(x.cycle || "monthly")}">${esc(x.name)} · ${esc(money(x.amount, x.currency))} / ${x.cycle === "annual" ? "year" : "mo"} + tax</option>`;
  const sameCcy = d.offers.filter((x) => x.currency === o.currency && (x.cycle || "monthly") === (o.billing_cycle || "monthly")); // a plan change keeps the cycle
  const parts = [];
  if (!can) parts.push(`<p class="muted">Billing changes are for founder and finance operators.</p>`);
  // 1. Paying by Razorpay: change plan, cancel, invoices and refunds.
  if (can && paying && rzp) parts.push(`
    <details class="cd-act" open><summary>Change plan</summary><form id="chgForm" class="cd-form">
      <p class="muted">Upgrades apply now (Razorpay charges the difference); downgrades at the end of the period. Choosing the current plan withdraws a scheduled downgrade.${o.pending_plan_code ? ` Scheduled: <b>${esc(o.pending_plan_code)}</b>.` : ""}</p>
      <label for="chgPlan">New plan (${esc(o.currency)})</label><select id="chgPlan">${sameCcy.map(opt).join("")}</select>
      <label for="chgReason">Reason</label><input id="chgReason" maxlength="200" placeholder="e.g. asked for more seats">
      <button class="btn sm" type="submit">Change plan</button><div id="chgOut" role="status"></div></form></details>
    <details class="cd-act"><summary>Cancel subscription</summary><form id="canForm" class="cd-form">
      <label class="cd-ck"><input type="radio" name="canWhen" value="end" checked>At the end of the paid period${o.current_period_end ? ` (${esc(dt(o.current_period_end))})` : ""}</label>
      <label class="cd-ck"><input type="radio" name="canWhen" value="now">Now: access ends when Razorpay confirms</label>
      <label for="canConfirm">To cancel now, type <code>${esc(o.slug)}</code></label><input id="canConfirm" autocomplete="off">
      <label for="canReason">Reason</label><input id="canReason" maxlength="200">
      <button class="btn sm cd-danger" type="submit">Cancel subscription</button><div id="canOut" role="status"></div></form></details>
    <details class="cd-act" id="invBox"><summary>Invoices and refunds</summary><div id="invList" class="muted">Loading from Razorpay…</div></details>`);
  // 2. Not paying (or cancelling): send a Razorpay subscription link.
  if (can && rzp && !(paying && !o.cancel_at_period_end)) parts.push(d.offers.length ? `
    <details class="cd-act" open><summary>Send subscription link</summary><form id="subForm" class="cd-form">
      <p class="muted">Razorpay emails <b>${esc(o.owner || "the owner")}</b> a link to authorise it. Razorpay charges when they pay and the plan starts at once${o.billing_status === "trialing" ? ", ending their free trial" : ""}; it renews every period until cancelled.</p>
      <label for="subOffer">Plan</label><select id="subOffer">${d.offers.map(opt).join("")}</select>
      <label for="subReason">Reason</label><input id="subReason" maxlength="200" placeholder="e.g. agreed on call">
      <button class="btn sm" type="submit">Send subscription link</button><div id="subOut" role="status"></div></form></details>`
    : `<p class="muted">No plan has a Razorpay plan id yet. Create one on the Plans page.</p>`);
  // 2b. One month, paid once: a Razorpay Payment Link at the plan's monthly price (+ tax). No renewal.
  const once = (STATE.allPlans || []).filter((p) => p.active && p.code !== "trial" && p.code !== "legacy").flatMap((p) => Object.entries(p.prices || {}).filter(([, x]) => x?.amount > 0).map(([c, x]) => ({ plan: p.code, name: p.name, currency: c, amount: x.amount })));
  const links = d.paymentLinks || [], LST = { created: ["info", "sent"], paid: ["good", "paid"], cancelled: ["", "cancelled"], expired: ["", "expired"] };
  if (can && rzp && !paying) parts.push(`
    <details class="cd-act"${links.some((l) => l.status === "created") ? " open" : ""}><summary>One month, one-time payment</summary><form id="oneForm" class="cd-form">
      <p class="muted">Razorpay emails <b>${esc(o.owner || "the owner")}</b> a payment link for one month. When it's paid the plan is active for a month from that day${o.billing_status === "trialing" ? " (their free trial ends)" : ""}, with no renewal; paying again adds a month. The link works for 7 days.</p>
      <label for="oneOffer">Plan</label><select id="oneOffer">${once.map((x) => `<option value="${esc(x.plan)}|${esc(x.currency)}">${esc(x.name)} · ${esc(money(x.amount, x.currency))} for one month + tax</option>`).join("")}</select>
      <label for="oneReason">Reason</label><input id="oneReason" maxlength="200" placeholder="e.g. pays monthly by link, no card">
      <button class="btn sm" type="submit">Send one-month payment link</button><div id="oneOut" role="status"></div></form>
      ${links.length ? `<div class="cd-tl" style="margin-top:10px">${links.map((l) => `<div><time>${esc(dtm(l.created_at))}</time><span>${esc(l.plan_code)} · ${esc(money(l.amount, l.currency))} <span class="cd-st ${LST[l.status]?.[0] || ""}">${esc(LST[l.status]?.[1] || l.status)}</span>${l.status === "paid" && l.period_end ? ` <span class="muted">until ${esc(dt(l.period_end))}</span>` : ""}${l.status === "created" && l.short_url ? ` <a href="${esc(l.short_url)}" target="_blank" rel="noopener">link</a>` : ""}</span></div>`).join("")}</div>` : ""}</details>`);
  // 3. Assign a plan without Razorpay: an invoiced contract, a longer trial, an internal account, with optional custom limits.
  if (can && !paying) parts.push(`
    <details class="cd-act"${rzp ? "" : " open"}><summary>Assign a plan (no card)</summary><form id="asgForm" class="cd-form">
      <p class="muted">For invoiced contracts, extended trials and internal accounts. Refused while a Razorpay subscription is live.</p>
      <label for="asgPlan">Plan</label><select id="asgPlan">${(STATE.allPlans || []).map((p) => `<option value="${esc(p.code)}"${p.code === o.plan_code ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <label for="asgStatus">As</label><select id="asgStatus"><option value="active">Paid contract (access until a date)</option><option value="trialing">Free trial (until a date)</option><option value="internal">Internal, no end</option><option value="canceled">Ended</option></select>
      <label for="asgUntil">Until</label><input id="asgUntil" type="date" value="${day(30)}" min="${day(0)}">
      <details><summary class="muted">Custom limits for this organisation (optional)</summary><div class="cd-pf-grid">${LIMITS.filter(([k]) => k !== "checks").map(([k, l]) => `<label>${l}<input id="ov_${k}" type="number" min="0" step="1"></label>`).join("")}</div></details>
      <label for="asgReason">Reason</label><input id="asgReason" maxlength="200" placeholder="e.g. annual contract INV-2026-014">
      <button class="btn sm" type="submit">Assign plan</button><div id="asgOut" role="status"></div></form></details>`);
  // Extra seats: on top of the plan's seats, invoiced or billed through the Razorpay subscription.
  const sp = d.subscription;
  if (can && sp.maxExtraSeats !== 0) parts.push(`
    <details class="cd-act"${sp.extraSeats ? " open" : ""}><summary>Extra seats${sp.extraSeats ? ` · ${num(sp.extraSeats)}` : ""}</summary><form id="seatForm" class="cd-form">
      <p class="muted">Seats on top of the plan's own${sp.limits.seats != null ? ` (plan: ${num(sp.limits.seats - sp.extraSeats)})` : ""}${sp.seatPrice != null ? `, at ${money(sp.seatPrice, sp.currency)} per seat per month before tax` : ", and this plan has no seat price yet"}${sp.maxExtraSeats != null ? `, up to ${num(sp.maxExtraSeats)}` : ""}. Through Razorpay, added seats go on the next invoice for this cycle, and each renewal bills the cycle's seats in arrears.</p>
      <label for="seatN">Extra seats</label><input id="seatN" type="number" min="0" max="${sp.maxExtraSeats ?? 10000}" step="1" value="${sp.extraSeats}">
      <label for="seatHow">Billing</label><select id="seatHow"><option value="invoice"${sp.seatBilling !== "razorpay" ? " selected" : ""}>Invoice (outside Razorpay)</option>${rzp && o.razorpay_subscription_id ? `<option value="razorpay"${sp.seatBilling === "razorpay" ? " selected" : ""}>Razorpay subscription</option>` : ""}</select>
      <label for="seatReason">Reason</label><input id="seatReason" maxlength="200" placeholder="e.g. agreed 5 more seats on call">
      <button class="btn sm" type="submit">Save seats</button><div role="status"></div></form></details>`);
  parts.push(rzp ? `<div class="cd-form-row"><button class="btn ghost sm" type="button" id="syncBtn">Sync with Razorpay now</button><span class="muted" id="syncOut"></span></div>`
    : `<p class="muted">Razorpay keys aren't set on this server, so links, plan changes, cancellations and refunds are off.</p>`);
  return `<div class="cd-bill">${parts.join("")}</div>`;
}
function bindBilling(slug, after = route) {
  const S = encodeURIComponent(slug), done = (msg) => { toast(msg); after(); route(); };
  const form = (id, fn) => $(id)?.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = e.submitter, out = $(id + " [role=status]"); btn.setAttribute("aria-disabled", "true"); out.innerHTML = "";
    try { await fn(out); } catch (err) { out.innerHTML = `<p class="cd-err">${esc(err.message)}</p>`; }
    btn.removeAttribute("aria-disabled");
  });
  form("#subForm", async (out) => {
    const [plan, currency, cycle] = $("#subOffer").value.split("|");
    const r = await api("POST", `customers/${S}/subscription`, { plan, currency, cycle, reason: $("#subReason").value });
    out.innerHTML = `<p class="cd-ok">Link sent to ${esc(r.sentTo)}.</p>${r.url ? `<div class="cd-copy"><input id="subLink" readonly value="${esc(r.url)}" aria-label="Payment link"><button class="btn ghost sm" type="button" id="copyLink">Copy</button></div>` : ""}`;
    $("#copyLink")?.addEventListener("click", () => { const i = $("#subLink"); navigator.clipboard?.writeText(i.value).then(() => toast("Link copied."), () => i.select()); });
  });
  form("#oneForm", async (out) => {
    const [plan, currency] = $("#oneOffer").value.split("|");
    const r = await api("POST", `customers/${S}/one-time`, { plan, currency, reason: $("#oneReason").value });
    out.innerHTML = `<p class="cd-ok">Link for ${esc(money(r.amount, r.currency))} (with tax) sent to ${esc(r.sentTo)}. It works until ${esc(dt(r.expiresAt))}.</p>${r.url ? `<div class="cd-copy"><input id="oneLink" readonly value="${esc(r.url)}" aria-label="Payment link"><button class="btn ghost sm" type="button" id="copyOne">Copy</button></div>` : ""}`;
    $("#copyOne")?.addEventListener("click", () => { const i = $("#oneLink"); navigator.clipboard?.writeText(i.value).then(() => toast("Link copied."), () => i.select()); });
  });
  form("#chgForm", async () => {
    const r = await api("POST", `customers/${S}/change-plan`, { plan: $("#chgPlan").value.split("|")[0], reason: $("#chgReason").value });
    done(r.upgrade ? "Upgrade sent to Razorpay. The plan changes when it confirms." : r.pendingPlan ? "Downgrade scheduled for the end of the period." : "Scheduled downgrade withdrawn.");
  });
  form("#canForm", async () => {
    const now = $('input[name="canWhen"]:checked').value === "now";
    const r = await api("POST", `customers/${S}/cancel`, { now, confirm: $("#canConfirm").value.trim(), reason: $("#canReason").value });
    done(now ? "Cancellation sent. Access ends when Razorpay confirms." : `Cancels on ${dt(r.until)}.`);
  });
  form("#seatForm", async () => {
    const r = await api("POST", `customers/${S}/seats`, { extraSeats: Number($("#seatN").value), billing: $("#seatHow").value, reason: $("#seatReason").value });
    const w = r.withdrawn;
    done(r.charged ? `Saved. ${money(r.charged.amount, r.charged.currency)} added to the next Razorpay invoice.`
      : w?.error ? w.error
      : w?.withdrawn ? `Saved. ${w.withdrawn} seat${w.withdrawn > 1 ? "s" : ""} added this cycle taken off the next Razorpay invoice${w.recharged ? `, ${money(w.recharged.amount, w.recharged.currency)} re-added for the rest` : ""}.`
      : "Extra seats saved.");
  });
  form("#asgForm", async () => {
    const status = $("#asgStatus").value, until = $("#asgUntil").value, values = {};
    for (const [k] of LIMITS) { const v = $("#ov_" + k)?.value; if (v) values[k] = Number(v); }
    const end = until ? new Date(until + "T23:59:59+05:30").toISOString() : null;
    await api("PATCH", `/api/admin/orgs/${S}/billing`, { plan: $("#asgPlan").value, status, reason: $("#asgReason").value,
      ...(status === "trialing" ? { trialEndsAt: end } : ["active", "canceled"].includes(status) ? { periodEndsAt: end } : {}),
      ...(Object.keys(values).length ? { overrides: { values, expiresAt: end } } : {}) });
    done("Plan assigned.");
  });
  $("#syncBtn")?.addEventListener("click", async () => {
    $("#syncOut").textContent = "Asking Razorpay…";
    try { const r = await api("POST", `customers/${S}/sync`); $("#syncOut").textContent = r.changed ? `${r.changed} change(s) applied.` : "Already in step."; }
    catch (err) { $("#syncOut").textContent = err.message; }
  });
  const inv = $("#invBox");
  inv?.addEventListener("toggle", async () => {
    if (!inv.open || inv.dataset.loaded) return; inv.dataset.loaded = "1";
    try {
      const r = await api("GET", `customers/${S}/invoices`), list = $("#invList");
      list.classList.remove("muted");
      list.innerHTML = r.invoices.length ? table([
        { h: "Issued", v: (i) => esc(dt(i.issuedAt)) }, { h: "Amount", r: 1, v: (i) => esc(money(i.amount, i.currency)) }, { h: "Status", v: (i) => `<span class="cd-st ${i.status === "paid" ? "good" : "warn"}">${esc(i.status)}</span>` },
        { h: "Invoice", v: (i) => (i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">Open</a>` : "—") },
        { h: "", v: (i) => (i.paymentId && i.status === "paid" ? `<button class="btn ghost sm" type="button" data-refund="${esc(i.paymentId)}" data-amount="${i.amount}" data-ccy="${esc(i.currency)}">Refund…</button>` : "") },
      ], r.invoices) + `<form id="refForm" class="cd-form" hidden>
          <p>Refund payment <code id="refPay"></code></p>
          <label for="refAmt">Amount in <span id="refCcy"></span> (empty = full refund)</label><input id="refAmt" type="number" min="1" step="0.01">
          <label for="refConfirm">Type <code>${esc(slug)}</code> to confirm</label><input id="refConfirm" autocomplete="off">
          <label for="refReason">Reason</label><input id="refReason" maxlength="200">
          <button class="btn sm cd-danger" type="submit">Refund</button><div role="status"></div></form>` : "No charges yet.";
      list.addEventListener("click", (e) => { const b = e.target.closest("[data-refund]"); if (!b) return; const f = $("#refForm"); f.hidden = false; f.dataset.pay = b.dataset.refund;
        $("#refPay").textContent = b.dataset.refund; $("#refCcy").textContent = b.dataset.ccy; $("#refAmt").max = b.dataset.amount / 100; $("#refAmt").focus(); });
      form("#refForm", async (out) => {
        const a = $("#refAmt").value, r2 = await api("POST", `customers/${S}/refund`, { paymentId: $("#refForm").dataset.pay, amount: a === "" ? null : Math.round(Number(a) * 100), confirm: $("#refConfirm").value.trim(), reason: $("#refReason").value });
        out.innerHTML = `<p class="cd-ok">Refund ${esc(r2.refundId)} (${esc(r2.status || "created")}).</p>`;
      });
    } catch (err) { $("#invList").innerHTML = `<span class="cd-err">${esc(err.message)}</span>`; }
  });
}

/* ⌘K / Ctrl-K: jump to any page or organisation. */
async function palette() {
  if ($(".cd-pal")) return;
  if (!STATE.orgs.length) { try { STATE.orgs = (await api("GET", "customers")).orgs; } catch {} }
  const items = [...$$("#nav [data-page]").filter((b) => !b.hidden).map((b) => ({ label: b.textContent.trim(), sub: "Page", go: b.dataset.page })),
    ...STATE.orgs.map((o) => ({ label: o.name, sub: `${o.planName} · ${STATUS[o.billing_status]?.[0] || o.billing_status}`, go: "customers?account=" + o.slug }))];
  const m = document.createElement("div"); m.className = "modal light cd-pal";
  m.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-label="Jump to"><input id="palIn" type="search" placeholder="Jump to a page or organisation…" autocomplete="off"><div class="cd-pal-list" id="palList" role="listbox"></div></div>`;
  document.body.append(m);
  let sel = 0, shown = [];
  const paint = () => {
    const qv = $("#palIn").value.trim().toLowerCase();
    shown = items.filter((x) => !qv || x.label.toLowerCase().includes(qv)).slice(0, 12); sel = Math.min(sel, Math.max(0, shown.length - 1));
    $("#palList").innerHTML = shown.map((x, i) => `<button type="button" role="option" aria-selected="${i === sel}" data-i="${i}"><b>${esc(x.label)}</b><span>${esc(x.sub)}</span></button>`).join("") || '<div class="cd-empty">No match.</div>';
  };
  const close = () => { m.remove(); document.removeEventListener("keydown", key, true); };
  const go = (x) => { if (x) { close(); location.hash = x.go; } };
  const key = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); go(shown[sel]); }
  };
  document.addEventListener("keydown", key, true);
  m.addEventListener("click", (e) => { if (e.target === m) close(); const b = e.target.closest("[data-i]"); if (b) go(shown[+b.dataset.i]); });
  $("#palIn").addEventListener("input", () => { sel = 0; paint(); });
  paint(); $("#palIn").focus();
}


/* ── Live stream ── */
let LIVE = null;
function stopLive() { LIVE?.es.close(); clearInterval(LIVE?.clock); LIVE = null; }
function startLive() {
  stopLive();
  const es = new EventSource("/api/admin/console/live"), seen = new Set();
  LIVE = { es, last: null, clock: setInterval(() => {
    if (!$("#liveAge")) return stopLive();
    $("#liveAge").textContent = LIVE.last ? `Updated ${Math.max(0, Math.round((Date.now() - LIVE.last) / 1000))} s ago` : "Connecting…";
    $$("[data-elapsed]").forEach((el) => { el.dataset.elapsed = Number(el.dataset.elapsed) + 1; el.textContent = dur(Number(el.dataset.elapsed)); });
  }, 1000) };
  es.addEventListener("snapshot", (e) => { LIVE.last = Date.now(); paintLive(JSON.parse(e.data), seen); });
  // `ended`: access was withdrawn. Stop for good (no reconnecting, no age clock over the message).
  es.addEventListener("problem", (e) => { const p = JSON.parse(e.data); if (p.ended) stopLive(); if ($("#liveAge")) $("#liveAge").textContent = p.error; });
  es.onerror = () => { if ($("#liveAge")) $("#liveAge").textContent = "Reconnecting…"; };
}
const dur = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const DEVICE = { desktop: "Desktop", mobile: "Phone", tablet: "Tablet" };
const FEED = { ai: ["AI", "info"], check: ["Check", ""], done: ["Done", "good"], failed: ["Failed", "bad"], action: ["Action", "warn"], view: ["View", ""] };
function paintLive(d, seen) {
  if (!$("#liveKpis")) return;
  const lastMin = d.perMinute.at(-1) || {}, ev = (lastMin.ai || 0) + (lastMin.views || 0) + (lastMin.checks || 0);
  $("#liveKpis").innerHTML = [kpi("People online", `<span class="cd-dot"></span>${num(d.online.length)}`, "seen in the last 2 minutes"), kpi("Active today", num(d.today), "people"), kpi("Organisations online", num(d.onlineOrgs)), kpi("Checks running", num(d.running.length)),
    kpi("Events, last minute", num(ev)), kpi("AI spend, last hour", usd(d.spend.hour), `${usd(d.spend.day)} in 24 h`)].join("");
  // stacked minute bars
  const w = 1000, h = 150, pad = { l: 30, r: 6, t: 8, b: 20 }, tot = (m) => (m.views || 0) + (m.ai || 0) + (m.checks || 0), max = Math.max(1, ...d.perMinute.map(tot));
  const gw = (w - pad.l - pad.r) / d.perMinute.length, y = (v) => (h - pad.t - pad.b) * (v / max);
  $("#liveMinutes").innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Events per minute, last hour"><g class="grid"><line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b}" y2="${h - pad.b}"/></g>
    <g class="ax"><text x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end">${max}</text><text x="${pad.l}" y="${h - 4}">60 min ago</text><text x="${w - pad.r}" y="${h - 4}" text-anchor="end">now</text></g>
    ${d.perMinute.map((m, i) => { let base = h - pad.b; const x0 = pad.l + gw * i + 1, tip = `${new Date(m.minute).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · ${m.views} views · ${m.ai} AI calls · ${m.checks} checks`;
      return [["views", "c2"], ["ai", "c1"], ["checks", "c3"]].map(([k, c]) => { const hh = y(m[k] || 0); base -= hh; return hh ? `<rect class="mb ${c}${i === d.perMinute.length - 1 ? " now" : ""}" x="${x0}" y="${base}" width="${Math.max(1, gw - 2)}" height="${hh}" data-tip="${esc(tip)}"/>` : ""; }).join("")
        + `<rect class="hitm" x="${x0}" y="${pad.t}" width="${Math.max(1, gw - 2)}" height="${h - pad.t - pad.b}" data-tip="${esc(tip)}"/>`; }).join("")}</svg>`;
  $("#onlineCount").textContent = `· ${d.online.length}`;
  $("#liveOnline").innerHTML = d.online.length ? table([
    { h: "Person", v: (x) => `<b>${esc(x.name || x.email)}</b><div class="muted cd-sm">${esc(x.org || "no organisation")} · ${esc(x.plan || "")}</div>` },
    { h: "Looking at", v: (x) => `<span class="cd-st info">${esc(x.page)}</span>${x.brand ? ` <span class="muted cd-sm">${esc(x.brand)}</span>` : ""}` },
    { h: "Device", v: (x) => esc(DEVICE[x.device] || x.device) },
    { h: "On this page", r: 1, v: (x) => `<span data-elapsed="${x.on_page_s}">${dur(x.on_page_s)}</span>` },
  ], d.online, { click: (x) => (x.slug ? A(x.slug) : "") }) : `<div class="cd-empty"><b>Nobody online</b>People appear here within a minute of opening White Petal.</div>`;
  const group = (t, rows) => `<div class="cd-where"><span class="kl">${t}</span>${rows.length ? bars(rows.slice(0, 6), (x) => x.key, (x) => x.n, (x) => num(x.n), "p") : '<div class="cd-empty">—</div>'}</div>`;
  $("#liveWhere").innerHTML = group("By page", d.onlineByPage) + group("By plan", d.onlineByPlan) + group("By device", d.onlineByDevice.map((x) => ({ ...x, key: DEVICE[x.key] || x.key })));
  $("#liveRuns").innerHTML = d.running.length ? `<div class="cd-tl">${d.running.map((r) => `<div><time><span class="cd-dot"></span><span data-elapsed="${r.elapsed_s}">${dur(r.elapsed_s)}</span></time><span><b>${esc(r.brand)}</b> <span class="muted">${esc(r.org)} · ${esc(r.source)}</span></span></div>`).join("")}</div>` : '<div class="cd-empty">No checks running.</div>';
  $("#liveFeed").innerHTML = d.feed.length ? d.feed.map((f) => { const k = f.at + f.type + f.what + (f.who || ""), fresh = seen.size && !seen.has(k); seen.add(k); const [l, t] = FEED[f.type] || [f.type, ""];
    return `<div class="cd-fe${fresh ? " fresh" : ""}"><time>${esc(new Date(f.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</time><span class="cd-st ${t}">${l}</span><span class="cd-fw">${esc(f.what)}${f.usd ? ` <span class="muted">${usd(f.usd, 3)}</span>` : ""}</span><span class="muted cd-sm">${esc(f.org || "")}${f.who ? " · " + esc(f.who) : ""}</span></div>`; }).join("")
    : '<div class="cd-empty">Nothing in the last 30 minutes.</div>';
}
/* ── router ── */
const STATE = { me: null, orgs: [], page: "pulse" };
const allowed = (btn) => !btn || !btn.dataset.role || btn.dataset.role.split(" ").includes(STATE.me?.role);
const ALIAS = { today: "pulse", insights: "growth", activity: "growth", platform: "ai", audit: "operations" };
let ROUTING = Promise.resolve();
// A direct call (after a save) always redraws; an address change may skip the redraw when only the account drawer opened or closed.
function route(opts = {}) { const run = () => routeNow(!!opts.fromHash); ROUTING = ROUTING.then(run, run); return ROUTING; }
async function routeNow(fromHash = false) {
  const [path, query = ""] = location.hash.slice(1).split("?"), qs = new URLSearchParams(query), acct = qs.get("account"), healthQ = qs.get("health");
  let [page, ...rest] = (path || "pulse").split("/"); page = ALIAS[page] || page;
  if (page === "customers" && rest.length && !acct) { location.replace(`#customers?account=${rest[0]}`); return; } // old links
  const key = PAGES[page] && allowed($(`#nav [data-page="${page}"]`)) ? page : "pulse", P = PAGES[key], sub = rest.map(decodeURIComponent).join("/");
  const modal = key === "plans" && sub ? sub : null, arg = modal ? "" : sub;
  const same = fromHash && STATE.drawn === key + "/" + arg + "|" + scopeQs() + "|" + (STATE.health || "");
  STATE.page = key;
  if (key === "customers" && healthQ != null) STATE.health = healthQ;
  $$("#nav [data-page]").forEach((b) => b.classList.toggle("on", b.dataset.page === key));
  $("#side").classList.remove("open");
  document.title = `${P.title} · Command Deck · White Petal`;
  if (key !== "live") stopLive();
  if (!same) {
    const box = $("#pages"); box.setAttribute("aria-busy", "true");
    try {
      const html = await P.draw(arg);
      box.innerHTML = `<div class="pg">${html}</div>`; paintIcons(box);
      if (!arg || key === "operations" || key === "growth") P.after?.();
      STATE.drawn = key + "/" + arg + "|" + scopeQs() + "|" + (STATE.health || "");
    } catch (e) {
      box.innerHTML = `<div class="pg"><div class="card"><div class="cd-err">${esc(e.status === 403 ? "Your operator role can't open this page." : e.message)}</div></div></div>`; STATE.drawn = null;
    }
    box.removeAttribute("aria-busy"); $("#main").scrollTop = 0;
  }
  if (key === "customers" && healthQ != null) $("#brand-health")?.scrollIntoView({ block: "start" });
  if (modal) openPlanModal(modal); else closePlanModal(false);
  if (acct) openAccount(acct); else $("#sheet").hidden = true;
}
function bindNotes(slug) {
  const f = $("#noteForm"); if (!f) return;
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const body = $("#noteIn").value.trim(); if (!body) return;
    try { const { note } = await api("POST", `customers/${encodeURIComponent(slug)}/notes`, { body }); $("#noteIn").value = "";
      const list = $("#notes"); $(".cd-empty", list)?.remove();
      list.insertAdjacentHTML("afterbegin", `<div><time>${esc(dtm(note.at))}</time><span>${esc(note.body)} <span class="muted">· ${esc(note.by)}</span></span></div>`); toast("Note added.");
    } catch (err) { toast(err.message); }
  });
}

document.addEventListener("click", async (e) => {
  const go = e.target.closest("[data-go]");
  if (go && go.dataset.go) { e.preventDefault(); location.hash = go.dataset.go; return; }
  const item = e.target.closest(".cd-item");
  if (item && e.target.closest("[data-snooze],[data-done]")) {
    const snooze = e.target.closest("[data-snooze]");
    try { await api("POST", "attention", { key: item.dataset.key, ...(snooze ? { days: Number(snooze.dataset.snooze) } : {}) }); item.remove(); toast(snooze ? "Snoozed for a day." : "Marked done."); }
    catch (err) { toast(err.message); }
  }
});
document.addEventListener("keydown", (e) => { const tr = e.target.closest?.("tr[data-go], .kpi[data-go]"); if (tr && e.target === tr && (e.key === "Enter" || (e.key === " " && tr.matches(".kpi")))) { e.preventDefault(); location.hash = tr.dataset.go; } });
// The (i) on a card: a small pop-up with what the number means, on click, tap or keyboard. Closes on a click elsewhere, Esc or scroll.
(() => {
  const pop = document.createElement("div"); pop.className = "cd-info"; pop.hidden = true; pop.setAttribute("role", "tooltip"); pop.id = "cdInfo"; document.body.append(pop);
  let at = null;
  const close = () => { if (!at) return; at.setAttribute("aria-expanded", "false"); at.removeAttribute("aria-describedby"); at = null; pop.hidden = true; };
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-info]");
    if (!b) { if (!pop.contains(e.target)) close(); return; }
    e.preventDefault(); e.stopPropagation(); // a card's own link doesn't fire when its (i) is clicked
    if (at === b) return close();
    close(); at = b; pop.textContent = b.dataset.info; pop.hidden = false; b.setAttribute("aria-expanded", "true"); b.setAttribute("aria-describedby", "cdInfo");
    const r = b.getBoundingClientRect(), w = Math.min(300, innerWidth - 24); pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + "px";
    const below = r.bottom + 8 + pop.offsetHeight < innerHeight; pop.style.top = (below ? r.bottom + 8 : r.top - pop.offsetHeight - 8) + "px";
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && at) { const b = at; close(); b.focus(); e.stopPropagation(); } }, true);
  addEventListener("scroll", close, true); addEventListener("resize", close);
})();
$("#nav").addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (b) location.hash = b.dataset.page; });
// One tooltip bubble for every [data-tip] (chart marks, heat cells), placed above the pointer.
(() => {
  const tip = document.createElement("div"); tip.className = "cd-tip"; tip.hidden = true; tip.setAttribute("role", "tooltip"); document.body.append(tip);
  document.addEventListener("mousemove", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip; tip.hidden = false;
    tip.style.left = Math.min(innerWidth - 170, Math.max(170, e.clientX)) + "px"; tip.style.top = Math.max(40, e.clientY) + "px";
  });
  addEventListener("scroll", () => { tip.hidden = true; }, true);
})();
$("#sideToggle").addEventListener("click", () => $("#side").classList.toggle("open"));
$("#collapse").addEventListener("click", () => { $("#fc").classList.toggle("collapsed"); try { localStorage.setItem("cd.collapsed", $("#fc").classList.contains("collapsed") ? "1" : ""); } catch {} });
$("#jump").addEventListener("click", palette); $("#jump2").addEventListener("click", palette);
$("#fAccounts").addEventListener("change", (e) => setScope({ accounts: e.target.value }));
$("#fDays").addEventListener("change", (e) => setScope({ days: Number(e.target.value) }));
$("#fDemo").addEventListener("change", (e) => setScope({ demo: e.target.checked }));
$("#sheet").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeAccount(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden && $("#modal").hidden && !$(".cd-pal") && !document.querySelector(".wpsp")) closeAccount(); }); // Esc closes the top layer only
$("#modal").addEventListener("click", (e) => { if (e.target.closest("[data-mclose]")) closePlanModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden && !$(".cd-pal") && !document.querySelector(".wpsp")) { e.preventDefault(); closePlanModal(); } });
document.addEventListener("click", (e) => { const b = e.target.closest("[data-tbl]"); if (b) { const t = b.nextElementSibling; t.hidden = !t.hidden; b.textContent = t.hidden ? "Show as a table" : "Hide the table"; } });
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette(); } });
addEventListener("hashchange", () => route({ fromHash: true }));

(async () => {
  paintIcons();
  try { if (localStorage.getItem("cd.collapsed")) $("#fc").classList.add("collapsed"); } catch {}
  try { await refreshMe(); }
  catch (e) {
    $("#pages").innerHTML = `<div class="pg"><div class="card"><div class="cd-empty"><b>${e.status === 404 ? "This page is for the White Petal team" : "Couldn't open the console"}</b>${e.status === 404 ? "Sign in with an operator account to use the Command Deck." : esc(e.message)}<div style="margin-top:14px"><a class="btn sm" href="/">Back to White Petal</a></div></div></div></div>`;
    return;
  }
  $("#meEmail").textContent = STATE.me.email; $("#meRole").textContent = STATE.me.role[0].toUpperCase() + STATE.me.role.slice(1);
  $("#envName").textContent = STATE.me.env;
  $$("#nav [data-page]").forEach((b) => { b.hidden = !allowed(b); });
  route();
})();
})();
