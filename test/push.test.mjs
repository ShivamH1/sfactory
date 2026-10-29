import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, sh } from "./helpers.mjs";
import { push } from "../src/push.mjs";
import { headOf } from "../src/git.mjs";

function repoWithRemote() {
  const bare = tmpDir("sf-bare-"); sh("git", ["init", "-q", "--bare", bare], bare);
  const root = tmpRepo(); sh("git", ["remote", "add", "origin", bare], root); sh("git", ["push", "-q", "-u", "origin", "main"], root);
  // I3: push works only in a registered worktree under worktrees.dir, so the main checkout steps off main (detached)
  // and r is a worktree on main; cfg() carries repoRoot and worktrees.dir.
  sh("git", ["checkout", "-q", "--detach"], root);
  const dir = tmpDir("sf-pw-"); const r = join(dir, "card");
  sh("git", ["worktree", "add", "-q", r, "main"], root);
  ctx = { repoRoot: root, dir };
  return r;
}
let ctx = {};
const cfg = (push = true) => ({ stateDir: tmpDir("sf-p-"), git: { push }, repoRoot: ctx.repoRoot, worktrees: { branchPrefix: "feature/", dir: ctx.dir } });

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

test("I3: push refuses the main checkout and a worktree outside worktrees.dir (MAIN_CHECKOUT)", () => {
  const r = repoWithRemote();
  const root = ctx.repoRoot;
  sh("git", ["checkout", "-q", "-b", "feature/m"], root);
  assert.throws(() => push(cfg(), { cwd: root }), (e) => e.code === "MAIN_CHECKOUT" && /main checkout/.test(e.message));
  const stray = join(tmpDir("sf-ps-"), "stray");
  sh("git", ["worktree", "add", "-q", "-b", "feature/stray", stray], root);
  assert.throws(() => push(cfg(), { cwd: stray }), (e) => e.code === "MAIN_CHECKOUT" && /not a card's worktree/.test(e.message));
  sh("git", ["checkout", "-q", "-b", "feature/ok"], r);
  assert.equal(push(cfg(), { cwd: r }).branch, "feature/ok");
});
