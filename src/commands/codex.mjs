import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { addCost } from "../cost.mjs";
import { readJob } from "../store.mjs";
import { fail } from "../errors.mjs";
import { runCodexExec, runCodexReview } from "../codex.mjs";
import { resolve } from "node:path";

const USAGE = "usage: sfactory codex exec --cwd <dir> --profile <p> --out <dir> [--sandbox s] [--job id --stage s --model m] < prompt\n       sfactory codex review --cwd <dir> (--base <b>|--commit <sha>) --out <dir> [--profile p] [--job id] < prompt";

async function readStdin(io) {
  if (io.stdin) return io.stdin();
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString("utf8");
}
const need = (flags, name) => { if (typeof flags[name] !== "string") fail("BAD_ARGS", `codex needs --${name}\n${USAGE}`); return flags[name]; };

register("codex", async ({ positional: [verb], flags }, io) => {
  if (verb !== "exec" && verb !== "review") fail(verb ? "UNKNOWN_COMMAND" : "BAD_ARGS", verb ? `codex ${verb}` : USAGE);
  const c = loadConfig(findRepoRoot(io.cwd));
  const cwd = resolve(io.cwd, need(flags, "cwd")), outDir = resolve(io.cwd, need(flags, "out"));
  const prompt = await readStdin(io);
  if (!prompt.trim()) fail("BAD_ARGS", "the prompt (stdin) is empty");
  const run = io.runners ?? { exec: runCodexExec, review: runCodexReview };
  const record = (usage, profile) => {
    if (!usage || typeof flags.job !== "string") return;
    readJob(c, flags.job);
    addCost(c, flags.job, { stage: typeof flags.stage === "string" ? flags.stage : verb, agent: "codex", model: typeof flags.model === "string" ? flags.model : (profile ?? "codex"), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  };
  if (verb === "exec") {
    const profile = need(flags, "profile");
    const r = await run.exec(c, { cwd, profile, prompt, outDir, ...(typeof flags.sandbox === "string" ? { sandbox: flags.sandbox } : {}) });
    record(r.usage, profile);
    io.stdout(JSON.stringify({ ok: r.ok, exitCode: r.exitCode, usage: r.usage, logPath: r.logPath, lastMessagePath: r.lastMessagePath, durationMs: r.durationMs }) + "\n");
    return r.ok ? 0 : 1;
  }
  const profile = typeof flags.profile === "string" ? flags.profile : undefined;
  const r = await run.review(c, { cwd, prompt, outDir, profile, ...(typeof flags.base === "string" ? { base: flags.base } : {}), ...(typeof flags.commit === "string" ? { commit: flags.commit } : {}) });
  io.stdout(r.text.endsWith("\n") ? r.text : r.text + "\n");
  return r.ok ? 0 : 1;
});
