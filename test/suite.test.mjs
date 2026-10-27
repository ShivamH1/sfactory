import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, tmpRepo, writeConfig } from "./helpers.mjs";
import { existsSync, readdirSync } from "node:fs";
import { main } from "../src/cli.mjs";
import { findRepoRoot, loadConfig } from "../src/config.mjs";
import { jobDir, writeJob } from "../src/store.mjs";
import { newJob } from "../src/job.mjs";
import { runSuite } from "../src/suite.mjs";
import { acquire } from "../src/lock.mjs";

const cfg = (suite) => ({ stateDir: tmpDir("sf-s-"), commands: { suite, suiteSerial: true }, limits: { suiteWaitMs: 300, lockStaleMs: 60_000 } });

test("suite: green run logs and returns ok", async () => {
  const c = cfg('node -e "console.log(\'12 passing\')"');
  const log = join(tmpDir(), "suite.log");
  const r = await runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: log });
  assert.equal(r.ok, true); assert.equal(r.code, 0);
  assert.match(readFileSync(log, "utf8"), /=== .* node -e/); assert.match(r.tail, /12 passing/);
});

test("suite: red run returns ok=false with the exit code, no throw", async () => {
  const c = cfg('node -e "console.error(\'1 failing\'); process.exit(1)"');
  const r = await runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: join(tmpDir(), "s.log") });
  assert.equal(r.ok, false); assert.equal(r.code, 1); assert.match(r.tail, /1 failing/);
});

test("suite: waits for the lock and gives up with LOCK_HELD", async () => {
  const c = cfg("node -e 0");
  const l = await acquire(c, "suite", { holder: "other" });
  await assert.rejects(runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: join(tmpDir(), "s.log") }), (e) => e.code === "LOCK_HELD");
  l.release();
});

test("suite: a spawn in a missing directory resolves ok=false and does not crash", async () => {
  const c = cfg("node -e 0");
  let crashed = null;
  const guard = (e) => { crashed = e; };
  process.once("uncaughtException", guard);
  const log = join(tmpDir(), "s.log");
  const r = await runSuite(c, { cwd: join(tmpDir(), "nope"), jobId: "m-1", logPath: log });
  await new Promise((res) => setTimeout(res, 300));
  const text = readFileSync(log, "utf8");
  assert.match(text, /=== .* node -e 0 ===/);
  assert.match(text, /spawn failed:/);
  assert.match(text, /=== exit /);
  process.removeListener("uncaughtException", guard);
  assert.equal(crashed, null);
  assert.equal(r.ok, false);
});

test("suite: an unwritable log settles ok=false instead of crashing", async () => {
  const c = cfg("node -e 0");
  const dir = tmpDir();
  // a log path whose parent is an existing file: mkdir fails synchronously, so use a directory as the log file
  const c2 = cfg('node -e "setTimeout(()=>{},5000)"');
  const t0 = Date.now();
  const r = await runSuite(c2, { cwd: process.cwd(), jobId: "m-1", logPath: dir }).catch((e) => ({ threw: e }));
  assert.ok(Date.now() - t0 < 4000, "the child was killed, not waited for");
  assert.equal(r.threw, undefined);
  assert.equal(r.ok, false);
  assert.match(r.tail, /log write failed/);
});

const setup = (cmds = {}) => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "node -e 0", ...cmds } });
  const c = loadConfig(findRepoRoot(root));
  return { root, c };
};
const run = async (root, argv) => {
  const out = [], err = [];
  const code = await main(["suite", ...argv], { stdout: (s) => out.push(s), stderr: (s) => err.push(s), cwd: root });
  return { code, out: out.join(""), err: err.join("") };
};

test("suite cli: missing --job is BAD_ARGS", async () => {
  const { root } = setup();
  const r = await run(root, []);
  assert.equal(r.code, 2); assert.match(r.err, /BAD_ARGS/);
});

test("suite cli: unknown job is JOB_NOT_FOUND and no folder is created", async () => {
  const { root, c } = setup();
  const r = await run(root, ["--job", "m-9"]);
  assert.equal(r.code, 2); assert.match(r.err, /JOB_NOT_FOUND/);
  assert.equal(existsSync(jobDir(c, "m-9")), false);
});

test("suite cli: a missing --cwd is BAD_ARGS", async () => {
  const { root, c } = setup();
  writeJob(c, newJob({ id: "m-1", kind: "milestone", title: "t", now: new Date().toISOString() }));
  const r = await run(root, ["--job", "m-1", "--cwd", "does-not-exist"]);
  assert.equal(r.code, 2); assert.match(r.err, /BAD_ARGS/);
});

test("suite cli: red command prints red (exit 1), returns 1, log lands under verify/", async () => {
  const { root, c } = setup({ suite: "node -e \"process.exit(1)\"" });
  writeJob(c, newJob({ id: "m-1", kind: "milestone", title: "t", now: new Date().toISOString() }));
  const r = await run(root, ["--job", "m-1"]);
  assert.equal(r.code, 1); assert.match(r.out, /red \(exit 1\)/);
  const files = readdirSync(join(jobDir(c, "m-1"), "verify"));
  assert.ok(files.some((f) => /^suite-.*\.log$/.test(f)));
});
