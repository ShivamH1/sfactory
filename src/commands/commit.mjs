import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { commit } from "../commit.mjs";
import { fail } from "../errors.mjs";

// Single-dash -m is not parsed by parseArgs: use --m or --message.
/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: null, flags: ["cwd", "holder", "m", "message"] };

register("commit", async ({ flags }, io) => {
  const message = flags.message ?? flags.m;
  const paths = flags.rest ?? [];
  if (typeof message !== "string" || !message.trim()) fail("BAD_ARGS", "usage: sfactory commit [--cwd dir] [--holder id] --m|--message \"<msg>\" -- <path...>");
  if (paths.length === 0) fail("BAD_ARGS", "commit needs paths after --");
  const cwd = typeof flags.cwd === "string" ? flags.cwd : io.cwd;
  const c = loadConfig(findRepoRoot(cwd));
  const sha = await commit(c, { cwd, paths, message, holder: typeof flags.holder === "string" ? flags.holder : "session" });
  io.stdout(`${sha}\n`);
  return 0;
}, ACCEPTS);
