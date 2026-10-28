import { basename } from "node:path";

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
