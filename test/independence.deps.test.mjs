import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parsePlan } from "../src/plan.mjs";
import { taskBatches, migrationsDirOf } from "../src/independence.mjs";
import { main } from "../src/cli.mjs";

// Plan C entry criterion I7: a plan with no dependency information runs
// sequentially unless the caller allows it, and the migrations rule applies
// inside a milestone.

const undeclared = "### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Create: `b.ts`\n### Task 3: C\n- Create: `c.ts`\n";

test("taskBatches: a plan with no dependency information is sequential", () => {
  const p = parsePlan(undeclared);
  assert.equal(p.dependencyInfo, "none");
  assert.deepEqual(taskBatches(p, 4), [[1], [2], [3]]);
  assert.deepEqual(taskBatches(p, 4, { allowUndeclared: true }), [[1, 2, 3]]);
});

test("taskBatches: a plan built without dependencyInfo is treated as undeclared (fail closed)", () => {
  const plan = { tasks: [1, 2].map((n) => ({ n, title: "", files: [{ op: "create", path: `f${n}` }], dependsOn: [] })) };
  assert.deepEqual(taskBatches(plan, 4), [[1], [2]]);
  assert.deepEqual(taskBatches({ ...plan, dependencyInfo: "declared" }, 4), [[1, 2]]);
});

test("taskBatches: dependencies inferred from Consumes and (after Task N) order the batches", () => {
  const p = parsePlan("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Consumes: Task 1's `a`\n- Create: `b.ts`\n### Task 3: C (after Task 2)\n- Create: `c.ts`\n### Task 4: D\n- Create: `d.ts`\n");
  assert.equal(p.dependencyInfo, "declared");
  assert.deepEqual(taskBatches(p, 4), [[1, 4], [2], [3]]);
});

test("taskBatches: two tasks adding migrations never share a batch", () => {
  const md = "### Task 1: A\n- Create: `db/migrations/1_a/migration.sql`\n**Depends on:** none\n### Task 2: B\n- Create: `db/migrations/2_b/migration.sql`\n### Task 3: C\n- Create: `c.ts`\n### Task 4: D\n- Modify: `db/migrations`\n";
  const p = parsePlan(md);
  assert.deepEqual(taskBatches(p, 4), [[1, 2, 3], [4]]);
  assert.deepEqual(taskBatches(p, 4, { migrationsDir: "./db/migrations/" }), [[1, 3], [2], [4]]);
  const q = parsePlan(md.replace("- Modify: `db/migrations`", "- Create: `d.ts`"));
  assert.deepEqual(taskBatches(q, 4), [[1, 2, 3, 4]]);
  assert.deepEqual(taskBatches(q, 4, { migrationsDir: "db/migrations" }), [[1, 3, 4], [2]]);
  // A task touching a parent of the migrations dir counts as adding one.
  const r = parsePlan("### Task 1: A\n- Modify: `db`\n**Depends on:** none\n### Task 2: B\n- Create: `db/migrations/2/m.sql`\n");
  assert.deepEqual(taskBatches(r, 4, { migrationsDir: "db/migrations" }), [[1], [2]]);
  // Read lines add nothing.
  const s = parsePlan("### Task 1: A\n- Read: `db/migrations/1/m.sql`\n- Create: `a.ts`\n**Depends on:** none\n### Task 2: B\n- Create: `db/migrations/2/m.sql`\n");
  assert.deepEqual(taskBatches(s, 4, { migrationsDir: "db/migrations" }), [[1, 2]]);
});

test("migrationsDirOf: relative to the repo root, null when the project has none", () => {
  assert.equal(migrationsDirOf({ repoRoot: "/repo", migrations: { dir: "/repo/apps/api/prisma/migrations" } }), "apps/api/prisma/migrations");
  assert.equal(migrationsDirOf({ repoRoot: "/repo", migrations: null }), null);
  assert.equal(migrationsDirOf({ repoRoot: "/repo" }), null);
});

const run = async (argv, cwd) => { const out = [], err = []; const code = await main(argv, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }); return { code, out: out.join(""), err: err.join("") }; };

test("independence tasks: sequential for an undeclared plan unless --allow-undeclared; migrations from the config", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-deps-")));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "sfactory.config.json"), JSON.stringify({ project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, migrations: { dir: "db/migrations" } }));
  writeFileSync(join(dir, "u.md"), undeclared);
  let r = await run(["independence", "tasks", "u.md"], dir);
  assert.equal(r.code, 0);
  assert.equal(r.out, "[[1],[2],[3]]\n");
  assert.match(r.err, /no dependency information/);
  r = await run(["independence", "tasks", "--allow-undeclared", "u.md"], dir);
  assert.equal(r.code, 0);
  assert.equal(r.out, "[[1,2,3]]\n");
  writeFileSync(join(dir, "m.md"), "### Task 1: A\n- Create: `db/migrations/1/m.sql`\n**Depends on:** none\n### Task 2: B\n- Create: `db/migrations/2/m.sql`\n");
  r = await run(["independence", "tasks", "m.md"], dir);
  assert.equal(r.out, "[[1],[2]]\n");
  assert.equal(r.err, "");
});

// Fix round 1 (review of 6126b68): a file shared with an earlier task is an ordering edge.

test("fix I2: a task never runs before an earlier task it shares a file with", () => {
  // The coordinator's shape: T3 lands after T1's batch.
  const a = parsePlan("### Task 1: A\n- Create: `a.ts`\n### Task 2: B\n- Consumes: Task 1\n- Create: `b.ts`\n### Task 3: C\n- Modify: `a.ts`\n");
  const ba = taskBatches(a, 4);
  assert.ok(ba.findIndex((b) => b.includes(3)) > ba.findIndex((b) => b.includes(1)), JSON.stringify(ba));
  // The reference plans' shape (08-ledger): the earlier task waits on a dependency, the later one does not.
  const b = parsePlan("### Task 1: A\n- Create: `x.ts`\n### Task 2: B\n- Consumes: Task 1\n- Create: `a.ts`\n### Task 3: C\n- Modify: `a.ts`\n");
  assert.deepEqual(taskBatches(b, 4), [[1], [2], [3]]);
  // An explicit forward Depends on wins over plan order, without a cycle.
  const c = parsePlan("### Task 1: A\n- Modify: `a.ts`\n**Depends on:** Task 2\n### Task 2: B\n- Create: `a.ts`\n");
  assert.deepEqual(taskBatches(c, 4), [[2], [1]]);
});
