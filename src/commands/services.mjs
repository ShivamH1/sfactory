import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { readJob } from "../store.mjs";
import { servicesUp, servicesDown, servicesStatus } from "../services.mjs";
import { fail } from "../errors.mjs";

register("services", async ({ positional: [verb, id] }, io) => {
  if (!["up", "down", "status"].includes(verb ?? "") || !id) fail("BAD_ARGS", "usage: sfactory services up|down|status <id>");
  const c = loadConfig(findRepoRoot(io.cwd));
  const job = readJob(c, id);
  const log = (m) => io.stderr(`${m}\n`);
  if (verb === "up") {
    for (const s of await servicesUp(c, job, { log, ...io.servicesOpts })) io.stdout(`${s.name} pid=${s.pid} log=${s.log}\n`);
    return 0;
  }
  if (verb === "down") {
    const r = await servicesDown(c, job, { log, ...io.servicesOpts });
    io.stdout(`stopped ${r.killed.length}${r.skipped.length ? `, left ${r.skipped.length}` : ""}\n`);
    for (const s of r.skipped) (s.alive ? io.stderr : io.stdout)(`${s.name} pid=${s.pid}: ${s.reason}\n`);
    return r.skipped.some((s) => s.alive) ? 1 : 0;
  }
  const rows = servicesStatus(c, job);
  if (!rows.length) io.stdout("no services recorded\n");
  for (const s of rows) io.stdout(`${s.name} pid=${s.pid} ${s.state === "ours" ? "alive" : s.state}\n`);
  return 0;
});
