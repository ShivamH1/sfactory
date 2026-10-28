import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { withJobLock, writeJob, readJob, addJob, jobDir, HOLDER, writeJobFile } from "../src/store.mjs";
import { newJob } from "../src/job.mjs";
import { acquireSync, status } from "../src/lock.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-jl-"), limits: { lockStaleMs: 60_000 } });

test("store: writeJob refuses without the job lock, works inside withJobLock", () => {
  const c = cfg();
  const job = newJob({ id: "m-1", kind: "milestone", title: "t" });
  assert.throws(() => writeJob(c, job), (e) => e.code === "JOB_LOCK_REQUIRED");
  const out = withJobLock(c, "m-1", () => writeJob(c, job));
  assert.equal(out.id, "m-1");
  assert.equal(status(c, "job:m-1").held, false);
  assert.ok(!readdirSync(jobDir(c, "m-1")).some((n) => n.endsWith(".tmp")));
});

test("store: a held job lock makes withJobLock wait then fail JOB_BUSY", () => {
  const c = cfg();
  const l = acquireSync(c, "job:m-1", { holder: "other" });
  const t0 = Date.now();
  assert.throws(() => withJobLock(c, "m-1", () => 1, { retries: 4, delayMs: 20 }), (e) => e.code === "JOB_BUSY");
  assert.ok(Date.now() - t0 >= 60);
  l.release();
  assert.equal(withJobLock(c, "m-1", () => 2), 2);
});

test("store: addJob allocates ids exclusively and creates the folder", () => {
  const c = cfg();
  const a = addJob(c, "milestone", "A"), b = addJob(c, "milestone", "B");
  assert.deepEqual([a.id, b.id], ["m-1", "m-2"]);
  assert.ok(existsSync(join(jobDir(c, "m-2"), "job.json")));
  assert.equal(readJob(c, "m-1").title, "A");
});

test("store: HOLDER is per process and withJobLock releases on throw", () => {
  const c = cfg();
  assert.match(HOLDER, /^sfactory:\d+:[0-9a-f-]+$/);
  assert.throws(() => withJobLock(c, "m-9", () => { throw new Error("boom"); }), /boom/);
  assert.equal(status(c, "job:m-9").held, false);
});

test("store: only a held lock becomes JOB_BUSY; any other acquire failure passes through", () => {
  const c = cfg();
  const bad = { stateDir: c.stateDir, limits: { lockStaleMs: 60_000 } };
  Object.defineProperty(bad, "stateDir", { get() { throw Object.assign(new Error("disk"), { code: "EIO" }); } });
  assert.throws(() => withJobLock(bad, "m-1", () => 1), (e) => e.code !== "JOB_BUSY" && /disk/.test(e.message));
});

test("store: withJobLock refuses an async callback after releasing the lock", async () => {
  const c = cfg();
  assert.throws(() => withJobLock(c, "m-1", async () => 1), (e) => e.code === "LOCK_ASYNC");
  assert.equal(status(c, "job:m-1").held, false);
});

test("store: writeJobFile refuses the job's own state files", () => {
  const c = cfg();
  addJob(c, "milestone", "A");
  for (const rel of ["job.json", "cost.json", "./job.json"]) assert.throws(() => writeJobFile(c, "m-1", rel, "{}"), (e) => e.code === "BAD_PATH", rel);
  assert.equal(readJob(c, "m-1").title, "A");
});

async function children(script, n, arg) {
  const { spawn } = await import("node:child_process");
  return Promise.all(Array.from({ length: n }, () => new Promise((res) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(arg)], { stdio: "pipe" });
    let err = ""; p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, err }));
  })));
}
const href = (p) => JSON.stringify(new URL(p, import.meta.url).href);

test("store: 3 processes x 4 adds give 12 unique ids and folders", async () => {
  const c = cfg();
  const script = `import { actions } from ${href("../src/job-actions.mjs")};
const c = JSON.parse(process.argv[1]);
for (let i = 0; i < 4; i++) actions.add(c, { kind: "milestone", title: "t" + i });`;
  for (const r of await children(script, 3, c)) assert.equal(r.code, 0, r.err);
  const dirs = readdirSync(join(c.stateDir, "jobs"));
  assert.equal(new Set(dirs).size, 12);
  assert.deepEqual([...dirs].sort(), Array.from({ length: 12 }, (_, i) => `m-${i + 1}`).sort());
  for (const d of dirs) assert.ok(existsSync(join(c.stateDir, "jobs", d, "job.json")), d);
});

test("store: 2 processes x 4 requestChanges alongside 4 board POSTs lose nothing", async () => {
  const { actions } = await import("../src/job-actions.mjs");
  const { startBoard } = await import("../src/board/server.mjs");
  const c = { ...cfg(), project: "p", board: { pollMs: 1500, port: 0 } };
  const j = addJob(c, "milestone", "Plan");
  for (const s of ["planning", "awaiting-approval"]) actions.set(c, { id: j.id, to: s });
  const before = readJob(c, j.id).history.length;
  const script = `import { actions } from ${href("../src/job-actions.mjs")};
const c = JSON.parse(process.argv[1]);
for (let i = 0; i < 4; i++) actions.requestChanges(c, { id: "m-1", notes: "n" + i, by: "child" });`;
  const b = await startBoard(c, { port: 0, log: () => {} });
  try {
    const posts = Array.from({ length: 4 }, (_, i) => fetch(`${b.url}jobs/m-1/request-changes`, { method: "POST", headers: { "X-Sfactory-Board": "1", "Content-Type": "application/json" }, body: JSON.stringify({ notes: "p" + i }) }).then((r) => r.status));
    const [kids, statuses] = await Promise.all([children(script, 2, c), Promise.all(posts)]);
    for (const r of kids) assert.equal(r.code, 0, r.err);
    assert.deepEqual(statuses, [200, 200, 200, 200]);
  } finally { await b.close(); }
  assert.equal(readJob(c, j.id).history.length, before + 12);
  const plan = readdirSync(join(jobDir(c, j.id), "plan"));
  for (let k = 1; k <= 12; k++) assert.ok(plan.includes(`changes-${k}.md`), `changes-${k}.md`);
  assert.ok(![...plan, ...readdirSync(jobDir(c, j.id))].some((n) => n.endsWith(".tmp")));
});
