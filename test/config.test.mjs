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

test("config: findRepoRoot from a linked worktree is the main checkout, so jobs and config are shared", async () => {
  const { tmpRepo, sh } = await import("./helpers.mjs");
  const { findRepoRoot } = await import("../src/config.mjs");
  const { main } = await import("../src/cli.mjs");
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } }); // untracked: absent from the worktree
  const wt = join(tmpDir("sf-wt-"), "one");
  sh("git", ["worktree", "add", "-q", "-b", "feature/one", wt], root);
  assert.equal(findRepoRoot(wt), findRepoRoot(root));
  const io = (cwd) => { const out = [], err = []; return { out, err, io: { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) } }; };
  const a = io(root);
  assert.equal(await main(["job", "add", "milestone", "Shared"], a.io), 0, a.err.join(""));
  const b = io(wt);
  assert.equal(await main(["job", "show", "m-1"], b.io), 0, b.err.join(""));
  assert.equal(JSON.parse(b.out.join("")).title, "Shared");
});

test("config: string booleans and untyped lists are INVALID_CONFIG, naming the key", () => {
  const base = { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } };
  const root = tmpDir();
  writeConfig(root, { ...base, git: { trailers: "false" } });
  assert.throws(() => loadConfig(root), (e) => e.code === "INVALID_CONFIG" && /git\.trailers/.test(e.message));
  writeConfig(root, { ...base, worktrees: { afterCut: "pnpm install" } });
  assert.throws(() => loadConfig(root), (e) => e.code === "INVALID_CONFIG" && /worktrees\.afterCut/.test(e.message));
  const errs = validateConfig({ ...base, commands: { suite: "x", suiteSerial: "yes", typecheck: "tsc" }, git: { push: "true", namedPathsOnly: 0 },
    rules: "CLAUDE.md", hotspots: [1], fixCardRefusals: {}, stops: "awaiting-approval", ports: { names: "api" },
    secrets: { neverHandToAgents: ".env" }, worktrees: { copyFromBase: [".env", null] } });
  for (const k of ["commands\.suiteSerial", "commands\.typecheck", "git\.push", "git\.namedPathsOnly", "^rules", "^hotspots", "^fixCardRefusals", "^stops", "ports\.names", "secrets\.neverHandToAgents", "worktrees\.copyFromBase"])
    assert.ok(errs.some((e) => new RegExp(k).test(e)), `${k} not named in ${JSON.stringify(errs)}`);
  assert.deepEqual(validateConfig({ ...base, git: { trailers: true, push: false }, rules: ["CLAUDE.md"], worktrees: { afterCut: [] } }), []);
});

test("validateConfig: board.activeMs is a positive integer", () => {
  const base = { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } };
  for (const bad of [0, -1, "x", 1.5]) assert.ok(validateConfig({ ...base, board: { activeMs: bad } }).some((e) => /board\.activeMs/.test(e)), String(bad));
  assert.deepEqual(validateConfig({ ...base, board: { activeMs: 5000 } }), []);
  assert.equal(DEFAULTS.board.activeMs, 120000);
});

test("config: rules entries with .. or an absolute path are refused", () => {
  const base = { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } };
  for (const bad of ["../CLAUDE.md", "a/../../b.md", "/etc/x.md", "C:/x.md", "C:" + String.fromCharCode(92) + "x.md"])
    assert.ok(validateConfig({ ...base, rules: ["CLAUDE.md", bad] }).some((e) => /^rules/.test(e)), bad);
  assert.deepEqual(validateConfig({ ...base, rules: ["CLAUDE.md", "docs/AGENTS.md"] }), []);
});

test("config: record patterns must stay inside the worktree (no absolute path, no ..)", () => {
  const base = { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } };
  assert.deepEqual(validateConfig({ ...base, record: { brief: "spec/modules/{n}-{slug}.md", stories: "spec/product/S_*.md" } }), []);
  for (const [k, v] of [["brief", "/abs/{n}.md"], ["plan", "../plans/{n}.md"], ["log", "C:/logs/{n}.md"], ["stories", "spec/../../x_*.md"], ["carriedForward", String.raw`..\cf.md`]]) {
    const errs = validateConfig({ ...base, record: { [k]: v } });
    assert.ok(errs.some((e) => e.startsWith(`record.${k}:`) && /inside the worktree/.test(e)), `${k}=${v}: ${errs}`);
  }
});
