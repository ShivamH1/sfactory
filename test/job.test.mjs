import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES, TRANSITIONS, COLUMNS, WORKING, newJob, transition, park, release, stop, resume } from "../src/job.mjs";

const now = "2026-10-27T10:00:00.000Z";

test("job: every stage has a column and a transition entry", () => {
  for (const s of STAGES) { assert.ok(COLUMNS[s], s); assert.ok(Array.isArray(TRANSITIONS[s]), s); }
  for (const [s, nexts] of Object.entries(TRANSITIONS)) for (const n of nexts) assert.ok(STAGES.includes(n), `${s} -> ${n}`);
});

test("job: TRANSITIONS is exactly the specified edge set", () => {
  const want = {
    backlog: ["planning"], planning: ["awaiting-approval", "building"], "awaiting-approval": ["building"], building: ["reviewing"],
    reviewing: ["fixing", "verifying", "building"], fixing: ["reviewing"], verifying: ["pushing", "fixing"], pushing: ["pushed"],
    pushed: ["merged", "building"], merged: [], "decision-needed": [], stopped: [],
  };
  for (const from of STAGES) for (const to of STAGES) {
    assert.equal(TRANSITIONS[from].includes(to), want[from].includes(to), `${from} -> ${to}`);
  }
});

test("job: the main line for a milestone", () => {
  let j = newJob({ id: "m-1", kind: "milestone", title: "t", now });
  assert.equal(j.stage, "backlog");
  for (const to of ["planning", "awaiting-approval", "building", "reviewing", "verifying", "pushing", "pushed", "merged"]) j = transition(j, to, { by: "test", now });
  assert.equal(j.stage, "merged");
  assert.equal(j.ended, now);
  assert.equal(j.history.length, 9);
  assert.deepEqual(j.history[0], { at: now, from: null, to: "backlog", by: "session", reason: "created" });
  assert.deepEqual(j.history[1], { at: now, from: "backlog", to: "planning", by: "test", reason: null });
});

test("job: a fix skips approval and a milestone may not", () => {
  const f = transition(newJob({ id: "f-1", kind: "fix", title: "t", now }), "planning", { now });
  assert.equal(transition(f, "building", { now }).stage, "building");
  const m = transition(newJob({ id: "m-1", kind: "milestone", title: "t", now }), "planning", { now });
  assert.throws(() => transition(m, "building", { now }), (e) => e.code === "ILLEGAL_TRANSITION");
});

test("job: illegal edges are refused and the job is not mutated", () => {
  const j = newJob({ id: "m-1", kind: "milestone", title: "t", now });
  assert.throws(() => transition(j, "pushed", { now }), (e) => e.code === "ILLEGAL_TRANSITION" && /backlog -> pushed/.test(e.message));
  assert.throws(() => transition(j, "nowhere", { now }), (e) => e.code === "ILLEGAL_TRANSITION");
  assert.equal(j.stage, "backlog");
  assert.equal(j.history.length, 1);
});

test("job: fix loop and the rework edges", () => {
  let j = newJob({ id: "m-1", kind: "milestone", title: "t", now });
  for (const to of ["planning", "awaiting-approval", "building", "reviewing"]) j = transition(j, to, { now });
  j = transition(j, "fixing", { now });
  assert.equal(j.round, 1);
  j = transition(j, "reviewing", { now });
  j = transition(j, "fixing", { now });
  assert.equal(j.round, 2);
  j = transition(j, "reviewing", { now });
  j = transition(j, "building", { now, reason: "rework" });
  assert.equal(j.rework, 1);
  assert.throws(() => transition(transition(j, "reviewing", { now }), "pushed", { now }));
});

test("job: park from every working stage and release to it", () => {
  for (const s of WORKING) {
    const j = { ...newJob({ id: "m-1", kind: "milestone", title: "t", now }), stage: s };
    const p = park(j, { by: "session", reason: "D6 vs stories 4.2", now });
    assert.equal(p.stage, "decision-needed");
    assert.equal(p.returnStage, s);
    assert.equal(p.pending, "decision");
    const r = release(p, { by: "board", now });
    assert.equal(r.stage, s);
    assert.equal(r.returnStage, null);
    assert.equal(r.pending, null);
  }
  const b = park(newJob({ id: "m-2", kind: "milestone", title: "t", now }), { reason: "parallel?", pending: "parallel", now });
  assert.equal(b.returnStage, "backlog");
  assert.equal(b.pending, "parallel");
  assert.throws(() => park(newJob({ id: "m-4", kind: "milestone", title: "t", now }), { reason: "x", now }), (e) => e.code === "ILLEGAL_TRANSITION" && /backlog/.test(e.message));
  assert.throws(() => park({ ...newJob({ id: "m-5", kind: "milestone", title: "t", now }), stage: "building" }, { reason: "x", pending: "parallel", now }), (e) => e.code === "ILLEGAL_TRANSITION" && /building/.test(e.message));
  assert.throws(() => park({ ...newJob({ id: "m-3", kind: "milestone", title: "t", now }), stage: "merged" }, { reason: "x", now }), (e) => e.code === "ILLEGAL_TRANSITION");
});

test("job: stop remembers where it was; resume returns there; merged cannot stop", () => {
  const j = { ...newJob({ id: "m-1", kind: "milestone", title: "t", now }), stage: "fixing" };
  const s = stop(j, { reason: "usage limit", now });
  assert.equal(s.stage, "stopped");
  assert.equal(s.previousStage, "fixing");
  assert.equal(resume(s, { now }).stage, "fixing");
  assert.throws(() => stop({ ...j, stage: "merged" }, { reason: "x", now }), (e) => e.code === "ILLEGAL_TRANSITION");
});

import { tmpRepo, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { readJob, jobFileExists, writeJobFile } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";

function project() {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } });
  return root;
}
const run = (root, args) => { const out = [], err = []; return main(args, { cwd: root, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }).then((code) => ({ code, out: out.join(""), err: err.join("") })); };

test("job cmd: add, set, approve path with its refusal", async () => {
  const root = project(); const c = loadConfig(root);
  let r = await run(root, ["job", "add", "milestone", "M1 thing"]);
  assert.equal(r.code, 0); assert.match(r.out, /m-1 backlog/);
  r = await run(root, ["job", "set", "m-1", "planning"]); assert.equal(r.code, 0);
  r = await run(root, ["job", "set", "m-1", "awaiting-approval"]); assert.equal(r.code, 0);
  r = await run(root, ["job", "set", "m-1", "building"]);
  assert.equal(r.code, 2); assert.match(r.err, /APPROVAL_REQUIRED/);
  r = await run(root, ["job", "approve", "m-1", "--by", "board"]);
  assert.equal(r.code, 0);
  assert.equal(readJob(c, "m-1").stage, "building");
  assert.equal(jobFileExists(c, "m-1", "plan/approval.md"), true);
  assert.equal(readJob(c, "m-1").history.at(-1).by, "board");
});

test("job cmd: park, answer requires the answer file, parallel yes/no", async () => {
  const root = project(); const c = loadConfig(root);
  await run(root, ["job", "add", "fix", "small"]);
  await run(root, ["job", "set", "f-1", "planning"]);
  await run(root, ["job", "set", "f-1", "building"]);
  let r = await run(root, ["job", "park", "f-1", "--reason", "D6 question"]);
  assert.equal(r.code, 0); assert.equal(readJob(c, "f-1").stage, "decision-needed");
  assert.equal(jobFileExists(c, "f-1", "decisions/1.md"), true);
  r = await run(root, ["job", "answer", "f-1"]);
  assert.equal(r.code, 2); assert.match(r.err, /ANSWER_REQUIRED/);
  writeJobFile(c, "f-1", "decisions/1-answer.md", "go with B\n");
  r = await run(root, ["job", "answer", "f-1", "--by", "board"]);
  assert.equal(r.code, 0); assert.equal(readJob(c, "f-1").stage, "building");

  await run(root, ["job", "park", "f-1", "--reason", "again"]);
  r = await run(root, ["job", "park", "f-1", "--reason", "again"]);
  assert.equal(r.code, 2); assert.match(r.err, /ILLEGAL_TRANSITION/);
  assert.equal(jobFileExists(c, "f-1", "decisions/3.md"), false);

  await run(root, ["job", "add", "milestone", "M2"]);
  r = await run(root, ["job", "park", "m-1", "--reason", "parallel check passed", "--pending", "parallel"]);
  assert.equal(r.code, 0);
  assert.equal(jobFileExists(c, "m-1", "plan/parallel.md"), true);
  r = await run(root, ["job", "parallel", "m-1", "--no"]);
  assert.equal(r.code, 0); assert.equal(readJob(c, "m-1").stage, "backlog"); assert.equal(readJob(c, "m-1").parallel, "queued");
  r = await run(root, ["job", "parallel", "m-1", "--yes"]);
  assert.equal(r.code, 2); assert.match(r.err, /ILLEGAL_TRANSITION/);
});

test("job cmd: stop/resume, merged, rework writes notes, list and show", async () => {
  const root = project(); const c = loadConfig(root);
  await run(root, ["job", "add", "fix", "x"]);
  for (const s of ["planning", "building", "reviewing", "verifying", "pushing", "pushed"]) await run(root, ["job", "set", "f-1", s]);
  let r = await run(root, ["job", "rework", "f-1", "--notes", "keep the query client out of it"]);
  assert.equal(r.code, 0); assert.equal(readJob(c, "f-1").stage, "building");
  assert.equal(jobFileExists(c, "f-1", "rework/1.md"), true);
  r = await run(root, ["job", "stop", "f-1", "--reason", "usage limit"]); assert.equal(readJob(c, "f-1").stage, "stopped");
  r = await run(root, ["job", "resume", "f-1"]); assert.equal(readJob(c, "f-1").stage, "building");
  for (const s of ["reviewing", "verifying", "pushing", "pushed"]) await run(root, ["job", "set", "f-1", s]);
  r = await run(root, ["job", "merged", "f-1"]); assert.equal(readJob(c, "f-1").stage, "merged");
  r = await run(root, ["job", "list"]); assert.match(r.out, /f-1\s+merged/);
  r = await run(root, ["job", "show", "f-1", "--json"]); assert.equal(JSON.parse(r.out).id, "f-1");
});

test("job cmd: a double park leaves no stray decision file; answer still works", async () => {
  const root = project(); const c = loadConfig(root);
  await run(root, ["job", "add", "fix", "x"]);
  await run(root, ["job", "set", "f-1", "planning"]);
  await run(root, ["job", "set", "f-1", "building"]);
  await run(root, ["job", "park", "f-1", "--reason", "q"]);
  const r = await run(root, ["job", "park", "f-1", "--reason", "q2"]);
  assert.equal(r.code, 2); assert.match(r.err, /ILLEGAL_TRANSITION/);
  assert.equal(jobFileExists(c, "f-1", "decisions/2.md"), false);
  writeJobFile(c, "f-1", "decisions/1-answer.md", "ok");
  assert.equal((await run(root, ["job", "answer", "f-1"])).code, 0);
});

test("job cmd: rework is refused outside reviewing or pushed", async () => {
  const root = project(); const c = loadConfig(root);
  await run(root, ["job", "add", "fix", "x"]);
  await run(root, ["job", "set", "f-1", "planning"]);
  await run(root, ["job", "set", "f-1", "building"]);
  const r = await run(root, ["job", "rework", "f-1", "--notes", "n"]);
  assert.equal(r.code, 2); assert.match(r.err, /ILLEGAL_TRANSITION/);
  assert.equal(jobFileExists(c, "f-1", "rework/0.md"), false);
  assert.equal(jobFileExists(c, "f-1", "rework/1.md"), false);
});

test("job cmd: set building from reviewing or pushed is refused, pointing at rework", async () => {
  const root = project(); const c = loadConfig(root);
  await run(root, ["job", "add", "fix", "x"]);
  for (const s of ["planning", "building", "reviewing"]) await run(root, ["job", "set", "f-1", s]);
  let r = await run(root, ["job", "set", "f-1", "building"]);
  assert.equal(r.code, 2); assert.match(r.err, /ILLEGAL_TRANSITION.*job rework f-1/);
  assert.equal(readJob(c, "f-1").stage, "reviewing");
  assert.equal(readJob(c, "f-1").rework, 0);
  for (const s of ["verifying", "pushing", "pushed"]) await run(root, ["job", "set", "f-1", s]);
  r = await run(root, ["job", "set", "f-1", "building"]);
  assert.equal(r.code, 2); assert.match(r.err, /job rework/);
  assert.equal(readJob(c, "f-1").stage, "pushed");
});

test("job cmd: touch marks a working stage; elsewhere it prints (not touched) and exits 0; a bare --note is BAD_ARGS", async () => {
  const root = project(); const c = loadConfig(root);
  await run(root, ["job", "add", "milestone", "M1 touch"]);
  const before = readJob(c, "m-1");
  let r = await run(root, ["job", "touch", "m-1", "--note", "early"]);
  assert.equal(r.code, 0); assert.equal(r.out, "m-1 backlog (not touched)\n");
  assert.deepEqual(readJob(c, "m-1"), before);
  await run(root, ["job", "set", "m-1", "planning"]);
  r = await run(root, ["job", "touch", "m-1", "--note", "start brainstorming"]);
  assert.equal(r.code, 0); assert.equal(r.out, "m-1 planning\n");
  assert.equal(readJob(c, "m-1").activity.note, "start brainstorming");
  r = await run(root, ["job", "touch", "m-1", "--note"]);
  assert.equal(r.code, 2); assert.match(r.err, /BAD_ARGS/);
  await run(root, ["job", "set", "m-1", "awaiting-approval"]);
  const parked = readJob(c, "m-1");
  r = await run(root, ["job", "touch", "m-1", "--note", "late finish"]);
  assert.equal(r.code, 0); assert.equal(r.out, "m-1 awaiting-approval (not touched)\n");
  assert.deepEqual(readJob(c, "m-1"), parked, "awaiting-approval is not re-stamped (the board's Approve-after-viewing keys on it)");
});

test("job: a parallel proposal parks from backlog or planning; planning may also park a decision; a queued planning card goes back to backlog", async () => {
  const { PARK_PENDING, queue } = await import("../src/job.mjs");
  assert.deepEqual(PARK_PENDING.backlog, ["parallel"]);
  assert.deepEqual([...PARK_PENDING.planning].sort(), ["decision", "parallel"]);
  for (const s of WORKING.filter((x) => x !== "planning")) assert.deepEqual(PARK_PENDING[s], ["decision"], s);
  const j = { ...newJob({ id: "m-2", kind: "milestone", title: "t", now }), stage: "planning", worktree: "/w" };
  const p = park(j, { reason: "parallel rows", pending: "parallel", now });
  assert.equal(p.stage, "decision-needed"); assert.equal(p.returnStage, "planning"); assert.equal(p.pending, "parallel");
  assert.equal(release(p, { now }).stage, "planning");
  const q = queue(p, { by: "board", now });
  assert.equal(q.stage, "backlog"); assert.equal(q.returnStage, null); assert.equal(q.pending, null); assert.equal(q.worktree, "/w");
  assert.deepEqual({ from: q.history.at(-1).from, to: q.history.at(-1).to, reason: q.history.at(-1).reason }, { from: "decision-needed", to: "backlog", reason: "queued" });
  assert.throws(() => queue({ ...p, pending: "decision" }, { now }), (e) => e.code === "ILLEGAL_TRANSITION");
  assert.throws(() => queue(j, { now }), (e) => e.code === "ILLEGAL_TRANSITION");
});
