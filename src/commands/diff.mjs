import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { register } from "../registry.mjs";
import { fail } from "../errors.mjs";
import { reviewPackage, diffNames, diffCommits } from "../diff.mjs";
import { findRepoRoot, loadConfig, pathsOverlap } from "../config.mjs";
import { coveredBySecret } from "../secrets.mjs";

const USAGE = "usage: sfactory diff --cwd <worktree> <base> <head|WORKTREE> (--out <file> | --names | --commits) [-- <path>...]";

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: null, flags: ["cwd", "out", "names", "commits"] };

/**
 * The git reads the skills need, as one verb (so allowed-tools need no Bash(git *)): --out writes a review package,
 * --names prints the changed files, --commits the commits. head WORKTREE is the working tree, new files included.
 */
register("diff", async ({ positional: [base, head], flags }, io) => {
  const modes = [flags.out !== undefined && "out", flags.names !== undefined && "names", flags.commits !== undefined && "commits"].filter(Boolean);
  if (!base || !head || modes.length !== 1 || (modes[0] === "out" && typeof flags.out !== "string")) fail("BAD_ARGS", USAGE);
  if (typeof flags.cwd !== "string") fail("BAD_ARGS", `diff needs --cwd <worktree>\n${USAGE}`);
  const cwd = resolve(io.cwd, flags.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail("BAD_ARGS", `--cwd is not a directory: ${cwd}`);
  const paths = flags.rest ?? [];
  // A package goes to an agent: never a path under secrets.neverHandToAgents, nor a worktrees.copyForVerify file (it may be an untracked secret).
  let skip = () => false;
  try {
    const c = loadConfig(findRepoRoot(cwd));
    const verify = c.worktrees.copyForVerify ?? [];
    skip = (f) => coveredBySecret(c, f, { cwd }) || verify.some((v) => pathsOverlap(f, v));
  } catch (e) { if (e?.code !== "NO_CONFIG") throw e; }
  if (modes[0] === "names") { const n = diffNames(cwd, base, head, paths, { skip }); io.stdout(n.length ? n.join("\n") + "\n" : ""); return 0; }
  if (modes[0] === "commits") { const t = diffCommits(cwd, base, head, paths); io.stdout(t ? t + "\n" : ""); return 0; }
  const out = resolve(io.cwd, flags.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, reviewPackage(cwd, base, head, paths, { skip }));
  io.stdout(`wrote ${out}\n`);
  return 0;
}, ACCEPTS);
