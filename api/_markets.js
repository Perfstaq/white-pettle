// Countries White Petal can check AI answers for, and how to recognise them on a website.
// One table for the crawler (a /in path, lang="en-IN", ₹ prices), the engines (ChatGPT and Perplexity take an ISO country,
// Gemini and Groq are told where the buyer is) and Google (DataForSEO location names, SerpApi gl codes).
export const COUNTRIES = [
  ["US", "United States", "USD", "en", ["usa", "us", "america", "united states of america"]],
  ["GB", "United Kingdom", "GBP", "en", ["uk", "britain", "great britain", "england"]],
  ["IN", "India", "INR", "en", []],
  ["CA", "Canada", "CAD", "en", []],
  ["AU", "Australia", "AUD", "en", []],
  ["NZ", "New Zealand", "NZD", "en", []],
  ["IE", "Ireland", "EUR", "en", []],
  ["SG", "Singapore", "SGD", "en", []],
  ["AE", "United Arab Emirates", "AED", "en", ["uae", "dubai", "abu dhabi"]],
  ["SA", "Saudi Arabia", "SAR", "ar", ["ksa"]],
  ["ZA", "South Africa", "ZAR", "en", []],
  ["NG", "Nigeria", "NGN", "en", []],
  ["KE", "Kenya", "KES", "en", []],
  ["PK", "Pakistan", "PKR", "en", []],
  ["BD", "Bangladesh", "BDT", "en", []],
  ["LK", "Sri Lanka", "LKR", "en", []],
  ["MY", "Malaysia", "MYR", "en", []],
  ["PH", "Philippines", "PHP", "en", []],
  ["ID", "Indonesia", "IDR", "id", []],
  ["TH", "Thailand", "THB", "th", []],
  ["VN", "Vietnam", "VND", "vi", []],
  ["JP", "Japan", "JPY", "ja", []],
  ["KR", "South Korea", "KRW", "ko", ["korea"]],
  ["HK", "Hong Kong", "HKD", "en", []],
  ["DE", "Germany", "EUR", "de", []],
  ["FR", "France", "EUR", "fr", []],
  ["ES", "Spain", "EUR", "es", []],
  ["IT", "Italy", "EUR", "it", []],
  ["NL", "Netherlands", "EUR", "nl", ["holland"]],
  ["BE", "Belgium", "EUR", "nl", []],
  ["CH", "Switzerland", "CHF", "de", []],
  ["AT", "Austria", "EUR", "de", []],
  ["SE", "Sweden", "SEK", "sv", []],
  ["NO", "Norway", "NOK", "no", []],
  ["DK", "Denmark", "DKK", "da", []],
  ["FI", "Finland", "EUR", "fi", []],
  ["PL", "Poland", "PLN", "pl", []],
  ["PT", "Portugal", "EUR", "pt", []],
  ["BR", "Brazil", "BRL", "pt", []],
  ["MX", "Mexico", "MXN", "es", []],
  ["AR", "Argentina", "ARS", "es", []],
  ["TR", "Turkey", "TRY", "tr", ["turkiye"]],
  ["IL", "Israel", "ILS", "he", []],
  ["EG", "Egypt", "EGP", "ar", []],
].map(([code, name, currency, lang, aliases]) => ({ code, name, currency, lang, aliases }));
const BY_CODE = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));
// Locale path segments use "uk" for Great Britain more often than the ISO "gb".
const PATH_ALIAS = { uk: "GB" };
const SYMBOL = { "₹": "INR", "£": "GBP", "€": "EUR", "¥": "JPY", "₩": "KRW", "₦": "NGN", "₱": "PHP", "฿": "THB", "₺": "TRY", "₪": "ILS" };

export const countryByCode = (code) => BY_CODE[String(code || "").toUpperCase()] || null;
// "India", "in", "IN", "en-IN", "Dubai" → the country, or null for "Global", "Europe" and anything unknown.
export function countryOf(text) {
  const s = String(text || "").trim(); if (!s) return null;
  const tag = s.match(/^[a-z]{2,3}[-_]([a-z]{2})$/i); if (tag) return countryByCode(tag[1]);
  if (/^[a-z]{2}$/i.test(s)) return countryByCode(PATH_ALIAS[s.toLowerCase()] || s);
  const t = " " + s.toLowerCase().replace(/[^a-z ]+/g, " ") + " ";
  for (const c of COUNTRIES) if (t.includes(" " + c.name.toLowerCase() + " ")) return c;
  for (const c of COUNTRIES) if (c.aliases.some((a) => t.includes(" " + a + " "))) return c;
  return null;
}
// The first path segment when it names a country or a locale: /in, /uk, /en-gb, /en_IN. "" when it doesn't.
export function localePath(pathname) {
  const seg = String(pathname || "").split("/").filter(Boolean)[0] || "";
  if (/^[a-z]{2}$/i.test(seg) && countryByCode(PATH_ALIAS[seg.toLowerCase()] || seg)) return "/" + seg;
  if (/^[a-z]{2}[-_][a-z]{2}$/i.test(seg) && countryOf(seg)) return "/" + seg;
  return "";
}

// What a page says about the market it serves: <html lang>, og:locale, hreflang alternates, prices.
export function localeSignals(body, pageUrl) {
  const b = String(body || "");
  const lang = (b.match(/<html[^>]*\blang=["']?([a-z]{2,3}(?:[-_][a-z0-9]{2,4})?)/i) || [])[1] || "";
  const og = (b.match(/<meta[^>]+property=["']og:locale["'][^>]+content=["']([^"']+)/i) || [])[1] || "";
  const alternates = [];
  for (const m of b.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]; if (!/rel=["']?alternate/i.test(tag)) continue;
    const hl = (tag.match(/hreflang=["']?([a-z-_]+)/i) || [])[1], href = (tag.match(/href=["']([^"']+)/i) || [])[1];
    if (!hl || !href || /x-default/i.test(hl)) continue;
    try { const u = new URL(href, pageUrl).href; if (!alternates.some((a) => a.href === u)) alternates.push({ lang: hl, href: u, country: countryOf(hl)?.code || null }); } catch {}
  }
  const ld = [...b.matchAll(/"priceCurrency"\s*:\s*"([A-Z]{3})"/g)].map((x) => x[1]);
  const sym = {}; for (const [s, c] of Object.entries(SYMBOL)) { const n = b.split(s).length - 1; if (n) sym[c] = n; }
  const currency = ld[0] || Object.entries(sym).sort((x, y) => y[1] - x[1])[0]?.[0] || "";
  return { lang, ogLocale: og, alternates: alternates.slice(0, 30), currency };
}

// The country one market of a site is for: its locale path first, then its language tag, then its currency (only when one
// country uses it). Returns { code, name, lang, currency, via } or null.
export function detectCountry({ path = "", lang = "", ogLocale = "", currency = "" } = {}) {
  const fromPath = path ? countryOf(path.replace(/^\//, "")) : null;
  if (fromPath) return { ...fromPath, via: "path" };
  for (const [tag, via] of [[lang, "lang"], [ogLocale, "og:locale"]]) { const c = /[-_]/.test(tag) ? countryOf(tag) : null; if (c) return { ...c, via }; }
  const users = COUNTRIES.filter((c) => c.currency === currency);
  if (users.length === 1) return { ...users[0], via: "currency" };
  return null;
}

// Other country versions of the same site, from hreflang or from links that share the locale-path pattern.
export function siblingMarkets(signals, links, origin, scope) {
  const out = new Map();
  for (const a of signals.alternates || []) {
    try { const u = new URL(a.href); if (u.origin !== origin) continue; const p = localePath(u.pathname); const c = countryOf(a.lang) || (p ? countryOf(p.slice(1)) : null); if (c && p !== scope) out.set(p || "/", { path: p || "/", code: c.code, name: c.name, url: u.origin + (p || "/") }); } catch {}
  }
  for (const l of links || []) {
    try { const u = new URL(l); if (u.origin !== origin) continue; const p = localePath(u.pathname); if (!p || p === scope || out.has(p)) continue; const c = countryOf(p.slice(1)); if (c) out.set(p, { path: p, code: c.code, name: c.name, url: u.origin + p }); } catch {}
  }
  return [...out.values()].slice(0, 20);
}

// Is this URL the brand's own page for this market? A page under another country's locale path (/us/... in an India
// check) is the same site but not this market; pages outside any locale path (/about) count for every market.
export function ownUrl(url, site) {
  let u, s;
  try { u = new URL(String(url)); s = new URL(String(site).includes("://") ? site : "https://" + site); } catch { return false; }
  const h = (x) => x.hostname.replace(/^www\./, "");
  if (!(h(u) === h(s) || h(u).endsWith("." + h(s)))) return false;
  const scope = localePath(s.pathname); if (!scope) return true;
  const p = localePath(u.pathname);
  return !p || p.toLowerCase() === scope.toLowerCase();
}
// For engines that don't take a location: one line telling them where the person asking is.
export const locationNote = (c) => (c ? `The user is located in ${c.name}. Answer for buyers there.` : "");
