import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { jobDir, readJob } from "../store.mjs";
import { runSuite } from "../suite.mjs";
import { fail } from "../errors.mjs";

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: null, flags: ["cwd", "job", "log"] };

register("suite", async ({ flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  const job = flags.job;
  if (typeof job !== "string" || !job) fail("BAD_ARGS", "usage: sfactory suite --cwd <dir> --job <id> [--log path]");
  readJob(c, job); // unknown id fails before any folder is created
  const cwd = typeof flags.cwd === "string" ? resolve(io.cwd, flags.cwd) : io.cwd;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail("BAD_ARGS", `--cwd is not a directory: ${cwd}`);
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const logPath = typeof flags.log === "string" ? resolve(io.cwd, flags.log) : join(jobDir(c, job), "verify", `suite-${stamp}.log`);
  const r = await runSuite(c, { cwd, jobId: job, logPath });
  io.stdout(`${r.ok ? `ok (${r.durationMs} ms)` : r.signal ? `red (signal ${r.signal})` : `red (exit ${r.code})`}\n`);
  if (r.tail) io.stdout(`${r.tail}\n`);
  return r.code ?? 1;
}, ACCEPTS);
