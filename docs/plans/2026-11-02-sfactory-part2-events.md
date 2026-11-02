# sfactory Part 2 — the event log and the board's activity routes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every card keeps an append-only `events.jsonl` of what happened to it (stage moves, gates, agents, suite runs, services, locks, commits, notes), and the board serves the recent events across all cards, the agents running now, and the tail of any log in a card's folder.

**Architecture:** One module, `src/events.mjs`, owns the file format: append one line, read from a byte offset, and decide which agents are running. It imports nothing but `src/job.mjs` (for the working stages), so the store and the lock module can call it without an import cycle. Writers call `appendEvent` at the points where the thing already happens: `writeJob` (stage moves, from the history it is writing), the gate actions, `job touch`, the Codex command, `runSuite`, the services, the lock module, the commit. The board gains `src/board/activity.mjs` (the activity feed and the tail) and two GET routes. The page itself is redrawn in Part 3.

**Tech Stack:** Node ≥ 20, ESM `.mjs`, `node:test` + `node:assert/strict`, zero runtime dependencies.

**Spec:** `docs/plans/2026-10-30-sfactory-roadmap-activity-design.md`, sections 4, 5 (the activity and tail routes) and 7 (the touch lines), part 2 of section 10.

**Branch:** `feat/events`, cut from `feat/roadmap-activity` (Part 1, pushed, not yet merged into `main`); its pull request targets `feat/roadmap-activity` until that merges.

**Where this plan departs from the spec, on purpose:**
- The routes follow the board's existing naming (`/jobs.json`, `/jobs/:id/file?path=`): the activity feed is `GET /activity.json` and the tail is `GET /jobs/:id/tail?path=<rel>&from=<offset>`, not `/api/...` with `file=`.
- An empty `job touch` (no `--note`, no `--agent`) writes no event: it only stamps the pulse, as today.
- An agent event is written even when the card is outside a working stage (a finish after the card moved on still belongs in the timeline); `job.activity` is still set only in a working stage. The running rule ignores cards outside the working stages.
- A Codex run given `--job` records its own start and finish; the skills stop touching for Codex runs and touch only for Claude agents, so a Codex run is not recorded twice.
- The import's per-card `stage` event (owed by Part 1) comes from `writeJob`, like every other stage move.

## Global Constraints

- Node 20 or later; `"dependencies": {}` stays empty. ESM only; every file is `.mjs`.
- The plugin is generic: no company, product, person or machine-specific word in any file (`test/docs.test.mjs` refuses some).
- Every `sfactory ...` command line written in README, INSTALL, DESIGN or a skill uses a registered verb and flag (`test/docs.test.mjs`).
- Errors are thrown with `fail(code, message)` from `src/errors.mjs`. Job writes only inside `withJobLock`.
- `job.json` stays the source of truth. An event append that fails prints one warning line to stderr and never fails the command; an append for something that is not a card (an id that is not `m-<n>`/`f-<n>`, or a card with no folder) writes nothing and says nothing.
- An event is one line of at most 1,024 bytes; a longer string field is cut, never the line split.
- The board stays read-only for these routes, bound to 127.0.0.1, with its Host check.
- Make every source and test edit with the Edit or Write tool, never a heredoc, sed or script rewrite (on Part 1 those dropped regex backslashes and ate spaces after operators).
- Never `git stash`; stage named paths only; commits carry no trailers.
- The full suite (`node --test`) is green at the end of every task, on a quiet machine. `test/services.test.mjs` and `test/suite.test.mjs` hold process-timing tests that fail under load: rerun those files alone before blaming a change.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/events.mjs` (new) | the event file: append, encode, read by offset, running agents | all of it |
| `src/store.mjs` | `writeJob` | stage events from the history it writes |
| `src/job-actions.mjs` | the gates, `touch` | gate events; structured touch |
| `src/commands/job.mjs` | `sfactory job` flags | `touch --agent --role --task --vendor --model --verdict` |
| `src/commands/codex.mjs` | `sfactory codex` | agent start/finish, `--role`, `--task` |
| `src/suite.mjs` | `runSuite` | suite start/finish |
| `src/services.mjs` | `servicesUp`/`servicesDown` | service up/down |
| `src/lock.mjs` | named locks | lock take/release for `live`, `suite`, `commit` held by a card |
| `src/commit.mjs` | `commit` | commit event |
| `src/board/activity.mjs` (new) | the activity feed and the tail | all of it |
| `src/board/server.mjs` | routes | `GET /activity.json`, `GET /jobs/:id/tail`, two status codes |
| `skills/sdd/SKILL.md`, `skills/sfactory/SKILL.md` | the orchestrator and build skills | structured touch lines; Codex runs record themselves |
| `README.md`, `docs/DESIGN.md`, `package.json`, `.claude-plugin/plugin.json` | docs, version | the event log; 0.4.0 |

---

### Task 1: The event file

**Depends on:** none

**Files:**
- Create: `src/events.mjs`
- Create: `test/events.test.mjs`

**Interfaces:**
- Produces: `EVENTS_FILE = "events.jsonl"`, `MAX_LINE_BYTES = 1024`, `KINDS` (the eight kinds), `STALE_AGENT_MS = 21_600_000`; `eventsPath(c, id)`; `encodeEvent(event) → string` (one line ending `\n`); `appendEvent(c, id, event, { now, warn }) → boolean`; `readEvents(c, id, { from = 0, maxBytes = 262144 }) → { events, next, size }`, each event carrying `end` (the byte offset after its line); `readAllEvents(c, id) → events[]`; `runningAgents(c, jobs, { now, staleMs }) → [{ id, role, task, vendor, model, startedAt, log }]`.

- [ ] **Step 1: Write the failing tests**

Create `test/events.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/events.test.mjs`
Expected: FAIL — `../src/events.mjs` does not exist.

- [ ] **Step 3: Implement**

Create `src/events.mjs`:

```js
import { appendFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { WORKING } from "./job.mjs";

/**
 * Each card's append-only event log, one JSON object per line. job.json stays the truth: an append that fails
 * warns and carries on, and nothing here ever fails a command. This module imports only src/job.mjs, so the store
 * and the lock module can call it without an import cycle.
 */
export const EVENTS_FILE = "events.jsonl";
export const MAX_LINE_BYTES = 1024;
export const KINDS = ["stage", "gate", "agent", "suite", "service", "lock", "commit", "note"];
export const STALE_AGENT_MS = 6 * 60 * 60 * 1000;
const ID_RE = /^[mf]-\d+$/;

export const eventsPath = (c, id) => join(c.stateDir, "jobs", id, EVENTS_FILE);

/** Fields never cut: the timeline needs them whole. */
const UNCUT = new Set(["at", "by", "kind"]);
const chars = (s) => Array.from(s); // code points, so a cut never splits a character

/**
 * One event as one line of at most MAX_LINE_BYTES, by shortening its longest string fields (each cut strictly
 * shorter, by whole characters; `at`, `by` and `kind` never cut); never split. Null when it still cannot fit.
 */
export function encodeEvent(event) {
  const o = { ...event };
  let s = JSON.stringify(o);
  while (Buffer.byteLength(s) > MAX_LINE_BYTES - 1) {
    const longest = Object.keys(o).filter((k) => !UNCUT.has(k) && typeof o[k] === "string" && chars(o[k]).length > 17)
      .sort((a, b) => chars(o[b]).length - chars(o[a]).length)[0];
    if (!longest) return null;
    const cs = chars(o[longest]);
    o[longest] = `${cs.slice(0, Math.max(16, Math.floor(cs.length * 0.6))).join("")}…`;
    s = JSON.stringify(o);
  }
  return `${s}\n`;
}

/**
 * Append one event to card `id`'s log. An id that is not a card's, or a card with no folder, writes nothing and
 * says nothing (a lock or a suite run held by something that is not a card). Any other failure warns and returns false.
 */
export function appendEvent(c, id, event, { now = new Date().toISOString(), warn = (m) => process.stderr.write(m) } = {}) {
  if (!ID_RE.test(String(id)) || !existsSync(join(c.stateDir, "jobs", String(id)))) return false;
  try {
    if (!KINDS.includes(event?.kind)) throw new Error(`unknown event kind "${event?.kind}"`);
    const line = encodeEvent({ at: now, by: "session", ...event });
    if (line === null) throw new Error(`the event does not fit in ${MAX_LINE_BYTES} bytes`);
    appendFileSync(eventsPath(c, id), line);
    return true;
  } catch (e) {
    warn(`warning: ${id}: event not recorded (${e.message})\n`);
    return false;
  }
}

/**
 * Events of card `id` from byte offset `from`, reading at most `maxBytes`: complete lines only, each event with
 * `end`, the offset after its line; a line that does not parse is skipped. `next` is where the next read starts.
 * A missing file is empty; an offset past the end (the file was replaced) starts again from 0.
 */
export function readEvents(c, id, { from = 0, maxBytes = 256 * 1024 } = {}) {
  const f = eventsPath(c, id);
  if (!existsSync(f)) return { events: [], next: 0, size: 0 };
  const fd = openSync(f, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Number.isInteger(from) && from >= 0 && from <= size ? from : 0;
    const len = Math.min(maxBytes, size - start);
    const buf = Buffer.alloc(Math.max(0, len));
    const n = len > 0 ? readSync(fd, buf, 0, len, start) : 0;
    const chunk = buf.subarray(0, n);
    const last = chunk.lastIndexOf(0x0a);
    const events = [];
    if (last < 0) return { events, next: start, size };
    let pos = 0;
    while (pos <= last) {
      const nl = chunk.indexOf(0x0a, pos);
      try {
        const e = JSON.parse(chunk.subarray(pos, nl).toString("utf8"));
        if (e && typeof e === "object" && !Array.isArray(e)) events.push({ ...e, end: start + nl + 1 });
      } catch { /* a line that does not parse is skipped */ }
      pos = nl + 1;
    }
    return { events, next: start + last + 1, size };
  } finally { closeSync(fd); }
}

/** Every complete event of card `id`. */
export function readAllEvents(c, id) {
  const out = [];
  let from = 0;
  for (;;) {
    const r = readEvents(c, id, { from });
    out.push(...r.events);
    if (r.next === from || r.next >= r.size) return out;
    from = r.next;
  }
}

/**
 * The agents running now: an agent start with no later finish of the same vendor, role and task, on a card in a
 * working stage, started less than `staleMs` ago. An older unmatched start is an agent that ended unrecorded.
 */
export function runningAgents(c, jobs, { now = Date.now(), staleMs = STALE_AGENT_MS } = {}) {
  const out = [];
  for (const j of jobs) {
    if (!WORKING.includes(j.stage)) continue;
    const open = new Map();
    for (const e of readAllEvents(c, j.id)) {
      if (e.kind !== "agent") continue;
      const key = `${e.vendor}|${e.role}|${e.task ?? ""}`;
      if (e.phase === "start") open.set(key, e);
      else if (e.phase === "finish") open.delete(key);
    }
    for (const e of open.values()) {
      const t = typeof e.at === "string" ? Date.parse(e.at) : NaN;
      if (Number.isNaN(t) || now - t > staleMs) continue;
      out.push({ id: j.id, role: e.role, task: e.task ?? null, vendor: e.vendor, model: e.model ?? null, startedAt: e.at, log: e.log ?? null });
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
```

- [ ] **Step 4: Run the test, then the full suite**

Run: `node --test test/events.test.mjs` — Expected: PASS. Then `node --test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.mjs test/events.test.mjs
git commit -m "feat(events): the per-card event log — append, read by offset, running agents"
```

---

### Task 2: Stage and gate events

**Depends on:** Task 1

**Files:**
- Modify: `src/store.mjs` (`writeJob`)
- Modify: `src/job-actions.mjs` (gate wrapper)
- Modify: `test/store.test.mjs`
- Modify: `test/job-actions.test.mjs`

**Interfaces:**
- Consumes: `appendEvent`, `readAllEvents` (Task 1).
- Produces: every history entry `writeJob` adds with `from !== to` becomes a `stage` event `{ kind: "stage", at, by, from, to, reason }` (the entry's own `at` and `by`); every successful gate action (`approve`, `requestChanges`, `answer`, `parallel`, `merged`, `rework`, `start`, `external`) appends `{ kind: "gate", by, action }` (`action` in the CLI's spelling: `request-changes`; `parallel` also carries `yes`).

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.mjs` (extend its imports: `addJob`, `withJobLock` and `writeJob as rawWriteJob` from the store are already there; add `readAllEvents` from `../src/events.mjs` and `transition` from `../src/job.mjs`):

```js
test("store: writeJob records each new stage move as a stage event, once", () => {
  const c = { stateDir: tmpDir("sf-st-"), limits: { lockStaleMs: 60_000 } };
  const j = addJob(c, "milestone", "t");
  let ev = readAllEvents(c, j.id);
  assert.deepEqual(ev.map((e) => [e.kind, e.from, e.to, e.reason]), [["stage", null, "backlog", "created"]]);
  const moved = transition(j, "planning", { by: "board", reason: "started" });
  withJobLock(c, j.id, () => rawWriteJob(c, moved));
  withJobLock(c, j.id, () => rawWriteJob(c, moved)); // a rewrite with no new history adds nothing
  ev = readAllEvents(c, j.id);
  assert.deepEqual(ev.map((e) => [e.kind, e.from, e.to, e.by, e.reason]), [["stage", null, "backlog", "session", "created"], ["stage", "backlog", "planning", "board", "started"]]);
  assert.equal(ev[1].at, moved.history.at(-1).at);
});
```

Append to `test/job-actions.test.mjs` (add `readAllEvents` from `../src/events.mjs` to its imports):

```js
test("actions: each gate appends a gate event after its stage event", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "later", roadmap: true });
  actions.start(c, { id: "m-1", by: "board" });
  actions.set(c, { id: "m-1", to: "planning" });
  actions.set(c, { id: "m-1", to: "awaiting-approval" });
  actions.requestChanges(c, { id: "m-1", notes: "shorter" });
  actions.approve(c, { id: "m-1", by: "board" });
  const ev = readAllEvents(c, "m-1").map((e) => e.kind === "gate" ? `gate ${e.action} ${e.by}` : `stage ${e.from}->${e.to}`);
  assert.deepEqual(ev, [
    "stage null->roadmap", "stage roadmap->backlog", "gate start board",
    "stage backlog->planning", "stage planning->awaiting-approval",
    "gate request-changes session",
    "stage awaiting-approval->building", "gate approve board",
  ]);
});

test("actions: a refused gate writes no gate event", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "x" });
  throwsCode(() => actions.start(c, { id: "m-1" }), "ILLEGAL_TRANSITION");
  assert.equal(readAllEvents(c, "m-1").filter((e) => e.kind === "gate").length, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/store.test.mjs test/job-actions.test.mjs`
Expected: FAIL — no events are written.

- [ ] **Step 3: Implement**

In `src/store.mjs`, add `import { appendEvent } from "./events.mjs";` and replace `writeJob`:

```js
/**
 * Called inside withJobLock by the job commands (src/job-actions.mjs, src/commands/*) and by addJob. Atomic via
 * atomicWrite. Each history entry this write adds that moves the card (from !== to) is appended to the card's event
 * log, with the entry's own time and author; a rewrite that adds no history adds no event.
 */
export function writeJob(c, job) {
  const s = status(c, `job:${job.id}`);
  if (!s.held || s.holder !== HOLDER) fail("JOB_LOCK_REQUIRED", `writeJob(${job.id}) needs withJobLock`);
  mkdirSync(jobDir(c, job.id), { recursive: true });
  const f = jobFile(c, job.id);
  let before = 0;
  if (existsSync(f)) { try { before = JSON.parse(readFileSync(f, "utf8")).history?.length ?? 0; } catch { before = 0; } }
  job.updated = new Date().toISOString();
  atomicWrite(f, JSON.stringify(job, null, 2) + "\n");
  for (const h of (job.history ?? []).slice(before)) {
    if (h.from !== h.to) appendEvent(c, job.id, { kind: "stage", at: h.at, by: h.by ?? "session", from: h.from ?? null, to: h.to, reason: h.reason ?? null });
  }
  return job;
}
```

In `src/job-actions.mjs`, add `import { appendEvent } from "./events.mjs";` and, after the `actions` object, wrap the gates:

```js
/** The person's gates: each successful one is also a gate event, after the stage event its write made. */
const GATES = { approve: "approve", requestChanges: "request-changes", answer: "answer", parallel: "parallel", merged: "merged", rework: "rework", start: "start", external: "external" };
for (const [name, action] of Object.entries(GATES)) {
  const run = actions[name];
  actions[name] = (c, args = {}) => {
    const job = run(c, args);
    appendEvent(c, job.id, { kind: "gate", by: args.by ?? "session", action, ...(name === "parallel" ? { yes: args.yes } : {}) });
    return job;
  };
}
```

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/store.test.mjs test/job-actions.test.mjs test/import.test.mjs` — Expected: PASS. Then `node --test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.mjs src/job-actions.mjs test/store.test.mjs test/job-actions.test.mjs
git commit -m "feat(events): stage events from writeJob's history, gate events from the gates"
```

---

### Task 3: The structured touch

**Depends on:** Task 2

**Files:**
- Modify: `src/job-actions.mjs` (`touch`, `checkAgent`)
- Modify: `src/commands/job.mjs` (`touch` flags, `ACCEPTS`)
- Modify: `test/job-actions.test.mjs`
- Modify: `test/cli.job.test.mjs`

**Interfaces:**
- Consumes: `appendEvent` (Task 1).
- Produces: `checkAgent(agent)` exported from `src/job-actions.mjs` (validates and normalises `{ phase, role, vendor, task?, model?, verdict? }`, `BAD_ARGS` on any bad field); `actions.touch(c, { id, note, by, agent })` — with `agent` it appends an `agent` event, with only `note` a `note` event `{ kind: "note", text }`, with neither no event; `job.activity` is set only in a working stage, its note the given note or the agent's own label; CLI `sfactory job touch <id> --agent start|finish --role <r> --vendor claude|codex [--task <t>] [--model <m>] [--verdict ok|fixes]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/job-actions.test.mjs` (add `checkAgent` to its import from `../src/job-actions.mjs`):

```js
test("actions: touch --agent appends an agent event and labels the pulse; a note appends a note event", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "x" });
  for (const s of ["planning"]) actions.set(c, { id: "m-1", to: s });
  let j = actions.touch(c, { id: "m-1", agent: { phase: "start", role: "spec-reviewer", vendor: "claude", task: "2", model: "opus" } });
  assert.equal(j.activity.note, "start claude spec-reviewer task 2 opus");
  actions.touch(c, { id: "m-1", agent: { phase: "finish", role: "spec-reviewer", vendor: "claude", task: "2", model: "opus", verdict: "ok" } });
  actions.touch(c, { id: "m-1", note: "reading the brief" });
  actions.touch(c, { id: "m-1" }); // pulse only: no event
  const ev = readAllEvents(c, "m-1").filter((e) => e.kind !== "stage");
  assert.deepEqual(ev.map(({ at, end, ...e }) => e), [
    { by: "session", kind: "agent", phase: "start", role: "spec-reviewer", vendor: "claude", task: "2", model: "opus" },
    { by: "session", kind: "agent", phase: "finish", role: "spec-reviewer", vendor: "claude", task: "2", model: "opus", verdict: "ok" },
    { by: "session", kind: "note", text: "reading the brief" },
  ]);
});

test("actions: an agent event is recorded outside a working stage too, without touching the pulse", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "x" });
  const j = actions.touch(c, { id: "m-1", agent: { phase: "finish", role: "planner", vendor: "claude" } });
  assert.equal(j.activity, undefined);
  assert.equal(readAllEvents(c, "m-1").filter((e) => e.kind === "agent").length, 1);
});

test("actions: checkAgent refuses each bad field", () => {
  const ok = { phase: "start", role: "implementer", vendor: "codex" };
  assert.deepEqual(checkAgent({ ...ok, task: 3, model: " implement " }), { phase: "start", role: "implementer", vendor: "codex", task: "3", model: "implement" });
  for (const bad of [{ ...ok, phase: "begin" }, { ...ok, role: "" }, { ...ok, role: "x".repeat(41) }, { ...ok, vendor: "gpt" },
    { ...ok, task: "x".repeat(41) }, { ...ok, model: "x".repeat(81) }, { ...ok, verdict: "ok" }, { ...ok, phase: "finish", verdict: "maybe" }]) {
    throwsCode(() => checkAgent(bad), "BAD_ARGS");
  }
});
```

Append to `test/cli.job.test.mjs`:

```js
test("cli: job touch --agent records an agent event", async () => {
  const r0 = repo();
  await run(r0, ["job", "add", "milestone", "x"]);
  await run(r0, ["job", "set", "m-1", "planning"]);
  const r = await run(r0, ["job", "touch", "m-1", "--agent", "start", "--role", "implementer", "--vendor", "codex", "--task", "1", "--model", "implement"]);
  assert.equal(r.code, 0, r.err);
  const show = JSON.parse((await run(r0, ["job", "show", "m-1"])).out);
  assert.equal(show.activity.note, "start codex implementer task 1 implement");
  assert.notEqual((await run(r0, ["job", "touch", "m-1", "--agent", "start", "--role", "x", "--vendor", "nope"])).code, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/job-actions.test.mjs test/cli.job.test.mjs`
Expected: FAIL — `checkAgent` is not exported; no agent or note events.

- [ ] **Step 3: Implement**

In `src/job-actions.mjs`, add above `actions`:

```js
const AGENT_PHASES = ["start", "finish"], VENDORS = ["claude", "codex"], VERDICTS = ["ok", "fixes"];
const short = (v, max) => typeof v === "string" && v.trim() !== "" && v.length <= max;

/** An agent touch's fields, checked and trimmed: phase, role and vendor required; task, model and a finish's verdict optional. */
export function checkAgent(a) {
  if (!AGENT_PHASES.includes(a?.phase)) fail("BAD_ARGS", '--agent must be "start" or "finish"');
  if (!short(a.role, 40)) fail("BAD_ARGS", "--role needs text of at most 40 characters");
  if (!VENDORS.includes(a.vendor)) fail("BAD_ARGS", '--vendor must be "claude" or "codex"');
  if (a.task !== undefined && !short(String(a.task), 40)) fail("BAD_ARGS", "--task needs text of at most 40 characters");
  if (a.model !== undefined && !short(a.model, 80)) fail("BAD_ARGS", "--model needs text of at most 80 characters");
  if (a.verdict !== undefined && (a.phase !== "finish" || !VERDICTS.includes(a.verdict))) fail("BAD_ARGS", '--verdict is "ok" or "fixes", on a finish only');
  return {
    phase: a.phase, role: a.role.trim(), vendor: a.vendor,
    ...(a.task !== undefined ? { task: String(a.task).trim() } : {}),
    ...(a.model !== undefined ? { model: a.model.trim() } : {}),
    ...(a.verdict !== undefined ? { verdict: a.verdict } : {}),
  };
}
const agentLabel = (a) => [a.phase, a.vendor, a.role, a.task !== undefined ? `task ${a.task}` : null, a.model ?? null].filter(Boolean).join(" ");
```

Replace `touch` in `actions`:

```js
  touch(c, { id, note, by = "session", agent }) {
    if (note !== undefined && (typeof note !== "string" || note.length > 200)) fail("BAD_ARGS", "the note must be text of at most 200 characters");
    const a = agent === undefined ? null : checkAgent(agent);
    return locked(c, id, (job) => {
      if (a) appendEvent(c, job.id, { kind: "agent", by, ...a });
      else if (note) appendEvent(c, job.id, { kind: "note", by, text: note });
      if (!WORKING.includes(job.stage)) return job;
      const label = note ?? (a ? agentLabel(a) : undefined);
      const next = structuredClone(job);
      next.activity = { at: new Date().toISOString(), ...(label ? { note: label.slice(0, 200) } : {}), by };
      return writeJob(c, next);
    });
  },
```

In `src/commands/job.mjs`, replace the `touch` entry of `sub`:

```js
  touch: (p, f) => {
    if (f.note === true) fail("BAD_ARGS", '--note needs a value: sfactory job touch <id> --note "<text>"');
    const agent = f.agent === undefined ? undefined : {
      phase: str(f.agent), role: str(f.role), vendor: str(f.vendor),
      ...(f.task !== undefined ? { task: str(f.task) } : {}),
      ...(f.model !== undefined ? { model: str(f.model) } : {}),
      ...(f.verdict !== undefined ? { verdict: str(f.verdict) } : {}),
    };
    return { id: p[0], note: str(f.note), ...(agent ? { agent } : {}) };
  },
```

and add `"agent", "role", "task", "vendor", "model", "verdict"` to `ACCEPTS.flags`.

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/job-actions.test.mjs test/cli.job.test.mjs test/board.snapshot.test.mjs` — Expected: PASS. Then `node --test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/job-actions.mjs src/commands/job.mjs test/job-actions.test.mjs test/cli.job.test.mjs
git commit -m "feat(events): job touch --agent records agent starts and finishes"
```

---

### Task 4: Codex and suite events

**Depends on:** Task 3

**Files:**
- Modify: `src/commands/codex.mjs`
- Modify: `src/suite.mjs` (`runSuite`)
- Modify: `test/codex.test.mjs`
- Modify: `test/suite.test.mjs`

**Interfaces:**
- Consumes: `appendEvent`, `readAllEvents` (Task 1); `jobDir` (store).
- Produces: `sfactory codex exec|review --job <id>` appends `{ kind: "agent", phase: "start", vendor: "codex", role, task?, model: <profile>, log? }` before the run and `{ ..., phase: "finish", ok, exit?, durationMs? }` after it, the finish written even when the run throws; `role` is `--role` or `implementer` (exec) / `reviewer` (review); `--task` is optional; `log` is the Codex stream (`codex.jsonl` or `codex-review.jsonl` in `--out`) relative to the card's folder, present only when it lies inside it. `runSuite` appends `{ kind: "suite", phase: "start", log? }` once it holds the lock and `{ kind: "suite", phase: "finish", log?, exit, ok, durationMs }` after the run.

- [ ] **Step 1: Write the failing tests**

Append to `test/codex.test.mjs` (reuse the setup of the existing "cli codex: records cost" test; add `readAllEvents` from `../src/events.mjs` and `jobDir` from `../src/store.mjs` to its imports):

```js
test("cli codex: --job records the run's start and finish as agent events, with the stream's path", async () => {
  const root = tmpRepo();
  const stateDir = tmpDir("sf-cli-");
  writeConfig(root, { project: "p", agents: { mode: "codex" }, commands: { suite: "npm test" }, stateDir, worktrees: { dir: tmpDir("sf-clw-") }, ports: { base: 47950 } });
  const outs = [], errs = [];
  const io = (extra = {}) => ({ cwd: root, stdout: (s) => outs.push(s), stderr: (s) => errs.push(s), stdin: async () => "prompt text", ...extra });
  assert.equal(await main(["job", "add", "milestone", "t", "--json"], io()), 0, errs.join(""));
  const jid = JSON.parse(outs.join("")).id;
  const c = loadConfig(root);
  const out = join(jobDir(c, jid), "tasks", "1", "codex-0");
  const runners = {
    exec: async () => ({ ok: true, exitCode: 0, usage: null, logPath: "l", lastMessagePath: "m", durationMs: 42 }),
    review: async () => { throw new Error("boom"); },
  };
  assert.equal(await main(["codex", "exec", "--cwd", ".", "--profile", "implement", "--out", out, "--job", jid, "--task", "1"], io({ runners })), 0, errs.join(""));
  await main(["codex", "review", "--cwd", ".", "--base", "main", "--profile", "review", "--out", tmpDir("sf-cro-"), "--job", jid, "--role", "code-reviewer"], io({ runners })).catch(() => {});
  const ev = readAllEvents(c, jid).filter((e) => e.kind === "agent").map(({ at, end, by, kind, ...e }) => e);
  assert.deepEqual(ev, [
    { phase: "start", role: "implementer", vendor: "codex", model: "implement", task: "1", log: "tasks/1/codex-0/codex.jsonl" },
    { phase: "finish", role: "implementer", vendor: "codex", model: "implement", task: "1", log: "tasks/1/codex-0/codex.jsonl", ok: true, exit: 0, durationMs: 42 },
    { phase: "start", role: "code-reviewer", vendor: "codex", model: "review" },
    { phase: "finish", role: "code-reviewer", vendor: "codex", model: "review", ok: false },
  ]);
});
```

Append to `test/suite.test.mjs` (it defines `cfg(suite)`; add `addJob` to its import from `../src/store.mjs` and `readAllEvents` from `../src/events.mjs`):

```js
test("suite: a run for a card records its start and finish", async () => {
  const c = cfg('node -e "process.exit(0)"');
  const j = addJob(c, "milestone", "t");
  const log = join(tmpDir(), "s.log");
  const r = await runSuite(c, { cwd: process.cwd(), jobId: j.id, logPath: log });
  assert.equal(r.ok, true);
  const ev = readAllEvents(c, j.id).filter((e) => e.kind === "suite");
  assert.deepEqual(ev.map((e) => e.phase), ["start", "finish"]);
  assert.equal(ev[1].ok, true); assert.equal(ev[1].exit, 0); assert.ok(Number.isInteger(ev[1].durationMs));
});
```

(The `logPath` is outside the card's folder, so the events carry no `log` field.)

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/codex.test.mjs test/suite.test.mjs`
Expected: FAIL — no agent or suite events; `--role` and `--task` refused by `ACCEPTS`.

- [ ] **Step 3: Implement**

In `src/commands/codex.mjs`:
- imports: add `relative, isAbsolute, sep, join` to the `node:path` import, `jobDir` to the store import, and `import { appendEvent } from "../events.mjs";`;
- `ACCEPTS.flags` gains `"role"` and `"task"`;
- after `if (typeof flags.job === "string") readJob(c, flags.job);`, add:

```js
  // A run given --job is an agent the board can show: its start, then its finish, even when the run throws.
  const role = typeof flags.role === "string" ? flags.role : verb === "exec" ? "implementer" : "reviewer";
  const stream = join(outDir, verb === "exec" ? "codex.jsonl" : "codex-review.jsonl");
  const agentEvent = (phase, extra = {}) => {
    if (typeof flags.job !== "string") return;
    const rel = relative(jobDir(c, flags.job), stream);
    const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    appendEvent(c, flags.job, {
      kind: "agent", phase, role, vendor: "codex", model: profile,
      ...(typeof flags.task === "string" ? { task: flags.task } : {}),
      ...(inside ? { log: rel.split(sep).join("/") } : {}),
      ...extra,
    });
  };
  const finished = (r) => (r ? { ok: !!r.ok, ...(Number.isInteger(r.exitCode) ? { exit: r.exitCode } : {}), ...(Number.isInteger(r.durationMs) ? { durationMs: r.durationMs } : {}) } : { ok: false });
```

- wrap each run: for exec, replace `const r = await run.exec(...);` with

```js
    agentEvent("start");
    let r;
    try { r = await run.exec(c, { cwd, profile, prompt, outDir, ...(typeof flags.sandbox === "string" ? { sandbox: flags.sandbox } : {}) }); }
    finally { agentEvent("finish", finished(r)); }
```

  and the same shape around `run.review(...)`.

In `src/suite.mjs`, add `import { relative, isAbsolute, sep } from "node:path";` (merge with an existing `node:path` import if there is one), `import { jobDir } from "./store.mjs";` and `import { appendEvent } from "./events.mjs";`, and replace `runSuite`:

```js
export async function runSuite(c, { cwd, jobId, logPath, command = c.commands.suite }) {
  // The run's start and finish go to the card's event log, the log path relative to its folder when it lies inside.
  const rel = (() => { try { const r = relative(jobDir(c, jobId), logPath); return r !== "" && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : null; } catch { return null; } })();
  const suiteEvent = (phase, extra = {}) => appendEvent(c, jobId, { kind: "suite", phase, ...(rel ? { log: rel } : {}), ...extra });
  const ended = (r) => ({ ok: !!r?.ok, ...(Number.isInteger(r?.code) ? { exit: r.code } : {}), ...(r?.signal ? { signal: r.signal } : {}), ...(Number.isInteger(r?.durationMs) ? { durationMs: r.durationMs } : {}) });
  if (c.commands.suiteSerial === false) {
    suiteEvent("start");
    let r;
    try { r = await spawnToLog(command, cwd, logPath); return r; } finally { suiteEvent("finish", ended(r)); }
  }
  const lock = await acquire(c, "suite", { holder: jobId, waitMs: c.limits.suiteWaitMs, pollMs: 100 });
  // The lock names the suite's child too, so it stays held while the suite runs even if this process is killed
  // (a Bash tool timeout, say): a second suite must never start beside an orphaned one.
  const onSpawn = (pid) => { try { setLockChild(c, "suite", { holder: jobId, token: lock.token, childPid: pid }); } catch (e) { console.error(`sfactory: suite lock child not recorded: ${e.message}`); } };
  suiteEvent("start");
  let r;
  try { r = await spawnToLog(command, cwd, logPath, { onSpawn }); return r; }
  finally {
    suiteEvent("finish", ended(r));
    try { lock.release(); } catch (e) { console.error(`sfactory: suite lock release failed: ${e.message}`); }
  }
}
```

(`jobDir` asserts the id's shape and throws for a non-card holder; the `try` above makes that "no log field", and `appendEvent` itself writes nothing for a non-card id.)

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/codex.test.mjs test/suite.test.mjs` — Expected: PASS. Then `node --test` — Expected: PASS (rerun `test/suite.test.mjs` alone if a process-timing test fails under load).

- [ ] **Step 5: Commit**

```bash
git add src/commands/codex.mjs src/suite.mjs test/codex.test.mjs test/suite.test.mjs
git commit -m "feat(events): Codex runs and suite runs record their start and finish"
```

---

### Task 5: Service, lock and commit events

**Depends on:** Task 4

**Files:**
- Modify: `src/services.mjs` (`servicesUp`, `servicesDown`)
- Modify: `src/lock.mjs` (`acquireSync`, `acquire`, `release`)
- Modify: `src/commit.mjs` (`commit`)
- Modify: `test/services.test.mjs`
- Modify: `test/lock.test.mjs`
- Modify: `test/commit.test.mjs`

**Interfaces:**
- Consumes: `appendEvent`, `readAllEvents` (Task 1).
- Produces: `{ kind: "service", phase: "up", name, port? }` for each service started and `{ kind: "service", phase: "down", name }` for each one killed; `{ kind: "lock", phase: "take"|"release", name }` when a `live`, `suite` or `commit` lock is taken or released by a holder that is a card id; `{ kind: "commit", sha, files }` after a commit whose holder is a card id.

- [ ] **Step 1: Write the failing tests**

In `test/services.test.mjs`, at the end of the existing test "services: up substitutes ports into cmd and env, drops secrets, logs, records; down kills and clears", after its last `assert`, add (and import `readAllEvents` from `../src/events.mjs`):

```js
    const ev = readAllEvents(c, job.id).filter((e) => e.kind === "service").map((e) => [e.phase, e.name, e.port ?? null]);
    assert.deepEqual(ev, [["up", "api", ports.api], ["up", "probe", null], ["down", "api", null], ["down", "probe", null]]);
```

Append to `test/lock.test.mjs` (follow its existing config helper; create a card folder with `addJob` from `../src/store.mjs`; import `readAllEvents`):

```js
test("lock: live, suite and commit locks held by a card record take and release; others record nothing", async () => {
  const c = { stateDir: tmpDir("sf-lk-"), limits: { lockStaleMs: 60_000 } };
  const j = addJob(c, "milestone", "t");
  for (const name of ["live", "suite", "commit"]) { const l = await acquire(c, name, { holder: j.id }); l.release(); }
  const r = acquireSync(c, "record", { holder: j.id }); r.release();
  const s = await acquire(c, "suite", { holder: "session" }); s.release();
  const ev = readAllEvents(c, j.id).filter((e) => e.kind === "lock").map((e) => `${e.phase} ${e.name}`);
  assert.deepEqual(ev, ["take live", "release live", "take suite", "release suite", "take commit", "release commit"]);
});
```

Append to `test/commit.test.mjs` (it defines `wtRepo()` and `cfg()`; add `addJob` from `../src/store.mjs` and `readAllEvents` from `../src/events.mjs` to its imports):

```js
test("commit: a commit held by a card records its sha and file count; a session commit records nothing", async () => {
  const r = wtRepo();
  const c = cfg();
  const j = addJob(c, "milestone", "t");
  writeFileSync(join(r, "a.txt"), "a"); writeFileSync(join(r, "b.txt"), "b");
  const sha = await commit(c, { cwd: r, paths: ["a.txt", "b.txt"], message: "feat: ab", holder: j.id });
  writeFileSync(join(r, "c.txt"), "c");
  await commit(c, { cwd: r, paths: ["c.txt"], message: "feat: c", holder: "session" });
  const ev = readAllEvents(c, j.id).filter((e) => e.kind === "commit").map((e) => [e.sha, e.files]);
  assert.deepEqual(ev, [[sha, 2]]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/lock.test.mjs test/commit.test.mjs test/services.test.mjs`
Expected: FAIL — no service, lock or commit events.

- [ ] **Step 3: Implement**

In `src/services.mjs`, add `import { appendEvent } from "./events.mjs";`. `resolveEntries` drops the config's `port` name; keep the resolved number — change its returned object from `{ name: e.name, cmd: sub(e.cmd, "cmd"), env, live: e.live === true }` to:

```js
    return { name: e.name, cmd: sub(e.cmd, "cmd"), env, live: e.live === true, ...(e.port != null ? { port: ports[e.port] } : {}) };
```

In `servicesUp`, right after `started.push({ name: e.name, ... });`:

```js
        appendEvent(c, job.id, { kind: "service", phase: "up", name: e.name, ...(Number.isInteger(e.port) ? { port: e.port } : {}) });
```

(Check that nothing compares a resolved entry's keys exactly; if a test pins `resolveEntries`' output, update it for the added `port`.) In `servicesDown`, right after `killed.push(r.name);`:

```js
          appendEvent(c, job.id, { kind: "service", phase: "down", name: r.name });
```

In `src/lock.mjs`, add `import { appendEvent } from "./events.mjs";` and:

```js
/** The locks the board's timeline shows: taken or released by a card. */
const TIMELINE_LOCKS = ["live", "suite", "commit"];
const noteLock = (c, name, holder, phase) => { if (TIMELINE_LOCKS.includes(name)) appendEvent(c, holder, { kind: "lock", phase, name }); };
```

Call `noteLock(c, name, holder, "take")` where `acquireSync` and `acquire` are about to return a lock they obtained (after `tryAcquireOnce` returned a non-null lock), and `noteLock(c, name, holder, "release")` in `release` just before its `return true` (the path where this holder's lock was removed). Do not change any other behaviour of the lock module.

In `src/commit.mjs`, add `import { appendEvent } from "./events.mjs";` and replace the last line inside the `withLock` callback, `return git(["rev-parse", "HEAD"], { cwd });`, with:

```js
    const sha = git(["rev-parse", "HEAD"], { cwd });
    appendEvent(c, holder, { kind: "commit", sha, files: paths.length });
    return sha;
```

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/lock.test.mjs test/commit.test.mjs test/services.test.mjs` — Expected: PASS. Then `node --test` — Expected: PASS (rerun `test/services.test.mjs` alone if a process-timing test fails under load).

- [ ] **Step 5: Commit**

```bash
git add src/services.mjs src/lock.mjs src/commit.mjs test/services.test.mjs test/lock.test.mjs test/commit.test.mjs
git commit -m "feat(events): services, locks held by a card, and commits record events"
```

---

### Task 6: The board's activity and tail routes

**Depends on:** Task 5

**Files:**
- Create: `src/board/activity.mjs`
- Modify: `src/board/server.mjs`
- Create: `test/board.activity.test.mjs`
- Modify: `test/board.server.test.mjs`

**Interfaces:**
- Consumes: `readEvents`, `runningAgents` (Task 1); `listJobs`, `readJob`, `jobDir` (store).
- Produces: `activity(c, { cursor, limit }, { now }) → { events: [{ id, at, by, kind, ... }], cursor, running }`; `tail(c, id, rel, from) → { text, from, next, size }`; `ACTIVITY_LIMIT = 200`, `ACTIVITY_MAX = 500`, `TAIL_MAX = 65536`; routes `GET /activity.json?cursor=&limit=` and `GET /jobs/:id/tail?path=&from=`.

Semantics:
- No cursor: the newest `limit` events across all cards, oldest first, and a cursor at the end of every card's log.
- With a cursor: the events written since, oldest first, at most `limit`. Cards' logs are merged by `at` without ever skipping within a card: when the limit cuts, each card's cursor is the end of its last returned event, so the rest comes on the next call. A card new since the cursor starts at 0. A cursor this board did not give is `400 BAD_ARGS`.
- `running`: `runningAgents` over every card.
- Tail: only `.log`, `.jsonl` and `.md` files inside the card's folder (`403 FORBIDDEN_FILE` otherwise, including any path that escapes it); a missing file is `404 FILE_NOT_FOUND`; an unknown card `404 JOB_NOT_FOUND`; `from` past the end starts at 0; at most `TAIL_MAX` bytes, cut after the last newline when the read is full and holds one.

- [ ] **Step 1: Write the failing tests**

Create `test/board.activity.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { addJob, writeJobFile } from "../src/store.mjs";
import { appendEvent } from "../src/events.mjs";
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

test("activity: a limit never skips an event; the rest comes on the next call", () => {
  const c = cfg(); addJob(c, "milestone", "a"); addJob(c, "milestone", "b");
  const start = activity(c, {}).cursor;
  for (let i = 1; i <= 6; i++) appendEvent(c, i % 2 ? "m-1" : "m-2", { kind: "note", text: `n${i}` }, { now: t(i) });
  const seen = [];
  let cur = start;
  for (let k = 0; k < 5; k++) { const r = activity(c, { cursor: cur, limit: 2 }); seen.push(...notes(r)); cur = r.cursor; }
  assert.deepEqual(seen, ["m-1 n1", "m-2 n2", "m-1 n3", "m-2 n4", "m-1 n5", "m-2 n6"]);
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
```

Append to `test/board.server.test.mjs`:

```js
test("server: GET /activity.json and /jobs/:id/tail", async () => {
  const c = mk();
  actions.add(c, { kind: "milestone", title: "One" });
  writeJobFile(c, "m-1", "verify/suite.log", "green\n");
  await withBoard(c, {}, async (b) => {
    const a = await (await fetch(`${b.url}activity.json`)).json();
    assert.ok(a.events.some((e) => e.kind === "stage" && e.to === "backlog" && e.id === "m-1"));
    assert.equal(typeof a.cursor, "string"); assert.deepEqual(a.running, []);
    assert.equal((await fetch(`${b.url}activity.json?cursor=nope`)).status, 400);
    const t = await (await fetch(`${b.url}jobs/m-1/tail?path=verify/suite.log&from=0`)).json();
    assert.equal(t.text, "green\n");
    assert.equal((await fetch(`${b.url}jobs/m-1/tail?path=job.json`)).status, 403);
    assert.equal((await fetch(`${b.url}jobs/m-1/tail?path=nope.log`)).status, 404);
    assert.equal((await fetch(`${b.url}jobs/m-1/tail?path=verify/suite.log&from=-1`)).status, 400);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/board.activity.test.mjs test/board.server.test.mjs`
Expected: FAIL — `../src/board/activity.mjs` does not exist; the routes answer 404.

- [ ] **Step 3: Implement**

Create `src/board/activity.mjs`:

```js
import { openSync, readSync, closeSync, fstatSync, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { listJobs, readJob, jobDir } from "../store.mjs";
import { readEvents, runningAgents } from "../events.mjs";
import { fail } from "../errors.mjs";

export const ACTIVITY_LIMIT = 200;
export const ACTIVITY_MAX = 500;
export const TAIL_MAX = 64 * 1024;

const encodeCursor = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function decodeCursor(s) {
  try {
    const o = JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
    if (o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every((v) => Number.isInteger(v) && v >= 0)) return o;
  } catch { /* refused below */ }
  fail("BAD_ARGS", "the cursor is not one this board gave");
}

/** Every complete event of one card from `from`, each with its end offset. */
function eventsFrom(c, id, from) {
  const out = [];
  let off = from;
  for (;;) {
    const r = readEvents(c, id, { from: off });
    out.push(...r.events.map((e) => ({ ...e, id })));
    if (r.next === off || r.next >= r.size) return { events: out, end: r.next };
    off = r.next;
  }
}

/**
 * The board's timeline. With no cursor: the newest `limit` events across every card, oldest first, and a cursor
 * at the end of every card's log. With a cursor: what was written since, oldest first, at most `limit`, merged by
 * time without ever skipping within a card (each card's cursor is the end of its last returned event).
 */
export function activity(c, { cursor, limit } = {}, { now = Date.now() } = {}) {
  const n = Math.min(ACTIVITY_MAX, Math.max(1, Number.isInteger(limit) ? limit : ACTIVITY_LIMIT));
  const jobs = listJobs(c);
  const from = cursor === undefined || cursor === null || cursor === "" ? null : decodeCursor(cursor);
  const queues = jobs.map((j) => ({ id: j.id, start: from ? (from[j.id] ?? 0) : 0, ...eventsFrom(c, j.id, from ? (from[j.id] ?? 0) : 0) }));
  // A k-way merge by `at`: each card's events stay in file order, so a prefix of the merge is a prefix of every card.
  const merged = [];
  const heads = queues.map(() => 0);
  for (;;) {
    let best = -1;
    for (let i = 0; i < queues.length; i++) {
      const e = queues[i].events[heads[i]];
      if (e && (best < 0 || String(e.at).localeCompare(String(queues[best].events[heads[best]].at)) < 0)) best = i;
    }
    if (best < 0) break;
    merged.push(queues[best].events[heads[best]++]);
  }
  const next = Object.fromEntries(queues.map((q) => [q.id, q.end]));
  let events;
  if (!from) events = merged.slice(-n);
  else if (merged.length <= n) events = merged;
  else {
    events = merged.slice(0, n);
    for (const q of queues) next[q.id] = q.start;
    for (const e of events) next[e.id] = Math.max(next[e.id], e.end);
  }
  return { events: events.map(({ end, ...e }) => e), cursor: encodeCursor(next), running: runningAgents(c, jobs, { now }) };
}

/**
 * Up to TAIL_MAX bytes of one log in a card's folder from `from` (past the end: from 0), cut after the last
 * newline when the read is full and holds one. Only .log, .jsonl and .md files inside the card's folder.
 */
export function tail(c, id, rel, from = 0) {
  readJob(c, id);
  const base = resolve(jobDir(c, id));
  const f = resolve(base, String(rel ?? ""));
  if (!f.startsWith(base + sep) || !/\.(log|jsonl|md)$/i.test(f)) fail("FORBIDDEN_FILE", `"${rel}" is not a log in ${id}'s folder`);
  if (!existsSync(f) || !statSync(f).isFile()) fail("FILE_NOT_FOUND", `${id} has no ${rel}`);
  const fd = openSync(f, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Number.isInteger(from) && from >= 0 && from <= size ? from : 0;
    const len = Math.min(TAIL_MAX, size - start);
    const buf = Buffer.alloc(Math.max(0, len));
    const got = len > 0 ? readSync(fd, buf, 0, len, start) : 0;
    let used = got;
    if (got === TAIL_MAX) { const nl = buf.subarray(0, got).lastIndexOf(0x0a); if (nl >= 0) used = nl + 1; }
    return { text: buf.subarray(0, used).toString("utf8"), from: start, next: start + used, size };
  } finally { closeSync(fd); }
}
```

In `src/board/server.mjs`:
- import `{ activity, tail }` from `./activity.mjs`;
- extend `STATUS` with `FORBIDDEN_FILE: 403, FILE_NOT_FOUND: 404`;
- before the existing `GET .../file` route, add:

```js
      if (req.method === "GET" && url.pathname === "/activity.json") {
        const raw = url.searchParams.get("limit");
        const limit = raw === null ? undefined : Number(raw);
        if (limit !== undefined && !Number.isInteger(limit)) throw new SfactoryError("BAD_ARGS", "limit must be a whole number");
        return sendJson(res, 200, activity(view, { cursor: url.searchParams.get("cursor") ?? undefined, limit }));
      }
      if (req.method === "GET" && parts.length === 3 && parts[0] === "jobs" && parts[2] === "tail") {
        const raw = url.searchParams.get("from") ?? "0";
        const from = Number(raw);
        if (!Number.isInteger(from) || from < 0) throw new SfactoryError("BAD_ARGS", "from must be a whole number of bytes");
        return sendJson(res, 200, tail(view, parts[1], url.searchParams.get("path") ?? "", from));
      }
```

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/board.activity.test.mjs test/board.server.test.mjs` — Expected: PASS. Then `node --test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/board/activity.mjs src/board/server.mjs test/board.activity.test.mjs test/board.server.test.mjs
git commit -m "feat(board): the activity feed and a log tail, read by offset"
```

---

### Task 7: The skills, the docs and the version

**Depends on:** Task 6

**Files:**
- Modify: `skills/sdd/SKILL.md`
- Modify: `skills/sfactory/SKILL.md`
- Modify: `test/skills.test.mjs`
- Modify: `README.md`, `docs/DESIGN.md`
- Modify: `package.json`, `.claude-plugin/plugin.json`, `test/cli.test.mjs` (its version test)

**Interfaces:**
- Consumes: the touch flags (Task 3) and the Codex `--role`/`--task` flags (Task 4).
- Produces: the build skill touches with the structured form for Claude agents only and passes `--role`/`--task` to Codex runs; version `0.4.0`.

- [ ] **Step 1: Write the failing test**

In `test/skills.test.mjs`, replace the test "every agent start and finish is a job touch; no agents.log" with:

```js
test("every Claude agent's start and finish is a structured touch; a Codex run records itself; no agents.log", () => {
  const t = read(join(skillsRoot, "sdd", "SKILL.md"));
  assert.match(t, /sfactory job touch <JOB> --agent <start\|finish> --role <role> --task <n\|branch> --vendor claude --model <alias>/);
  assert.match(t, /A Codex run given `--job` records its own start and finish/);
  assert.match(t, /sfactory codex exec [^\n]*--role implementer --task <n>/);
  assert.ok(!t.includes("agents.log"), "the agents.log stand-in is gone");
  assert.match(read(join(skillsRoot, "sfactory", "SKILL.md")), /sfactory job touch <id> --agent <start\|finish> --role <role> --vendor claude --model <alias>/);
  for (const s of ["brainstorming", "writing-plans"]) assert.match(read(join(skillsRoot, s, "SKILL.md")), /sfactory job touch <JOB> --note/, `${s}: touches the job`);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/skills.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement**

In `skills/sdd/SKILL.md`, replace the touch paragraph (the line with `sfactory job touch <JOB> --note "<start|finish> <role> task <n> <alias|profile>"` and the sentence after it) with:

```markdown
`sfactory job touch <JOB> --agent <start|finish> --role <role> --task <n|branch> --vendor claude --model <alias>`, adding `--verdict ok` or `--verdict fixes` to a reviewer's finish.

A Codex run given `--job` records its own start and finish (with its stream's path, which the board follows live): do not touch for it. Pass it `--role` and `--task` so the board names it. A touch is best-effort: if it is refused, carry on — a missed touch never stops the work.
```

In the same file, every `sfactory codex exec ...` dispatch line gains `--role implementer --task <n>` (a fix round: `--role fixer --task <n>`), and every `sfactory codex review ...` line gains `--role code-reviewer --task <n>` (the branch bug-hunt: `--role bug-hunter --task branch`); the worked example near the end (the `[job touch: ...]` lines) says the Codex runs record themselves and the Claude reviewers are touched with `--agent`.

In `skills/sfactory/SKILL.md`, replace step 5 of section 3 with:

```markdown
5. **Touch at every Claude agent's start and finish**, best effort: `sfactory job touch <id> --agent <start|finish> --role <role> --vendor claude --model <alias>`. A Codex run given `--job` records itself. Outside a working stage the CLI prints "(not touched)" and still records the agent event. That is not an error.
```

In `README.md`, in "The board" section, add a bullet:

```markdown
- **Activity:** every card keeps an append-only `events.jsonl` (stage moves, gates, agent starts and finishes, suite runs, services, locks, commits). The board serves the recent events across all cards and the agents running now at `/activity.json`, and the tail of any log in a card's folder at `/jobs/<id>/tail?path=<file>&from=<offset>`. A Codex run records itself; a Claude agent is recorded by `sfactory job touch <id> --agent start|finish --role <role> --vendor claude`.
```

and add `--agent`, `--role`, `--task`, `--vendor`, `--model`, `--verdict` to the `touch` mention in the CLI list, and `--role`, `--task` to `sfactory codex`.

In `docs/DESIGN.md`, below the 2026-10-30 amendment, add: "*Amendment (2026-11-02):* each card keeps `events.jsonl`, written where things happen (`writeJob` for stage moves, the gates, `job touch --agent`, the Codex command, the suite, the services, the card-held locks, the commit); the board reads it through `/activity.json` and `/jobs/<id>/tail`. See part 2 of `docs/plans/2026-10-30-sfactory-roadmap-activity-design.md`."

Change `"version": "0.3.0"` to `"version": "0.4.0"` in `package.json` and `.claude-plugin/plugin.json`, and the version the test in `test/cli.test.mjs` expects.

- [ ] **Step 4: Run the tests, then the full suite**

Run: `node --test test/skills.test.mjs test/docs.test.mjs test/cli.test.mjs` — Expected: PASS. Then `node --test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/sdd/SKILL.md skills/sfactory/SKILL.md test/skills.test.mjs README.md docs/DESIGN.md package.json .claude-plugin/plugin.json test/cli.test.mjs
git commit -m "docs: structured touches, self-recording Codex runs, the activity routes; 0.4.0"
```
