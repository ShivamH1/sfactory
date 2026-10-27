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

const tk = (n, deps = [], p = `f${n}`) => ({ n, title: "", files: [{ op: "create", path: p }], dependsOn: deps });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test("taskBatches: validation and ordering", () => {
  assert.equal(code(() => taskBatches({ tasks: [tk(1, [9])] }, 4)), "PLAN_BAD_DEPENDENCY");
  assert.equal(code(() => taskBatches({ tasks: [tk(1, [2]), tk(2, [1])] }, 4)), "PLAN_DEPENDENCY_CYCLE");
  assert.deepEqual(taskBatches({ tasks: [tk(1, [2]), tk(2)] }, 4), [[2], [1]]);
  assert.equal(code(() => taskBatches({ tasks: [tk(1)] }, 0)), "BAD_ARGS");
  assert.deepEqual(taskBatches({ tasks: [tk(1, [], "pkg"), tk(2, [], "pkg/x.ts")] }, 4), [[1], [2]]);
});

test("independence: normalised hotspots and a parent migrations directory count", () => {
  const c = { hotspots: ["./packages/core/"], migrations: { dir: "/repo/apps/api/prisma/migrations" }, repoRoot: "/repo", record: {} };
  const p = (path) => ({ tasks: [tk(1, [], path)] });
  const r = checkMilestones(c, p("packages/core/src/a.ts"), p("packages/core/src/a.ts"));
  assert.equal(r.checks.find((x) => x.name === "hotspots").ok, false);
  const m = checkMilestones(c, p("apps/api/prisma"), p("apps/api/prisma/migrations/1/m.sql"));
  assert.equal(m.checks.find((x) => x.name === "migrations").ok, false);
});

test("independence: a file-less task touches nothing", () => {
  const plan = parsePlan("### Task 1: Baseline\nRun the suite.\n### Task 2: B\n- Create: `b.ts`\n### Task 3: C\n- Modify: `b.ts`\n### Task 4: Close\nTick the boxes.\n");
  assert.deepEqual(taskBatches(plan, 4), [[1, 2, 4], [3]]);
  const r = checkMilestones({ hotspots: [], migrations: null, repoRoot: "/repo", record: {} }, plan, { tasks: [tk(1, [], "c.ts"), { n: 2, title: "", files: [], dependsOn: [] }] });
  assert.equal(r.ok, true);
});

test("independence: read lines never conflict", () => {
  const a = parsePlan("### Task 1: A\n- Read: `CLAUDE.md`\n- Create: `a.ts`\n### Task 2: B\n- Read: `CLAUDE.md`\n- Create: `b.ts`\n");
  const b = parsePlan("### Task 1: X\n- Read: `CLAUDE.md`\n- Create: `x.ts`\n");
  assert.deepEqual(a.tasks[0].files[0], { op: "read", path: "CLAUDE.md" });
  const r = checkMilestones({ hotspots: ["CLAUDE.md"], migrations: null, repoRoot: "/repo", record: {} }, a, b);
  assert.deepEqual(r.checks.filter((c) => ["disjoint-files", "hotspots"].includes(c.name)).map((c) => c.ok), [true, true]);
  assert.deepEqual(taskBatches(a, 4), [[1, 2]]);
  const w = parsePlan("### Task 1: X\n- Modify: `CLAUDE.md`\n");
  assert.equal(checkMilestones({ hotspots: ["CLAUDE.md"], migrations: null, repoRoot: "/repo", record: {} }, w, w).ok, false);
});
