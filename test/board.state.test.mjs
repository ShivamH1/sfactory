import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEEP_EVENTS, foldActivity, foldTail, describe, matches,
  timelineGroups, dayKey, dayLabel, fmtElapsed, vendorName, taskLabel, reviewFor, reportPath, startNearEnd, dropPartialLine,
  byMilestoneNumber,
} from "../board/activity-state.mjs";

const ev = (i) => ({ id: "m-1", at: new Date(Date.UTC(2026, 0, 5, 10, 0, i)).toISOString(), kind: "note", text: `n${i}` }); // later i, later at

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

test("state: describe never throws on hostile fields and never prints undefined", () => {
  const hostile = [
    { kind: "agent", vendor: 7 }, { kind: "note", text: { toString: 1 } }, { kind: "agent", role: { toString: 1 }, vendor: { toString: 1 } },
    { kind: "stage", to: { toString: 1 }, from: { toString: 1 } }, { kind: "gate", action: { toString: 1 } }, { kind: { toString: 1 } }, null,
  ];
  for (const e of hostile) assert.doesNotThrow(() => describe(e));
  for (const e of [{ kind: "agent" }, { kind: "service" }, { kind: "lock", phase: "release" }, { kind: "gate" }, { kind: "stage" }, { kind: "commit" }, { kind: { toString: 1 } }]) {
    const r = describe(e);
    assert.ok(!`${r.title} ${r.sub}`.includes("undefined"), JSON.stringify(e));
  }
  assert.equal(describe({ kind: "agent" }).title, "Agent finished");
  assert.equal(describe({ kind: "service" }).title, "Service down");
  assert.equal(describe({ kind: "lock", phase: "release" }).title, "Released a lock");
  assert.equal(describe({ kind: "gate" }).title, "Gate");
  assert.equal(describe({ kind: "stage" }).title, "Created");
  assert.equal(describe({ kind: "stage", from: "a" }).title, "Moved");
  assert.equal(describe({ kind: "commit" }).title, "Committed");
  assert.equal(describe({ kind: { toString: 1 } }).title, "Event");
  assert.equal(describe({ kind: "note" }).title, "Note");
  assert.equal(describe({ kind: "note", text: "" }).title, "Note");
  assert.equal(describe({ kind: "note", text: { toString: 1 } }).title, "Note");
});

test("state: describe agent sub is its log, suite signal and agent exit are named", () => {
  assert.equal(describe({ kind: "agent", phase: "start", vendor: "codex", role: "implementer", model: "m", log: "agents/a.log" }).sub, "agents/a.log");
  assert.equal(describe({ kind: "suite", phase: "finish", ok: false, signal: "SIGTERM", durationMs: 4000 }).title, "Suite stopped by SIGTERM in 4s");
  assert.equal(describe({ kind: "agent", phase: "finish", vendor: "codex", role: "reviewer", ok: false, exit: 2 }).title, "Codex reviewer failed (exit 2)");
});

test("state: foldTail tolerates a missing answer; matches ignores unknown groups", () => {
  assert.doesNotThrow(() => foldTail(null, 0, undefined));
  assert.deepEqual(foldTail(null, 5, undefined), { text: "", next: 5, size: 0 });
  const v = { text: "x", next: 1, size: 1 };
  assert.equal(foldTail(v, 1, null), v);
  assert.equal(matches({ id: "m-1", kind: "agent" }, { group: "constructor" }), false);
});

test("state: matches filters by card and by group", () => {
  const e = { id: "m-1", kind: "agent" };
  assert.equal(matches(e, { card: null, group: null }), true);
  assert.equal(matches(e, { card: "m-1", group: "Agents" }), true);
  assert.equal(matches(e, { card: "m-2", group: null }), false);
  assert.equal(matches(e, { card: null, group: "Gates" }), false);
});

const local = (d, h, m = 0) => new Date(2026, 0, d, h, m).toISOString(); // a local wall-clock time, so day labels hold in any zone
const NOW = new Date(2026, 0, 6, 12, 0).getTime();

test("state: timelineGroups orders by time, not arrival, newest first", () => {
  const events = [
    { id: "m-1", kind: "note", text: "a", at: local(6, 10) },
    { id: "m-1", kind: "note", text: "b", at: local(6, 11) },
    { id: "m-2", kind: "stage", text: "imported", at: local(6, 9) }, // arrived last, stamped earlier
  ];
  const g = timelineGroups(events, {}, NOW);
  assert.equal(g.length, 1);
  assert.equal(g[0].label, "Today");
  assert.deepEqual(g[0].rows.map((r) => r.e.text), ["b", "a", "imported"]);
  assert.deepEqual(g[0].rows.map((r) => r.key), ["e1", "e0", "e2"]); // with no seq, keys are positions in the list
  const folded = events.map((e, i) => ({ ...e, seq: 40 + i }));
  assert.deepEqual(timelineGroups(folded, {}, NOW)[0].rows.map((r) => r.key), ["e41", "e40", "e42"]); // a folded event's key is its seq
});

test("state: foldActivity trims by time, not arrival: an import while the view is open never evicts today", () => {
  const today = Array.from({ length: 200 }, (_, i) => ({ id: "m-1", kind: "note", text: "t" + i, at: new Date(2026, 0, 6, 8, i).toISOString() }));
  const old = Array.from({ length: 750 }, (_, i) => ({ id: "m-2", kind: "stage", text: "o" + i, at: new Date(2026, 0, 4, 23, -i).toISOString() })); // o0 newest
  const keysOf = (st) => new Map(timelineGroups(st.events, {}, NOW).flatMap((g) => g.rows).map((r) => [r.e.text, r.key]));
  let s = foldActivity(null, { events: today, cursor: "c0", running: [] });
  const before = keysOf(s);
  for (let p = 0; p < old.length; p += 200) {
    s = foldActivity(s, { events: old.slice(p, p + 200), cursor: "c" + p, running: [] });
    for (const [text, key] of before) assert.equal(keysOf(s).get(text), key, `${text} keeps its key after the page at ${p}`);
  }
  s = foldActivity(s, { events: [{ id: "m-1", kind: "note", text: "live", at: new Date(2026, 0, 6, 11, 50).toISOString() }], cursor: "c-live", running: [] });
  assert.equal(s.events.length, KEEP_EVENTS);
  const g = timelineGroups(s.events, {}, NOW);
  assert.equal(g[0].label, "Today");
  assert.equal(g[0].rows.length, 201, "all 200 of today's events and the live one");
  assert.equal(g[0].rows[0].e.text, "live");
  const kept = s.events.filter((e) => e.id === "m-2").map((e) => e.text);
  assert.deepEqual(new Set(kept), new Set(old.slice(0, KEEP_EVENTS - 201).map((e) => e.text)), "the newest back-dated events fill the rest");
  const seqs = s.events.map((e) => e.seq);
  assert.ok(seqs.every((q, i) => Number.isInteger(q) && (i === 0 || q > seqs[i - 1])), "the state keeps arrival order");
  const after = keysOf(s);
  for (const [text, key] of before) assert.equal(after.get(text), key, `${text} keeps its key`);
});

test("state: foldActivity evicts an unparseable at first, then the oldest, the earlier arrival first on a tie", () => {
  const at = new Date(2026, 0, 6, 10).toISOString();
  const fill = Array.from({ length: KEEP_EVENTS - 2 }, (_, i) => ({ kind: "note", text: "f" + i, at: new Date(2026, 0, 6, 11, 0, i).toISOString() }));
  let s = foldActivity(null, { events: fill, cursor: "c1", running: [] });
  s = foldActivity(s, { events: [{ kind: "note", text: "tie1", at }, { kind: "note", text: "bad", at: "not a time" }, null, { kind: "note", text: "tie2", at }, { kind: "note", text: "new", at: new Date(2026, 0, 6, 11, 30).toISOString() }], cursor: "c2", running: [] });
  const texts = s.events.map((e) => e.text);
  assert.equal(s.events.length, KEEP_EVENTS);
  assert.equal(texts.includes("bad"), false);
  assert.equal(texts.includes("tie1"), false);
  assert.ok(texts.includes("tie2") && texts.includes("new") && texts.includes("f0"));
  assert.deepEqual(texts.slice(-2), ["tie2", "new"], "still in arrival order");
  assert.equal(new Set(s.events.map((e) => e.seq)).size, KEEP_EVENTS, "every kept event has its own seq");
});

test("state: byMilestoneNumber orders by number, 29.1 between 29 and 30, unnumbered after, then by id numerically", () => {
  const jobs = [
    { id: "m-10" }, { id: "m-3", number: "30" }, { id: "m-2" }, { id: "m-7", number: "29.1" }, { id: "m-9", number: "29" },
    { id: "m-11", number: "4" }, { id: "m-1", number: "4" }, { id: "m-12", number: "" }, { id: "m-13", number: null },
  ];
  assert.deepEqual(jobs.slice().sort(byMilestoneNumber).map((j) => j.id), ["m-1", "m-11", "m-9", "m-7", "m-3", "m-2", "m-10", "m-12", "m-13"]);
});

test("state: timelineGroups gives one header per day when days arrive interleaved", () => {
  const events = [
    { id: "m-1", kind: "note", text: "today 1", at: local(6, 10) },
    { id: "m-2", kind: "note", text: "old 1", at: local(2, 10) },
    { id: "m-1", kind: "note", text: "yesterday", at: local(5, 10) },
    { id: "m-1", kind: "note", text: "today 2", at: local(6, 11) },
    { id: "m-2", kind: "note", text: "old 2", at: local(2, 11) },
  ];
  const g = timelineGroups(events, {}, NOW);
  assert.deepEqual(g.map((x) => x.label.slice(0, 9)), ["Today", "Yesterday", g[2].label.slice(0, 9)]);
  assert.equal(g.length, 3);
  assert.deepEqual(g.map((x) => x.rows.map((r) => r.e.text)), [["today 2", "today 1"], ["yesterday"], ["old 2", "old 1"]]);
  assert.notEqual(g[2].label, "Today"); assert.notEqual(g[2].label, "Yesterday");
});

test("state: timelineGroups breaks a tie by arrival (the later arrival above) and sorts an unparseable at last", () => {
  const at = local(6, 10);
  const events = [
    { id: "m-1", kind: "gate", text: "first", at },
    { id: "m-1", kind: "note", text: "bad", at: "not a time" },
    { id: "m-1", kind: "stage", text: "second", at },
    { id: "m-1", kind: "note", text: "missing" },
  ];
  const g = timelineGroups(events, {}, NOW);
  assert.deepEqual(g.map((x) => x.label), ["Today", "Undated"]);
  assert.deepEqual(g[0].rows.map((r) => r.e.text), ["second", "first"]);
  assert.deepEqual(g[1].rows.map((r) => r.e.text), ["missing", "bad"]);
});

test("state: timelineGroups applies the filters and tolerates junk", () => {
  const events = [{ id: "m-1", kind: "agent", at: local(6, 10) }, null, { id: "m-2", kind: "agent", at: local(6, 11) }, { id: "m-1", kind: "gate", at: local(6, 9) }];
  assert.deepEqual(timelineGroups(events, { card: "m-1", group: "Agents" }, NOW)[0].rows.map((r) => r.key), ["e0"]);
  assert.deepEqual(timelineGroups(null, {}, NOW), []);
});

test("state: dayKey and dayLabel use the local calendar", () => {
  assert.equal(dayKey(new Date(2026, 0, 6, 23, 59).getTime()), "2026-01-06");
  assert.equal(dayLabel(new Date(2026, 0, 6, 0, 1).getTime(), NOW), "Today");
  assert.equal(dayLabel(new Date(2026, 0, 5, 23, 59).getTime(), NOW), "Yesterday");
  const older = dayLabel(new Date(2026, 0, 2, 9).getTime(), NOW);
  assert.ok(older && older !== "Today" && older !== "Yesterday");
  assert.match(dayLabel(new Date(2025, 11, 30, 9).getTime(), NOW), /2025/);
  assert.equal(dayLabel(NaN, NOW), "Undated");
});

test("state: fmtElapsed, vendorName and taskLabel", () => {
  assert.equal(fmtElapsed(12000), "12s");
  assert.equal(fmtElapsed(252000), "4m 12s");
  assert.equal(fmtElapsed(3840000), "1h 4m");
  assert.equal(fmtElapsed(51 * 3600000), "2d 3h");
  assert.equal(fmtElapsed(-1), ""); assert.equal(fmtElapsed(NaN), ""); assert.equal(fmtElapsed(undefined), "");
  assert.equal(vendorName("codex"), "Codex"); assert.equal(vendorName("claude"), "Claude");
  assert.equal(vendorName("other"), "other"); assert.equal(vendorName(null), "Agent"); assert.equal(vendorName({}), "Agent");
  assert.equal(taskLabel("3", { tasks: { done: 2, total: 9 } }), "task 3 of 9");
  assert.equal(taskLabel(3, { tasks: { total: 9 } }), "task 3 of 9");
  assert.equal(taskLabel("3", { tasks: 9 }), "task 3");
  assert.equal(taskLabel("3a", { tasks: { total: 9 } }), "task 3a");
  assert.equal(taskLabel("3", null), "task 3");
  assert.equal(taskLabel(null, { tasks: { total: 9 } }), null); assert.equal(taskLabel("", null), null);
});

test("state: reviewFor matches a task's reviews, or a role's with no task", () => {
  assert.equal(reviewFor("7-task-2-code.md", "2", "reviewer"), true);
  assert.equal(reviewFor("7-task-12-code.md", "2", "reviewer"), false);
  assert.equal(reviewFor("3-task-2-rereview-1.md", "2", null), true);
  assert.equal(reviewFor("7-judge.md", null, "judge"), true);
  assert.equal(reviewFor("8-bug-hunt.md", null, "bug hunt"), true);
  assert.equal(reviewFor("8-bug-hunt.md", null, "judge"), false);
  assert.equal(reviewFor("8-bug-hunt.md", null, ""), false);
});

test("state: reportPath picks the reviewer's own review, the implementer's report, and nothing of another kind", () => {
  const job = { files: ["tasks/2/report.md", "reviews/4-task-2-spec.md", "reviews/5-task-2-code.md", "reviews/10-task-2-code.md", "reviews/6-task-3-code.md", "reviews/9-judge.md"] };
  assert.equal(reportPath({ role: "spec-reviewer", task: "2" }, job), "reviews/4-task-2-spec.md");
  assert.equal(reportPath({ role: "code-reviewer", task: "2" }, job), "reviews/10-task-2-code.md"); // by number, not by name
  assert.equal(reportPath({ role: "implementer", task: "2" }, job), "tasks/2/report.md");
  assert.equal(reportPath({ role: "reviewer", task: "2" }, job), "reviews/10-task-2-code.md");
  assert.equal(reportPath({ role: "spec-reviewer", task: "3" }, job), null, "no spec review of task 3: not the code review");
  assert.equal(reportPath({ role: "implementer", task: "3" }, job), "reviews/6-task-3-code.md");
  assert.equal(reportPath({ role: "judge", task: null }, job), "reviews/9-judge.md");
  assert.equal(reportPath({ role: "implementer", task: "4" }, job), null);
  assert.equal(reportPath({ role: "implementer", task: "2" }, null), null);
});

test("state: startNearEnd and dropPartialLine open a long log near its end on a whole line", () => {
  assert.equal(startNearEnd(100, 1000), 0);
  assert.equal(startNearEnd(5000, 1000), 4000);
  assert.equal(startNearEnd(undefined, 1000), 0);
  assert.equal(dropPartialLine("tail of a line\nwhole\nlines\n"), "whole\nlines\n");
  assert.equal(dropPartialLine("no newline yet"), null);
  assert.equal(dropPartialLine("\nnext"), "next");
});
