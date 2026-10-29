# sfactory Board Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The kanban board of design §11: a localhost server that serves one static page reading the job folders, with the human gates (approve, answer, parallel, merged, stop, rework, request changes) as controls on the cards, each going through the state machine and nothing else.

**Architecture:** The job sub-commands move out of `commands/job.mjs` into `src/job-actions.mjs`, each action a function `(config, args) -> Job` that does its read-modify-write under a per-job lock; the CLI and the board server both call them. `src/board/server.mjs` is a dependency-free `node:http` server bound to `127.0.0.1` with three GET routes and one POST route per gate, refusing any request without the `X-Sfactory-Board: 1` header. `board/dashboard.html` is a single static file that polls `/jobs.json`. Everything is tested with `node:test` against a temp state dir and an ephemeral port.

**Tech Stack:** Node 20+ ESM, `node:http`, `node:test`; plain HTML/CSS/JS with no library; the page's palette and type follow the explainer artifact's tokens (dark-first, gold for value, mint for live).

## Global Constraints

- Everything in `docs/plans/2026-10-27-sfactory-core.md`'s Global Constraints still binds: ESM `.mjs`, no runtime dependencies, `node:path` for paths, `SfactoryError` for every refusal, no brand words, named-path commits with no trailers.
- **The board never starts an agent and never spends a token.** Its only writes are the human gates, each through `src/job-actions.mjs`.
- **One writer of state, now with concurrency:** every `job.json` read-modify-write (CLI or board) runs under the per-job lock `job:<id>` from `src/lock.mjs`; `writeJob` is called only inside it.
- The server binds `127.0.0.1` only; every POST requires the header `X-Sfactory-Board: 1` and a JSON body; a missing header is `403`, a bad body `400`, a refused transition `409` with `{ code, message }`, an unknown job `404`.
- The page works in light and dark, at phone width, and never shows a token, a secret or a lock body.
- Entry criterion from the core's whole-branch review (I8): Task 1 must land before any board write exists.

---

## File structure

```
src/
  job-actions.mjs          add, set, approve, park, answer, parallel, stop, resume, merged, rework,
                           requestChanges, show, list — each (c, args) -> Job, under the job lock
  store.mjs                writeJob under lock, unique temp name, exclusive job folder (modified)
  commands/job.mjs         thin: parses flags, calls job-actions (rewritten)
  board/
    server.mjs             startBoard(c, { port, host, demoDir }) -> { url, close }
    snapshot.mjs           buildSnapshot(c) -> the /jobs.json shape (pure over the store + locks)
  commands/board.mjs       sfactory board [--port n] [--demo]
board/dashboard.html
bin/sfactory-board
examples/jobs/             six example job folders for --demo and the tests
test/
  job-actions.test.mjs  store.lock.test.mjs  board.snapshot.test.mjs  board.server.test.mjs
  board.page.test.mjs   examples.jobs.test.mjs
```

---

### Task 1: Job-store concurrency — per-job lock, unique temp name, exclusive folder

**Files:**
- Modify: `src/store.mjs`
- Create: `test/store.lock.test.mjs`

**Interfaces:**
- Produces: `withJobLock(c, id, fn)` — acquires `job:<id>` via `acquireSync` with up to 40 retries 50 ms apart (`JOB_BUSY` after), runs `fn()`, releases in `finally`; `writeJob(c, job)` unchanged in signature but refuses to run unless the caller holds the job lock (it checks `status(c, "job:<id>").holder === process-local holder id`, where the holder id is `sfactory:<pid>:<random>` created once per process in `store.mjs`); unique temp name `job.json.<pid>.<random>.tmp` and a rename retried three times on `EPERM`/`EBUSY` 20 ms apart; `createJobFolder(c, id)` with a non-recursive `mkdirSync` (`EEXIST` → `JOB_EXISTS`); `nextId` stays, and `addJob(c, kind, title)` loops `nextId` + `createJobFolder` until one succeeds (bounded to 20 tries).
- Consumes: `acquireSync`, `release`, `status` from `src/lock.mjs`.

- [x] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { withJobLock, writeJob, readJob, addJob, jobDir, HOLDER } from "../src/store.mjs";
import { newJob } from "../src/job.mjs";
import { acquireSync, status } from "../src/lock.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-jl-"), limits: { lockStaleMs: 60_000 } });

test("store: writeJob refuses without the job lock, works inside withJobLock", () => {
  const c = cfg();
  const job = newJob({ id: "m-1", kind: "milestone", title: "t" });
  assert.throws(() => writeJob(c, job), (e) => e.code === "JOB_LOCK_REQUIRED");
  const out = withJobLock(c, "m-1", () => writeJob(c, job));
  assert.equal(out.id, "m-1");
  assert.equal(status(c, "job:m-1").held, false);
  assert.ok(!readdirSync(jobDir(c, "m-1")).some((n) => n.endsWith(".tmp")));
});

test("store: a held job lock makes withJobLock wait then fail JOB_BUSY", () => {
  const c = cfg();
  const l = acquireSync(c, "job:m-1", { holder: "other" });
  const t0 = Date.now();
  assert.throws(() => withJobLock(c, "m-1", () => 1, { retries: 4, delayMs: 20 }), (e) => e.code === "JOB_BUSY");
  assert.ok(Date.now() - t0 >= 60);
  l.release();
  assert.equal(withJobLock(c, "m-1", () => 2), 2);
});

test("store: addJob allocates ids exclusively and creates the folder", () => {
  const c = cfg();
  const a = addJob(c, "milestone", "A"), b = addJob(c, "milestone", "B");
  assert.deepEqual([a.id, b.id], ["m-1", "m-2"]);
  assert.ok(existsSync(join(jobDir(c, "m-2"), "job.json")));
  assert.equal(readJob(c, "m-1").title, "A");
});

test("store: HOLDER is per process and withJobLock releases on throw", () => {
  const c = cfg();
  assert.match(HOLDER, /^sfactory:\d+:[0-9a-f-]+$/);
  assert.throws(() => withJobLock(c, "m-9", () => { throw new Error("boom"); }), /boom/);
  assert.equal(status(c, "job:m-9").held, false);
});
```

- [x] **Step 2: Run it to see it fail** — `node --test test/store.lock.test.mjs` (named exports missing).

- [x] **Step 3: Implement in `src/store.mjs`**

```js
import { randomUUID } from "node:crypto";
import { acquireSync, release, status } from "./lock.mjs";
export const HOLDER = `sfactory:${process.pid}:${randomUUID()}`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withJobLock(c, id, fn, { retries = 40, delayMs = 50 } = {}) {
  assertId(id);
  let lock;
  for (let i = 0; ; i++) {
    try { lock = acquireSync(c, `job:${id}`, { holder: HOLDER, pid: process.pid }); break; }
    catch (e) { if (e.code !== "LOCK_HELD" || i >= retries) fail("JOB_BUSY", `${id} is being written by another process: ${e.message}`); sleepSync(delayMs); }
  }
  try { return fn(); } finally { try { lock.release(); } catch {} }
}

export function writeJob(c, job) {
  const s = status(c, `job:${job.id}`);
  if (!s.held || s.holder !== HOLDER) fail("JOB_LOCK_REQUIRED", `writeJob(${job.id}) needs withJobLock`);
  mkdirSync(jobDir(c, job.id), { recursive: true });
  job.updated = new Date().toISOString();
  const f = jobFile(c, job.id);
  const tmp = `${f}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2) + "\n");
  for (let i = 0; ; i++) {
    try { renameSync(tmp, f); break; }
    catch (e) { if (!["EPERM", "EBUSY"].includes(e.code) || i >= 2) { try { unlinkSync(tmp); } catch {} throw e; } sleepSync(20); }
  }
  return job;
}

export function createJobFolder(c, id) {
  assertId(id);
  mkdirSync(jobsDir(c), { recursive: true });
  try { mkdirSync(jobDir(c, id)); } catch (e) { if (e.code === "EEXIST") fail("JOB_EXISTS", `${id} already exists`); throw e; }
}

export function addJob(c, kind, title, { now } = {}) {
  for (let i = 0; i < 20; i++) {
    const id = nextId(c, kind);
    try { createJobFolder(c, id); } catch (e) { if (e.code === "JOB_EXISTS") continue; throw e; }
    return withJobLock(c, id, () => writeJob(c, newJob({ id, kind, title, now })));
  }
  fail("JOB_BUSY", `could not allocate a ${kind} id after 20 tries`);
}
```

`newJob` is imported from `./job.mjs` (no cycle: `job.mjs` imports nothing from the store). `nextId` must also count folders without a `job.json` (a folder created by `createJobFolder` whose write has not landed yet): change it to list every directory under `jobs/` matching the id pattern.

- [x] **Step 4: Fix every caller of `writeJob`** — `commands/job.mjs`, `commands/worktree.mjs`, `commands/ports.mjs` now wrap their read-modify-write in `withJobLock(c, id, () => …)`; `commands/job.mjs`'s `add` calls `addJob`. The existing suite must stay green: run bare `node --test`.

- [x] **Step 5: Commit**

```bash
git add src/store.mjs src/commands/job.mjs src/commands/worktree.mjs src/commands/ports.mjs test/store.lock.test.mjs
git commit -m "feat(store): per-job lock around every job write, unique temp names, exclusive job folders"
```

---

### Task 2: `src/job-actions.mjs` — the gates as functions, CLI rewritten over them

**Files:**
- Create: `src/job-actions.mjs`, `test/job-actions.test.mjs`
- Modify: `src/commands/job.mjs` (becomes flag parsing only)

**Interfaces:**
- Produces: `actions` object of `(c, args) -> Job` functions, every one running inside `withJobLock` and re-reading the job there: `add({ kind, title })`, `set({ id, to, by, reason })`, `approve({ id, by })`, `park({ id, reason, pending, by })`, `answer({ id, by, text? })` (when `text` is given it writes `decisions/<k>-answer.md` first), `parallel({ id, yes, by })`, `stop({ id, reason, by })`, `resume({ id, by })`, `merged({ id, by })`, `rework({ id, notes, by })`, `requestChanges({ id, notes, by })` (allowed only in `awaiting-approval`: writes `plan/changes-<k>.md`, appends a history entry `{ to: same stage, reason: "changes requested" }`, stage unchanged), `show({ id })`, `list()`. Each refusal is the same `SfactoryError` the CLI threw before; `by` defaults to `"session"`.
- Consumes: Task 1's `withJobLock`, `addJob`; `src/job.mjs`.

- [x] **Step 1: Write the failing tests** — port the three command tests of the core's Task 4 to call `actions.*` directly on a temp config (`{ stateDir, limits }`), plus: `answer({ text })` writes the answer file and releases; `requestChanges` on `awaiting-approval` writes `plan/changes-1.md` and keeps the stage, and is `ILLEGAL_TRANSITION` elsewhere; every action leaves `job:<id>` unheld afterwards; `set` from a job held by another holder → `JOB_BUSY`.

- [x] **Step 2: Implement** — move the bodies of the twelve sub-commands into `actions`, replacing `readJob` + `writeJob` pairs with `withJobLock(c, id, () => { const job = readJob(c, id); … return writeJob(c, next); })`; `commands/job.mjs` becomes: parse `positional`/`flags` into the args object, call `actions[name]`, print `${job.id} ${job.stage}` or JSON. Keep the `set` refusal for `awaiting-approval` and the `building`-from-`reviewing/pushed` refusal.

- [x] **Step 3: Run `node --test`** — the old `test/job.test.mjs` command tests must still pass unchanged.

- [x] **Step 4: Commit** — `feat(job): gate actions as functions under the job lock; the CLI calls them`.

---

### Task 3: The snapshot — `/jobs.json`'s shape

**Files:**
- Create: `src/board/snapshot.mjs`, `test/board.snapshot.test.mjs`

**Interfaces:**
- Produces: `buildSnapshot(c, { now }) -> Snapshot`:
  ```
  { project, generatedAt, columns: ["Backlog","Plan","Needs you","In process","Review","Fixed","Pushed / PR","Done","Stopped"],
    jobs: [{ id, kind, title, stage, column, pending, returnStage, branch, base, worktree, ports, slug,
             tasks, round, rework, parallel, started, updated, ended, elapsedMs,
             cost: { usd, unpriced }, files: ["plan/questionnaire.md", …], needsYou: { action, command } | null,
             prText: string | null }],
    locks: { live: { held, holder, since }, suite: {…}, commit: {…} },
    ports: [{ id, ports }] }
  ```
  `needsYou` is `{ action: "approve" }` for `awaiting-approval`, `{ action: "answer", question: <decisions/<k>.md text> }` or `{ action: "parallel", reason: <plan/parallel.md> }` for `decision-needed`, `{ action: "merged" }` for `pushed`; `command` is the equivalent CLI line. `files` lists every `.md` and `.log` under the job folder, relative, sorted. **Never** included: `lockToken`, any lock body token, `secrets`, the `.tmp` files.
- Consumes: `listJobs`, `readJobFile`, `readCost`, `lock.status`, `COLUMNS`.

- [x] **Step 1: Tests** — on a temp state dir with three jobs (one parked with a question, one awaiting approval, one pushed with `pr.md`): columns mapped per `COLUMNS` (`stopped` → "Stopped"), `needsYou` shapes, `files` sorted and without `.tmp`, `lockToken` absent from every job, `cost.usd` from `cost.json`, `elapsedMs` from `started` to `ended ?? now`.

- [x] **Step 2: Implement** `buildSnapshot` as pure reads; strip fields with an explicit allow-list (never spread the job).

- [x] **Step 3: Commit** — `feat(board): the jobs snapshot`.

---

### Task 4: The server

**Files:**
- Create: `src/board/server.mjs`, `test/board.server.test.mjs`

**Interfaces:**
- Produces: `startBoard(c, { port = c.board.port, host = "127.0.0.1", demoDir = null, log = console.error }) -> Promise<{ url, port, close() }>`. Routes:
  - `GET /` → `board/dashboard.html` (read once at start, `text/html; charset=utf-8`, `Cache-Control: no-store`).
  - `GET /jobs.json` → `buildSnapshot(c)` (or over `demoDir` as the state dir when given), `application/json`, `no-store`.
  - `GET /jobs/:id/file?path=<rel>` → the file's text (`text/plain`), `BAD_PATH`/`BAD_ID` → 400, missing → 404; refuses `job.json` and anything not `.md`/`.log`.
  - `POST /jobs/:id/:action` with `X-Sfactory-Board: 1`, JSON body `{ by?, text?, notes?, yes?, reason? }`; `action` ∈ `approve answer parallel merged stop rework request-changes`; calls `actions[...]` with `by: body.by ?? "board"`; answers `200 { job }`; a `SfactoryError` → `409` for `ILLEGAL_TRANSITION`/`ANSWER_REQUIRED`/`JOB_BUSY`, `404` for `JOB_NOT_FOUND`, `400` for `BAD_ARGS`/`BAD_ID`, else `500` with the code only. Demo mode refuses every POST with `403 { code: "DEMO" }`.
  - Anything else → 404 JSON. Bodies over 64 KiB → 413. Requests to a `Host` other than `127.0.0.1:<port>`/`localhost:<port>` → 403.
- Consumes: Task 2's `actions`, Task 3's `buildSnapshot`.

- [x] **Step 1: Tests** (with `fetch` against `port: 0`): the page is served; `/jobs.json` lists a job; the file route serves `plan/questionnaire.md` and refuses `../x` and `job.json`; `POST approve` without the header → 403; with it on a `backlog` job → 409 `ILLEGAL_TRANSITION`; on an `awaiting-approval` job → 200 and the job is `building` with `plan/approval.md` written by `board`; `POST answer` with `{ text }` releases a parked job; `POST parallel { yes: false }` → `backlog` with `parallel: "queued"`; demo mode → 403 on POST; `close()` frees the port.

- [x] **Step 2: Implement** with `node:http`; parse JSON bodies by hand (`for await` chunks, size cap); map errors in one `respondError(res, e)`.

- [x] **Step 3: Commit** — `feat(board): localhost server with the snapshot, file and gate routes`.

---

### Task 5: The page

**Files:**
- Create: `board/dashboard.html`, `test/board.page.test.mjs`

**Interfaces:**
- The page fetches `/jobs.json` every `pollMs` (read from the snapshot's `project` block as `board.pollMs`, default 2000), pauses polling when `document.hidden`, renders nine columns (Stopped only when non-empty), cards per Task 3's fields, a drawer (`GET /jobs/:id/file`) rendering `.md`/`.log` as preformatted text with the first line as a verdict badge when it matches `✅|❌|Approved|Needs fixes|ok|red`, and the gate controls: *Approve* / *Request changes* (textarea) on `awaiting-approval`; the question text and an *Answer* textarea on a decision; *Run in parallel* / *Queue it* with the reason shown; *Copy PR text* / *Mark merged* on `pushed`; *Stop* on every working card and *Rework* (textarea) on `reviewing`/`pushed`. Each control POSTs with the header and shows the server's `message` on refusal, inline on the card. Footer: running agents is **not** shown (nothing knows it yet) — instead the `live`, `suite` and `commit` lock holders, the ports in use, and the day's cost with "API-equivalent". A `demo` banner when the snapshot carries `demo: true`.
- Design: tokens and type as the explainer page (`:root` dark-first, light under `prefers-color-scheme: light` and `[data-theme="light"]`, IBM Plex Sans/Mono via Google Fonts with fallbacks); phone width scrolls the board sideways; gutters per the artifact rules; no inline event handlers (CSP-friendly), one `<script>`.

- [x] **Step 1: The page test** (static checks, since there is no browser runner): the file parses as HTML enough to contain `id="board"`, nine `data-column` headers, `fetch("/jobs.json")`, the `X-Sfactory-Board` header string in the POST helper, no `lockToken` string, no `<script src=`, and both theme blocks.

- [x] **Step 2: Write the page.** Keep it under 900 lines; derive every colour from the tokens; copy the artefact's card/column CSS where it fits.

- [x] **Step 3: Commit** — `feat(board): the dashboard page`.

---

### Task 6: `sfactory board`, the shim, demo jobs, README, headed check

**Files:**
- Create: `src/commands/board.mjs`, `bin/sfactory-board`, `examples/jobs/<six folders>`, `test/examples.jobs.test.mjs`
- Modify: `README.md`, `package.json` (`files` already lists `board` and `examples`)

**Interfaces:**
- `sfactory board [--port n] [--demo]` starts the server (demo → `examples/jobs` as the state dir, no config needed outside a repo), prints the URL, stays up until `Ctrl+C`; with `--once` (test hook) it starts, prints and exits.
- `examples/jobs/`: `m-1` merged, `m-2` pushed with `pr.md`, `m-3` building with tasks and a `cost.json`, `m-4` awaiting-approval with `plan/questionnaire.md`, `f-1` decision-needed with `decisions/1.md`, `f-2` stopped — every `job.json` produced by `job.mjs`'s functions in a generator script committed as `examples/jobs/generate.mjs` (so the fixtures never drift from the schema), with tokens scrubbed.
- Test: the generator's output equals the committed folders (run it to a temp dir and compare), and `buildSnapshot` over `examples/jobs` lists six jobs across the expected columns.

- [x] **Step 1: Tests, generator, fixtures, command, shim, README section ("The board": start, demo, what the gates do, that it binds localhost only).**
- [x] **Step 2: Headed check (controller).** The controller opens `sfactory board --demo` in a headed `agent-browser` with an isolated profile, screenshots light and dark at desktop and 400 px, clicks a card's drawer, and attempts *Approve* on the demo (expects the 403 banner). Findings go back to the implementer as a fix round; the screenshots go under the plan's workspace, never the repo.
- [x] **Step 3: Commit** — `feat(board): board command, demo jobs and README`.

---

## Self-review

Spec coverage: design §11 every sentence → Tasks 3–6; §1 principle 3 and the core review's I8 → Tasks 1–2; §12's "board can do nothing the script refuses" → Task 4's error mapping over Task 2's actions. Placeholders: Tasks 2–6 give interfaces and test lists rather than full code for the page and the server bodies; each is fully determined by its interface block and the design. Types: `actions[name](c, args)` is the one signature used by Tasks 2, 4 and 6; `buildSnapshot(c, { now })` by Tasks 3, 4, 6; `withJobLock(c, id, fn, opts)` by Tasks 1, 2.
