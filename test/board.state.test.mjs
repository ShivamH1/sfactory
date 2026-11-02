import { test } from "node:test";
import assert from "node:assert/strict";
import { KEEP_EVENTS, foldActivity, foldTail, describe, matches } from "../board/activity-state.mjs";

const ev = (i) => ({ id: "m-1", at: `2026-01-05T10:00:${String(i % 60).padStart(2, "0")}.000Z`, kind: "note", text: `n${i}` });

test("state: foldActivity appends, keeps the newest, replaces cursor and running", () => {
  let s = foldActivity(null, { events: [ev(1), ev(2)], cursor: "c1", running: [{ id: "m-1" }] });
  assert.deepEqual(s.events.map((e) => e.text), ["n1", "n2"]); assert.equal(s.cursor, "c1"); assert.equal(s.running.length, 1);
  s = foldActivity(s, { events: [ev(3)], cursor: "c2", running: [] });
  assert.deepEqual(s.events.map((e) => e.text), ["n1", "n2", "n3"]); assert.equal(s.cursor, "c2"); assert.deepEqual(s.running, []);
  s = foldActivity(s, { events: Array.from({ length: KEEP_EVENTS }, (_, i) => ev(i + 10)), cursor: "c3", running: [] });
  assert.equal(s.events.length, KEEP_EVENTS); assert.equal(s.events[0].text, "n10");
});

test("state: foldTail appends when the server read from where we asked, replaces when it restarted", () => {
  let v = foldTail(null, 0, { text: "one\n", from: 0, next: 4, size: 4 });
  v = foldTail(v, 4, { text: "two\n", from: 4, next: 8, size: 8 });
  assert.deepEqual(v, { text: "one\ntwo\n", next: 8, size: 8 });
  v = foldTail(v, 8, { text: "new\n", from: 0, next: 4, size: 4 });
  assert.deepEqual(v, { text: "new\n", next: 4, size: 4 });
});

test("state: describe gives one sentence per kind", () => {
  const d = (e) => { const r = describe(e); return `${r.title}${r.sub ? ` | ${r.sub}` : ""}${r.tone ? ` | ${r.tone}` : ""}`; };
  assert.equal(d({ kind: "stage", from: null, to: "backlog", reason: "created" }), "Created in backlog | created");
  assert.equal(d({ kind: "stage", from: "building", to: "reviewing", reason: "tasks done" }), "Moved to reviewing | from building · tasks done");
  assert.equal(d({ kind: "gate", action: "approve", by: "board" }), "Approved | by board | you");
  assert.equal(d({ kind: "gate", action: "parallel", yes: false, by: "session" }), "Queued instead of running in parallel | by session | you");
  assert.equal(d({ kind: "agent", phase: "start", vendor: "codex", role: "implementer", task: "3", model: "implement" }), "Codex implementer started on task 3 | implement | live");
  assert.equal(d({ kind: "agent", phase: "finish", vendor: "claude", role: "spec-reviewer", task: "2", model: "opus", verdict: "ok" }), "Claude spec-reviewer finished on task 2: ✓ Approved | opus | ok");
  assert.equal(d({ kind: "agent", phase: "finish", vendor: "codex", role: "reviewer", ok: false }), "Codex reviewer failed | bad");
  assert.equal(d({ kind: "suite", phase: "finish", ok: true, exit: 0, durationMs: 161000, log: "verify/suite.log" }), "Suite passed in 2m 41s | verify/suite.log | ok");
  assert.equal(d({ kind: "suite", phase: "finish", ok: false, exit: 1, durationMs: 4000 }), "Suite failed (exit 1) in 4s | bad");
  assert.equal(d({ kind: "service", phase: "up", name: "api", port: 4100 }), "Service api up on :4100");
  assert.equal(d({ kind: "lock", phase: "take", name: "suite" }), "Took the suite lock");
  assert.equal(d({ kind: "commit", sha: "a41c9e2f00", files: 3 }), "Committed a41c9e2 | 3 files");
  assert.equal(d({ kind: "note", text: "reading the brief" }), "reading the brief");
  assert.equal(d({ kind: "mystery" }), "mystery");
});

test("state: matches filters by card and by group", () => {
  const e = { id: "m-1", kind: "agent" };
  assert.equal(matches(e, { card: null, group: null }), true);
  assert.equal(matches(e, { card: "m-1", group: "Agents" }), true);
  assert.equal(matches(e, { card: "m-2", group: null }), false);
  assert.equal(matches(e, { card: null, group: "Gates" }), false);
});
