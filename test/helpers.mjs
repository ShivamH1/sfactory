import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function tmpDir(prefix = "sf-") { return mkdtempSync(join(tmpdir(), prefix)); }

// Minor 12 (Plan C final review): every git the tests run reads an empty global config, never the machine's
// (a commit.gpgsign, a hook path, an init.defaultBranch or a credential helper there changes what the tests see),
// with a fixed identity for the commits made in clones that carry no local user.
const EMPTY_GLOBAL = join(tmpDir("sf-gitcfg-"), "gitconfig");
writeFileSync(EMPTY_GLOBAL, "");
process.env.GIT_CONFIG_GLOBAL = EMPTY_GLOBAL;
for (const [k, v] of [["GIT_AUTHOR_NAME", "t"], ["GIT_AUTHOR_EMAIL", "t@example.com"], ["GIT_COMMITTER_NAME", "t"], ["GIT_COMMITTER_EMAIL", "t@example.com"]]) process.env[k] = v;
export const GIT_CONFIG_GLOBAL = EMPTY_GLOBAL;

export function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
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
