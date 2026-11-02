import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { addJob, writeJobFile } from "../src/store.mjs";
import { writeFileSync, rmSync } from "node:fs";
import { appendEvent, eventsPath, encodeEvent } from "../src/events.mjs";
import { activity, tail, TAIL_MAX } from "../src/board/activity.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-act-"), limits: { lockStaleMs: 60_000 } });
const t = (m) => `2026-11-02T11:${String(m).padStart(2, "0")}:00.000Z`;
const notes = (r) => r.events.filter((e) => e.kind === "note").map((e) => `${e.id} ${e.text}`);

test("activity: first call gives the newest events oldest first and a cursor at the end", () => {
  const c = cfg(); addJob(c, "milestone", "a"); addJob(c, "milestone", "b");
  appendEvent(c, "m-1", { kind: "note", text: "one" }, { now: t(1) });
  appendEvent(c, "m-2", { kind: "note", text: "two" }, { now: t(2) });
  appendEvent(c, "m-1", { kind: "note", text: "three" }, { now: t(3) });
  const r = activity(c, {});
  assert.deepEqual(notes(r), ["m-1 one", "m-2 two", "m-1 three"]);
  assert.ok(r.events.every((e) => !("end" in e)));
  assert.deepEqual(notes(activity(c, { cursor: r.cursor })), []);
  appendEvent(c, "m-2", { kind: "note", text: "four" }, { now: t(4) });
  addJob(c, "fix", "c");
  appendEvent(c, "f-1", { kind: "note", text: "five" }, { now: t(5) });
  assert.deepEqual(notes(activity(c, { cursor: r.cursor })), ["m-2 four", "f-1 five"]);
});

test("activity: the cursor leaves out cards whose log is empty", () => {
  const c = cfg(); addJob(c, "milestone", "a"); addJob(c, "milestone", "b"); addJob(c, "milestone", "c");
  for (const id of ["m-1", "m-2", "m-3"]) rmSync(eventsPath(c, id), { force: true }); // cards with no history
  appendEvent(c, "m-2", { kind: "note", text: "one" }, { now: t(1) });
  const o = JSON.parse(Buffer.from(activity(c, {}).cursor, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(o), ["m-2"]);
});

test("activity: a limit never skips an event; the rest comes on the next call", () => {
  const c = cfg(); addJob(c, "milestone", "a"); addJob(c, "milestone", "b");
  const start = activity(c, {}).cursor;
  for (let i = 1; i <= 6; i++) appendEvent(c, i % 2 ? "m-1" : "m-2", { kind: "note", text: `n${i}` }, { now: t(i) });
  const seen = [];
  let cur = start;
  for (let k = 0; k < 5; k++) { const r = activity(c, { cursor: cur, limit: 2 }); seen.push(...notes(r)); cur = r.cursor; }
  assert.deepEqual(seen, ["m-1 n1", "m-2 n2", "m-1 n3", "m-2 n4", "m-1 n5", "m-2 n6"]);
});

test("activity: a log that shrank under a cut cursor is read from its start, each event once", { timeout: 5000 }, () => {
  const c = cfg(); addJob(c, "milestone", "a"); addJob(c, "milestone", "b");
  for (let i = 1; i <= 6; i++) appendEvent(c, "m-1", { kind: "note", text: `old${i}` }, { now: t(i) });
  let cur = activity(c, {}).cursor;
  const lines = [1, 2, 3].map((i) => encodeEvent({ at: t(10 + i), by: "x", kind: "note", text: `new${i}` }));
  writeFileSync(eventsPath(c, "m-1"), lines.join(""));
  const seen = [];
  for (let k = 0; k < 5; k++) { const r = activity(c, { cursor: cur, limit: 2 }); seen.push(...notes(r)); cur = r.cursor; }
  assert.deepEqual(seen, ["m-1 new1", "m-1 new2", "m-1 new3"]);
});

test("activity: limit is clamped, a foreign cursor refused, running agents listed", () => {
  const c = cfg(); addJob(c, "milestone", "a");
  assert.throws(() => activity(c, { cursor: "not-ours" }), (e) => e.code === "BAD_ARGS");
  for (let i = 0; i < 3; i++) appendEvent(c, "m-1", { kind: "note", text: `n${i}` }, { now: t(i) });
  assert.equal(activity(c, { limit: 0 }).events.filter((e) => e.kind === "note").length, 1);
  assert.deepEqual(activity(c, {}).running, []);
});

test("tail: reads a card's log from an offset, refuses other files", () => {
  const c = cfg(); addJob(c, "milestone", "a");
  writeJobFile(c, "m-1", "tasks/1/suite-0.log", "line one\nline two\n");
  const r = tail(c, "m-1", "tasks/1/suite-0.log", 0);
  assert.equal(r.text, "line one\nline two\n"); assert.equal(r.next, r.size);
  assert.equal(tail(c, "m-1", "tasks/1/suite-0.log", 9).text, "line two\n");
  assert.equal(tail(c, "m-1", "tasks/1/suite-0.log", 999).from, 0);
  assert.throws(() => tail(c, "m-1", "job.json", 0), (e) => e.code === "FORBIDDEN_FILE");
  assert.throws(() => tail(c, "m-1", "../m-1/job.json", 0), (e) => e.code === "FORBIDDEN_FILE");
  assert.throws(() => tail(c, "m-1", "../../x.log", 0), (e) => e.code === "FORBIDDEN_FILE");
  assert.throws(() => tail(c, "m-1", "missing.log", 0), (e) => e.code === "FILE_NOT_FOUND");
  assert.throws(() => tail(c, "m-9", "a.log", 0), (e) => e.code === "JOB_NOT_FOUND");
});

test("tail: a full read is cut after its last newline", () => {
  const c = cfg(); addJob(c, "milestone", "a");
  const line = `${"x".repeat(99)}\n`;
  writeJobFile(c, "m-1", "big.log", line.repeat(Math.ceil((TAIL_MAX * 2) / line.length)));
  const r = tail(c, "m-1", "big.log", 0);
  assert.ok(r.text.endsWith("\n")); assert.ok(r.next - r.from <= TAIL_MAX); assert.equal(r.next % line.length, 0);
});
