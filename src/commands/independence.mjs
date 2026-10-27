import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { fail, SfactoryError } from "../errors.mjs";
import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { parsePlan } from "../plan.mjs";
import { checkMilestones, taskBatches, migrationsDirOf } from "../independence.mjs";

function readPlan(io, file) {
  const path = resolve(io.cwd, file);
  try { return parsePlan(readFileSync(path, "utf8")); } catch (e) { if (e instanceof SfactoryError) throw new SfactoryError(e.code, `${file}: ${e.message}`); fail("PLAN_UNREADABLE", `${path}: ${e.message}`); }
}

function tryConfig(io) {
  try { return loadConfig(findRepoRoot(io.cwd)); } catch (e) {
    if (e?.code === "NO_CONFIG" || e?.code === "NOT_A_REPO") return null;
    throw e;
  }
}

register("independence", async ({ positional, flags }, io) => {
  const [sub, ...args] = positional;
  if (sub === "milestones") {
    if (args.length !== 2) fail("BAD_ARGS", "usage: sfactory independence milestones <planA> <planB>");
    const config = loadConfig(findRepoRoot(io.cwd));
    const r = checkMilestones(config, readPlan(io, args[0]), readPlan(io, args[1]), { nameA: basename(args[0]), nameB: basename(args[1]) });
    for (const c of r.checks) io.stdout(`${c.name}  ${c.ok ? "ok" : "FAIL"}  ${c.detail}\n`);
    return r.ok ? 0 : 1;
  }
  if (sub === "tasks") {
    // "--allow-undeclared <plan>": the generic parser hands the plan to the
    // flag as its value; a value other than true/false is the positional.
    let allow = flags["allow-undeclared"];
    if (typeof allow === "string" && !/^(true|false)$/.test(allow)) { args.unshift(allow); allow = true; }
    allow = allow === true || allow === "true";
    if (args.length !== 1) fail("BAD_ARGS", "usage: sfactory independence tasks <plan> [--max n] [--allow-undeclared]");
    const config = tryConfig(io);
    let max = flags.max != null ? Number(flags.max) : config?.limits.parallelTasks ?? 4;
    if (!Number.isInteger(max) || max < 1) fail("BAD_ARGS", "--max must be a positive integer");
    const plan = readPlan(io, args[0]);
    if (plan.dependencyInfo !== "declared" && !allow) io.stderr(`${args[0]}: no dependency information (no Depends on, Consumes or "after Task N"): one task per batch; --allow-undeclared batches by files alone\n`);
    io.stdout(JSON.stringify(taskBatches(plan, max, { allowUndeclared: allow, migrationsDir: migrationsDirOf(config) })) + "\n");
    return 0;
  }
  fail("BAD_ARGS", "usage: sfactory independence milestones <planA> <planB> | tasks <plan> [--max n] [--allow-undeclared]");
});
