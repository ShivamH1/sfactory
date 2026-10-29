import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { jobDir, readJobFile, withJobLock, atomicWrite, HOLDER } from "./store.mjs";
import { status } from "./lock.mjs";
import { fail } from "./errors.mjs";

export function priceOf(prices, model, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 }) {
  const p = prices?.[model];
  if (!p) return null;
  return Math.round(((inputTokens * p.input + outputTokens * p.output + cacheReadTokens * (p.cacheRead ?? 0)) / 1e6) * 10000 + 1e-9) / 10000;
}
export function totalUsd(entries) {
  let usd = 0, unpriced = 0;
  for (const e of entries) if (e.usd == null) unpriced++; else usd += e.usd;
  return { usd: Math.round(usd * 10000 + 1e-9) / 10000, unpriced };
}
export function readCost(c, id) {
  const t = readJobFile(c, id, "cost.json");
  if (!t) return { entries: [], total: { usd: 0, unpriced: 0 } };
  try { return JSON.parse(t); } catch (e) { fail("COST_CORRUPT", `${join(jobDir(c, id), "cost.json")}: ${e.message}`); }
}
export function addCost(c, id, { at = new Date().toISOString(), stage, agent, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, usd = null }) {
  const computed = usd ?? priceOf(c.prices, model, { inputTokens, outputTokens, cacheReadTokens });
  const entry = { at, stage, agent, model, inputTokens, outputTokens, cacheReadTokens, usd: computed, priced: computed != null };
  const write = () => {
    const all = readCost(c, id);
    all.entries.push(entry);
    all.total = totalUsd(all.entries);
    const dir = jobDir(c, id);
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, "cost.json"), JSON.stringify(all, null, 2) + "\n");
  };
  const s = status(c, `job:${id}`);
  if (s.held && s.holder === HOLDER) write(); // the caller already holds the job lock: a nested acquire would wait on itself
  else withJobLock(c, id, write);
  return entry;
}
