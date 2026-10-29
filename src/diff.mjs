import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";
import { git } from "./git.mjs";

/** The working tree as the "head" of a diff (uncommitted changes, new files included): the triage's wip package. */
export const WORKTREE = "WORKTREE";
/** A ref as a skill passes it: a sha, a branch, HEAD, HEAD~2. Never an option, never a range. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/;

export function assertRef(v, what) {
  if (typeof v !== "string" || !REF.test(v) || v.includes("..") || v.endsWith(".lock") || v.endsWith("/")) fail("BAD_ARGS", `${what}: ${JSON.stringify(v)} is not a ref (a sha, a branch name, HEAD or HEAD~n)`);
  return v;
}

const lit = (args, cwd, opts) => git(["--literal-pathspecs", ...args], { cwd, ...opts });
const sep = (paths) => (paths.length ? ["--", ...paths] : []);

/** Untracked, not ignored, files among `paths` (or anywhere), relative to cwd's top level. */
function untracked(cwd, paths) {
  return lit(["ls-files", "--others", "--exclude-standard", ...sep(paths)], cwd).split(/\r?\n/).filter(Boolean);
}

/** A new file as a diff from nothing: git diff --no-index exits 1 when the files differ, which is the point. */
function newFileDiff(cwd, file, extra = []) {
  const r = spawnSync("git", ["diff", "--no-index", ...extra, "--", "/dev/null", file], { cwd, encoding: "utf8" });
  if (r.error || (r.status !== 0 && r.status !== 1)) fail("GIT_FAILED", `git diff --no-index ${file} (in ${cwd}): ${(r.stderr || "").trim()}`);
  return r.stdout.replace(/\s+$/, "");
}

/** Names of the files that differ between base and head (head WORKTREE: the working tree, new files included). */
export function diffNames(cwd, base, head, paths = [], { skip = () => false } = {}) {
  assertRef(base, "base");
  if (head === WORKTREE) {
    const names = lit(["diff", "--name-only", base, ...sep(paths)], cwd).split(/\r?\n/).filter(Boolean);
    for (const f of untracked(cwd, paths)) if (!names.includes(f)) names.push(f);
    return names.filter((f) => !skip(f));
  }
  assertRef(head, "head");
  return lit(["diff", "--name-only", `${base}..${head}`, ...sep(paths)], cwd).split(/\r?\n/).filter(Boolean);
}

/** The commits in base..head touching paths, one line each. */
export function diffCommits(cwd, base, head, paths = []) {
  assertRef(base, "base"); assertRef(head === WORKTREE ? "HEAD" : head, "head");
  return lit(["log", "--oneline", `${base}..${head === WORKTREE ? "HEAD" : head}`, ...sep(paths)], cwd);
}

/**
 * A review package (the sdd skill's format): a header, the commits, the stat and the -U10 diff of base..head over
 * paths. With head WORKTREE it is the working tree against base, and every new (untracked, not ignored) file among
 * the paths is added as a whole-file diff, so a triage sees what a red run's task created. `skip(file)` names a
 * file that must never be packaged (a secret, a verify copy): a working-tree package leaves it out of the stat,
 * the diff and the new-file diffs alike.
 */
export function reviewPackage(cwd, base, head, paths = [], { skip = () => false } = {}) {
  assertRef(base, "base");
  const wt = head === WORKTREE;
  if (!wt) assertRef(head, "head");
  const range = wt ? [base] : [`${base}..${head}`];
  const fresh = wt ? untracked(cwd, paths).filter((f) => !skip(f)) : [];
  let tracked = paths, noTracked = false;
  if (wt) {
    // A skipped file cannot be excluded by a pathspec (they are literal), so the tracked files left are named instead.
    const all = lit(["diff", "--name-only", base, ...sep(paths)], cwd).split(/\r?\n/).filter(Boolean);
    const kept = all.filter((f) => !skip(f));
    if (kept.length !== all.length) { tracked = kept; noTracked = kept.length === 0; }
  }
  const parts = [`# Review package: ${base}..${head}`, "", "## Commits", diffCommits(cwd, base, wt ? "HEAD" : head, paths), "", "## Files changed", noTracked ? "" : lit(["diff", "--stat", ...range, ...sep(tracked)], cwd)];
  if (fresh.length) parts.push(...fresh.map((f) => ` ${f} (new, untracked)`));
  parts.push("", "## Diff", noTracked ? "" : lit(["diff", "-U10", ...range, ...sep(tracked)], cwd));
  for (const f of fresh) parts.push(newFileDiff(cwd, f, ["-U10"]));
  return parts.join("\n").replace(/\s+$/, "") + "\n";
}

/** git status --porcelain --untracked-files=all of a worktree, one line per path ("" when clean); the lines keep their leading status column. */
export function porcelain(cwd) {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) fail("GIT_FAILED", `git status (in ${cwd}): ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout.replace(/\s+$/, "");
}
