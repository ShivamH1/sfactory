import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { acquire, acquireSync, clearGuard, release, status, withLock } from "../src/lock.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-lock-"), limits: { lockStaleMs: 3_600_000 } });

test("lock: acquire, status, release", async () => {
  const c = cfg();
  const l = await acquire(c, "suite", { holder: "m-1" });
  assert.equal(status(c, "suite").held, true);
  assert.equal(status(c, "suite").holder, "m-1");
  l.release();
  assert.equal(status(c, "suite").held, false);
});

test("lock: a second holder is refused with the first holder named, and waits if asked", async () => {
  const c = cfg();
  const l = await acquire(c, "suite", { holder: "m-1" });
  await assert.rejects(acquire(c, "suite", { holder: "m-2" }), (e) => e.code === "LOCK_HELD" && /m-1/.test(e.message));
  setTimeout(() => l.release(), 300);
  const t0 = Date.now();
  const l2 = await acquire(c, "suite", { holder: "m-2", waitMs: 5000, pollMs: 50 });
  assert.ok(Date.now() - t0 >= 250, "waited for the release");
  assert.equal(l2.holder, "m-2");
  l2.release();
});

test("lock: a dead pid lock is taken over and recorded", async () => {
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
  assert.throws(() => release(c, "commit", { holder: "b", token: l.token }), (e) => e.code === "NOT_HOLDER");
  l.release();
  await assert.rejects(withLock(c, "commit", { holder: "a" }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(status(c, "commit").held, false);
});

const child = fileURLToPath(new URL("./fixtures/lock-child.mjs", import.meta.url));
const run = (stateDir, holder, start, mode) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [child, stateDir, holder, String(start), ...(mode ? [mode] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  const timer = setTimeout(() => { p.kill(); reject(new Error("child timed out")); }, 10_000);
  p.stdout.on("data", (d) => { out += d; });
  p.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
});
const stale = (c, name, extra = {}) => {
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  writeFileSync(join(c.stateDir, "locks", name + ".lock"), JSON.stringify({ holder: "ghost", token: "t", pid: 999999, since: new Date().toISOString(), ...extra }));
};

test("lock: (a) eight aligned processes racing for a dead pid lock produce exactly one winner, three times", async () => {
  for (let round = 0; round < 3; round++) {
    const c = cfg();
    stale(c, "race");
    const start = Date.now() + 2500;
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => run(c.stateDir, "p-" + i, start)));
    assert.ok(results.every((r) => r === "GOT" || r === "HELD"), results.join(","));
    assert.equal(results.filter((r) => r === "GOT").length, 1, results.join(","));
    const iv = readFileSync(join(c.stateDir, "intervals.log"), "utf8").trim().split(String.fromCharCode(10)).map((l) => l.split(" ").map(Number).slice(1)).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < iv.length; i++) assert.ok(iv[i][0] >= iv[i - 1][1], "holding intervals overlap: " + JSON.stringify(iv));
  }
});

test("lock: (b) right holder with the wrong token is NOT_HOLDER and the file stays", async () => {
  const c = cfg();
  const l = await acquire(c, "x", { holder: "a" });
  assert.throws(() => release(c, "x", { holder: "a", token: "wrong" }), (e) => e.code === "NOT_HOLDER");
  assert.ok(existsSync(l.path));
  assert.equal(status(c, "x").holder, "a");
  assert.equal("token" in status(c, "x"), false);
  l.release();
});

test("lock: (c) an old empty lock file is taken over; a fresh one is held by unknown", async () => {
  const c = cfg();
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  const p = join(c.stateDir, "locks", "e.lock");
  writeFileSync(p, "");
  await assert.rejects(acquire(c, "e", { holder: "a" }), (e) => e.code === "LOCK_HELD" && /unknown/.test(e.message));
  const old = new Date(Date.now() - 60_000);
  utimesSync(p, old, old);
  const l = await acquire(c, "e", { holder: "a" });
  assert.equal(l.tookOverFrom, "unknown");
  l.release();
});

test("lock: (d) a non-numeric waitMs is BAD_ARGS", async () => {
  await assert.rejects(acquire(cfg(), "x", { holder: "a", waitMs: "abc" }), (e) => e.code === "BAD_ARGS");
});

test("lock: (f) a pid-null (CLI) lock is not taken over within staleMs", async () => {
  const c = cfg();
  const l = await acquire(c, "cli", { holder: "a", pid: null });
  await assert.rejects(acquire(c, "cli", { holder: "b" }), (e) => e.code === "LOCK_HELD");
  assert.equal(status(c, "cli").stale, false);
  l.release();
});

test("lock: (g) withLock rethrows a release failure after fn succeeded", async () => {
  const c = cfg();
  await assert.rejects(
    withLock(c, "w", { holder: "a" }, async (l) => {
      release(c, "w", { holder: "a", token: l.token });
      writeFileSync(l.path, JSON.stringify({ holder: "other", token: "z", pid: null, since: new Date().toISOString() }));
      return 1;
    }),
    (e) => e.code === "NOT_HOLDER",
  );
});

test("lock: (h) a durable lock from an exited process is never taken over", async () => {
  const c = cfg();
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  const year = new Date(Date.now() - 365 * 86_400_000).toISOString();
  writeFileSync(join(c.stateDir, "locks", "d.lock"), JSON.stringify({ holder: "old", token: "t", pid: 1, durable: true, since: year }));
  await assert.rejects(acquire(c, "d", { holder: "b" }), (e) => e.code === "LOCK_HELD" && /old/.test(e.message));
  assert.equal(status(c, "d").durable, true);
  assert.equal(release(c, "d", { holder: "old", token: "t" }), true);
  const l = await acquire(c, "d", { holder: "b", durable: true });
  assert.equal(l.pid, null);
  assert.equal(l.durable, true);
  l.release();
});

test("lock: (i) acquireSync takes a free name, refuses a held one, takes over a stale one", () => {
  const c = cfg();
  const l = acquireSync(c, "s", { holder: "a" });
  assert.throws(() => acquireSync(c, "s", { holder: "b" }), (e) => e.code === "LOCK_HELD" && /a/.test(e.message));
  l.release();
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  writeFileSync(join(c.stateDir, "locks", "s.lock"), JSON.stringify({ holder: "ghost", token: "t", pid: 999999, since: new Date().toISOString() }));
  const l2 = acquireSync(c, "s", { holder: "b" });
  assert.equal(l2.tookOverFrom, "ghost");
  l2.release();
});

test("lock: (j) wrong-token releases racing four acquirers never yield two holders", async () => {
  const c = cfg();
  const start = Date.now() + 1500;
  const kids = [1, 2, 3, 4].map((i) => run(c.stateDir, "q-" + i, start, "loop"));
  await new Promise((r) => setTimeout(r, start - Date.now()));
  while (Date.now() < start + 1500) {
    try { release(c, "race", { holder: "q-1", token: "wrong" }); } catch (e) { assert.equal(e.code, "NOT_HOLDER"); }
    await new Promise((r) => setTimeout(r, 1));
  }
  const results = await Promise.all(kids);
  for (const r of results) assert.match(r, /^GOT [0-9]+ OVERLAP 0$/, results.join(" | "));
});

test("lock: (k) a fresh takeover guard is busy and shown by status", () => {
  const c = cfg();
  stale(c, "g");
  writeFileSync(join(c.stateDir, "locks", "g.lock.takeover"), "{}");
  assert.throws(() => acquireSync(c, "g", { holder: "b" }), (e) => e.code === "LOCK_HELD");
  const st = status(c, "g");
  assert.equal(st.takeover, true);
  assert.ok(st.guardAge >= 0);
});

test("lock: (l) an old guard is never auto-cleared; clearGuard (lock clear --guard) removes it", () => {
  const c = cfg();
  stale(c, "g");
  const guard = join(c.stateDir, "locks", "g.lock.takeover");
  writeFileSync(guard, "{}");
  const old = new Date(Date.now() - 60_000);
  utimesSync(guard, old, old);
  assert.throws(() => acquireSync(c, "g", { holder: "b" }), (e) => e.code === "LOCK_HELD" && /takeover guard present/.test(e.message) && /lock clear g --guard/.test(e.message));
  assert.ok(existsSync(guard));
  assert.ok(status(c, "g").guardAge >= 60_000);
  assert.equal(clearGuard(c, "g"), true);
  assert.equal(clearGuard(c, "g"), false);
  const l = acquireSync(c, "g", { holder: "b" });
  assert.equal(l.tookOverFrom, "ghost");
  l.release();
});

test("lock: (m) a live-pid lock a year old is not taken over; a pid-null one that old is", async () => {
  const c = cfg();
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  const year = new Date(Date.now() - 365 * 86_400_000).toISOString();
  writeFileSync(join(c.stateDir, "locks", "live.lock"), JSON.stringify({ holder: "running-suite", token: "t", pid: process.pid, since: year }));
  await assert.rejects(acquire(c, "live", { holder: "b" }), (e) => e.code === "LOCK_HELD" && /running-suite/.test(e.message));
  assert.equal(status(c, "live").stale, false);
  writeFileSync(join(c.stateDir, "locks", "cli.lock"), JSON.stringify({ holder: "old-cli", token: "t", pid: null, since: year }));
  const l = await acquire(c, "cli", { holder: "b" });
  assert.equal(l.tookOverFrom, "old-cli");
  l.release();
});
