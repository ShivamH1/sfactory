import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../examples/jobs/generate.mjs";
import { buildSnapshot } from "../src/board/snapshot.mjs";

const examples = fileURLToPath(new URL("../examples/", import.meta.url));
const committed = join(examples, "jobs");
const IDS = ["f-1", "f-2", "m-1", "m-2", "m-3", "m-4"];
const norm = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
function files(root, prefix = "") {
  return readdirSync(root).flatMap((n) => {
    const p = join(root, n), rel = prefix ? `${prefix}/${n}` : n;
    return statSync(p).isDirectory() ? files(p, rel) : [rel];
  });
}

test("generator output equals the committed demo folders", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sfactory-demo-"));
  try {
    generate(tmp);
    assert.deepEqual(readdirSync(tmp).sort(), IDS);
    for (const id of IDS) {
      const a = files(join(tmp, id)).sort(), b = files(join(committed, id)).sort();
      assert.deepEqual(b, a, id);
      for (const rel of a) assert.equal(norm(join(committed, id, rel)), norm(join(tmp, id, rel)), `${id}/${rel}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("the snapshot over the demo jobs lists six jobs in the expected columns", () => {
  const s = buildSnapshot({ stateDir: examples, board: { pollMs: 2000 } }, { now: "2026-01-06T00:00:00.000Z", demo: true });
  const col = Object.fromEntries(s.jobs.map((j) => [j.id, j.column]));
  assert.equal(s.jobs.length, 6);
  assert.deepEqual(col, { "m-1": "Done", "m-2": "Pushed / PR", "m-3": "In process", "m-4": "Needs you", "f-1": "Needs you", "f-2": "Stopped" });
  assert.ok(s.jobs.find((j) => j.id === "m-2").prText);
  assert.ok(s.jobs.find((j) => j.id === "m-3").cost.usd > 0);
  assert.equal(s.jobs.find((j) => j.id === "m-4").needsYou.action, "approve");
  assert.equal(s.jobs.find((j) => j.id === "f-1").needsYou.action, "answer");
});
