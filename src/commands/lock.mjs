import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { acquire, release, status } from "../lock.mjs";
import { fail } from "../errors.mjs";

const int = (v, flag, min) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min) fail("BAD_ARGS", `--${flag} must be an integer >= ${min}`);
  return n;
};

register("lock", async ({ positional: [verb, name], flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (!name) fail("BAD_ARGS", "usage: sfactory lock <acquire|release|status> <name> [--holder id] [--token t] [--wait ms] [--pid n] [--stale-ms n] [--durable]");
  if (verb === "status") { io.stdout(JSON.stringify(status(c, name)) + "\n"); return 0; }
  if (verb === "acquire") {
    // The CLI process exits at once, so its own pid says nothing about the owner: pid null unless --pid names one.
    const opts = { holder: flags.holder, waitMs: flags.wait === undefined ? 0 : int(flags.wait, "wait", 0), pid: flags.pid === undefined ? null : int(flags.pid, "pid", 1), durable: flags.durable === true };
    if (flags["stale-ms"] !== undefined) opts.staleMs = int(flags["stale-ms"], "stale-ms", 0);
    const l = await acquire(c, name, opts);
    io.stdout(`${name} acquired by ${l.holder} token ${l.token}${l.tookOverFrom ? ` (took over from ${l.tookOverFrom})` : ""}\n`);
    return 0;
  }
  if (verb === "release") {
    if (typeof flags.token !== "string") fail("BAD_ARGS", "release needs --token");
    io.stdout(release(c, name, { holder: flags.holder, token: flags.token }) ? `${name} released\n` : `${name} was not held\n`);
    return 0;
  }
  fail("UNKNOWN_COMMAND", `lock ${verb}`);
});
