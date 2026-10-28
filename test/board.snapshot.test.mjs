import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpDir } from "./helpers.mjs";
import { addJob, withJobLock, writeJob, writeJobFile, jobDir } from "../src/store.mjs";
import { park, transition } from "../src/job.mjs";
import { addCost } from "../src/cost.mjs";
import { buildSnapshot } from "../src/board/snapshot.mjs";
import { acquireSync } from "../src/lock.mjs";

const COLS = ["Backlog", "Plan", "Needs you", "In process", "Review", "Fixed", "Pushed / PR", "Done", "Stopped"];
const T0 = "2026-10-27T10:00:00.000Z", NOW = "2026-10-27T10:10:00.000Z";

function setup() {
  const c = { stateDir: tmpDir("sf-snap-"), project: "proj", board: { pollMs: 1500 } };
  const set = (id, fn) => withJobLock(c, id, () => writeJob(c, fn(JSON.parse(JSON.stringify(readIt(c, id))))));
  return { c, set };
}
import { readJob } from "../src/store.mjs";
const readIt = (c, id) => readJob(c, id);

test("snapshot: shape, columns, needsYou, files, cost, elapsed, no secrets", () => {
  const { c, set } = setup();
  const a = addJob(c, "milestone", "Parked one", { now: T0 });
  const b = addJob(c, "milestone", "Approve me", { now: T0 });
  const p = addJob(c, "fix", "Pushed fix", { now: T0 });
  set(a.id, (j) => { j = transition(j, "planning", { now: T0 }); j = transition(j, "awaiting-approval", { now: T0 }); return transition(j, "building", { now: T0 }); });
  set(a.id, (j) => park(j, { reason: "q?", now: T0 }));
  writeJobFile(c, a.id, "decisions/1.md", "# Decision 1\nWhich?");
  writeJobFile(c, a.id, "plan/questionnaire.md", "q");
  writeJobFile(c, a.id, "stray.tmp", "x");
  writeJobFile(c, a.id, "plan/x.json.tmp", "x");
  writeJobFile(c, a.id, "run.log", "l");
  set(b.id, (j) => { j.stage = "awaiting-approval"; j.lockToken = "SECRET"; return j; });
  set(p.id, (j) => { j.stage = "pushed"; j.ended = "2026-10-27T10:05:00.000Z"; j.ports = { block: 4000, api: 4000, web: 4001 }; return j; });
  writeJobFile(c, p.id, "pr.md", "PR body");
  addCost(c, a.id, { stage: "building", agent: "x", model: "m", usd: 1.5 });
  const lk = acquireSync(c, "live", { holder: "h" });

  const s = buildSnapshot(c, { now: NOW });
  lk.release();
  assert.equal(s.project, "proj");
  assert.deepEqual(s.board, { pollMs: 1500 });
  assert.equal(s.generatedAt, NOW);
  assert.deepEqual(s.columns, COLS);
  const byId = Object.fromEntries(s.jobs.map((j) => [j.id, j]));
  assert.equal(byId[a.id].column, "Needs you");
  assert.equal(byId[a.id].needsYou.action, "answer");
  assert.equal(byId[a.id].needsYou.question, "# Decision 1\nWhich?");
  assert.equal(byId[a.id].needsYou.command, `sfactory job answer ${a.id}`);
  assert.deepEqual(byId[a.id].files, ["decisions/1.md", "plan/questionnaire.md", "run.log"]);
  assert.equal(byId[a.id].cost.usd, 1.5);
  assert.equal(byId[a.id].elapsedMs, 600000);
  assert.deepEqual(byId[b.id].needsYou, { action: "approve", command: `sfactory job approve ${b.id}` });
  assert.equal(byId[p.id].column, "Pushed / PR");
  assert.deepEqual(byId[p.id].needsYou, { action: "merged", command: `sfactory job merged ${p.id}` });
  assert.equal(byId[p.id].prText, "PR body");
  assert.equal(byId[p.id].elapsedMs, 300000);
  assert.equal(byId[a.id].prText, null);
  assert.deepEqual(s.ports, [{ id: p.id, ports: { block: 4000, api: 4000, web: 4001 } }]);
  assert.equal(s.locks.live.held, true);
  assert.equal(s.locks.suite.held, false);
  const text = JSON.stringify(s);
  assert.ok(!text.includes("lockToken") && !text.includes("SECRET") && !text.includes("token"));
  for (const j of s.jobs) assert.ok(!("lockToken" in j) && !("history" in j));
});

test("snapshot: parallel proposal, stopped column, ports of live jobs", () => {
  const { c, set } = setup();
  const a = addJob(c, "milestone", "Par", { now: T0 });
  const b = addJob(c, "fix", "Stop", { now: T0 });
  set(a.id, (j) => park(j, { reason: "r", pending: "parallel", now: T0 }));
  writeJobFile(c, a.id, "plan/parallel.md", "go parallel?");
  set(a.id, (j) => { j.ports = [1, 2]; return j; });
  set(b.id, (j) => { j.stage = "stopped"; return j; });
  const s = buildSnapshot(c, { now: NOW });
  const byId = Object.fromEntries(s.jobs.map((j) => [j.id, j]));
  assert.equal(byId[a.id].needsYou.action, "parallel");
  assert.equal(byId[a.id].needsYou.reason, "go parallel?");
  assert.equal(byId[a.id].needsYou.command, `sfactory job parallel ${a.id} --yes|--no`);
  assert.equal(byId[b.id].column, "Stopped");
  assert.equal(byId[b.id].needsYou, null);
  assert.deepEqual(s.ports, [{ id: a.id, ports: [1, 2] }]);
  assert.equal(s.board.pollMs, 1500);
  assert.equal(buildSnapshot({ stateDir: c.stateDir }, { now: NOW }).board.pollMs, 2000);
});

test("snapshot: active is set for a working stage updated inside board.activeMs, absent otherwise", () => {
  const { c, set } = setup();
  const a = addJob(c, "fix", "Fresh", { now: T0 });
  const b = addJob(c, "fix", "Stale", { now: T0 });
  const d = addJob(c, "fix", "Waiting", { now: T0 });
  // writeJob stamps the real clock, so the fixed "updated" values go straight into job.json
  const stamp = (id, stage, updated) => { const f = join(jobDir(c, id), "job.json"); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), stage, updated })); };
  stamp(a.id, "building", "2026-10-27T10:08:30.000Z");
  stamp(b.id, "building", "2026-10-27T10:07:00.000Z");
  stamp(d.id, "awaiting-approval", NOW);
  const by = (s) => Object.fromEntries(s.jobs.map((j) => [j.id, j]));
  let s = by(buildSnapshot(c, { now: NOW }));
  assert.equal(s[a.id].active, true);
  assert.equal("active" in s[b.id], false, "180 s old, default window 120 s");
  assert.equal("active" in s[d.id], false, "not a working stage");
  c.board.activeMs = 200000;
  s = by(buildSnapshot(c, { now: NOW }));
  assert.equal(s[b.id].active, true, "inside a configured window");
  c.board.activeMs = 1000;
  assert.equal("active" in by(buildSnapshot(c, { now: NOW }))[a.id], false);
});

test("snapshot: reviews are the latest three verdict files, first line only, absent when none", () => {
  const { c } = setup();
  const a = addJob(c, "fix", "Reviewed", { now: T0 });
  const b = addJob(c, "fix", "Unreviewed", { now: T0 });
  writeJobFile(c, a.id, "reviews/a-0.md", "✅ Approved");
  writeJobFile(c, a.id, "reviews/b-1.md", "# Review\n❌ Needs fixes");
  writeJobFile(c, a.id, "reviews/c-2.md", "❌ Needs fixes\nbody ✅");
  writeJobFile(c, a.id, "reviews/d-3.md", "Status: ok\n");
  writeJobFile(c, a.id, "reviews/e-4.md", "just notes");
  writeJobFile(c, a.id, "reviews/sub/x.md", "✅");
  writeJobFile(c, b.id, "reviews/only.md", "just notes");
  const s = buildSnapshot(c, { now: NOW });
  const byId = Object.fromEntries(s.jobs.map((j) => [j.id, j]));
  // the latest three by name are c-2, d-3 and e-4; e-4 says neither and is left out
  assert.deepEqual(byId[a.id].reviews, [{ file: "reviews/c-2.md", verdict: "bad" }, { file: "reviews/d-3.md", verdict: "good" }]);
  assert.equal("reviews" in byId[b.id], false);
  assert.equal("active" in byId[a.id], false);
});

test("snapshot: demo is present only when asked for", () => {
  const { c } = setup();
  assert.equal("demo" in buildSnapshot(c, { now: NOW }), false);
  assert.equal(buildSnapshot(c, { now: NOW, demo: true }).demo, true);
});

test("snapshot: a demo snapshot measures elapsed against the latest stamp in its jobs", () => {
  const { c } = setup();
  const a = addJob(c, "fix", "Old demo", { now: T0 });
  const file = join(jobDir(c, a.id), "job.json"); // fixed stamps, as a demo folder carries them
  const raw = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...raw, updated: "2026-10-27T10:30:00.000Z" }));
  const s = buildSnapshot(c, { demo: true });
  assert.equal(s.generatedAt, "2026-10-27T10:30:00.000Z");
  assert.equal(s.jobs[0].elapsedMs, 30 * 60 * 1000);
});
