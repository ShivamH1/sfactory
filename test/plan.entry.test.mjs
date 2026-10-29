import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parsePlan } from "../src/plan.mjs";
import { taskBatches } from "../src/independence.mjs";
import { acceptancePlans } from "../scripts/acceptance-plans.mjs";

// Plan C entry criteria: the five parked parser holes (N1-N5) and dependency
// inference. Each hole was a false "ok" on a crafted plan.

const code = (md) => { try { parsePlan(md); } catch (e) { return e.code; } return null; };
const files = (md, i = 0) => parsePlan(md).tasks[i].files.map((f) => `${f.op} ${f.path}`);
const deps = (md, i = 0) => parsePlan(md).tasks[i].dependsOn;
const one = (body) => "### Task 1: A\n" + body + "\n";
const tail = "### Task 2: B\n- Create: `b.ts`\n";
const names = (md) => parsePlan(md).tasks.map((t) => t.n);

test("N1: a Files line after a heading that closed the task is refused, not dropped", () => {
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n### Notes\n- Modify: `b.ts`\n"), "PLAN_FILES_OUTSIDE_TASK");
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n## Wrap-up\n**Files:** `c.ts`\n"), "PLAN_FILES_OUTSIDE_TASK");
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n### Notes\n**Files:**\n- `c.ts`\n"), "PLAN_FILES_OUTSIDE_TASK");
  // Before the first task too: a Files line there belongs to no task.
  assert.equal(code("- Create: `x.ts`\n### Task 1: A\n- Create: `a.ts`\n"), "PLAN_FILES_OUTSIDE_TASK");
  // A deeper heading stays inside the task; prose outside a task is still fine.
  assert.deepEqual(files("## Task 1: A\n### Step 1\n- Create: `a.ts`\n## Self-review\nSee `src/x.ts`.\n"), ["create a.ts"]);
});

test("N2: a read line never declares a task", () => {
  // Fix round 4 (R4-4) changed the shape of this case: an unindented line right
  // after a Files line now continues it, so "Then edit `src/a.ts`." directly
  // under the read line records `touch src/a.ts` (prose beside the item), which
  // declares the task - the write is recorded, not hidden. After a blank line
  // it is prose again, and the read line still declares nothing.
  assert.equal(code(one("- Read: `CLAUDE.md`\n\nThen edit `src/a.ts`.") + tail), "PLAN_TASK_NO_FILES");
  assert.deepEqual(files(one("- Read: `CLAUDE.md`\nThen edit `src/a.ts`.") + tail), ["read CLAUDE.md", "touch src/a.ts"]);
  // A task whose only Files lines are reads, and that names nothing else, is still accepted.
  assert.deepEqual(files(one("- Read: `CLAUDE.md`, `spec/x.md`") + tail), ["read CLAUDE.md", "read spec/x.md"]);
});

test("N2: a read line that can hide a write records its items as touch", () => {
  assert.deepEqual(files(one("- Read `src/a.ts` and update its export")), ["touch src/a.ts"]);
  assert.deepEqual(files(one("- Read: `src/a.ts` (then add the route)")), ["touch src/a.ts"]);
  assert.deepEqual(files(one("- Read (and patch): `src/a.ts`")), ["touch src/a.ts"]);
  assert.deepEqual(files(one("- Read: `a.md`,\n  `b.ts` (and fix it)")), ["read a.md", "touch b.ts"]);
  // A touch from a read line declares the task.
  assert.deepEqual(files(one("- Read `src/a.ts` then edit it\nSee `src/a.ts`.") + tail), ["touch src/a.ts"]);
  // Separators alone are not prose.
  assert.deepEqual(files(one("- Read: `a.md` and `b.md`, `c.md`.")), ["read a.md", "read b.md", "read c.md"]);
});

test("N3: a Depends on line after a trailing comma is a dependency, not a continuation", () => {
  const p = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n";
  assert.deepEqual(deps(p + "- Modify: `b.ts`,\n**Depends on:** Task 1\n", 1), [1]);
  assert.deepEqual(files(p + "- Modify: `b.ts`,\n**Depends on:** Task 1\n", 1), ["modify b.ts"]);
  assert.deepEqual(deps(p + "- Modify: `b.ts`,\nDepends on: 1\n", 1), [1]);
  assert.deepEqual(deps(p + "- Modify: `b.ts`\n  - Depends on: Task 1\n", 1), [1]);
});

test("N4: the first backticked item after an op is a path when it is a bare word", () => {
  assert.deepEqual(files(one("- Create: `Makefile`")), ["create Makefile"]);
  assert.deepEqual(files(one("- Modify: `src` (the whole folder)")), ["modify src"]);
  assert.deepEqual(files(one("**Files:** `bin`")), ["touch bin"]);
  assert.deepEqual(files(one("- Create:\n  - `bin`\n  - `lib`")), ["create bin", "create lib"]);
  // A later bare word is still prose, and so is one opening a wrapped line.
  assert.deepEqual(files(one("- Modify: `a.ts` (`register`)")), ["modify a.ts"]);
  assert.deepEqual(files(one("- Modify: `a.ts` (the hook,\n  `register` and `IST_OFFSET_MS`)")), ["modify a.ts"]);
  assert.deepEqual(files(one("- Modify:\n  - `a.ts`,\n  `register` and `x`")), ["modify a.ts"]);
});

test("N4: an allow-listed extension-less name is a path in any position", () => {
  assert.deepEqual(files(one("- Modify: `a.ts`, `Dockerfile` and `LICENSE`")), ["modify a.ts", "modify Dockerfile", "modify LICENSE"]);
  assert.deepEqual(files(one("- Modify: `a.ts`,\n  `CODEOWNERS`, `justfile`")), ["modify a.ts", "modify CODEOWNERS", "modify justfile"]);
  for (const n of ["Containerfile", "Procfile", "Gemfile", "Rakefile", "Jenkinsfile", "Vagrantfile", "Brewfile", "Justfile", "LICENCE", "COPYING", "NOTICE", "README", "CHANGELOG", "AUTHORS", "VERSION"]) {
    assert.deepEqual(files(one(`- Modify: \`a.ts\` and \`${n}\``)), ["modify a.ts", `modify ${n}`], n);
  }
});

test("N4: a quote-led first item that is path-like is a path", () => {
  assert.deepEqual(files(one("- Modify: `\"apps/x.ts\"`")), ["modify apps/x.ts"]);
  assert.deepEqual(files(one("- Modify: `'apps/y.ts'` (rename)")), ["modify apps/y.ts"]);
  // A route string after the first item stays prose (round 5).
  assert.deepEqual(files(one("- Modify: `web/api.ts` (the `\"/me/wallet\"` route)")), ["modify web/api.ts"]);
});

test("N5: '- <op>: none' no longer exempts a task; only the **Files:** none label does", () => {
  // Fix round 4 (R4-4): directly under the op line the next line continues it
  // and its item is recorded (fail closed); after a blank line it is prose.
  assert.equal(code(one("- Modify: none\n\nEdit `src/a.ts` by hand.") + tail), "PLAN_TASK_NO_FILES");
  assert.deepEqual(files(one("- Modify: none\nEdit `src/a.ts` by hand.") + tail), ["modify src/a.ts"]);
  assert.equal(code(one("- Create: none\n- Modify: none\n\nSee `src/a.ts`.") + tail), "PLAN_TASK_NO_FILES");
  assert.deepEqual(files(one("- Create: none\n- Modify: none\nSee `src/a.ts`.") + tail), ["modify src/a.ts"]);
  assert.deepEqual(files(one("**Files:** none\n\nSee `docs/x.md`.") + tail), []);
  assert.deepEqual(files(one("**Files:** none\nSee `docs/x.md`.") + tail), ["touch docs/x.md"]);
  // An op line saying none and naming nothing else is accepted when the task names no path.
  assert.deepEqual(files(one("- Modify: none") + tail), []);
});

test("N5: a Files line yielding no paths passes its text to the mention check", () => {
  assert.equal(code(one("- Modify: the `pnpm build` step and `\"src/a.ts\"`") + tail), "PLAN_TASK_NO_FILES");
  // A line that yields a path declares the task as before.
  assert.deepEqual(files(one("- Modify: `a.ts` (the `\"/me/x\"` route)") + tail), ["modify a.ts"]);
});

test("deps: Consumes lines name tasks in every real shape", () => {
  const p = (line) => "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n### Task 3: C\n- Create: `c.ts`\n### Task 4: D\n- Create: `d.ts`\n### Task 5: E\n- Create: `e.ts`\n### Task 6: F\n- Create: `f.ts`\n### Task 7: G\n- Create: `g.ts`\n### Task 8: H\n**Interfaces:**\n" + line + "\n- Create: `h.ts`\n";
  const d = (line) => deps(p(line), 7);
  assert.deepEqual(d("- Consumes: `x` (Task 1), `y` (Task 2)."), [1, 2]);
  assert.deepEqual(d("- Consumes: everything from Tasks 3–5."), [3, 4, 5]);
  assert.deepEqual(d("- Consumes: everything Tasks 2-4 produced."), [2, 3, 4]);
  assert.deepEqual(d("**Consumes:** Task 1's `foo`"), [1]);
  assert.deepEqual(d("- **Consumes:** Tasks 5, 6 and 7's services; Task 3/4's `x`"), [5, 6, 7, 3, 4]);
  assert.deepEqual(d("- Consumes (Task 2): `ApiClient.x`"), [2]);
  // Fix round 2 (R2-1, fail closed): every number naming an earlier task counts,
  // the "1" inside the code span included.
  assert.deepEqual(d("- Consumes from history state (Task 6 writes it): `{ a: 1 }`"), [6, 1]);
  assert.deepEqual(d("- Consumes: the Task 3 schemas."), [3]);
  // Fix round 2 (R2-1, fail closed) changed this expectation: every number in a
  // Consumes line that names an earlier task of this plan counts, so "M44 Task 6"
  // over-serialises behind this plan's Task 6. A milestone or "T17" token is not
  // a number of its own.
  assert.deepEqual(d("- Consumes: `v` (M44 Task 6); `w` (M44's Task 2); Task 1"), [6, 2, 1]);
  assert.deepEqual(d("- Consumes: M18's `grantAllowance`; T17's helper"), []);
  // A wrapped Consumes line continues onto its indented lines; Produces is not a dependency.
  assert.deepEqual(d("- Consumes: Task 1 (`a`), Task 2\n  (`b`), Task 3\n  (`c`).\n- Produces: `z`; Task 4 consumes all of these."), [1, 2, 3]);
  // A task consuming its own earlier step is not a dependency.
  assert.deepEqual(d("- Consumes: Task 8's first step; Task 1"), [1]);
});

test("deps: a Consumes line after a trailing comma is not swallowed as a continuation", () => {
  const md = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Modify: `b.ts`,\n- Consumes: Task 1's `modules/a.ts` export\n";
  assert.deepEqual(deps(md, 1), [1]);
  assert.deepEqual(files(md, 1), ["modify b.ts"]);
});

test("deps: dependencyInfo is declared only by an explicit Depends on line, else none", () => {
  const info = (md) => parsePlan(md).dependencyInfo;
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n" + tail), "none");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n- Consumes: nothing.\n" + tail), "none");
  // Fix round 3 (S1, structural ruling) changed these two expectations: Consumes
  // and "(after Task N)" still add ordering edges, but prose-derived edges are
  // not proof of independence, so they never on their own declare a plan.
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n### Task 2: B (after Task 1)\n- Create: `b.ts`\n"), "none");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Consumes: Task 1\n- Create: `b.ts`\n"), "none");
  // Fix round 4 (R4-1) changed these two expectations: one task's Depends on
  // line no longer declares the plan; every task needs its own.
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n" + tail), "none");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Depends on: Task 1\n- Create: `b.ts`\n"), "none");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n### Task 2: B\n- Depends on: Task 1\n- Create: `b.ts`\n"), "declared");
  assert.deepEqual(deps("### Task 1: A\n- Create: `a.ts`\n### Task 2: B (after Task 1)\n- Create: `b.ts`\n- Consumes: Task 1\n", 1), [1]);
});

test("acceptance script: prints the table and a summary line", () => {
  const dir = fileURLToPath(new URL("./fixtures/plans/", import.meta.url));
  const script = fileURLToPath(new URL("../scripts/acceptance-plans.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "file | tasks | code\na.md | 4 | ok\nb.md | 2 | ok\noverlap.md | 2 | ok\nreal.md | 2 | ok\n4 plans: 4 parse / 0 fail\n");
  const bad = mkdtempSync(join(tmpdir(), "sf-acc-"));
  writeFileSync(join(bad, "x.md"), "# nothing\n");
  writeFileSync(join(bad, "y.md"), one("- Create: `a.ts`") );
  writeFileSync(join(bad, "notes.txt"), "ignored");
  const a = acceptancePlans(bad);
  assert.deepEqual([a.ok, a.fail], [1, 1]);
  assert.match(a.text, /^x\.md \| - \| PLAN_NO_TASKS$/m);
  assert.match(a.text, /2 plans: 1 parse \/ 1 fail \(1 PLAN_NO_TASKS\)\n$/);
  assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
});

// Fix round 1 (review of 6126b68).

test("fix C1: a Files label after a Consumes line is a Files line, not a Consumes continuation", () => {
  const md = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n- Consumes: Task 1\n  **Files:** `secret.ts`\n";
  assert.deepEqual(files(md, 1), ["create b.ts", "touch secret.ts"]);
  assert.deepEqual(deps(md, 1), [1]);
  // A label alone opens a Files list that is read as before.
  assert.deepEqual(files("### Task 1: A\n- Consumes: nothing,\n  **Files:**\n- Create: `c.ts`\n"), ["create c.ts"]);
});

test("fix I1: a Consumes line keeps only earlier tasks; Depends on stays literal", () => {
  const p = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n### Task 3: C\n";
  const t4 = "### Task 4: D\n- Create: `d.ts`\n";
  assert.deepEqual(deps(p + "- Consumes: `f` (Task 4 uses it), Task 2's `g`\n- Create: `c.ts`\n" + t4, 2), [2]);
  assert.deepEqual(deps(p + "- Consumes: nothing. (Task 4's classifier validates it.)\n- Create: `c.ts`\n" + t4, 2), []);
  assert.deepEqual(deps(p + "**Depends on:** Task 4\n- Create: `c.ts`\n" + t4, 2), [4]);
  // Letter ids order by number, then letter.
  const l = "### Task 6: A\n- Create: `a.ts`\n### Task 6a: B\n- Consumes: Task 6, Task 7\n- Create: `b.ts`\n### Task 7: C\n- Create: `c.ts`\n";
  assert.deepEqual(deps(l, 1), [6]);
});

test("fix m2: digits inside an ISO date are not dependencies", () => {
  const p = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n### Task 3: C\n- Create: `c.ts`\n### Task 9: D\n- Create: `d.ts`\n";
  const d = (line) => deps(p + line + "\n", 3);
  assert.deepEqual(d("- Consumes: Task 1, 2026-10-07 ruling"), [1]);
  assert.deepEqual(d("- Consumes: Task 1, 2026-10-02 ruling"), [1]);
  // Fix round 2 (R2-1) superseded m2's terminator rule: it dropped real lists
  // ("Tasks 2 and 3 outputs"). A number naming an earlier task now counts, fail
  // closed, so these over-serialise.
  assert.deepEqual(d("- Consumes: Task 1, 3 days later"), [1, 3]);
  assert.deepEqual(d("- Consumes: Task 1 and 2 more helpers"), [1, 2]);
  assert.deepEqual(d("- Consumes: Tasks 1, 2 and 3's services"), [1, 2, 3]);
  assert.deepEqual(d("- Consumes: Tasks 1–3."), [1, 2, 3]);
  assert.deepEqual(d("- Consumes: (Tasks 1, 3)"), [1, 3]);
});

// Fix round 2 (re-review of 1aebd8f / 2c8e093).

const four = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n### Task 3: C\n- Create: `c.ts`\n### Task 4: D\n- Create: `d.ts`\n";

test("fix R2-1: a Consumes line keeps every number naming an earlier task (fail closed)", () => {
  const d = (line) => deps(four + line + "\n", 3);
  assert.deepEqual(d("- Consumes: Tasks 2 and 3 outputs"), [2, 3]);
  assert.deepEqual(d("- Consumes: Tasks 1, 2 produced"), [1, 2]);
  assert.deepEqual(d("- Consumes: Tasks 1,2,3 output"), [1, 2, 3]);
  assert.deepEqual(d("- Consumes: Tasks 1 & 2 output"), [1, 2]);
  assert.deepEqual(d("- Consumes: Task 1 or 2 output"), [1, 2]);
  assert.deepEqual(d("- Consumes: Task 1, 2 helpers, Task 3"), [1, 2, 3]);
  // A number naming no task is prose in a Consumes line.
  assert.deepEqual(d("- Consumes: Task 1 and 9 more, see entry 47"), [1]);
  // A Depends on line stays literal: a missing task is a loud error at batch time.
  assert.deepEqual(deps(four + "**Depends on:** Task 9\n", 3), [9]);
});

test("fix R2-2: 'earlier' is plan position, not task number", () => {
  assert.deepEqual(deps("### Task 7: A\n- Create: `a.ts`\n### Task 6: B\n- Consumes: Task 7's `a`\n- Create: `b.ts`\n", 1), [7]);
  assert.deepEqual(deps("### Task 6: A\n- Consumes: Task 7's `a`\n- Create: `a.ts`\n### Task 7: B\n- Create: `b.ts`\n", 0), []);
});

test("fix R2-3: a dependency line inside an open Files list does not close it", () => {
  const p = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n";
  for (const body of [
    "- Modify:\n  - `b.ts`\n  - Consumes: Task 1\n  - `secret.ts`",
    "- Modify:\n  - `b.ts`\n  - Depends on: Task 1\n  - `secret.ts`",
    "- Modify: `b.ts`,\n**Depends on:** Task 1\n`secret.ts`",
    "- Modify: `b.ts`\n  - Consumes: Task 1\n  `secret.ts`",
  ]) {
    assert.deepEqual(files(p + body + "\n", 1), ["modify b.ts", "modify secret.ts"], body);
    assert.deepEqual(deps(p + body + "\n", 1), [1], body);
  }
});

test("fix R2-4: an empty **Files:** label opens a list", () => {
  const p = "### Task 1: A\n- Create: `a.ts`\n";
  assert.deepEqual(files(p + "**Files:**\n- `secret.ts`\n"), ["create a.ts", "touch secret.ts"]);
  assert.deepEqual(files(p + "**Files:**\n  `secret.ts`\n"), ["create a.ts", "touch secret.ts"]);
  // A bare item after an op line in a label's list is a file too.
  assert.deepEqual(files("### Task 1: A\n**Files:**\n- Create: `a.ts`\n- `secret.ts`\n"), ["create a.ts", "touch secret.ts"]);
  // Fix round 3 (S4) changed this case: the list no longer ends at a blank line
  // followed by a list item; "- step one" names no path, so it adds no file.
  assert.deepEqual(files(p + "**Files:**\n- `b.ts`\n\n- step one\n"), ["create a.ts", "touch b.ts"]);
});

test("fix R2-5: more Files line forms, and an indented task heading", () => {
  assert.deepEqual(files(one("1. Create: `x.ts`\n2) Modify: `y.ts`")), ["create x.ts", "modify y.ts"]);
  assert.deepEqual(files(one("Files: `x.ts`, `y.ts`")), ["touch x.ts", "touch y.ts"]);
  assert.deepEqual(files(one("**Files (new):** `x.ts`")), ["touch x.ts"]);
  assert.deepEqual(files(one("**Files (all three):**\n- Create: `x.ts`")), ["create x.ts"]);
  const md = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n- Consumes: Task 1 **Files:** `secret.ts`\n";
  assert.deepEqual(files(md, 1), ["create b.ts", "touch secret.ts"]);
  assert.deepEqual(deps(md, 1), [1]);
  assert.deepEqual(names("### Task 1: A\n- Create: `a.ts`\n   ### Task 2: B\n- Create: `b.ts`\n"), [1, 2]);
  assert.deepEqual(files("### Task 1: A\n- Create: `a.ts`\n   ### Task 2: B\n- Create: `b.ts`\n", 1), ["create b.ts"]);
  // Four spaces is an indented code block, not a heading.
  assert.deepEqual(names("### Task 1: A\n- Create: `a.ts`\n    ### Task 2: B\n"), [1]);
  // Outside a task these forms are refused like the others.
  assert.equal(code("1. Create: `x.ts`\n### Task 1: A\n- Create: `a.ts`\n"), "PLAN_FILES_OUTSIDE_TASK");
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n## Notes\nFiles: `x.ts`\n"), "PLAN_FILES_OUTSIDE_TASK");
});

// Fix round 3 (structural ruling and the remaining Files holes).

const five = four + "### Task 5: E\n";

test("fix S2: Consumes reads T-refs, Task2 with no space, and through / .. ranges", () => {
  const d = (line) => deps(five + line + "\n- Create: `e.ts`\n", 4);
  assert.deepEqual(d("- Consumes: `x` (T1), `y` (T2)"), [1, 2]);
  assert.deepEqual(d("- Consumes: T3's helper"), [3]);
  assert.deepEqual(d("- Consumes: Task2's `z`"), [2]);
  assert.deepEqual(d("- Consumes: Tasks 1 through 3"), [1, 2, 3]);
  assert.deepEqual(d("- Consumes: Tasks 1..3"), [1, 2, 3]);
  // A T-ref to no earlier task is prose.
  assert.deepEqual(d("- Consumes: T17's helper"), []);
});

test("fix S3: a dependency line outside any task is refused", () => {
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n## Notes\n**Depends on:** Task 1\n"), "PLAN_DEPS_OUTSIDE_TASK");
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n  ### Notes\n- Consumes: Task 1\n"), "PLAN_DEPS_OUTSIDE_TASK");
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n   ## Wrap-up\n- Depends on: Task 1\n"), "PLAN_DEPS_OUTSIDE_TASK");
  assert.equal(code("**Depends on:** Task 1\n### Task 1: A\n- Create: `a.ts`\n"), "PLAN_DEPS_OUTSIDE_TASK");
  // Inside a deeper heading the task is still open.
  assert.deepEqual(deps("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n#### Interfaces\n- Consumes: Task 1\n- Create: `b.ts`\n", 1), [1]);
});

test("fix S4: a Files list survives blank lines before a list item or an indented line", () => {
  const p = "### Task 1: A\n- Create: `a.ts`\n";
  assert.deepEqual(files(p + "**Files:**\n\n- `secret.ts`\n"), ["create a.ts", "touch secret.ts"]);
  assert.deepEqual(files("### Task 1: A\n**Files:**\n\n- Create: `a.ts`\n- `secret.ts`\n"), ["create a.ts", "touch secret.ts"]);
  assert.deepEqual(files(one("- Modify:\n  - `b.ts`\n\n  - `secret.ts`")), ["modify b.ts", "modify secret.ts"]);
  assert.deepEqual(files(p + "**Files:**\n- `b.ts`\n\n\n  `secret.ts`\n"), ["create a.ts", "touch b.ts", "touch secret.ts"]);
  // A checkbox step or a paragraph ends the list.
  assert.deepEqual(files(p + "**Files:**\n- `b.ts`\n\n- [ ] **Step 1:** edit `c.ts`\n"), ["create a.ts", "touch b.ts"]);
  assert.deepEqual(files(p + "**Files:**\n- `b.ts`\n\nThen run it.\n\n- `x.ts`\n"), ["create a.ts", "touch b.ts"]);
});

test("fix S5: a lazy backticked-path line right after a Files op line continues it", () => {
  assert.deepEqual(files(one("- Modify: `b.ts`\n`secret.ts`")), ["modify b.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("- Modify: `b.ts`\n`secret.ts` and `c.ts`")), ["modify b.ts", "modify secret.ts", "modify c.ts"]);
  // After a blank line it is a paragraph, not a continuation.
  assert.deepEqual(files(one("- Modify: `b.ts`\n\n`x.ts` is generated.")), ["modify b.ts"]);
});

test("fix S1/S3: only a Depends on label is a dependency line; prose 'depends on' is not", () => {
  // Reference plan 34's appendix wraps prose onto a line opening "depends on it.".
  assert.deepEqual(names("### Task 1: A\n- Create: `a.ts`\n## Appendix\n   depends on it.** The same gap\n"), [1]);
  const p = parsePlan("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\nThe retry\ndepends on 1 clock: the tick.\n");
  // Fix round 4 (R4-2) changed this expectation: a line opening with a loose
  // "depends on" orders like a Consumes line, so the "1" naming the earlier
  // Task 1 is an edge (over-serialising, fail closed). It still never declares.
  assert.deepEqual(p.tasks[1].dependsOn, [1]);
  assert.equal(p.dependencyInfo, "none");
  // The label forms stay dependency lines. Fix round 4 (R4-1): Task 1 carries
  // its own line too, since a plan is declared only when every task does.
  for (const line of ["Depends on: Task 1", "**Depends on:** Task 1", "**Depends on**: Task 1", "**Depends on** Task 1", "- Depends on: 1", "1. Depends on: Task 1"]) {
    const q = parsePlan("### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n### Task 2: B\n" + line + "\n- Create: `b.ts`\n");
    assert.deepEqual([q.tasks[1].dependsOn, q.dependencyInfo], [[1], "declared"], line);
  }
});

// Fix round 4 (controller rulings R4-1 to R4-5).

const info = (md) => parsePlan(md).dependencyInfo;
const dep = (body) => body + "\n";   // a task's Depends on line
const t2 = (deps2) => "### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n### Task 2: B\n- Create: `b.ts`\n" + deps2;

test("fix R4-1: a plan is declared only when every task carries its own Depends on label", () => {
  // One task's line no longer declares the plan; the tasks without one are named.
  const partial = "### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n### Task 2: B\n- Create: `b.ts`\n### Task 3: C\n- Create: `c.ts`\n- Depends on: Task 1\n";
  assert.equal(info(partial), "none");
  assert.deepEqual(parsePlan(partial).missingDependsOn, [2]);
  const all = t2(dep("**Depends on:** Task 1"));
  assert.equal(info(all), "declared");
  assert.deepEqual(parsePlan(all).missingDependsOn, []);
  assert.deepEqual(parsePlan("### Task 1: A\n- Create: `a.ts`\n").missingDependsOn, [1]);
  // A Consumes or "(after Task N)" line on the rest does not make up for a missing label.
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n### Task 2: B (after Task 1)\n- Consumes: Task 1\n- Create: `b.ts`\n"), "none");
});

test("fix R4-1: a Depends on label that reads no task id and is not 'none' is refused", () => {
  for (const line of ["**Depends on:** the ledger task", "Depends on: -", "**Depends on:** nothing", "- Depends on: the schema (see above)"]) {
    assert.equal(code(t2(dep(line))), "PLAN_BAD_DEPENDENCY", line);
  }
  // An empty label with no list after it reads nothing either.
  assert.equal(code(t2("**Depends on:**\nThen build it.\n")), "PLAN_BAD_DEPENDENCY");
  assert.equal(code(t2("**Depends on:**\n")), "PLAN_BAD_DEPENDENCY");
  // "none" in any case, with emphasis or punctuation, is fine.
  for (const line of ["**Depends on:** None.", "Depends on: _none_", "**Depends on:** none (it stands alone)"]) assert.equal(info(t2(dep(line))), "declared", line);
});

test("fix R4-1: Depends on reads T-refs, Task2, ranges and an empty label's nested list", () => {
  const p = four + "### Task 5: E\n- Create: `e.ts`\n";
  const d = (line) => deps(p + line + "\n", 4);
  assert.deepEqual(d("**Depends on:** T1, Task2"), [1, 2]);
  assert.deepEqual(d("**Depends on:** (T3)"), [3]);
  assert.deepEqual(d("Depends on: Tasks 1 through 3"), [1, 2, 3]);
  assert.deepEqual(d("Depends on: 1..3"), [1, 2, 3]);
  assert.deepEqual(d("**Depends on:**\n- Task 2"), [2]);
  assert.deepEqual(d("**Depends on:**\n  - T1\n  - Task 4 (the routes)"), [1, 4]);
  assert.deepEqual(d("**Depends on:**\n\n- Task 3"), [3]);
  // Probe pass: an item four columns past the label after a blank line may be
  // code, so it orders but cannot make the label declare; the label is empty.
  assert.equal(code(t2("**Depends on:**\n\n    - none\n")), "PLAN_BAD_DEPENDENCY");
  assert.deepEqual(deps(t2("**Depends on:**\n\n    - Task 1\n\n- none\n"), 1), [1]);
  // A nested list item that reads no id is refused like the label.
  assert.equal(code(p + "**Depends on:**\n- Task 1\n- the ledger\n"), "PLAN_BAD_DEPENDENCY");
  // The list ends at a Files line, which is read as one.
  const q = t2("**Depends on:**\n- Task 1\n- Modify: `secret.ts`\n");
  assert.deepEqual([deps(q, 1), files(q, 1), info(q)], [[1], ["create b.ts", "modify secret.ts"], "declared"]);
  // A nested list under a bulleted label inside a Files list ends at the next sibling item.
  const r = t2("- Modify:\n  - `c.ts`\n  - Depends on:\n    - Task 1\n  - `secret.ts`\n");
  assert.deepEqual([deps(r, 1), files(r, 1)], [[1], ["create b.ts", "modify c.ts", "modify secret.ts"]]);
});

test("fix R4-2: a loose 'Depends on Task N' orders like Consumes and never declares", () => {
  const p = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n";
  assert.deepEqual(deps(p + "Depends on Task 1\n", 1), [1]);
  assert.deepEqual(deps(p + "- depends on Task 1 and Task 3\n### Task 3: C\n- Create: `c.ts`\n", 1), [1]);
  assert.deepEqual(deps(p + "**Depends on Task 1's schema**\n", 1), [1]);
  assert.equal(info(p + "Depends on Task 1\n"), "none");
  // Even beside labels on every other task, a loose line does not declare its own.
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n### Task 2: B\n- Create: `b.ts`\nDepends on Task 1\n"), "none");
  // Outside a task it is prose, not a refusal.
  assert.deepEqual(names(p + "## Appendix\nDepends on Task 1 being merged.\n"), [1, 2]);
});

test("fix R4-3: HTML comments are skipped for every reading", () => {
  const each = (extra) => "### Task 1: A\n- Create: `a.ts`\n" + extra + "\n### Task 2: B\n- Create: `b.ts`\n" + extra + "\n";
  assert.equal(info(each("<!-- **Depends on:** none -->")), "none");
  assert.equal(info(each("<!--\n**Depends on:** none\n-->")), "none");
  assert.equal(info(each("Some text <!-- **Depends on:** none --> here.")), "none");
  assert.deepEqual(deps(each("<!--\n- Consumes: Task 1\n-->"), 1), []);
  assert.deepEqual(files(one("- Create: `a.ts`\n<!--\n- Modify: `x.ts`\n-->")), ["create a.ts"]);
  assert.deepEqual(files(one("- Modify: `a.ts` <!-- `x.ts` -->")), ["modify a.ts"]);
  // What follows a comment's end on its line is read.
  assert.deepEqual(files(one("- Create: `a.ts`\n<!-- a\nnote --> - Modify: `secret.ts`")), ["create a.ts", "modify secret.ts"]);
  // An opener inside a code span is not a comment, so it hides nothing.
  assert.deepEqual(files(one("- Modify: `a.ts` (`<!--`)\n- Modify: `secret.ts`\n<!-- x -->")), ["modify a.ts", "modify secret.ts"]);
  // A comment that never closes would hide the rest of the plan.
  assert.equal(code(one("- Create: `a.ts`\n<!-- start\n- Modify: `secret.ts`")), "PLAN_UNCLOSED_COMMENT");
  // A mid-line comment spanning lines is read, but it can never declare.
  const m = "### Task 1: A\n- Create: `a.ts`\nText <!-- a\n**Depends on:** none\n- Modify: `secret.ts`\n-->\n";
  assert.deepEqual([files(m), info(m)], [["create a.ts", "modify secret.ts"], "none"]);
});

test("fix R4-3: fenced and 4-space indented code is skipped; nested lists are not code", () => {
  const each = (extra) => "### Task 1: A\n- Create: `a.ts`\n" + extra + "\n### Task 2: B\n- Create: `b.ts`\n" + extra + "\n";
  // Plan C final review (minor 7) superseded the Depends on lines below in code and the quoted one in the next test:
  // a Depends on label inside code was skipped (its task read as having none); it is now refused, like a heading.
  assert.equal(code(each("\nExample:\n\n    **Depends on:** none")), "PLAN_CODE_HIDES_TASK");
  assert.equal(info(each("\n    **Depends on:** none")), "none"); // indented under the list item: its content, not code, and not a label either (kept)
  // Round 6 (R1) superseded this: an op Files line inside code is now refused, not skipped,
  // since nested fences can re-pair and hide one. Code holding other text is still skipped.
  assert.equal(code(one("- Create: `a.ts`\n\nExample:\n\n    - Modify: `x.ts`")), "PLAN_CODE_HIDES_TASK");
  assert.deepEqual(files(one("- Create: `a.ts`\n\nExample:\n\n    edit `x.ts`")), ["create a.ts"]);
  // A fence inside a list item, indented four spaces, is still a fence.
  assert.equal(code(each("- Note:\n\n    ```md\n    **Depends on:** none\n    ```")), "PLAN_CODE_HIDES_TASK");
  // A list item's fence ends with the item: the next item is read, not hidden.
  // Fix round 5 (N1) superseded this: a fence ended by its item rather than by a
  // closer is now refused outright, since the stray closer after it can re-pair with
  // a later fence and swallow Files lines. Nothing is hidden either way.
  assert.equal(code(one("- Create: `a.ts`\n- Step:\n  ```\n  x\n- Modify: `secret.ts`\n```\ny\n```")), "PLAN_UNCLOSED_FENCE");
  assert.equal(code(one("- Create: `a.ts`\n- Step:\n  ```\n- Modify: `secret.ts`\n```")), "PLAN_UNCLOSED_FENCE");
  // Lines indented under a list item are its content, not code.
  assert.deepEqual(files(one("- Modify:\n  - `b.ts`\n\n    - `secret.ts`")), ["modify b.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("- Modify: `b.ts`\n\n    `secret.ts`")), ["modify b.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("- Modify:\n    - `secret.ts`")), ["modify secret.ts"]);
});

test("fix R4-3: blockquote prefixes are stripped and the line read", () => {
  assert.deepEqual(files(one("- Create: `a.ts`\n> - Modify: `secret.ts`")), ["create a.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("> **Files:**\n> - `x.ts`\n> > - Modify: `y.ts`")), ["touch x.ts", "modify y.ts"]);
  assert.deepEqual(deps(t2("> > **Depends on:** Task 1\n"), 1), [1]);
  assert.equal(info(t2("> **Depends on:** Task 1\n")), "declared");
  // A fence inside a quote is skipped; one that loses its quote ends there.
  assert.equal(code(t2("**Depends on:** Task 1\n").replace("**Depends on:** none", "> ```\n> **Depends on:** none\n> ```")), "PLAN_CODE_HIDES_TASK");
  // Fix round 5 (N1) superseded this: a quoted fence ended by an unquoted line, not
  // by a closer, is now refused rather than read past.
  assert.equal(code(one("- Create: `a.ts`\n> ```\n- Modify: `secret.ts`\n```\n```")), "PLAN_UNCLOSED_FENCE");
  assert.equal(code("> - Modify: `x.ts`\n### Task 1: A\n- Create: `a.ts`\n"), "PLAN_FILES_OUTSIDE_TASK");
});

test("fix R4-4: an unindented line directly after a Files line continues it", () => {
  assert.deepEqual(files(one("- Modify: `b.ts`\nand `secret.ts`")), ["modify b.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("- Modify: `b.ts`\n(`secret.ts`)")), ["modify b.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("- Modify: `b.ts`\n**`secret.ts`**")), ["modify b.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("- Modify: `b.ts`,\n  `c.ts`\nand `secret.ts`")), ["modify b.ts", "modify c.ts", "modify secret.ts"]);
  // checkProse holds the continuation to the backtick rule.
  assert.equal(code(one("- Modify: `b.ts`\nand src/secret.ts")), "PLAN_BAD_FILE_LINE");
  // A bullet, heading or label is not a continuation.
  assert.deepEqual(files(one("- Modify: `b.ts`\n**Step 2:** edit it\n- Run it")), ["modify b.ts"]);
  assert.deepEqual(files(one("- Modify: `b.ts`\n#### Notes\nSee `x.ts`.")), ["modify b.ts"]);
});

test("fix R4-4: an unindented sibling bullet under a bare op line is that op's item", () => {
  assert.deepEqual(files(one("- Create: `a.ts`\n- Modify:\n- `secret.ts`")), ["create a.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("- Create: `a.ts`\n- Modify:\n- `b.ts`\n- `secret.ts`")), ["create a.ts", "modify b.ts", "modify secret.ts"]);
  // A checkbox step is never an item. Fix round 5 (N2) superseded the expectation
  // ["create a.ts"]: the bare "- Modify:" then has nothing read under it, which is now
  // refused, since its files may sit where the parser does not read them.
  assert.equal(code(one("- Create: `a.ts`\n- Modify:\n- [ ] edit `x.ts`")), "PLAN_BAD_FILE_LINE");
  assert.deepEqual(files(one("- Create: `a.ts`\n- Modify:\n- `b.ts`\n- [ ] edit `x.ts`")), ["create a.ts", "modify b.ts"]);
});

test("fix R4-5: __Depends on:__ and Depends-on are labels", () => {
  for (const line of ["__Depends on:__ Task 1", "__Depends on__: Task 1", "Depends-on: Task 1", "**Depends-on:** Task 1", "- __Depends on__ Task 1", "*Depends on:* Task 1"]) {
    const p = parsePlan(t2(dep(line)));
    assert.deepEqual([p.tasks[1].dependsOn, p.dependencyInfo], [[1], "declared"], line);
  }
});

test("probe pass: an empty Files label with nothing under it is refused", () => {
  const md = (body) => "### Task 1: A\n**Files:**\n" + body + "\n### Task 2: B\n- Create: `b.ts`\n";
  // Its list in a code block would leave the task file-less and hide the write.
  assert.equal(code(md("```\n- `secret.ts`\n```")), "PLAN_BAD_FILE_LINE");
  assert.equal(code(md("\n    - `secret.ts`")), "PLAN_BAD_FILE_LINE");
  assert.equal(code(md("")), "PLAN_BAD_FILE_LINE");
  // Anything read under it - an item, an op line, a lazy line - satisfies it.
  assert.deepEqual(files(md("- Create: `a.ts`")), ["create a.ts"]);
  assert.deepEqual(files(md("None: this task only runs the suite.")), []);
});

test("fix round 5 N1: a fence ended by its container rather than a closer is refused", () => {
  // A closer at column 0 under a fence opened inside a list item ends the item,
  // not the fence; the next fence would then pair with the wrong closer and
  // swallow the Files lines between (the round-4 re-review's probe).
  const step = (body) => "### Task 1: A\n- [ ] Step 1:\n  ```ts\n  x\n" + body + "\n### Task 2: B\n- Create: `db/migrations/002/m.sql`\n- Modify: `shared.ts`\n**Depends on:** none\n";
  assert.equal(code(step("```\n- Create: `db/migrations/001/m.sql`\n- Modify: `shared.ts`\n**Depends on:** none\n- [ ] Step 2:\n  ```ts\n  y\n```")), "PLAN_UNCLOSED_FENCE");
  // A heredoc's EOF at column 0 inside an item's indented fence.
  assert.equal(code(step("  cat <<EOF\nEOF\n  ```\n- Create: `db/migrations/001/m.sql`\n**Depends on:** none\n- [ ] Step 2:\n  ```bash\n  y\n  ```")), "PLAN_UNCLOSED_FENCE");
  // A quoted fence ended by an unquoted line, or by a blank line, is refused too.
  assert.equal(code(one("- Create: `a.ts`\n> ```\n> x\n- Modify: `secret.ts`")), "PLAN_UNCLOSED_FENCE");
  assert.equal(code(one("- Create: `a.ts`\n> ```\n> x\n\n- Modify: `secret.ts`")), "PLAN_UNCLOSED_FENCE");
  // The refusal names where the fence opened.
  assert.match((() => { try { parsePlan(one("- Step:\n  ```\n  x\nEOF\n- Create: `a.ts`")); } catch (e) { return e.message; } return ""; })(), /line 3/);
  // A fence closed inside its item, or inside its quote, is fine.
  assert.deepEqual(files(one("- Create: `a.ts`\n- Step:\n  ```\n  x\n  ```\n- Modify: `b.ts`")), ["create a.ts", "modify b.ts"]);
  assert.deepEqual(files(one("- Create: `a.ts`\n> ```\n> x\n> ```\n- Modify: `b.ts`")), ["create a.ts", "modify b.ts"]);
  // A blank line inside an item's fence does not end it.
  assert.deepEqual(files(one("- Create: `a.ts`\n- Step:\n  ```\n  x\n\n  y\n  ```\n- Modify: `b.ts`")), ["create a.ts", "modify b.ts"]);
});

test("fix round 5 N2: a bare op line with nothing read under it is refused", () => {
  // Its items in an indented fence, or eight columns deep after a blank line, are code: the files would be hidden.
  assert.equal(code(one("- Create: `a.ts`\n- Modify:\n    ```\n    - `secret.ts`\n    ```") + tail), "PLAN_BAD_FILE_LINE");
  assert.equal(code(one("- Create: `a.ts`\n- Modify:\n\n        - `secret.ts`") + tail), "PLAN_BAD_FILE_LINE");
  assert.equal(code(one("- Create: `a.ts`\n- Delete:") + tail), "PLAN_BAD_FILE_LINE");
  assert.equal(code(one("- Create: `a.ts`\n- Modify:\n\nSome prose.") + tail), "PLAN_BAD_FILE_LINE");
  // Items under it, indented, lazy or after a blank line, satisfy it.
  assert.deepEqual(files(one("- Modify:\n  - `b.ts`")), ["modify b.ts"]);
  assert.deepEqual(files(one("- Modify:\n- `b.ts`")), ["modify b.ts"]);
  assert.deepEqual(files(one("- Modify:\n\n  - `b.ts`")), ["modify b.ts"]);
  assert.deepEqual(files(one("**Files:**\n- Modify:\n  - `b.ts`")), ["modify b.ts"]);
  // "- add:" with nothing after it introduces a step's code block, as before.
  assert.deepEqual(files(one("- Create: `a.ts`\n- add:\n\n```ts\nz\n```")), ["create a.ts"]);
});

test("fix round 5 N3: a loose 'depends on' line inside an open Files list is also its continuation", () => {
  assert.deepEqual(files(one("- Modify: `a.ts` (the parser that\n  depends on `secret.ts`)")), ["modify a.ts", "modify secret.ts"]);
  assert.deepEqual(files(one("**Files:**\n- Modify: `a.ts`\n- Depends on the `secret.ts` schema")), ["modify a.ts", "touch secret.ts"]);
  // It still orders.
  const p = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Modify: `b.ts`,\n  depends on Task 1 for `secret.ts`\n";
  assert.deepEqual([deps(p, 1), files(p, 1), parsePlan(p).dependencyInfo], [[1], ["modify b.ts", "modify secret.ts"], "none"]);
  // With no Files list open it is ordering only, as in round 4.
  assert.deepEqual(files("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n\nDepends on Task 1\n", 1), ["create b.ts"]);
});

test("fix round 5 N4: a '**Files:** none' inside a comment spanning lines exempts nothing", () => {
  assert.equal(code(one("Edit `src/x.ts`. <!-- was:\n**Files:** none\n-->") + tail), "PLAN_TASK_NO_FILES");
  // Outside a comment it still exempts.
  assert.deepEqual(files(one("Edit `src/x.ts`.\n\n**Files:** none") + tail), []);
});

test("fix round 5 O1: lines skipped as code still count as path mentions", () => {
  // Round 6 (R1) superseded the three Files-line forms below: an op Files line inside code was
  // PLAN_TASK_NO_FILES (or skipped beside a real Files line) and is now refused outright, since
  // nested fences can re-pair and hide one. O1 still holds for code that names a path otherwise.
  // A task whose only Files line is indented four spaces under its heading is code, and parses file-less no more.
  assert.equal(code(one("    - Modify: `secret.ts`") + tail), "PLAN_CODE_HIDES_TASK");
  assert.equal(code(one("    edit `secret.ts`") + tail), "PLAN_TASK_NO_FILES");
  // Beside a real Files line, code is still not read for files.
  assert.equal(code(one("- Create: `a.ts`\n\nExample:\n\n    - Modify: `x.ts`")), "PLAN_CODE_HIDES_TASK");
  assert.deepEqual(files(one("- Create: `a.ts`\n\nExample:\n\n    edit `x.ts`")), ["create a.ts"]);
  // Fenced code counts the same way.
  assert.equal(code(one("```\n- Modify: `secret.ts`\n```") + tail), "PLAN_CODE_HIDES_TASK");
  assert.equal(code(one("```\nedit `secret.ts`\n```") + tail), "PLAN_TASK_NO_FILES");
});

// Round 6 (owner-approved extra): three holes that let a plan parse "ok" while hiding a write or a task.
const mig1 = "### Task 1: A\n**Depends on:** none\n- Create: `db/migrations/001/m.sql`\n";
const batch = (md) => taskBatches(parsePlan(md), 4, { migrationsDir: "db/migrations" });

test("fix round 6 B1: a loose 'depends on' continuation keeps the Files line's comma state", () => {
  // The comma on "- Modify: `a.ts`," carries the list past the loose line to the next bullet.
  const p = mig1 + "### Task 2: B\n**Depends on:** none\n- Modify: `a.ts`,\n  depends on the new schema\n- `db/migrations/002/m.sql`\n";
  assert.deepEqual(files(p, 1), ["modify a.ts", "modify db/migrations/002/m.sql"]);
  assert.deepEqual(batch(p), [[1], [2]]);
  // A loose line that ends in a comma opens the comma state itself, as before.
  assert.deepEqual(files(one("- Modify: `a.ts`\n  depends on the schema in,\n- `b.ts`")), ["modify a.ts", "modify b.ts"]);
});

test("fix round 6 R1: a task heading or Files line inside code is refused, never hidden", () => {
  // Two same-length fences nested re-pair: the stray closer opens a fence that swallows Task 2 whole.
  const nested = "### Task 1: A\n- Create: `a.ts`\n\n```md\n```ts\nconst x = 1;\n```\n```\n\n### Task 2: B\n- Create: `b.ts`\n\n```bash\nnpm test\n```\n\n### Task 3: C\n- Create: `c.ts`\n";
  assert.equal(code(nested), "PLAN_CODE_HIDES_TASK");
  assert.throws(() => parsePlan(nested), /line 10/);
  // Every heading form the parser takes as a task, in fenced, indented and quoted code.
  assert.equal(code(one("- Create: `a.ts`\n\n```\n## Task 2: B\n```")), "PLAN_CODE_HIDES_TASK");
  assert.equal(code(one("- Create: `a.ts`\n\nExample:\n\n    ### Task 2: B")), "PLAN_CODE_HIDES_TASK");
  assert.equal(code(one("- Create: `a.ts`\n\n> ```\n> ### Task 2: B\n> ```")), "PLAN_CODE_HIDES_TASK");
  // An op Files line or a Files label in code.
  assert.equal(code(one("- Create: `a.ts`\n\n```\n- Modify: `b.ts`\n```")), "PLAN_CODE_HIDES_TASK");
  assert.equal(code(one("- Create: `a.ts`\n\n```\n**Files:** `b.ts`\n```")), "PLAN_CODE_HIDES_TASK");
  // Before the first task too.
  assert.equal(code("```\n### Task 1: A\n```\n### Task 2: B\n- Create: `b.ts`\n"), "PLAN_CODE_HIDES_TASK");
  // Code that names paths, or mentions a task in prose, is still read for mentions only.
  assert.deepEqual(files(one("- Create: `a.ts`\n\n```ts\nimport x from \"./b.ts\"; // see Task 2: B\n```")), ["create a.ts"]);
});

test("fix round 6 R2: an unindented path-only bullet right after a Files line is that line's item, as touch", () => {
  const p = mig1 + "### Task 2: B\n**Depends on:** none\n- Modify: `a.ts`\n- `db/migrations/002/m.sql`\n";
  assert.deepEqual(files(p, 1), ["modify a.ts", "touch db/migrations/002/m.sql"]);
  assert.deepEqual(batch(p), [[1], [2]]);
  // After a continuation line too, several paths on one bullet, and the next sibling after it.
  assert.deepEqual(files(one("- Modify: `a.ts` and\n  `b.ts`\n- `c.ts`, `d.ts`\n- `e.ts`")), ["modify a.ts", "modify b.ts", "touch c.ts", "touch d.ts", "touch e.ts"]);
  // A bullet with prose beside its paths, or a step, is not an item.
  assert.deepEqual(files(one("- Modify: `a.ts`\n- Run `npm test` in `src/x.ts`")), ["modify a.ts"]);
  assert.deepEqual(files(one("- Modify: `a.ts`\n- [ ] `b.ts`")), ["modify a.ts"]);
});

test("Plan C final review (minor 7): a Depends on line inside code is PLAN_CODE_HIDES_TASK", () => {
  const nl = "\n", fence = "```";
  assert.equal(code(one(["**Depends on:** none", "- Create: `a.ts`", "", fence + "md", "**Depends on:** Task 3", fence].join(nl))), "PLAN_CODE_HIDES_TASK");
  assert.equal(code(one(["**Depends on:** none", "- Create: `a.ts`", "", "Example:", "", "    Depends on: none"].join(nl))), "PLAN_CODE_HIDES_TASK");
  // prose that merely mentions a dependency inside code is not a label
  assert.equal(code(one(["**Depends on:** none", "- Create: `a.ts`", "", fence, "this depends on the schema", fence].join(nl))), null);
});
