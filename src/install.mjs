import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_FOLDERS = ["skills", "agents", "prompts"];

/** The plugin's own root: CLAUDE_PLUGIN_ROOT, else this package's directory; never the current repo. */
export function pluginRoot(env = process.env) {
  return env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
}

function* walk(dir, rel = "") {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, r); else if (e.isFile()) yield r;
  }
}

/**
 * Copy the plugin's skills/agents/prompts. `codex` copies skills only, straight into dest (Codex reads
 * <dest>/<skill>/SKILL.md). A file that differs from what is there is kept unless `force`.
 * Returns { copied, same, kept, absent } as lists of relative paths / folder names.
 */
export function install({ root, dest, codex = false, force = false }) {
  const out = { copied: [], same: [], kept: [], absent: [] };
  for (const folder of codex ? ["skills"] : PLUGIN_FOLDERS) {
    const src = join(root, folder);
    if (!existsSync(src) || !statSync(src).isDirectory()) { out.absent.push(folder); continue; }
    for (const rel of walk(src)) {
      const to = codex ? join(dest, rel) : join(dest, folder, rel);
      const shown = codex ? rel : `${folder}/${rel}`;
      const from = join(src, rel);
      if (existsSync(to)) {
        if (readFileSync(to).equals(readFileSync(from))) { out.same.push(shown); continue; }
        if (!force) { out.kept.push(shown); continue; }
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      out.copied.push(shown);
    }
  }
  return out;
}
