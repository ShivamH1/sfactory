import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { push } from "../push.mjs";

register("push", async ({ flags }, io) => {
  const cwd = typeof flags.cwd === "string" ? flags.cwd : io.cwd;
  const c = loadConfig(findRepoRoot(cwd));
  const res = push(c, { cwd });
  io.stdout(`${res.branch} ${res.remoteHead}\n`);
  return 0;
});
