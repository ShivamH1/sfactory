import { register } from "../registry.mjs";
import { SfactoryError } from "../errors.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { runDoctor } from "../doctor.mjs";
import { isFree } from "../ports.mjs";

const SOFT = new Set(["NO_CONFIG", "INVALID_CONFIG", "NOT_A_REPO"]);

register("doctor", async (_args, io) => {
  let c = null;
  let configError = null;
  try { c = loadConfig(findRepoRoot(io.cwd)); } catch (e) {
    if (e instanceof SfactoryError && SOFT.has(e.code)) configError = `${e.code}: ${e.message}`; else throw e;
  }
  const r = runDoctor(c, { cwd: io.cwd });
  if (configError) { const row = r.checks.find((x) => x.name === "config"); if (row) row.detail = configError; }
  if (c) {
    const free = await isFree(c.ports.base);
    r.checks.push({ name: "ports.base", ok: free, detail: free ? String(c.ports.base) : `${c.ports.base} is in use` });
  }
  let ok = true;
  for (const k of r.checks) { if (!k.ok) ok = false; io.stdout(`${k.ok ? "ok  " : "FAIL"}  ${k.name}  ${k.detail}\n`); }
  return ok ? 0 : 1;
});
