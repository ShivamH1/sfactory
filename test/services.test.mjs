import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, tmpRepo, writeConfig } from "./helpers.mjs";
import { execFile } from "node:child_process";
import { main } from "../src/cli.mjs";
import { jobDir, writeJob as rawWriteJob, readJob, withJobLock } from "../src/store.mjs";
const writeJob = (c, job) => withJobLock(c, job.id, () => rawWriteJob(c, job));
import { isFree } from "../src/ports.mjs";
import { acquire } from "../src/lock.mjs";
import { servicesUp, servicesDown, servicesStatus, pidAlive, processStarts } from "../src/services.mjs";

const SLEEP = 'node -e "setTimeout(()=>{},120000)"';
const listenCmd = (p) => `node -e "require('net').createServer().listen(${p});setTimeout(()=>{},120000)"`;

async function freeBlock(from) {
  for (let p = from; p < from + 800; p += 4) if ((await isFree(p)) && (await isFree(p + 1))) return p;
  throw new Error("no free test port block");
}
const waitFor = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

function setup(services, { ports = true, secrets = [], id = "m-1" } = {}) {
  const c = { stateDir: tmpDir("sf-svc-"), commands: { services }, secrets: { neverHandToAgents: secrets }, limits: { lockStaleMs: 60_000 } };
  const job = { id, kind: "milestone", title: "t", stage: "verifying", started: "2026-01-01T00:00:00Z", history: [], worktree: tmpDir("sf-wt-") };
  if (ports) job.ports = { block: 0, api: 0, web: 1 };
  return { c, job };
}
async function withPorts(base, fn) {
  const p = await freeBlock(base);
  return fn({ block: p, api: p, web: p + 1 });
}

test("services: up substitutes ports into cmd and env, drops secrets, logs, records; down kills and clears", async () => {
  await withPorts(47600, async (ports) => {
    const out = join(tmpDir("sf-out-"), "env.txt");
    const { c, job } = setup([
      { name: "api", cmd: listenCmd("{port.api}"), port: "api", env: { P: "{port.web}", OUT: out, SF_TEST_SECRET: "from-entry" } },
      { name: "probe", cmd: 'node -e "require(\'fs\').writeFileSync(process.env.OUT,[process.env.P,process.env.SF_TEST_SECRET||\'none\',process.cwd()].join(\'|\'));setTimeout(()=>{},120000)"', env: { P: "{port.web}", OUT: out, SF_TEST_SECRET: "from-entry" } },
    ], { secrets: ["SF_TEST_SECRET"] });
    job.ports = ports;
    writeJob(c, job);
    process.env.SF_TEST_SECRET = "hunter2";
    let up;
    try {
      up = await servicesUp(c, job);
      assert.equal(up.length, 2);
      assert.ok(await waitFor(async () => !(await isFree(ports.api))), "api is listening on its port");
      assert.ok(await waitFor(() => existsSync(out) && readFileSync(out, "utf8").split("|").length === 3), "the probe wrote its whole line");
      const [p, secret, cwd] = readFileSync(out, "utf8").split("|");
      assert.equal(p, String(ports.web));
      assert.equal(secret, "none");
      assert.equal(cwd.toLowerCase(), job.worktree.toLowerCase());
      assert.ok(existsSync(join(jobDir(c, job.id), "verify", "api.log")));
      assert.ok(existsSync(join(jobDir(c, job.id), "verify", "services.json")));
      assert.deepEqual(servicesStatus(c, job).map((s) => [s.name, s.state]), [["api", "ours"], ["probe", "ours"]]);
    } finally {
      delete process.env.SF_TEST_SECRET;
      const r = await servicesDown(c, job);
      if (up) assert.deepEqual(r.killed, ["api", "probe"]);
    }
    assert.ok(up.every((s) => !pidAlive(s.pid)));
    assert.ok(await waitFor(() => isFree(ports.api)));
    assert.equal(existsSync(join(jobDir(c, job.id), "verify", "services.json")), false);
  });
});

test("services: an unknown port name is BAD_ARGS and nothing starts", async () => {
  const { c, job } = setup([{ name: "a", cmd: SLEEP }, { name: "b", cmd: SLEEP, env: { X: "{port.nope}" } }]);
  writeJob(c, job);
  try {
    await assert.rejects(servicesUp(c, job), (e) => e.code === "BAD_ARGS" && /nope/.test(e.message));
    assert.equal(existsSync(join(jobDir(c, job.id), "verify", "a.log")), false);
    assert.equal(existsSync(join(jobDir(c, job.id), "verify", "services.json")), false);
  } finally { await servicesDown(c, job); }
});

test("services: a card with no ports is PORTS_REQUIRED, naming the allocate command", async () => {
  const { c, job } = setup([{ name: "a", cmd: SLEEP }], { ports: false });
  writeJob(c, job);
  await assert.rejects(servicesUp(c, job), (e) => e.code === "PORTS_REQUIRED" && /sfactory ports allocate m-1/.test(e.message));
});

test("services: up twice refuses while alive; down with nothing recorded is a no-op; down then up works", async () => {
  await withPorts(47700, async (ports) => {
    const { c, job } = setup([{ name: "a", cmd: SLEEP }]);
    job.ports = ports; writeJob(c, job);
    assert.deepEqual(await servicesDown(c, job), { killed: [], skipped: [] });
    try {
      await servicesUp(c, job);
      await assert.rejects(servicesUp(c, job), (e) => e.code === "SERVICES_RUNNING");
      await servicesDown(c, job);
      await servicesUp(c, job);
      assert.equal(servicesStatus(c, job)[0].state, "ours");
    } finally { await servicesDown(c, job); }
  });
});

test("services: a recorded pid that is gone is dead, and up may start over it", async () => {
  await withPorts(47800, async (ports) => {
    const { c, job } = setup([{ name: "a", cmd: SLEEP }]);
    job.ports = ports; writeJob(c, job);
    mkdirSync(join(jobDir(c, job.id), "verify"), { recursive: true });
    writeFileSync(join(jobDir(c, job.id), "verify", "services.json"), JSON.stringify({ services: [{ name: "a", pid: 2147483000, startedAt: Date.now() }] }));
    assert.equal(servicesStatus(c, job)[0].state, "dead");
    try { await servicesUp(c, job); assert.equal(servicesStatus(c, job)[0].state, "ours"); }
    finally { await servicesDown(c, job); }
  });
});

test("services: a live entry needs the live lock held by this job", async () => {
  await withPorts(47900, async (ports) => {
    const { c, job } = setup([{ name: "w", cmd: SLEEP, live: true }]);
    job.ports = ports; writeJob(c, job);
    await assert.rejects(servicesUp(c, job), (e) => e.code === "LIVE_LOCK_REQUIRED");
    const other = await acquire(c, "live", { holder: "m-9" });
    try { await assert.rejects(servicesUp(c, job), (e) => e.code === "LIVE_LOCK_REQUIRED"); } finally { other.release(); }
    const mine = await acquire(c, "live", { holder: job.id });
    try {
      await servicesUp(c, job);
      assert.equal(servicesStatus(c, job)[0].state, "ours");
    } finally { await servicesDown(c, job); mine.release(); }
  });
});

test("services: a pid that began after the record is foreign: reported, never killed", async () => {
  await withPorts(48000, async (ports) => {
    const { c, job } = setup([{ name: "a", cmd: SLEEP }]);
    job.ports = ports; writeJob(c, job);
    const rec = join(jobDir(c, job.id), "verify", "services.json");
    let pid;
    try {
      [{ pid }] = await servicesUp(c, job);
      const good = readFileSync(rec, "utf8");
      const r = JSON.parse(good); r.services[0].startedAt -= 3_600_000; // the process looks a lot younger than the record
      writeFileSync(rec, JSON.stringify(r));
      assert.equal(servicesStatus(c, job)[0].state, "foreign");
      writeFileSync(rec, good);
      assert.equal(servicesStatus(c, job)[0].state, "ours");
      writeFileSync(rec, JSON.stringify(r));
      const d = await servicesDown(c, job);
      assert.deepEqual(d.killed, []);
      assert.equal(d.skipped[0].pid, pid);
      assert.ok(pidAlive(pid), "the foreign pid was left alone");
    } finally {
      if (pid) { writeFileSync(rec, JSON.stringify({ services: [{ name: "a", pid, startedAt: Date.now() }] })); await servicesDown(c, job); }
    }
    assert.ok(!pidAlive(pid));
  });
});

test("services: sfactory services up|status|down drives the same record from the CLI", async () => {
  const repo = tmpRepo();
  const ports = await freeBlock(48100);
  writeConfig(repo, { project: "p", agents: { mode: "claude" }, stateDir: join(repo, ".sf"), commands: { suite: "node -e 0", services: [{ name: "a", cmd: listenCmd("{port.api}"), port: "api" }] } });
  const c = { stateDir: join(repo, ".sf") };
  writeJob(c, { id: "m-1", kind: "milestone", title: "t", stage: "verifying", started: "2026-01-01T00:00:00Z", history: [], worktree: repo, ports: { block: ports, api: ports, web: ports + 1 } });
  const run = async (...argv) => { let out = ""; const code = await main(["services", ...argv], { cwd: repo, stdout: (s) => { out += s; }, stderr: (s) => { out += s; } }); return { code, out }; };
  try {
    let r = await run("up", "m-1"); assert.equal(r.code, 0, r.out); assert.match(r.out, /a pid=\d+/);
    assert.ok(await waitFor(async () => !(await isFree(ports))));
    r = await run("status", "m-1"); assert.match(r.out, /a pid=\d+ alive/);
    r = await run("up", "m-1"); assert.equal(r.code, 2); assert.match(r.out, /SERVICES_RUNNING/);
    r = await run("down", "m-1"); assert.match(r.out, /stopped 1/);
    assert.ok(await waitFor(() => isFree(ports)));
    r = await run("status", "m-1"); assert.match(r.out, /no services recorded/);
    r = await run("bogus", "m-1"); assert.equal(r.code, 2);
  } finally { await run("down", "m-1"); }
  assert.equal(readJob(c, "m-1").id, "m-1");
});

test("services: a stale live lock held by this job does not satisfy a live entry", async () => {
  await withPorts(48200, async (ports) => {
    const { c, job } = setup([{ name: "w", cmd: SLEEP, live: true }]);
    job.ports = ports; writeJob(c, job);
    const stale = await acquire(c, "live", { holder: job.id, pid: 2147483000 }); // its pid is gone: stale
    try {
      await assert.rejects(servicesUp(c, job), (e) => e.code === "LIVE_LOCK_REQUIRED");
      assert.equal(existsSync(join(jobDir(c, job.id), "verify", "services.json")), false);
    } finally { try { stale.release(); } catch { /* already judged stale */ } await servicesDown(c, job); }
  });
});

test("services: a pid whose start time cannot be read is unknown: reported, kept in the record, blocks up", async () => {
  await withPorts(48300, async (ports) => {
    const { c, job } = setup([{ name: "a", cmd: SLEEP }]);
    job.ports = ports; writeJob(c, job);
    const rec = join(jobDir(c, job.id), "verify", "services.json");
    let pid;
    try {
      [{ pid }] = await servicesUp(c, job);
      const none = { startOf: () => null };
      assert.equal(servicesStatus(c, job, none)[0].state, "unknown");
      await assert.rejects(servicesUp(c, job, none), (e) => e.code === "SERVICES_UNKNOWN");
      const d = await servicesDown(c, job, none);
      assert.deepEqual(d.killed, []);
      assert.equal(d.skipped[0].alive, true);
      assert.ok(pidAlive(pid), "an unattributable pid is not killed");
      assert.ok(existsSync(rec), "and stays in the record");
    } finally { await servicesDown(c, job); }
    assert.ok(!pidAlive(pid));
  });
});

test("services: a failure after the first service started kills it and leaves no record", async () => {
  await withPorts(48400, async (ports) => {
    const { c, job } = setup([{ name: "a", cmd: SLEEP }, { name: "b", cmd: SLEEP }]);
    job.ports = ports; writeJob(c, job);
    const seen = [];
    try {
      await assert.rejects(servicesUp(c, job, { log: (m) => { seen.push(m); if (/started b /.test(m)) throw new Error("boom"); } }), /boom/);
      const pid = Number(/started a pid (\d+)/.exec(seen.join("\n"))?.[1]);
      assert.ok(pid, "a was started first");
      assert.ok(await waitFor(() => !pidAlive(pid)), "and rolled back");
      assert.equal(existsSync(join(jobDir(c, job.id), "verify", "services.json")), false);
    } finally { await servicesDown(c, job); }
  });
});

test("services: two concurrent ups from two processes start one set", async () => {
  const repo = tmpRepo();
  const ports = await freeBlock(48500);
  writeConfig(repo, { project: "p", agents: { mode: "claude" }, stateDir: join(repo, ".sf"), commands: { suite: "node -e 0", services: [{ name: "a", cmd: SLEEP }] } });
  const c = { stateDir: join(repo, ".sf") };
  writeJob(c, { id: "m-1", kind: "milestone", title: "t", stage: "verifying", started: "2026-01-01T00:00:00Z", history: [], worktree: repo, ports: { block: ports, api: ports, web: ports + 1 } });
  const bin = join(process.cwd(), "bin", "sfactory-services");
  const up = () => new Promise((res) => execFile(process.execPath, [bin, "up", "m-1"], { cwd: repo, windowsHide: true }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stderr })));
  try {
    const r = await Promise.all([up(), up()]);
    assert.deepEqual(r.map((x) => x.code).sort(), [0, 2]);
    assert.match(r.find((x) => x.code === 2).stderr, /SERVICES_RUNNING/);
    assert.equal(JSON.parse(readFileSync(join(jobDir(c, "m-1"), "verify", "services.json"), "utf8")).services.length, 1);
  } finally { await main(["services", "down", "m-1"], { cwd: repo, stdout() {}, stderr() {} }); }
});

test("services: down exits 1 with the reason on stderr when it leaves a pid alive", async () => {
  const repo = tmpRepo();
  const ports = await freeBlock(48600);
  writeConfig(repo, { project: "p", agents: { mode: "claude" }, stateDir: join(repo, ".sf"), commands: { suite: "node -e 0", services: [{ name: "a", cmd: SLEEP }] } });
  const c = { stateDir: join(repo, ".sf") };
  writeJob(c, { id: "m-1", kind: "milestone", title: "t", stage: "verifying", started: "2026-01-01T00:00:00Z", history: [], worktree: repo, ports: { block: ports, api: ports, web: ports + 1 } });
  const run = async (...argv) => { let out = "", err = ""; const code = await main(["services", ...argv], { cwd: repo, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } }); return { code, out, err }; };
  const rec = join(jobDir(c, "m-1"), "verify", "services.json");
  let good;
  try {
    assert.equal((await run("up", "m-1")).code, 0);
    good = readFileSync(rec, "utf8");
    const r = JSON.parse(good); r.services[0].startedAt -= 3_600_000; writeFileSync(rec, JSON.stringify(r));
    const d = await run("down", "m-1");
    assert.equal(d.code, 1);
    assert.match(d.err, /a pid=\d+: pid now belongs to another process/);
  } finally { if (good) { writeFileSync(rec, good); await run("down", "m-1"); } }
});

test("services: processStarts reads this process's own start time", () => {
  const began = processStarts([process.pid]).get(process.pid);
  assert.ok(Number.isFinite(began), "a start time came back");
  assert.ok(Math.abs((Date.now() - began) / 1000 - process.uptime()) < 5, "and it matches the uptime");
});

async function cliCard(base) {
  const repo = tmpRepo();
  const ports = await freeBlock(base);
  writeConfig(repo, { project: "p", agents: { mode: "claude" }, stateDir: join(repo, ".sf"), commands: { suite: "node -e 0", services: [{ name: "a", cmd: SLEEP }] } });
  const c = { stateDir: join(repo, ".sf") };
  writeJob(c, { id: "m-1", kind: "milestone", title: "t", stage: "verifying", started: "2026-01-01T00:00:00Z", history: [], worktree: repo, ports: { block: ports, api: ports, web: ports + 1 } });
  const run = async (servicesOpts, ...argv) => { let out = "", err = ""; const code = await main(["services", ...argv], { cwd: repo, servicesOpts, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } }); return { code, out, err }; };
  return { c, run, rec: join(jobDir(c, "m-1"), "verify", "services.json") };
}

test("services: down exits 1 with the reason for an unknown pid, which stays in the record", async () => {
  const { run, rec } = await cliCard(48700);
  try {
    assert.equal((await run(undefined, "up", "m-1")).code, 0);
    const d = await run({ startOf: () => null }, "down", "m-1");
    assert.equal(d.code, 1);
    assert.match(d.err, /a pid=\d+: alive but its start time cannot be read/);
    assert.ok(existsSync(rec));
    const up = await run({ startOf: () => null }, "up", "m-1");
    assert.equal(up.code, 2);
    assert.match(up.err, /SERVICES_UNKNOWN.*check these pids are yours/);
    assert.doesNotMatch(up.err, /stop them|kill/);
  } finally { assert.equal((await run(undefined, "down", "m-1")).code, 0); }
});

test("services: a pid that survives the kill is skipped with a reason, stays in the record, and down exits 1", async () => {
  const { c, run, rec } = await cliCard(48800);
  const job = { id: "m-1" };
  try {
    assert.equal((await run(undefined, "up", "m-1")).code, 0);
    const d = await run({ kill: async () => false }, "down", "m-1");
    assert.equal(d.code, 1);
    assert.match(d.err, /a pid=\d+: still running after the kill/);
    assert.equal(JSON.parse(readFileSync(rec, "utf8")).services.length, 1);
    assert.equal(servicesStatus(c, job)[0].state, "ours");
  } finally { assert.equal((await run(undefined, "down", "m-1")).code, 0); }
});

test("services: a dead group leader whose group lives on is still ours, and down ends the group (POSIX)", { skip: process.platform === "win32" && "POSIX process groups" }, async () => {
  await withPorts(48900, async (ports) => {
    const { c, job } = setup([{ name: "a", cmd: "sleep 120 & exit 0" }]);
    job.ports = ports; writeJob(c, job);
    try {
      await servicesUp(c, job);
      assert.ok(await waitFor(() => servicesStatus(c, job)[0].state === "ours"));
    } finally { const d = await servicesDown(c, job); assert.deepEqual(d.killed, ["a"]); }
  });
});
