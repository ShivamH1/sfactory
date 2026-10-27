import { fail } from "./errors.mjs";

const norm = (p) => p.trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "");
const id = (s) => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase());
const ID = "\\d+[a-z]?";

function pathsOf(rest) {
  const ticked = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const items = ticked.length ? ticked : rest.split(",");
  return items.map(norm).filter(Boolean);
}

/**
 * Strict plan reader. Fails closed: a plan with no tasks, a task with no Files
 * lines, or a duplicate task number is an error, never an empty answer.
 */
export function parsePlan(md) {
  const tasks = [];
  let cur = null;
  let fenced = false;
  const heading = new RegExp(`^#{2,3}\\s+Task\\s+(${ID})\\s*:\\s*(.+?)\\s*$`, "i");
  const after = new RegExp(`\\(after Task (${ID})\\)`, "i");
  const afterEnd = new RegExp(`\\s*\\(after Task (${ID})\\)\\s*$`, "i");
  const depends = /^\s*(?:-\s*)?\*{0,2}Depends on\s*\*{0,2}\s*:?\s*\*{0,2}\s*(.+)$/i;
  const fileLine = /^\s*[-*]\s*(Create|Modify|Test)\b\s*(:?)\s*(.+?)\s*$/i;
  for (const raw of String(md).split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
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
      for (const p of pathsOf(f[3])) cur.files.push({ op: f[1].toLowerCase(), path: p });
      continue;
    }
    const d = raw.match(depends);
    if (d) for (const m of d[1].matchAll(new RegExp(`\\b${ID}\\b`, "gi"))) { const n = id(m[0]); if (!cur.dependsOn.includes(n)) cur.dependsOn.push(n); }
  }
  if (!tasks.length) fail("PLAN_NO_TASKS", "no '## Task N:' or '### Task N:' headings found");
  for (const t of tasks) if (!t.files.length) fail("PLAN_TASK_NO_FILES", `Task ${t.n} has no Files lines`);
  return { tasks };
}
