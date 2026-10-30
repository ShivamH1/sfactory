# sfactory Part 1 — Milestones, External running, numbers and import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cards can wait in a Milestones column and run outside the factory in an External running column, carry an M-number every person-facing command accepts, and arrive in bulk through `sfactory job import`.

**Architecture:** Two stages (`roadmap`, `external`) join the state machine in `src/job.mjs`; neither is a working stage nor counts toward the milestone cap. A card gains optional `number`, `after`, `externalNote`, `pr`, `prUrl` fields. New gates `start` and `external` live in `src/job-actions.mjs`; the import is its own module, `src/import.mjs`, writing whole jobs through a new store helper. The board page shows the new columns and fields with today's styling (the redesign is Part 3).

**Tech Stack:** Node ≥ 20, ESM `.mjs`, `node:test` + `node:assert/strict`, zero runtime dependencies.

**Spec:** `docs/plans/2026-10-30-sfactory-roadmap-activity-design.md`, sections 2, 3, 7 (the run loop and commands), 10 part 1 and 11.

**Where this plan departs from the spec, on purpose:**
- `M<n>` is resolved in the person-facing id arguments: every `sfactory job` verb, `sfactory worktree` (and its `--from` / `--base-of`) and `sfactory services`. The internal flags the skills pass (`--job`, `--holder`, `ports allocate`) keep taking the job id the skills already hold.
- An unknown `M<n>` is `JOB_NOT_FOUND`, the code the CLI already uses for an unknown id, not a new `NOT_FOUND`.
- The import's one `stage` event per card (spec §3, last bullet) lands with the event log in Part 2.
- The board's look stays as it is; only the columns, the number pill, *Start* and the external note are added (the redesign is Part 3).

## Global Constraints

- Node 20 or later; `"dependencies": {}` stays empty.
- ESM only; every file is `.mjs`; imports carry the `.js`/`.mjs` extension as the existing files do.
- The plugin is generic: no company, product, person or machine-specific word in any file (`test/docs.test.mjs` refuses `thrive`, `truworth`, `C:/tw-wt`). Examples are invented.
- Every `sfactory ...` command line written in README, INSTALL, DESIGN or a skill must use a registered verb, sub-verb and flag (`test/docs.test.mjs` checks this against each command's `ACCEPTS`).
- Errors are thrown with `fail(code, message)` from `src/errors.mjs`; codes are SCREAMING_SNAKE.
- Job writes happen only inside `withJobLock`; `writeJob` refuses otherwise.
- Never `git stash` (the stash stack is shared with other worktrees); stage named paths only, never `git add -A` or `git add .`; commits carry no trailers.
- The full suite (`node --test`) must be green at the end of every task; run it on a quiet machine.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/job.mjs` | stages, columns, transitions, the job's shape | two stages, three edges, `NUMBER_RE`, `newJob` options |
| `src/store.mjs` | job files, ids, locks | `addJobWith`, `addJob` options, `resolveId` |
| `src/job-actions.mjs` | the gates | `OFF` list, `add` options, `start`, `external` |
| `src/record.mjs` | record paths at the cut | a numbered card's `{n}` |
| `src/import.mjs` (new) | validate and write an import file | all of it |
| `src/commands/job.mjs` | `sfactory job` flag parsing | `start`, `external`, `import`, `--number --roadmap --after`, id resolution |
| `src/commands/worktree.mjs`, `src/commands/services.mjs` | person-facing id arguments | resolve `M<n>` |
| `src/board/snapshot.mjs` | what the board sees | columns, allow-listed fields |
| `src/board/server.mjs` | board routes | `start` route, three status codes |
| `board/dashboard.html` | the page | two columns, number pill, Start, external note |
| `skills/sfactory/SKILL.md` | the orchestrator | commands, run-loop skip |
| `README.md`, `INSTALL.md`, `docs/DESIGN.md` | docs | commands, columns, "Bringing an existing project" |
| `package.json`, `.claude-plugin/plugin.json` | version | 0.2.0 → 0.3.0 |
| `test/*.test.mjs` | tests | per task |

---

### Task 1: The two stages in the state machine

**Depends on:** none

**Files:**
- Modify: `src/job.mjs`
- Modify: `src/job-actions.mjs` (the cap's off-list only)
- Modify: `src/board/snapshot.mjs` (`BOARD_COLUMNS` only)
- Modify: `test/job.test.mjs`
- Modify: `test/job-actions.test.mjs`
- Modify: `test/board.snapshot.test.mjs`

**Interfaces:**
- Produces: `STAGES` includes `"roadmap"` and `"external"`; `COLUMNS.roadmap === "Milestones"`, `COLUMNS.external === "External running"`; `TRANSITIONS.roadmap = ["backlog", "external"]`, `TRANSITIONS.backlog = ["planning", "external"]`, `TRANSITIONS.external = ["merged"]`; `newJob({ id, kind, title, now, stage = "backlog", number, after })` where `stage` is `"backlog"` or `"roadmap"` and `number`/`after` are included only when given; `OFF_STAGES` exported from `src/job-actions.mjs`; `BOARD_COLUMNS` in the order Milestones, Backlog, Plan, Needs you, In process, Review, Fixed, Pushed / PR, External running, Done, Stopped.

- [ ] **Step 1: Write the failing tests**

Append to `test/job.test.mjs`:

```js
import { STAGES, COLUMNS, TRANSITIONS, WORKING, newJob, transition, stop } from "../src/job.mjs";

test("job: roadmap and external are stages with their own columns, never working", () => {
  for (const s of ["roadmap", "external"]) { assert.ok(STAGES.includes(s), s); assert.ok(!WORKING.includes(s), s); }
  assert.equal(COLUMNS.roadmap, "Milestones");
  assert.equal(COLUMNS.external, "External running");
  assert.deepEqual(TRANSITIONS.roadmap, ["backlog", "external"]);
  assert.deepEqual(TRANSITIONS.backlog, ["planning", "external"]);
  assert.deepEqual(TRANSITIONS.external, ["merged"]);
});

test("job: newJob can start in roadmap and carries number and after only when given", () => {
  const plain = newJob({ id: "m-1", kind: "milestone", title: "t", now: "2026-01-01T00:00:00.000Z" });
  assert.equal(plain.stage, "backlog");
  assert.equal("number" in plain, false); assert.equal("after" in plain, false);
  const r = newJob({ id: "m-2", kind: "milestone", title: "t", now: "2026-01-01T00:00:00.000Z", stage: "roadmap", number: "14", after: "M13" });
  assert.equal(r.stage, "roadmap"); assert.equal(r.number, "14"); assert.equal(r.after, "M13");
  assert.deepEqual(r.history, [{ at: "2026-01-01T00:00:00.000Z", from: null, to: "roadmap", by: "session", reason: "created" }]);
  assert.throws(() => newJob({ id: "m-3", kind: "milestone", title: "t", stage: "building" }), (e) => e.code === "BAD_ARGS");
});

test("job: roadmap -> backlog -> planning, roadmap -> external -> merged; external cannot plan; both can stop", () => {
  const r = newJob({ id: "m-1", kind: "milestone", title: "t", stage: "roadmap" });
  assert.equal(transition(r, "backlog").stage, "backlog");
  const ext = transition(r, "external");
  assert.equal(ext.stage, "external");
  assert.equal(transition(ext, "merged").stage, "merged");
  assert.throws(() => transition(ext, "planning"), (e) => e.code === "ILLEGAL_TRANSITION");
  assert.throws(() => transition(r, "planning"), (e) => e.code === "ILLEGAL_TRANSITION");
  assert.equal(stop(r).stage, "stopped");
  assert.equal(stop(ext).stage, "stopped");
});
```

(If `test/job.test.mjs` already imports some of these names, merge the import lines rather than duplicating them.)

Append to `test/job-actions.test.mjs`:

```js
import { OFF_STAGES, activeMilestones } from "../src/job-actions.mjs";
import { newJob } from "../src/job.mjs";
import { createJobFolder } from "../src/store.mjs";

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
```

In `test/board.snapshot.test.mjs`, the existing `COLS` constant (line 12) pins today's columns; change it to the new list, and add `BOARD_COLUMNS` to the import from `../src/board/snapshot.mjs`:

```js
const COLS = ["Milestones", "Backlog", "Plan", "Needs you", "In process", "Review", "Fixed", "Pushed / PR", "External running", "Done", "Stopped"];

test("snapshot: the columns, Milestones first and External running before Done", () => {
  assert.deepEqual(BOARD_COLUMNS, COLS);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/job.test.mjs test/job-actions.test.mjs test/board.snapshot.test.mjs`
Expected: FAIL — `roadmap` is not a stage, `OFF_STAGES` is undefined, `BOARD_COLUMNS` lacks the two columns.

- [ ] **Step 3: Implement**

In `src/job.mjs`, replace the four constants and `newJob`:

```js
export const STAGES = ["roadmap", "backlog", "planning", "awaiting-approval", "building", "reviewing", "fixing", "verifying", "pushing", "pushed", "external", "merged", "decision-needed", "stopped"];
export const TERMINAL = ["merged"];
export const WORKING = ["planning", "building", "reviewing", "fixing", "verifying", "pushing"];
export const COLUMNS = {
  roadmap: "Milestones", backlog: "Backlog", planning: "Plan", "awaiting-approval": "Needs you", building: "In process", reviewing: "Review",
  fixing: "Fixed", verifying: "Fixed", pushing: "Pushed / PR", pushed: "Pushed / PR", external: "External running", merged: "Done",
  "decision-needed": "Needs you", stopped: "Stopped",
};
/** Edges other than park/stop, which are added per call. "awaiting-approval -> building" also needs the approval file (commands/job.mjs). */
export const TRANSITIONS = {
  roadmap: ["backlog", "external"],
  backlog: ["planning", "external"],
  planning: ["awaiting-approval", "building"],
  "awaiting-approval": ["building"],
  building: ["reviewing"],
  reviewing: ["fixing", "verifying", "building"],
  fixing: ["reviewing"],
  verifying: ["pushing", "fixing"],
  pushing: ["pushed"],
  pushed: ["merged", "building"],
  external: ["merged"],
  merged: [],
  "decision-needed": [],   // only release()
  stopped: [],             // only resume()
};
/** A milestone number: a whole number or one with a single decimal part ("57", "29.1"). */
export const NUMBER_RE = /^\d+(\.\d+)?$/;

export function newJob({ id, kind, title, now = new Date().toISOString(), stage = "backlog", number, after }) {
  if (!["milestone", "fix"].includes(kind)) fail("BAD_KIND", `kind must be milestone or fix, got ${kind}`);
  if (!["backlog", "roadmap"].includes(stage)) fail("BAD_ARGS", `a new card starts in backlog or roadmap, not ${stage}`);
  return {
    id, kind, title, stage, returnStage: null, previousStage: null, pending: null,
    branch: null, base: null, worktree: null, ports: null, record: null,
    tasks: { total: 0, done: 0, parallel: [] }, round: 0, rework: 0, parallel: null, agents: null, cost: 0,
    started: now, updated: now, ended: null,
    ...(number !== undefined ? { number } : {}),
    ...(after !== undefined ? { after } : {}),
    history: [{ at: now, from: null, to: stage, by: "session", reason: "created" }],
  };
}
```

In `src/job-actions.mjs`, replace `activeMilestones` and `countsAt`:

```js
/** Stages that never count toward limits.parallelMilestones: not started, outside the factory, or finished. */
export const OFF_STAGES = ["roadmap", "backlog", "external", "pushed", "merged", "stopped"];

/**
 * The milestones that count toward limits.parallelMilestones: from planning until pushed, merged or stopped. A card
 * in roadmap, backlog or external does not count, a queued one (parallel: queued) included, nor one parked for a
 * parallel proposal from backlog (it has not started).
 */
export function activeMilestones(c, exceptId = null) {
  return listJobs(c).filter((j) => j.id !== exceptId && j.kind === "milestone" && !OFF_STAGES.includes(j.stage) && !(j.stage === "decision-needed" && j.returnStage === "backlog"));
}

/** Is a card resting at `stage` one that counts toward the cap? (the same rule as activeMilestones, for a stage not yet written) */
const countsAt = (job, stage) => !OFF_STAGES.includes(stage) && !(stage === "decision-needed" && job.returnStage === "backlog");
```

In `src/board/snapshot.mjs`:

```js
export const BOARD_COLUMNS = ["Milestones", "Backlog", "Plan", "Needs you", "In process", "Review", "Fixed", "Pushed / PR", "External running", "Done", "Stopped"];
```

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/job.test.mjs test/job-actions.test.mjs test/board.snapshot.test.mjs`
Expected: PASS.
Run: `node --test`
Expected: PASS. If `test/board.page.test.mjs` fails because the page's column sections no longer match `BOARD_COLUMNS`, add the two sections to `board/dashboard.html` now (Task 6's Step 3 shows them: a `Milestones` section first and an `External running` section before `Done`) and rerun.

- [ ] **Step 5: Commit**

```bash
git add src/job.mjs src/job-actions.mjs src/board/snapshot.mjs test/job.test.mjs test/job-actions.test.mjs test/board.snapshot.test.mjs
git commit -m "feat(job): roadmap and external stages, outside the cap and the working stages"
```

(Add `board/dashboard.html` to the `git add` line if Step 4 needed it.)

---

### Task 2: Milestone numbers, `add --roadmap`, and `M<n>` ids

**Depends on:** Task 1

**Files:**
- Modify: `src/store.mjs`
- Modify: `src/job-actions.mjs` (`add`)
- Modify: `src/commands/job.mjs`
- Modify: `src/commands/worktree.mjs`
- Modify: `src/commands/services.mjs`
- Modify: `src/board/server.mjs` (`STATUS` only)
- Modify: `test/store.test.mjs`
- Modify: `test/job-actions.test.mjs`
- Create: `test/cli.job.test.mjs`

**Interfaces:**
- Consumes: `newJob({ ..., stage, number, after })`, `NUMBER_RE` (Task 1).
- Produces: `addJobWith(c, kind, make)` in `src/store.mjs` — allocates the next id of `kind`, calls `make(id)` for the full job object and writes it under the job lock, returning it; `addJob(c, kind, title, { now, logOf, stage, number, after })`; `resolveId(c, ref)` → a job id string (`"m-3"`) for `"M14"`/`"m14"` style refs, `ref` unchanged otherwise, `JOB_NOT_FOUND` when no card carries the number, `AMBIGUOUS` when two do; `actions.add(c, { kind, title, logOf, number, roadmap, after })` refusing `BAD_NUMBER` and `NUMBER_TAKEN`.

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.mjs`:

```js
import { addJob, addJobWith, resolveId, readJob } from "../src/store.mjs";
import { newJob } from "../src/job.mjs";

test("store: addJobWith writes the job make() builds under the next id", () => {
  const c = { stateDir: tmpDir("sf-st-"), limits: { lockStaleMs: 60_000 } };
  const j = addJobWith(c, "milestone", (id) => ({ ...newJob({ id, kind: "milestone", title: "x" }), stage: "merged" }));
  assert.equal(j.id, "m-1"); assert.equal(readJob(c, "m-1").stage, "merged");
  assert.equal(addJob(c, "milestone", "y", { stage: "roadmap", number: "7", after: "M6" }).id, "m-2");
  assert.equal(readJob(c, "m-2").stage, "roadmap");
});

test("store: resolveId maps M<n> to the card carrying that number", () => {
  const c = { stateDir: tmpDir("sf-st-"), limits: { lockStaleMs: 60_000 } };
  addJob(c, "milestone", "a", { number: "14" });
  addJob(c, "milestone", "b", { number: "29.1" });
  assert.equal(resolveId(c, "M14"), "m-1");
  assert.equal(resolveId(c, "m29.1"), "m-2");
  assert.equal(resolveId(c, "m-2"), "m-2");
  assert.equal(resolveId(c, "f-9"), "f-9");
  assert.throws(() => resolveId(c, "M99"), (e) => e.code === "JOB_NOT_FOUND" && /M99/.test(e.message));
});
```

(Use the file's existing `tmpDir` import; add it from `./helpers.mjs` if absent.)

Append to `test/job-actions.test.mjs`:

```js
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
```

Create `test/cli.job.test.mjs` (the CLI driven in-process through `main`, against a temp repo with the smallest valid config, as `test/config.test.mjs` does):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";

const repo = () => { const r = tmpRepo(); writeConfig(r, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } }); return r; };
async function run(cwd, args) {
  const out = [], err = [];
  const code = await main(args, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
}

test("cli: job add --number --roadmap --after, and M<n> accepted as an id", async () => {
  const r0 = repo();
  let r = await run(r0, ["job", "add", "milestone", "Audit", "log", "--number", "14", "--roadmap", "--after", "M13"]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^m-1 roadmap/);
  r = await run(r0, ["job", "show", "M14"]);
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).id, "m-1");
  assert.notEqual((await run(r0, ["job", "show", "M99"])).code, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/store.test.mjs test/job-actions.test.mjs test/cli.job.test.mjs`
Expected: FAIL — `addJobWith` and `resolveId` are not exported; `add` ignores `number`; the CLI refuses `--number`.

- [ ] **Step 3: Implement**

In `src/store.mjs`, replace `addJob` and add `addJobWith` and `resolveId`:

```js
/** Allocate the next id of `kind`, build the job with make(id) and write it under its lock. */
export function addJobWith(c, kind, make) {
  for (let i = 0; i < 20; i++) {
    const id = nextId(c, kind);
    try { createJobFolder(c, id); } catch (e) { if (e.code === "JOB_EXISTS") continue; throw e; }
    return withJobLock(c, id, () => writeJob(c, make(id)));
  }
  fail("JOB_BUSY", `could not allocate a ${kind} id after 20 tries`);
}

export function addJob(c, kind, title, { now, logOf, stage, number, after } = {}) {
  return addJobWith(c, kind, (id) => ({
    ...newJob({ id, kind, title, now, ...(stage !== undefined ? { stage } : {}), ...(number !== undefined ? { number } : {}), ...(after !== undefined ? { after } : {}) }),
    ...(logOf !== undefined ? { logOf } : {}),
  }));
}

/** "M14" (any case, with or without the dash-less form) names the card whose number is "14"; anything else is returned as given. */
export function resolveId(c, ref) {
  const m = /^m(\d+(?:\.\d+)?)$/i.exec(String(ref ?? ""));
  if (!m) return ref;
  const hits = listJobs(c).filter((j) => j.number === m[1]);
  if (!hits.length) fail("JOB_NOT_FOUND", `no card carries the number M${m[1]}`);
  if (hits.length > 1) fail("AMBIGUOUS", `M${m[1]} is carried by ${hits.map((j) => j.id).join(" and ")}; fix the job files by hand`);
  return hits[0].id;
}
```

In `src/job-actions.mjs`, add `NUMBER_RE` to the import from `./job.mjs` and replace `add`:

```js
  add(c, { kind, title, logOf, number, roadmap, after }) {
    if (!kind || !title) fail("BAD_ARGS", 'usage: sfactory job add <milestone|fix> "<title>"');
    if (kind !== "milestone" && kind !== "fix") fail("BAD_ARGS", 'kind must be "milestone" or "fix"');
    if (kind === "fix" && (number !== undefined || roadmap || after !== undefined)) fail("BAD_ARGS", "--number, --roadmap and --after are for a milestone card");
    if (after !== undefined && (typeof after !== "string" || !after.trim() || after.length > 80)) fail("BAD_ARGS", "--after needs text of at most 80 characters");
    if (number !== undefined && !NUMBER_RE.test(String(number))) fail("BAD_NUMBER", `"${number}" is not a milestone number (a whole number, or one like 29.1)`);
    if (logOf !== undefined) {
      if (kind !== "fix") fail("BAD_ARGS", "--log is for a fix card: the milestone whose log takes the fix's dated note");
      if (!/^[1-9]\d*$/.test(String(logOf))) fail("BAD_ARGS", "--log needs a positive whole number");
      return addJob(c, kind, title, { logOf: Number(logOf) });
    }
    const opts = { ...(roadmap ? { stage: "roadmap" } : {}), ...(number !== undefined ? { number: String(number) } : {}), ...(after !== undefined ? { after } : {}) };
    if (number === undefined) return addJob(c, kind, title, opts);
    // The duplicate check and the write share the record lock, so two adds cannot both take one number.
    return withRecordLock(c, "add", () => {
      const held = listJobs(c).find((j) => j.number === String(number));
      if (held) fail("NUMBER_TAKEN", `M${number} is ${held.id} ("${held.title}")`);
      return addJob(c, kind, title, opts);
    });
  },
```

In `src/commands/job.mjs`:

- add `resolveId` to the import from `../store.mjs` (the file imports `jobDir` from there today);
- replace the `add` entry of `sub`:

```js
  add: (p, f) => ({
    kind: p[0], title: p.slice(1).join(" "),
    ...(f.log !== undefined ? { logOf: f.log } : {}),
    ...(f.number !== undefined ? { number: f.number } : {}),
    ...(f.roadmap === true ? { roadmap: true } : {}),
    ...(f.after !== undefined ? { after: f.after } : {}),
  }),
```

- add `"number"`, `"roadmap"`, `"after"` to `ACCEPTS.flags`;
- in the registered handler, right after `const args = { ...sub[name](rest, flags), ... };`, add:

```js
  if (typeof args.id === "string") args.id = resolveId(c, args.id);
```

In `src/commands/worktree.mjs`, import `resolveId` from `../store.mjs` and, at the top of the handler after the config is loaded and the usage check has passed, resolve the id and the two partner flags:

```js
  const jid = resolveId(c, id);
  const partnerOf = (v) => (typeof v === "string" ? resolveId(c, v) : v);
```

then use `jid` wherever the handler used `id`, and `partnerOf(flags["base-of"])` / `partnerOf(flags.from)` wherever it read those flags.

In `src/commands/services.mjs`, import `resolveId` and replace `const job = readJob(c, id);` with `const job = readJob(c, resolveId(c, id));`, using `job.id` below wherever the handler used `id`.

In `src/board/server.mjs`, extend `STATUS`:

```js
const STATUS = { ILLEGAL_TRANSITION: 409, FIX_ROUNDS_EXHAUSTED: 409, ANSWER_REQUIRED: 409, APPROVAL_REQUIRED: 409, BAD_KIND: 400, JOB_BUSY: 409, JOB_NOT_FOUND: 404, BAD_ARGS: 400, BAD_ID: 400, BAD_PATH: 400, BAD_NUMBER: 400, NUMBER_TAKEN: 409, AMBIGUOUS: 409 };
```

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/store.test.mjs test/job-actions.test.mjs test/cli.job.test.mjs`
Expected: PASS.
Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.mjs src/job-actions.mjs src/commands/job.mjs src/commands/worktree.mjs src/commands/services.mjs src/board/server.mjs test/store.test.mjs test/job-actions.test.mjs test/cli.job.test.mjs
git commit -m "feat(job): milestone numbers, add --roadmap and --after, M<n> accepted as an id"
```

---

### Task 3: The start and external gates

**Depends on:** Task 2

**Files:**
- Modify: `src/job-actions.mjs`
- Modify: `src/commands/job.mjs`
- Modify: `src/board/server.mjs` (`ROUTES`)
- Modify: `test/job-actions.test.mjs`
- Modify: `test/board.server.test.mjs`

**Interfaces:**
- Consumes: `TRANSITIONS` (Task 1), `resolveId` in the job command (Task 2).
- Produces: `actions.start(c, { id, by })` (`roadmap -> backlog`, reason `"started"`); `actions.external(c, { id, note, by })` (`roadmap|backlog -> external`, reason `"external"`, sets `externalNote`); `sfactory job start <id>`, `sfactory job external <id> --note "<text>"`; board route `POST /jobs/:id/start`.

- [ ] **Step 1: Write the failing tests**

Append to `test/job-actions.test.mjs`:

```js
test("actions: start moves a roadmap card to backlog; nothing else starts", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "later", number: "14", roadmap: true });
  const j = actions.start(c, { id: "m-1", by: "board" });
  assert.equal(j.stage, "backlog");
  assert.deepEqual({ ...j.history.at(-1), at: undefined }, { at: undefined, from: "roadmap", to: "backlog", by: "board", reason: "started" });
  throwsCode(() => actions.start(c, { id: "m-1" }), "ILLEGAL_TRANSITION");
  unheld(c, "m-1");
});

test("actions: external from roadmap or backlog with a note; merged closes it", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "a", roadmap: true });
  actions.add(c, { kind: "milestone", title: "b" });
  assert.equal(actions.external(c, { id: "m-1", note: "pairing session" }).externalNote, "pairing session");
  assert.equal(actions.external(c, { id: "m-2", note: "another agent" }).stage, "external");
  throwsCode(() => actions.external(c, { id: "m-1", note: "x" }), "ILLEGAL_TRANSITION");
  actions.add(c, { kind: "milestone", title: "c" });
  throwsCode(() => actions.external(c, { id: "m-3" }), "BAD_ARGS");
  throwsCode(() => actions.external(c, { id: "m-3", note: "x".repeat(201) }), "BAD_ARGS");
  assert.equal(actions.merged(c, { id: "m-1" }).stage, "merged");
});
```

Append to `test/board.server.test.mjs` (it already defines `mk`, `post(b, path, body)` and `withBoard(c, opts, fn)`):

```js
test("server: POST start moves a roadmap card to backlog", async () => {
  const c = mk();
  actions.add(c, { kind: "milestone", title: "later", roadmap: true });
  await withBoard(c, {}, async (b) => {
    const r = await post(b, "jobs/m-1/start");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).job.stage, "backlog");
    assert.equal((await post(b, "jobs/m-1/start")).status, 409);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/job-actions.test.mjs test/board.server.test.mjs`
Expected: FAIL — `actions.start` is not a function; the board answers 404 for `start`.

- [ ] **Step 3: Implement**

In `src/job-actions.mjs`, add to `actions` (beside `merged`):

```js
  /** A card waiting in roadmap joins the backlog; the next run starts it. */
  start(c, { id, by = "session" }) { return locked(c, id, (job) => writeJob(c, transition(job, "backlog", { by, reason: "started" }))); },
  /** A card worked outside the factory: run never touches it; merged or stop closes it. */
  external(c, { id, note, by = "session" }) {
    return locked(c, id, (job) => {
      if (typeof note !== "string" || !note.trim() || note.length > 200) fail("BAD_ARGS", 'external needs --note "<who is doing it>" of at most 200 characters');
      const next = transition(job, "external", { by, reason: "external" });
      next.externalNote = note.trim();
      return writeJob(c, next);
    });
  },
```

In `src/commands/job.mjs`, add to `sub`:

```js
  start: (p) => ({ id: p[0] }),
  external: (p, f) => ({ id: p[0], note: str(f.note) }),
```

(`note` is already in `ACCEPTS.flags`.)

In `src/board/server.mjs`, extend `ROUTES`:

```js
const ROUTES = { approve: "approve", answer: "answer", parallel: "parallel", merged: "merged", stop: "stop", rework: "rework", "request-changes": "requestChanges", start: "start" };
```

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/job-actions.test.mjs test/board.server.test.mjs`
Expected: PASS.
Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/job-actions.mjs src/commands/job.mjs src/board/server.mjs test/job-actions.test.mjs test/board.server.test.mjs
git commit -m "feat(job): start and external gates; the board can start a roadmap card"
```

---

### Task 4: A numbered card's record number at the cut

**Depends on:** Task 2

**Files:**
- Modify: `src/record.mjs` (`resolveRecord`)
- Create: `test/record.number.test.mjs`

**Interfaces:**
- Consumes: `job.number` (Task 2).
- Produces: `resolveRecord(c, job, worktree, others)` returns `n = Number(job.number)` for a numbered milestone under every `record.numbering`; refuses `BAD_NUMBER` (not a whole number) and `NUMBER_TAKEN` (another unmerged card's `record.n`, or a brief at that number in the worktree).

- [ ] **Step 1: Write the failing test**

Create `test/record.number.test.mjs`:

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { resolveRecord } from "../src/record.mjs";

const cfg = (numbering) => ({ record: { brief: "spec/{n}-{slug}.md", plan: "plans/{n}-{slug}.md", log: "log/{n}-{slug}.md", stories: null, numbering } });
const card = (extra) => ({ id: "m-3", kind: "milestone", slug: "audit-log", stage: "planning", ...extra });
const wt = (...briefs) => { const d = tmpDir("sf-rn-"); mkdirSync(join(d, "spec"), { recursive: true }); for (const b of briefs) writeFileSync(join(d, "spec", b), "# b\n"); return d; };

test("record: a numbered card takes its own number under either numbering", () => {
  for (const numbering of ["next-milestone-number", "job-id"]) {
    const r = resolveRecord(cfg(numbering), card({ number: "14" }), wt("01-a.md", "02-b.md"), []);
    assert.equal(r.n, 14, numbering);
    assert.equal(r.brief, "spec/14-audit-log.md");
  }
});

test("record: an unnumbered card keeps today's rule", () => {
  assert.equal(resolveRecord(cfg("next-milestone-number"), card({}), wt("01-a.md", "02-b.md"), []).n, 3);
});

test("record: refusals for a numbered card", () => {
  const c = cfg("next-milestone-number");
  assert.throws(() => resolveRecord(c, card({ number: "29.1" }), wt(), []), (e) => e.code === "BAD_NUMBER");
  assert.throws(() => resolveRecord(c, card({ number: "14" }), wt(), [{ id: "m-9", kind: "milestone", stage: "building", record: { n: 14 } }]),
    (e) => e.code === "NUMBER_TAKEN" && /m-9/.test(e.message));
  assert.throws(() => resolveRecord(c, card({ number: "14" }), wt("14-other.md"), []),
    (e) => e.code === "NUMBER_TAKEN" && /spec\/14-other\.md/.test(e.message));
  // a merged card's record does not hold the number
  assert.equal(resolveRecord(c, card({ number: "14" }), wt(), [{ id: "m-9", kind: "milestone", stage: "merged", record: { n: 14 } }]).n, 14);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/record.number.test.mjs`
Expected: FAIL — `n` is 3 (or the id's number), not 14; no refusal is thrown.

- [ ] **Step 3: Implement**

In `src/record.mjs`, replace the numbering block of `resolveRecord` (from `let n;` to the end of the `else` line):

```js
  let n;
  if (job.number !== undefined && job.number !== null) {
    if (!/^\d+$/.test(String(job.number))) fail("BAD_NUMBER", `${job.id} is M${job.number}; only a whole-number milestone can be cut`);
    n = Number(job.number);
    const holder = others.find((o) => o.id !== job.id && o.kind !== "fix" && o.stage !== "merged" && o.record?.n === n && !Number.isInteger(o.logOf));
    if (holder) fail("NUMBER_TAKEN", `M${n} is already the record number of ${holder.id}`);
    // Only a brief pattern with {n} can hold a brief "at that number"; compare by value, so 01-a.md is number 1.
    if (r.brief.includes("{n}")) {
      const re = patternRegex(r.brief);
      const brief = filesUnder(worktree, r.brief).find((f) => { const m = re.exec(f); return m?.groups?.n !== undefined && Number(m.groups.n) === n; });
      if (brief) fail("NUMBER_TAKEN", `a brief for M${n} is already in the worktree: ${brief}`);
    }
  } else if (r.numbering === "next-milestone-number") {
    const re = patternRegex(r.brief);
    let max = 0;
    for (const f of filesUnder(worktree, r.brief)) { const m = re.exec(f); if (m?.groups?.n) max = Math.max(max, Number(m.groups.n)); }
    for (const o of others) if (o.id !== job.id && o.kind !== "fix" && o.stage !== "merged" && Number.isInteger(o.record?.n) && !Number.isInteger(o.logOf)) max = Math.max(max, o.record.n);
    n = max + 1;
  } else n = Number.isInteger(idNo) ? idNo : null;
```

Update the docblock above `resolveRecord` to add: "A numbered milestone (`job.number`) takes its own number under every numbering, refused when it is not whole or another unmerged card or a brief already holds it."

- [ ] **Step 4: Run the test, then the full suite**

Run: `node --test test/record.number.test.mjs`
Expected: PASS.
Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/record.mjs test/record.number.test.mjs
git commit -m "feat(record): a numbered milestone's record takes its own number"
```

---

### Task 5: `sfactory job import <file.json>`

**Depends on:** Task 3

**Files:**
- Create: `src/import.mjs`
- Modify: `src/commands/job.mjs`
- Create: `test/import.test.mjs`
- Modify: `test/cli.job.test.mjs`

**Interfaces:**
- Consumes: `addJobWith`, `listJobs`, `writeJobFile` (store), `newJob`, `NUMBER_RE` (job), `withRecordLock` (record), `assertNotSecret` (commit, as `request-changes --notes-file` uses it).
- Produces: `validateImport(doc)` → `{ cards }` with each card normalised (dates as ISO strings) or throws `BAD_IMPORT` naming `cards[<i>].<field>`; `importCards(c, doc, { now })` → `{ created: [{ index, id, number, stage }], skipped: [{ index, reason }] }`; CLI `sfactory job import <file>` printing one line per card, `--json` for the result object.

- [ ] **Step 1: Write the failing tests**

Create `test/import.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { validateImport, importCards } from "../src/import.mjs";
import { readJob, readJobFile, listJobs } from "../src/store.mjs";
import { actions } from "../src/job-actions.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-im-"), limits: { lockStaleMs: 60_000 } });
const bad = (doc, re) => assert.throws(() => validateImport(doc), (e) => e.code === "BAD_IMPORT" && re.test(e.message), String(re));
const DOC = { cards: [
  { number: "12", kind: "milestone", title: "Saved searches", stage: "merged", branch: "feature/saved-searches", pr: 31, started: "2026-09-02", ended: "2026-09-09" },
  { number: "13", kind: "milestone", title: "CSV export", stage: "external", branch: "feature/csv-export", pr: 34, prUrl: "https://example.com/pr/34", externalNote: "pairing session", started: "2026-09-10" },
  { number: "14", kind: "milestone", title: "Audit log", stage: "roadmap", after: "M13", note: "Needs the export first." },
  { kind: "fix", title: "Typo on the login page", stage: "backlog" },
  { number: "11", kind: "milestone", title: "Search page", stage: "pushed", branch: "feature/search", pr: 30 },
] };

test("import: validation refuses the whole file, naming the card and the field", () => {
  bad(null, /cards/);
  bad({ cards: "x" }, /cards/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "building" }] }, /cards\[0\]\.stage/);
  bad({ cards: [{ kind: "chore", title: "t", stage: "backlog" }] }, /cards\[0\]\.kind/);
  bad({ cards: [{ kind: "milestone", title: "", stage: "backlog" }] }, /cards\[0\]\.title/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "backlog", number: "1.2.3" }] }, /cards\[0\]\.number/);
  bad({ cards: [{ kind: "fix", title: "t", stage: "backlog", number: "3" }] }, /cards\[0\]\.number/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "merged", pr: 0 }] }, /cards\[0\]\.pr/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "merged", prUrl: "javascript:x" }] }, /cards\[0\]\.prUrl/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "merged", started: "not a date" }] }, /cards\[0\]\.started/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "backlog", ended: "2026-01-01" }] }, /cards\[0\]\.ended/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "backlog", externalNote: "x" }] }, /cards\[0\]\.externalNote/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "roadmap", after: "x".repeat(81) }] }, /cards\[0\]\.after/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "roadmap", note: "x".repeat(2001) }] }, /cards\[0\]\.note/);
  bad({ cards: [{ kind: "milestone", title: "t", stage: "roadmap", colour: "red" }] }, /cards\[0\]\.colour/);
  bad({ cards: [{ kind: "milestone", title: "a", stage: "roadmap", number: "4" }, { kind: "milestone", title: "b", stage: "roadmap", number: "4" }] }, /cards\[1\]\.number/);
});

test("import: writes every card in its stage with its fields, history and files", () => {
  const c = cfg();
  const r = importCards(c, DOC, { now: "2026-10-30T10:00:00.000Z" });
  assert.deepEqual(r.created.map((x) => [x.id, x.stage]), [["m-1", "merged"], ["m-2", "external"], ["m-3", "roadmap"], ["f-1", "backlog"], ["m-4", "pushed"]]);
  assert.deepEqual(r.skipped, []);
  const m1 = readJob(c, "m-1");
  assert.equal(m1.number, "12"); assert.equal(m1.branch, "feature/saved-searches"); assert.equal(m1.pr, 31);
  assert.equal(m1.started, "2026-09-02T00:00:00.000Z"); assert.equal(m1.ended, "2026-09-09T00:00:00.000Z");
  assert.deepEqual(m1.history, [{ at: "2026-09-02T00:00:00.000Z", from: null, to: "merged", by: "import", reason: "imported" }]);
  assert.equal(readJobFile(c, "m-1", "pr.md"), "PR #31 · feature/saved-searches\n");
  const m2 = readJob(c, "m-2");
  assert.equal(m2.externalNote, "pairing session"); assert.equal(m2.prUrl, "https://example.com/pr/34");
  assert.equal(readJobFile(c, "m-2", "pr.md"), "PR #34 · feature/csv-export\nhttps://example.com/pr/34\n");
  const m3 = readJob(c, "m-3");
  assert.equal(m3.after, "M13"); assert.equal(m3.started, "2026-10-30T10:00:00.000Z"); assert.equal(m3.ended, null);
  assert.equal(readJobFile(c, "m-3", "notes.md"), "Needs the export first.\n");
  assert.equal(readJobFile(c, "f-1", "pr.md"), null);
  // a merged card with no ended date is ended at the import
  const c2 = cfg();
  importCards(c2, { cards: [{ kind: "milestone", title: "t", stage: "merged" }] }, { now: "2026-10-30T10:00:00.000Z" });
  assert.equal(readJob(c2, "m-1").ended, "2026-10-30T10:00:00.000Z");
});

test("import: running it again skips what is already on the board", () => {
  const c = cfg();
  actions.add(c, { kind: "milestone", title: "Something else", number: "14" });
  const r1 = importCards(c, DOC, { now: "2026-10-30T10:00:00.000Z" });
  assert.deepEqual(r1.skipped, [{ index: 2, reason: "M14 is m-1" }]);
  const r2 = importCards(c, DOC, { now: "2026-10-30T11:00:00.000Z" });
  assert.equal(r2.created.length, 0);
  assert.equal(r2.skipped.length, 5);
  assert.match(r2.skipped[3].reason, /^a fix titled "Typo on the login page" is f-1$/);
  assert.equal(listJobs(c).length, 5);
});

test("import: one bad card writes nothing", () => {
  const c = cfg();
  assert.throws(() => importCards(c, { cards: [DOC.cards[0], { kind: "milestone", title: "t", stage: "building" }] }), (e) => e.code === "BAD_IMPORT");
  assert.equal(listJobs(c).length, 0);
});
```

Append to `test/cli.job.test.mjs` (its `repo` and `run` helpers come from Task 2):

```js
test("cli: job import prints one line per card and refuses a missing file", async () => {
  const r0 = repo();
  writeFileSync(join(r0, "cards.json"), JSON.stringify({ cards: [{ number: "3", kind: "milestone", title: "Later", stage: "roadmap" }, { kind: "milestone", title: "Done thing", stage: "merged", pr: 2 }] }));
  let r = await run(r0, ["job", "import", "cards.json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "created m-1 M3 roadmap\ncreated m-2 merged\n2 created, 0 skipped\n");
  r = await run(r0, ["job", "import", "cards.json"]);
  assert.match(r.out, /skipped #0: M3 is m-1\n/);
  assert.notEqual((await run(r0, ["job", "import", "missing.json"])).code, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/import.test.mjs test/cli.job.test.mjs`
Expected: FAIL — `../src/import.mjs` does not exist; `import` is not a `job` verb.

- [ ] **Step 3: Implement**

Create `src/import.mjs`:

```js
import { fail } from "./errors.mjs";
import { NUMBER_RE, newJob } from "./job.mjs";
import { addJobWith, listJobs, writeJobFile } from "./store.mjs";
import { withRecordLock } from "./record.mjs";

const STAGES = ["roadmap", "backlog", "external", "pushed", "merged"];
const FIELDS = ["number", "kind", "title", "stage", "branch", "pr", "prUrl", "started", "ended", "after", "externalNote", "note"];

const text = (v, max) => typeof v === "string" && v.trim() !== "" && v.length <= max;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
/** A strict ISO date (YYYY-MM-DD, read as UTC midnight) or a date-time with Z or an offset, as an ISO string; null for anything else or an impossible date. */
const iso = (v) => {
  const m = typeof v === "string" ? ISO_RE.exec(v) : null;
  if (!m) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  return new Date(t).toISOString();
};

/** Check a whole import document; return the cards normalised (dates as ISO strings), or throw BAD_IMPORT naming the first bad field. */
export function validateImport(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.cards)) fail("BAD_IMPORT", 'the file must be a JSON object with a "cards" array');
  const seen = new Map();
  const cards = doc.cards.map((card, i) => {
    const at = (f) => `cards[${i}].${f}`;
    const no = (f, why) => fail("BAD_IMPORT", `${at(f)}: ${why}`);
    if (!card || typeof card !== "object" || Array.isArray(card)) fail("BAD_IMPORT", `cards[${i}]: must be an object`);
    for (const k of Object.keys(card)) if (!FIELDS.includes(k)) no(k, "is not a field an import card takes");
    if (!["milestone", "fix"].includes(card.kind)) no("kind", 'must be "milestone" or "fix"');
    if (!text(card.title, 200)) no("title", "must be text of at most 200 characters");
    if (!STAGES.includes(card.stage)) no("stage", `must be one of ${STAGES.join(", ")}`);
    const out = { kind: card.kind, title: card.title.trim(), stage: card.stage };
    if (card.number !== undefined) {
      if (card.kind !== "milestone") no("number", "only a milestone carries a number");
      if (typeof card.number !== "string" || !NUMBER_RE.test(card.number)) no("number", 'must be a string like "14" or "29.1"');
      if (seen.has(card.number)) no("number", `M${card.number} is also cards[${seen.get(card.number)}]`);
      seen.set(card.number, i);
      out.number = card.number;
    }
    if (card.branch !== undefined) { if (!text(card.branch, 200)) no("branch", "must be text of at most 200 characters"); out.branch = card.branch.trim(); }
    if (card.pr !== undefined) { if (!Number.isInteger(card.pr) || card.pr < 1) no("pr", "must be a positive whole number"); out.pr = card.pr; }
    if (card.prUrl !== undefined) { if (!text(card.prUrl, 500) || !/^https?:\/\//.test(card.prUrl)) no("prUrl", "must be an http(s) URL"); out.prUrl = card.prUrl; }
    if (card.started !== undefined) { out.started = iso(card.started) ?? no("started", "must be a date or date-time"); }
    if (card.ended !== undefined) {
      if (card.stage !== "merged") no("ended", "only a merged card has an end");
      out.ended = iso(card.ended) ?? no("ended", "must be a date or date-time");
    }
    if (card.after !== undefined) { if (!text(card.after, 80)) no("after", "must be text of at most 80 characters"); out.after = card.after.trim(); }
    if (card.externalNote !== undefined) {
      if (card.stage !== "external") no("externalNote", "only an external card has an external note");
      if (!text(card.externalNote, 200)) no("externalNote", "must be text of at most 200 characters");
      out.externalNote = card.externalNote.trim();
    }
    if (card.note !== undefined) { if (!text(card.note, 2000)) no("note", "must be text of at most 2,000 characters"); out.note = card.note; }
    return out;
  });
  return { cards };
}

/** The job object an import card becomes. */
function jobOf(id, card, now) {
  const started = card.started ?? now;
  const base = newJob({ id, kind: card.kind, title: card.title, now: started });
  return {
    ...base,
    stage: card.stage,
    ...(card.number !== undefined ? { number: card.number } : {}),
    ...(card.after !== undefined ? { after: card.after } : {}),
    ...(card.externalNote !== undefined ? { externalNote: card.externalNote } : {}),
    ...(card.branch !== undefined ? { branch: card.branch } : {}),
    ...(card.pr !== undefined ? { pr: card.pr } : {}),
    ...(card.prUrl !== undefined ? { prUrl: card.prUrl } : {}),
    ended: card.stage === "merged" ? (card.ended ?? now) : null,
    history: [{ at: started, from: null, to: card.stage, by: "import", reason: "imported" }],
  };
}

/**
 * Validate the whole document, then create each card not already on the board (a number already carried, or for an
 * unnumbered card the same kind and title), in file order, under the record lock so a concurrent add cannot take a
 * number between the check and the write.
 */
export function importCards(c, doc, { now = new Date().toISOString() } = {}) {
  const { cards } = validateImport(doc);
  return withRecordLock(c, "import", () => {
    const created = [], skipped = [];
    cards.forEach((card, index) => {
      const jobs = listJobs(c);
      const held = card.number !== undefined
        ? jobs.find((j) => j.number === card.number)
        : jobs.find((j) => j.kind === card.kind && j.title === card.title);
      if (held) {
        skipped.push({ index, reason: card.number !== undefined ? `M${card.number} is ${held.id}` : `a ${card.kind} titled "${card.title}" is ${held.id}` });
        return;
      }
      const job = addJobWith(c, card.kind, (id) => jobOf(id, card, now));
      if (card.pr !== undefined) writeJobFile(c, job.id, "pr.md", `PR #${card.pr}${card.branch ? ` · ${card.branch}` : ""}\n${card.prUrl ? `${card.prUrl}\n` : ""}`);
      if (card.note !== undefined) writeJobFile(c, job.id, "notes.md", card.note.endsWith("\n") ? card.note : `${card.note}\n`);
      created.push({ index, id: job.id, ...(card.number !== undefined ? { number: card.number } : {}), stage: card.stage });
    });
    return { created, skipped };
  });
}
```

In `src/commands/job.mjs`:

- add imports: `import { readFileSync } from "node:fs";` is already there; add `import { importCards } from "../import.mjs";`;
- add to `sub`: `import: (p) => ({ file: p[0] }),`;
- in the handler, before `const out = actions[...]`, add:

```js
  if (name === "import") {
    if (typeof args.file !== "string") fail("BAD_ARGS", "usage: sfactory job import <file.json>");
    assertNotSecret(c, [args.file], { cwd: io.cwd });
    let doc;
    try { doc = JSON.parse(readFileSync(resolve(io.cwd, args.file), "utf8")); }
    catch (e) { fail(e.code === "ENOENT" ? "BAD_ARGS" : "BAD_IMPORT", `${args.file}: ${e.code === "ENOENT" ? "no such file" : "not valid JSON"}`); }
    const r = importCards(c, doc);
    if (flags.json) { io.stdout(JSON.stringify(r, null, 2) + "\n"); return 0; }
    for (const x of r.created) io.stdout(`created ${x.id}${x.number ? ` M${x.number}` : ""} ${x.stage}\n`);
    for (const x of r.skipped) io.stdout(`skipped #${x.index}: ${x.reason}\n`);
    io.stdout(`${r.created.length} created, ${r.skipped.length} skipped\n`);
    return 0;
  }
```

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/import.test.mjs test/cli.job.test.mjs`
Expected: PASS.
Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/import.mjs src/commands/job.mjs test/import.test.mjs test/cli.job.test.mjs
git commit -m "feat(job): import cards from a JSON file, safe to run again"
```

---

### Task 6: The board shows the new columns and fields

**Depends on:** Task 5

**Files:**
- Modify: `src/board/snapshot.mjs` (`jobView`)
- Modify: `board/dashboard.html`
- Modify: `examples/jobs/generate.mjs` and the generated `examples/jobs/*` (two demo cards)
- Modify: `test/board.snapshot.test.mjs`
- Modify: `test/board.page.test.mjs`

**Interfaces:**
- Consumes: job fields `number`, `after`, `externalNote`, `pr`, `prUrl` (Tasks 2, 3, 5); route `start` (Task 3).
- Produces: `jobView` adds `number`, `after`, `externalNote`, `pr`, `prUrl` (each `null` when absent); the page has `Milestones` and `External running` sections, shows `M<number>` in place of the id when a card has one (the id in the `title` attribute), an "after …" line, the external note as a tag, a *Start* button on roadmap cards and *Mark merged* on external cards.

- [ ] **Step 1: Write the failing tests**

Append to `test/board.snapshot.test.mjs`:

```js
test("snapshot: number, after, externalNote, pr and prUrl are allow-listed", () => {
  const c = { stateDir: tmpDir("sf-snap-"), limits: { lockStaleMs: 60_000 } };
  importCards(c, { cards: [
    { number: "14", kind: "milestone", title: "Audit log", stage: "roadmap", after: "M13" },
    { number: "13", kind: "milestone", title: "CSV export", stage: "external", externalNote: "pairing session", pr: 34, prUrl: "https://example.com/pr/34" },
  ] });
  const jobs = buildSnapshot(c).jobs;
  const r = jobs.find((j) => j.id === "m-1"), e = jobs.find((j) => j.id === "m-2");
  assert.equal(r.column, "Milestones"); assert.equal(r.number, "14"); assert.equal(r.after, "M13"); assert.equal(r.externalNote, null);
  assert.equal(e.column, "External running"); assert.equal(e.externalNote, "pairing session"); assert.equal(e.pr, 34); assert.equal(e.prUrl, "https://example.com/pr/34");
  assert.equal(r.needsYou, null); assert.equal(e.needsYou, null);
});
```

(The file has no config helper: build `const c = { stateDir: tmpDir("sf-snap-"), limits: { lockStaleMs: 60_000 } };` at the top of the test in place of `cfg()`, and import `importCards` from `../src/import.mjs`.)

Append to `test/board.page.test.mjs` (it already reads the page into `html` at the top; add `BOARD_COLUMNS` to its import from `../src/board/snapshot.mjs`):

```js
test("page: a section per board column, the start gate and the number pill", () => {
  for (const col of BOARD_COLUMNS) assert.ok(html.includes(`data-column="${col}"`), col);
  assert.ok(html.indexOf('data-column="Milestones"') < html.indexOf('data-column="Backlog"'));
  assert.ok(html.indexOf('data-column="External running"') < html.indexOf('data-column="Done"'));
  assert.match(html, /"start"/);
  assert.match(html, /Starts on the next \/sfactory run/);
  assert.match(html, /"M" \+ job\.number/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/board.snapshot.test.mjs test/board.page.test.mjs`
Expected: FAIL — `number` is undefined in the view; the page has no Start gate.

- [ ] **Step 3: Implement**

In `src/board/snapshot.mjs`, inside the object `jobView` returns, after `slug: j.slug ?? null,`:

```js
    number: j.number ?? null, after: j.after ?? null, externalNote: j.externalNote ?? null, pr: j.pr ?? null, prUrl: j.prUrl ?? null,
```

In `board/dashboard.html`:

- the column sections become (Milestones first, External running before Done):

```html
  <section class="col" data-column="Milestones"><h2>Milestones <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="Backlog"><h2>Backlog <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="Plan"><h2>Plan <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="Needs you"><h2>Needs you <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="In process"><h2>In process <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="Review"><h2>Review <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="Fixed"><h2>Fixed <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="Pushed / PR"><h2>Pushed / PR <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="External running"><h2>External running <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="Done"><h2>Done <span class="n"></span></h2><div class="cards"></div></section>
  <section class="col" data-column="Stopped" hidden><h2>Stopped <span class="n"></span></h2><div class="cards"></div></section>
```

- in `buildCard`, replace `top.appendChild(h("span", "id", job.id));` with:

```js
    var idEl = h("span", "id", job.number ? "M" + job.number : job.id);
    if (job.number) idEl.title = job.id;
    top.appendChild(idEl);
```

  and, after the title element is appended, add:

```js
    if (job.after) card.appendChild(h("div", "hint", "after " + job.after));
    if (job.externalNote) card.appendChild(h("span", "tag ext", job.externalNote + (job.pr ? " · PR #" + job.pr : "")));
```

- in `gateFor`, before the `if (job.stage === "reviewing" || job.stage === "pushed")` line, add two branches to the existing `if / else if` chain:

```js
    } else if (job.stage === "roadmap") {
      btns.appendChild(actionButton(card, job, "Start", "go", "start"));
      g.appendChild(h("div", "hint", "Starts on the next /sfactory run"));
    } else if (job.stage === "external") {
      btns.appendChild(actionButton(card, job, "Mark merged", "go", "merged"));
```

- in the stylesheet, beside `.tag.danger`, add: `.tag.ext { color: var(--gold); border-color: var(--gold); border-style: dashed; }`

In `examples/jobs/generate.mjs`, add two demo cards following the file's existing pattern: a `roadmap` milestone (`number: "5"`, title "Notifications digest", `after: "M4"`) and an `external` milestone (`number: "4"`, title "Billing export", `externalNote: "pairing session"`, `pr: 12`). Run `node examples/jobs/generate.mjs` to regenerate `examples/jobs/*`; update any count the examples tests pin (`test/examples.jobs.test.mjs`) to match.

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/board.snapshot.test.mjs test/board.page.test.mjs test/examples.jobs.test.mjs`
Expected: PASS.
Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/board/snapshot.mjs board/dashboard.html examples/jobs test/board.snapshot.test.mjs test/board.page.test.mjs test/examples.jobs.test.mjs
git commit -m "feat(board): Milestones and External running columns, M-numbers, Start and the external note"
```

---

### Task 7: The orchestrator, the docs and the version

**Depends on:** Task 6

**Files:**
- Modify: `skills/sfactory/SKILL.md`
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/DESIGN.md`
- Modify: `package.json`, `.claude-plugin/plugin.json`
- Modify: `test/skills.test.mjs`

**Interfaces:**
- Consumes: every command added in Tasks 2, 3 and 5.
- Produces: the orchestrator knows `/sfactory start`, `/sfactory external`, `/sfactory import`, `add --roadmap`, and its run loop skips `roadmap` and `external`; version `0.3.0`.

- [ ] **Step 1: Write the failing test**

Append to `test/skills.test.mjs`:

```js
test("sfactory skill: start, external and import are commands, and the run loop never works roadmap or external cards", () => {
  const t = readFileSync(join(skillsRoot, "sfactory", "SKILL.md"), "utf8");
  for (const row of ["`/sfactory start <id>`", "`/sfactory external <id> \"<note>\"`", "`/sfactory import <file>`", "--roadmap"]) assert.ok(t.includes(row), row);
  assert.match(t, /never works a `roadmap` or `external` card/);
  assert.match(t, /nothing is left but `roadmap`, `external`, `pushed`, `merged` and `stopped` cards/);
});
```

(Use the file's existing `skillsRoot`, `readFileSync` and `join`.)

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/skills.test.mjs`
Expected: FAIL — the rows are missing.

- [ ] **Step 3: Implement**

In `skills/sfactory/SKILL.md`, section 1's command table:

- replace the `/sfactory add milestone` row with:

```markdown
| `/sfactory add milestone "<title>" [--number <n>] [--roadmap] [--after "<text>"]` | `sfactory job add milestone "<title>"` with the same flags. Without `--roadmap` it waits in backlog until `run` starts it; with it, it waits in the Milestones column until the person starts it. `--number` gives it an M-number every command accepts in place of its id. |
```

- add three rows after the `/sfactory run` row:

```markdown
| `/sfactory start <id>` | `sfactory job start <id>` (the id may be `M<n>`). It moves a Milestones card to backlog. Then carry on as `/sfactory run`. |
| `/sfactory external <id> "<note>"` | `sfactory job external <id> --note "<note>"`: the card is being worked outside the factory, and `run` leaves it alone. `/sfactory merged <id>` or `/sfactory stop <id>` closes it. |
| `/sfactory import <file>` | `sfactory job import <file>`. Show the lines it prints. It creates cards only in roadmap, backlog, external, pushed and merged, and skips cards already on the board. |
```

In section 4, replace the sentence `A run ends when nothing is left but \`pushed\`, \`merged\` and \`stopped\` cards, or every remaining card waits on the person.` with:

```markdown
The factory never works a `roadmap` or `external` card: a `roadmap` card waits for `/sfactory start`, an `external` card is someone else's work. Skip both in every pass.

A run ends when nothing is left but `roadmap`, `external`, `pushed`, `merged` and `stopped` cards, or every remaining card waits on the person.
```

In `README.md`:

- in "What you see on the board", add Milestones before Backlog and External running before Done in the column list, with one sentence each: "**Milestones** holds planned work the factory leaves alone until you start it (`/sfactory start M14`); **External running** shows work being done outside the factory, which `run` never touches.";
- in the session command list, add `/sfactory start <id>`, `/sfactory external <id> "<note>"`, `/sfactory import <file>` and the `--number`, `--roadmap`, `--after` flags on `add`, and note "`<id>` may be `M<n>` for a numbered card";
- in the CLI list, extend `sfactory job` with `start`, `external`, `import`;
- add a section before "Safety rules":

````markdown
## Bringing an existing project

A project with finished and planned work can put it on the board once. Write a JSON file from your own records and run `sfactory job import cards.json` after `sfactory init` and `sfactory doctor`:

```json
{ "cards": [
  { "number": "12", "kind": "milestone", "title": "Saved searches", "stage": "merged", "branch": "feature/saved-searches", "pr": 31 },
  { "number": "13", "kind": "milestone", "title": "CSV export", "stage": "external", "externalNote": "pairing session" },
  { "number": "14", "kind": "milestone", "title": "Audit log", "stage": "roadmap", "after": "M13" }
] }
```

Stages: `roadmap` (Milestones), `backlog`, `external`, `pushed`, `merged`. Other fields: `branch`, `pr`, `prUrl`, `started`, `ended` (merged only), `after`, `externalNote` (external only), `note`. The whole file is checked before anything is written, and cards already on the board are skipped, so running it again is safe.
````

In `INSTALL.md` section 4, after the `board` bullet, add: "- An existing project can import its finished and planned work once: see README, \"Bringing an existing project\"."

In `docs/DESIGN.md`, after the state-machine section, add a dated amendment: "*Amendment (2026-10-30):* two stages, `roadmap` (Milestones) and `external` (External running), neither working nor counted toward the cap; cards may carry an M-number; `sfactory job import` creates cards in bulk. See `docs/plans/2026-10-30-sfactory-roadmap-activity-design.md`."

In `package.json` and `.claude-plugin/plugin.json`, change `"version": "0.2.0"` to `"version": "0.3.0"`.

- [ ] **Step 4: Run the test, then the full suite**

Run: `node --test test/skills.test.mjs test/docs.test.mjs`
Expected: PASS (the docs test checks every new command line against `ACCEPTS`).
Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/sfactory/SKILL.md README.md INSTALL.md docs/DESIGN.md package.json .claude-plugin/plugin.json test/skills.test.mjs
git commit -m "docs: start, external and import in the orchestrator and the docs; 0.3.0"
```
