import { engines, env, json, llmProvider } from "./_lib.js";
import { COUNTRIES } from "./_markets.js";
export const config = { runtime: "edge" };
export default async function handler() {
  return json({ engines: engines(), llm: !!llmProvider(), writer: llmProvider(), access: !!env("ACCESS_CODE"),
    // The countries a market can be checked for (onboarding's "Where do you sell?" and Add market).
    countries: COUNTRIES.map((c) => [c.code, c.name]) });
}
