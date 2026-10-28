import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, tmpRepo, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { jobDir, writeJob as rawWriteJob, readJob, withJobLock } from "../src/store.mjs";
const writeJob = (c, job) => withJobLock(c, job.id, () => rawWriteJob(c, job));
import { isFree } from "../src/ports.mjs";
import { acquire } from "../src/lock.mjs";
import { servicesUp, servicesDown, servicesStatus, pidAlive } from "../src/services.mjs";

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
      { name: "api", cmd: listenCmd("{port.api}"), port: "api", env: { P: "{port.web}", OUT: out } },
      { name: "probe", cmd: 'node -e "require(\'fs\').writeFileSync(process.env.OUT,[process.env.P,process.env.SF_TEST_SECRET||\'none\',process.cwd()].join(\'|\'));setTimeout(()=>{},120000)"', env: { P: "{port.web}", OUT: out } },
    ], { secrets: ["SF_TEST_SECRET"] });
    job.ports = ports;
    writeJob(c, job);
    process.env.SF_TEST_SECRET = "hunter2";
    let up;
    try {
      up = await servicesUp(c, job);
      assert.equal(up.length, 2);
      assert.ok(await waitFor(async () => !(await isFree(ports.api))), "api is listening on its port");
      assert.ok(await waitFor(() => existsSync(out)));
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
