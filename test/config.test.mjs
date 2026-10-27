import { writeFileSync, mkdirSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, basename } from "node:path";
import { tmpDir, writeConfig } from "./helpers.mjs";
import { loadConfig, validateConfig, resolveConfig, DEFAULTS } from "../src/config.mjs";

test("config: minimal file resolves every default", () => {
  const root = tmpDir();
  writeConfig(root, { project: "my-app", agents: { mode: "claude" }, commands: { suite: "npm test" } });
  const c = loadConfig(root);
  assert.equal(c.project, "my-app");
  assert.equal(c.agents.mode, "claude");
  assert.equal(c.commands.suite, "npm test");
  assert.equal(c.stateDir, join(root, ".sfactory"));
  assert.equal(c.worktrees.dir, join(dirname(root), basename(root) + "-worktrees"));
  assert.equal(c.worktrees.branchPrefix, "feature/");
  assert.equal(c.worktrees.baseRule, "integration-branch");
  assert.equal(c.record.style, "docs-folder");
  assert.deepEqual(c.stops, ["awaiting-approval", "decision-needed"]);
  assert.equal(c.limits.parallelMilestones, 2);
  assert.equal(c.git.push, true);
  assert.equal(c.git.merge, false);
  assert.equal(c.ports.base, 4100);
  assert.equal(c.migrations, null);
});

test("config: absolute and relative paths resolve against the repo root", () => {
  const root = tmpDir();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: "state", worktrees: { dir: tmpDir() } });
  const c = loadConfig(root);
  assert.equal(c.stateDir, join(root, "state"));
  assert.ok(c.worktrees.dir.length > 0 && !c.worktrees.dir.startsWith("."));
});

test("config: validation names every problem", () => {
  const errs = validateConfig({ agents: { mode: "both" }, limits: { parallelMilestones: 9 }, stops: ["nowhere"], git: { merge: true } });
  assert.ok(errs.some((e) => /project/.test(e)));
  assert.ok(errs.some((e) => /agents\.mode/.test(e)));
  assert.ok(errs.some((e) => /commands\.suite/.test(e)));
  assert.ok(errs.some((e) => /parallelMilestones/.test(e)));
  assert.ok(errs.some((e) => /stops/.test(e)));
  assert.ok(errs.some((e) => /git\.merge/.test(e)));
});

test("config: missing file is NO_CONFIG, invalid file is INVALID_CONFIG", () => {
  const root = tmpDir();
  assert.throws(() => loadConfig(root), (e) => e.code === "NO_CONFIG");
  writeConfig(root, { project: "p" });
  assert.throws(() => loadConfig(root), (e) => e.code === "INVALID_CONFIG" && /agents\.mode/.test(e.message));
});

test("config: DEFAULTS is frozen and resolveConfig does not mutate input", () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  const raw = { project: "p", agents: { mode: "codex" }, commands: { suite: "x" } };
  const c = resolveConfig(raw, tmpDir());
  assert.equal(raw.stateDir, undefined);
  assert.equal(c.agents.mode, "codex");
});

test("config: a resolved config shares no arrays with DEFAULTS", () => {
  const root = tmpDir();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } });
  const c = loadConfig(root);
  c.stops.push("x");
  assert.deepEqual(DEFAULTS.stops, ["awaiting-approval", "decision-needed"]);
});

test("config: a null section is INVALID_CONFIG, not a TypeError", () => {
  const root = tmpDir();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, worktrees: null });
  assert.throws(() => loadConfig(root), (e) => e.code === "INVALID_CONFIG" && /worktrees/.test(e.message));
});

test("config: a UTF-8 BOM does not break loading", () => {
  const root = tmpDir();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sfactory.config.json"), "\uFEFF" + JSON.stringify({ project: "p", agents: { mode: "claude" }, commands: { suite: "x" } }));
  assert.equal(loadConfig(root).project, "p");
});
