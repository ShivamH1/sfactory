import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, sh } from "./helpers.mjs";
import { git, isClean, currentBranch, headOf, newestBranch, worktrees, worktreeOfBranch, branchContains } from "../src/git.mjs";

test("git: basics on a temp repo", () => {
  const r = tmpRepo();
  assert.equal(currentBranch(r), "main");
  assert.equal(isClean(r), true);
  writeFileSync(join(r, "a.txt"), "a");
  assert.equal(isClean(r), false);
  assert.match(headOf(r, "main"), /^[0-9a-f]{40}$/);
  assert.throws(() => git(["rev-parse", "nope-ref"], { cwd: r }), (e) => e.code === "GIT_FAILED");
});

test("git: newestBranch by committer date, worktrees, branchContains", () => {
  const r = tmpRepo();
  sh("git", ["checkout", "-q", "-b", "feature/old"], r);
  writeFileSync(join(r, "o.txt"), "o"); sh("git", ["add", "o.txt"], r);
  sh("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "old", "--date", "2026-01-01T00:00:00Z"], r, { GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" });
  sh("git", ["checkout", "-q", "-b", "feature/new"], r);
  writeFileSync(join(r, "n.txt"), "n"); sh("git", ["add", "n.txt"], r);
  sh("git", ["commit", "-q", "-m", "new"], r);
  sh("git", ["checkout", "-q", "main"], r);
  assert.equal(newestBranch(r, "feature/"), "feature/new");
  assert.equal(newestBranch(r, "zzz/"), null);
  const wt = join(r, "..", "wt-" + Date.now());
  sh("git", ["worktree", "add", "-q", wt, "feature/old"], r);
  assert.equal(worktreeOfBranch(r, "feature/old"), realpathSync.native(wt));
  assert.ok(worktrees(r).some((w) => w.branch === "main"));
  assert.equal(branchContains(r, "feature/new", headOf(r, "feature/old")), true);
  assert.equal(branchContains(r, "feature/old", headOf(r, "feature/new")), false);
});

test("git: newestBranch works for a prefix without a trailing slash", () => {
  const r = tmpRepo();
  sh("git", ["checkout", "-q", "-b", "milestone-a"], r);
  writeFileSync(join(r, "a.txt"), "a"); sh("git", ["add", "a.txt"], r);
  sh("git", ["commit", "-q", "-m", "a", "--date", "2026-01-01T00:00:00Z"], r, { GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" });
  sh("git", ["checkout", "-q", "-b", "milestone-b"], r);
  writeFileSync(join(r, "b.txt"), "b"); sh("git", ["add", "b.txt"], r);
  sh("git", ["commit", "-q", "-m", "b"], r);
  sh("git", ["checkout", "-q", "main"], r);
  assert.equal(newestBranch(r, "milestone-"), "milestone-b");
});
