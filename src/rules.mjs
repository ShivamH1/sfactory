import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fail } from "./errors.mjs";

const TOOL_OF = { "AGENTS.md": "Codex", "CLAUDE.md": "Claude Code" };
const lf = (s) => s.replace(/\r\n/g, "\n");

/** Rewrite "guidance to Claude Code" (and its "(claude.ai/code)" tag) to the target's tool name, in the first lines only. */
export function adaptText(text, targetName) {
  const tool = TOOL_OF[basename(targetName)];
  if (!tool) return text;
  const lines = text.split("\n");
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (/guidance to Claude Code/.test(lines[i])) {
      lines[i] = lines[i].replace(/guidance to Claude Code( \(claude\.ai\/code\))?/, `guidance to ${tool}`);
      break;
    }
  }
  return lines.join("\n");
}

/**
 * Make every rules file after the first identical to rules[0] (LF-compared). Returns { source, differs, written }.
 * With check, nothing is written. A target keeps its own line-ending style; a new one takes the source's.
 */
export function syncRules(root, rules, { check = false } = {}) {
  if (!Array.isArray(rules) || rules.length < 2) fail("RULES_NEEDED", "sync-rules needs at least two paths in the config's rules (the first is the source)");
  const srcPath = join(root, rules[0]);
  if (!existsSync(srcPath)) fail("RULES_SOURCE_MISSING", `${rules[0]} does not exist`);
  const srcRaw = readFileSync(srcPath, "utf8");
  const srcText = lf(srcRaw);
  const differs = [], written = [];
  for (const t of rules.slice(1)) {
    const p = join(root, t);
    const want = adaptText(srcText, t);
    const have = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (have !== null && lf(have) === want) continue;
    differs.push(t);
    if (check) continue;
    const crlf = have !== null ? have.includes("\r\n") : srcRaw.includes("\r\n");
    writeFileSync(p, crlf ? want.replace(/\n/g, "\r\n") : want);
    written.push(t);
  }
  return { source: rules[0], differs, written };
}
