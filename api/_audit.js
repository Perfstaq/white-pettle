// Read a website the way an AI crawler does: robots.txt, llms.txt, the sitemap and up to 9 scored pages. No AI calls, so a
// scheduled check can re-read the site every time and a fix can be re-checked for free. api/site.js streams it during setup.
import { fetchPage, parsePage, scorePage, robotsAccess, hostOf, AI_BOTS } from "./_lib.js";
import { localePath, localeSignals, detectCountry, siblingMarkets } from "./_markets.js";

const noop = () => {};
export const isText = (r) => r.ok && !/<html/i.test(r.body.slice(0, 500));
export const ORG_TYPES = /Organization|Corporation|ProfessionalService|LocalBusiness/;

// A page row as the report shows it.
export function pageRow(url, p) {
  const s = scorePage(p, null);
  return { url, title: p.title, score: s.score, fails: s.checks.filter((c) => !c.pass).map((c) => c.label), checks: s.checks, words: p.words, schema: p.schema, jsOnly: p.jsOnly, author: p.author };
}

// url: what the person typed (a /in or /en-gb path keeps the crawl inside that country's pages).
// send(event, data): the same step/done/page events api/site.js streams. Returns { home, hp, parsed, audit }.
export async function auditSite(url, send = noop, { pagesMax = 8 } = {}) {
  let base = String(url || "").trim(); if (!base) throw new Error("Paste a website address.");
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  const host = hostOf(base);
  send("step", { id: "home", text: `Opening ${host} the way an AI crawler would`, why: "If AI crawlers can't read your site, ChatGPT and Perplexity can't cite it." });
  const home = await fetchPage(base);
  if (!home.ok) throw new Error(`Couldn't open ${base} (${home.error || "HTTP " + home.status}). Check the address.`);
  const final = new URL(home.url), origin = final.origin;
  // Country versions of one site (/in, /us, /uk): keep to the one we landed on. A bare domain that redirects to /in (geo by
  // IP) is pinned to /in too, so a later check from a server in another country reads the same pages, not /us.
  const typed = (() => { try { return new URL(base).pathname; } catch { return "/"; } })();
  const scope = localePath(final.pathname);
  const redirectedTo = scope && localePath(typed).toLowerCase() !== scope.toLowerCase() ? scope : "";
  const hp = parsePage(home.url, home.body);
  const signals = localeSignals(home.body, home.url);
  send("done", { id: "home", text: `Read “${hp.title || host}”: ${hp.words.toLocaleString()} words, ${hp.headings.length} headings${hp.schema.length ? `, schema: ${hp.schema.slice(0, 4).join(", ")}` : ", no schema"}` });

  send("step", { id: "robots", text: "Checking robots.txt for AI crawler access", why: "Many sites block GPTBot or PerplexityBot by accident, which makes them invisible to those assistants." });
  const [robots, llms, llmsFull] = await Promise.all([fetchPage(origin + "/robots.txt"), fetchPage(origin + "/llms.txt"), fetchPage(origin + "/llms-full.txt")]);
  const bots = robotsAccess(robots.ok ? robots.body : "");
  const blocked = AI_BOTS.filter((b) => !bots[b]);
  send("done", { id: "robots", ok: !blocked.length, text: blocked.length ? `Blocked: ${blocked.join(", ")}` : "All 9 major AI crawlers are allowed", data: { bots } });

  const hasLlms = isText(llms) || isText(llmsFull);
  send("step", { id: "llms", text: "Looking for llms.txt", why: "llms.txt is a plain-language briefing AI tools read to understand a company." });
  send("done", { id: "llms", ok: hasLlms, text: hasLlms ? `Found ${isText(llms) ? "llms.txt" : ""}${isText(llms) && isText(llmsFull) ? " and " : ""}${isText(llmsFull) ? "llms-full.txt" : ""}` : "No llms.txt. I'll write one for you." });

  send("step", { id: "sitemap", text: `Reading the sitemap to find your key pages${scope ? ` under ${scope}` : ""}`, why: "I'll score the pages buyers and AI are most likely to land on." });
  const maps = [...(robots.body || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!maps.length) maps.push(origin + "/sitemap.xml");
  const locs = [];
  for (const sm of maps.slice(0, 2)) {
    const x = await fetchPage(sm, { timeout: 8000 });
    if (!x.ok) continue;
    const sub = [...x.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    if (/<sitemapindex/i.test(x.body)) {
      // With a country scope, child sitemaps named for it come first (sitemap-in.xml, /in/sitemap.xml).
      const kids = scope ? [...sub.filter((u) => u.toLowerCase().includes(scope.slice(1).toLowerCase())), ...sub.filter((u) => !u.toLowerCase().includes(scope.slice(1).toLowerCase()))] : sub;
      const got = await Promise.all(kids.slice(0, 3).map((u) => fetchPage(u, { timeout: 8000 })));
      got.forEach((k) => k.ok && locs.push(...[...k.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])));
    } else locs.push(...sub);
  }
  const inScope = (u) => { if (!scope) return true; try { const p = new URL(u).pathname.toLowerCase(), s = scope.toLowerCase(); return p === s || p.startsWith(s + "/"); } catch { return false; } };
  const scoped = locs.filter(inScope);
  send("done", { id: "sitemap", ok: scoped.length > 0, text: scoped.length ? `${scoped.length} URLs in the sitemap${scope ? ` under ${scope}` : ""}` : "No sitemap found. Using links from the homepage." });

  const links = [...home.body.matchAll(/href=["']([^"'#]+)/gi)].map((m) => { try { return new URL(m[1], home.url).href; } catch { return ""; } });
  const same = (u) => { try { return new URL(u).host === final.host && inScope(u) && !/\.(pdf|jpg|png|gif|svg|zip|xml|css|js)$/i.test(u) && !/privacy|terms|cookie|legal|login|signin|cart|\/tag\/|\/author\/|wp-json|feed/i.test(u); } catch { return false; } };
  const important = /about|service|solution|product|pricing|platform|case|customer|blog|guide|compare|vs|alternative|deal|categor/i;
  const pool = [...new Set([...scoped, ...links].filter(same).map((u) => u.split("#")[0].replace(/\/$/, "")))].filter((u) => u !== home.url.replace(/\/$/, ""));
  pool.sort((a, b) => (important.test(b) ? 1 : 0) - (important.test(a) ? 1 : 0) || a.split("/").length - b.split("/").length);
  const picks = pool.slice(0, pagesMax);

  send("step", { id: "pages", text: `Scoring ${picks.length + 1} pages for AI-readiness`, why: "AI quotes pages that answer fast, show numbers and sources, and use question headings." });
  const pages = [pageRow(home.url, hp)];
  send("page", pages[0]);
  const parsed = [hp];
  await Promise.all(picks.map(async (u) => {
    const r = await fetchPage(u, { timeout: 9000 });
    if (!r.ok || !/<html|<body/i.test(r.body.slice(0, 4000))) return;
    const p = parsePage(r.url, r.body); parsed.push(p);
    const row = pageRow(r.url, p); pages.push(row); send("page", row);
  }));
  const avg = Math.round(pages.reduce((s, p) => s + p.score, 0) / pages.length);
  send("done", { id: "pages", ok: avg >= 60, text: `Average AI-readiness ${avg}/100 across ${pages.length} pages` });

  const country = detectCountry({ path: scope, ...signals });
  // Sites with country paths often link only to their own country (meshopcheap.com/in links only /in pages). Look for the
  // common siblings directly; one that opens at its own path is another market of this site.
  let markets = siblingMarkets(signals, links, origin, scope);
  if (scope && !markets.length) {
    const tryP = ["/us", "/uk", "/in", "/ae", "/au", "/ca", "/sg", "/de"].filter((p) => p.toLowerCase() !== scope.toLowerCase());
    const got = await Promise.all(tryP.map(async (p) => { const r = await fetchPage(origin + p, { timeout: 5000, cap: 20000 }); try { return r.ok && localePath(new URL(r.url).pathname).toLowerCase() === p ? origin + p : null; } catch { return null; } }));
    markets = siblingMarkets({ alternates: [] }, got.filter(Boolean), origin, scope);
  }
  const homeSchema = hp.schema;
  const audit = { origin, scope, site: origin + scope, bots, llms: hasLlms, sitemap: scoped.length, pages: pages.sort((a, b) => a.score - b.score), avg, homeSchema,
    orgSchema: homeSchema.some((t) => ORG_TYPES.test(t)), faqSchema: pages.some((p) => p.schema.includes("FAQPage")),
    articleSchema: pages.some((p) => p.schema.some((t) => /Article|BlogPosting|NewsArticle/.test(t))), org: hp.org, jsOnly: pages.filter((p) => p.jsOnly).length, authors: pages.filter((p) => p.author).length,
    locale: { lang: signals.lang, ogLocale: signals.ogLocale, currency: signals.currency, hreflang: signals.alternates.length, redirectedTo, country: country ? { code: country.code, name: country.name, via: country.via } : null },
    markets, checkedAt: Date.now() };
  return { home, hp, parsed, audit };
}
