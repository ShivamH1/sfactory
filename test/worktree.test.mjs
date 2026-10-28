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

test("worktree cli: a second cut of one job is WORKTREE_EXISTS; the printed line names the lock token", async () => {
  const { root, c } = setup();
  const { main } = await import("../src/cli.mjs");
  const { writeJob: raw, readJob, withJobLock } = await import("../src/store.mjs");
  const writeJob = (c, job) => withJobLock(c, job.id, () => raw(c, job));
  writeJob(c, newJob({ id: "m-1", kind: "milestone", title: "Twice" }));
  const out = [], err = [];
  const io = { cwd: root, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  assert.equal(await main(["worktree", "cut", "m-1"], io), 0, err.join(""));
  const j = readJob(c, "m-1");
  assert.match(out.join(""), new RegExp(`lock token ${j.lockToken}`));
  assert.equal(await main(["worktree", "cut", "m-1", "--slug", "other"], io), 2);
  assert.match(err.join(""), /WORKTREE_EXISTS/);
  assert.equal(branchExists(root, "feature/other"), false);
  assert.equal(readJob(c, "m-1").worktree, j.worktree);
  assert.equal(await main(["worktree", "remove", "m-1", "--force"], io), 0, err.join(""));
  const after = readJob(c, "m-1");
  assert.equal(after.worktree, null);
  assert.equal("lockToken" in after, false);
});

test("worktree cli: a stage change made during the cut survives the write", async () => {
  const { c } = setup();
  const { cutJob } = await import("../src/commands/worktree.mjs");
  const { writeJob: raw, readJob, withJobLock } = await import("../src/store.mjs");
  const writeJob = (c, job) => withJobLock(c, job.id, () => raw(c, job));
  const { transition } = await import("../src/job.mjs");
  writeJob(c, newJob({ id: "m-1", kind: "milestone", title: "Racing" }));
  const afterAdd = () => writeJob(c, transition(readJob(c, "m-1"), "planning", { by: "other-session" }));
  const j = cutJob(c, "m-1", { afterAdd });
  const saved = readJob(c, "m-1");
  assert.equal(saved.stage, "planning");
  assert.equal(saved.history.at(-1).by, "other-session");
  assert.equal(saved.worktree, j.worktree);
  assert.equal(saved.branch, "feature/racing");
  assert.match(saved.lockToken, /^[0-9a-f-]{36}$/);
  assert.equal(status(c, "worktree:racing").holder, "m-1");
  remove(c, saved, { force: true });
});

test("worktree cli: a cut that finds another cut recorded meanwhile undoes itself", async () => {
  const { root, c } = setup();
  const { cutJob } = await import("../src/commands/worktree.mjs");
  const { writeJob: raw, readJob, withJobLock } = await import("../src/store.mjs");
  const writeJob = (c, job) => withJobLock(c, job.id, () => raw(c, job));
  writeJob(c, newJob({ id: "m-1", kind: "milestone", title: "Late" }));
  const afterAdd = () => writeJob(c, { ...readJob(c, "m-1"), worktree: "elsewhere" });
  assert.throws(() => cutJob(c, "m-1", { afterAdd }), (e) => e.code === "WORKTREE_EXISTS");
  assert.equal(readJob(c, "m-1").worktree, "elsewhere");
  assert.equal(existsSync(join(c.worktrees.dir, "late")), false);
  assert.equal(branchExists(root, "feature/late"), false);
  assert.equal(status(c, "worktree:late").held, false);
});

test("worktree: remove by a job that does not hold the lock is NOT_HOLDER and leaves the worktree", () => {
  const { c } = setup();
  const job = cut(c, newJob({ id: "m-1", kind: "milestone", title: "Kept" }), {});
  assert.throws(() => remove(c, { ...job, lockToken: "wrong" }), (e) => e.code === "NOT_HOLDER");
  assert.throws(() => remove(c, { ...job, id: "m-2" }), (e) => e.code === "NOT_HOLDER");
  assert.ok(existsSync(job.worktree));
  assert.ok(worktrees(c.repoRoot).some((w) => w.branch === "feature/kept"));
  assert.equal(status(c, "worktree:kept").holder, "m-1");
  remove(c, job);
  assert.equal(existsSync(job.worktree), false);
});

test("worktree cli: a cut whose job update fails (job vanished) undoes the worktree, branch and lock", async () => {
  const { root, c } = setup();
  const { cutJob } = await import("../src/commands/worktree.mjs");
  const { writeJob: raw, withJobLock } = await import("../src/store.mjs");
  withJobLock(c, "m-1", () => raw(c, newJob({ id: "m-1", kind: "milestone", title: "Vanish" })));
  const { rmSync } = await import("node:fs");
  const afterAdd = () => rmSync(join(c.stateDir, "jobs", "m-1"), { recursive: true, force: true });
  assert.throws(() => cutJob(c, "m-1", { afterAdd }), (e) => e.code === "JOB_NOT_FOUND");
  assert.equal(existsSync(join(c.worktrees.dir, "vanish")), false);
  assert.equal(branchExists(root, "feature/vanish"), false);
  assert.equal(status(c, "worktree:vanish").held, false);
});

test("worktree cli: an undo that cannot remove everything names what is left on stderr, and still removes the rest", async () => {
  const { root, c } = setup();
  const { cutJob } = await import("../src/commands/worktree.mjs");
  const { writeJob: raw, withJobLock } = await import("../src/store.mjs");
  const { rmSync, readdirSync, unlinkSync } = await import("node:fs");
  const { acquireSync } = await import("../src/lock.mjs");
  withJobLock(c, "m-1", () => raw(c, newJob({ id: "m-1", kind: "milestone", title: "Stolen" })));
  const afterAdd = () => {
    const dir = join(c.stateDir, "locks");
    for (const f of readdirSync(dir)) if (f.includes("stolen")) unlinkSync(join(dir, f));
    acquireSync(c, "worktree:stolen", { holder: "thief", durable: true });
    rmSync(join(c.stateDir, "jobs", "m-1"), { recursive: true, force: true });
  };
  const warned = [];
  assert.throws(() => cutJob(c, "m-1", { afterAdd, warn: (m) => warned.push(m) }), (e) => e.code === "JOB_NOT_FOUND");
  assert.equal(existsSync(join(c.worktrees.dir, "stolen")), false);
  assert.equal(branchExists(root, "feature/stolen"), false);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not remove: lock worktree:stolen\n$/);
  assert.equal(status(c, "worktree:stolen").holder, "thief"); // not ours: left alone
});
