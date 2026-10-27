import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { main } from "../src/cli.mjs";

const plans = (n) => fileURLToPath(new URL(`./fixtures/plans/${n}.md`, import.meta.url));
const run = async (argv, cwd) => { const out = [], err = []; const code = await main(argv, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }); return { code, out: out.join(""), err: err.join("") }; };

test("independence milestones: outside a repository exits 2 with NOT_A_REPO", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-norepo-")));
  const r = await run(["independence", "milestones", plans("a"), plans("overlap")], dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /NOT_A_REPO/);
});

test("independence milestones: in a configured repo prints four rows and exits 1 on a conflict", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-repo-")));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "sfactory.config.json"), JSON.stringify({ project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, hotspots: ["apps/api/src/app.ts"], migrations: { dir: "apps/api/prisma/migrations" }, record: { carriedForward: "spec/modules/19.1-CARRIED-FORWARD.md" } }));
  const r = await run(["independence", "milestones", plans("a"), plans("overlap")], dir);
  assert.equal(r.code, 1);
  assert.equal(r.out.trim().split("\n").length, 4);
  assert.match(r.out, /migrations {2}FAIL/);
});

test("independence milestones: a plan with no tasks keeps its PLAN_NO_TASKS code", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-empty-")));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "sfactory.config.json"), JSON.stringify({ project: "p", agents: { mode: "claude" }, commands: { suite: "x" } }));
  writeFileSync(join(dir, "empty.md"), "# nothing\n");
  const r = await run(["independence", "milestones", "empty.md", plans("a")], dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /PLAN_NO_TASKS/);
});

test("independence milestones: a parse error names the plan file", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-named-")));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "sfactory.config.json"), JSON.stringify({ project: "p", agents: { mode: "claude" }, commands: { suite: "x" } }));
  writeFileSync(join(dir, "empty.md"), "# nothing\n");
  const r = await run(["independence", "milestones", "empty.md", plans("a")], dir);
  assert.match(r.err, /PLAN_NO_TASKS: empty\.md:/);
});
