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
  assert.deepEqual(d("- Consumes from history state (Task 6 writes it): `{ a: 1 }`"), [6]);
  assert.deepEqual(d("- Consumes: the Task 3 schemas."), [3]);
  // Another milestone's task is not this plan's.
  assert.deepEqual(d("- Consumes: `v` (M44 Task 6); `w` (M44's Task 2); Task 1"), [1]);
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

test("deps: dependencyInfo is declared when any task has a dependency source, else none", () => {
  const info = (md) => parsePlan(md).dependencyInfo;
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n" + tail), "none");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n- Consumes: nothing.\n" + tail), "none");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n### Task 2: B (after Task 1)\n- Create: `b.ts`\n"), "declared");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Consumes: Task 1\n- Create: `b.ts`\n"), "declared");
  assert.equal(info("### Task 1: A\n- Create: `a.ts`\n**Depends on:** none\n" + tail), "declared");
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
