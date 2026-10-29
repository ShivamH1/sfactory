import { basename, posix, relative, resolve } from "node:path";

/** Config resolves every secrets entry to an absolute path, so an env var name arrives as a path; its basename is the name. Entries that are not env-name shaped (files like .env) are skipped. */
export function secretNames(c) {
  return (c?.secrets?.neverHandToAgents ?? []).map((s) => basename(s)).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
}

/** A copy of env without any variable named in secrets (compared case-insensitively) and without undefined values. */
export function dropNamedSecrets(c, env) {
  const drop = new Set(secretNames(c).map((s) => s.toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.has(k.toUpperCase())) out[k] = v;
  return out;
}

/**
 * Is a path covered by secrets.neverHandToAgents? True when it equals, lies inside, or is an ancestor of an entry,
 * matched as the same repo-relative path (a worktree has another root) or the same absolute location (with cwd);
 * slashes normalised, case-insensitive on Windows.
 */
export function coveredBySecret(c, p, { cwd } = {}) {
  const secrets = c.secrets?.neverHandToAgents ?? [];
  if (!secrets.length) return false;
  const norm = (x) => {
    const n = posix.normalize(String(x).split("\\").join("/")).replace(/\/+$/, "") || ".";
    return process.platform === "win32" ? n.toLowerCase() : n;
  };
  const related = (a, b) => a === b || a === "." || b === "." || a.startsWith(b + "/") || b.startsWith(a + "/");
  const rel = secrets.map((s) => norm(c.repoRoot ? relative(c.repoRoot, s) : s));
  const abs = secrets.map((s) => norm(resolve(s)));
  const np = norm(p);
  const ap = cwd ? norm(resolve(cwd, p)) : null;
  return rel.some((r) => related(np, r)) || (ap !== null && abs.some((a) => related(ap, a)));
}
