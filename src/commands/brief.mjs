import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { register } from "../registry.mjs";
import { fail } from "../errors.mjs";
import { taskBrief } from "../brief.mjs";

const USAGE = "usage: sfactory brief <plan> <task id> --out <file>";

/** What this command accepts (test/cli.test.mjs checks it against the flags read below). */
export const ACCEPTS = { verbs: null, flags: ["out"] };

register("brief", async ({ positional: [plan, n], flags }, io) => {
  if (!plan || !n || typeof flags.out !== "string") fail("BAD_ARGS", USAGE);
  const from = resolve(io.cwd, plan), out = resolve(io.cwd, flags.out);
  let text;
  try { text = readFileSync(from, "utf8"); } catch (e) { fail("PLAN_UNREADABLE", `${from}: ${e.code ?? e.message}`); }
  const brief = taskBrief(text, n);
  if (!brief) fail("TASK_NOT_FOUND", `task ${n} not found in ${plan} (no heading matching "Task ${n}:")`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, brief);
  io.stdout(`wrote ${out}: ${brief.split("\n").length - 1} lines\n`);
  return 0;
}, ACCEPTS);
