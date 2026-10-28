import { fail } from "./errors.mjs";

const norm = (p) => p.trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "");
const id = (s) => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase());
const ID = "\\d+[a-z]?";
const OPS = "Create|Modify|Test|Delete|Read|Add|Remove|Edit|Rename|Move|Touch";
/** A list marker: "-", "*", "+", or an ordered "1." / "1)" (R2-5). */
const BULLET = "(?:[-*+]|\\d+[.)])";
const BULLET_RE = new RegExp(`^\\s*${BULLET}\\s+`);
const FILE = /^[\w.-]+\.([A-Za-z0-9]{1,6})$/;
const TICKED = /`([^`]+)`/g;
/** Extension-less names that are files wherever they stand on a Files line (N4). */
const ALLOWED = new Set("Makefile Dockerfile Containerfile Procfile Gemfile Rakefile Jenkinsfile Vagrantfile Brewfile Justfile justfile LICENSE LICENCE COPYING NOTICE README CHANGELOG AUTHORS CODEOWNERS VERSION".split(" "));
const BARE = /^[\w.-]+$/;
/** What may stand beside a Files line's items without being prose. */
const SEPARATOR = /^([.,;:/&()[\]–—-]+|and|or)$/i;

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

/**
 * A backticked item is a path only if it is path-like ("." and ".." included);
 * an identifier (`register`), code, or an item that opens with a quote (a
 * route string such as `"/me/wallet"`) is prose and ignored - except as below.
 */
const tickedIsPath = (s) => { const t = s.trim(); return !/^["']/.test(t) && (t === "." || t === ".." || pathLike(t)); };

/**
 * The backticked items of a Files line's text: { paths, prose }. An item is a
 * path when it is path-like or an allow-listed name (`Makefile`, `LICENSE`);
 * with `first`, the text's first backticked item - the op's object - is also a
 * path when it is a bare [\w.-]+ word (`src`, N4) or a quoted path-like token.
 * `prose` says the text holds something beside its paths and separators: a
 * word, or a backticked item that is not a path.
 */
function tickedItems(rest, where, first = false) {
  checkProse(rest, where);
  const paths = [];
  let prose = false;
  [...rest.matchAll(TICKED)].forEach((m, i) => {
    const s = m[1].trim();
    let p = tickedIsPath(s) || ALLOWED.has(s) || (first && i === 0 && BARE.test(s)) ? s : null;
    if (p === null && first && i === 0) { const q = s.match(/^(["'])(.+)\1$/); if (q && isPathToken(q[2].trim())) p = q[2].trim(); }
    if (p === null) { prose = true; return; }
    const n = norm(p);
    if (!n) fail("PLAN_BAD_FILE_LINE", `${where}: an empty backticked file item`);
    paths.push(n);
  });
  if (rest.replace(TICKED, " ").split(/[\s,;]+/).some((t) => t && !SEPARATOR.test(t))) prose = true;
  return { paths, prose };
}

/** The paths named on a Files line's text after the op (or after the Files label): { paths, prose }. */
function pathsOf(rest, where) {
  if (/^none\b/i.test(rest)) {
    // An explicit "none": names no file unless it backticks some (taken, fail closed).
    if (rest.includes("`")) return tickedItems(rest, where);
    checkProse(rest, where);
    return { paths: [], prose: true };
  }
  if (rest.includes("`")) {
    if (![...rest.matchAll(TICKED)].length) fail("PLAN_BAD_FILE_LINE", `${where}: cannot read file item "${rest}"`);
    return tickedItems(rest, where, true);
  }
  const paths = rest.split(",").map((x) => x.trim()).map((x) => {
    if (!isPathToken(x)) fail("PLAN_BAD_FILE_LINE", `${where}: cannot read file item "${x}" - wrap paths in backticks`);
    const p = norm(x);
    if (!p) fail("PLAN_BAD_FILE_LINE", `${where}: cannot read file item "${x}"`);
    return p;
  });
  return { paths, prose: false };
}

/**
 * A Files line: "- Op: items", "- Op `item` ...", or "- Op (qualifier): `item`"
 * / "- Op then delete: `item`" (a qualifier needs a backticked item after the
 * colon). The colon-less form needs its first backticked item to be one
 * whitespace-free token, so "- add `import x from y`" is a step, not a file.
 * Returns { op, rest, plain } or null; `plain` is the "- Op: items" form.
 */
function fileLine(raw) {
  const m = raw.match(new RegExp(`^\\s*${BULLET}\\s+(${OPS})\\b(.*)$`, "i"));
  if (!m) return null;
  const op = m[1].toLowerCase(), after = m[2].trimEnd();
  let x = after.match(/^\s*:\s*(.*)$/);
  if (x) return { op, rest: x[1], plain: true };
  x = after.match(/^\s*(`([^`]+)`.*)$/);
  if (x) return /^\S+$/.test(x[2].trim()) ? { op, rest: x[1], plain: false } : null;
  x = after.match(/^([^:`]{1,60}):\s*(.*)$/);
  if (x && /`[^`]+`/.test(x[2])) return { op, rest: x[2], plain: false };
  return null;
}

/** Ids in a text; a numeric range ("2-4", "2–4", "2 to 4") stands for every id in it. */
const RANGE = new RegExp(`\\b(${ID})\\b(?:\\s*(?:\\bto\\b|[-\\u2013\\u2014])\\s*(${ID})\\b)?`, "gi");
function idsIn(text) {
  const out = [];
  for (const m of text.matchAll(RANGE)) {
    const a = id(m[1]);
    out.push(a);
    if (!m[2]) continue;
    const b = id(m[2]);
    if (typeof a === "number" && typeof b === "number" && b > a && b - a <= 100) for (let x = a + 1; x <= b; x++) out.push(x);
    else out.push(b);
  }
  return out;
}

/**
 * A Consumes line's dependencies fail closed (R2-1): every number in it that
 * names a task earlier in the plan (by position, R2-2) counts, ranges included,
 * except the digits of a full ISO date. A number naming no earlier task is
 * prose there. "M44" or "T17" is not a number of its own. Over-serialising
 * ("Task 1, 3 days later" waits for Task 3 too) is accepted.
 */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** A `**Files…:**` label standing mid-line, after a Consumes or Depends on line's text (R2-5). */
const MID_LABEL = /\*\*Files(?:\s*\([^)]*\))?\s*:?\s*\*\*\s*:?/i;

/**
 * Strict plan reader. Fails closed: a plan with no tasks, a task that names a
 * backticked path but has no Files lines, a plan with no files at all, a
 * duplicate task number, or a Files line outside any task is an error, never
 * an empty answer. A task with no Files lines whose text names no backticked
 * path, or that says "**Files:** none", is accepted with `files: []`; an op
 * line saying "none" ("- Modify: none") declares nothing.
 *
 * A Files line continues onto the following lines while they are indented, or
 * while the line before ended with a comma; a continuation's backticked items
 * are files of the same op, and its prose obeys the same rule. A Files line
 * that yields no path (and does not say "none") is read like prose for the
 * mention check.
 *
 * A Read line touches nothing and never declares its task; one in the
 * colon-less or qualified form, or with prose beside its items, may hide a
 * write and records its items as `touch` instead (N2).
 *
 * Dependencies come from "Depends on" lines, "(after Task N)" in a title, and
 * Consumes lines naming "Task N". `dependencyInfo` is "declared" when any task
 * has a dependency source (a Depends on line naming a task or "none", a title's
 * "after", a Consumes line naming a task of this plan), else "none".
 */
export function parsePlan(md) {
  const tasks = [];
  const mentions = new Map();   // task -> first backticked path-like token outside a Files line
  const declared = new Set();   // tasks with a Files line that names a written file, or "**Files:** none"
  let cur = null;
  let level = 0;      // the current task heading's level
  let fence = null;   // { ch, len } while inside a fenced block
  // { op, comma, list, label } while a Files line may continue: `list` after a
  // bare "- Op:" or label (nested items), `label` inside a Files label's list,
  // where an unindented bullet is an item too (R2-4).
  let cont = null;
  let consumes = false;   // while a Consumes line may continue onto indented lines
  let depInfo = false;
  // CommonMark: a heading may be indented up to three spaces (R2-5).
  const heading = new RegExp(`^ {0,3}#{2,3}\\s+Task\\s+(${ID})\\s*:\\s*(.+?)\\s*$`, "i");
  const after = new RegExp(`\\(after Task (${ID})\\)`, "i");
  const afterEnd = new RegExp(`\\s*\\(after Task (${ID})\\)\\s*$`, "i");
  const depends = new RegExp(`^\\s*(?:${BULLET}\\s*)?\\*{0,2}Depends on\\s*\\*{0,2}\\s*:?\\s*\\*{0,2}\\s*(.+)$`, "i");
  const consumesLine = new RegExp(`^\\s*(?:${BULLET}\\s+)?\\*{0,2}Consumes\\b([^:]*):(.*)$`, "i");
  // "**Files:**", "**Files**:", "**Files (anything):**", or a plain "Files:" (R2-5).
  const label = new RegExp(`^\\s*(?:${BULLET}\\s+)?(?:\\*\\*Files(?:\\s*\\([^)]*\\))?\\s*:?\\s*\\*\\*\\s*:?|Files(?:\\s*\\([^)]*\\))?\\s*:)\\s*(.*?)\\s*$`, "i");
  const itemBullet = new RegExp(`^\\s*${BULLET}\\s+\``);
  const note = (line) => { if (cur && !mentions.has(cur)) { const p = tickedPaths(line)[0]; if (p) mentions.set(cur, p); } };
  const depend = (ns) => { for (const n of ns) if (!cur.dependsOn.includes(n)) cur.dependsOn.push(n); };
  // A Consumes line names only tasks earlier in the plan (R2-2), and every
  // number naming one counts (R2-1). Depends on lines stay literal.
  const consume = (text) => {
    const before = new Set(tasks.slice(0, -1).map((t) => t.n));   // cur is the last task pushed
    const ns = idsIn(text.replace(ISO_DATE, " ")).filter((n) => before.has(n));
    if (ns.length) depInfo = true;
    depend(ns);
  };
  /** A dependency line's text and the rest after a mid-line Files label, or null. */
  const splitLabel = (s) => { const m = s.match(MID_LABEL); return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length).trim()] : [s, null]; };
  /** Record a Files line's items under `op`; a read with prose beside its items becomes touch. */
  const record = (op, r, text) => {
    const o = op === "read" && r.prose ? "touch" : op;
    if (r.paths.length && o !== "read") declared.add(cur);
    if (!r.paths.length && !/^none\b/i.test(text)) note(text);
    for (const p of r.paths) cur.files.push({ op: o, path: p });
    return o;
  };
  const add = (op, rest, where, { plain = true, isLabel = false } = {}) => {
    // "- add:" with nothing after it introduces a step's code block; it is a
    // Files line only if indented items follow it (a nested list).
    // A label's list stays a label's list across its op lines.
    const inLabel = isLabel || !!cont?.label;
    if (!rest) { cont = { op, comma: false, list: true, label: inLabel }; return; }
    const r = pathsOf(rest, where);
    // Only the "**Files:** none" label declares a file-less task (N5).
    if (isLabel && /^none\b/i.test(rest)) declared.add(cur);
    // A read in the colon-less or qualified form may hide a write (N2).
    const o = record(op === "read" && !plain ? "touch" : op, r, rest);
    cont = { op: o, comma: /,\s*$/.test(rest), label: inLabel };
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
    if (o && !(o[1][0] === "`" && o[2].includes("`"))) { fence = { ch: o[1][0], len: o[1].length }; cont = null; consumes = false; continue; }
    const h = raw.match(heading);
    if (h) {
      const n = id(h[1]);
      if (tasks.some((t) => t.n === n)) fail("PLAN_DUPLICATE_TASK", `Task ${h[1]} appears more than once`);
      cur = { n, title: h[2].replace(afterEnd, "").trim(), files: [], dependsOn: [] };
      level = raw.trim().match(/^#+/)[0].length;
      const a = h[2].match(after); if (a) { cur.dependsOn.push(id(a[1])); depInfo = true; }
      tasks.push(cur); note(h[2]); cont = null; consumes = false; continue;
    }
    // A heading at the task's level or above ("## Self-review") ends its section.
    const other = raw.match(/^ {0,3}(#{1,6})\s/);
    if (cur && other && other[1].length <= level) { cur = null; cont = null; consumes = false; }
    if (!cur) {
      // N1: a Files line with no open task would be silently dropped.
      if (fileLine(raw) || label.test(raw)) fail("PLAN_FILES_OUTSIDE_TASK", `line ${i + 1}: a Files line outside any task ("${raw.trim()}") - put it under its task's heading`);
      continue;
    }
    // Dependency lines come before the continuation branch, so a Files line
    // ending in a comma cannot swallow them (N3). They leave an open Files list
    // open: the items after them are still its items (R2-3). A `**Files:**`
    // label later on the same line is a label (R2-5).
    const d = raw.match(depends);
    if (d) {
      const [text, tail] = splitLabel(d[1]);
      const ns = idsIn(text);
      if (ns.length || /^\W*none\b/i.test(text)) depInfo = true;
      depend(ns); note(raw); consumes = false;
      if (tail !== null) add("touch", tail, where(), { isLabel: true });
      continue;
    }
    const c = raw.match(consumesLine);
    if (c) {
      const [text, tail] = splitLabel(c[1] + " " + c[2]);
      consume(text); note(raw); consumes = tail === null;
      if (tail !== null) add("touch", tail, where(), { isLabel: true });
      continue;
    }
    const f = fileLine(raw);
    if (f) { consumes = false; add(f.op, f.rest, where(), { plain: f.plain }); continue; }
    // A Files label ends a Consumes line; it is never its continuation (C1).
    // Inside an open Files list a wrapped Consumes line is read both ways.
    let both = false;
    if (consumes && /^\s+\S/.test(raw) && !label.test(raw)) { consume(raw); note(raw); if (!cont) continue; both = true; }
    if (!both) consumes = false;
    const bare = cont?.label && !/^\s/.test(raw) && !cont.comma && BULLET_RE.test(raw);
    if (cont && raw.trim() && !/^\s*#/.test(raw) && !label.test(raw) && (/^\s/.test(raw) || cont.comma || bare)) {
      const text = raw.trim().replace(BULLET_RE, "");
      // In a nested item list under a bare "- Op:" or label, an item that opens its bullet is the op's object.
      const item = (!!cont.list || bare) && itemBullet.test(raw);
      const r = text.includes("`") ? tickedItems(text, where(), item) : (checkProse(text, where()), { paths: [], prose: true });
      // An unindented bullet in a label's list carries no op of its own.
      record(bare ? "touch" : cont.op, r, text);
      cont.comma = /,\s*$/.test(text);
      continue;
    }
    cont = null;
    const l = raw.match(label);
    if (l) { add("touch", l[1], where(), { isLabel: true }); continue; }
    note(raw);
  }
  if (fence) fail("PLAN_UNCLOSED_FENCE", "a fenced code block is never closed; everything after it would be hidden");
  if (!tasks.length) fail("PLAN_NO_TASKS", "no '## Task N:' or '### Task N:' headings found");
  for (const t of tasks) if (!declared.has(t) && mentions.has(t)) fail("PLAN_TASK_NO_FILES", `Task ${t.n} mentions paths but has no Files lines (first: \`${mentions.get(t)}\`)`);
  if (tasks.every((t) => !t.files.length)) fail("PLAN_NO_FILES", "no task has a Files line");
  return { tasks, dependencyInfo: depInfo ? "declared" : "none" };
}
