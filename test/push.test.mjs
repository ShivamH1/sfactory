import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, sh } from "./helpers.mjs";
import { push } from "../src/push.mjs";
import { headOf } from "../src/git.mjs";

function repoWithRemote() {
  const bare = tmpDir("sf-bare-"); sh("git", ["init", "-q", "--bare", bare], bare);
  const r = tmpRepo(); sh("git", ["remote", "add", "origin", bare], r); sh("git", ["push", "-q", "-u", "origin", "main"], r);
  return r;
}
const cfg = (push = true) => ({ stateDir: tmpDir("sf-p-"), git: { push }, worktrees: { branchPrefix: "feature/" } });

test("push: pushes a clean feature branch and verifies the remote head", () => {
  const r = repoWithRemote();
  sh("git", ["checkout", "-q", "-b", "feature/x"], r);
  writeFileSync(join(r, "x.txt"), "x"); sh("git", ["add", "x.txt"], r); sh("git", ["commit", "-q", "-m", "x"], r);
  const res = push(cfg(), { cwd: r, holder: "t" });
  assert.equal(res.branch, "feature/x");
  assert.equal(res.remoteHead, headOf(r, "feature/x"));
});

test("push: refusals", () => {
  const r = repoWithRemote();
  assert.throws(() => push(cfg(false), { cwd: r, holder: "t" }), (e) => e.code === "PUSH_DISABLED");
  assert.throws(() => push(cfg(), { cwd: r, holder: "t" }), (e) => e.code === "BRANCH_REFUSED");
  sh("git", ["checkout", "-q", "-b", "feature/y"], r);
  writeFileSync(join(r, "dirty.txt"), "d");
  assert.throws(() => push(cfg(), { cwd: r, holder: "t" }), (e) => e.code === "DIRTY_TREE");
});

test("push: anything but a real true is PUSH_DISABLED", () => {
  const r = repoWithRemote();
  sh("git", ["checkout", "-q", "-b", "feature/z"], r);
  for (const v of ["true", null, 1]) assert.throws(() => push(cfg(v), { cwd: r, holder: "t" }), (e) => e.code === "PUSH_DISABLED", String(v));
});
