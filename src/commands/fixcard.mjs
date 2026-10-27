import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail, SfactoryError } from "../errors.mjs";
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { parsePlan } from "../plan.mjs";
import { checkFixCard } from "../fixcard.mjs";

register("fixcard", async ({ positional: [file] }, io) => {
  if (!file) fail("BAD_ARGS", "usage: sfactory fixcard <plan>");
  const c = loadConfig(findRepoRoot(io.cwd));
  const path = resolve(io.cwd, file);
  let plan;
  try { plan = parsePlan(readFileSync(path, "utf8")); } catch (e) { if (e instanceof SfactoryError) throw new SfactoryError(e.code, `${file}: ${e.message}`); fail("PLAN_UNREADABLE", `${path}: ${e.message}`); }
  const r = checkFixCard(c, plan);
  if (r.ok) { io.stdout("ok: no file matches fixCardRefusals\n"); return 0; }
  for (const h of r.hits) io.stdout(`${h.file}  matches ${h.pattern}\n`);
  io.stdout("refile this card as a milestone\n");
  return 1;
});
