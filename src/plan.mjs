import { fail } from "./errors.mjs";

const norm = (p) => p.trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "");
const id = (s) => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase());
const ID = "\\d+[a-z]?";
const OPS = "Create|Modify|Test|Delete|Read|Add|Remove|Edit|Rename|Move|Touch";
const FILE = /^[\w.-]+\.([A-Za-z0-9]{1,6})$/;
const TICKED = /`([^`]+)`/g;

/**
 * Path-like: a token that contains a slash or backslash (a run of slashes
 * alone is a separator, as in "`a` / `b`"), starts with ":" and goes on
 * (":80-87" alone is a line range, not a path), is a dotfile, or is a filename
 * with an extension. The last three are judged once wrapping brackets, quotes,
 * emphasis and trailing punctuation are stripped. The extension must hold a
 * letter, so "M44.1", "19.1" or "0.28" in prose are numbers, not files. A
 * free-standing "." or ".." is judged by the caller.
 */
function pathLike(tok) {
  if (/^[/\\]+$/.test(tok)) return false;
  if (/[/\\]/.test(tok)) return true;
  const core = tok.replace(/^[(\[{"'*_]+/, "").replace(/[)\]}"'*_,;:!?]+$/, "");
  if (/^:\d+([-–]\d+)?\.?$/.test(core)) return false;
  if (/^:./.test(core)) return true;
  if (/^\.[A-Za-z][\w.-]*$/.test(core.replace(/\.$/, ""))) return true;
  return [core, core.replace(/\.$/, "")].some((c) => { const m = c.match(FILE); return !!m && /[A-Za-z]/.test(m[1]); });
}

const isPathToken = (t) => /^\S+$/.test(t) && (t === "." || t === ".." || pathLike(t));

/** Backticked items on a line whose content is one whitespace-free path-like token. */
const tickedPaths = (line) => [...line.matchAll(TICKED)].map((m) => m[1].trim()).filter(isPathToken);

/**
 * Prose beside backticked items is allowed when it names no path. A piece
 * glued to a backticked item ("`t.ts`.") is punctuation unless it is itself
 * path-like; a free-standing "." or ".." is a path.
 */
function checkProse(rest, where) {
  for (const tok of rest.replace(TICKED, "\u0000").split(/[\s,]+/)) {
    const glued = tok.includes("\u0000");
    for (const piece of tok.split("\u0000")) {
      if (!piece || (!glued && /^and$/i.test(piece))) continue;
      if ((!glued && (piece === "." || piece === "..")) || pathLike(piece)) {
        fail("PLAN_BAD_FILE_LINE", `${where}: unquoted path-like text "${piece}" beside backticked paths - wrap every path in backticks`);
      }
    }
  }
}

function tickedItems(rest, where) {
  checkProse(rest, where);
  return [...rest.matchAll(TICKED)].map((m) => {
    const p = norm(m[1]);
    if (!p) fail("PLAN_BAD_FILE_LINE", `${where}: an empty backticked file item`);
    return p;
  });
}

/** The paths named on a Files line's text after the op (or after the Files label). */
function pathsOf(rest, where) {
  if (/^none\b/i.test(rest)) {
    // An explicit "none": names no file unless it backticks some (taken, fail closed).
    if (rest.includes("`")) return tickedItems(rest, where);
    checkProse(rest, where);
    return [];
  }
  if (rest.includes("`")) {
    if (![...rest.matchAll(TICKED)].length) fail("PLAN_BAD_FILE_LINE", `${where}: cannot read file item "${rest}"`);
    return tickedItems(rest, where);
  }
  return rest.split(",").map((x) => x.trim()).map((x) => {
    if (!isPathToken(x)) fail("PLAN_BAD_FILE_LINE", `${where}: cannot read file item "${x}" - wrap paths in backticks`);
    const p = norm(x);
    if (!p) fail("PLAN_BAD_FILE_LINE", `${where}: cannot read file item "${x}"`);
    return p;
  });
}

/**
 * A Files line: "- Op: items", "- Op `item` ...", or "- Op (qualifier): `item`"
 * / "- Op then delete: `item`" (a qualifier needs a backticked item after the
 * colon). The colon-less form needs its first backticked item to be one
 * whitespace-free token, so "- add `import x from y`" is a step, not a file.
 * Returns { op, rest } or null.
 */
function fileLine(raw) {
  const m = raw.match(new RegExp(`^\\s*[-*]\\s+(${OPS})\\b(.*)$`, "i"));
  if (!m) return null;
  const op = m[1].toLowerCase(), after = m[2].trimEnd();
  let x = after.match(/^\s*:\s*(.*)$/);
  if (x) return { op, rest: x[1] };
  x = after.match(/^\s*(`([^`]+)`.*)$/);
  if (x) return /^\S+$/.test(x[2].trim()) ? { op, rest: x[1] } : null;
  x = after.match(/^([^:`]{1,60}):\s*(.*)$/);
  if (x && /`[^`]+`/.test(x[2])) return { op, rest: x[2] };
  return null;
}

/**
 * Strict plan reader. Fails closed: a plan with no tasks, a task that names a
 * backticked path but has no Files lines, a plan with no files at all, or a
 * duplicate task number is an error, never an empty answer. A task with no
 * Files lines whose text names no backticked path, or that says "**Files:**
 * none", is accepted with `files: []`.
 *
 * A Files line continues onto the following lines while they are indented, or
 * while the line before ended with a comma; a continuation's backticked items
 * are files of the same op, and its prose obeys the same rule.
 */
export function parsePlan(md) {
  const tasks = [];
  const mentions = new Map();   // task -> first backticked path-like token outside a Files line
  const declared = new Set();   // tasks with a Files line, even one naming none
  let cur = null;
  let level = 0;      // the current task heading's level
  let fence = null;   // { ch, len } while inside a fenced block
  let cont = null;    // { op, comma } while a Files line may continue
  const heading = new RegExp(`^#{2,3}\\s+Task\\s+(${ID})\\s*:\\s*(.+?)\\s*$`, "i");
  const after = new RegExp(`\\(after Task (${ID})\\)`, "i");
  const afterEnd = new RegExp(`\\s*\\(after Task (${ID})\\)\\s*$`, "i");
  const depends = /^\s*(?:-\s*)?\*{0,2}Depends on\s*\*{0,2}\s*:?\s*\*{0,2}\s*(.+)$/i;
  const label = /^\s*(?:[-*]\s+)?\*\*Files\s*:?\s*\*\*\s*:?\s*(.*?)\s*$/i;
  const note = (line) => { if (cur && !mentions.has(cur)) { const p = tickedPaths(line)[0]; if (p) mentions.set(cur, p); } };
  const add = (op, rest, where) => {
    // "- add:" with nothing after it introduces a step's code block; it is a
    // Files line only if indented items follow it (a nested list).
    if (!rest) { cont = { op, comma: false }; return; }
    declared.add(cur);
    for (const p of pathsOf(rest, where)) cur.files.push({ op, path: p });
    cont = { op, comma: /,\s*$/.test(rest) };
  };
  const lines = String(md).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const where = () => `Task ${cur.n} (line ${i + 1})`;
    if (fence) {
      const c = raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      continue;
    }
    const o = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (o && !(o[1][0] === "`" && o[2].includes("`"))) { fence = { ch: o[1][0], len: o[1].length }; cont = null; continue; }
    const h = raw.match(heading);
    if (h) {
      const n = id(h[1]);
      if (tasks.some((t) => t.n === n)) fail("PLAN_DUPLICATE_TASK", `Task ${h[1]} appears more than once`);
      cur = { n, title: h[2].replace(afterEnd, "").trim(), files: [], dependsOn: [] };
      level = raw.match(/^#+/)[0].length;
      const a = h[2].match(after); if (a) cur.dependsOn.push(id(a[1]));
      tasks.push(cur); note(h[2]); cont = null; continue;
    }
    // A heading at the task's level or above ("## Self-review") ends its section.
    const other = raw.match(/^(#{1,6})\s/);
    if (cur && other && other[1].length <= level) { cur = null; cont = null; }
    if (!cur) continue;
    const f = fileLine(raw);
    if (f) { add(f.op, f.rest, where()); continue; }
    if (cont && raw.trim() && !/^\s*#/.test(raw) && (/^\s/.test(raw) || cont.comma)) {
      const text = raw.trim().replace(/^[-*]\s+/, "");
      const ps = text.includes("`") ? tickedItems(text, where()) : (checkProse(text, where()), []);
      if (ps.length) declared.add(cur);
      for (const p of ps) cur.files.push({ op: cont.op, path: p });
      cont.comma = /,\s*$/.test(text);
      continue;
    }
    cont = null;
    const l = raw.match(label);
    if (l) { if (l[1]) add("touch", l[1], where()); continue; }
    note(raw);
    const d = raw.match(depends);
    if (d) for (const m of d[1].matchAll(new RegExp(`\\b${ID}\\b`, "gi"))) { const n = id(m[0]); if (!cur.dependsOn.includes(n)) cur.dependsOn.push(n); }
  }
  if (fence) fail("PLAN_UNCLOSED_FENCE", "a fenced code block is never closed; everything after it would be hidden");
  if (!tasks.length) fail("PLAN_NO_TASKS", "no '## Task N:' or '### Task N:' headings found");
  for (const t of tasks) if (!declared.has(t) && mentions.has(t)) fail("PLAN_TASK_NO_FILES", `Task ${t.n} mentions paths but has no Files lines (first: \`${mentions.get(t)}\`)`);
  if (tasks.every((t) => !t.files.length)) fail("PLAN_NO_FILES", "no task has a Files line");
  return { tasks };
}
