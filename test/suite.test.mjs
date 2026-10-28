import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, tmpRepo, writeConfig } from "./helpers.mjs";
import { existsSync, readdirSync } from "node:fs";
import { main } from "../src/cli.mjs";
import { findRepoRoot, loadConfig } from "../src/config.mjs";
import { jobDir, writeJob as rawWriteJob, withJobLock } from "../src/store.mjs";
const writeJob = (c, job) => withJobLock(c, job.id, () => rawWriteJob(c, job));
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

test("suite: killTree ends the shell's child too (the command, not only the shell)", async () => {
  const { spawn } = await import("node:child_process");
  const { killTree } = await import("../src/suite.mjs");
  const marker = join(tmpDir(), "survived.txt").replace(/\\/g, "/");
  // Spawned as the callers spawn: detached off win32, so the child leads its own process group.
  const p = spawn(`node -e "setTimeout(()=>require('fs').writeFileSync('${marker}','x'),4000)"`, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((res) => p.on("close", () => res(Date.now())));
  await new Promise((res) => setTimeout(res, 500)); // let the grandchild start
  const t0 = Date.now();
  killTree(p);
  const t1 = await Promise.race([closed, new Promise((res) => setTimeout(() => res(null), 2000))]);
  assert.ok(t1 !== null && t1 - t0 < 2000, "close fired within 2 s");
  await new Promise((res) => setTimeout(res, 4500));
  assert.equal(existsSync(marker), false, "the grandchild was killed before it wrote its marker");
});

test("round 4: killTree leaves an exited child alone, even when its pid now names a live process", async () => {
  const { spawn } = await import("node:child_process");
  const { killTree } = await import("../src/suite.mjs");
  // A live process stands in for whatever reused the dead child's pid.
  const live = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore", detached: process.platform !== "win32" });
  await new Promise((res) => setTimeout(res, 300));
  try {
    let killCalled = false;
    for (const ended of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGTERM" }]) {
      killTree({ pid: live.pid, ...ended, kill: () => { killCalled = true; } });
    }
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(killCalled, false, "p.kill() not called on an exited child");
    assert.equal(live.exitCode, null, "the process now holding the pid was not killed");
    assert.equal(live.signalCode, null);
  } finally { live.kill(); }
});

const SIGS = ["SIGINT", "SIGTERM", "SIGHUP"];
const counts = () => SIGS.map((s) => process.listenerCount(s));

test("round 4: followSignals kills the child's tree on SIGINT, SIGTERM or SIGHUP, re-raises, and removes its handlers", async () => {
  const { EventEmitter } = await import("node:events");
  const { followSignals } = await import("../src/suite.mjs");
  const before = counts();
  for (const sig of SIGS) {
    const child = new EventEmitter();
    const killed = [], raised = [];
    // kill and reraise are stubbed: the real re-raise would end this test process.
    followSignals(child, { kill: (p) => killed.push(p), reraise: (s) => raised.push(s) });
    assert.deepEqual(counts(), before.map((n) => n + 1), "one handler per signal while the child runs");
    process.emit(sig, sig);
    assert.deepEqual(killed, [child], `${sig} killed the child's tree`);
    assert.deepEqual(raised, [sig], `${sig} was re-raised`);
    assert.deepEqual(counts(), before, `every handler removed after ${sig}`);
  }
  // A child that closes on its own takes its handlers with it; a later signal touches nothing.
  const child = new EventEmitter();
  const seen = [];
  const off = followSignals(child, { kill: () => seen.push("kill"), reraise: () => seen.push("raise") });
  child.emit("close", 0, null);
  assert.deepEqual(counts(), before);
  process.emit("SIGINT", "SIGINT");
  off(); // idempotent
  assert.deepEqual(seen, []);
  assert.deepEqual(counts(), before);
});

test("round 4: followSignals' own re-raise ends the process with the signal after killing the child", async () => {
  // Run in a separate process: the real re-raise must not reach the test runner.
  const { spawnSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const d = tmpDir("sf-sig-");
  const killedFile = join(d, "killed"), survivedFile = join(d, "survived");
  const url = new URL("../src/suite.mjs", import.meta.url).href;
  const script = `
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { followSignals } from ${JSON.stringify(url)};
const child = new EventEmitter();
followSignals(child, { kill: () => writeFileSync(${JSON.stringify(killedFile)}, "x") });
process.emit("SIGTERM", "SIGTERM");
setTimeout(() => writeFileSync(${JSON.stringify(survivedFile)}, "x"), 3000);
`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
  assert.equal(readFileSync(killedFile, "utf8"), "x", "the child's tree was killed first");
  assert.equal(existsSync(survivedFile), false, "the process ended on the re-raised signal");
  if (process.platform === "win32") assert.notEqual(r.status, 0);
  else assert.equal(r.signal, "SIGTERM");
});
