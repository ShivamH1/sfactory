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
