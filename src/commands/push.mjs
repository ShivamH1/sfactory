import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { push } from "../push.mjs";
import { withLock } from "../lock.mjs";

register("push", async ({ flags }, io) => {
  const cwd = typeof flags.cwd === "string" ? flags.cwd : io.cwd;
  const c = loadConfig(findRepoRoot(cwd));
  const res = await withLock(c, "push", { holder: typeof flags.holder === "string" ? flags.holder : "session", waitMs: 60_000 }, async () => push(c, { cwd }));
  io.stdout(`${res.branch} ${res.remoteHead}\n`);
  return 0;
});
