#!/usr/bin/env node
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SfactoryError } from "./errors.mjs";
import { commands } from "./registry.mjs";

export { register } from "./registry.mjs";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

/** Flags that never consume the next argument. */
export const BOOLEAN_FLAGS = new Set(["json", "yes", "no", "apply", "dry-run", "force", "guard", "durable", "no-fetch", "allow-undeclared", "demo", "once"]);

/**
 * Minimal arg parser: positionals plus --flag, --flag=value, --flag value.
 * BOOLEAN_FLAGS never take a separate value; "--" ends flag parsing and the
 * remainder goes to flags.rest; an empty flag name ("--=x") is ignored.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      if (i + 1 < argv.length) flags.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!name) continue;
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[name] = argv[++i];
      else flags[name] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const [name, ...rest] = argv;
  if (!name || name === "version" || name === "--version") { stdout(`sfactory ${pkg.version}\n`); return 0; }
  const handler = commands.get(name);
  if (!handler) { stderr(`error UNKNOWN_COMMAND: ${name}\n`); return 2; }
  try {
    const code = await handler(parseArgs(rest), { ...io, stdout, stderr, cwd: io.cwd ?? process.cwd() });
    return code ?? 0;
  } catch (e) {
    if (e instanceof SfactoryError) { stderr(`error ${e.code}: ${e.message}\n`); return 2; }
    stderr(`error INTERNAL: ${e?.stack ?? e}\n`);
    return 3;
  }
}

// Command modules register themselves on import via registry.mjs. Each later task adds one line here.
await Promise.all([
  import("./commands/board.mjs"),
  import("./commands/codex.mjs"),
  import("./commands/commit.mjs"),
  import("./commands/cost.mjs"),
  import("./commands/doctor.mjs"),
  import("./commands/fixcard.mjs"),
  import("./commands/independence.mjs"),
  import("./commands/job.mjs"),
  import("./commands/lock.mjs"),
  import("./commands/ports.mjs"),
  import("./commands/push.mjs"),
  import("./commands/services.mjs"),
  import("./commands/suite.mjs"),
  import("./commands/worktree.mjs"),
]);

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
