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
