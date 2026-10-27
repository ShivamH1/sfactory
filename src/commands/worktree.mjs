import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
// writeJob is called here with a job produced by cut/remove, not by job.mjs. This is the one
// sanctioned exception to "only job.mjs writes": cut changes no stage and appends no history,
// and the branch/base/worktree fields belong to it.
import { readJob, writeJob } from "../store.mjs";
import { cut, remove, resolveBase } from "../worktree.mjs";
import { fail } from "../errors.mjs";

register("worktree", async ({ positional: [verb, id], flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (verb === "base") { const b = resolveBase(c); io.stdout(`${b.branch} ${b.head}\n`); return 0; }
  if (!id) fail("BAD_ARGS", "usage: sfactory worktree <cut|remove> <id> [--slug s] [--force] | sfactory worktree base");
  const job = readJob(c, id);
  if (verb === "cut") { const j = writeJob(c, cut(c, job, { slug: flags.slug })); io.stdout(`${j.id} ${j.branch} ${j.worktree} (base ${j.base.branch} ${j.base.head.slice(0, 7)})\n`); return 0; }
  if (verb === "remove") { writeJob(c, remove(c, job, { force: flags.force === true })); io.stdout(`${id} worktree removed\n`); return 0; }
  fail("UNKNOWN_COMMAND", `worktree ${verb}`);
});
