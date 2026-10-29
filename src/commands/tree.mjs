import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "../registry.mjs";
import { fail } from "../errors.mjs";
import { git } from "../git.mjs";
import { porcelain } from "../diff.mjs";

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: null, flags: ["head"] };

/**
 * A worktree's state for the skills: the porcelain lines (untracked files listed one by one), exit 0 and nothing
 * printed when clean, exit 1 when anything is listed; --head prints HEAD's sha instead.
 */
register("tree", async ({ positional: [dir], flags }, io) => {
  if (!dir) fail("BAD_ARGS", "usage: sfactory tree <worktree> [--head]");
  const cwd = resolve(io.cwd, dir);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail("BAD_ARGS", `not a directory: ${cwd}`);
  if (flags.head === true) { io.stdout(`${git(["rev-parse", "HEAD"], { cwd })}\n`); return 0; }
  const p = porcelain(cwd);
  if (!p) return 0;
  io.stdout(p + "\n");
  return 1;
}, ACCEPTS);
