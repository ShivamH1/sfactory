import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { actions, OFF_STAGES, activeMilestones } from "../src/job-actions.mjs";
import { newJob } from "../src/job.mjs";
import { createJobFolder } from "../src/store.mjs";
import { readJob, jobFileExists, readJobFile, writeJobFile, withJobLock, writeJob } from "../src/store.mjs";
import { acquireSync, status } from "../src/lock.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-ja-"), limits: { lockStaleMs: 60_000 } });
const unheld = (c, id) => assert.equal(status(c, `job:${id}`).held, false, `job:${id} is still held`);
const throwsCode = (fn, code, re) => assert.throws(fn, (e) => e.code === code && (!re || re.test(e.message)), `${code}`);

test("actions: add, set, approve path with its refusal", () => {
  const c = cfg();
  let j = actions.add(c, { kind: "milestone", title: "M1 thing" });
  assert.equal(j.id, "m-1"); assert.equal(j.stage, "backlog");
  actions.set(c, { id: "m-1", to: "planning" });
  actions.set(c, { id: "m-1", to: "awaiting-approval" });
  throwsCode(() => actions.set(c, { id: "m-1", to: "building" }), "APPROVAL_REQUIRED");
  j = actions.approve(c, { id: "m-1", by: "board" });
  assert.equal(j.stage, "building");
  assert.equal(jobFileExists(c, "m-1", "plan/approval.md"), true);
  assert.equal(readJob(c, "m-1").history.at(-1).by, "board");
  throwsCode(() => actions.approve(c, { id: "m-1" }), "ILLEGAL_TRANSITION");
  unheld(c, "m-1");
});

test("actions: by defaults to session", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "x" });
  assert.equal(actions.set(c, { id: "f-1", to: "planning" }).history.at(-1).by, "session");
});

test("actions: park, answer requires the answer file, parallel yes/no", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "small" });
  for (const s of ["planning", "building"]) actions.set(c, { id: "f-1", to: s });
  assert.equal(actions.park(c, { id: "f-1", reason: "D6 question" }).stage, "decision-needed");
  assert.equal(jobFileExists(c, "f-1", "decisions/1.md"), true);
  throwsCode(() => actions.answer(c, { id: "f-1" }), "ANSWER_REQUIRED");
  writeJobFile(c, "f-1", "decisions/1-answer.md", "go with B\n");
  assert.equal(actions.answer(c, { id: "f-1", by: "board" }).stage, "building");
  actions.park(c, { id: "f-1", reason: "again" });
  throwsCode(() => actions.park(c, { id: "f-1", reason: "again" }), "ILLEGAL_TRANSITION");
  assert.equal(jobFileExists(c, "f-1", "decisions/3.md"), false);
  throwsCode(() => actions.park(c, { id: "f-1" }), "BAD_ARGS");

  actions.add(c, { kind: "milestone", title: "M2" });
  actions.park(c, { id: "m-1", reason: "parallel check passed", pending: "parallel", with: "f-1" });
  assert.equal(jobFileExists(c, "m-1", "plan/parallel.md"), true);
  throwsCode(() => actions.parallel(c, { id: "m-1" }), "BAD_ARGS");
  const j = actions.parallel(c, { id: "m-1", yes: false });
  assert.equal(j.stage, "backlog"); assert.equal(j.parallel, "queued");
  throwsCode(() => actions.parallel(c, { id: "m-1", yes: true }), "ILLEGAL_TRANSITION");
  unheld(c, "f-1"); unheld(c, "m-1");
});

test("actions: answer({ text }) writes the answer file and releases", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "x" });
  for (const s of ["planning", "building"]) actions.set(c, { id: "f-1", to: s });
  actions.park(c, { id: "f-1", reason: "q" });
  const j = actions.answer(c, { id: "f-1", text: "take A", by: "board" });
  assert.equal(j.stage, "building");
  assert.equal(readJobFile(c, "f-1", "decisions/1-answer.md").trim(), "take A");
  unheld(c, "f-1");
  actions.park(c, { id: "f-1", reason: "q2" });
  throwsCode(() => actions.answer(c, { id: "f-1", text: "   " }), "ANSWER_REQUIRED");
});

test("actions: stop/resume, merged, rework, list and show", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "x" });
  for (const s of ["planning", "building", "reviewing", "verifying", "pushing", "pushed"]) actions.set(c, { id: "f-1", to: s });
  assert.equal(actions.rework(c, { id: "f-1", notes: "keep it small" }).stage, "building");
  assert.equal(jobFileExists(c, "f-1", "rework/1.md"), true);
  throwsCode(() => actions.rework(c, { id: "f-1" }), "BAD_ARGS");
  throwsCode(() => actions.rework(c, { id: "f-1", notes: "  " }), "BAD_ARGS");
  throwsCode(() => actions.rework(c, { id: "f-1", notes: "n" }), "ILLEGAL_TRANSITION");
  assert.equal(actions.stop(c, { id: "f-1", reason: "usage limit" }).stage, "stopped");
  assert.equal(actions.resume(c, { id: "f-1" }).stage, "building");
  for (const s of ["reviewing", "verifying", "pushing", "pushed"]) actions.set(c, { id: "f-1", to: s });
  assert.equal(actions.merged(c, { id: "f-1" }).stage, "merged");
  assert.equal(actions.list(c).length, 1);
  assert.equal(actions.show(c, { id: "f-1" }).id, "f-1");
  unheld(c, "f-1");
});

test("actions: set building from reviewing or pushed points at rework", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "x" });
  for (const s of ["planning", "building", "reviewing"]) actions.set(c, { id: "f-1", to: s });
  throwsCode(() => actions.set(c, { id: "f-1", to: "building" }), "ILLEGAL_TRANSITION", /job rework f-1/);
  assert.equal(readJob(c, "f-1").rework, 0);
});

test("actions: requestChanges only in awaiting-approval, writes changes-<k>.md, keeps the stage", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "M" });
  throwsCode(() => actions.requestChanges(c, { id: "m-1", notes: "n" }), "ILLEGAL_TRANSITION");
  actions.set(c, { id: "m-1", to: "planning" });
  throwsCode(() => actions.requestChanges(c, { id: "m-1", notes: "n" }), "ILLEGAL_TRANSITION");
  actions.set(c, { id: "m-1", to: "awaiting-approval" });
  throwsCode(() => actions.requestChanges(c, { id: "m-1" }), "BAD_ARGS");
  const j = actions.requestChanges(c, { id: "m-1", notes: "split task 3", by: "board" });
  assert.equal(j.stage, "awaiting-approval");
  assert.match(readJobFile(c, "m-1", "plan/changes-1.md"), /split task 3/);
  assert.deepEqual({ ...j.history.at(-1), at: 0 }, { at: 0, from: "awaiting-approval", to: "awaiting-approval", by: "board", reason: "changes requested", file: "plan/changes-1.md" });
  actions.requestChanges(c, { id: "m-1", notes: "again" });
  assert.equal(jobFileExists(c, "m-1", "plan/changes-2.md"), true);
  unheld(c, "m-1");
});

test("actions: a job held by another holder is JOB_BUSY, and the lock is untouched", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "x" });
  const l = acquireSync(c, "job:f-1", { holder: "other" });
  try {
    throwsCode(() => actions.set(c, { id: "f-1", to: "planning" }), "JOB_BUSY");
    const s = status(c, "job:f-1");
    assert.equal(s.held, true); assert.equal(s.holder, "other");
  } finally { l.release(); }
  assert.equal(readJob(c, "f-1").stage, "backlog");
  assert.equal(actions.set(c, { id: "f-1", to: "planning" }).stage, "planning");
});

test("actions: board input is validated (park pending, answer text)", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "x" });
  actions.set(c, { id: "f-1", to: "planning" });
  throwsCode(() => actions.park(c, { id: "f-1", reason: "r", pending: "bogus" }), "BAD_ARGS");
  throwsCode(() => actions.park(c, { id: "f-1", reason: "r", pending: 5 }), "BAD_ARGS");
  assert.equal(readJob(c, "f-1").stage, "planning");
  actions.park(c, { id: "f-1", reason: "r", pending: "decision" });
  throwsCode(() => actions.answer(c, { id: "f-1", text: 42 }), "BAD_ARGS");
  throwsCode(() => actions.answer(c, { id: "f-1", text: null }), "BAD_ARGS");
  assert.equal(readJob(c, "f-1").stage, "decision-needed");
  unheld(c, "f-1");
});

test("actions: add with a bad kind is BAD_ARGS and leaves no folder", () => {
  const c = cfg();
  throwsCode(() => actions.add(c, { kind: "bogus", title: "t" }), "BAD_ARGS");
  throwsCode(() => actions.add(c, { kind: "milestone ", title: "t" }), "BAD_ARGS");
  assert.deepEqual(existsSync(join(c.stateDir, "jobs")) ? readdirSync(join(c.stateDir, "jobs")) : [], []);
});

test("actions: answer with no decision file is refused and writes nothing", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "x" });
  // a decision-needed job whose decisions/<k>.md is missing
  withJobLockForTest(c, "f-1", (j) => { j.stage = "decision-needed"; j.pending = "decision"; j.returnStage = "building"; });
  throwsCode(() => actions.answer(c, { id: "f-1", text: "yes" }), "ILLEGAL_TRANSITION", /no decision/);
  assert.equal(jobFileExists(c, "f-1", "decisions/0-answer.md"), false);
});
function withJobLockForTest(c, id, mutate) {
  return withJobLock(c, id, () => { const j = readJob(c, id); mutate(j); return writeJob(c, j); });
}

test("actions: set applies the config's fix-round cap (moved here from commands/job.mjs in the board merge)", () => {
  const c = { ...cfg(), limits: { lockStaleMs: 60_000, fixRounds: 1 } };
  actions.add(c, { kind: "fix", title: "F1 thing" });
  for (const to of ["planning", "building", "reviewing", "fixing", "reviewing"]) actions.set(c, { id: "f-1", to });
  assert.equal(readJob(c, "f-1").round, 1);
  throwsCode(() => actions.set(c, { id: "f-1", to: "fixing" }), "FIX_ROUNDS_EXHAUSTED", /1 of 1/);
  assert.equal(readJob(c, "f-1").stage, "reviewing");
  unheld(c, "f-1");
});

test("actions: touch stamps updated and activity, changes no stage or history, validates the note", () => {
  const c = cfg();
  actions.add(c, { kind: "fix", title: "F" });
  actions.set(c, { id: "f-1", to: "planning" });
  const before = readJob(c, "f-1");
  const j = actions.touch(c, { id: "f-1", note: "writing the plan", by: "claude" });
  assert.equal(j.stage, before.stage);
  assert.equal(j.history.length, before.history.length);
  assert.equal(j.activity.note, "writing the plan"); assert.equal(j.activity.by, "claude");
  assert.ok(Date.parse(j.updated) >= Date.parse(before.updated));
  assert.equal(actions.touch(c, { id: "f-1" }).activity.note, undefined);
  throwsCode(() => actions.touch(c, { id: "f-1", note: "x".repeat(201) }), "BAD_ARGS");
  throwsCode(() => actions.touch(c, { id: "f-1", note: 5 }), "BAD_ARGS");
  unheld(c, "f-1");
});

test("actions: touch writes nothing outside a working stage and returns the job unchanged", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "M" });
  for (const to of [null, "planning", "awaiting-approval"]) {
    if (to) actions.set(c, { id: "m-1", to });
    if (to === "planning") { assert.ok(actions.touch(c, { id: "m-1", note: "n" }).activity, "planning is a working stage"); continue; }
    const before = readJob(c, "m-1");
    assert.deepEqual(actions.touch(c, { id: "m-1", note: "n" }), before);
    assert.deepEqual(readJob(c, "m-1"), before);
  }
  unheld(c, "m-1");
});

test("actions: a parallel proposal from planning - yes returns to planning, no queues the card in backlog", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "A" });
  actions.add(c, { kind: "milestone", title: "B" });
  for (const id of ["m-1", "m-2"]) actions.set(c, { id, to: "planning" });
  actions.park(c, { id: "m-1", reason: "rows: files ok", pending: "parallel", with: "m-2" });
  assert.match(readJobFile(c, "m-1", "plan/parallel.md"), /rows: files ok/);
  let j = actions.parallel(c, { id: "m-1", yes: true });
  assert.equal(j.stage, "planning"); assert.equal(j.parallel, "approved");
  actions.park(c, { id: "m-2", reason: "rows: files FAIL", pending: "parallel", with: "m-1" });
  j = actions.parallel(c, { id: "m-2", yes: false });
  assert.equal(j.stage, "backlog"); assert.equal(j.parallel, "queued");
  unheld(c, "m-1"); unheld(c, "m-2");
});

test("actions: a parallel park names its partner (--with): recorded as parallelWith, kept by yes and by no; refused without it, for itself or an unknown card", () => {
  const c = cfg();
  for (const t of ["A", "B", "C"]) actions.add(c, { kind: "milestone", title: t });
  actions.set(c, { id: "m-2", to: "planning" });
  throwsCode(() => actions.park(c, { id: "m-2", reason: "rows", pending: "parallel" }), "BAD_ARGS", /--with/);
  throwsCode(() => actions.park(c, { id: "m-2", reason: "rows", pending: "parallel", with: "m-2" }), "BAD_ARGS");
  throwsCode(() => actions.park(c, { id: "m-2", reason: "rows", pending: "parallel", with: "m-9" }), "JOB_NOT_FOUND");
  throwsCode(() => actions.park(c, { id: "m-2", reason: "a decision", with: "m-1" }), "BAD_ARGS", /--with/);
  let j = actions.park(c, { id: "m-2", reason: "rows", pending: "parallel", with: "m-1" });
  assert.equal(j.parallelWith, "m-1");
  assert.match(readJobFile(c, "m-2", "plan/parallel.md"), /beside m-1/);
  j = actions.parallel(c, { id: "m-2", yes: true });
  assert.deepEqual([j.stage, j.parallel, j.parallelWith], ["planning", "approved", "m-1"]);
  actions.park(c, { id: "m-3", reason: "rows", pending: "parallel", with: "m-1" });
  j = actions.parallel(c, { id: "m-3", yes: false });
  assert.deepEqual([j.stage, j.parallel, j.parallelWith], ["backlog", "queued", "m-1"], "a queued card keeps the partner it waits on");
  unheld(c, "m-2"); unheld(c, "m-3");
});

test("I4: a milestone's start at the cap is CAP_REACHED; queued and stopped cards do not count; fixes are never capped", () => {
  const c = { ...cfg(), limits: { lockStaleMs: 60_000, parallelMilestones: 2 } };
  for (const t of ["A", "B", "C", "D"]) actions.add(c, { kind: "milestone", title: t });
  actions.set(c, { id: "m-1", to: "planning" });
  actions.set(c, { id: "m-2", to: "planning" });
  throwsCode(() => actions.set(c, { id: "m-3", to: "planning" }), "CAP_REACHED", /m-1 planning, m-2 planning/);
  assert.equal(readJob(c, "m-3").stage, "backlog", "nothing written");
  // a parallel proposal answered no puts m-2 back in backlog (queued): it no longer counts
  actions.park(c, { id: "m-2", reason: "beside m-1?", pending: "parallel", with: "m-1" });
  actions.parallel(c, { id: "m-2", yes: false });
  assert.equal(readJob(c, "m-2").parallel, "queued");
  actions.set(c, { id: "m-3", to: "planning" });
  actions.stop(c, { id: "m-3" });
  actions.set(c, { id: "m-4", to: "planning" }); // m-3 stopped: one active (m-1) + m-4
  actions.add(c, { kind: "fix", title: "F" });
  actions.set(c, { id: "f-1", to: "planning" });   // a fix is never capped
  unheld(c, "m-4");
});

test("I4: approve refuses a milestone beside an active one without a parallel yes (PARALLEL_UNANSWERED); either side of an approved pair passes", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "A" });
  actions.add(c, { kind: "milestone", title: "B" });
  actions.set(c, { id: "m-1", to: "planning" }); actions.set(c, { id: "m-1", to: "awaiting-approval" });
  actions.set(c, { id: "m-2", to: "planning" }); actions.set(c, { id: "m-2", to: "awaiting-approval" });
  throwsCode(() => actions.approve(c, { id: "m-2" }), "PARALLEL_UNANSWERED", /m-1 is active/);
  throwsCode(() => actions.approve(c, { id: "m-1" }), "PARALLEL_UNANSWERED", /m-2 is active/);
  assert.equal(jobFileExists(c, "m-2", "plan/approval.md"), false, "nothing written");
  // B asks beside A and the person says yes: both sides approve
  withJobLock(c, "m-2", () => writeJob(c, { ...readJob(c, "m-2"), stage: "planning" }));
  actions.park(c, { id: "m-2", reason: "beside m-1?", pending: "parallel", with: "m-1" });
  actions.parallel(c, { id: "m-2", yes: true });
  withJobLock(c, "m-2", () => writeJob(c, { ...readJob(c, "m-2"), stage: "awaiting-approval" }));
  assert.equal(actions.approve(c, { id: "m-1" }).stage, "building", "the side that was never asked");
  assert.equal(actions.approve(c, { id: "m-2" }).stage, "building");
  // alone, a milestone approves as before
  const d = cfg();
  actions.add(d, { kind: "milestone", title: "Solo" });
  actions.set(d, { id: "m-1", to: "planning" }); actions.set(d, { id: "m-1", to: "awaiting-approval" });
  assert.equal(actions.approve(d, { id: "m-1" }).stage, "building");
});

test("N4: resume re-checks the cap and, past approval, the parallel answer; a card resting before the cap resumes freely", () => {
  const c = { ...cfg(), limits: { lockStaleMs: 60_000, parallelMilestones: 2 } };
  for (const t of ["A", "B", "C"]) actions.add(c, { kind: "milestone", title: t });
  actions.set(c, { id: "m-1", to: "planning" });
  actions.stop(c, { id: "m-1" });
  actions.set(c, { id: "m-2", to: "planning" });
  actions.set(c, { id: "m-3", to: "planning" });
  throwsCode(() => actions.resume(c, { id: "m-1" }), "CAP_REACHED", /m-2 planning, m-3 planning/);
  assert.equal(readJob(c, "m-1").stage, "stopped", "nothing written");
  actions.stop(c, { id: "m-3" });
  assert.equal(actions.resume(c, { id: "m-1" }).stage, "planning");
  // past approval the parallel answer is needed beside another active card
  withJobLock(c, "m-1", () => writeJob(c, { ...readJob(c, "m-1"), stage: "building" }));
  actions.stop(c, { id: "m-1" });
  throwsCode(() => actions.resume(c, { id: "m-1" }), "PARALLEL_UNANSWERED", /m-2 is active/);
  actions.stop(c, { id: "m-2" });
  assert.equal(actions.resume(c, { id: "m-1" }).stage, "building", "alone, it resumes");
  // a fix is never capped
  actions.add(c, { kind: "fix", title: "F" });
  actions.set(c, { id: "f-1", to: "planning" });
  actions.stop(c, { id: "f-1" });
  assert.equal(actions.resume(c, { id: "f-1" }).stage, "planning");
  unheld(c, "m-1");
});

const put = (c, job) => { createJobFolder(c, job.id); withJobLock(c, job.id, () => writeJob(c, job)); };

test("actions: roadmap and external milestones never count toward the cap", () => {
  const c = { ...cfg(), limits: { lockStaleMs: 60_000, parallelMilestones: 1 } };
  assert.ok(OFF_STAGES.includes("roadmap") && OFF_STAGES.includes("external"));
  put(c, newJob({ id: "m-1", kind: "milestone", title: "later", stage: "roadmap" }));
  put(c, { ...newJob({ id: "m-2", kind: "milestone", title: "elsewhere" }), stage: "external" });
  assert.deepEqual(activeMilestones(c), []);
  actions.add(c, { kind: "milestone", title: "now" });
  assert.equal(actions.set(c, { id: "m-3", to: "planning" }).stage, "planning");
});

test("actions: add with a number, in roadmap, with an after line", () => {
  const c = cfg();
  const j = actions.add(c, { kind: "milestone", title: "Audit log", number: "14", roadmap: true, after: "M13" });
  assert.equal(j.stage, "roadmap"); assert.equal(j.number, "14"); assert.equal(j.after, "M13");
  throwsCode(() => actions.add(c, { kind: "milestone", title: "again", number: "14" }), "NUMBER_TAKEN", /M14 is m-1/);
  throwsCode(() => actions.add(c, { kind: "milestone", title: "bad", number: "1.2.3" }), "BAD_NUMBER");
  throwsCode(() => actions.add(c, { kind: "fix", title: "f", number: "3" }), "BAD_ARGS");
  throwsCode(() => actions.add(c, { kind: "fix", title: "f", roadmap: true }), "BAD_ARGS");
  throwsCode(() => actions.add(c, { kind: "milestone", title: "long", after: "x".repeat(81) }), "BAD_ARGS");
  assert.equal(actions.add(c, { kind: "milestone", title: "plain" }).stage, "backlog");
});
