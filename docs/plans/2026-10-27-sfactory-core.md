# sfactory Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the engine of sfactory: the npm package and Claude Code plugin scaffold, the config loader, the job store and state machine, locks, ports, git and worktree operations, commit and push with their refusals, the serialised suite runner, the independence checks, cost recording, the `sfactory` CLI and `doctor`.

**Architecture:** One ESM Node package with no runtime dependencies. Every operation is a pure-ish module in `src/` with a thin CLI dispatcher; the plugin's `bin/` shims call the same CLI. State is a folder per job under `stateDir`; `job.json` is written only through `src/job.mjs`, which refuses any edge not in its transition table. Tests run under `node --test` against temp directories and temp git repos, never against a real project.

**Tech Stack:** Node 20+ (ESM `.mjs`, `node:test`, `node:fs`, `node:child_process`, `node:net`), git 2.30+, Claude Code plugin manifests. No bundler, no TypeScript, no dependencies.

## Global Constraints

- Node `>=20`; `"type": "module"`; every file `.mjs`; no runtime dependencies (`dependencies: {}`).
- Windows, macOS and Linux: use `node:path` for every path, `spawnSync("git", args)` with an args array (never a shell string) for git, `shell: true` only for the user's own commands from config.
- No brand words in identifiers; the package and plugin are both named `sfactory`.
- Errors thrown by `src/` are `SfactoryError(code, message)`; the CLI prints `error <CODE>: <message>` and exits 2. A refusal is never a silent no-op.
- `job.json` is written only by `src/job.mjs` through `src/store.mjs`'s atomic write; nothing else imports `writeJob`.
- Every write of `job.json` appends a `history` entry `{ at, from, to, by, reason }`.
- Commits in this repo: conventional messages (`feat:`, `test:`, `chore:`, `docs:`), named paths only, no trailers.
- Licence MIT; `LICENSE` lands in Task 1.
- Reference: `docs/DESIGN.md` §4 (stages), §6 (independence), §8 (config), §9 (layout), §12 (guardrails).

---

## File structure

```
sfactory/
  package.json                 name, version 0.1.0, type module, bin, files, scripts.test
  LICENSE                      MIT
  .gitignore                   node_modules, .sfactory, *.log
  .claude-plugin/plugin.json   { name, version, description, author }
  .claude-plugin/marketplace.json
  bin/                         shims: sfactory-job, sfactory-worktree, sfactory-lock, sfactory-suite,
                               sfactory-commit, sfactory-push, sfactory-independence, sfactory-ports,
                               sfactory-doctor, sfactory-cost  (board, init, install, sync-rules: later plans)
  src/
    errors.mjs                 SfactoryError
    config.mjs                 DEFAULTS, findRepoRoot, loadConfig, resolveConfig, validateConfig
    store.mjs                  slugify, jobsDir, jobDir, listJobs, readJob, writeJob, nextId, writeJobFile, readJobFile
    job.mjs                    STAGES, COLUMNS, TRANSITIONS, newJob, transition, park, release, stop, resume
    lock.mjs                   acquire, release, status, withLock
    git.mjs                    git, isClean, currentBranch, headOf, newestFeatureBranch, worktrees, branchContains
    worktree.mjs               cut, remove
    ports.mjs                  allocate, isFree
    commit.mjs                 commit, hasTrailers, assertNamedPaths
    push.mjs                   push
    suite.mjs                  runSuite
    plan.mjs                   parsePlan
    independence.mjs           checkMilestones, taskBatches
    prices.mjs                 DEFAULT_PRICES
    cost.mjs                   addCost, readCost, totalUsd
    doctor.mjs                 runDoctor
    cli.mjs                    dispatch; commands/*.mjs per sub-command
    commands/job.mjs  commands/lock.mjs  commands/worktree.mjs  commands/ports.mjs
    commands/commit.mjs  commands/push.mjs  commands/suite.mjs  commands/independence.mjs
    commands/cost.mjs  commands/doctor.mjs
  schema/config.json           JSON Schema for sfactory.config.json (documentation + $schema target)
  test/
    helpers.mjs                tmpDir, tmpRepo, writeConfig
    config.test.mjs  store.test.mjs  job.test.mjs  lock.test.mjs  git.test.mjs  worktree.test.mjs
    ports.test.mjs  commit.test.mjs  push.test.mjs  suite.test.mjs  plan.test.mjs
    independence.test.mjs  cost.test.mjs  doctor.test.mjs  cli.test.mjs
    fixtures/plans/a.md  fixtures/plans/b.md  fixtures/plans/overlap.md
```

---

### Task 1: Package scaffold, licence, plugin manifests, CLI skeleton

**Files:**
- Create: `package.json`, `LICENSE`, `.gitignore`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `src/errors.mjs`, `src/cli.mjs`, `test/helpers.mjs`, `test/cli.test.mjs`

**Interfaces:**
- Produces: `SfactoryError(code, message)` with `.code`; `cli.mjs` exporting `main(argv) -> Promise<number>` (exit code) and a `register(name, handler)` table later tasks add to; `test/helpers.mjs` exporting `tmpDir()`, `tmpRepo()`, `writeConfig(repoRoot, obj)`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "sfactory",
  "version": "0.1.0",
  "description": "A software factory for Claude Code and Codex: cards move from backlog to pushed through plan, build, review, verify, with a kanban board of file-based state.",
  "license": "MIT",
  "author": "Shivam Sanjay (https://github.com/ShivamH1)",
  "repository": { "type": "git", "url": "https://github.com/ShivamH1/sfactory.git" },
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "sfactory": "./src/cli.mjs" },
  "files": ["src", "bin", "board", "skills", "agents", "prompts", "schema", "docs/DESIGN.md", "INSTALL.md", "README.md", "LICENSE"],
  "scripts": { "test": "node --test test/" },
  "dependencies": {}
}
```

- [ ] **Step 2: Write LICENSE (MIT, 2026, Shivam Sanjay), .gitignore**

`.gitignore`:
```
node_modules/
.sfactory/
*.log
```

- [ ] **Step 3: Write the plugin manifests**

`.claude-plugin/plugin.json`:
```json
{
  "name": "sfactory",
  "version": "0.1.0",
  "description": "Software factory: backlog → plan → build → review → verify → pushed, with a kanban board. Claude, Codex or both.",
  "author": { "name": "Shivam Sanjay", "url": "https://github.com/ShivamH1" }
}
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "sfactory",
  "owner": { "name": "Shivam Sanjay", "url": "https://github.com/ShivamH1" },
  "plugins": [
    { "name": "sfactory", "source": "./", "description": "Software factory: backlog → plan → build → review → verify → pushed, with a kanban board. Claude, Codex or both." }
  ]
}
```

- [ ] **Step 4: Write src/errors.mjs**

```js
export class SfactoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SfactoryError";
    this.code = code;
  }
}
export function fail(code, message) { throw new SfactoryError(code, message); }
```

- [ ] **Step 5: Write the failing CLI test**

`test/cli.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";

test("cli: version prints the package version and exits 0", async () => {
  const out = [];
  const code = await main(["version"], { stdout: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.match(out.join(""), /^sfactory 0\.1\.0/);
});

test("cli: unknown command exits 2 with an error line", async () => {
  const err = [];
  const code = await main(["nope"], { stderr: (s) => err.push(s) });
  assert.equal(code, 2);
  assert.match(err.join(""), /error UNKNOWN_COMMAND: nope/);
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL, `Cannot find module '../src/cli.mjs'`.

- [ ] **Step 7: Write src/cli.mjs**

```js
#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SfactoryError } from "./errors.mjs";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const commands = new Map();
/** Later tasks call register("job", handler) from src/commands/*.mjs. */
export function register(name, handler) { commands.set(name, handler); }

/** Minimal arg parser: positionals plus --flag, --flag=value, --flag value. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const [name, ...rest] = argv;
  if (!name || name === "version" || name === "--version") { stdout(`sfactory ${pkg.version}\n`); return 0; }
  const handler = commands.get(name);
  if (!handler) { stderr(`error UNKNOWN_COMMAND: ${name}\n`); return 2; }
  try {
    const code = await handler(parseArgs(rest), { stdout, stderr, cwd: io.cwd ?? process.cwd() });
    return code ?? 0;
  } catch (e) {
    if (e instanceof SfactoryError) { stderr(`error ${e.code}: ${e.message}\n`); return 2; }
    stderr(`error INTERNAL: ${e?.stack ?? e}\n`);
    return 3;
  }
}

// Command modules register themselves on import. Each later task adds one line here.
await Promise.all([
  // import("./commands/job.mjs"),
]);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 8: Write test/helpers.mjs**

```js
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function tmpDir(prefix = "sf-") { return mkdtempSync(join(tmpdir(), prefix)); }

export function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A git repo with one commit on main and user config set, so commits work in CI. */
export function tmpRepo() {
  const dir = tmpDir("sf-repo-");
  sh("git", ["init", "-q", "-b", "main"], dir);
  sh("git", ["config", "user.email", "t@example.com"], dir);
  sh("git", ["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "README.md"), "# t\n");
  sh("git", ["add", "README.md"], dir);
  sh("git", ["commit", "-q", "-m", "init"], dir);
  return dir;
}

export function writeConfig(repoRoot, obj) {
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, "sfactory.config.json"), JSON.stringify(obj, null, 2));
}
```

- [ ] **Step 9: Run the test to see it pass**

Run: `node --test test/cli.test.mjs`
Expected: 2 passing.

- [ ] **Step 10: Commit**

```bash
git add package.json LICENSE .gitignore .claude-plugin/plugin.json .claude-plugin/marketplace.json src/errors.mjs src/cli.mjs test/helpers.mjs test/cli.test.mjs
git commit -m "feat: package scaffold, plugin manifests, CLI dispatcher"
```

---

### Task 2: Config — defaults, load, resolve, validate

**Files:**
- Create: `src/config.mjs`, `schema/config.json`, `test/config.test.mjs`

**Interfaces:**
- Produces: `findRepoRoot(cwd) -> string` (via `git rev-parse --show-toplevel`, throws `NOT_A_REPO`); `loadConfig(repoRoot) -> Config` (reads `sfactory.config.json`, throws `NO_CONFIG` if absent, `INVALID_CONFIG` with every message joined); `resolveConfig(raw, repoRoot) -> Config`; `validateConfig(raw) -> string[]`; `DEFAULTS`.
- `Config` shape (all paths absolute): `{ repoRoot, project, agents: { mode, claude: {...}, codex: {...} }, stateDir, worktrees: { dir, branchPrefix, baseRule, integrationBranch, afterCut: string[], copyFromBase: string[] }, commands: { suite, suiteSerial, build, typecheck: string[], migrate, services: [] }, ports: { base, step, names: string[] }, record: { style, brief, plan, log, stories, carriedForward, postCloseHeading, numbering }, rules: string[], hotspots: string[], migrations: { dir } | null, fixCardRefusals: string[], stops: string[], limits: { parallelMilestones, parallelTasks, fixRounds, taskRounds, suiteWaitMs, lockStaleMs }, git: { trailers, namedPathsOnly, push, merge }, secrets: { neverHandToAgents: string[] }, board: { port, pollMs }, prices: object }`.

- [ ] **Step 1: Write the failing tests**

`test/config.test.mjs`:
```js
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
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/config.test.mjs` — Expected: FAIL, module not found.

- [ ] **Step 3: Write src/config.mjs**

```js
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { DEFAULT_PRICES } from "./prices.mjs";

export const STOP_STAGES = ["awaiting-approval", "decision-needed", "verifying", "pushing"];
export const MODES = ["claude", "codex", "mixed"];
export const BASE_RULES = ["newest-feature-branch", "integration-branch"];

export const DEFAULTS = Object.freeze({
  agents: {
    claude: { plan: "opus/high", review: "opus/high", judge: "opus/high", implement: "sonnet", triage: "haiku" },
    codex: { implement: "implement", review: "review" },
  },
  worktrees: { branchPrefix: "feature/", baseRule: "integration-branch", integrationBranch: null, afterCut: [], copyFromBase: [] },
  commands: { suiteSerial: true, build: null, typecheck: [], migrate: null, services: [] },
  ports: { base: 4100, step: 100, names: ["api", "web"] },
  record: {
    style: "docs-folder",
    brief: "docs/sfactory/{id}/brief.md", plan: "docs/sfactory/{id}/plan.md", log: "docs/sfactory/{id}/log.md",
    stories: null, carriedForward: null, postCloseHeading: "# Post-close work", numbering: "job-id",
  },
  rules: ["CLAUDE.md"],
  hotspots: [],
  migrations: null,
  fixCardRefusals: [],
  stops: ["awaiting-approval", "decision-needed"],
  limits: { parallelMilestones: 2, parallelTasks: 4, fixRounds: 3, taskRounds: 3, suiteWaitMs: 7_200_000, lockStaleMs: 3_600_000 },
  git: { trailers: false, namedPathsOnly: true, push: true, merge: false },
  secrets: { neverHandToAgents: [] },
  board: { port: 5900, pollMs: 2000 },
  prices: DEFAULT_PRICES,
});

export function findRepoRoot(cwd = process.cwd()) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0) fail("NOT_A_REPO", `${cwd} is not inside a git repository`);
  return resolve(r.stdout.trim());
}

export function validateConfig(raw) {
  const errs = [];
  if (!raw || typeof raw !== "object") return ["config must be a JSON object"];
  if (typeof raw.project !== "string" || !raw.project.trim()) errs.push("project: a non-empty string is required");
  if (!raw.agents || !MODES.includes(raw.agents.mode)) errs.push(`agents.mode: one of ${MODES.join(", ")} is required`);
  if (!raw.commands || typeof raw.commands.suite !== "string") errs.push("commands.suite: the test command string is required");
  const lim = raw.limits ?? {};
  if (lim.parallelMilestones != null && !(Number.isInteger(lim.parallelMilestones) && lim.parallelMilestones >= 1 && lim.parallelMilestones <= 3))
    errs.push("limits.parallelMilestones: integer 1..3");
  if (lim.parallelTasks != null && !(Number.isInteger(lim.parallelTasks) && lim.parallelTasks >= 1 && lim.parallelTasks <= 4))
    errs.push("limits.parallelTasks: integer 1..4");
  if (lim.fixRounds != null && !(Number.isInteger(lim.fixRounds) && lim.fixRounds >= 1)) errs.push("limits.fixRounds: integer >= 1");
  if (raw.stops != null) {
    if (!Array.isArray(raw.stops)) errs.push("stops: must be an array");
    else for (const s of raw.stops) if (!STOP_STAGES.includes(s)) errs.push(`stops: "${s}" is not a stoppable stage (${STOP_STAGES.join(", ")})`);
  }
  if (raw.git?.merge === true) errs.push("git.merge: the factory never merges; remove this key");
  if (raw.worktrees?.baseRule != null && !BASE_RULES.includes(raw.worktrees.baseRule) && typeof raw.worktrees.baseRule !== "string")
    errs.push("worktrees.baseRule: newest-feature-branch, integration-branch or a branch name");
  if (raw.ports != null) {
    if (raw.ports.base != null && !(Number.isInteger(raw.ports.base) && raw.ports.base > 1024 && raw.ports.base < 65000)) errs.push("ports.base: integer 1025..64999");
    if (raw.ports.step != null && !(Number.isInteger(raw.ports.step) && raw.ports.step >= 2)) errs.push("ports.step: integer >= 2");
  }
  if (raw.record?.style != null && !["docs-folder", "spec-tree"].includes(raw.record.style)) errs.push("record.style: docs-folder or spec-tree");
  return errs;
}

function merge(def, raw) {
  if (Array.isArray(def) || Array.isArray(raw)) return raw ?? def;
  if (def && typeof def === "object" && raw && typeof raw === "object") {
    const out = {};
    for (const k of new Set([...Object.keys(def), ...Object.keys(raw)])) out[k] = merge(def[k], raw[k]);
    return out;
  }
  return raw === undefined ? def : raw;
}

const abs = (root, p) => (p == null ? null : isAbsolute(p) ? p : resolve(root, p));

export function resolveConfig(raw, repoRoot) {
  const c = merge(DEFAULTS, structuredClone(raw));
  c.repoRoot = repoRoot;
  c.stateDir = abs(repoRoot, raw.stateDir ?? ".sfactory");
  c.worktrees.dir = abs(repoRoot, raw.worktrees?.dir ?? join(dirname(repoRoot), basename(repoRoot) + "-worktrees"));
  if (c.migrations && c.migrations.dir) c.migrations = { ...c.migrations, dir: abs(repoRoot, c.migrations.dir) };
  c.secrets.neverHandToAgents = c.secrets.neverHandToAgents.map((p) => abs(repoRoot, p));
  return c;
}

export function loadConfig(repoRoot) {
  const file = join(repoRoot, "sfactory.config.json");
  if (!existsSync(file)) fail("NO_CONFIG", `${file} not found; run "sfactory init"`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { fail("INVALID_CONFIG", `${file}: ${e.message}`); }
  const errs = validateConfig(raw);
  if (errs.length) fail("INVALID_CONFIG", `${file}:\n  ${errs.join("\n  ")}`);
  return resolveConfig(raw, repoRoot);
}
```

`src/prices.mjs` (needed by the import; Task 11 tests it):
```js
/** USD per million tokens. Estimates for the board's cost figure only; override with config.prices. */
export const DEFAULT_PRICES = Object.freeze({
  "claude-fable-5-1":  { input: 10.0, output: 50.0, cacheRead: 0.25 },
  "claude-opus-5-5":   { input: 4.0,  output: 20.0, cacheRead: 0.20 },
  "claude-sonnet-5-5": { input: 2.0,  output: 10.0, cacheRead: 0.20 },
  "claude-haiku-5-5":  { input: 0.10, output: 0.50, cacheRead: 0.01 },
});
```

- [ ] **Step 4: Write schema/config.json**

A JSON Schema (draft 2020-12) mirroring `validateConfig`: `required: ["project", "agents", "commands"]`, `agents.mode` enum, `commands.suite` string, `limits` integer ranges, `stops` enum items, `git.merge` `const: false`, `record.style` enum, `ports.base`/`step` ranges, every other key typed and described with the sentence from `docs/DESIGN.md` §8. `additionalProperties: false` at the top level.

- [ ] **Step 5: Run the tests**

Run: `node --test test/config.test.mjs` — Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add src/config.mjs src/prices.mjs schema/config.json test/config.test.mjs
git commit -m "feat: config defaults, loading, resolution and validation"
```

---

### Task 3: Job store — ids, slugs, atomic writes, job files

**Files:**
- Create: `src/store.mjs`, `test/store.test.mjs`

**Interfaces:**
- Produces: `slugify(title) -> string` (lowercase, `[a-z0-9-]`, max 40, no leading/trailing `-`); `jobsDir(config)`, `jobDir(config, id)`; `listJobs(config) -> Job[]` (sorted by `started` ascending; unreadable folders skipped with a `warnings` array on the result? No: skipped silently, listed by `listJobIds`); `readJob(config, id)` throws `JOB_NOT_FOUND`; `writeJob(config, job)` atomic (tmp + rename), sets `job.updated`; `nextId(config, kind) -> "m-<n>" | "f-<n>"` (n = 1 + highest existing of that kind); `writeJobFile(config, id, relPath, text)` (creates folders); `readJobFile(config, id, relPath) -> string | null`; `jobFileExists`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { slugify, jobDir, listJobs, readJob, writeJob, nextId, writeJobFile, readJobFile, jobFileExists } from "../src/store.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-state-") });

test("store: slugify", () => {
  assert.equal(slugify("M56 Feed moderation queue!"), "m56-feed-moderation-queue");
  assert.equal(slugify("  --Hello  World-- "), "hello-world");
  assert.equal(slugify("x".repeat(80)).length, 40);
});

test("store: nextId counts per kind", () => {
  const c = cfg();
  assert.equal(nextId(c, "milestone"), "m-1");
  writeJob(c, { id: "m-1", kind: "milestone", title: "a", stage: "backlog", started: "2026-01-01T00:00:00Z", history: [] });
  writeJob(c, { id: "m-7", kind: "milestone", title: "b", stage: "backlog", started: "2026-01-02T00:00:00Z", history: [] });
  assert.equal(nextId(c, "milestone"), "m-8");
  assert.equal(nextId(c, "fix"), "f-1");
});

test("store: writeJob is atomic and stamps updated; readJob round-trips; listJobs sorts by started", () => {
  const c = cfg();
  writeJob(c, { id: "f-2", kind: "fix", title: "later", stage: "backlog", started: "2026-01-03T00:00:00Z", history: [] });
  writeJob(c, { id: "f-1", kind: "fix", title: "earlier", stage: "backlog", started: "2026-01-01T00:00:00Z", history: [] });
  const j = readJob(c, "f-1");
  assert.equal(j.title, "earlier");
  assert.ok(j.updated);
  assert.ok(!existsSync(join(jobDir(c, "f-1"), "job.json.tmp")));
  assert.deepEqual(listJobs(c).map((x) => x.id), ["f-1", "f-2"]);
});

test("store: readJob of a missing id is JOB_NOT_FOUND", () => {
  assert.throws(() => readJob(cfg(), "m-9"), (e) => e.code === "JOB_NOT_FOUND");
});

test("store: job files under the job folder", () => {
  const c = cfg();
  writeJob(c, { id: "m-1", kind: "milestone", title: "a", stage: "backlog", started: "2026-01-01T00:00:00Z", history: [] });
  writeJobFile(c, "m-1", "plan/approval.md", "approved\n");
  assert.equal(jobFileExists(c, "m-1", "plan/approval.md"), true);
  assert.equal(readJobFile(c, "m-1", "plan/approval.md"), "approved\n");
  assert.equal(readJobFile(c, "m-1", "nope.md"), null);
  assert.equal(readFileSync(join(jobDir(c, "m-1"), "plan", "approval.md"), "utf8"), "approved\n");
});
```

- [ ] **Step 2: Run to see them fail** — `node --test test/store.test.mjs`, module not found.

- [ ] **Step 3: Write src/store.mjs**

```js
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fail } from "./errors.mjs";

export function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}
export const jobsDir = (c) => join(c.stateDir, "jobs");
export const jobDir = (c, id) => join(jobsDir(c), id);
const jobFile = (c, id) => join(jobDir(c, id), "job.json");

export function listJobIds(c) {
  const d = jobsDir(c);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => existsSync(join(d, n, "job.json")));
}
export function listJobs(c) {
  return listJobIds(c).map((id) => readJob(c, id)).sort((a, b) => String(a.started).localeCompare(String(b.started)) || a.id.localeCompare(b.id));
}
export function readJob(c, id) {
  const f = jobFile(c, id);
  if (!existsSync(f)) fail("JOB_NOT_FOUND", `no job ${id} under ${jobsDir(c)}`);
  return JSON.parse(readFileSync(f, "utf8"));
}
/** Only src/job.mjs may call this. Atomic: write a temp file, then rename over job.json. */
export function writeJob(c, job) {
  mkdirSync(jobDir(c, job.id), { recursive: true });
  job.updated = new Date().toISOString();
  const f = jobFile(c, job.id);
  const tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify(job, null, 2) + "\n");
  renameSync(tmp, f);
  return job;
}
export function nextId(c, kind) {
  const prefix = kind === "milestone" ? "m-" : "f-";
  const max = listJobIds(c).filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(2))).filter(Number.isInteger).reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}${max + 1}`;
}
export function writeJobFile(c, id, rel, text) {
  const f = join(jobDir(c, id), rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
}
export function readJobFile(c, id, rel) {
  const f = join(jobDir(c, id), rel);
  return existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : null;
}
export const jobFileExists = (c, id, rel) => existsSync(join(jobDir(c, id), rel));
```

- [ ] **Step 4: Run the tests** — Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/store.mjs test/store.test.mjs
git commit -m "feat: job store with atomic writes and per-kind ids"
```

---

### Task 4: The state machine and the `job` command

**Files:**
- Create: `src/job.mjs`, `src/commands/job.mjs`, `test/job.test.mjs`
- Modify: `src/cli.mjs` (uncomment the import line)

**Interfaces:**
- Produces (pure, in `src/job.mjs`): `STAGES`, `TERMINAL = ["merged"]`, `WORKING = ["planning","building","reviewing","fixing","verifying","pushing"]`, `COLUMNS` (stage → column name), `TRANSITIONS` (stage → allowed next stages), `newJob({ id, kind, title, now }) -> Job`, `transition(job, to, { by, reason, now }) -> Job` (throws `ILLEGAL_TRANSITION`), `park(job, { by, reason, pending, now })` (→ `decision-needed`, sets `returnStage`, `pending` one of `"decision" | "parallel"`), `release(job, { by, now })` (→ `returnStage`), `stop(job, {...})` (sets `previousStage`), `resume(job, {...})`.
- `Job`: `{ id, kind, title, stage, returnStage, previousStage, pending, branch, base, worktree, ports, record, tasks: { total, done, parallel: [] }, round, rework, parallel, agents, cost, started, updated, ended, history: [] }`.
- Produces (effects, in `src/commands/job.mjs`): the `sfactory job …` sub-commands: `add <milestone|fix> "<title>"`, `set <id> <stage> [--reason]`, `park <id> --reason "<r>" [--pending parallel]`, `answer <id>`, `approve <id> [--by]`, `parallel <id> --yes|--no`, `stop <id> [--reason]`, `resume <id>`, `merged <id>`, `rework <id> --notes "<n>"`, `show <id>`, `list [--json]`. Each prints the job id and new stage; `--json` prints the job.

- [ ] **Step 1: Write the failing tests for the pure machine**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES, TRANSITIONS, COLUMNS, WORKING, newJob, transition, park, release, stop, resume } from "../src/job.mjs";

const now = "2026-10-27T10:00:00.000Z";

test("job: every stage has a column and a transition entry", () => {
  for (const s of STAGES) { assert.ok(COLUMNS[s], s); assert.ok(Array.isArray(TRANSITIONS[s]), s); }
  for (const [s, nexts] of Object.entries(TRANSITIONS)) for (const n of nexts) assert.ok(STAGES.includes(n), `${s} -> ${n}`);
});

test("job: the main line for a milestone", () => {
  let j = newJob({ id: "m-1", kind: "milestone", title: "t", now });
  assert.equal(j.stage, "backlog");
  for (const to of ["planning", "awaiting-approval", "building", "reviewing", "verifying", "pushing", "pushed", "merged"]) j = transition(j, to, { by: "test", now });
  assert.equal(j.stage, "merged");
  assert.equal(j.ended, now);
  assert.equal(j.history.length, 8);
  assert.deepEqual(j.history[0], { at: now, from: "backlog", to: "planning", by: "test", reason: null });
});

test("job: a fix skips approval and a milestone may not", () => {
  const f = transition(newJob({ id: "f-1", kind: "fix", title: "t", now }), "planning", { now });
  assert.equal(transition(f, "building", { now }).stage, "building");
  const m = transition(newJob({ id: "m-1", kind: "milestone", title: "t", now }), "planning", { now });
  assert.throws(() => transition(m, "building", { now }), (e) => e.code === "ILLEGAL_TRANSITION");
});

test("job: illegal edges are refused and the job is not mutated", () => {
  const j = newJob({ id: "m-1", kind: "milestone", title: "t", now });
  assert.throws(() => transition(j, "pushed", { now }), (e) => e.code === "ILLEGAL_TRANSITION" && /backlog -> pushed/.test(e.message));
  assert.throws(() => transition(j, "nowhere", { now }), (e) => e.code === "ILLEGAL_TRANSITION");
  assert.equal(j.stage, "backlog");
  assert.equal(j.history.length, 0);
});

test("job: fix loop and the rework edges", () => {
  let j = newJob({ id: "m-1", kind: "milestone", title: "t", now });
  for (const to of ["planning", "awaiting-approval", "building", "reviewing"]) j = transition(j, to, { now });
  j = transition(j, "fixing", { now });
  assert.equal(j.round, 1);
  j = transition(j, "reviewing", { now });
  j = transition(j, "fixing", { now });
  assert.equal(j.round, 2);
  j = transition(j, "reviewing", { now });
  j = transition(j, "building", { now, reason: "rework" });
  assert.equal(j.rework, 1);
  assert.throws(() => transition(transition(j, "reviewing", { now }), "pushed", { now }));
});

test("job: park from every working stage and release to it", () => {
  for (const s of WORKING) {
    const j = { ...newJob({ id: "m-1", kind: "milestone", title: "t", now }), stage: s };
    const p = park(j, { by: "session", reason: "D6 vs stories 4.2", now });
    assert.equal(p.stage, "decision-needed");
    assert.equal(p.returnStage, s);
    assert.equal(p.pending, "decision");
    const r = release(p, { by: "board", now });
    assert.equal(r.stage, s);
    assert.equal(r.returnStage, null);
    assert.equal(r.pending, null);
  }
  const b = park(newJob({ id: "m-2", kind: "milestone", title: "t", now }), { reason: "parallel?", pending: "parallel", now });
  assert.equal(b.returnStage, "backlog");
  assert.throws(() => park({ ...newJob({ id: "m-3", kind: "milestone", title: "t", now }), stage: "merged" }, { reason: "x", now }), (e) => e.code === "ILLEGAL_TRANSITION");
});

test("job: stop remembers where it was; resume returns there; merged cannot stop", () => {
  const j = { ...newJob({ id: "m-1", kind: "milestone", title: "t", now }), stage: "fixing" };
  const s = stop(j, { reason: "usage limit", now });
  assert.equal(s.stage, "stopped");
  assert.equal(s.previousStage, "fixing");
  assert.equal(resume(s, { now }).stage, "fixing");
  assert.throws(() => stop({ ...j, stage: "merged" }, { reason: "x", now }), (e) => e.code === "ILLEGAL_TRANSITION");
});
```

- [ ] **Step 2: Run to see them fail** — `node --test test/job.test.mjs`.

- [ ] **Step 3: Write src/job.mjs**

```js
import { fail } from "./errors.mjs";

export const STAGES = ["backlog", "planning", "awaiting-approval", "building", "reviewing", "fixing", "verifying", "pushing", "pushed", "merged", "decision-needed", "stopped"];
export const TERMINAL = ["merged"];
export const WORKING = ["planning", "building", "reviewing", "fixing", "verifying", "pushing"];
export const COLUMNS = {
  backlog: "Backlog", planning: "Plan", "awaiting-approval": "Needs you", building: "In process", reviewing: "Review",
  fixing: "Fixed", verifying: "Fixed", pushing: "Pushed / PR", pushed: "Pushed / PR", merged: "Done",
  "decision-needed": "Needs you", stopped: "Stopped",
};
/** Edges other than park/stop, which are added per call. "awaiting-approval -> building" also needs the approval file (commands/job.mjs). */
export const TRANSITIONS = {
  backlog: ["planning"],
  planning: ["awaiting-approval", "building"],
  "awaiting-approval": ["building"],
  building: ["reviewing"],
  reviewing: ["fixing", "verifying", "building"],
  fixing: ["reviewing"],
  verifying: ["pushing", "fixing"],
  pushing: ["pushed"],
  pushed: ["merged", "building"],
  merged: [],
  "decision-needed": [],   // only release()
  stopped: [],             // only resume()
};

export function newJob({ id, kind, title, now = new Date().toISOString() }) {
  if (!["milestone", "fix"].includes(kind)) fail("BAD_KIND", `kind must be milestone or fix, got ${kind}`);
  return {
    id, kind, title, stage: "backlog", returnStage: null, previousStage: null, pending: null,
    branch: null, base: null, worktree: null, ports: null, record: null,
    tasks: { total: 0, done: 0, parallel: [] }, round: 0, rework: 0, parallel: null, agents: null, cost: 0,
    started: now, updated: now, ended: null, history: [],
  };
}

const entry = (job, to, { by = "session", reason = null, now = new Date().toISOString() }) => ({ at: now, from: job.stage, to, by, reason });

export function transition(job, to, opts = {}) {
  const allowed = TRANSITIONS[job.stage] ?? [];
  if (!STAGES.includes(to) || !allowed.includes(to)) fail("ILLEGAL_TRANSITION", `${job.stage} -> ${to} is not allowed for ${job.id}`);
  if (job.stage === "planning" && to === "building" && job.kind === "milestone") fail("ILLEGAL_TRANSITION", `planning -> building needs approval for a milestone (${job.id})`);
  const next = structuredClone(job);
  next.history.push(entry(job, to, opts));
  next.stage = to;
  if (to === "fixing") next.round += 1;
  if (to === "building" && ["reviewing", "pushed"].includes(job.stage)) next.rework += 1;
  if (TERMINAL.includes(to)) next.ended = opts.now ?? new Date().toISOString();
  return next;
}

export function park(job, { by = "session", reason, pending = "decision", now } = {}) {
  if (!reason) fail("BAD_ARGS", "park needs a reason");
  if (!WORKING.includes(job.stage) && job.stage !== "backlog") fail("ILLEGAL_TRANSITION", `${job.stage} cannot park (${job.id})`);
  const next = structuredClone(job);
  next.history.push(entry(job, "decision-needed", { by, reason, now }));
  next.returnStage = job.stage; next.pending = pending; next.stage = "decision-needed";
  return next;
}
export function release(job, { by = "session", now } = {}) {
  if (job.stage !== "decision-needed" || !job.returnStage) fail("ILLEGAL_TRANSITION", `${job.id} is not parked`);
  const next = structuredClone(job);
  next.history.push(entry(job, job.returnStage, { by, reason: "released", now }));
  next.stage = job.returnStage; next.returnStage = null; next.pending = null;
  return next;
}
export function stop(job, { by = "session", reason = "stopped", now } = {}) {
  if (TERMINAL.includes(job.stage) || job.stage === "stopped") fail("ILLEGAL_TRANSITION", `${job.stage} cannot stop (${job.id})`);
  const next = structuredClone(job);
  next.history.push(entry(job, "stopped", { by, reason, now }));
  next.previousStage = job.stage; next.stage = "stopped";
  return next;
}
export function resume(job, { by = "session", now } = {}) {
  if (job.stage !== "stopped" || !job.previousStage) fail("ILLEGAL_TRANSITION", `${job.id} is not stopped`);
  const next = structuredClone(job);
  next.history.push(entry(job, job.previousStage, { by, reason: "resumed", now }));
  next.stage = job.previousStage; next.previousStage = null;
  return next;
}
```

- [ ] **Step 4: Run the pure tests** — Expected: 7 passing.

- [ ] **Step 5: Write the failing command tests (append to test/job.test.mjs)**

```js
import { tmpDir, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { readJob, jobFileExists, writeJobFile } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";

function project() {
  const root = tmpDir("sf-proj-");
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } });
  return root;
}
const run = (root, args) => { const out = [], err = []; return main(args, { cwd: root, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }).then((code) => ({ code, out: out.join(""), err: err.join("") })); };

test("job cmd: add, set, approve path with its refusal", async () => {
  const root = project(); const c = loadConfig(root);
  let r = await run(root, ["job", "add", "milestone", "M1 thing"]);
  assert.equal(r.code, 0); assert.match(r.out, /m-1 backlog/);
  r = await run(root, ["job", "set", "m-1", "planning"]); assert.equal(r.code, 0);
  r = await run(root, ["job", "set", "m-1", "awaiting-approval"]); assert.equal(r.code, 0);
  r = await run(root, ["job", "set", "m-1", "building"]);
  assert.equal(r.code, 2); assert.match(r.err, /APPROVAL_REQUIRED/);
  r = await run(root, ["job", "approve", "m-1", "--by", "board"]);
  assert.equal(r.code, 0);
  assert.equal(readJob(c, "m-1").stage, "building");
  assert.equal(jobFileExists(c, "m-1", "plan/approval.md"), true);
  assert.equal(readJob(c, "m-1").history.at(-1).by, "board");
});

test("job cmd: park, answer requires the answer file, parallel yes/no", async () => {
  const root = project(); const c = loadConfig(root);
  await run(root, ["job", "add", "fix", "small"]);
  await run(root, ["job", "set", "f-1", "planning"]);
  await run(root, ["job", "set", "f-1", "building"]);
  let r = await run(root, ["job", "park", "f-1", "--reason", "D6 question"]);
  assert.equal(r.code, 0); assert.equal(readJob(c, "f-1").stage, "decision-needed");
  assert.equal(jobFileExists(c, "f-1", "decisions/1.md"), true);
  r = await run(root, ["job", "answer", "f-1"]);
  assert.equal(r.code, 2); assert.match(r.err, /ANSWER_REQUIRED/);
  writeJobFile(c, "f-1", "decisions/1-answer.md", "go with B\n");
  r = await run(root, ["job", "answer", "f-1", "--by", "board"]);
  assert.equal(r.code, 0); assert.equal(readJob(c, "f-1").stage, "building");

  await run(root, ["job", "add", "milestone", "M2"]);
  r = await run(root, ["job", "park", "m-1", "--reason", "parallel check passed", "--pending", "parallel"]);
  assert.equal(r.code, 0);
  r = await run(root, ["job", "parallel", "m-1", "--no"]);
  assert.equal(r.code, 0); assert.equal(readJob(c, "m-1").stage, "backlog"); assert.equal(readJob(c, "m-1").parallel, "queued");
  r = await run(root, ["job", "parallel", "m-1", "--yes"]);
  assert.equal(r.code, 2); assert.match(r.err, /ILLEGAL_TRANSITION/);
});

test("job cmd: stop/resume, merged, rework writes notes, list and show", async () => {
  const root = project(); const c = loadConfig(root);
  await run(root, ["job", "add", "fix", "x"]);
  for (const s of ["planning", "building", "reviewing", "verifying", "pushing", "pushed"]) await run(root, ["job", "set", "f-1", s]);
  let r = await run(root, ["job", "rework", "f-1", "--notes", "keep the query client out of it"]);
  assert.equal(r.code, 0); assert.equal(readJob(c, "f-1").stage, "building");
  assert.equal(jobFileExists(c, "f-1", "rework/1.md"), true);
  r = await run(root, ["job", "stop", "f-1", "--reason", "usage limit"]); assert.equal(readJob(c, "f-1").stage, "stopped");
  r = await run(root, ["job", "resume", "f-1"]); assert.equal(readJob(c, "f-1").stage, "building");
  for (const s of ["reviewing", "verifying", "pushing", "pushed"]) await run(root, ["job", "set", "f-1", s]);
  r = await run(root, ["job", "merged", "f-1"]); assert.equal(readJob(c, "f-1").stage, "merged");
  r = await run(root, ["job", "list"]); assert.match(r.out, /f-1\s+merged/);
  r = await run(root, ["job", "show", "f-1", "--json"]); assert.equal(JSON.parse(r.out).id, "f-1");
});
```

- [ ] **Step 6: Write src/commands/job.mjs**

```js
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { readJob, writeJob, nextId, listJobs, writeJobFile, jobFileExists, readJobFile } from "../store.mjs";
import { newJob, transition, park, release, stop, resume } from "../job.mjs";
import { fail } from "../errors.mjs";

const ctx = (io) => { const root = findRepoRoot(io.cwd); return { root, c: loadConfig(root) }; };
const done = (io, job, flags) => { io.stdout(flags.json ? JSON.stringify(job, null, 2) + "\n" : `${job.id} ${job.stage}\n`); return 0; };
const by = (flags) => (typeof flags.by === "string" ? flags.by : "session");
const nextDecisionNo = (c, id) => { let k = 1; while (jobFileExists(c, id, `decisions/${k}.md`)) k++; return k; };

const sub = {
  add(p, f, io) {
    const { c } = ctx(io);
    const [kind, ...title] = p;
    if (!kind || !title.length) fail("BAD_ARGS", 'usage: sfactory job add <milestone|fix> "<title>"');
    const job = newJob({ id: nextId(c, kind), kind, title: title.join(" ") });
    return done(io, writeJob(c, job), f);
  },
  set(p, f, io) {
    const { c } = ctx(io);
    const [id, to] = p;
    const job = readJob(c, id);
    if (job.stage === "awaiting-approval") fail("APPROVAL_REQUIRED", `${id} leaves awaiting-approval only through "sfactory job approve"`);
    return done(io, writeJob(c, transition(job, to, { by: by(f), reason: f.reason ?? null })), f);
  },
  approve(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (job.stage !== "awaiting-approval") fail("ILLEGAL_TRANSITION", `${job.id} is ${job.stage}, not awaiting-approval`);
    writeJobFile(c, job.id, "plan/approval.md", `approved by ${by(f)} at ${new Date().toISOString()}\n`);
    return done(io, writeJob(c, transition(job, "building", { by: by(f), reason: "approved" })), f);
  },
  park(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (typeof f.reason !== "string") fail("BAD_ARGS", "park needs --reason");
    const k = nextDecisionNo(c, job.id);
    writeJobFile(c, job.id, `decisions/${k}.md`, `# Decision ${k}\n\n${f.reason}\n\nWrite the answer to decisions/${k}-answer.md, then run: sfactory job answer ${job.id}\n`);
    return done(io, writeJob(c, park(job, { by: by(f), reason: f.reason, pending: f.pending === "parallel" ? "parallel" : "decision" })), f);
  },
  answer(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (job.stage !== "decision-needed" || job.pending !== "decision") fail("ILLEGAL_TRANSITION", `${job.id} is not waiting for a decision`);
    const k = nextDecisionNo(c, job.id) - 1;
    if (!readJobFile(c, job.id, `decisions/${k}-answer.md`)?.trim()) fail("ANSWER_REQUIRED", `write decisions/${k}-answer.md first`);
    return done(io, writeJob(c, release(job, { by: by(f) })), f);
  },
  parallel(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (job.stage !== "decision-needed" || job.pending !== "parallel") fail("ILLEGAL_TRANSITION", `${job.id} is not a parallel proposal`);
    if (f.yes === f.no) fail("BAD_ARGS", "parallel needs --yes or --no");
    const next = release(job, { by: by(f) });
    next.parallel = f.yes ? "approved" : "queued";
    return done(io, writeJob(c, next), f);
  },
  stop(p, f, io) { const { c } = ctx(io); return done(io, writeJob(c, stop(readJob(c, p[0]), { by: by(f), reason: f.reason ?? "stopped" })), f); },
  resume(p, f, io) { const { c } = ctx(io); return done(io, writeJob(c, resume(readJob(c, p[0]), { by: by(f) })), f); },
  merged(p, f, io) { const { c } = ctx(io); return done(io, writeJob(c, transition(readJob(c, p[0]), "merged", { by: by(f), reason: "merged" })), f); },
  rework(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (typeof f.notes !== "string") fail("BAD_ARGS", "rework needs --notes");
    const next = transition(job, "building", { by: by(f), reason: "rework" });
    writeJobFile(c, job.id, `rework/${next.rework}.md`, `# Rework ${next.rework}\n\n${f.notes}\n`);
    return done(io, writeJob(c, next), f);
  },
  show(p, f, io) { const { c } = ctx(io); return done(io, readJob(c, p[0]), { json: true }); },
  list(p, f, io) {
    const { c } = ctx(io);
    const jobs = listJobs(c);
    io.stdout(f.json ? JSON.stringify(jobs, null, 2) + "\n" : jobs.map((j) => `${j.id.padEnd(6)} ${j.stage.padEnd(18)} ${j.kind.padEnd(9)} ${j.title}\n`).join(""));
    return 0;
  },
};

register("job", async ({ positional, flags }, io) => {
  const [name, ...rest] = positional;
  const fn = sub[name];
  if (!fn) fail("UNKNOWN_COMMAND", `job ${name ?? ""}; one of ${Object.keys(sub).join(", ")}`);
  return fn(rest, flags, io);
});
```

In `src/cli.mjs`, replace the commented import with `import("./commands/job.mjs"),`.

- [ ] **Step 7: Run every test** — `node --test test/` — Expected: all passing (cli 2, config 5, store 5, job 10).

- [ ] **Step 8: Commit**

```bash
git add src/job.mjs src/commands/job.mjs src/cli.mjs test/job.test.mjs
git commit -m "feat: job state machine with park, stop and the job command"
```

---

### Task 5: File locks

**Files:**
- Create: `src/lock.mjs`, `src/commands/lock.mjs`, `test/lock.test.mjs`
- Modify: `src/cli.mjs` (add the import)

**Interfaces:**
- Produces: `acquire(config, name, { holder, waitMs = 0, pollMs = 500, staleMs = config.limits.lockStaleMs }) -> Promise<Lock>` where `Lock = { name, path, holder, pid, since, release() }`; throws `LOCK_HELD` with the holder's name after `waitMs`; a lock whose `pid` is not alive, or older than `staleMs`, is taken over and the takeover written to the new lock as `tookOverFrom`. `release(config, name, { holder })` (refuses another holder's lock: `NOT_HOLDER`). `status(config, name) -> { held, holder, pid, since } `. `withLock(config, name, opts, fn)`. Lock files: `<stateDir>/locks/<name>.lock` (names sanitised like slugs), JSON body.
- CLI: `sfactory lock acquire <name> --holder <id> [--wait ms]`, `sfactory lock release <name> --holder <id>`, `sfactory lock status <name>`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { acquire, release, status, withLock } from "../src/lock.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-lock-"), limits: { lockStaleMs: 3_600_000 } });

test("lock: acquire, status, release", async () => {
  const c = cfg();
  const l = await acquire(c, "suite", { holder: "m-1" });
  assert.equal(status(c, "suite").held, true);
  assert.equal(status(c, "suite").holder, "m-1");
  l.release();
  assert.equal(status(c, "suite").held, false);
});

test("lock: a second holder is refused with the first's name, and waits if asked", async () => {
  const c = cfg();
  const l = await acquire(c, "suite", { holder: "m-1" });
  await assert.rejects(acquire(c, "suite", { holder: "m-2" }), (e) => e.code === "LOCK_HELD" && /m-1/.test(e.message));
  setTimeout(() => l.release(), 300);
  const l2 = await acquire(c, "suite", { holder: "m-2", waitMs: 5000, pollMs: 50 });
  assert.equal(l2.holder, "m-2");
  l2.release();
});

test("lock: a dead pid's lock is taken over and recorded", async () => {
  const c = cfg();
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  writeFileSync(join(c.stateDir, "locks", "live.lock"), JSON.stringify({ holder: "ghost", pid: 999999, since: new Date().toISOString() }));
  const l = await acquire(c, "live", { holder: "m-3" });
  assert.equal(l.tookOverFrom, "ghost");
  l.release();
});

test("lock: release by a non-holder is NOT_HOLDER; withLock releases on throw", async () => {
  const c = cfg();
  const l = await acquire(c, "commit", { holder: "a" });
  assert.throws(() => release(c, "commit", { holder: "b" }), (e) => e.code === "NOT_HOLDER");
  l.release();
  await assert.rejects(withLock(c, "commit", { holder: "a" }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(status(c, "commit").held, false);
});
```

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Write src/lock.mjs**

```js
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.mjs";
import { slugify } from "./store.mjs";

const lockPath = (c, name) => join(c.stateDir, "locks", `${slugify(name)}.lock`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function read(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }

export function status(c, name) {
  const p = lockPath(c, name);
  const body = existsSync(p) ? read(p) : null;
  return body ? { held: true, ...body } : { held: false };
}

function tryCreate(path, body) {
  let fd;
  try { fd = openSync(path, "wx"); } catch (e) { if (e.code === "EEXIST") return false; throw e; }
  writeSync(fd, JSON.stringify(body, null, 2)); closeSync(fd); return true;
}

export async function acquire(c, name, { holder, waitMs = 0, pollMs = 500, staleMs = c.limits?.lockStaleMs ?? 3_600_000 } = {}) {
  if (!holder) fail("BAD_ARGS", "acquire needs a holder");
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  const path = lockPath(c, name);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const body = { name, holder, pid: process.pid, since: new Date().toISOString() };
    const cur = existsSync(path) ? read(path) : null;
    if (cur) {
      const stale = !alive(cur.pid) || Date.now() - Date.parse(cur.since) > staleMs;
      if (stale) { body.tookOverFrom = cur.holder; try { unlinkSync(path); } catch {} }
    }
    if (tryCreate(path, body)) return { ...body, path, release: () => release(c, name, { holder }) };
    if (Date.now() >= deadline) { const h = read(path); fail("LOCK_HELD", `${name} is held by ${h?.holder ?? "unknown"} since ${h?.since ?? "?"}`); }
    await sleep(pollMs);
  }
}

export function release(c, name, { holder }) {
  const path = lockPath(c, name);
  const cur = existsSync(path) ? read(path) : null;
  if (!cur) return false;
  if (cur.holder !== holder) fail("NOT_HOLDER", `${name} is held by ${cur.holder}, not ${holder}`);
  unlinkSync(path);
  return true;
}

export async function withLock(c, name, opts, fn) {
  const l = await acquire(c, name, opts);
  try { return await fn(l); } finally { try { l.release(); } catch {} }
}
```

- [ ] **Step 4: Write src/commands/lock.mjs**

```js
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { acquire, release, status } from "../lock.mjs";
import { fail } from "../errors.mjs";

register("lock", async ({ positional: [verb, name], flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (!name) fail("BAD_ARGS", "usage: sfactory lock <acquire|release|status> <name> [--holder id] [--wait ms]");
  if (verb === "status") { io.stdout(JSON.stringify(status(c, name)) + "\n"); return 0; }
  if (verb === "acquire") { const l = await acquire(c, name, { holder: flags.holder, waitMs: Number(flags.wait ?? 0) }); io.stdout(`${name} acquired by ${l.holder}${l.tookOverFrom ? ` (took over from ${l.tookOverFrom})` : ""}\n`); return 0; }
  if (verb === "release") { io.stdout(release(c, name, { holder: flags.holder }) ? `${name} released\n` : `${name} was not held\n`); return 0; }
  fail("UNKNOWN_COMMAND", `lock ${verb}`);
});
```

Add `import("./commands/lock.mjs"),` to `src/cli.mjs`.

- [ ] **Step 5: Run every test** — all passing.

- [ ] **Step 6: Commit**

```bash
git add src/lock.mjs src/commands/lock.mjs src/cli.mjs test/lock.test.mjs
git commit -m "feat: file locks with stale takeover and the lock command"
```

#### Revision after review (controller, 2026-10-27) — this block supersedes the code above where they differ

The task review probed the brief's lock with concurrent processes and found two Critical holes, both in the design: a lock acquired through the CLI records the short-lived CLI process's pid, so the next acquirer judges it dead and takes it over at once; and the stale takeover (unlink, then create) lets every waiter that read the stale file win together (5 to 8 holders in every probe round). Three Important gaps followed: an empty or half-written lock file reads as free but can never be taken, a non-numeric `--wait` waits for ever, and `release` matches on the holder's name alone. The revised design:

**Lock body** `{ name, holder, token, pid, since }`. `token` is `crypto.randomUUID()` per acquire and is what proves ownership. `pid` is the owner process's pid **only when the owner outlives the lock**: library callers pass nothing and get `process.pid`; the CLI records `pid: null` unless `--pid <n>` names a long-lived owner. A lock with `pid: null` is judged stale by age alone.

**Staleness** (`isStale(body, now, staleMs)`): `pid` not null and not alive (`process.kill(pid, 0)` throws anything but `EPERM`), or `now - Date.parse(since) > staleMs`. An unparseable or empty file whose mtime is older than `GRACE_MS = 5000` is stale too (a crashed writer); younger, it is "being written" and counts as held by `unknown`.

**Atomic takeover**: never unlink-then-create. To take a stale lock, `renameSync(path, path + ".stale-" + randomUUID())`; only one process's rename succeeds (the others get `ENOENT` and loop); read the moved file, confirm it is still the body you judged stale (same `since` and `token`, or unparseable) — if it is not, rename it back and loop; `unlinkSync` the moved file; then `wx`-create as usual. If the create loses to another creator, loop. Record `tookOverFrom` from the moved body's holder.

**Create**: `openSync(path, "wx")` then `writeSync` the whole body in one call then `closeSync` (the half-written window is covered by `GRACE_MS`).

**Release** `release(c, name, { holder, token })`: `renameSync(path, path + ".rel-" + randomUUID())`; read it; if `holder` and `token` both match, unlink it and return `true`; otherwise rename it back and `fail("NOT_HOLDER", …)` naming the actual holder. A missing file returns `false`. The `Lock` object's `release()` carries its own token.

**withLock**: releases in `finally`; if `fn` succeeded and the release throws, the release error propagates; if `fn` threw, the release error is logged to `console.error` and `fn`'s error propagates.

**waitMs guard**: `acquire` fails `BAD_ARGS` unless `waitMs` is a finite integer ≥ 0; the CLI validates `--wait` the same way before calling (a bare `--wait` is `true` and is refused), and accepts `--pid <n>` (integer ≥ 1) and `--stale-ms <n>`.

**status** answers `{ held: true, holder, pid, since, token: undefined, stale: boolean }` (the token is never printed), `{ held: true, holder: "unknown", corrupt: true, stale }` for an unparseable file, or `{ held: false }`.

**CLI** `sfactory lock acquire <name> --holder <id> [--wait ms] [--pid n] [--stale-ms n]` prints `<name> acquired by <holder> token <token>[ (took over from X)]`; `sfactory lock release <name> --holder <id> --token <t>`; `sfactory lock status <name>`.

**Tests to add** (keep the brief's four, adapted to the token API): (a) a two-process takeover test — write a dead-pid lock, spawn 6 child `node` processes (a small inline script via `-e` or a helper under `test/fixtures/`) that each call `acquire` with `waitMs: 0` and print `GOT` or `HELD`, wait for all, assert exactly one `GOT`; bounded by a 10 s timeout, children confirmed exited; (b) `release` with the right holder but wrong token → `NOT_HOLDER` and the file stays; (c) an empty lock file older than `GRACE_MS` (set its mtime back with `utimesSync`) is taken over; a fresh empty file makes `acquire` fail `LOCK_HELD` naming `unknown`; (d) `acquire(c, "x", { holder: "a", waitMs: "abc" })` → `BAD_ARGS`; (e) the waiting test asserts it waited at least 250 ms; (f) a CLI-acquired lock (`pid: null`) is not taken over by a second acquire within `staleMs`, proving the pid-null path is age-based; (g) `withLock` rethrows a release failure after `fn` succeeded.

Deferred as recorded in the ledger: age-based takeover of a live holder past `lockStaleMs`; `slugify` collisions on long lock names; the pid-reuse window on Windows.
---

### Task 6: Git helpers and worktree cut/remove

**Files:**
- Create: `src/git.mjs`, `src/worktree.mjs`, `src/commands/worktree.mjs`, `test/git.test.mjs`, `test/worktree.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- `src/git.mjs`: `git(args, { cwd }) -> string` (stdout trimmed; throws `GIT_FAILED` with stderr); `isClean(cwd) -> boolean`; `currentBranch(cwd)`; `headOf(cwd, ref) -> sha`; `branchExists(cwd, name)`; `newestBranch(cwd, prefix) -> name | null` (by committer date, local branches only); `worktrees(cwd) -> [{ path, head, branch }]` (from `--porcelain`); `worktreeOfBranch(cwd, branch) -> path | null`; `branchContains(cwd, branch, sha) -> boolean`; `fetch(cwd, remote = "origin")`; `remoteHead(cwd, branch) -> sha | null`.
- `src/worktree.mjs`: `resolveBase(config) -> { branch, head }` by `baseRule` (`newest-feature-branch` → newest `branchPrefix*` else integration; `integration-branch` → `integrationBranch` or the first of `development`, `develop`, `main`, `master` that exists; any other string → that branch); `cut(config, job, { slug }) -> Job` (refuses `WORKTREE_IS_MAIN_CHECKOUT`, `WORKTREE_LOCKED` by a foreign holder, `BASE_MOVED` if head differs after the add; creates `<worktrees.dir>/<slug>`, branch `<branchPrefix><slug>`, runs `afterCut` commands with `shell: true`, copies `copyFromBase` files from the base branch's worktree when it has one, acquires lock `worktree:<slug>` with holder `job.id`, returns the job with `branch`, `base: { branch, head }`, `worktree`); `remove(config, job)` (releases the lock, `git worktree remove`, keeps the branch).
- CLI: `sfactory worktree cut <id> [--slug s]`, `sfactory worktree remove <id>`, `sfactory worktree base` (prints the resolved base).

- [ ] **Step 1: Write the failing git tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, sh } from "./helpers.mjs";
import { git, isClean, currentBranch, headOf, newestBranch, worktrees, worktreeOfBranch, branchContains } from "../src/git.mjs";

test("git: basics on a temp repo", () => {
  const r = tmpRepo();
  assert.equal(currentBranch(r), "main");
  assert.equal(isClean(r), true);
  writeFileSync(join(r, "a.txt"), "a");
  assert.equal(isClean(r), false);
  assert.match(headOf(r, "main"), /^[0-9a-f]{40}$/);
  assert.throws(() => git(["rev-parse", "nope-ref"], { cwd: r }), (e) => e.code === "GIT_FAILED");
});

test("git: newestBranch by committer date, worktrees, branchContains", () => {
  const r = tmpRepo();
  sh("git", ["checkout", "-q", "-b", "feature/old"], r);
  writeFileSync(join(r, "o.txt"), "o"); sh("git", ["add", "o.txt"], r);
  sh("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "old", "--date", "2026-01-01T00:00:00Z"], r);
  sh("git", ["checkout", "-q", "-b", "feature/new"], r);
  writeFileSync(join(r, "n.txt"), "n"); sh("git", ["add", "n.txt"], r);
  sh("git", ["commit", "-q", "-m", "new"], r);
  sh("git", ["checkout", "-q", "main"], r);
  assert.equal(newestBranch(r, "feature/"), "feature/new");
  assert.equal(newestBranch(r, "zzz/"), null);
  const wt = join(r, "..", "wt-" + Date.now());
  sh("git", ["worktree", "add", "-q", wt, "feature/old"], r);
  assert.equal(worktreeOfBranch(r, "feature/old"), require_resolve(wt));
  assert.ok(worktrees(r).some((w) => w.branch === "main"));
  assert.equal(branchContains(r, "feature/new", headOf(r, "feature/old")), true);
  assert.equal(branchContains(r, "feature/old", headOf(r, "feature/new")), false);
});
import { resolve as require_resolve } from "node:path";
```

(The `newestBranch` test sets `GIT_COMMITTER_DATE` for the old commit; add `env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" }` to that one `sh` call by giving `sh` an optional fourth `env` argument in `test/helpers.mjs`.)

- [ ] **Step 2: Write src/git.mjs**

```js
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fail } from "./errors.mjs";

export function git(args, { cwd, allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) fail("GIT_FAILED", `git not runnable: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail("GIT_FAILED", `git ${args.join(" ")} (in ${cwd}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}
export const isClean = (cwd) => git(["status", "--porcelain"], { cwd }) === "";
export const currentBranch = (cwd) => git(["branch", "--show-current"], { cwd });
export const headOf = (cwd, ref) => git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
export const branchExists = (cwd, name) => spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd }).status === 0;
export function newestBranch(cwd, prefix) {
  const out = git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", `refs/heads/${prefix}`], { cwd });
  return out.split("\n").filter(Boolean)[0] ?? null;
}
export function worktrees(cwd) {
  const out = git(["worktree", "list", "--porcelain"], { cwd });
  const list = []; let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: resolve(line.slice(9)), head: null, branch: null }; list.push(cur); }
    else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return list;
}
export const worktreeOfBranch = (cwd, branch) => worktrees(cwd).find((w) => w.branch === branch)?.path ?? null;
export const branchContains = (cwd, branch, sha) => spawnSync("git", ["merge-base", "--is-ancestor", sha, branch], { cwd }).status === 0;
export const fetch = (cwd, remote = "origin") => git(["fetch", "--quiet", remote], { cwd });
export function remoteHead(cwd, branch, remote = "origin") {
  const r = spawnSync("git", ["rev-parse", "--verify", `${remote}/${branch}^{commit}`], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
```

- [ ] **Step 3: Run the git tests** — passing.

- [ ] **Step 4: Write the failing worktree tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, writeConfig, sh } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { newJob } from "../src/job.mjs";
import { resolveBase, cut, remove } from "../src/worktree.mjs";
import { status } from "../src/lock.mjs";
import { worktrees } from "../src/git.mjs";

function setup(extra = {}) {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: tmpDir("sf-st-"), worktrees: { dir: tmpDir("sf-wt-"), ...extra } });
  return { root, c: loadConfig(root) };
}

test("worktree: resolveBase by rule", () => {
  const { root, c } = setup();
  assert.deepEqual(resolveBase(c).branch, "main");
  sh("git", ["branch", "feature/one"], root);
  const c2 = loadConfig(root); c2.worktrees.baseRule = "newest-feature-branch";
  assert.equal(resolveBase(c2).branch, "feature/one");
  const c3 = loadConfig(root); c3.worktrees.baseRule = "main";
  assert.equal(resolveBase(c3).branch, "main");
});

test("worktree: cut creates the worktree and branch, records base, runs afterCut, copies files, locks; remove undoes it", () => {
  const { root, c } = setup({ afterCut: ["node -e \"require('fs').writeFileSync('after.txt','ran')\""], copyFromBase: [".env"] });
  writeFileSync(join(root, ".env"), "SECRET=1\n");   // untracked in the base's worktree (the main checkout)
  const job = cut(c, newJob({ id: "m-1", kind: "milestone", title: "Feed moderation" }), {});
  assert.equal(job.branch, "feature/feed-moderation");
  assert.equal(job.worktree, join(c.worktrees.dir, "feed-moderation"));
  assert.ok(existsSync(join(job.worktree, "README.md")));
  assert.equal(readFileSync(join(job.worktree, "after.txt"), "utf8"), "ran");
  assert.equal(readFileSync(join(job.worktree, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(job.base.branch, "main");
  assert.match(job.base.head, /^[0-9a-f]{40}$/);
  assert.equal(status(c, "worktree:feed-moderation").holder, "m-1");
  assert.ok(worktrees(root).some((w) => w.branch === "feature/feed-moderation"));
  remove(c, job);
  assert.equal(existsSync(job.worktree), false);
  assert.equal(status(c, "worktree:feed-moderation").held, false);
});

test("worktree: refuses the main checkout and a foreign lock", async () => {
  const { root, c } = setup();
  c.worktrees.dir = root;
  assert.throws(() => cut(c, newJob({ id: "m-1", kind: "milestone", title: "x" }), { slug: "" }), (e) => e.code === "WORKTREE_IS_MAIN_CHECKOUT");
  const { c: c2 } = setup();
  const { acquire } = await import("../src/lock.mjs");
  const l = await acquire(c2, "worktree:x", { holder: "someone-else" });
  assert.throws(() => cut(c2, newJob({ id: "m-2", kind: "milestone", title: "x" }), {}), (e) => e.code === "WORKTREE_LOCKED" && /someone-else/.test(e.message));
  l.release();
});
```

- [ ] **Step 5: Write src/worktree.mjs**

```js
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { git, headOf, branchExists, newestBranch, worktreeOfBranch } from "./git.mjs";
import { slugify } from "./store.mjs";
import { status, release } from "./lock.mjs";
import { openSync, writeSync, closeSync } from "node:fs";

export function resolveBase(c) {
  const cwd = c.repoRoot;
  const rule = c.worktrees.baseRule;
  let branch;
  if (rule === "newest-feature-branch") branch = newestBranch(cwd, c.worktrees.branchPrefix) ?? integration(c);
  else if (rule === "integration-branch") branch = integration(c);
  else branch = rule;
  if (!branchExists(cwd, branch)) fail("BASE_NOT_FOUND", `base branch ${branch} does not exist`);
  return { branch, head: headOf(cwd, branch) };
}
function integration(c) {
  if (c.worktrees.integrationBranch) return c.worktrees.integrationBranch;
  return ["development", "develop", "main", "master"].find((b) => branchExists(c.repoRoot, b)) ?? "main";
}

/** Synchronous lock take, same file format as lock.mjs, because cut() is sync. */
function takeLockSync(c, name, holder) {
  const s = status(c, name);
  if (s.held && s.holder !== holder) fail("WORKTREE_LOCKED", `${name} is locked by ${s.holder} since ${s.since}`);
  if (s.held) return;
  const dir = join(c.stateDir, "locks"); mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${slugify(name)}.lock`), "wx");
  writeSync(fd, JSON.stringify({ name, holder, pid: process.pid, since: new Date().toISOString() }, null, 2)); closeSync(fd);
}

export function cut(c, job, { slug } = {}) {
  const s = slug || slugify(job.title.replace(/^M\d+\s+/i, ""));
  if (!s) fail("BAD_ARGS", "cannot derive a slug from the title; pass --slug");
  const dir = resolve(c.worktrees.dir, s);
  if (dir === resolve(c.repoRoot) || resolve(c.worktrees.dir) === resolve(c.repoRoot)) fail("WORKTREE_IS_MAIN_CHECKOUT", `worktrees.dir must not be the main checkout (${c.repoRoot})`);
  const lockName = `worktree:${s}`;
  takeLockSync(c, lockName, job.id);
  const branch = `${c.worktrees.branchPrefix}${s}`;
  if (branchExists(c.repoRoot, branch)) fail("BRANCH_EXISTS", `${branch} already exists`);
  const base = resolveBase(c);
  mkdirSync(dirname(dir), { recursive: true });
  git(["worktree", "add", "-b", branch, dir, base.head], { cwd: c.repoRoot });
  const after = headOf(c.repoRoot, base.branch);
  if (after !== base.head) fail("BASE_MOVED", `${base.branch} moved from ${base.head} to ${after} during the cut; re-run`);
  const baseDir = worktreeOfBranch(c.repoRoot, base.branch);
  for (const rel of c.worktrees.copyFromBase) {
    const from = baseDir ? join(baseDir, rel) : null;
    if (from && existsSync(from) && !existsSync(join(dir, rel))) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); copyFileSync(from, join(dir, rel)); }
  }
  for (const cmd of c.worktrees.afterCut) {
    const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) fail("AFTER_CUT_FAILED", `${cmd} exited ${r.status} in ${dir}:\n${r.stderr.slice(-2000)}`);
  }
  return { ...job, branch, base, worktree: dir };
}

export function remove(c, job) {
  if (!job.worktree) fail("BAD_ARGS", `${job.id} has no worktree`);
  git(["worktree", "remove", "--force", job.worktree], { cwd: c.repoRoot });
  const s = slugify(job.worktree.split(/[\\/]/).pop());
  try { release(c, `worktree:${s}`, { holder: job.id }); } catch {}
  return { ...job, worktree: null };
}
```

- [ ] **Step 6: Write src/commands/worktree.mjs**

```js
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { readJob, writeJob } from "../store.mjs";
import { cut, remove, resolveBase } from "../worktree.mjs";
import { fail } from "../errors.mjs";

register("worktree", async ({ positional: [verb, id], flags }, io) => {
  const c = loadConfig(findRepoRoot(io.cwd));
  if (verb === "base") { const b = resolveBase(c); io.stdout(`${b.branch} ${b.head}\n`); return 0; }
  if (!id) fail("BAD_ARGS", "usage: sfactory worktree <cut|remove> <id> [--slug s] | sfactory worktree base");
  const job = readJob(c, id);
  if (verb === "cut") { const j = writeJob(c, cut(c, job, { slug: flags.slug })); io.stdout(`${j.id} ${j.branch} ${j.worktree} (base ${j.base.branch} ${j.base.head.slice(0, 7)})\n`); return 0; }
  if (verb === "remove") { writeJob(c, remove(c, job)); io.stdout(`${id} worktree removed\n`); return 0; }
  fail("UNKNOWN_COMMAND", `worktree ${verb}`);
});
```

Note: `writeJob` is called here with a job produced by `cut`, not by `job.mjs`. That is the one sanctioned exception to "only job.mjs writes": `cut` changes no stage and appends no history, and the worktree fields belong to it. Record this in a comment above the import.

Add the import to `src/cli.mjs`.

- [ ] **Step 7: Run all tests** — passing. On Windows the `remove` test needs the worktree dir not to be the process cwd; the tests never `chdir`, so it is fine.

- [ ] **Step 8: Commit**

```bash
git add src/git.mjs src/worktree.mjs src/commands/worktree.mjs src/cli.mjs test/helpers.mjs test/git.test.mjs test/worktree.test.mjs
git commit -m "feat: git helpers, worktree cut and remove with base resolution and locks"
```

---

### Task 7: Port blocks

**Files:**
- Create: `src/ports.mjs`, `src/commands/ports.mjs`, `test/ports.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- `isFree(port) -> Promise<boolean>` (tries `net.createServer().listen(port, "127.0.0.1")`); `allocate(config, jobId) -> Promise<{ block, ...names }>`: the first block `base + k*step` (k ≥ 0, k < 100) whose base is not held by another job in `listJobs` and whose every named port is free; throws `NO_PORTS`. The job's `ports` field is set by the caller (`commands/ports.mjs` writes it, same exception as worktree). `substitute(template, ports)` replaces `{port.<name>}` in strings (used by Plan C's services).
- CLI: `sfactory ports allocate <id>` prints `api=4100 web=4101`; `sfactory ports free <port>` exits 0/1.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { tmpDir } from "./helpers.mjs";
import { allocate, isFree, substitute } from "../src/ports.mjs";
import { writeJob } from "../src/store.mjs";

const cfg = (base) => ({ stateDir: tmpDir("sf-ports-"), ports: { base, step: 10, names: ["api", "web"] } });

test("ports: allocate skips a block held by another job and a block whose port is busy", async () => {
  const c = cfg(47100);
  writeJob(c, { id: "m-1", kind: "milestone", title: "a", stage: "building", started: "2026-01-01T00:00:00Z", history: [], ports: { block: 47100, api: 47100, web: 47101 } });
  const srv = createServer(); await new Promise((r) => srv.listen(47111, "127.0.0.1", r));
  try {
    const p = await allocate(c, "m-2");
    assert.deepEqual(p, { block: 47120, api: 47120, web: 47121 });
  } finally { srv.close(); }
});

test("ports: isFree and substitute", async () => {
  assert.equal(await isFree(0), true);
  assert.equal(substitute("http://localhost:{port.api}/x {port.web}", { api: 4100, web: 4102 }), "http://localhost:4100/x 4102");
});
```

- [ ] **Step 2: Write src/ports.mjs**

```js
import { createServer } from "node:net";
import { fail } from "./errors.mjs";
import { listJobs } from "./store.mjs";

export function isFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}
export async function allocate(c, jobId) {
  const { base, step, names } = c.ports;
  const held = new Set(listJobs(c).filter((j) => j.id !== jobId && j.ports && j.stage !== "merged").map((j) => j.ports.block));
  for (let k = 0; k < 100; k++) {
    const block = base + k * step;
    if (held.has(block)) continue;
    const ports = { block };
    let ok = true;
    for (let i = 0; i < names.length; i++) { ports[names[i]] = block + i; if (!(await isFree(block + i))) { ok = false; break; } }
    if (ok) return ports;
  }
  fail("NO_PORTS", `no free port block from ${base} in steps of ${step}`);
}
export const substitute = (s, ports) => String(s).replace(/\{port\.([a-z0-9_-]+)\}/gi, (_, n) => (ports[n] != null ? String(ports[n]) : `{port.${n}}`));
```

- [ ] **Step 3: Write src/commands/ports.mjs** (allocate writes `job.ports`; free prints and exits 0/1). Add the import to `cli.mjs`.

- [ ] **Step 4: Run tests; commit**

```bash
git add src/ports.mjs src/commands/ports.mjs src/cli.mjs test/ports.test.mjs
git commit -m "feat: per-card port blocks"
```

---

### Task 8: Commit and push with their refusals

**Files:**
- Create: `src/commit.mjs`, `src/push.mjs`, `src/commands/commit.mjs`, `src/commands/push.mjs`, `test/commit.test.mjs`, `test/push.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- `hasTrailers(message) -> string[]` (trailer lines in the final paragraph matching `/^[A-Za-z][A-Za-z-]*: \S/`); `assertNamedPaths(paths)` (throws `UNNAMED_PATHS` for empty, `.`, `-A`, `--all`, `*`, or a path containing `*`); `commit(config, { cwd, paths, message, holder }) -> sha` under the `commit` lock; refuses trailers when `git.trailers` is false (`TRAILER_REFUSED`), unnamed paths when `git.namedPathsOnly`, and a stash (there is no stash path at all; `commit` never calls stash). Sets no author; uses the repo's git config.
- `push(config, { cwd, holder }) -> { branch, remoteHead }`: refuses `git.push === false` (`PUSH_DISABLED`), a branch not starting with `branchPrefix` (`BRANCH_REFUSED`), a dirty tree (`DIRTY_TREE`); runs `git push -u origin <branch>`, then `fetch` and returns `remoteHead` read from `origin/<branch>`, failing `PUSH_UNVERIFIED` if it does not equal the local head.
- CLI: `sfactory commit --cwd <dir> --holder <id> -m "<msg>" -- <path...>` (paths after `--`; extend `parseArgs` to collect everything after `--` into `flags.rest`); `sfactory push --cwd <dir> --holder <id>`.

- [ ] **Step 1: Write the failing tests**

`test/commit.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir } from "./helpers.mjs";
import { hasTrailers, assertNamedPaths, commit } from "../src/commit.mjs";
import { git, isClean } from "../src/git.mjs";

const cfg = (trailers = false) => ({ stateDir: tmpDir("sf-c-"), git: { trailers, namedPathsOnly: true }, limits: { lockStaleMs: 1000 } });

test("commit: trailer detection", () => {
  assert.deepEqual(hasTrailers("feat: x\n\nbody\n\nCo-Authored-By: Someone <a@b>\nSigned-off-by: me"), ["Co-Authored-By: Someone <a@b>", "Signed-off-by: me"]);
  assert.deepEqual(hasTrailers("feat: x\n\nNote: this is prose in the body, not a trailer paragraph\nmore"), []);
  assert.deepEqual(hasTrailers("feat: x"), []);
});

test("commit: named paths only", () => {
  for (const bad of [[], ["."], ["-A"], ["--all"], ["src/*"], ["*"]]) assert.throws(() => assertNamedPaths(bad), (e) => e.code === "UNNAMED_PATHS", JSON.stringify(bad));
  assertNamedPaths(["src/a.mjs", "docs/b.md"]);
});

test("commit: commits named paths only, refuses trailers, leaves other changes unstaged", async () => {
  const r = tmpRepo();
  writeFileSync(join(r, "a.txt"), "a"); writeFileSync(join(r, "b.txt"), "b");
  await assert.rejects(commit(cfg(), { cwd: r, paths: ["a.txt"], message: "feat: a\n\nCo-Authored-By: X <x@y>", holder: "t" }), (e) => e.code === "TRAILER_REFUSED");
  const sha = await commit(cfg(), { cwd: r, paths: ["a.txt"], message: "feat: a", holder: "t" });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(git(["show", "--stat", "--format=", "HEAD"], { cwd: r }).includes("a.txt"), true);
  assert.equal(isClean(r), false);   // b.txt is still untracked
  const sha2 = await commit(cfg(true), { cwd: r, paths: ["b.txt"], message: "feat: b\n\nCo-Authored-By: X <x@y>", holder: "t" });
  assert.match(git(["log", "-1", "--format=%B"], { cwd: r }), /Co-Authored-By/);
});
```

`test/push.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, sh } from "./helpers.mjs";
import { push } from "../src/push.mjs";
import { headOf } from "../src/git.mjs";

function repoWithRemote() {
  const bare = tmpDir("sf-bare-"); sh("git", ["init", "-q", "--bare", bare]);
  const r = tmpRepo(); sh("git", ["remote", "add", "origin", bare], r); sh("git", ["push", "-q", "-u", "origin", "main"], r);
  return r;
}
const cfg = (push = true) => ({ stateDir: tmpDir("sf-p-"), git: { push }, worktrees: { branchPrefix: "feature/" } });

test("push: pushes a clean feature branch and verifies the remote head", () => {
  const r = repoWithRemote();
  sh("git", ["checkout", "-q", "-b", "feature/x"], r);
  writeFileSync(join(r, "x.txt"), "x"); sh("git", ["add", "x.txt"], r); sh("git", ["commit", "-q", "-m", "x"], r);
  const res = push(cfg(), { cwd: r, holder: "t" });
  assert.equal(res.branch, "feature/x");
  assert.equal(res.remoteHead, headOf(r, "feature/x"));
});

test("push: refusals", () => {
  const r = repoWithRemote();
  assert.throws(() => push(cfg(false), { cwd: r, holder: "t" }), (e) => e.code === "PUSH_DISABLED");
  assert.throws(() => push(cfg(), { cwd: r, holder: "t" }), (e) => e.code === "BRANCH_REFUSED");   // on main
  sh("git", ["checkout", "-q", "-b", "feature/y"], r);
  writeFileSync(join(r, "dirty.txt"), "d");
  assert.throws(() => push(cfg(), { cwd: r, holder: "t" }), (e) => e.code === "DIRTY_TREE");
});
```

- [ ] **Step 2: Write src/commit.mjs**

```js
import { fail } from "./errors.mjs";
import { git } from "./git.mjs";
import { withLock } from "./lock.mjs";

export function hasTrailers(message) {
  const paras = String(message).trim().split(/\n\s*\n/);
  if (paras.length < 2) return [];
  const last = paras.at(-1).split("\n").map((l) => l.trim()).filter(Boolean);
  const re = /^[A-Za-z][A-Za-z-]*: \S/;
  return last.every((l) => re.test(l)) ? last : [];
}
export function assertNamedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) fail("UNNAMED_PATHS", "commit needs at least one named path");
  for (const p of paths) if ([".", "-A", "--all", "*"].includes(p) || /[*?]/.test(p) || p.startsWith("-")) fail("UNNAMED_PATHS", `"${p}" is not a named path`);
}
export async function commit(c, { cwd, paths, message, holder }) {
  if (c.git.namedPathsOnly !== false) assertNamedPaths(paths);
  const trailers = hasTrailers(message);
  if (trailers.length && !c.git.trailers) fail("TRAILER_REFUSED", `trailers are off (git.trailers): ${trailers.join("; ")}`);
  if (!message?.trim()) fail("BAD_ARGS", "commit needs a message");
  return withLock(c, "commit", { holder: holder ?? "session", waitMs: 60_000 }, async () => {
    git(["add", "--", ...paths], { cwd });
    git(["commit", "--quiet", "-m", message, "--", ...paths], { cwd });
    return git(["rev-parse", "HEAD"], { cwd });
  });
}
```

- [ ] **Step 3: Write src/push.mjs**

```js
import { fail } from "./errors.mjs";
import { git, currentBranch, isClean, fetch, remoteHead, headOf } from "./git.mjs";

export function push(c, { cwd, remote = "origin" }) {
  if (c.git.push === false) fail("PUSH_DISABLED", "git.push is false in sfactory.config.json");
  const branch = currentBranch(cwd);
  if (!branch || !branch.startsWith(c.worktrees.branchPrefix)) fail("BRANCH_REFUSED", `only ${c.worktrees.branchPrefix}* branches are pushed; on "${branch || "(detached)"}"`);
  if (!isClean(cwd)) fail("DIRTY_TREE", `uncommitted changes in ${cwd}`);
  git(["push", "--quiet", "-u", remote, branch], { cwd });
  fetch(cwd, remote);
  const rh = remoteHead(cwd, branch, remote);
  const lh = headOf(cwd, branch);
  if (rh !== lh) fail("PUSH_UNVERIFIED", `${remote}/${branch} is ${rh ?? "absent"}, local is ${lh}`);
  return { branch, remoteHead: rh };
}
```

- [ ] **Step 4: Extend parseArgs for `--`** in `src/cli.mjs`: when `a === "--"`, put every remaining arg into `flags.rest` and stop. Add the test to `test/cli.test.mjs`:

```js
test("cli: parseArgs collects paths after --", () => {
  const { positional, flags } = parseArgs(["x", "--m", "msg", "--", "a.txt", "b.txt"]);
  assert.deepEqual(positional, ["x"]); assert.equal(flags.m, "msg"); assert.deepEqual(flags.rest, ["a.txt", "b.txt"]);
});
```

- [ ] **Step 5: Write the two command modules** (`commit`: reads `--cwd` (default `io.cwd`), `--holder`, `-m`/`--m`/`--message`, paths from `flags.rest`; prints the sha. `push`: prints `branch remoteHead`). Add both imports to `cli.mjs`.

- [ ] **Step 6: Run all tests; commit**

```bash
git add src/commit.mjs src/push.mjs src/commands/commit.mjs src/commands/push.mjs src/cli.mjs test/cli.test.mjs test/commit.test.mjs test/push.test.mjs
git commit -m "feat: commit and push with named-path, trailer, branch and clean-tree refusals"
```

---

### Task 9: The serialised suite runner

**Files:**
- Create: `src/suite.mjs`, `src/commands/suite.mjs`, `test/suite.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- `runSuite(config, { cwd, jobId, logPath, command = config.commands.suite }) -> Promise<{ ok, code, durationMs, tail }>`: holds the `suite` lock when `commands.suiteSerial` (waits up to `limits.suiteWaitMs`), spawns the command with `shell: true`, streams stdout and stderr into `logPath` (appending a header line `=== <iso> <command> ===`), resolves with the exit code and the last 40 lines. Never throws for a red suite; throws `LOCK_HELD` if the wait expires.
- CLI: `sfactory suite --cwd <dir> --job <id> [--log path]` (default log `<jobDir>/verify/suite-<timestamp>.log`); exit code = the suite's.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { runSuite } from "../src/suite.mjs";
import { acquire } from "../src/lock.mjs";

const cfg = (suite) => ({ stateDir: tmpDir("sf-s-"), commands: { suite, suiteSerial: true }, limits: { suiteWaitMs: 300, lockStaleMs: 60_000 } });

test("suite: green run logs and returns ok", async () => {
  const c = cfg('node -e "console.log(\'12 passing\')"');
  const log = join(tmpDir(), "suite.log");
  const r = await runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: log });
  assert.equal(r.ok, true); assert.equal(r.code, 0);
  assert.match(readFileSync(log, "utf8"), /=== .* node -e/); assert.match(r.tail, /12 passing/);
});

test("suite: red run returns ok=false with the exit code, no throw", async () => {
  const c = cfg('node -e "console.error(\'1 failing\'); process.exit(1)"');
  const r = await runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: join(tmpDir(), "s.log") });
  assert.equal(r.ok, false); assert.equal(r.code, 1); assert.match(r.tail, /1 failing/);
});

test("suite: waits for the lock and gives up with LOCK_HELD", async () => {
  const c = cfg("node -e 0");
  const l = await acquire(c, "suite", { holder: "other" });
  await assert.rejects(runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: join(tmpDir(), "s.log") }), (e) => e.code === "LOCK_HELD");
  l.release();
});
```

- [ ] **Step 2: Write src/suite.mjs**

```js
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquire } from "./lock.mjs";

function spawnToLog(command, cwd, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const out = createWriteStream(logPath, { flags: "a" });
  out.write(`=== ${new Date().toISOString()} ${command} ===\n`);
  const lines = [];
  const keep = (chunk) => { for (const l of String(chunk).split(/\r?\n/)) if (l) { lines.push(l); if (lines.length > 40) lines.shift(); } };
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    p.stdout.on("data", (d) => { out.write(d); keep(d); });
    p.stderr.on("data", (d) => { out.write(d); keep(d); });
    p.on("close", (code) => { out.end(`=== exit ${code} ===\n`); resolve({ ok: code === 0, code, durationMs: Date.now() - started, tail: lines.join("\n") }); });
  });
}

export async function runSuite(c, { cwd, jobId, logPath, command = c.commands.suite }) {
  if (!c.commands.suiteSerial) return spawnToLog(command, cwd, logPath);
  const lock = await acquire(c, "suite", { holder: jobId, waitMs: c.limits.suiteWaitMs, pollMs: 100 });
  try { return await spawnToLog(command, cwd, logPath); } finally { lock.release(); }
}
```

- [ ] **Step 3: Write src/commands/suite.mjs** (resolves the default log path under the job folder with `jobDir`; prints `ok`/`red` and the tail; returns the code). Add the import.

- [ ] **Step 4: Run tests; commit**

```bash
git add src/suite.mjs src/commands/suite.mjs src/cli.mjs test/suite.test.mjs
git commit -m "feat: serialised suite runner that logs to the job folder"
```

---

### Task 10: Plan parsing and the independence checks

**Files:**
- Create: `src/plan.mjs`, `src/independence.mjs`, `src/commands/independence.mjs`, `test/plan.test.mjs`, `test/independence.test.mjs`, `test/fixtures/plans/a.md`, `test/fixtures/plans/b.md`, `test/fixtures/plans/overlap.md`
- Modify: `src/cli.mjs`

**Interfaces:**
- `parsePlan(markdown) -> { tasks: [{ n, title, files: [{ op: "create"|"modify"|"test", path }], dependsOn: number[] }] }`. Tasks are `### Task N: Title` headings; inside, lines `- Create: path`, `- Modify: path[:lines]`, `- Test: path` (case-insensitive, within a `**Files:**` block or anywhere in the task); `**Depends on:** Task 2, Task 3` or `- Depends on: 2, 3` or `(after Task 2)` in the title. Paths are normalised to forward slashes and trimmed of `:line` suffixes.
- `checkMilestones(config, planA, planB, { nameA, nameB }) -> { ok, checks: [{ name, ok, detail }] }` with the four checks: `disjoint-files` (no path in both; a directory path like `packages/core` covers its children), `hotspots` (each plan touches at most one file under each hotspot, and never the same hotspot file), `migrations` (at most one plan has a file under `migrations.dir`; skipped with `ok: true, detail: "no migrations dir"` when null), `numbering` (skipped unless `record.carriedForward`; then fails if both plans mention the carried-forward file, with the detail telling the later card to wait).
- `taskBatches(plan, max) -> number[][]`: greedy batches in task order; a task joins the current batch if all its `dependsOn` are in earlier batches, its files are disjoint from every task in the batch, and the batch has fewer than `max`; a task whose dependencies are unmet starts a new batch.
- CLI: `sfactory independence milestones <planA> <planB>` (prints the table, exits 0/1) and `sfactory independence tasks <plan> [--max 4]` (prints batches as JSON).

- [ ] **Step 1: Write the fixtures**

`test/fixtures/plans/a.md`:
```markdown
# A plan

### Task 1: Schema
**Files:**
- Create: `apps/api/prisma/migrations/20261027_a/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`

### Task 2: Service
**Files:**
- Create: `apps/api/src/modules/alpha/alpha.service.ts`
- Test: `apps/api/tests/modules/alpha/alpha.service.test.ts`
**Depends on:** Task 1

### Task 3: Routes
**Files:**
- Create: `apps/api/src/modules/alpha/alpha.routes.ts`
- Modify: `apps/api/src/app.ts:40-48`
- Depends on: 2

### Task 4: Docs
**Files:**
- Modify: `spec/modules/19.1-CARRIED-FORWARD.md`
```

`test/fixtures/plans/b.md`: Tasks 1–2 touching `apps/web/src/pages/beta.tsx`, `apps/web/src/hooks/use-beta.ts`, `packages/core/src/beta.ts` (one file under the hotspot), no migrations, no carried-forward.

`test/fixtures/plans/overlap.md`: Task 1 modifies `apps/api/src/modules/alpha/alpha.service.ts` and creates `apps/api/prisma/migrations/20261028_o/migration.sql`; Task 2 modifies `apps/api/src/app.ts` and `spec/modules/19.1-CARRIED-FORWARD.md`.

- [ ] **Step 2: Write the failing tests**

`test/plan.test.mjs`:
```js
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
```

`test/independence.test.mjs`:
```js
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
```

- [ ] **Step 3: Write src/plan.mjs**

```js
const norm = (p) => p.trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "");

export function parsePlan(md) {
  const tasks = [];
  let cur = null;
  for (const raw of String(md).split(/\r?\n/)) {
    const h = raw.match(/^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/i);
    if (h) {
      cur = { n: Number(h[1]), title: h[2].replace(/\s*\(after Task (\d+)\)\s*$/i, "").trim(), files: [], dependsOn: [] };
      const after = h[2].match(/\(after Task (\d+)\)/i); if (after) cur.dependsOn.push(Number(after[1]));
      tasks.push(cur); continue;
    }
    if (!cur) continue;
    const f = raw.match(/^\s*-\s*(Create|Modify|Test)\s*:\s*(.+?)\s*$/i);
    if (f) { cur.files.push({ op: f[1].toLowerCase(), path: norm(f[2]) }); continue; }
    const d = raw.match(/depends on\s*:?\*{0,2}\s*(.+)$/i);
    if (d) for (const m of d[1].matchAll(/\d+/g)) { const n = Number(m[0]); if (!cur.dependsOn.includes(n)) cur.dependsOn.push(n); }
  }
  return { tasks };
}
```

- [ ] **Step 4: Write src/independence.mjs**

```js
import { relative, isAbsolute } from "node:path";

const paths = (plan) => new Set(plan.tasks.flatMap((t) => t.files.map((f) => f.path)));
const under = (p, dir) => p === dir || p.startsWith(dir.replace(/\/$/, "") + "/");
const toRel = (c, dir) => (isAbsolute(dir) ? relative(c.repoRoot, dir).replace(/\\/g, "/") : dir);

export function checkMilestones(c, a, b, { nameA = "A", nameB = "B" } = {}) {
  const pa = [...paths(a)], pb = [...paths(b)];
  const checks = [];
  const shared = pa.filter((x) => pb.some((y) => x === y || under(x, y) || under(y, x)));
  checks.push({ name: "disjoint-files", ok: shared.length === 0, detail: shared.length ? `both touch: ${shared.join(", ")}` : "no file in common" });
  const hot = c.hotspots ?? [];
  const hits = (ps) => hot.flatMap((h) => ps.filter((p) => under(p, h)).map((p) => ({ h, p })));
  const ha = hits(pa), hb = hits(pb);
  const sameHot = ha.filter((x) => hb.some((y) => y.p === x.p)).map((x) => x.p);
  const tooMany = [ha, hb].flatMap((hs, i) => hot.filter((h) => hs.filter((x) => x.h === h).length > 1).map((h) => `${i ? nameB : nameA} edits ${h} more than once`));
  const hotOk = sameHot.length === 0 && tooMany.length === 0;
  checks.push({ name: "hotspots", ok: hotOk, detail: hotOk ? "at most one small edit per hotspot, none shared" : [...sameHot.map((p) => `both edit hotspot ${p}`), ...tooMany].join("; ") });
  if (c.migrations?.dir) {
    const dir = toRel(c, c.migrations.dir);
    const ma = pa.some((p) => under(p, dir)), mb = pb.some((p) => under(p, dir));
    checks.push({ name: "migrations", ok: !(ma && mb), detail: ma && mb ? `both add migrations under ${dir}; one applied list on the dev database` : ma || mb ? `only ${ma ? nameA : nameB} adds a migration` : "neither adds a migration" });
  } else checks.push({ name: "migrations", ok: true, detail: "no migrations dir configured" });
  if (c.record?.carriedForward) {
    const cf = c.record.carriedForward.replace(/\\/g, "/");
    const na = pa.includes(cf), nb = pb.includes(cf);
    checks.push({ name: "numbering", ok: !(na && nb), detail: na && nb ? `both edit ${cf}; ${nameB} waits for ${nameA} to close before taking an entry number` : "no shared entry numbering" });
  } else checks.push({ name: "numbering", ok: true, detail: "no carried-forward list configured" });
  return { ok: checks.every((x) => x.ok), checks };
}

export function taskBatches(plan, max = 4) {
  const batches = [];
  const placed = new Map();   // n -> batch index
  for (const t of plan.tasks) {
    const depsDone = t.dependsOn.every((d) => placed.has(d));
    const minBatch = t.dependsOn.length ? Math.max(...t.dependsOn.map((d) => placed.get(d) ?? Infinity)) + 1 : 0;
    let i = depsDone ? Math.max(minBatch, 0) : batches.length;
    for (; ; i++) {
      if (!batches[i]) { batches[i] = []; }
      const b = batches[i];
      const disjoint = b.every((n) => { const o = plan.tasks.find((x) => x.n === n); return !o.files.some((f) => t.files.some((g) => g.path === f.path)); });
      if (b.length < max && disjoint) { b.push(t.n); placed.set(t.n, i); break; }
    }
  }
  return batches.filter((b) => b.length);
}
```

- [ ] **Step 5: Write src/commands/independence.mjs** (reads the plan files, prints `name  ok/FAIL  detail` rows or the batches JSON; exit 1 when `ok` is false). Add the import.

- [ ] **Step 6: Run tests; commit**

```bash
git add src/plan.mjs src/independence.mjs src/commands/independence.mjs src/cli.mjs test/plan.test.mjs test/independence.test.mjs test/fixtures/plans/a.md test/fixtures/plans/b.md test/fixtures/plans/overlap.md
git commit -m "feat: plan parsing, milestone independence checks and task batching"
```

---

### Task 11: Cost recording

**Files:**
- Create: `src/cost.mjs`, `src/commands/cost.mjs`, `test/cost.test.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- `addCost(config, jobId, { at, stage, agent: "claude"|"codex", model, inputTokens, outputTokens, cacheReadTokens = 0, usd = null }) -> entry` appends to `<jobDir>/cost.json` (`{ entries: [] }`), computing `usd` from `config.prices[model]` when null (unknown model → `usd: null, priced: false`), and writes the running `total` back; `readCost(config, jobId)`; `totalUsd(entries) -> number` (unpriced entries count 0 and the result carries `unpriced: n`).
- CLI: `sfactory cost add <id> --stage building --agent codex --model gpt-6.1-sol --in 12000 --out 3000`; `sfactory cost show <id>`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { addCost, readCost, totalUsd } from "../src/cost.mjs";
import { DEFAULT_PRICES } from "../src/prices.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-cost-"), prices: DEFAULT_PRICES });

test("cost: priced and unpriced entries, running total", () => {
  const c = cfg();
  const e = addCost(c, "m-1", { stage: "building", agent: "claude", model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 100_000 });
  assert.equal(e.usd, 2.0 + 1.0); assert.equal(e.priced, true);
  const u = addCost(c, "m-1", { stage: "building", agent: "codex", model: "gpt-6.1-sol", inputTokens: 5, outputTokens: 5 });
  assert.equal(u.usd, null); assert.equal(u.priced, false);
  const all = readCost(c, "m-1");
  assert.equal(all.entries.length, 2);
  assert.deepEqual(totalUsd(all.entries), { usd: 3.0, unpriced: 1 });
  assert.equal(all.total.usd, 3.0);
});
```

- [ ] **Step 2: Write src/cost.mjs**

```js
import { readJobFile, writeJobFile } from "./store.mjs";

export function priceOf(prices, model, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 }) {
  const p = prices?.[model];
  if (!p) return null;
  return Math.round(((inputTokens * p.input + outputTokens * p.output + cacheReadTokens * (p.cacheRead ?? 0)) / 1e6) * 10000) / 10000;
}
export function totalUsd(entries) {
  let usd = 0, unpriced = 0;
  for (const e of entries) if (e.usd == null) unpriced++; else usd += e.usd;
  return { usd: Math.round(usd * 10000) / 10000, unpriced };
}
export function readCost(c, id) { const t = readJobFile(c, id, "cost.json"); return t ? JSON.parse(t) : { entries: [], total: { usd: 0, unpriced: 0 } }; }
export function addCost(c, id, { at = new Date().toISOString(), stage, agent, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, usd = null }) {
  const computed = usd ?? priceOf(c.prices, model, { inputTokens, outputTokens, cacheReadTokens });
  const entry = { at, stage, agent, model, inputTokens, outputTokens, cacheReadTokens, usd: computed, priced: computed != null };
  const all = readCost(c, id);
  all.entries.push(entry);
  all.total = totalUsd(all.entries);
  writeJobFile(c, id, "cost.json", JSON.stringify(all, null, 2) + "\n");
  return entry;
}
```

- [ ] **Step 3: Write src/commands/cost.mjs**, add the import, run tests, commit**

```bash
git add src/cost.mjs src/commands/cost.mjs src/cli.mjs test/cost.test.mjs
git commit -m "feat: per-job cost recording with a price table"
```

---

### Task 12: `doctor`, the bin shims, and the package check

**Files:**
- Create: `src/doctor.mjs`, `src/commands/doctor.mjs`, `bin/sfactory-job`, `bin/sfactory-lock`, `bin/sfactory-worktree`, `bin/sfactory-ports`, `bin/sfactory-commit`, `bin/sfactory-push`, `bin/sfactory-suite`, `bin/sfactory-independence`, `bin/sfactory-cost`, `bin/sfactory-doctor`, `test/doctor.test.mjs`, `README.md` (short: what it is, install, status "core only; skills and board follow")
- Modify: `src/cli.mjs`, `package.json` (`files` already lists `bin`)

**Interfaces:**
- `runDoctor(config | null, { cwd, exec = spawnSync }) -> { ok, checks: [{ name, ok, detail }] }`: `node>=20`, `git` runnable, config present and valid (when null, the check fails and the rest that need config are skipped), `stateDir` writable (creates it), `worktrees.dir` creatable and not the repo root, `claude` on PATH when mode is `claude`/`mixed`, `codex` on PATH when `codex`/`mixed`, Codex profiles present in `~/.codex/config.toml` when `codex`/`mixed` (reads the file, looks for `[profiles.<name>]`), `ports.base` block free, `rules` files identical when more than one, `commands.suite` non-empty. `exec` is injectable so the test can fake `codex`/`claude` absent or present.
- Each shim is three lines: shebang, `import { main } from "../src/cli.mjs"`, `process.exitCode = await main(["job", ...process.argv.slice(2)])` (with its own command name). No `.mjs` extension on the shim filename, `#!/usr/bin/env node`, executable bit set in git (`git update-index --chmod=+x`).

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpRepo, tmpDir, writeConfig } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { runDoctor } from "../src/doctor.mjs";

const fakeExec = (present) => (cmd) => ({ status: present.includes(cmd) ? 0 : 1, stdout: present.includes(cmd) ? `${cmd} 1.0.0\n` : "", stderr: "" });

test("doctor: a healthy claude-mode project passes", () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: 47300 } });
  const r = runDoctor(loadConfig(root), { cwd: root, exec: fakeExec(["git", "claude"]) });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.ok(r.checks.some((c) => c.name === "claude" && c.ok));
  assert.ok(!r.checks.some((c) => c.name === "codex"));
});

test("doctor: mixed mode without codex fails that one check and names it", () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "mixed" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: 47400 } });
  const r = runDoctor(loadConfig(root), { cwd: root, exec: fakeExec(["git", "claude"]), codexConfigPath: "/nonexistent" });
  assert.equal(r.ok, false);
  const codex = r.checks.find((c) => c.name === "codex");
  assert.equal(codex.ok, false); assert.match(codex.detail, /not on PATH/);
});

test("doctor: no config reports NO_CONFIG and skips the dependent checks", () => {
  const root = tmpRepo();
  const r = runDoctor(null, { cwd: root, exec: fakeExec(["git"]) });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === "config" && !c.ok));
  assert.ok(!r.checks.some((c) => c.name === "stateDir"));
});
```

- [ ] **Step 2: Write src/doctor.mjs**

```js
import { spawnSync } from "node:child_process";
import { mkdirSync, accessSync, constants, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const which = (exec, cmd) => { const r = exec(cmd, ["--version"], { encoding: "utf8", shell: process.platform === "win32" }); return r && r.status === 0 ? (r.stdout || "").trim().split("\n")[0] : null; };

export function runDoctor(c, { cwd, exec = spawnSync, codexConfigPath = join(homedir(), ".codex", "config.toml") } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20, `node ${process.versions.node}${major >= 20 ? "" : " (need >= 20)"}`);
  const gitV = which(exec, "git"); add("git", !!gitV, gitV ?? "git not on PATH");
  if (!c) { add("config", false, "sfactory.config.json missing or invalid; run sfactory init"); return { ok: false, checks }; }
  add("config", true, `${c.project}, mode ${c.agents.mode}`);
  try { mkdirSync(c.stateDir, { recursive: true }); accessSync(c.stateDir, constants.W_OK); add("stateDir", true, c.stateDir); } catch (e) { add("stateDir", false, `${c.stateDir}: ${e.message}`); }
  if (resolve(c.worktrees.dir) === resolve(c.repoRoot)) add("worktrees.dir", false, "must not be the main checkout");
  else { try { mkdirSync(c.worktrees.dir, { recursive: true }); add("worktrees.dir", true, c.worktrees.dir); } catch (e) { add("worktrees.dir", false, e.message); } }
  add("commands.suite", !!c.commands.suite?.trim(), c.commands.suite || "empty");
  const mode = c.agents.mode;
  if (mode !== "codex") { const v = which(exec, "claude"); add("claude", !!v, v ?? "claude not on PATH (needed for claude and mixed modes)"); }
  if (mode !== "claude") {
    const v = which(exec, "codex"); add("codex", !!v, v ?? "codex not on PATH (needed for codex and mixed modes)");
    const toml = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
    for (const p of [c.agents.codex.implement, c.agents.codex.review]) add(`codex profile ${p}`, new RegExp(`^\\[profiles\\.${p}\\]`, "m").test(toml), toml ? (new RegExp(`^\\[profiles\\.${p}\\]`, "m").test(toml) ? "present" : `add [profiles.${p}] to ${codexConfigPath} (see INSTALL.md)`) : `${codexConfigPath} not found`);
  }
  if (c.rules.length > 1) {
    const bodies = c.rules.map((r) => { const f = join(c.repoRoot, r); return existsSync(f) ? readFileSync(f, "utf8") : null; });
    const same = bodies.every((b) => b !== null && b === bodies[0]);
    add("rules", same, same ? `${c.rules.join(" = ")}` : `${c.rules.join(", ")} differ or are missing; run sfactory sync-rules`);
  }
  return { ok: checks.every((x) => x.ok), checks };
}
```

Port freeness is async; `commands/doctor.mjs` runs `isFree(config.ports.base)` after `runDoctor` and appends a `ports.base` check before printing.

- [ ] **Step 3: Write src/commands/doctor.mjs** (loads config in a try/catch so a missing config still produces the report; prints `ok`/`FAIL` rows; exit 1 on any failure), the ten shims, and README.md. Add the import to `cli.mjs`.

- [ ] **Step 4: Mark the shims executable and check the package**

Run: `git add bin && git update-index --chmod=+x bin/*` then `npm pack --dry-run` — Expected: the file list contains `bin/`, `src/`, `schema/`, `LICENSE`, `README.md`, `docs/DESIGN.md`, and nothing from `test/` or `.sfactory`.

- [ ] **Step 5: Run every test** — `npm test` — Expected: all green; note the count in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/doctor.mjs src/commands/doctor.mjs src/cli.mjs bin README.md test/doctor.test.mjs
git commit -m "feat: doctor, plugin bin shims and README"
```

---

### Task 13: Thrive example config and a dry run against a throwaway clone

**Files:**
- Create: `examples/thrive-rewards.config.json`, `examples/minimal-node.config.json`, `examples/python-uv.config.json`
- Modify: `package.json` (`files` gains `examples`)

**Interfaces:**
- Consumes: everything above through the CLI.
- Produces: the three example configs the design names, each valid under `validateConfig` (a test asserts it).

- [ ] **Step 1: Write the test**

`test/examples.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validateConfig } from "../src/config.mjs";
const dir = new URL("../examples/", import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith(".config.json")))
  test(`examples: ${f} is valid`, () => assert.deepEqual(validateConfig(JSON.parse(readFileSync(new URL(f, dir), "utf8"))), []));
```

- [ ] **Step 2: Write the three configs.** `thrive-rewards.config.json` is the block in `docs/DESIGN.md` §8 with the comments removed and `$schema` pointing at `https://raw.githubusercontent.com/ShivamH1/sfactory/main/schema/config.json`; `minimal-node.config.json` is the three-line config in §8; `python-uv.config.json` has `"commands": { "suite": "uv run pytest" }` and mode `claude`.

- [ ] **Step 3: Dry run on a throwaway clone (not the real project)**

Clone the Thrive repo into a temp directory outside OneDrive (`git clone --depth 50 <path-to-main-checkout> C:/tmp/sf-dry/thrive`), copy `examples/thrive-rewards.config.json` to its root as `sfactory.config.json` with `worktrees.dir` and `stateDir` pointed at `C:/tmp/sf-dry/wt` and `C:/tmp/sf-dry/state`, then from that clone:

```
node <sfactory>/src/cli.mjs doctor
node <sfactory>/src/cli.mjs job add fix "dry run"
node <sfactory>/src/cli.mjs job set f-1 planning
node <sfactory>/src/cli.mjs job set f-1 building
node <sfactory>/src/cli.mjs worktree cut f-1 --slug dry-run
node <sfactory>/src/cli.mjs ports allocate f-1
node <sfactory>/src/cli.mjs job show f-1
node <sfactory>/src/cli.mjs worktree remove f-1
```

Expected: doctor reports `claude` and `codex` present and the two Codex profiles missing (they are added in Plan C's INSTALL step); the cut lands under `C:/tmp/sf-dry/wt/dry-run` on `feature/dry-run` with `.env` files copied if the clone has them; `job show` has `branch`, `base`, `worktree`, `ports`. `afterCut` (`pnpm install`) is expected to take minutes; set it to `[]` in the dry-run config if the machine is busy. Delete `C:/tmp/sf-dry` afterwards. Record the outcome in the commit body.

- [ ] **Step 4: Commit**

```bash
git add examples/thrive-rewards.config.json examples/minimal-node.config.json examples/python-uv.config.json test/examples.test.mjs package.json
git commit -m "feat: example configs for a spec-tree, a minimal Node and a Python project"
```

---

## Self-review

**Spec coverage (DESIGN.md → task):** §2 concepts: job folder (T3), worktree (T6), lock (T5), card kinds (T4). §4 stages and transitions, `job.json` fields (T4). §5 task loop: the locks and commit the loop uses (T5, T8, T9); the loop itself is Plan C. §6 independence (T10), port blocks (T7), the `live` lock is just a lock name (T5). §7 stops: `awaiting-approval` and `decision-needed` (T4); `stops` config (T2). §8 config and defaults (T2), examples (T13). §9 layout: `package.json`, manifests, `bin/`, `src/`, `schema/`, `examples/`, `test/` (T1, T12, T13); `board/`, `skills/`, `agents/`, `prompts/`, `INSTALL.md` are Plans B and C. §10 commands: `job`, `lock`, `worktree`, `ports`, `commit`, `push`, `suite`, `independence`, `cost`, `doctor` here; `init`, `install`, `sync-rules`, `board`, and the `/sfactory …` session commands in Plan C. §12 guardrails: push (T8), commit (T8), job approval (T4), worktree main checkout and foreign lock (T6), fix-card refusals (Plan C, needs the plan parser from T10), secrets never handed to agents (Plan C), suite lock (T9), fix-round cap (Plan C, reads `limits.fixRounds`). §13 Codex integration: Plan C; `doctor`'s profile check (T12). §14 install: manifests (T1), npm `bin` (T1), shims (T12). §15 tests: every task. §17 licence (T1).

**Placeholder scan:** `schema/config.json` (T2 Step 4), `b.md`/`overlap.md` fixtures (T10 Step 1), the three command modules in T7/T9/T11 and T12's shims are described by their behaviour and one-line contents rather than full code; each is under fifteen lines and fully determined by the interface block above it. No "TBD".

**Type consistency:** `SfactoryError.code` names used across tasks: `NOT_A_REPO`, `NO_CONFIG`, `INVALID_CONFIG`, `JOB_NOT_FOUND`, `BAD_KIND`, `ILLEGAL_TRANSITION`, `APPROVAL_REQUIRED`, `ANSWER_REQUIRED`, `BAD_ARGS`, `UNKNOWN_COMMAND`, `LOCK_HELD`, `NOT_HOLDER`, `GIT_FAILED`, `BASE_NOT_FOUND`, `WORKTREE_IS_MAIN_CHECKOUT`, `WORKTREE_LOCKED`, `BRANCH_EXISTS`, `BASE_MOVED`, `AFTER_CUT_FAILED`, `NO_PORTS`, `UNNAMED_PATHS`, `TRAILER_REFUSED`, `PUSH_DISABLED`, `BRANCH_REFUSED`, `DIRTY_TREE`, `PUSH_UNVERIFIED`. `writeJob` is imported by `commands/job.mjs`, `commands/worktree.mjs` and `commands/ports.mjs` only; the latter two set non-stage fields and the plan says so. `Job.ports` shape `{ block, <name>: port }` is the same in T7 and T12's doctor. `config.limits.lockStaleMs` and `suiteWaitMs` exist in DEFAULTS (T2) and are read in T5 and T9.
