import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { readJob, resolveId } from "../store.mjs";
import { servicesUp, servicesDown, servicesStatus } from "../services.mjs";
import { fail } from "../errors.mjs";
import { copyForVerify } from "../verify-copies.mjs";

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: ["up", "down", "status", "copy"], flags: [] };

register("services", async ({ positional: [verb, id] }, io) => {
  if (!["up", "down", "status", "copy"].includes(verb ?? "") || !id) fail("BAD_ARGS", "usage: sfactory services up|down|status|copy <id>");
  const c = loadConfig(findRepoRoot(io.cwd));
  const job = readJob(c, resolveId(c, id));
  const log = (m) => io.stderr(`${m}\n`);
  // copy: the copyForVerify files only, for a verify step that needs them before the services start (migrations).
  if (verb === "copy") {
    if (!job.worktree) fail("WORKTREE_REQUIRED", `job ${job.id} has no worktree`);
    const r = copyForVerify(c, job, { log });
    io.stdout(`copied ${r.copied.length}${r.missing.length ? `, missing ${r.missing.join(", ")}` : ""}\n`);
    return r.missing.length ? 1 : 0;
  }
  if (verb === "up") {
    for (const s of await servicesUp(c, job, { log, ...io.servicesOpts })) io.stdout(`${s.name} pid=${s.pid} log=${s.log}\n`);
    return 0;
  }
  if (verb === "down") {
    const r = await servicesDown(c, job, { log, ...io.servicesOpts });
    io.stdout(`stopped ${r.killed.length}${r.skipped.length ? `, left ${r.skipped.length}` : ""}\n`);
    for (const s of r.skipped) (s.alive ? io.stderr : io.stdout)(`${s.name} pid=${s.pid}: ${s.reason}\n`);
    for (const p of r.copiesLeft ?? []) io.stderr(`${p}: a verify copy could not be removed from the worktree; remove it by hand\n`);
    return r.skipped.some((s) => s.alive) || r.copiesLeft?.length ? 1 : 0;
  }
  const rows = servicesStatus(c, job, io.servicesOpts);
  if (!rows.length) io.stdout("no services recorded\n");
  for (const s of rows) io.stdout(`${s.name} pid=${s.pid} ${s.state === "ours" ? "alive" : s.state}\n`);
  return rows.some((s) => s.state !== "ours" && s.state !== "dead") ? 1 : 0; // unknown, foreign or unreadable
}, ACCEPTS);
