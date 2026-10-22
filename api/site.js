// Read a website like an AI crawler would (api/_audit.js), stream every finding, then build the brand profile.
import { sse, guard, body, llmJSON } from "./_lib.js";
import { auditSite } from "./_audit.js";
export const config = { runtime: "edge" };

export default async function handler(req) {
  const denied = guard(req); if (denied) return denied;
  const { url } = await body(req);
  return sse(async (send) => {
    const { hp, parsed, audit } = await auditSite(url, send);
    send("step", { id: "profile", text: "Working out what you sell, who buys it, and who you compete with", why: "I need this to ask AI the same questions your buyers ask." });
    const summary = parsed.slice(0, 9).map((p) => `## ${p.title} (${p.url})\n${p.description}\n${p.text.slice(0, 1200)}`).join("\n\n");
    const info = await llmJSON(`Read this company's website and describe it for an AI-visibility tracker.\n\n${summary.slice(0, 12000)}${audit.locale.country ? `\n\nThis is the ${audit.locale.country.name} version of the site.` : ""}\n\nJSON: {"name":"brand name as customers say it","category":"ONE phrase buyers type to find this kind of company, 2-6 words, lowercase, no commas","offer":"one sentence: what they sell and the promise","audience":"who buys it, short","market":"main country or region","competitors":["6-8 real companies whose product does the SAME job for the SAME buyer, i.e. what a buyer would shortlist instead of this company. Prefer direct, category-specific rivals over big generic platforms or tools from adjacent categories (e.g. for an engineering-metrics tool list LinearB, Jellyfish, Swarmia, not Jira or Asana)"],"facts":["5 key facts the site states about the company"],"identity":["4-6 adjectives or short phrases that describe the brand"],"products":["4-8 products or services they sell, short names"],"personas":["4-6 job titles or customer types who buy, short"]}`);
    // A country version of the site (/in, lang="en-IN", ₹ prices) decides the market; the AI's guess is the fallback.
    const c = audit.locale.country;
    const profile = { name: String(info.name || hp.title.split(/[|–-]/)[0]).trim().slice(0, 80), site: audit.site, category: String(info.category || "").split(/[,;|/]/)[0].trim().slice(0, 80), offer: String(info.offer || "").slice(0, 240),
      audience: String(info.audience || "").slice(0, 120), market: c ? c.name : String(info.market || "").slice(0, 60), country: c?.code || null, competitors: (info.competitors || []).map(String).slice(0, 9), facts: (info.facts || []).map(String).slice(0, 6),
      identity: (info.identity || []).map(String).slice(0, 6), products: (info.products || []).map(String).slice(0, 8), personas: (info.personas || []).map(String).slice(0, 6) };
    send("done", { id: "profile", text: `${profile.name}: ${profile.category}. Rivals to watch: ${profile.competitors.slice(0, 4).join(", ")}` });

    send("result", { profile, audit,
      siteText: parsed.slice(0, 6).map((p) => `${p.title}: ${p.text.slice(0, 1500)}`).join("\n\n").slice(0, 9000) });
  });
}
