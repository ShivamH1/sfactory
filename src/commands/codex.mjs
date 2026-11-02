import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { addCost } from "../cost.mjs";
import { readJob, jobDir } from "../store.mjs";
import { appendEvent } from "../events.mjs";
import { fail } from "../errors.mjs";
import { runCodexExec, runCodexReview, profileModel } from "../codex.mjs";
import { resolve, relative, isAbsolute, sep, join } from "node:path";

const USAGE = "usage: sfactory codex exec --cwd <dir> --profile <p> --out <dir> [--sandbox s] [--job id --stage s --model m] < prompt\n       sfactory codex review --cwd <dir> (--base <b>|--commit <sha>) --profile <p> --out <dir> [--job id --stage s --model m] < prompt";

async function readStdin(io) {
  if (io.stdin) return io.stdin();
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString("utf8");
}
const need = (flags, name) => { if (typeof flags[name] !== "string") fail("BAD_ARGS", `codex needs --${name}\n${USAGE}`); return flags[name]; };

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: ["exec", "review"], flags: ["cwd", "profile", "out", "sandbox", "job", "stage", "model", "base", "commit", "role", "task"] };

register("codex", async ({ positional: [verb], flags }, io) => {
  if (verb !== "exec" && verb !== "review") fail(verb ? "UNKNOWN_COMMAND" : "BAD_ARGS", verb ? `codex ${verb}` : USAGE);
  const c = loadConfig(findRepoRoot(io.cwd));
  const cwd = resolve(io.cwd, need(flags, "cwd")), outDir = resolve(io.cwd, need(flags, "out"));
  const prompt = await readStdin(io);
  if (!prompt.trim()) fail("BAD_ARGS", "the prompt (stdin) is empty");
  const run = io.runners ?? { exec: runCodexExec, review: runCodexReview };
  if (flags.profile === true) fail("BAD_ARGS", `--profile needs a value
${USAGE}`);
  const profile = typeof flags.profile === "string" ? flags.profile : c.agents?.codex?.[verb === "exec" ? "implement" : "review"];
  if (typeof profile !== "string" || !profile) fail("BAD_ARGS", `codex needs --profile (or agents.codex.${verb === "exec" ? "implement" : "review"} in the config)\n${USAGE}`);
  if (flags.sandbox === true) fail("BAD_ARGS", `--sandbox needs a value
${USAGE}`);
  if (typeof flags.job === "string") readJob(c, flags.job); // a bad job id fails before Codex is run
  // A run given --job is an agent the board can show: its start, then its finish, even when the run throws.
  const role = typeof flags.role === "string" ? flags.role : verb === "exec" ? "implementer" : "reviewer";
  const stream = join(outDir, verb === "exec" ? "codex.jsonl" : "codex-review.jsonl");
  const agentEvent = (phase, extra = {}) => {
    if (typeof flags.job !== "string") return;
    const rel = relative(jobDir(c, flags.job), stream);
    const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    appendEvent(c, flags.job, {
      kind: "agent", phase, role, vendor: "codex", model: profile,
      ...(typeof flags.task === "string" ? { task: flags.task } : {}),
      ...(inside ? { log: rel.split(sep).join("/") } : {}),
      ...extra,
    });
  };
  const finished = (r) => (r ? { ok: !!r.ok, ...(Number.isInteger(r.exitCode) ? { exit: r.exitCode } : {}), ...(Number.isInteger(r.durationMs) ? { durationMs: r.durationMs } : {}) } : { ok: false });
  const record = (usage) => {
    if (!usage || typeof flags.job !== "string") return;
    addCost(c, flags.job, { stage: typeof flags.stage === "string" ? flags.stage : verb, agent: "codex", model: typeof flags.model === "string" ? flags.model : (profileModel(profile) ?? profile), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens ?? 0 });
  };
  if (verb === "exec") {
    agentEvent("start");
    let r;
    try { r = await run.exec(c, { cwd, profile, prompt, outDir, ...(typeof flags.sandbox === "string" ? { sandbox: flags.sandbox } : {}) }); }
    finally { agentEvent("finish", finished(r)); }
    record(r.usage);
    io.stdout(JSON.stringify({ ok: r.ok, exitCode: r.exitCode, usage: r.usage, logPath: r.logPath, lastMessagePath: r.lastMessagePath, durationMs: r.durationMs, ...(r.timedOut ? { timedOut: true } : {}) }) + "\n");
    return r.ok ? 0 : 1;
  }
  agentEvent("start");
  let r;
  try { r = await run.review(c, { cwd, prompt, outDir, profile, ...(typeof flags.base === "string" ? { base: flags.base } : {}), ...(typeof flags.commit === "string" ? { commit: flags.commit } : {}) }); }
  finally { agentEvent("finish", finished(r)); }
  record(r.usage);
  if (r.timedOut) io.stderr("codex review timed out\n");
  io.stdout(r.text.endsWith("\n") ? r.text : r.text + "\n");
  return r.ok ? 0 : 1;
}, ACCEPTS);
