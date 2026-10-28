import { fail } from "./errors.mjs";
import { integration } from "./worktree.mjs";
import { git, currentBranch, isClean, remoteHead, headOf } from "./git.mjs";

const PROTECTED = ["main", "master"];

/** First commit between the integration branch (or the root) and HEAD that carries a trailer, or null. */
function firstTrailerCommit(c, cwd) {
  const base = git(["merge-base", "HEAD", `origin/${integration({ ...c, repoRoot: cwd })}`], { cwd, allowFail: true });
  // no merge base: only commits that are on no remote, never the whole history
  const out = base
    ? git(["log", "--format=%H%x00%(trailers)%x01", `${base}..HEAD`], { cwd })
    : git(["log", "--format=%H%x00%(trailers)%x01", "HEAD", "--not", "--remotes"], { cwd });
  for (const rec of out.split("\x01")) {
    const [sha, trailers] = rec.trim().split("\0");
    if (sha && trailers && trailers.trim()) return { sha, line: trailers.trim().split(/\r?\n/)[0] };
  }
  return null;
}

export function push(c, { cwd, remote = "origin" }) {
  if (c.git.push !== true) fail("PUSH_DISABLED", `git.push is ${JSON.stringify(c.git.push)} in sfactory.config.json; only true allows a push`);
  const prefix = c.worktrees.branchPrefix;
  if (!prefix) fail("BRANCH_REFUSED", "branchPrefix is empty; refusing to push");
  const branch = currentBranch(cwd);
  if (!branch || !branch.startsWith(prefix)) fail("BRANCH_REFUSED", `only ${prefix}* branches are pushed; on "${branch || "(detached)"}"`);
  const integ = c.worktrees.integrationBranch;
  if (PROTECTED.includes(branch) || (integ && branch === integ)) fail("BRANCH_REFUSED", `"${branch}" is a protected branch and is never pushed by the factory`);
  if (!isClean(cwd)) fail("DIRTY_TREE", `uncommitted changes in ${cwd}`);
  if (c.git.trailers !== true) {
    const bad = firstTrailerCommit(c, cwd);
    if (bad) fail("PUSH_TRAILERS", `commit ${bad.sha} carries a trailer ("${bad.line}") and git.trailers is not true`);
  }
  git(["push", "--quiet", "-u", remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd });
  git(["fetch", "--quiet", remote, branch], { cwd });
  const rh = remoteHead(cwd, branch, remote);
  const lh = headOf(cwd, branch);
  if (rh !== lh) fail("PUSH_UNVERIFIED", `${remote}/${branch} is ${rh ?? "absent"}, local is ${lh}`);
  return { branch, remoteHead: rh };
}
