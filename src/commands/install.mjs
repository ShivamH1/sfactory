import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "../registry.mjs";
import { fail } from "../errors.mjs";
import { findRepoRoot } from "../config.mjs";
import { install, pluginRoot, assertPluginRoot } from "../install.mjs";

register("install", (args, io) => {
  const { flags } = args;
  if (flags.dest === true) fail("BAD_ARGS", "--dest needs a directory");
  const codex = flags.codex === true;
  const env = io.env ?? process.env;
  const dest = typeof flags.dest === "string" ? resolve(io.cwd, flags.dest)
    : codex ? join(io.home ?? homedir(), ".codex", "skills") : join(findRepoRoot(io.cwd), ".claude");
  const root = pluginRoot(env);
  if (env.CLAUDE_PLUGIN_ROOT) assertPluginRoot(root);
  const r = install({ root, dest, codex, force: flags.force === true });
  for (const f of r.copied) io.stdout(`copied  ${f}\n`);
  for (const f of r.skipped) io.stdout(`skipped symlink ${f}\n`);
  for (const f of r.kept) io.stdout(`kept    ${f} (differs; --force replaces it)\n`);
  io.stdout(`${r.copied.length} copied, ${r.same.length} already identical, ${r.kept.length} kept into ${dest}\n`);
  if (r.absent.length) io.stdout(`not in the plugin: ${r.absent.join(", ")}\n`);
  if (codex) io.stdout("--codex installs skills only\n");
  if (r.absent.length === (codex ? 1 : 3)) { io.stdout(`nothing to install: none of the plugin folders exist under ${root}\n`); return 1; }
  return r.kept.length ? 1 : 0;
});
