#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SfactoryError } from "./errors.mjs";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const commands = new Map();
/** Later tasks call register("job", handler) from src/commands/*.mjs. */
export function register(name, handler) { commands.set(name, handler); }

/** Minimal arg parser: positionals plus --flag, --flag=value, --flag value. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
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
    const code = await handler(parseArgs(rest), { stdout, stderr, cwd: io.cwd ?? process.cwd() });
    return code ?? 0;
  } catch (e) {
    if (e instanceof SfactoryError) { stderr(`error ${e.code}: ${e.message}\n`); return 2; }
    stderr(`error INTERNAL: ${e?.stack ?? e}\n`);
    return 3;
  }
}

// Command modules register themselves on import. Each later task adds one line here.
await Promise.all([
  // import("./commands/job.mjs"),
]);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
