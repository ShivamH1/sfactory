import { fail } from "./errors.mjs";
import { git, currentBranch, isClean, remoteHead, headOf } from "./git.mjs";

export function push(c, { cwd, remote = "origin" }) {
  if (c.git.push === false) fail("PUSH_DISABLED", "git.push is false in sfactory.config.json");
  const prefix = c.worktrees.branchPrefix;
  if (!prefix) fail("BRANCH_REFUSED", "branchPrefix is empty; refusing to push");
  const branch = currentBranch(cwd);
  if (!branch || !branch.startsWith(prefix)) fail("BRANCH_REFUSED", `only ${prefix}* branches are pushed; on "${branch || "(detached)"}"`);
  if (!isClean(cwd)) fail("DIRTY_TREE", `uncommitted changes in ${cwd}`);
  git(["push", "--quiet", "-u", remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd });
  git(["fetch", "--quiet", remote, branch], { cwd });
  const rh = remoteHead(cwd, branch, remote);
  const lh = headOf(cwd, branch);
  if (rh !== lh) fail("PUSH_UNVERIFIED", `${remote}/${branch} is ${rh ?? "absent"}, local is ${lh}`);
  return { branch, remoteHead: rh };
}
