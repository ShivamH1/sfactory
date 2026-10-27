import { existsSync, copyFileSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { git, headOf, branchExists, newestBranch, worktreeOfBranch } from "./git.mjs";
import { slugify } from "./store.mjs";
import { status, release } from "./lock.mjs";

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

/** Synchronous lock take, same file format as lock.mjs, because cut() is sync. */
function takeLockSync(c, name, holder) {
  const s = status(c, name);
  if (s.held && s.holder !== holder) fail("WORKTREE_LOCKED", `${name} is locked by ${s.holder} since ${s.since}`);
  if (s.held) return;
  const dir = join(c.stateDir, "locks"); mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${slugify(name)}.lock`), "wx");
  writeSync(fd, JSON.stringify({ name, holder, pid: process.pid, since: new Date().toISOString() }, null, 2)); closeSync(fd);
}

export function cut(c, job, { slug } = {}) {
  const s = slug || slugify(job.title.replace(/^M\d+\s+/i, ""));
  if (!s) fail("BAD_ARGS", "cannot derive a slug from the title; pass --slug");
  const dir = resolve(c.worktrees.dir, s);
  if (dir === resolve(c.repoRoot) || resolve(c.worktrees.dir) === resolve(c.repoRoot)) fail("WORKTREE_IS_MAIN_CHECKOUT", `worktrees.dir must not be the main checkout (${c.repoRoot})`);
  const lockName = `worktree:${s}`;
  takeLockSync(c, lockName, job.id);
  const branch = `${c.worktrees.branchPrefix}${s}`;
  if (branchExists(c.repoRoot, branch)) fail("BRANCH_EXISTS", `${branch} already exists`);
  const base = resolveBase(c);
  mkdirSync(dirname(dir), { recursive: true });
  git(["worktree", "add", "-b", branch, dir, base.head], { cwd: c.repoRoot });
  const after = headOf(c.repoRoot, base.branch);
  if (after !== base.head) fail("BASE_MOVED", `${base.branch} moved from ${base.head} to ${after} during the cut; re-run`);
  const baseDir = worktreeOfBranch(c.repoRoot, base.branch);
  for (const rel of c.worktrees.copyFromBase) {
    const from = baseDir ? join(baseDir, rel) : null;
    if (from && existsSync(from) && !existsSync(join(dir, rel))) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); copyFileSync(from, join(dir, rel)); }
  }
  for (const cmd of c.worktrees.afterCut) {
    const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) fail("AFTER_CUT_FAILED", `${cmd} exited ${r.status} in ${dir}:\n${r.stderr.slice(-2000)}`);
  }
  return { ...job, branch, base, worktree: dir };
}

export function remove(c, job) {
  if (!job.worktree) fail("BAD_ARGS", `${job.id} has no worktree`);
  git(["worktree", "remove", "--force", job.worktree], { cwd: c.repoRoot });
  const s = slugify(job.worktree.split(/[\\/]/).pop());
  try { release(c, `worktree:${s}`, { holder: job.id }); } catch {}
  return { ...job, worktree: null };
}
