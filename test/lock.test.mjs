import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { acquire, release, status, withLock } from "../src/lock.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-lock-"), limits: { lockStaleMs: 3_600_000 } });

test("lock: acquire, status, release", async () => {
  const c = cfg();
  const l = await acquire(c, "suite", { holder: "m-1" });
  assert.equal(status(c, "suite").held, true);
  assert.equal(status(c, "suite").holder, "m-1");
  l.release();
  assert.equal(status(c, "suite").held, false);
});

test("lock: a second holder is refused with the first's name, and waits if asked", async () => {
  const c = cfg();
  const l = await acquire(c, "suite", { holder: "m-1" });
  await assert.rejects(acquire(c, "suite", { holder: "m-2" }), (e) => e.code === "LOCK_HELD" && /m-1/.test(e.message));
  setTimeout(() => l.release(), 300);
  const l2 = await acquire(c, "suite", { holder: "m-2", waitMs: 5000, pollMs: 50 });
  assert.equal(l2.holder, "m-2");
  l2.release();
});

test("lock: a dead pid's lock is taken over and recorded", async () => {
  const c = cfg();
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  writeFileSync(join(c.stateDir, "locks", "live.lock"), JSON.stringify({ holder: "ghost", pid: 999999, since: new Date().toISOString() }));
  const l = await acquire(c, "live", { holder: "m-3" });
  assert.equal(l.tookOverFrom, "ghost");
  l.release();
});

test("lock: release by a non-holder is NOT_HOLDER; withLock releases on throw", async () => {
  const c = cfg();
  const l = await acquire(c, "commit", { holder: "a" });
  assert.throws(() => release(c, "commit", { holder: "b" }), (e) => e.code === "NOT_HOLDER");
  l.release();
  await assert.rejects(withLock(c, "commit", { holder: "a" }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(status(c, "commit").held, false);
});
