import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parsePlan } from "../src/plan.mjs";
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
  assert.equal(code(one("- Read: `CLAUDE.md`\nThen edit `src/a.ts`.") + tail), "PLAN_TASK_NO_FILES");
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
  assert.equal(code(one("- Modify: none\nEdit `src/a.ts` by hand.") + tail), "PLAN_TASK_NO_FILES");
  assert.equal(code(one("- Create: none\n- Modify: none\nSee `src/a.ts`.") + tail), "PLAN_TASK_NO_FILES");
  assert.deepEqual(files(one("**Files:** none\nSee `docs/x.md`.") + tail), []);
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
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n" + tail), "declared");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Depends on: Task 1\n- Create: `b.ts`\n"), "declared");
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
  assert.deepEqual(p.tasks[1].dependsOn, []);
  assert.equal(p.dependencyInfo, "none");
  // The label forms stay dependency lines.
  for (const line of ["Depends on: Task 1", "**Depends on:** Task 1", "**Depends on**: Task 1", "**Depends on** Task 1", "- Depends on: 1", "1. Depends on: Task 1"]) {
    const q = parsePlan("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n" + line + "\n- Create: `b.ts`\n");
    assert.deepEqual([q.tasks[1].dependsOn, q.dependencyInfo], [[1], "declared"], line);
  }
});
