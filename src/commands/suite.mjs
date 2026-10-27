import { join, resolve } from "node:path";
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { jobDir } from "../store.mjs";
import { runSuite } from "../suite.mjs";
import { fail } from "../errors.mjs";

register("suite", async ({ flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  const job = flags.job;
  if (typeof job !== "string" || !job) fail("BAD_ARGS", "usage: sfactory suite --cwd <dir> --job <id> [--log path]");
  const cwd = typeof flags.cwd === "string" ? resolve(io.cwd, flags.cwd) : io.cwd;
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const logPath = typeof flags.log === "string" ? resolve(io.cwd, flags.log) : join(jobDir(c, job), "verify", `suite-${stamp}.log`);
  const r = await runSuite(c, { cwd, jobId: job, logPath });
  io.stdout(`${r.ok ? "ok" : `red (exit ${r.code})`}${r.ok ? ` (${r.durationMs} ms)` : ""}\n`);
  if (r.tail) io.stdout(`${r.tail}\n`);
  return r.code ?? 1;
});
