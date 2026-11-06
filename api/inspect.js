// Open a page an AI engine cited and report who is on it, with evidence and contacts.
import { guard, body, json, fetchPage, stripHtml, aliases, hasAny, norm, contactsFrom, snippetAround, hostOf } from "./_lib.js";
import "../public/page-features.js"; // sets globalThis.WP_PAGE: the same page rules the browser uses
export const config = { runtime: "edge" };

export default async function handler(req) {
  const denied = guard(req); if (denied) return denied;
  const { url, brand = {}, names = [] } = await body(req);
  const r = await fetchPage(String(url || ""), { timeout: 10000 });
  if (!r.ok) return json({ ok: false, url, final: r.url, reason: r.error || `HTTP ${r.status}` });
  const text = stripHtml(r.body);
  const title = stripHtml((r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 200);
  const al = aliases(brand);
  const you = hasAny(text, al) || al.some((a) => norm(r.url).includes(a));
  const rivals = (brand.competitors || []).filter((c) => hasAny(text, [norm(c)]));
  const evidence = rivals.slice(0, 3).map((c) => ({ name: c, snippet: snippetAround(text, c, 90) }));
  const youSnippet = you ? snippetAround(text, brand.name || "", 90) : "";
  const listy = /best|top \d|alternatives?|vs\.?|compare|review|leading|list/i.test(title + " " + r.url);
  return json({ ok: true, url, final: r.url, domain: hostOf(r.url), title, words: text.split(" ").length, you, youSnippet, rivals, evidence, listy,
    contacts: contactsFrom(r.url, r.body), excerpt: text.slice(0, 1400),
    // What is on the page (best-for line, prices, comparison, FAQs, steps, dates, schema) and which brands it names, for the
    // rival playbooks. names: every brand seen in the answers, so a rival nobody tracks is still recognised.
    features: globalThis.WP_PAGE.pageFeatures(r.body, { brands: [...new Set([brand.name, ...(brand.competitors || []), ...(Array.isArray(names) ? names : [])].map((n) => String(n || "").trim().slice(0, 80)).filter(Boolean))].slice(0, 80) }) });
}
