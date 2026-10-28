import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { push } from "../push.mjs";

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: null, flags: ["cwd"] };

register("push", async ({ flags }, io) => {
  const cwd = typeof flags.cwd === "string" ? flags.cwd : io.cwd;
  const c = loadConfig(findRepoRoot(cwd));
  const res = push(c, { cwd });
  io.stdout(`${res.branch} ${res.remoteHead}\n`);
  return 0;
}, ACCEPTS);
