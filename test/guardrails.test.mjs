import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, writeConfig, sh } from "./helpers.mjs";
import { push } from "../src/push.mjs";
import { newJob, transition } from "../src/job.mjs";
import { validateConfig, loadConfig } from "../src/config.mjs";
import { allocate } from "../src/ports.mjs";
import { acquire, status } from "../src/lock.mjs";
import { resolveBase } from "../src/worktree.mjs";
import { headOf } from "../src/git.mjs";
import { checkFixCard, globToRegExp } from "../src/fixcard.mjs";
import { parsePlan } from "../src/plan.mjs";
import { main } from "../src/cli.mjs";

const now = "2026-10-27T10:00:00.000Z";

function repoWithRemote() {
  const bare = tmpDir("sf-bare-"); sh("git", ["init", "-q", "--bare", bare], bare);
  const r = tmpRepo(); sh("git", ["remote", "add", "origin", bare], r); sh("git", ["push", "-q", "-u", "origin", "main"], r);
  return { r, bare };
}
const cfg = (over = {}) => ({ stateDir: tmpDir("sf-g-"), git: { push: true, trailers: false }, worktrees: { branchPrefix: "feature/", integrationBranch: null, ...over } });
function commit(r, name, msg) {
  writeFileSync(join(r, name), name); sh("git", ["add", name], r); sh("git", ["commit", "-q", "-m", msg], r);
  return sh("git", ["rev-parse", "HEAD"], r);
}

test("push: a trailer on a branch commit is PUSH_TRAILERS naming the sha, unless git.trailers is true", () => {
  const { r } = repoWithRemote();
  sh("git", ["checkout", "-q", "-b", "feature/t"], r);
  commit(r, "a.txt", "plain");
  const bad = commit(r, "b.txt", "with trailer\n\nCo-Authored-By: Someone <s@example.com>");
  commit(r, "c.txt", "plain again");
  assert.throws(() => push(cfg(), { cwd: r }), (e) => e.code === "PUSH_TRAILERS" && e.message.includes(bad) && e.message.includes("Co-Authored-By"));
  assert.equal(sh("git", ["ls-remote", "--heads", "origin", "feature/t"], r), "", "nothing was pushed");
  const c = cfg(); c.git.trailers = true;
  assert.equal(push(c, { cwd: r }).branch, "feature/t");
});

test("push: a trailer already on the integration branch is not counted; the scan starts at the merge base", () => {
  const { r } = repoWithRemote();
  commit(r, "i.txt", "old\n\nSigned-off-by: A <a@example.com>");
  sh("git", ["push", "-q", "origin", "main"], r);
  sh("git", ["checkout", "-q", "-b", "feature/n"], r);
  commit(r, "n.txt", "clean");
  assert.equal(push(cfg({ integrationBranch: "main" }), { cwd: r }).branch, "feature/n");
});

test("push: main, master and the integration branch are BRANCH_REFUSED even under a matching prefix", () => {
  const { r } = repoWithRemote();
  assert.throws(() => push(cfg({ branchPrefix: "ma" }), { cwd: r }), (e) => e.code === "BRANCH_REFUSED" && /protected/.test(e.message));
  sh("git", ["checkout", "-q", "-b", "master"], r);
  assert.throws(() => push(cfg({ branchPrefix: "ma" }), { cwd: r }), (e) => e.code === "BRANCH_REFUSED" && /protected/.test(e.message));
  sh("git", ["checkout", "-q", "-b", "feature/int"], r);
  assert.throws(() => push(cfg({ integrationBranch: "feature/int" }), { cwd: r }), (e) => e.code === "BRANCH_REFUSED" && /protected/.test(e.message));
});

test("config: branchPrefix must end in /", () => {
  const base = { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } };
  assert.deepEqual(validateConfig({ ...base, worktrees: { branchPrefix: "feature/" } }), []);
  for (const v of ["feature", "", 3]) assert.ok(validateConfig({ ...base, worktrees: { branchPrefix: v } }).some((m) => m.includes("branchPrefix")), String(v));
  assert.deepEqual(validateConfig(base), []);
});

test("job: the fix-round cap refuses the transition into fixing when limits are given", () => {
  let j = newJob({ id: "m-1", kind: "milestone", title: "t", now });
  for (const to of ["planning", "awaiting-approval", "building", "reviewing"]) j = transition(j, to, { now });
  const limits = { fixRounds: 2 };
  for (let i = 0; i < 2; i++) { j = transition(j, "fixing", { now, limits }); j = transition(j, "reviewing", { now, limits }); }
  assert.equal(j.round, 2);
  assert.throws(() => transition(j, "fixing", { now, limits }), (e) => e.code === "FIX_ROUNDS_EXHAUSTED" && /2 of 2/.test(e.message));
  assert.equal(transition(j, "fixing", { now }).round, 3, "no limits: the old behaviour");
  assert.equal(transition(j, "verifying", { now, limits }).stage, "verifying");
});

test("ports: allocate waits for the ports lock and releases it", async () => {
  const c = { stateDir: tmpDir("sf-pl-"), ports: { base: 47600, step: 10, names: ["api"] } };
  const held = await acquire(c, "ports", { holder: "other", durable: true });
  let done = false;
  const p = allocate(c, "m-1").then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(done, false, "blocked behind the held lock");
  held.release();
  const ports = await p;
  assert.equal(ports.api, 47600);
  assert.equal(status(c, "ports").held, false);
});

test("worktree: resolveBase fetches origin first, skips with fetch:false, warns and carries on when the fetch fails", () => {
  const { r, bare } = repoWithRemote();
  const other = tmpDir("sf-other-"); sh("git", ["clone", "-q", "-b", "main", bare, other], other);
  sh("git", ["config", "user.email", "t@example.com"], other); sh("git", ["config", "user.name", "t"], other);
  const moved = commit(other, "m.txt", "moved"); sh("git", ["push", "-q", "origin", "main"], other);
  const c = { repoRoot: r, worktrees: { baseRule: "integration-branch", integrationBranch: "main", branchPrefix: "feature/" } };
  const before = headOf(r, "origin/main");
  resolveBase(c, { fetch: false });
  assert.equal(headOf(r, "origin/main"), before);
  resolveBase(c);
  assert.equal(headOf(r, "origin/main"), moved);

  sh("git", ["remote", "set-url", "origin", join(bare, "nope")], r);
  const writes = []; const orig = process.stderr.write;
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try { assert.equal(resolveBase(c).branch, "main"); } finally { process.stderr.write = orig; }
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^warning: git fetch origin failed/);
});

test("fixcard: ** is any depth, * one segment, otherwise exact", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b.ts"));
  assert.ok(globToRegExp("**/*.sql").test("db/m/x.sql"));
  assert.ok(globToRegExp("**/*.sql").test("x.sql"));
  assert.ok(globToRegExp("db/*.sql").test("db/x.sql"));
  assert.ok(!globToRegExp("db/*.sql").test("db/m/x.sql"));
  assert.ok(globToRegExp("package.json").test("package.json"));
  assert.ok(!globToRegExp("package.json").test("packageXjson"));
});

const PLAN = [
  "## Task 1: a", "", "**Files:** modify `src/api/a.ts`, create `db/migrations/001.sql`", "",
  "## Task 2: b", "", "**Files:** modify `README.md`", "",
].join("\n");

test("fixcard: checkFixCard names each hit, and the CLI exits 1 on one", async () => {
  const plan = parsePlan(PLAN);
  const c = { fixCardRefusals: ["**/*.sql", "src/api/**"] };
  const r = checkFixCard(c, plan);
  assert.equal(r.ok, false);
  assert.deepEqual(r.hits, [{ file: "src/api/a.ts", pattern: "src/api/**" }, { file: "db/migrations/001.sql", pattern: "**/*.sql" }]);
  assert.deepEqual(checkFixCard({ fixCardRefusals: [] }, plan), { ok: true, hits: [] });

  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: tmpDir("sf-fc-"), fixCardRefusals: ["**/*.sql"] });
  writeFileSync(join(root, "plan.md"), PLAN);
  let out = "";
  const code = await main(["fixcard", "plan.md"], { cwd: root, stdout: (s) => { out += s; } });
  assert.equal(code, 1);
  assert.match(out, /db\/migrations\/001\.sql/);
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: tmpDir("sf-fc-") });
  assert.equal(await main(["fixcard", "plan.md"], { cwd: root, stdout: () => {} }), 0);
  assert.equal(loadConfig(root).fixCardRefusals.length, 0);
});
