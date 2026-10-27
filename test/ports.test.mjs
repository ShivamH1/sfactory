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
