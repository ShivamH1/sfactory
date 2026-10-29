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
import { resolveBase, cut } from "../src/worktree.mjs";
import { headOf } from "../src/git.mjs";
import { checkFixCard, globToRegExp } from "../src/fixcard.mjs";
import { parsePlan } from "../src/plan.mjs";
import { main } from "../src/cli.mjs";

const now = "2026-10-27T10:00:00.000Z";

function repoWithRemote() {
  const bare = tmpDir("sf-bare-"); sh("git", ["init", "-q", "--bare", bare], bare);
  const root = tmpRepo(); sh("git", ["remote", "add", "origin", bare], root); sh("git", ["push", "-q", "-u", "origin", "main"], root);
  // I3: push works only in a registered worktree under worktrees.dir, so the main checkout steps off main (detached)
  // and r is a worktree on main; cfg() carries repoRoot and worktrees.dir.
  sh("git", ["checkout", "-q", "--detach"], root);
  const dir = tmpDir("sf-pw-"); const r = join(dir, "card");
  sh("git", ["worktree", "add", "-q", r, "main"], root);
  ctx = { repoRoot: root, dir };
  return { r, bare };
}
let ctx = {};
const cfg = (over = {}) => ({ stateDir: tmpDir("sf-g-"), git: { push: true, trailers: false }, repoRoot: ctx.repoRoot, worktrees: { branchPrefix: "feature/", integrationBranch: null, dir: ctx.dir, ...over } });
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

// ---- fix round 1 ----
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readJob, writeJob as rawWriteJob, withJobLock } from "../src/store.mjs";
const writeJob = (c, job) => withJobLock(c, job.id, () => rawWriteJob(c, job));
import { integration } from "../src/worktree.mjs";

test("ports: two concurrent allocations in separate processes get distinct blocks, persisted under the lock", async () => {
  const c = { stateDir: tmpDir("sf-race-"), ports: { base: 47600, step: 10, names: ["api", "web"] } };
  for (const id of ["m-1", "m-2"]) writeJob(c, { id, kind: "milestone", title: id, stage: "building", started: `2026-01-01T00:00:0${id.slice(-1)}Z`, history: [] });
  const src = pathToFileURL(join(process.cwd(), "src")).href;
  const code = `const {allocate}=await import(${JSON.stringify(src + "/ports.mjs")});const {readJob,writeJob,withJobLock}=await import(${JSON.stringify(src + "/store.mjs")});
const c=JSON.parse(process.argv[1]),id=process.argv[2];
const p=await allocate(c,id,async(ports)=>{await new Promise(r=>setTimeout(r,500));withJobLock(c,id,()=>writeJob(c,{...readJob(c,id),ports}));});
console.log(p.block);`;
  const run = (id) => new Promise((res, rej) => {
    const ch = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(c), id]);
    let out = "", err = ""; ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (err += d));
    ch.on("close", (st) => (st === 0 ? res(Number(out.trim())) : rej(new Error(err))));
  });
  const [a, b] = await Promise.all([run("m-1"), run("m-2")]);
  assert.notEqual(a, b);
  assert.equal(readJob(c, "m-1").ports.block, a);
  assert.equal(readJob(c, "m-2").ports.block, b);
});

test("worktree: after the fetch a local base that lags its remote is based on origin's head; a diverged one stays local with one warning", () => {
  const { r, bare } = repoWithRemote();
  const other = tmpDir("sf-other-"); sh("git", ["clone", "-q", "-b", "main", bare, other], other);
  sh("git", ["config", "user.email", "t@example.com"], other); sh("git", ["config", "user.name", "t"], other);
  const moved = commit(other, "m.txt", "moved"); sh("git", ["push", "-q", "origin", "main"], other);
  const c = { repoRoot: r, worktrees: { baseRule: "integration-branch", integrationBranch: "main", branchPrefix: "feature/" } };
  const old = headOf(r, "main");
  assert.notEqual(old, moved);
  assert.equal(resolveBase(c).head, moved);
  // diverge: a local commit on main, and another on origin
  const local = commit(r, "l.txt", "local");
  const moved2 = commit(other, "m2.txt", "moved2"); sh("git", ["push", "-q", "origin", "main"], other);
  const writes = []; const orig = process.stderr.write;
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try { assert.equal(resolveBase(c).head, local); } finally { process.stderr.write = orig; }
  assert.notEqual(local, moved2);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /diverged/);
});

test("worktree: a failed fetch warning is one line with URL credentials redacted", () => {
  const { r } = repoWithRemote();
  sh("git", ["remote", "set-url", "origin", "https://user:s3cret@127.0.0.1:9/nope.git"], r);
  const c = { repoRoot: r, worktrees: { baseRule: "integration-branch", integrationBranch: "main", branchPrefix: "feature/" } };
  const writes = []; const orig = process.stderr.write;
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try { resolveBase(c); } finally { process.stderr.write = orig; }
  assert.equal(writes.length, 1);
  assert.equal(writes[0].trimEnd().split("\n").length, 1);
  assert.ok(!writes[0].includes("s3cret"), writes[0]);
});

test("push: trailer scan ranges from the same integration branch worktree uses; no merge base scans only commits on no remote", () => {
  const { r } = repoWithRemote();
  // development carries a trailer commit that is not on main
  sh("git", ["checkout", "-q", "-b", "development"], r);
  commit(r, "d.txt", "dev work\n\nCo-Authored-By: Someone <s@example.com>");
  sh("git", ["push", "-q", "origin", "development"], r);
  sh("git", ["checkout", "-q", "-b", "feature/dv"], r);
  commit(r, "f.txt", "clean");
  const c = cfg();
  assert.equal(integration({ repoRoot: r, worktrees: { integrationBranch: null } }), "development");
  assert.equal(push(c, { cwd: r }).branch, "feature/dv");
});

test("push: with no merge base the scan covers commits on no remote, never the root", () => {
  const { r } = repoWithRemote();
  sh("git", ["checkout", "-q", "--orphan", "feature/orph"], r);
  sh("git", ["rm", "-rfq", "."], r);
  commit(r, "o.txt", "orphan root\n\nCo-Authored-By: Someone <s@example.com>");
  sh("git", ["push", "-q", "origin", "feature/orph"], r);
  sh("git", ["checkout", "-q", "-b", "feature/orph2"], r);
  commit(r, "o2.txt", "clean");
  assert.equal(push(cfg(), { cwd: r }).branch, "feature/orph2");
});

test("worktree: oneLine keeps the first line only and redacts URL credentials", async () => {
  const { oneLine } = await import("../src/worktree.mjs");
  const out = oneLine("fatal: unable to access 'https://user:pa55@host.example/r.git/': boom\nsecond line https://u:p@h/");
  assert.equal(out, "fatal: unable to access 'https://***@host.example/r.git/': boom");
  assert.ok(!out.includes("pa55") && !out.includes("\n"));
});

test("round 2: integration branch known only as origin/development (no local one) is development for push and resolveBase", () => {
  const { r } = repoWithRemote();
  sh("git", ["checkout", "-q", "-b", "development"], r);
  commit(r, "d.txt", "dev work\n\nCo-Authored-By: Someone <s@example.com>");
  sh("git", ["push", "-q", "origin", "development"], r);
  sh("git", ["checkout", "-q", "-b", "feature/dv2"], r);
  commit(r, "f.txt", "clean");
  sh("git", ["branch", "-D", "development"], r);
  const c = cfg();
  assert.equal(integration({ repoRoot: r, worktrees: { integrationBranch: null } }), "development");
  assert.equal(push(c, { cwd: r }).branch, "feature/dv2");
  const rb = resolveBase({ repoRoot: r, worktrees: { baseRule: "integration-branch", integrationBranch: null, branchPrefix: "feature/" } }, { fetch: false });
  assert.equal(rb.ref, "origin/development");
});

test("round 2: cut with a local base lagging origin succeeds and is based on origin's head", () => {
  const { r, bare } = repoWithRemote();
  const other = tmpDir("sf-other-"); sh("git", ["clone", "-q", "-b", "main", bare, other], other);
  sh("git", ["config", "user.email", "t@example.com"], other); sh("git", ["config", "user.name", "t"], other);
  const moved = commit(other, "m.txt", "moved"); sh("git", ["push", "-q", "origin", "main"], other);
  const wt = tmpDir("sf-wt-");
  const c = { repoRoot: r, stateDir: tmpDir("sf-g-"), limits: { lockStaleMs: 1000 }, worktrees: { baseRule: "integration-branch", integrationBranch: "main", branchPrefix: "feature/", dir: wt, copyFromBase: [], afterCut: [] } };
  const job = cut(c, newJob({ id: "m-1", kind: "milestone", title: "Lagging" }), {});
  assert.equal(sh("git", ["rev-parse", "HEAD"], job.worktree), moved);
});

test("round 2: push protects a derived integration branch (integrationBranch null)", () => {
  const { r } = repoWithRemote();
  sh("git", ["checkout", "-q", "-b", "development"], r);
  sh("git", ["push", "-q", "origin", "development"], r);
  const c = cfg();
  c.worktrees.branchPrefix = "dev";
  assert.throws(() => push(c, { cwd: r }), (e) => e.code === "BRANCH_REFUSED" && /protected/.test(e.message));
});

test("round 2: a fetch that outlives its timeout is killed with its children; the environment forbids prompts", async () => {
  const { fetchOrigin } = await import("../src/worktree.mjs");
  const { readFileSync, existsSync } = await import("node:fs");
  const d = tmpDir("sf-ssh-");
  const pidFile = join(d, "pid"), envFile = join(d, "env");
  writeFileSync(join(d, "slow.mjs"), `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(pidFile)},String(process.pid));writeFileSync(${JSON.stringify(envFile)},String(process.env.GCM_INTERACTIVE)+","+process.env.GIT_TERMINAL_PROMPT);setTimeout(()=>{},60000);`);
  const r = tmpRepo();
  sh("git", ["remote", "add", "origin", "ssh://example.invalid/x.git"], r);
  const old = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = `"${process.execPath}" "${join(d, "slow.mjs")}"`;
  let res;
  try { res = fetchOrigin(r, { timeoutMs: 4000 }); } finally { if (old === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = old; }
  assert.equal(res.status, 124);
  assert.match(res.stderr, /timed out/);
  assert.equal(readFileSync(envFile, "utf8"), "never,0");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((r2) => setTimeout(r2, 500));
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, "the ssh child is gone");
});

test("round 3: fetch leaves the ssh command to the repo core.sshCommand (and GIT_SSH)", async () => {
  const { fetchOrigin } = await import("../src/worktree.mjs");
  const { existsSync } = await import("node:fs");
  const d = tmpDir("sf-cfgssh-");
  const marker = join(d, "ran");
  writeFileSync(join(d, "mark.mjs"), `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(marker)},"x");`);
  const r = tmpRepo();
  sh("git", ["remote", "add", "origin", "ssh://example.invalid/x.git"], r);
  const fwd = (p) => p.split("\\").join("/");
  sh("git", ["config", "core.sshCommand", `"${fwd(process.execPath)}" "${fwd(join(d, "mark.mjs"))}"`], r);
  const old = process.env.GIT_SSH_COMMAND, oldSsh = process.env.GIT_SSH;
  delete process.env.GIT_SSH_COMMAND; delete process.env.GIT_SSH;
  try { fetchOrigin(r, { timeoutMs: 20000 }); } finally { if (old !== undefined) process.env.GIT_SSH_COMMAND = old; if (oldSsh !== undefined) process.env.GIT_SSH = oldSsh; }
  assert.equal(existsSync(marker), true, "core.sshCommand ran");
});

test("round 4: GIT_SSH set leaves GIT_SSH_COMMAND unset; with no ssh setting at all the fetch gets BatchMode", async () => {
  const { fetchEnv } = await import("../src/worktree.mjs");
  const r = tmpRepo();
  const emptyGlobal = join(tmpDir("sf-gcfg-"), "gitconfig");
  writeFileSync(emptyGlobal, "");
  const base = { ...process.env, GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1" };
  delete base.GIT_SSH_COMMAND; delete base.GIT_SSH;
  const withSsh = fetchEnv(r, { ...base, GIT_SSH: "plink" });
  assert.equal("GIT_SSH_COMMAND" in withSsh, false, "GIT_SSH is the user's choice; no GIT_SSH_COMMAND to outrank it");
  assert.equal(withSsh.GIT_SSH, "plink");
  assert.equal(withSsh.GIT_TERMINAL_PROMPT, "0");
  assert.equal(fetchEnv(r, base).GIT_SSH_COMMAND, "ssh -o BatchMode=yes");
});
