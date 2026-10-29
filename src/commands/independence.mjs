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

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: ["milestones", "tasks"], flags: ["max", "allow-undeclared"] };

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
    const allow = flags["allow-undeclared"] === true;
    if (args.length !== 1) fail("BAD_ARGS", "usage: sfactory independence tasks <plan> [--max n] [--allow-undeclared]");
    const config = tryConfig(io);
    // A bare --max (no value) is BAD_ARGS, never 1; a value above limits.parallelTasks is capped at it.
    if (flags.max !== undefined && !(typeof flags.max === "string" && /^[1-9][0-9]*$/.test(flags.max))) fail("BAD_ARGS", "--max needs a positive whole number");
    const limit = config?.limits.parallelTasks ?? 4;
    let max = flags.max !== undefined ? Number(flags.max) : limit;
    if (max > limit) { io.stderr(`--max ${max} is above limits.parallelTasks; capped at ${limit}\n`); max = limit; }
    const plan = readPlan(io, args[0]);
    if (plan.dependencyInfo !== "declared" && !allow) {
      // R4-1: every task must carry its own Depends on line; name the ones that do not.
      const miss = plan.missingDependsOn ?? [];
      const why = !miss.length || miss.length === plan.tasks.length ? `no explicit "Depends on" line`
        : miss.length === 1 ? `Task ${miss[0]} has no "Depends on" line (every task needs its own)` : `Tasks ${miss.join(", ")} have no "Depends on" line (every task needs its own)`;
      io.stderr(`${args[0]}: ${why}: one task per batch, in dependency order; --allow-undeclared batches by files and the Consumes / "after Task N" edges\n`);
    }
    io.stdout(JSON.stringify(taskBatches(plan, max, { allowUndeclared: allow, migrationsDir: migrationsDirOf(config) })) + "\n");
    return 0;
  }
  fail("BAD_ARGS", "usage: sfactory independence milestones <planA> <planB> | tasks <plan> [--max n] [--allow-undeclared]");
}, ACCEPTS);
