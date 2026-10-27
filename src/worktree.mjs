import { existsSync, copyFileSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { git, isClean, headOf, branchExists, newestBranch, worktreeOfBranch } from "./git.mjs";
import { slugify } from "./store.mjs";
import { acquireSync, release } from "./lock.mjs";

export function resolveBase(c) {
  const cwd = c.repoRoot;
  const rule = c.worktrees.baseRule;
  let branch;
  if (rule === "newest-feature-branch") branch = newestBranch(cwd, c.worktrees.branchPrefix) ?? integration(c);
  else if (rule === "integration-branch") branch = integration(c);
  else branch = rule;
  if (!branchExists(cwd, branch)) fail("BASE_NOT_FOUND", `base branch ${branch} does not exist`);
  return { branch, head: headOf(cwd, branch) };
}
function integration(c) {
  if (c.worktrees.integrationBranch) return c.worktrees.integrationBranch;
  return ["development", "develop", "main", "master"].find((b) => branchExists(c.repoRoot, b)) ?? "main";
}

/**
 * Cut a worktree and branch for a job. Refusals run cheap-first; anything that throws after the lock
 * is taken rolls back (worktree, branch, lock, in reverse) and rethrows the original error.
 * `afterAdd` is a TEST-ONLY callback invoked between the worktree add and the base re-read.
 */
export function cut(c, job, { slug, afterAdd } = {}) {
  const s = slugify(slug ?? job.title.replace(/^M\d+\s+/i, ""));
  const dir = resolve(c.worktrees.dir, s || "x");
  if (dir === resolve(c.repoRoot) || resolve(c.worktrees.dir) === resolve(c.repoRoot)) fail("WORKTREE_IS_MAIN_CHECKOUT", `worktrees.dir must not be the main checkout (${c.repoRoot})`);
  if (!s) fail("BAD_ARGS", "cannot derive a slug from the title; pass --slug");
  const branch = `${c.worktrees.branchPrefix}${s}`;
  if (branchExists(c.repoRoot, branch)) fail("BRANCH_EXISTS", `${branch} already exists`);
  const base = resolveBase(c);
  const lockName = `worktree:${s}`;
  let lock;
  try { lock = acquireSync(c, lockName, { holder: job.id, durable: true }); }
  catch (e) { if (e.code === "LOCK_HELD") fail("WORKTREE_LOCKED", e.message); throw e; }
  let worktreeAdded = false, branchCreated = false;
  try {
    mkdirSync(dirname(dir), { recursive: true });
    branchCreated = true;
    git(["worktree", "add", "-b", branch, dir, base.head], { cwd: c.repoRoot });
    worktreeAdded = true;
    if (afterAdd) afterAdd();
    const after = headOf(c.repoRoot, base.branch);
    if (after !== base.head) fail("BASE_MOVED", `${base.branch} moved from ${base.head} to ${after} during the cut; re-run`);
    const baseDir = worktreeOfBranch(c.repoRoot, base.branch);
    for (const rel of c.worktrees.copyFromBase) {
      const from = baseDir ? join(baseDir, rel) : null;
      if (from && existsSync(from) && !existsSync(join(dir, rel))) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); copyFileSync(from, join(dir, rel)); }
    }
    for (const cmd of c.worktrees.afterCut) {
      const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (r.status !== 0) fail("AFTER_CUT_FAILED", `${cmd} exited ${r.status} in ${dir}:
${(r.stderr ?? "").slice(-2000)}`);
    }
  } catch (e) {
    if (worktreeAdded) { try { git(["worktree", "remove", "--force", dir], { cwd: c.repoRoot }); } catch { /* best effort */ } }
    if (branchCreated && branchExists(c.repoRoot, branch)) { try { git(["branch", "-D", branch], { cwd: c.repoRoot }); } catch { /* best effort */ } }
    try { lock.release(); } catch { /* best effort */ }
    throw e;
  }
  return { ...job, branch, base, worktree: dir, slug: s, lockToken: lock.token };
}

export function remove(c, job, { force = false } = {}) {
  if (!job.worktree) fail("BAD_ARGS", `${job.id} has no worktree`);
  if (!force && existsSync(job.worktree) && !isClean(job.worktree)) fail("DIRTY_WORKTREE", `${job.worktree} has uncommitted changes; commit them or pass --force`);
  git(["worktree", "remove", "--force", job.worktree], { cwd: c.repoRoot });
  const { slug: _s, lockToken: _t, ...rest } = job;
  // NOT_HOLDER propagates; a false return means the lock was already gone.
  release(c, `worktree:${job.slug ?? slugify(basename(job.worktree))}`, { holder: job.id, token: job.lockToken });
  return { ...rest, worktree: null };
}
