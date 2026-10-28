import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
// writeJob is called here with fields produced by cut/remove, not by job.mjs. This is the one
// sanctioned exception to "only job.mjs writes": cut and remove change no stage and append no
// history, and the branch/base/worktree/slug/lockToken fields belong to them. The job is re-read
// after the git work and only those fields are patched, so a stage change made meanwhile survives.
import { readJob, writeJob, withJobLock } from "../store.mjs";
import { cut, remove, resolveBase } from "../worktree.mjs";
import { fail } from "../errors.mjs";
import { git, branchExists } from "../git.mjs";
import { release } from "../lock.mjs";
import { existsSync } from "node:fs";

const CUT_FIELDS = ["branch", "base", "worktree", "slug", "lockToken"];

/** Cut a job's worktree and record it. `afterAdd` is the TEST-ONLY hook passed through to cut(). */
export function cutJob(c, id, { slug, afterAdd, fetch = true, warn = (m) => process.stderr.write(m) } = {}) {
  const made = cut(c, readJob(c, id), { slug, afterAdd, fetch });
  // Only the re-read, patch and write hold the job lock; the cut above (its fetch included) can take minutes.
  // Any failure after the cut undoes it (worktree, branch, durable lock) and rethrows, so nothing is orphaned.
  // Order: worktree, then branch, then the durable lock last, so a crash midway leaves the lock held (the
  // name stays reserved) rather than a free name with a branch still on it. Anything not removed is named.
  const undo = () => {
    const left = [];
    try { if (existsSync(made.worktree)) git(["worktree", "remove", "--force", made.worktree], { cwd: c.repoRoot }); } catch { left.push(`worktree ${made.worktree}`); }
    try { if (branchExists(c.repoRoot, made.branch)) git(["branch", "-D", made.branch], { cwd: c.repoRoot }); } catch { left.push(`branch ${made.branch}`); }
    try { release(c, `worktree:${made.slug}`, { holder: made.id, token: made.lockToken }); } catch { left.push(`lock worktree:${made.slug}`); }
    if (left.length) warn(`cut undone for ${made.id}, but could not remove: ${left.join(", ")}
`);
  };
  try {
    return withJobLock(c, id, () => {
      const fresh = readJob(c, id);
      if (fresh.worktree) fail("WORKTREE_EXISTS", `${id} already has a worktree (${fresh.worktree}); this cut was undone`);
      for (const k of CUT_FIELDS) fresh[k] = made[k];
      return writeJob(c, fresh);
    });
  } catch (e) { undo(); throw e; }
}

export function removeJob(c, id, { force = false } = {}) {
  const left = remove(c, readJob(c, id), { force });
  return withJobLock(c, id, () => {
    const fresh = readJob(c, id);
    for (const k of CUT_FIELDS) if (k in left) fresh[k] = left[k]; else delete fresh[k];
    return writeJob(c, fresh);
  });
}

register("worktree", async ({ positional: [verb, id], flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (verb === "base") { const b = resolveBase(c, { fetch: flags["no-fetch"] !== true }); io.stdout(`${b.branch} ${b.head}\n`); return 0; }
  if (!id) fail("BAD_ARGS", "usage: sfactory worktree <cut|remove> <id> [--slug s] [--force] | sfactory worktree base");
  if (verb === "cut") {
    const j = cutJob(c, id, { slug: flags.slug, fetch: flags["no-fetch"] !== true, warn: io.stderr });
    io.stdout(`${j.id} ${j.branch} ${j.worktree} (base ${j.base.branch} ${j.base.head.slice(0, 7)}) lock token ${j.lockToken}\n`);
    return 0;
  }
  if (verb === "remove") { removeJob(c, id, { force: flags.force === true }); io.stdout(`${id} worktree removed\n`); return 0; }
  fail("UNKNOWN_COMMAND", `worktree ${verb}`);
});
