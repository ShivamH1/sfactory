import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { withJobLock, writeJob, readJob, addJob, jobDir, HOLDER } from "../src/store.mjs";
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
