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
const IDS = ["f-1", "f-2", "m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7"];
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

test("the snapshot over the demo jobs lists nine jobs in the expected columns", () => {
  const s = buildSnapshot({ stateDir: examples, board: { pollMs: 2000 } }, { now: "2026-01-06T00:00:00.000Z", demo: true });
  const col = Object.fromEntries(s.jobs.map((j) => [j.id, j.column]));
  assert.equal(s.jobs.length, 9);
  assert.deepEqual(col, { "m-7": "In process", "m-5": "Milestones", "m-6": "External running", "m-1": "Done", "m-2": "Pushed / PR", "m-3": "In process", "m-4": "Needs you", "f-1": "Needs you", "f-2": "Stopped" });
  assert.ok(s.jobs.find((j) => j.id === "m-2").prText);
  assert.ok(s.jobs.find((j) => j.id === "m-3").cost.usd > 0);
  assert.equal(s.jobs.find((j) => j.id === "m-4").needsYou.action, "approve");
  assert.equal(s.jobs.find((j) => j.id === "f-1").needsYou.action, "answer");
  assert.deepEqual(s.jobs.find((j) => j.id === "m-3").reviews.map((r) => r.verdict), ["good", "bad"]);
  assert.equal("active" in s.jobs.find((j) => j.id === "m-3"), false, "an explicit later clock leaves it idle");
  const demo = buildSnapshot({ stateDir: examples, board: { pollMs: 2000 } }, { demo: true });
  assert.deepEqual(demo.jobs.filter((j) => j.active).map((j) => j.id), ["m-7"], "the demo clock is its latest stamp (m-7's), so m-7 pulses");
});

test("m-7 is a building card with an events log that parses and a Codex log within the demo clock", () => {
  const dir = join(committed, "m-7");
  const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
  assert.equal(job.stage, "building");
  const lines = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length >= 8);
  const events = lines.map((l) => JSON.parse(l));
  for (const e of events) assert.ok(e.at <= job.updated, `${e.at} <= ${job.updated}`);
  const codex = events.find((e) => e.kind === "agent" && e.vendor === "codex" && e.phase === "start");
  assert.ok(codex?.log);
  assert.ok(Date.parse(job.updated) - Date.parse(codex.at) < 3600000, "the Codex start is within the hour before updated");
  assert.ok(readFileSync(join(dir, codex.log), "utf8").includes('"type":"item.completed"'));
  for (const other of ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "f-1", "f-2"]) {
    const o = JSON.parse(readFileSync(join(committed, other, "job.json"), "utf8"));
    assert.ok(o.updated <= job.updated, `${other} is not later than m-7`);
  }
});

test("m-3's cost entries are not later than its updated stamp", () => {
  const dir = join(committed, "m-3");
  const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
  const cost = JSON.parse(readFileSync(join(dir, "cost.json"), "utf8"));
  for (const e of cost.entries) assert.ok(e.at <= job.updated, `${e.at} <= ${job.updated}`);
});
