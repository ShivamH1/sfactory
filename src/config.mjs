import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { DEFAULT_PRICES } from "./prices.mjs";

export const STOP_STAGES = ["awaiting-approval", "decision-needed", "verifying", "pushing"];
const SECTIONS = ["agents", "worktrees", "commands", "ports", "record", "limits", "git", "secrets", "board"];
export const MODES = ["claude", "codex", "mixed"];
export const BASE_RULES = ["newest-feature-branch", "integration-branch"];

export const DEFAULTS = Object.freeze({
  agents: {
    claude: { plan: "opus/high", review: "opus/high", judge: "opus/high", implement: "sonnet", triage: "haiku" },
    codex: { implement: "implement", review: "review" },
  },
  worktrees: { branchPrefix: "feature/", baseRule: "integration-branch", integrationBranch: null, afterCut: [], copyFromBase: [], copyForVerify: [] },
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
  board: { port: 4317, pollMs: 2000, activeMs: 120000 },
  prices: DEFAULT_PRICES,
});

/**
 * The main checkout's root, also from inside a linked worktree: the config and a relative stateDir
 * live there, so every worktree of the repo shares one config, one set of locks and one job store.
 * The common git dir of a normal repo is "<main>/.git"; anything else (a bare repo, a submodule's
 * "modules/<name>", a git too old for --path-format) falls back to the current worktree's top level.
 */
export function findRepoRoot(cwd = process.cwd()) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0) fail("NOT_A_REPO", `${cwd} is not inside a git repository`);
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (common.status === 0) {
    const dir = resolve(common.stdout.trim());
    if (basename(dir) === ".git") return dirname(dir);
  }
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
  if (Array.isArray(raw.stops)) for (const s of raw.stops) if (!STOP_STAGES.includes(s)) errs.push(`stops: "${s}" is not a stoppable stage (${STOP_STAGES.join(", ")})`);
  for (const k of SECTIONS) {
    if (k in raw && (raw[k] === null || typeof raw[k] !== "object" || Array.isArray(raw[k]))) errs.push(`${k}: must be an object`);
  }
  if (raw.git?.merge === true) errs.push("git.merge: the factory never merges; remove this key");
  // A JSON string "false" is truthy: every switch must be a real boolean.
  for (const k of ["trailers", "namedPathsOnly", "push", "merge"]) {
    const v = raw.git?.[k];
    if (v != null && typeof v !== "boolean") errs.push(`git.${k}: must be true or false, not ${JSON.stringify(v)}`);
  }
  if (raw.commands?.suiteSerial != null && typeof raw.commands.suiteSerial !== "boolean") errs.push(`commands.suiteSerial: must be true or false, not ${JSON.stringify(raw.commands.suiteSerial)}`);
  const lists = { rules: raw.rules, hotspots: raw.hotspots, fixCardRefusals: raw.fixCardRefusals, stops: raw.stops,
    "worktrees.afterCut": raw.worktrees?.afterCut, "worktrees.copyFromBase": raw.worktrees?.copyFromBase, "worktrees.copyForVerify": raw.worktrees?.copyForVerify,
    "secrets.neverHandToAgents": raw.secrets?.neverHandToAgents, "commands.typecheck": raw.commands?.typecheck, "ports.names": raw.ports?.names };
  for (const [k, v] of Object.entries(lists)) {
    if (v == null) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) errs.push(`${k}: must be an array of strings`);
  }
  if (Array.isArray(raw.rules)) for (const r of raw.rules) if (typeof r === "string" && (isAbsolute(r) || /^(\/|\\|[A-Za-z]:)/.test(r) || r.split(/[\/\\]/).includes(".."))) errs.push(`rules: "${r}" must be a path inside the repo (no "..", not absolute)`);
  const outside = (p) => isAbsolute(p) || /^(\/|\\|[A-Za-z]:)/.test(p) || p.split(/[\/\\]/).includes("..");
  for (const k of ["brief", "plan", "log", "stories", "carriedForward"]) {
    const v = raw.record?.[k];
    if (typeof v === "string" && outside(v)) errs.push(`record.${k}: "${v}" must be a path inside the worktree (no "..", not absolute)`);
  }
  // record.fix: a fix card's own record patterns; a fix reserves no milestone number, so {n} is refused.
  const fx = raw.record?.fix;
  if (fx != null) {
    if (typeof fx !== "object" || Array.isArray(fx)) errs.push("record.fix: an object of brief, plan and log patterns");
    else for (const k of Object.keys(fx)) {
      const v = fx[k];
      if (!["brief", "plan", "log"].includes(k)) errs.push(`record.fix.${k}: only brief, plan and log`);
      else if (typeof v !== "string" || !v) errs.push(`record.fix.${k}: a path pattern string`);
      else if (outside(v)) errs.push(`record.fix.${k}: "${v}" must be a path inside the worktree (no "..", not absolute)`);
      else if (v.includes("{n}")) errs.push(`record.fix.${k}: "${v}" uses {n}, but a fix card takes no milestone number (use {id} and {slug})`);
    }
  }
  for (const k of ["copyFromBase", "copyForVerify"]) {
    const v = raw.worktrees?.[k];
    if (Array.isArray(v)) for (const p of v) if (typeof p === "string" && outside(p)) errs.push(`worktrees.${k}: "${p}" must be a path inside the repo (no "..", not absolute)`);
  }
  if (raw.worktrees?.baseRule != null && !BASE_RULES.includes(raw.worktrees.baseRule) && typeof raw.worktrees.baseRule !== "string")
    errs.push("worktrees.baseRule: newest-feature-branch, integration-branch or a branch name");
  if (raw.ports != null) {
    if (raw.ports.base != null && !(Number.isInteger(raw.ports.base) && raw.ports.base > 1024 && raw.ports.base < 65000)) errs.push("ports.base: integer 1025..64999");
    if (raw.ports.step != null && !(Number.isInteger(raw.ports.step) && raw.ports.step >= 2)) errs.push("ports.step: integer >= 2");
  }
  const bp = raw.worktrees?.branchPrefix;
  if (bp != null && !(typeof bp === "string" && bp.endsWith("/"))) errs.push('worktrees.branchPrefix: a non-empty string ending in "/"');
  if (raw.board?.activeMs != null && !(Number.isInteger(raw.board.activeMs) && raw.board.activeMs >= 1)) errs.push("board.activeMs: integer >= 1");
  if (raw.record?.style != null && !["docs-folder", "spec-tree"].includes(raw.record.style)) errs.push("record.style: docs-folder or spec-tree");
  return errs;
}

function merge(def, raw) {
  if (Array.isArray(def) || Array.isArray(raw)) return raw ?? structuredClone(def);
  if (def && typeof def === "object" && raw && typeof raw === "object") {
    const out = {};
    for (const k of new Set([...Object.keys(def), ...Object.keys(raw)])) out[k] = merge(def[k], raw[k]);
    return out;
  }
  return raw === undefined ? structuredClone(def) : raw;
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
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { fail("INVALID_CONFIG", `${file}: ${e.message}`); }
  const errs = validateConfig(raw);
  if (errs.length) fail("INVALID_CONFIG", `${file}:\n  ${errs.join("\n  ")}`);
  return resolveConfig(raw, repoRoot);
}
