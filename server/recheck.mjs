// Re-check ONE fix without re-running the whole analysis. Only checks that need no AI: they read a file or a page, so they are
// free, instant and can run as often as people press the button (and on every scheduled check). Whether an AI engine now
// names the brand is not checked here: that needs the engines, and the next full check measures it.
//
// A fix is known by its deck id, which is also its recovery_actions source_key:
//   robots          robots.txt lets the AI crawlers in
//   llms            /llms.txt or /llms-full.txt is published
//   org             the market's homepage has Organization JSON-LD
//   fix:<url>       that page of the brand's own site scores 60 or more for AI-readiness
//   pitch:<url>     that third-party page now names the brand
import { fetchPage as realFetch, parsePage, robotsAccess, AI_BOTS, aliases, hasAny, stripHtml, norm, hostOf } from "../api/_lib.js";
import { isText, pageRow, ORG_TYPES } from "../api/_audit.js";

let fetchPage = realFetch;
export function setFetch(fn) { fetchPage = fn || realFetch; } // tests

export const PAGE_PASS = 60; // the score under which the deck suggests improving a page
export function checkType(sourceKey) {
  const k = String(sourceKey || "");
  if (k === "robots" || k === "llms" || k === "org") return k;
  if (k.startsWith("fix:")) return "page";
  if (k.startsWith("pitch:")) return "listing";
  return null;
}
const urlOf = (sourceKey) => String(sourceKey).replace(/^(fix|pitch):/, "");

// Only public web addresses: a recheck must not be a way to make the server open its own network.
export function publicUrl(v) {
  let u; try { u = new URL(String(v)); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") || /^(localhost|metadata\.google\.internal)$/.test(h) || h.endsWith(".internal") || h.endsWith(".local")) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^(::1?|f[cd][0-9a-f]{2}:|fe80:)/.test(h)) return null;
  return u.href;
}
const sameSite = (u, site) => { const a = hostOf(u), b = hostOf(site); return !!a && (a === b || a.endsWith("." + b)); };

/**
 * Run one check. ctx: { site (the brand's site for this market, e.g. https://meshopcheap.com/in), brand (profile: name,
 * site, competitors), evidence (what the deck card saw: { blocked: [...] } for robots, { score } for a page) }.
 * Returns { type, pass, at, detail, observed }. Never throws for a site that is down: that is a failed check, said plainly.
 */
export async function recheck(sourceKey, { site, brand = {}, evidence = {} } = {}) {
  const type = checkType(sourceKey), at = new Date().toISOString();
  const out = (pass, detail, observed = {}) => ({ type, pass, at, detail, observed });
  if (!type) return out(false, "This fix can't be re-checked on its own. The next full check measures it.");
  const home = publicUrl(site);
  if (!home) return out(false, "The brand's website address isn't a public web address.");
  const origin = new URL(home).origin;

  if (type === "robots") {
    const r = await fetchPage(origin + "/robots.txt");
    const bots = robotsAccess(r.ok ? r.body : "");
    const want = (Array.isArray(evidence.blocked) && evidence.blocked.length ? evidence.blocked : AI_BOTS).filter((b) => AI_BOTS.includes(b));
    const still = want.filter((b) => !bots[b]);
    if (!r.ok && r.status !== 404) return out(false, `Couldn't read ${origin}/robots.txt (${r.error || "HTTP " + r.status}).`, { bots });
    return out(!still.length, still.length ? `Still blocked in robots.txt: ${still.join(", ")}.` : `${want.join(", ")} can read your site now.`, { bots, stillBlocked: still });
  }
  if (type === "llms") {
    const [a, b] = await Promise.all([fetchPage(origin + "/llms.txt"), fetchPage(origin + "/llms-full.txt")]);
    const found = [isText(a) && "llms.txt", isText(b) && "llms-full.txt"].filter(Boolean);
    return out(found.length > 0, found.length ? `Found ${found.join(" and ")} at ${origin}.` : `No llms.txt at ${origin}/llms.txt yet (or it returns a web page instead of plain text).`, { found });
  }
  if (type === "org") {
    const r = await fetchPage(home);
    if (!r.ok) return out(false, `Couldn't open ${home} (${r.error || "HTTP " + r.status}).`);
    const p = parsePage(r.url, r.body), ok = p.schema.some((t) => ORG_TYPES.test(t));
    return out(ok, ok ? `Organization schema found${p.org?.name ? ` for “${p.org.name}”` : ""}.` : `No Organization schema on ${r.url} yet.${p.schema.length ? ` It has: ${p.schema.slice(0, 4).join(", ")}.` : ""}`, { schema: p.schema, org: p.org });
  }
  const url = publicUrl(urlOf(sourceKey));
  if (!url) return out(false, "That page isn't a public web address.");
  if (type === "page") {
    if (!sameSite(url, home)) return out(false, "That page isn't on this brand's website.");
    const r = await fetchPage(url, { timeout: 10000 });
    if (!r.ok || !/<html|<body/i.test(r.body.slice(0, 4000))) return out(false, `Couldn't open ${url} (${r.error || "HTTP " + r.status}).`);
    const row = pageRow(r.url, parsePage(r.url, r.body)), was = Number.isFinite(evidence.score) ? evidence.score : null;
    const ok = row.score >= PAGE_PASS;
    return out(ok, `Scores ${row.score}/100${was != null ? ` (was ${was})` : ""}.${ok ? "" : ` Still missing: ${row.fails.slice(0, 3).join(", ")}.`}`, { score: row.score, was, fails: row.fails });
  }
  // listing: is the brand on that page now?
  const r = await fetchPage(url, { timeout: 10000 });
  if (!r.ok) return out(false, `Couldn't open ${url} (${r.error || "HTTP " + r.status}).`);
  const text = stripHtml(r.body), al = aliases(brand);
  const you = al.length > 0 && (hasAny(text, al) || al.some((a) => norm(r.url).includes(a)));
  const rivals = (brand.competitors || []).filter((c) => hasAny(text, [norm(c)]));
  return out(you, you ? `${brand.name || "You"} is named on this page now.` : `${brand.name || "You"} isn't named on this page yet.${rivals.length ? ` Rivals on it: ${rivals.slice(0, 3).join(", ")}.` : ""}`, { you, rivals });
}
