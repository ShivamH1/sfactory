import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlan } from "../src/plan.mjs";
import { checkMilestones, taskBatches } from "../src/independence.mjs";

const read = (n) => parsePlan(readFileSync(new URL(`./fixtures/plans/${n}.md`, import.meta.url), "utf8"));
const cfg = { hotspots: ["CLAUDE.md", "spec/modules/19.1-CARRIED-FORWARD.md", "packages/core", "apps/api/src/app.ts"], migrations: { dir: "/repo/apps/api/prisma/migrations" }, repoRoot: "/repo", record: { carriedForward: "spec/modules/19.1-CARRIED-FORWARD.md" } };

test("independence: a and b may run in parallel", () => {
  const r = checkMilestones(cfg, read("a"), read("b"), { nameA: "m-1", nameB: "m-2" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [["disjoint-files", true], ["hotspots", true], ["migrations", true], ["numbering", true]]);
});

test("independence: a and overlap fail three checks with named files", () => {
  const r = checkMilestones(cfg, read("a"), read("overlap"), { nameA: "m-1", nameB: "m-3" });
  assert.equal(r.ok, false);
  const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.equal(by["disjoint-files"].ok, false); assert.match(by["disjoint-files"].detail, /alpha\.service\.ts/);
  assert.equal(by.hotspots.ok, false); assert.match(by.hotspots.detail, /app\.ts/);
  assert.equal(by.migrations.ok, false); assert.match(by.migrations.detail, /both/);
  assert.equal(by.numbering.ok, false); assert.match(by.numbering.detail, /m-3 waits/);
});

test("independence: migrations and numbering are skipped when the project has neither", () => {
  const r = checkMilestones({ hotspots: [], migrations: null, repoRoot: "/repo", record: { carriedForward: null } }, read("a"), read("overlap"), { nameA: "x", nameB: "y" });
  assert.equal(r.checks.find((c) => c.name === "migrations").ok, true);
  assert.equal(r.checks.find((c) => c.name === "numbering").ok, true);
});

test("independence: task batches respect dependencies, disjointness and the cap", () => {
  assert.deepEqual(taskBatches(read("a"), 4), [[1, 4], [2], [3]]);
  const plan = { tasks: [1, 2, 3, 4, 5].map((n) => ({ n, title: String(n), files: [{ op: "create", path: `f${n}` }], dependsOn: [] })) };
  assert.deepEqual(taskBatches(plan, 2), [[1, 2], [3, 4], [5]]);
  const shared = { tasks: [{ n: 1, title: "", files: [{ op: "modify", path: "x" }], dependsOn: [] }, { n: 2, title: "", files: [{ op: "modify", path: "x" }], dependsOn: [] }] };
  assert.deepEqual(taskBatches(shared, 4), [[1], [2]]);
});
