import { readJobFile, writeJobFile } from "./store.mjs";

export function priceOf(prices, model, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 }) {
  const p = prices?.[model];
  if (!p) return null;
  return Math.round(((inputTokens * p.input + outputTokens * p.output + cacheReadTokens * (p.cacheRead ?? 0)) / 1e6) * 10000) / 10000;
}
export function totalUsd(entries) {
  let usd = 0, unpriced = 0;
  for (const e of entries) if (e.usd == null) unpriced++; else usd += e.usd;
  return { usd: Math.round(usd * 10000) / 10000, unpriced };
}
export function readCost(c, id) { const t = readJobFile(c, id, "cost.json"); return t ? JSON.parse(t) : { entries: [], total: { usd: 0, unpriced: 0 } }; }
export function addCost(c, id, { at = new Date().toISOString(), stage, agent, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, usd = null }) {
  const computed = usd ?? priceOf(c.prices, model, { inputTokens, outputTokens, cacheReadTokens });
  const entry = { at, stage, agent, model, inputTokens, outputTokens, cacheReadTokens, usd: computed, priced: computed != null };
  const all = readCost(c, id);
  all.entries.push(entry);
  all.total = totalUsd(all.entries);
  writeJobFile(c, id, "cost.json", JSON.stringify(all, null, 2) + "\n");
  return entry;
}
