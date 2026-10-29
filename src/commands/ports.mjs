import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
// writeJob is called here with the job's ports set, not by job.mjs. This is the one sanctioned
// exception to "only job.mjs writes": allocating ports changes no stage and appends no history,
// and the ports field belongs to this command.
import { readJob, writeJob, withJobLock } from "../store.mjs";
import { allocate, isFree } from "../ports.mjs";
import { fail } from "../errors.mjs";

register("ports", async ({ positional: [verb, arg] }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (verb === "allocate") {
    if (!arg) fail("BAD_ARGS", "usage: sfactory ports allocate <id> | sfactory ports free <port>");
    readJob(c, arg); // fail early on an unknown id, before any bind
    const ports = await allocate(c, arg);
    // re-read after the binds so a stage change made meanwhile is not overwritten
    withJobLock(c, arg, () => writeJob(c, { ...readJob(c, arg), ports }));
    io.stdout(`${c.ports.names.map((n) => `${n}=${ports[n]}`).join(" ")}\n`);
    return 0;
  }
  if (verb === "free") {
    const port = Number(arg);
    if (!/^\d+$/.test(arg ?? "") || port < 1 || port > 65535) fail("BAD_ARGS", "usage: sfactory ports free <port>");
    const free = await isFree(port);
    io.stdout(free ? "free\n" : "busy\n");
    return free ? 0 : 1;
  }
  fail("UNKNOWN_COMMAND", `ports ${verb}`);
});
