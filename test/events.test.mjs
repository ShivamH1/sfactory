import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { EVENTS_FILE, MAX_LINE_BYTES, encodeEvent, appendEvent, eventsPath, readEvents, readAllEvents, runningAgents } from "../src/events.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-ev-") });
const card = (c, id) => { mkdirSync(join(c.stateDir, "jobs", id), { recursive: true }); return id; };
const AT = "2026-11-02T10:00:00.000Z";

test("events: appendEvent writes one JSON line with at, by and the event's fields", () => {
  const c = cfg(); card(c, "m-1");
  assert.equal(appendEvent(c, "m-1", { kind: "note", text: "hello" }, { now: AT }), true);
  assert.equal(appendEvent(c, "m-1", { kind: "gate", action: "approve", by: "board" }, { now: AT }), true);
  const lines = readFileSync(eventsPath(c, "m-1"), "utf8").split("\n");
  assert.equal(lines.length, 3); assert.equal(lines[2], "");
  assert.deepEqual(JSON.parse(lines[0]), { at: AT, by: "session", kind: "note", text: "hello" });
  assert.deepEqual(JSON.parse(lines[1]), { at: AT, by: "board", kind: "gate", action: "approve" });
  assert.equal(eventsPath(c, "m-1"), join(c.stateDir, "jobs", "m-1", EVENTS_FILE));
});

test("events: not a card, or no card folder, writes nothing and warns nothing", () => {
  const c = cfg(); const warned = [];
  for (const id of ["session", "job:m-1", "m-2", ""]) assert.equal(appendEvent(c, id, { kind: "note", text: "x" }, { warn: (m) => warned.push(m) }), false);
  assert.deepEqual(warned, []);
});

test("events: an unknown kind or a write failure warns once and never throws", () => {
  const c = cfg(); card(c, "m-1"); const warned = [];
  assert.equal(appendEvent(c, "m-1", { kind: "nope" }, { warn: (m) => warned.push(m) }), false);
  mkdirSync(eventsPath(c, "m-1")); // a directory where the file should be: the append fails
  assert.equal(appendEvent(c, "m-1", { kind: "note", text: "x" }, { warn: (m) => warned.push(m) }), false);
  assert.equal(warned.length, 2);
  assert.match(warned[0], /^warning: m-1: event not recorded \(unknown event kind "nope"\)\n$/);
});

test("events: a line over the cap is cut in its longest string fields, never split", () => {
  const line = encodeEvent({ at: AT, by: "session", kind: "note", text: "x".repeat(5000), other: "y".repeat(3000) });
  assert.ok(Buffer.byteLength(line) <= MAX_LINE_BYTES, String(Buffer.byteLength(line)));
  assert.equal(line.split("\n").length, 2);
  const e = JSON.parse(line);
  assert.equal(e.kind, "note"); assert.equal(e.at, AT);
  assert.ok(e.text.endsWith("…") && e.other.endsWith("…"));
  assert.equal(encodeEvent({ kind: "note", text: "short" }), '{"kind":"note","text":"short"}\n');
});

test("events: an event that cannot be cut to fit returns null at once, and appendEvent warns and writes nothing", { timeout: 5000 }, () => {
  const big = () => ({ kind: "suite", text: "a".repeat(40), files: Array.from({ length: 200 }, (_, i) => `f${i}`) });
  const t0 = Date.now();
  const r = encodeEvent(big());
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r, null);
  const c = cfg(); card(c, "m-1"); const warned = [];
  assert.equal(appendEvent(c, "m-1", big(), { warn: (m) => warned.push(m) }), false);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /does not fit in 1024 bytes/);
  assert.equal(existsSync(eventsPath(c, "m-1")), false);
});

test("events: at, by and kind are never cut", () => {
  assert.equal(encodeEvent({ at: AT, by: "b".repeat(2000), kind: "note", text: "x" }), null);
  const e = JSON.parse(encodeEvent({ at: AT, by: "session", kind: "note", text: "x".repeat(3000) }));
  assert.equal(e.at, AT); assert.equal(e.by, "session"); assert.equal(e.kind, "note");
});

test("events: a cut never splits an emoji", () => {
  const e = JSON.parse(encodeEvent({ at: AT, by: "session", kind: "note", text: "😀".repeat(600) }));
  assert.ok(e.text.endsWith("…"));
  const body = e.text.slice(0, -1);
  assert.ok(body.length > 0 && /^(?:😀)+$/u.test(body));
});

test("events: readEvents reads complete lines from an offset, skips a corrupt one and waits for a partial one", () => {
  const c = cfg(); card(c, "m-1");
  appendEvent(c, "m-1", { kind: "note", text: "one" }, { now: AT });
  appendFileSync(eventsPath(c, "m-1"), "not json\n");
  appendEvent(c, "m-1", { kind: "note", text: "two" }, { now: AT });
  appendFileSync(eventsPath(c, "m-1"), '{"kind":"note","text":"thr');
  const r = readEvents(c, "m-1");
  assert.deepEqual(r.events.map((e) => e.text), ["one", "two"]);
  assert.ok(r.next < r.size, "the partial line is not consumed");
  assert.equal(r.events[1].end, r.next);
  appendFileSync(eventsPath(c, "m-1"), 'ee"}\n');
  const r2 = readEvents(c, "m-1", { from: r.next });
  assert.deepEqual(r2.events.map((e) => e.text), ["three"]);
  assert.equal(r2.next, r2.size);
});

test("events: a missing file is empty; an offset past the end starts again from 0", () => {
  const c = cfg(); card(c, "m-1");
  assert.deepEqual(readEvents(c, "m-1"), { events: [], next: 0, size: 0 });
  appendEvent(c, "m-1", { kind: "note", text: "one" }, { now: AT });
  assert.deepEqual(readEvents(c, "m-1", { from: 99999 }).events.map((e) => e.text), ["one"]);
});

test("events: readAllEvents reads past maxBytes", () => {
  const c = cfg(); card(c, "m-1");
  for (let i = 0; i < 400; i++) appendEvent(c, "m-1", { kind: "note", text: `n${i} ${"z".repeat(900)}` }, { now: AT });
  assert.equal(readAllEvents(c, "m-1").length, 400);
});

test("events: runningAgents — an open start on a working card, within the stale window", () => {
  const c = cfg(); card(c, "m-1"); card(c, "m-2"); card(c, "m-3");
  const t = (m) => `2026-11-02T10:${String(m).padStart(2, "0")}:00.000Z`;
  const a = (id, phase, extra, at) => appendEvent(c, id, { kind: "agent", phase, vendor: "codex", role: "implementer", task: "3", model: "implement", ...extra }, { now: at });
  a("m-1", "start", { log: "tasks/3/codex-0/codex.jsonl" }, t(0));
  a("m-1", "start", { vendor: "claude", role: "spec-reviewer", task: "2", model: "opus" }, t(1));
  a("m-1", "finish", { vendor: "claude", role: "spec-reviewer", task: "2", model: "opus", verdict: "ok" }, t(2));
  a("m-2", "start", {}, t(0)); // m-2 is in backlog: not running
  a("m-3", "start", {}, "2026-11-01T00:00:00.000Z"); // stale
  const jobs = [{ id: "m-1", stage: "building" }, { id: "m-2", stage: "backlog" }, { id: "m-3", stage: "building" }];
  const now = Date.parse(t(10));
  assert.deepEqual(runningAgents(c, jobs, { now }), [{ id: "m-1", role: "implementer", task: "3", vendor: "codex", model: "implement", startedAt: t(0), log: "tasks/3/codex-0/codex.jsonl" }]);
  a("m-1", "finish", {}, t(5));
  assert.deepEqual(runningAgents(c, jobs, { now }), []);
});
