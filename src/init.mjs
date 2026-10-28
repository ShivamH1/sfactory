import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULTS } from "./config.mjs";

export const CONFIG_FILE = "sfactory.config.json";
const SCHEMA = "https://raw.githubusercontent.com/ShivamH1/sfactory/main/schema/config.json";
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } };

/** Paths (relative, "/" separated) of env files that exist: root and one directory down, never their contents. */
export function findEnvFiles(root) {
  const looksEnv = (n) => (n === ".env" || n.startsWith(".env.")) && !/\.(example|sample|template)$/.test(n);
  const out = [];
  const scan = (dirRel) => {
    const dir = dirRel ? join(root, dirRel) : root;
    let names; try { names = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    for (const d of names) if (d.isFile() && looksEnv(d.name)) out.push(dirRel ? `${dirRel}/${d.name}` : d.name);
    return names.filter((d) => d.isDirectory() && d.name !== "node_modules" && d.name !== ".git").map((d) => d.name);
  };
  for (const sub of scan("")) {
    const inner = scan(sub);
    if (sub === "apps" || sub === "packages") for (const s2 of inner) scan(`${sub}/${s2}`);
  }
  return out.sort();
}

function localBranches(root) {
  const r = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** Guess a config from what is in the repo. Pure of writes; returns { config, guesses, defaults, secrets }. */
export function inspectRepo(root) {
  const guesses = [];
  const guess = (k, v, why) => guesses.push(`${k} = ${JSON.stringify(v)}  (${why})`);
  const pkg = readJson(join(root, "package.json"));
  const config = { $schema: SCHEMA, project: pkg?.name && typeof pkg.name === "string" ? pkg.name : basename(root), agents: { mode: "claude" } };
  guess("project", config.project, pkg?.name ? "package.json name" : "directory name");
  guess("agents.mode", "claude", "the safe start; set mixed or codex to use Codex");
  const commands = {};
  const pm = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : "npm";
  if (typeof pkg?.scripts?.test === "string") { commands.suite = `${pm} test`; guess("commands.suite", commands.suite, "package.json scripts.test"); }
  else if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "uv.lock"))) { commands.suite = "uv run pytest"; guess("commands.suite", commands.suite, "pyproject.toml or uv.lock"); }
  else { commands.suite = "echo no test command configured; set commands.suite && exit 1"; guess("commands.suite", commands.suite, "NOTHING FOUND: a placeholder that fails, edit it"); }
  if (typeof pkg?.scripts?.build === "string") { commands.build = `${pm} run build`; guess("commands.build", commands.build, "package.json scripts.build"); }
  config.commands = commands;
  const branches = localBranches(root);
  const integ = ["development", "develop", "main"].find((b) => branches.includes(b));
  const wt = {};
  if (integ) { wt.integrationBranch = integ; guess("worktrees.integrationBranch", integ, "a local branch of that name exists"); }
  if (branches.some((b) => b.startsWith("feature/"))) { wt.baseRule = "newest-feature-branch"; guess("worktrees.baseRule", wt.baseRule, "feature/* branches exist"); }
  if (Object.keys(wt).length) config.worktrees = wt;
  if (isDir(join(root, "spec/modules")) && isDir(join(root, "spec/plans")) && isDir(join(root, "spec/decisions"))) {
    config.record = { style: "spec-tree", brief: "spec/modules/{n}-{slug}.md", plan: "spec/plans/{n}-{slug}.md", log: "spec/decisions/{n}-{slug}.md", numbering: "next-milestone-number" };
    guess("record.style", "spec-tree", "spec/modules, spec/plans and spec/decisions exist");
  }
  const rules = ["CLAUDE.md", "AGENTS.md"].filter((f) => existsSync(join(root, f)));
  if (rules.length) { config.rules = rules; guess("rules", rules, "files present"); }
  if (pkg?.workspaces || existsSync(join(root, "pnpm-workspace.yaml"))) { config.hotspots = ["packages/*"]; guess("hotspots", config.hotspots, "a workspace repo: shared packages collide across jobs"); }
  const migDirs = ["prisma/migrations", ...["apps", "packages"].flatMap((g) => (isDir(join(root, g)) ? readdirSync(join(root, g)).map((n) => `${g}/${n}/prisma/migrations`) : []))];
  const mig = migDirs.find((d) => isDir(join(root, d)));
  if (mig) { config.migrations = { dir: mig }; guess("migrations.dir", mig, "a prisma migrations folder exists"); }
  const secrets = findEnvFiles(root);
  if (secrets.length) { config.secrets = { neverHandToAgents: secrets }; guess("secrets.neverHandToAgents", secrets, "env files exist (contents never read)"); }
  const defaults = Object.keys(DEFAULTS).filter((k) => !(k in config));
  return { config, guesses, defaults, secrets };
}

/** Write the config and gitignore the state dir. Returns { file, ignored }. */
export function writeInit(root, config) {
  const file = join(root, CONFIG_FILE);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  const gi = join(root, ".gitignore");
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  let ignored = false;
  if (!/^\/?\.sfactory\/?\s*$/m.test(cur)) {
    appendFileSync(gi, (cur && !cur.endsWith("\n") ? "\n" : "") + ".sfactory/\n");
    ignored = true;
  }
  return { file, ignored };
}
