import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { tmpDir } from "./helpers.mjs";
import { allocate, isFree, substitute } from "../src/ports.mjs";
import { writeJob } from "../src/store.mjs";

const cfg = (base) => ({ stateDir: tmpDir("sf-ports-"), ports: { base, step: 10, names: ["api", "web"] } });

test("ports: allocate skips a block held by another job and a block whose port is busy", async () => {
  const c = cfg(47100);
  writeJob(c, { id: "m-1", kind: "milestone", title: "a", stage: "building", started: "2026-01-01T00:00:00Z", history: [], ports: { block: 47100, api: 47100, web: 47101 } });
  const srv = createServer(); await new Promise((r) => srv.listen(47111, "127.0.0.1", r));
  try {
    const p = await allocate(c, "m-2");
    assert.deepEqual(p, { block: 47120, api: 47120, web: 47121 });
  } finally { srv.close(); }
});

test("ports: isFree and substitute", async () => {
  assert.equal(await isFree(0), true);
  assert.equal(substitute("http://localhost:{port.api}/x {port.web}", { api: 4100, web: 4102 }), "http://localhost:4100/x 4102");
});

const listen = (port, host) => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(port, host, () => res(s)); });
const closeSrv = (s) => new Promise((r) => s.close(r));
async function freePort(from) { for (let p = from; p < from + 500; p++) if (await isFree(p)) return p; throw new Error("no free port"); }

test("ports: isFree sees a port held on 0.0.0.0 and on ::1", async () => {
  const p = await freePort(47300);
  const a = await listen(p, "0.0.0.0");
  try { assert.equal(await isFree(p), false); } finally { await closeSrv(a); }
  const q = await freePort(47320);
  let b;
  try { b = await listen(q, "::1"); } catch { return; } // ::1 unavailable on this box: nothing to assert
  try { assert.equal(await isFree(q), false); } finally { await closeSrv(b); }
});

test("ports: allocate stops at the top of the port range with NO_PORTS", async () => {
  const c = { stateDir: tmpDir("sf-ports-"), ports: { base: 65530, step: 10, names: ["a", "b", "c", "d", "e", "f", "g"] } };
  await assert.rejects(allocate(c, "m-1"), (e) => e.code === "NO_PORTS");
});

test("ports: every port of a held job blocks, and overlapping config is refused", async () => {
  const held = { id: "m-1", kind: "milestone", title: "a", stage: "building", started: "2026-01-01T00:00:00Z", history: [], ports: { block: 47100, a: 47100, b: 47101, c: 47102 } };
  const c = { stateDir: tmpDir("sf-ports-"), ports: { base: 47100, step: 2, names: ["a", "b", "c"] } };
  writeJob(c, held);
  await assert.rejects(allocate(c, "m-2"), (e) => e.code === "INVALID_CONFIG" && /3/.test(e.message) && /2/.test(e.message));
  const d = { stateDir: c.stateDir, ports: { base: 47100, step: 10, names: ["a", "b", "c"] } };
  assert.equal((await allocate(d, "m-2")).block, 47110);
  const e = { stateDir: c.stateDir, ports: { base: 47101, step: 10, names: ["a", "b"] } };
  assert.equal((await allocate(e, "m-2")).block, 47111);
});

test("ports: substitute leaves inherited names alone", () => {
  assert.equal(substitute("{port.constructor} {port.nope}", { api: 1 }), "{port.constructor} {port.nope}");
});

import { tmpRepo, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { readJob } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";

const run = (root, args) => { const out = [], err = []; return main(args, { cwd: root, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }).then((code) => ({ code, out: out.join(""), err: err.join("") })); };

test("ports cmd: allocate writes job.ports and prints the names; free exits 0/1", async () => {
  const base = await freePort(47400);
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, ports: { base, step: 10, names: ["api", "web"] } });
  const c = loadConfig(root);
  await run(root, ["job", "add", "milestone", "M1 thing"]);
  let r = await run(root, ["ports", "allocate", "m-1"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^api=\d+ web=\d+\n$/);
  const ports = readJob(c, "m-1").ports;
  assert.equal(r.out, `api=${ports.api} web=${ports.web}\n`);
  assert.equal(readJob(c, "m-1").stage, "backlog");
  r = await run(root, ["ports", "allocate", "m-9"]);
  assert.equal(r.code, 2);

  const p = await freePort(47500);
  r = await run(root, ["ports", "free", String(p)]);
  assert.equal(r.code, 0); assert.equal(r.out, "free\n");
  const srv = await listen(p, "127.0.0.1");
  try {
    r = await run(root, ["ports", "free", String(p)]);
    assert.equal(r.code, 1); assert.equal(r.out, "busy\n");
  } finally { await closeSrv(srv); }
  for (const bad of ["", "1e3", "0x10", "0", "65536"]) {
    r = await run(root, ["ports", "free", bad]);
    assert.equal(r.code, 2, `"${bad}"`); assert.match(r.err, /BAD_ARGS/);
  }
});
