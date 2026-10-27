import { fail } from "./errors.mjs";

const norm = (p) => p.trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "");
const id = (s) => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase());
const ID = "\\d+[a-z]?";

function pathsOf(rest, n) {
  const ticked = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (ticked.length) {
    const rem = rest.replace(/`[^`]+`/g, "").replace(/,/g, "").replace(/\band\b/gi, "").replace(/\s+/g, "");
    if (rem) fail("PLAN_BAD_FILE_LINE", `Task ${n}: unquoted text beside backticked paths: "${rem}" - wrap every path in backticks`);
    return ticked.map(norm).filter(Boolean);
  }
  return rest.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    if (!/^\S+$/.test(x)) fail("PLAN_BAD_FILE_LINE", `Task ${n}: cannot read file item "${x}" - wrap paths in backticks`);
    return norm(x);
  });
}

/**
 * Strict plan reader. Fails closed: a plan with no tasks, a task with no Files
 * lines, or a duplicate task number is an error, never an empty answer.
 */
export function parsePlan(md) {
  const tasks = [];
  let cur = null;
  let fence = null;   // { ch, len } while inside a fenced block
  const heading = new RegExp(`^#{2,3}\\s+Task\\s+(${ID})\\s*:\\s*(.+?)\\s*$`, "i");
  const after = new RegExp(`\\(after Task (${ID})\\)`, "i");
  const afterEnd = new RegExp(`\\s*\\(after Task (${ID})\\)\\s*$`, "i");
  const depends = /^\s*(?:-\s*)?\*{0,2}Depends on\s*\*{0,2}\s*:?\s*\*{0,2}\s*(.+)$/i;
  const fileLine = /^\s*[-*]\s*(Create|Modify|Test)\b\s*(:?)\s*(.+?)\s*$/i;
  for (const raw of String(md).split(/\r?\n/)) {
    if (fence) {
      const c = raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      continue;
    }
    const o = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (o && !(o[1][0] === "`" && o[2].includes("`"))) { fence = { ch: o[1][0], len: o[1].length }; continue; }
    const h = raw.match(heading);
    if (h) {
      const n = id(h[1]);
      if (tasks.some((t) => t.n === n)) fail("PLAN_DUPLICATE_TASK", `Task ${h[1]} appears more than once`);
      cur = { n, title: h[2].replace(afterEnd, "").trim(), files: [], dependsOn: [] };
      const a = h[2].match(after); if (a) cur.dependsOn.push(id(a[1]));
      tasks.push(cur); continue;
    }
    if (!cur) continue;
    const f = raw.match(fileLine);
    if (f && (f[2] === ":" || f[3].startsWith("`"))) {
      for (const p of pathsOf(f[3], cur.n)) cur.files.push({ op: f[1].toLowerCase(), path: p });
      continue;
    }
    const d = raw.match(depends);
    if (d) for (const m of d[1].matchAll(new RegExp(`\\b${ID}\\b`, "gi"))) { const n = id(m[0]); if (!cur.dependsOn.includes(n)) cur.dependsOn.push(n); }
  }
  if (fence) fail("PLAN_UNCLOSED_FENCE", "a fenced code block is never closed; everything after it would be hidden");
  if (!tasks.length) fail("PLAN_NO_TASKS", "no '## Task N:' or '### Task N:' headings found");
  for (const t of tasks) if (!t.files.length) fail("PLAN_TASK_NO_FILES", `Task ${t.n} has no Files lines`);
  return { tasks };
}
