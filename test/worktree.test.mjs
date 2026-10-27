import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, writeConfig, sh } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { newJob } from "../src/job.mjs";
import { resolveBase, cut, remove } from "../src/worktree.mjs";
import { status } from "../src/lock.mjs";
import { worktrees, branchExists } from "../src/git.mjs";

function setup(extra = {}) {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: tmpDir("sf-st-"), worktrees: { dir: tmpDir("sf-wt-"), ...extra } });
  return { root, c: loadConfig(root) };
}

test("worktree: resolveBase by rule", () => {
  const { root, c } = setup();
  assert.deepEqual(resolveBase(c).branch, "main");
  sh("git", ["branch", "feature/one"], root);
  const c2 = loadConfig(root); c2.worktrees.baseRule = "newest-feature-branch";
  assert.equal(resolveBase(c2).branch, "feature/one");
  const c3 = loadConfig(root); c3.worktrees.baseRule = "main";
  assert.equal(resolveBase(c3).branch, "main");
});

test("worktree: cut creates the worktree and branch, records base, runs afterCut, copies files, locks; remove undoes it", () => {
  const { root, c } = setup({ afterCut: ["node -e \"require('fs').writeFileSync('after.txt','ran')\""], copyFromBase: [".env"] });
  writeFileSync(join(root, ".env"), "SECRET=1\n");   // untracked in the base's worktree (the main checkout)
  const job = cut(c, newJob({ id: "m-1", kind: "milestone", title: "Feed moderation" }), {});
  assert.equal(job.branch, "feature/feed-moderation");
  assert.equal(job.worktree, join(c.worktrees.dir, "feed-moderation"));
  assert.ok(existsSync(join(job.worktree, "README.md")));
  assert.equal(readFileSync(join(job.worktree, "after.txt"), "utf8"), "ran");
  assert.equal(readFileSync(join(job.worktree, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(job.base.branch, "main");
  assert.match(job.base.head, /^[0-9a-f]{40}$/);
  assert.equal(status(c, "worktree:feed-moderation").holder, "m-1");
  assert.ok(worktrees(root).some((w) => w.branch === "feature/feed-moderation"));
  remove(c, job, { force: true }); // after.txt and .env are untracked
  assert.equal(existsSync(job.worktree), false);
  assert.equal(status(c, "worktree:feed-moderation").held, false);
});

test("worktree: refuses the main checkout and a foreign lock", async () => {
  const { root, c } = setup();
  c.worktrees.dir = root;
  assert.throws(() => cut(c, newJob({ id: "m-1", kind: "milestone", title: "x" }), { slug: "" }), (e) => e.code === "WORKTREE_IS_MAIN_CHECKOUT");
  const { c: c2 } = setup();
  const { acquire } = await import("../src/lock.mjs");
  const l = await acquire(c2, "worktree:x", { holder: "someone-else" });
  assert.throws(() => cut(c2, newJob({ id: "m-2", kind: "milestone", title: "x" }), {}), (e) => e.code === "WORKTREE_LOCKED" && /someone-else/.test(e.message));
  l.release();
});

test("worktree: a failed afterCut rolls back worktree, branch and lock", () => {
  const { root, c } = setup({ afterCut: ["node -e \"process.exit(3)\""] });
  assert.throws(() => cut(c, newJob({ id: "m-1", kind: "milestone", title: "Rollback me" }), {}), (e) => e.code === "AFTER_CUT_FAILED");
  assert.equal(existsSync(join(c.worktrees.dir, "rollback-me")), false);
  assert.equal(branchExists(root, "feature/rollback-me"), false);
  assert.equal(status(c, "worktree:rollback-me").held, false);
});

test("worktree: BASE_MOVED rolls back completely", () => {
  const { root, c } = setup();
  const afterAdd = () => { writeFileSync(join(root, "moved.txt"), "m"); sh("git", ["add", "moved.txt"], root); sh("git", ["commit", "-q", "-m", "move"], root); };
  assert.throws(() => cut(c, newJob({ id: "m-1", kind: "milestone", title: "Moved" }), { afterAdd }), (e) => e.code === "BASE_MOVED");
  assert.equal(existsSync(join(c.worktrees.dir, "moved")), false);
  assert.equal(branchExists(root, "feature/moved"), false);
  assert.equal(status(c, "worktree:moved").held, false);
});

test("worktree: remove refuses a dirty worktree unless forced", () => {
  const { c } = setup();
  const job = cut(c, newJob({ id: "m-1", kind: "milestone", title: "Dirty" }), {});
  writeFileSync(join(job.worktree, "wip.txt"), "x");
  assert.throws(() => remove(c, job), (e) => e.code === "DIRTY_WORKTREE");
  assert.ok(existsSync(job.worktree));
  const out = remove(c, job, { force: true });
  assert.equal(existsSync(job.worktree), false);
  assert.equal(out.worktree, null);
  assert.equal(status(c, "worktree:dirty").held, false);
});

test("worktree: --slug is sanitised and an empty one refused", () => {
  const { c } = setup();
  const job = cut(c, newJob({ id: "m-1", kind: "milestone", title: "t" }), { slug: "My Slug!" });
  assert.equal(job.slug, "my-slug");
  remove(c, job);
  assert.throws(() => cut(c, newJob({ id: "m-2", kind: "milestone", title: "t" }), { slug: "!!!" }), (e) => e.code === "BAD_ARGS");
});
