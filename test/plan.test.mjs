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
  assert.equal(code("### Task 1: A\nno files\n"), "PLAN_TASK_NO_FILES");
  assert.equal(code("### Task 1: A\n- Create: a\n### Task 1: B\n- Create: b\n"), "PLAN_DUPLICATE_TASK");
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
  assert.deepEqual(names("### Task 1: A\n- Create: `a.ts`\n\t```\n" + tail), [1, 2]);
});
