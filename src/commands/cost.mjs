import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { addCost, readCost } from "../cost.mjs";
import { fail } from "../errors.mjs";

const int = (v, flag, required) => {
  if (v === undefined && !required) return 0;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) fail("BAD_ARGS", `--${flag} must be a non-negative integer`);
  return n;
};

register("cost", async ({ positional: [verb, id], flags }, io) => {
  if (!id) fail("BAD_ARGS", "usage: sfactory cost <add|show> <id> [--stage s --agent claude|codex --model m --in n --out n [--cache-read n] [--usd x]]");
  const c = loadConfig(findRepoRoot(io.cwd));
  if (verb === "show") { io.stdout(JSON.stringify(readCost(c, id), null, 2) + "\n"); return 0; }
  if (verb === "add") {
    if (flags.agent !== "claude" && flags.agent !== "codex") fail("BAD_ARGS", "--agent must be claude or codex");
    if (typeof flags.model !== "string") fail("BAD_ARGS", "cost add needs --model");
    if (typeof flags.stage !== "string") fail("BAD_ARGS", "cost add needs --stage");
    const inputTokens = int(flags.in, "in", true), outputTokens = int(flags.out, "out", true);
    const cacheReadTokens = int(flags["cache-read"], "cache-read", false);
    let usd = null;
    if (flags.usd !== undefined) {
      usd = typeof flags.usd === "string" && flags.usd.trim() !== "" ? Number(flags.usd) : NaN;
      if (!Number.isFinite(usd) || usd < 0) fail("BAD_ARGS", "--usd must be a non-negative number");
    }
    const e = addCost(c, id, { stage: flags.stage, agent: flags.agent, model: flags.model, inputTokens, outputTokens, cacheReadTokens, usd });
    io.stdout(`${id} ${e.model} ${e.priced ? e.usd : "unpriced"}\n`);
    return 0;
  }
  fail("UNKNOWN_COMMAND", `cost ${verb}`);
});
