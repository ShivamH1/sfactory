import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { acquire, release, status } from "../lock.mjs";
import { fail } from "../errors.mjs";

register("lock", async ({ positional: [verb, name], flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (!name) fail("BAD_ARGS", "usage: sfactory lock <acquire|release|status> <name> [--holder id] [--wait ms]");
  if (verb === "status") { io.stdout(JSON.stringify(status(c, name)) + "\n"); return 0; }
  if (verb === "acquire") { const l = await acquire(c, name, { holder: flags.holder, waitMs: Number(flags.wait ?? 0) }); io.stdout(`${name} acquired by ${l.holder}${l.tookOverFrom ? ` (took over from ${l.tookOverFrom})` : ""}\n`); return 0; }
  if (verb === "release") { io.stdout(release(c, name, { holder: flags.holder }) ? `${name} released\n` : `${name} was not held\n`); return 0; }
  fail("UNKNOWN_COMMAND", `lock ${verb}`);
});
