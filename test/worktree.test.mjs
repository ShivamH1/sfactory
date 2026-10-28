import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
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

test("worktree: a cut whose worktree folder vanished mid-way still deletes its branch (git worktree prune first)", () => {
  const { root, c } = setup();
  const dir = join(c.worktrees.dir, "vanish");
  const afterAdd = () => { rmSync(dir, { recursive: true, force: true }); throw new Error("boom"); };
  assert.throws(() => cut(c, newJob({ id: "m-1", kind: "milestone", title: "Vanish" }), { afterAdd }), /boom/);
  assert.equal(branchExists(root, "feature/vanish"), false);
  assert.equal(worktrees(root).some((w) => w.branch === "feature/vanish"), false);
});

test("worktree: the cut rollback prunes before deleting the branch, and only when the worktree was added", async () => {
  const { git } = await import("../src/git.mjs");
  // 1. The folder vanished and `worktree remove` fails (stubbed): only the prune frees the branch for -D.
  const { root, c } = setup();
  const calls = [];
  const gitRun = (args, opts) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[0] === "worktree" && args[1] === "remove") throw new Error("remove failed (stub)");
    return git(args, opts);
  };
  const dir = join(c.worktrees.dir, "stubbed");
  const afterAdd = () => { rmSync(dir, { recursive: true, force: true }); throw new Error("boom"); };
  assert.throws(() => cut(c, newJob({ id: "m-1", kind: "milestone", title: "Stubbed" }), { afterAdd, gitRun }), /boom/);
  const prune = calls.indexOf("worktree prune"), del = calls.indexOf("branch -D");
  assert.ok(prune >= 0 && del > prune, `prune before branch -D: ${calls.join(" | ")}`);
  assert.equal(branchExists(root, "feature/stubbed"), false);
  // 2. The add itself failed: nothing was added, so nothing is pruned.
  const s2 = setup();
  const calls2 = [];
  const failAdd = (args, opts) => {
    calls2.push(args.slice(0, 2).join(" "));
    if (args[0] === "worktree" && args[1] === "add") throw new Error("add failed (stub)");
    return git(args, opts);
  };
  assert.throws(() => cut(s2.c, newJob({ id: "m-2", kind: "milestone", title: "No add" }), { gitRun: failAdd }), /add failed/);
  assert.equal(calls2.includes("worktree prune"), false, `no prune without an add: ${calls2.join(" | ")}`);
  assert.equal(status(s2.c, "worktree:no-add").held, false);
});

test("worktree cli: a cut whose job update fails after its worktree folder vanished still deletes its branch (prune before branch -D)", async () => {
  const { root, c } = setup();
  const { cutJob } = await import("../src/commands/worktree.mjs");
  const { writeJob: raw, withJobLock } = await import("../src/store.mjs");
  withJobLock(c, "m-1", () => raw(c, newJob({ id: "m-1", kind: "milestone", title: "Gone" })));
  const afterAdd = () => {
    rmSync(join(c.worktrees.dir, "gone"), { recursive: true, force: true }); // the folder is gone, git still lists the worktree
    rmSync(join(c.stateDir, "jobs", "m-1"), { recursive: true, force: true });
  };
  const warned = [];
  assert.throws(() => cutJob(c, "m-1", { afterAdd, warn: (m) => warned.push(m) }), (e) => e.code === "JOB_NOT_FOUND");
  assert.equal(branchExists(root, "feature/gone"), false, "the branch is deleted");
  assert.ok(!worktrees(root).some((w) => w.branch === "feature/gone"), "the stale worktree entry is pruned");
  assert.equal(status(c, "worktree:gone").held, false);
  assert.deepEqual(warned, []);
});

/** A repo whose record is the spec-tree style, with briefs 1, 7 and a 19.1 carried-forward list committed on main. */
function specTree() {
  const root = tmpRepo();
  for (const d of ["spec/modules", "spec/plans", "spec/decisions"]) mkdirSync(join(root, d), { recursive: true });
  for (const f of ["spec/modules/1-start.md", "spec/modules/7-wallet.md", "spec/modules/19.1-CARRIED-FORWARD.md", "spec/decisions/7-wallet.md", "spec/decisions/3-a.md", "spec/decisions/3-b.md"]) writeFileSync(join(root, f), "x\n");
  sh("git", ["add", "spec"], root); sh("git", ["commit", "-q", "-m", "spec"], root);
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: tmpDir("sf-st-"), worktrees: { dir: tmpDir("sf-wt-") },
    record: { style: "spec-tree", brief: "spec/modules/{n}-{slug}.md", plan: "spec/plans/{n}-{slug}.md", log: "spec/decisions/{n}-{slug}.md", stories: "spec/product/STORIES_*.md", numbering: "next-milestone-number" } });
  return { root, c: loadConfig(root) };
}

test("worktree cli: the cut resolves job.record - default docs-folder paths by id", async () => {
  const { c } = setup();
  const { cutJob } = await import("../src/commands/worktree.mjs");
  const { addJob } = await import("../src/store.mjs");
  addJob(c, "milestone", "Docs card");
  const j = cutJob(c, "m-1", { fetch: false });
  assert.deepEqual(j.record, { brief: "docs/sfactory/m-1/brief.md", plan: "docs/sfactory/m-1/plan.md", log: "docs/sfactory/m-1/log.md", stories: null, n: 1 });
  remove(c, j, { force: true });
});

test("worktree cli: spec-tree numbering takes the next number after the briefs and every unmerged card's record", async () => {
  const { c } = specTree();
  const { cutJob } = await import("../src/commands/worktree.mjs");
  const { addJob, readJob, writeJob, withJobLock } = await import("../src/store.mjs");
  addJob(c, "milestone", "Rewards"); addJob(c, "milestone", "Badges");
  const a = cutJob(c, "m-1", { fetch: false });
  assert.deepEqual(a.record, { brief: "spec/modules/8-rewards.md", plan: "spec/plans/8-rewards.md", log: "spec/decisions/8-rewards.md", stories: "spec/product/STORIES_*.md", n: 8 });
  const b = cutJob(c, "m-2", { fetch: false });
  assert.equal(b.record.n, 9, "m-1's 8 is taken while it is unmerged");
  assert.equal(b.record.brief, "spec/modules/9-badges.md");
  // A merged card's number no longer counts beyond the briefs in the tree.
  withJobLock(c, "m-1", () => writeJob(c, { ...readJob(c, "m-1"), stage: "merged" }));
  addJob(c, "milestone", "Later");
  const l = cutJob(c, "m-3", { fetch: false });
  assert.equal(l.record.n, 10, "m-2's 9 still counts");
  for (const j of [a, b, l]) remove(c, readJob(c, j.id), { force: true });
});

test("worktree cli: a fix with --log finds its one log file; none or two is LOG_NOT_FOUND and the cut is undone", async () => {
  const { root, c } = specTree();
  const { cutJob } = await import("../src/commands/worktree.mjs");
  const { readJob } = await import("../src/store.mjs");
  const { actions } = await import("../src/job-actions.mjs");
  actions.add(c, { kind: "fix", title: "Wallet rounding", logOf: "7" });
  const f = cutJob(c, "f-1", { fetch: false });
  assert.equal(f.record.log, "spec/decisions/7-wallet.md");
  assert.equal(f.record.n, 7);
  actions.add(c, { kind: "fix", title: "Nothing there", logOf: "5" });
  assert.throws(() => cutJob(c, "f-2", { fetch: false }), (e) => e.code === "LOG_NOT_FOUND");
  actions.add(c, { kind: "fix", title: "Two logs", logOf: "3" });
  assert.throws(() => cutJob(c, "f-3", { fetch: false }), (e) => e.code === "LOG_NOT_FOUND" && /3-a\.md/.test(e.message));
  for (const [id, slug] of [["f-2", "nothing-there"], ["f-3", "two-logs"]]) {
    assert.equal(readJob(c, id).worktree, null); assert.equal(branchExists(root, `feature/${slug}`), false);
  }
  remove(c, readJob(c, "f-1"), { force: true });
});

test("worktree cli: cut --base-of cuts from the partner's recorded base, only for an approved parallel card with an active partner", async () => {
  const { root, c } = setup();
  const { main } = await import("../src/cli.mjs");
  const { addJob, readJob, writeJob, withJobLock } = await import("../src/store.mjs");
  const patch = (id, f) => withJobLock(c, id, () => writeJob(c, { ...readJob(c, id), ...f }));
  const io = () => { const out = [], err = []; return { o: { cwd: root, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, out, err }; };
  addJob(c, "milestone", "Alpha"); addJob(c, "milestone", "Beta"); addJob(c, "milestone", "Gamma");
  let r = io();
  assert.equal(await main(["worktree", "cut", "m-1", "--no-fetch"], r.o), 0, r.err.join(""));
  const a = readJob(c, "m-1");
  writeFileSync(join(root, "later.txt"), "x\n"); sh("git", ["add", "later.txt"], root); sh("git", ["commit", "-q", "-m", "later"], root);
  assert.notEqual(sh("git", ["rev-parse", "main"], root), a.base.head, "main moved after the partner's cut");
  // m-2 is not parallel-approved yet.
  r = io();
  assert.equal(await main(["worktree", "cut", "m-2", "--base-of", "m-1", "--no-fetch"], r.o), 2);
  assert.match(r.err.join(""), /NOT_PARALLEL/);
  patch("m-2", { parallel: "approved", stage: "planning" });
  r = io();
  assert.equal(await main(["worktree", "cut", "m-2", "--base-of", "m-1", "--no-fetch"], r.o), 0, r.err.join(""));
  const b = readJob(c, "m-2");
  assert.deepEqual({ branch: b.base.branch, head: b.base.head }, { branch: a.base.branch, head: a.base.head });
  assert.equal(sh("git", ["rev-parse", "HEAD"], b.worktree), a.base.head);
  // A stopped partner, or one with no worktree, is not active.
  patch("m-3", { parallel: "approved" });
  patch("m-1", { stage: "stopped" });
  r = io();
  assert.equal(await main(["worktree", "cut", "m-3", "--base-of", "m-1", "--no-fetch"], r.o), 2);
  assert.match(r.err.join(""), /PARTNER_NOT_ACTIVE/);
  r = io();
  assert.equal(await main(["worktree", "cut", "m-3", "--base-of", "m-3", "--no-fetch"], r.o), 2);
  assert.match(r.err.join(""), /BAD_ARGS/);
  assert.equal(readJob(c, "m-3").worktree, null);
  for (const id of ["m-1", "m-2"]) remove(c, readJob(c, id), { force: true });
});
