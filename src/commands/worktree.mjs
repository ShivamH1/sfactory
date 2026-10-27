import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
// writeJob is called here with fields produced by cut/remove, not by job.mjs. This is the one
// sanctioned exception to "only job.mjs writes": cut and remove change no stage and append no
// history, and the branch/base/worktree/slug/lockToken fields belong to them. The job is re-read
// after the git work and only those fields are patched, so a stage change made meanwhile survives.
import { readJob, writeJob } from "../store.mjs";
import { cut, remove, resolveBase } from "../worktree.mjs";
import { fail } from "../errors.mjs";
import { git } from "../git.mjs";

const CUT_FIELDS = ["branch", "base", "worktree", "slug", "lockToken"];

/** Cut a job's worktree and record it. `afterAdd` is the TEST-ONLY hook passed through to cut(). */
export function cutJob(c, id, { slug, afterAdd, fetch = true } = {}) {
  const made = cut(c, readJob(c, id), { slug, afterAdd, fetch });
  const fresh = readJob(c, id);
  if (fresh.worktree) {
    // A concurrent cut of the same job (under another slug) recorded its worktree first: undo ours.
    try { remove(c, made, { force: true }); git(["branch", "-D", made.branch], { cwd: c.repoRoot }); } catch { /* best effort */ }
    fail("WORKTREE_EXISTS", `${id} already has a worktree (${fresh.worktree}); this cut was undone`);
  }
  for (const k of CUT_FIELDS) fresh[k] = made[k];
  return writeJob(c, fresh);
}

export function removeJob(c, id, { force = false } = {}) {
  const left = remove(c, readJob(c, id), { force });
  const fresh = readJob(c, id);
  for (const k of CUT_FIELDS) if (k in left) fresh[k] = left[k]; else delete fresh[k];
  return writeJob(c, fresh);
}

register("worktree", async ({ positional: [verb, id], flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (verb === "base") { const b = resolveBase(c, { fetch: flags["no-fetch"] !== true }); io.stdout(`${b.branch} ${b.head}\n`); return 0; }
  if (!id) fail("BAD_ARGS", "usage: sfactory worktree <cut|remove> <id> [--slug s] [--force] | sfactory worktree base");
  if (verb === "cut") {
    const j = cutJob(c, id, { slug: flags.slug, fetch: flags["no-fetch"] !== true });
    io.stdout(`${j.id} ${j.branch} ${j.worktree} (base ${j.base.branch} ${j.base.head.slice(0, 7)}) lock token ${j.lockToken}\n`);
    return 0;
  }
  if (verb === "remove") { removeJob(c, id, { force: flags.force === true }); io.stdout(`${id} worktree removed\n`); return 0; }
  fail("UNKNOWN_COMMAND", `worktree ${verb}`);
});
