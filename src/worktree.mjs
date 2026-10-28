import { existsSync, copyFileSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { git, isClean, headOf, branchExists, newestBranch, worktreeOfBranch, remoteHead, branchContains } from "./git.mjs";
import { slugify } from "./store.mjs";
import { acquireSync, assertHolder, release } from "./lock.mjs";

export function resolveBase(c, { fetch = true } = {}) {
  const cwd = c.repoRoot;
  if (fetch && git(["remote"], { cwd }).split(/\s+/).includes("origin")) {
    const r = fetchOrigin(cwd);
    if (r.error || r.status !== 0) process.stderr.write(`warning: git fetch origin failed (${oneLine(r.error?.message ?? r.stderr)}); using local refs\n`);
  }
  const rule = c.worktrees.baseRule;
  let branch;
  if (rule === "newest-feature-branch") branch = newestBranch(cwd, c.worktrees.branchPrefix) ?? integration(c);
  else if (rule === "integration-branch") branch = integration(c);
  else branch = rule;
  const remote = remoteHead(cwd, branch);
  if (!branchExists(cwd, branch)) {
    if (!remote) fail("BASE_NOT_FOUND", `base branch ${branch} does not exist`);
    return { branch, ref: `origin/${branch}`, head: remote };
  }
  const local = headOf(cwd, branch);
  if (!remote || remote === local) return { branch, ref: branch, head: local };
  if (branchContains(cwd, remote, local)) return { branch, ref: `origin/${branch}`, head: remote };
  if (!branchContains(cwd, local, remote)) process.stderr.write(`warning: ${branch} and origin/${branch} have diverged; using local ${branch}\n`);
  return { branch, ref: branch, head: local };
}
/**
 * git fetch that can never prompt. It runs under a small node wrapper so that, on timeout, the whole
 * process tree (git-remote-https and friends) is killed with killTree, not just git. Off win32 git is
 * detached (its own group, for the kill), so the wrapper passes Ctrl+C, SIGTERM and SIGHUP on to it.
 */
const FETCH_WRAPPER = `
import { spawn } from "node:child_process";
import { killTree, followSignals } from ${JSON.stringify(new URL("./suite.mjs", import.meta.url).href)};
const detached = process.platform !== "win32";
const p = spawn("git", ["fetch", "--quiet", "origin"], { stdio: ["ignore", "ignore", "pipe"], detached });
if (detached) followSignals(p);
let err = "";
p.stderr.on("data", (d) => { err += d; });
const t = setTimeout(() => { killTree(p); process.stderr.write("fetch timed out"); process.exit(124); }, Number(process.env.SF_FETCH_TIMEOUT_MS) || 60000);
p.on("error", (e) => { clearTimeout(t); process.stderr.write(e.message); process.exit(1); });
p.on("close", (code) => { clearTimeout(t); process.stderr.write(err); process.exit(code ?? 1); });
`;
/** The fetch's environment: no prompts, and BatchMode ssh only when the user has chosen no ssh command. */
export function fetchEnv(cwd, env = process.env) {
  const out = { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  // Git ranks GIT_SSH_COMMAND above core.sshCommand and GIT_SSH, so only set it when the user has configured neither.
  const userSsh = env.GIT_SSH_COMMAND || env.GIT_SSH || spawnSync("git", ["config", "--get", "core.sshCommand"], { cwd, encoding: "utf8", env }).stdout?.trim();
  if (!userSsh) out.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return out;
}
export function fetchOrigin(cwd, { timeoutMs = 60_000 } = {}) {
  const env = { ...fetchEnv(cwd), SF_FETCH_TIMEOUT_MS: String(timeoutMs) };
  return spawnSync(process.execPath, ["--input-type=module", "-e", FETCH_WRAPPER], { cwd, encoding: "utf8", timeout: timeoutMs + 15_000, env });
}
const hasBranch = (cwd, b) => branchExists(cwd, b) || remoteHead(cwd, b) !== null;
/** One line, URL credentials (scheme://user:pass@) removed, capped. */
export function oneLine(s) {
  const first = String(s ?? "").trim().split(/\r?\n/)[0] ?? "";
  const t = first.replace(/(\w+:\/\/)[^\s/@]*@/g, "$1***@");
  return t.length > 200 ? `${t.slice(0, 200)}...` : t;
}
export function integration(c) {
  if (c.worktrees.integrationBranch) return c.worktrees.integrationBranch;
  return ["development", "develop", "main", "master"].find((b) => hasBranch(c.repoRoot, b)) ?? "main";
}

/**
 * Cut a worktree and branch for a job. Refusals run cheap-first; anything that throws after the lock
 * is taken rolls back (worktree, branch, lock, in reverse) and rethrows the original error.
 * `afterAdd` is a TEST-ONLY callback invoked between the worktree add and the base re-read.
 */
export function cut(c, job, { slug, afterAdd, fetch = true } = {}) {
  if (job.worktree) fail("WORKTREE_EXISTS", `${job.id} already has a worktree (${job.worktree}); remove it first`);
  const s = slugify(slug ?? job.title.replace(/^M\d+\s+/i, ""));
  const dir = resolve(c.worktrees.dir, s || "x");
  if (dir === resolve(c.repoRoot) || resolve(c.worktrees.dir) === resolve(c.repoRoot)) fail("WORKTREE_IS_MAIN_CHECKOUT", `worktrees.dir must not be the main checkout (${c.repoRoot})`);
  if (!s) fail("BAD_ARGS", "cannot derive a slug from the title; pass --slug");
  const branch = `${c.worktrees.branchPrefix}${s}`;
  if (branchExists(c.repoRoot, branch)) fail("BRANCH_EXISTS", `${branch} already exists`);
  const base = resolveBase(c, { fetch });
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
    const after = headOf(c.repoRoot, base.ref);
    if (after !== base.head) fail("BASE_MOVED", `${base.ref} moved from ${base.head} to ${after} during the cut; re-run`);
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
    try { git(["worktree", "prune"], { cwd: c.repoRoot }); } catch { /* best effort */ }
    if (branchCreated && branchExists(c.repoRoot, branch)) { try { git(["branch", "-D", branch], { cwd: c.repoRoot }); } catch { /* best effort */ } }
    try { lock.release(); } catch { /* best effort */ }
    throw e;
  }
  return { ...job, branch, base, worktree: dir, slug: s, lockToken: lock.token };
}

export function remove(c, job, { force = false } = {}) {
  if (!job.worktree) fail("BAD_ARGS", `${job.id} has no worktree`);
  const lockName = `worktree:${job.slug ?? slugify(basename(job.worktree))}`;
  // Ownership first: another holder's lock (NOT_HOLDER) leaves the worktree in place.
  assertHolder(c, lockName, { holder: job.id, token: job.lockToken });
  if (!force && existsSync(job.worktree) && !isClean(job.worktree)) fail("DIRTY_WORKTREE", `${job.worktree} has uncommitted changes; commit them or pass --force`);
  git(["worktree", "remove", "--force", job.worktree], { cwd: c.repoRoot });
  const { slug: _s, lockToken: _t, ...rest } = job;
  // NOT_HOLDER still propagates if the lock changed hands since the check; a false return means it was already gone.
  release(c, lockName, { holder: job.id, token: job.lockToken });
  return { ...rest, worktree: null };
}
