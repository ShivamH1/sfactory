import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { actions } from "../src/job-actions.mjs";
import { readJob, jobFileExists, readJobFile, writeJobFile } from "../src/store.mjs";
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
  actions.park(c, { id: "m-1", reason: "parallel check passed", pending: "parallel" });
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
  assert.deepEqual({ ...j.history.at(-1), at: 0 }, { at: 0, from: "awaiting-approval", to: "awaiting-approval", by: "board", reason: "changes requested" });
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
