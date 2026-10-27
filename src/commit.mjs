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
