import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fail } from "./errors.mjs";
import { fileURLToPath } from "node:url";

export const PLUGIN_FOLDERS = ["skills", "agents", "prompts"];

/** The plugin's own root: CLAUDE_PLUGIN_ROOT, else this package's directory; never the current repo. */
export function pluginRoot(env = process.env) {
  return env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** CLAUDE_PLUGIN_ROOT must be this package's own tree: its package.json names this package. */
export function assertPluginRoot(root) {
  let name = null;
  try { name = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name; } catch { /* unreadable: refused below */ }
  const own = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).name;
  if (name !== own) fail("BAD_PLUGIN_ROOT", `CLAUDE_PLUGIN_ROOT (${root}) is not the ${own} package (its package.json name is ${JSON.stringify(name)})`);
}

/** Files under dir/rel as relative paths; a symlink is yielded as { link } and never followed. */
function* walk(dir, rel = "") {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) yield { link: r };
    else if (e.isDirectory()) yield* walk(dir, r); else if (e.isFile()) yield r;
  }
}

/**
 * Copy the plugin's skills/agents/prompts. `codex` copies skills only, straight into dest (Codex reads
 * <dest>/<skill>/SKILL.md). A file that differs from what is there is kept unless `force`.
 * Returns { copied, same, kept, absent, skipped } (skipped: symlinks, never followed) as lists of relative paths / folder names.
 */
export function install({ root, dest, codex = false, force = false }) {
  const out = { copied: [], same: [], kept: [], absent: [], skipped: [] };
  for (const folder of codex ? ["skills"] : PLUGIN_FOLDERS) {
    const src = join(root, folder);
    if (!existsSync(src) || !statSync(src).isDirectory()) { out.absent.push(folder); continue; }
    for (const item of walk(src)) {
      if (typeof item !== "string") { out.skipped.push(codex ? item.link : `${folder}/${item.link}`); continue; }
      const rel = item;
      const to = codex ? join(dest, rel) : join(dest, folder, rel);
      const shown = codex ? rel : `${folder}/${rel}`;
      const from = join(src, rel);
      if (existsSync(to)) {
        let same;
        try { same = readFileSync(to).equals(readFileSync(from)); } catch (e) { if (e.code === "EISDIR") fail("INSTALL_TARGET_IS_DIRECTORY", `${to} is a directory; remove or move it`); throw e; }
        if (same) { out.same.push(shown); continue; }
        if (!force) { out.kept.push(shown); continue; }
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      out.copied.push(shown);
    }
  }
  return out;
}
