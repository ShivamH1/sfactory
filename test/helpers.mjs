import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function tmpDir(prefix = "sf-") { return mkdtempSync(join(tmpdir(), prefix)); }

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
