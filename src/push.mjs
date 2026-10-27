import { fail } from "./errors.mjs";
import { git, currentBranch, isClean, fetch, remoteHead, headOf } from "./git.mjs";

export function push(c, { cwd, remote = "origin" }) {
  if (c.git.push === false) fail("PUSH_DISABLED", "git.push is false in sfactory.config.json");
  const branch = currentBranch(cwd);
  if (!branch || !branch.startsWith(c.worktrees.branchPrefix)) fail("BRANCH_REFUSED", `only ${c.worktrees.branchPrefix}* branches are pushed; on "${branch || "(detached)"}"`);
  if (!isClean(cwd)) fail("DIRTY_TREE", `uncommitted changes in ${cwd}`);
  git(["push", "--quiet", "-u", remote, branch], { cwd });
  fetch(cwd, remote);
  const rh = remoteHead(cwd, branch, remote);
  const lh = headOf(cwd, branch);
  if (rh !== lh) fail("PUSH_UNVERIFIED", `${remote}/${branch} is ${rh ?? "absent"}, local is ${lh}`);
  return { branch, remoteHead: rh };
}
