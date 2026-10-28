import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlan } from "../src/plan.mjs";

const a = parsePlan(readFileSync(new URL("./fixtures/plans/a.md", import.meta.url), "utf8"));

test("plan: tasks, files, ops, line suffix stripped, dependencies in both syntaxes", () => {
  assert.equal(a.tasks.length, 4);
  assert.deepEqual(a.tasks[0], { n: 1, title: "Schema", files: [{ op: "create", path: "apps/api/prisma/migrations/20261027_a/migration.sql" }, { op: "modify", path: "apps/api/prisma/schema.prisma" }], dependsOn: [] });
  assert.deepEqual(a.tasks[1].dependsOn, [1]);
  assert.deepEqual(a.tasks[2].dependsOn, [2]);
  assert.deepEqual(a.tasks[2].files[1], { op: "modify", path: "apps/api/src/app.ts" });
});

const real = parsePlan(readFileSync(new URL("./fixtures/plans/real.md", import.meta.url), "utf8"));

test("plan: real format - h2 headings, no-colon lines, several paths, letter ids, fences and prose ignored", () => {
  assert.deepEqual(real.tasks.map((t) => t.n), [1, "6a"]);
  assert.deepEqual(real.tasks[0].files, [
    { op: "modify", path: "apps/x.ts" }, { op: "create", path: "apps/y.ts" }, { op: "create", path: "apps/z.ts" }, { op: "test", path: "apps/x.test.ts" },
  ]);
  assert.deepEqual(real.tasks[0].dependsOn, ["6a"]);
  assert.deepEqual(real.tasks[0].title, "Service");
  assert.deepEqual(real.tasks[1].files.map((f) => f.path), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(real.tasks[1].dependsOn, [1]);
});

const code = (md) => { try { parsePlan(md); } catch (e) { return e.code; } return null; };

test("plan: fails closed", () => {
  assert.equal(code("# nothing here"), "PLAN_NO_TASKS");
  // Round 4 changed this expectation: a task that names no path is file-less,
  // so a plan made only of such tasks has no files at all.
  assert.equal(code("### Task 1: A\nno files\n"), "PLAN_NO_FILES");
  assert.equal(code("### Task 1: A\nedit `src/x.ts` by hand\n### Task 2: B\n- Create: `b.ts`\n"), "PLAN_TASK_NO_FILES");
  // Round 4: an unticked item must be path-like, so the input names files with extensions.
  assert.equal(code("### Task 1: A\n- Create: a.ts\n### Task 1: B\n- Create: b.ts\n"), "PLAN_DUPLICATE_TASK");
});

const tail = "### Task 2: Next\n- Create: `next.ts`\n";
const names = (md) => parsePlan(md).tasks.map((t) => t.n);

test("plan: CommonMark fences", () => {
  const four = "### Task 1: A\n- Create: `a.ts`\n````md\n```js\n### Task 9: fake\n- Create: `leak.ts`\n```\n````\n" + tail;
  assert.deepEqual(names(four), [1, 2]);
  assert.deepEqual(parsePlan(four).tasks[0].files, [{ op: "create", path: "a.ts" }]);
  assert.deepEqual(names("### Task 1: A\n- Create: `a.ts`\n~~~\n```\n~~~\n" + tail), [1, 2]);
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n```\n### Task 2: hidden\n"), "PLAN_UNCLOSED_FENCE");
});

test("plan: a file item without backticks must be one token", () => {
  assert.equal(code("### Task 1: A\n- Modify: apps/api/src/app.ts (register the route)\n"), "PLAN_BAD_FILE_LINE");
  assert.equal(code("### Task 1: A\n- Modify: a.ts, b c.ts\n"), "PLAN_BAD_FILE_LINE");
  assert.deepEqual(parsePlan("### Task 1: A\n- Modify: apps/api/src/app.ts\n").tasks[0].files, [{ op: "modify", path: "apps/api/src/app.ts" }]);
});

test("plan: mixed Files lines refuse unquoted text", () => {
  const one = (line) => "### Task 1: A\n" + line + "\n";
  assert.equal(code(one("- Modify: `a.ts`, b.ts")), "PLAN_BAD_FILE_LINE");
  assert.deepEqual(parsePlan(one("- Modify: `a.ts` and `b.ts`")).tasks[0].files.map((f) => f.path), ["a.ts", "b.ts"]);
  assert.deepEqual(parsePlan(one("- Modify: `a.ts`, `b.ts`,")).tasks[0].files.map((f) => f.path), ["a.ts", "b.ts"]);
});

test("plan: fence openers - inline triple-backtick runs and tab indents are not fences", () => {
  assert.deepEqual(names("### Task 1: A\n- Create: `a.ts`\n```x```\n" + tail), [1, 2]);
  // Fix round 5 (N1) superseded this case: under the "- Create:" item a tab-indented
  // fence is the item's own fence (R4-3), and "### Task 2" ends it by its container,
  // not by a closer - now refused, since such a fence can re-pair with a later closer
  // and swallow Files lines. The original intent, a tab-indented run outside any
  // item being indented code and not a fence, holds directly under the heading.
  assert.equal(code("### Task 1: A\n- Create: `a.ts`\n\t```\n" + tail), "PLAN_UNCLOSED_FENCE");
  assert.deepEqual(names("### Task 1: A\n\t```\n- Create: `a.ts`\n" + tail), [1, 2]);
});

const files = (md) => parsePlan(md).tasks[0].files;
const one1 = (line) => "### Task 1: A\n" + line + "\n";

test("plan round 4: trailing prose that names no path is allowed", () => {
  assert.deepEqual(files(one1("- Modify: `apps/x.ts` (extend)")), [{ op: "modify", path: "apps/x.ts" }]);
  assert.deepEqual(files(one1("- Create: `y.ts` *(create)*")), [{ op: "create", path: "y.ts" }]);
  assert.deepEqual(files(one1("- Modify: `z.ts` (the controller call), Tier 3)")), [{ op: "modify", path: "z.ts" }]);
  assert.deepEqual(files(one1("- Test: `t.ts`.")), [{ op: "test", path: "t.ts" }]);
  assert.deepEqual(files(one1("- Modify: `a.ts` / `b.ts` (route)")).map((f) => f.path), ["a.ts", "b.ts"]);
  // Round 5 changed this expectation: `Foo` is an identifier, so it is prose, not a path.
  assert.deepEqual(files(one1("- Modify: `a.ts` (`Foo` at :80-87)")).map((f) => f.path), ["a.ts"]);
  assert.deepEqual(files(one1("- Modify: `a.ts` (see M44.1 and 19.1 entry 7)")).map((f) => f.path), ["a.ts"]);
});

test("plan round 5: backticked items that are not path-like are prose", () => {
  assert.deepEqual(files(one1("- Modify: `apps/api/src/app.ts` (`register`, `describe`, `RewardProgram`)")).map((f) => f.path), ["apps/api/src/app.ts"]);
  assert.deepEqual(files(one1("- Modify: `web/api.ts` (the `\"/me/wallet\"` route, `'/x'`)")).map((f) => f.path), ["web/api.ts"]);
  assert.deepEqual(files(one1("- Modify: `.env`, `.`, `Makefile.am`")).map((f) => f.path), [".env", ".", "Makefile.am"]);
  // Plan C Task 1 (N4) changed this expectation: the first backticked item after
  // an op is the op's object, so a bare word there (`createSession`, as `src` or
  // `Makefile` would be) is taken as a path, fail closed; later identifiers stay prose.
  const p = parsePlan("### Task 1: A\n- Modify: `createSession` and `adminUserId`\nThen run it.\n### Task 2: B\n- Create: `b.ts`\n");
  assert.deepEqual(p.tasks[0].files, [{ op: "modify", path: "createSession" }]);
  // A Files line whose items are none of them paths (the first is not a bare
  // word) contributes no files; the task then falls under ruling 4.
  const q = parsePlan("### Task 1: A\n- Modify: `createSession()` and `adminUserId`\nThen run it.\n### Task 2: B\n- Create: `b.ts`\n");
  assert.deepEqual(q.tasks[0].files, []);
  // Fix round 4 (R4-4): "See `src/auth.ts`." directly under the Files line now
  // continues it (the path is recorded, fail closed); after a blank line it is
  // prose and the mention check applies as before.
  assert.equal(code("### Task 1: A\n- Modify: `createSession()`\n\nSee `src/auth.ts`.\n### Task 2: B\n- Create: `b.ts`\n"), "PLAN_TASK_NO_FILES");
  assert.deepEqual(parsePlan("### Task 1: A\n- Modify: `createSession()`\nSee `src/auth.ts`.\n### Task 2: B\n- Create: `b.ts`\n").tasks[0].files, [{ op: "modify", path: "src/auth.ts" }]);
});

test("plan round 4: a path-like token beside a backticked item is refused", () => {
  for (const line of ["- Modify: `a.ts` and b.ts", "- Modify: `a.ts` (also src/x)", "- Modify: `a.ts` ..", "- Modify: `a.ts` (and .env)", "- Modify: `a.ts` (:src)"]) {
    assert.equal(code(one1(line)), "PLAN_BAD_FILE_LINE", line);
  }
});

test("plan round 4: more ops, with or without a colon, lower-cased", () => {
  assert.deepEqual(files(one1("- Delete: `old.ts`")), [{ op: "delete", path: "old.ts" }]);
  assert.deepEqual(files(one1("- RENAME `a.tsx` → `b.tsx`")).map((f) => f.op + " " + f.path), ["rename a.tsx", "rename b.tsx"]);
  for (const op of ["Read", "Add", "Remove", "Edit", "Move", "Touch"]) assert.deepEqual(files(one1(`- ${op}: \`f.ts\``)), [{ op: op.toLowerCase(), path: "f.ts" }]);
  assert.deepEqual(files(one1("- Create (gitignored): `.superpowers/r.ts`")), [{ op: "create", path: ".superpowers/r.ts" }]);
  // A step bullet that starts with an op word is not a Files line.
  assert.deepEqual(files("### Task 1: A\n- Create: `a.ts`\n- add `import x from \"y\";`\n- add:\n\n```ts\nz\n```\n"), [{ op: "create", path: "a.ts" }]);
});

test("plan round 4: unticked items must each be one path-like token, never empty", () => {
  for (const line of ["- Modify: ```", "- Modify: ``", "- Modify: a.ts, , b.ts", "- Modify: a.ts,", "- Create: the three migrations named in the file map", "- Modify: something"]) {
    assert.equal(code(one1(line)), "PLAN_BAD_FILE_LINE", line);
  }
  assert.deepEqual(files(one1("- Modify: src/a.ts, b.json")).map((f) => f.path), ["src/a.ts", "b.json"]);
});

test("plan round 4: file-less tasks", () => {
  const p = parsePlan("### Task 1: Baseline\nRun the suite; record the count.\n### Task 2: B\n- Create: `b.ts`\n");
  assert.deepEqual(p.tasks.map((t) => t.files), [[], [{ op: "create", path: "b.ts" }]]);
  assert.deepEqual(parsePlan("### Task 1: A\n**Files:** none changed. Log entry only, see `spec/log.md`.\n### Task 2: B\n- Create: `b.ts`\n").tasks[0].files, [{ op: "touch", path: "spec/log.md" }]);
  // Fix round 4 (R4-4) changed this expectation: the unindented line right
  // after the label continues it, so `docs/x.md` is recorded (fail closed).
  // After a blank line it is prose, and the label's "none" stands.
  assert.deepEqual(parsePlan("### Task 1: A\n**Files:** none in the repo.\nThen read `docs/x.md`.\n### Task 2: B\n- Create: `b.ts`\n").tasks[0].files, [{ op: "touch", path: "docs/x.md" }]);
  assert.deepEqual(parsePlan("### Task 1: A\n**Files:** none in the repo.\n\nThen read `docs/x.md`.\n### Task 2: B\n- Create: `b.ts`\n").tasks[0].files, []);
  assert.equal(code("### Task 1: A\nRun `pnpm test` and read `CLAUDE.md`.\n### Task 2: B\n- Create: `b.ts`\n"), "PLAN_TASK_NO_FILES");
  assert.equal(code("### Task 1: A\nRun the suite.\n### Task 2: B\nAnd the build.\n"), "PLAN_NO_FILES");
  // Prose after the plan's last task is not that task's.
  assert.deepEqual(parsePlan("### Task 1: A\n- Create: `a.ts`\n### Task 2: Close\nTick the boxes.\n## Self-review\nSee `src/x.ts`.\n").tasks[1].files, []);
});

test("plan round 4: a Files line continues onto indented lines or after a trailing comma", () => {
  assert.deepEqual(files(one1("- Test: `a.test.ts` (rewrite),\n  `b.test.ts`,\n  `c.test.ts` (fixtures only)")).map((f) => f.path), ["a.test.ts", "b.test.ts", "c.test.ts"]);
  assert.deepEqual(files(one1("**Files:** `x.tsx`, `y.tsx`,\n`z.tsx`.")).map((f) => f.op + " " + f.path), ["touch x.tsx", "touch y.tsx", "touch z.tsx"]);
  assert.deepEqual(files(one1("- Create:\n  - `n1.ts`\n  - `n2.ts`")).map((f) => f.path), ["n1.ts", "n2.ts"]);
  assert.equal(code(one1("- Modify: `a.ts`,\n  and also src/b.ts")), "PLAN_BAD_FILE_LINE");
});
