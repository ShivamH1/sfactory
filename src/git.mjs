import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fail } from "./errors.mjs";

export function git(args, { cwd, allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) fail("GIT_FAILED", `git not runnable: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail("GIT_FAILED", `git ${args.join(" ")} (in ${cwd}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}
export const isClean = (cwd) => git(["status", "--porcelain"], { cwd }) === "";
export const currentBranch = (cwd) => git(["branch", "--show-current"], { cwd });
export const headOf = (cwd, ref) => git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
export const branchExists = (cwd, name) => spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd }).status === 0;
export function newestBranch(cwd, prefix) {
  const out = git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"], { cwd });
  return out.split(/\r?\n/).filter(Boolean).find((n) => n.startsWith(prefix)) ?? null;
}
export function worktrees(cwd) {
  const out = git(["worktree", "list", "--porcelain"], { cwd });
  const list = []; let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: resolve(line.slice(9)), head: null, branch: null }; list.push(cur); }
    else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return list;
}
export const worktreeOfBranch = (cwd, branch) => worktrees(cwd).find((w) => w.branch === branch)?.path ?? null;
export const branchContains = (cwd, branch, sha) => spawnSync("git", ["merge-base", "--is-ancestor", sha, branch], { cwd }).status === 0;
export const fetch = (cwd, remote = "origin") => git(["fetch", "--quiet", remote], { cwd });
export function remoteHead(cwd, branch, remote = "origin") {
  const r = spawnSync("git", ["rev-parse", "--verify", `${remote}/${branch}^{commit}`], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
