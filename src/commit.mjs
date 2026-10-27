import { statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { fail } from "./errors.mjs";
import { git } from "./git.mjs";
import { withLock } from "./lock.mjs";

const regexTrailers = (message) => {
  const paras = String(message).trim().split(/\n\s*\n/);
  if (paras.length < 2) return [];
  const last = paras.at(-1).split("\n").map((l) => l.trim()).filter(Boolean);
  return last.every((l) => /^[A-Za-z][A-Za-z-]*: \S/.test(l)) ? last : [];
};

/** Trailers git itself would parse (interpret-trailers), unioned with a strict regex fallback. */
export function hasTrailers(message, { cwd } = {}) {
  const found = regexTrailers(message);
  let parsed = [];
  try {
    const out = git(["interpret-trailers", "--parse"], { cwd, input: String(message), allowFail: true });
    parsed = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch { /* git absent: the regex stands */ }
  return [...new Set([...parsed, ...found])];
}

export function assertNamedPaths(paths, { cwd } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) fail("UNNAMED_PATHS", "commit needs at least one named path");
  for (const p of paths) {
    const bad = (why) => fail("UNNAMED_PATHS", `"${p}" is not a named path (${why})`);
    if (typeof p !== "string" || p === "") bad("empty");
    if (p.startsWith("-") || p.startsWith(":")) bad("option or magic pathspec");
    if (/[\[\]*?]/.test(p)) bad("glob");
    if (isAbsolute(p) || /^[A-Za-z]:/.test(p)) bad("absolute");
    if (/[\\/]$/.test(p)) bad("directory");
    const norm = posix.normalize(p.replace(/\\/g, "/"));
    if (norm === "." || norm === ".." || norm.split("/").includes("..")) bad("whole tree or outside it");
    if (cwd) {
      let isDir = false;
      try { isDir = statSync(join(cwd, p)).isDirectory(); } catch { /* new or deleted file */ }
      if (isDir) fail("NOT_A_FILE", `"${p}" is a directory; name its files`);
    }
  }
}

export async function commit(c, { cwd, paths, message, holder }) {
  if (typeof message !== "string" || !message.trim()) fail("BAD_ARGS", "commit needs a message");
  if (c.git.namedPathsOnly !== false) assertNamedPaths(paths, { cwd });
  const trailers = hasTrailers(message, { cwd });
  if (trailers.length && c.git.trailers !== true) fail("TRAILER_REFUSED", `trailers are off (git.trailers): ${trailers.join("; ")}`);
  return withLock(c, "commit", { holder: holder ?? "session", waitMs: 60_000 }, async () => {
    git(["--literal-pathspecs", "add", "--", ...paths], { cwd });
    git(["--literal-pathspecs", "commit", "--quiet", "-m", message, "--", ...paths], { cwd });
    const added = git(["log", "-1", "--format=%(trailers)", "HEAD"], { cwd });
    if (added && c.git.trailers !== true) fail("TRAILER_REFUSED", `a commit-msg hook added a trailer: ${added.split(/\r?\n/).filter(Boolean).join("; ")} (the commit was left in place, not reset)`);
    return git(["rev-parse", "HEAD"], { cwd });
  });
}
