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

/** Ids in a text; a numeric range ("2-4", "2–4", "2 to 4", "2 through 4", "2..4") stands for every id in it. */
const RANGE = new RegExp(`\\b(${ID})\\b(?:\\s*(?:\\bto\\b|\\bthrough\\b|\\bthru\\b|\\.\\.|[-\\u2013\\u2014])\\s*(${ID})\\b)?`, "gi");
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
/** "T5" and "Task5" read as "5" (S2, R4-1). */
const spaced = (s) => s.replace(/\bT(?=\d)/g, " ").replace(/\b(Tasks?)(?=\d)/gi, "$1 ");
/** A Depends on label's ids, read literally (a missing task is a loud error at batch time). */
const depIds = (s) => idsIn(spaced(s));
const NONE = /^[\W_]*none(?![a-z0-9])/i;

/** Leading columns of a line; a tab advances to the next multiple of four. */
function indentOf(s) {
  let col = 0;
  for (const ch of s) { if (ch === " ") col++; else if (ch === "\t") col += 4 - (col % 4); else break; }
  return col;
}

/** At most `max` blockquote markers ("> ", nested) stripped: { q, s } (R4-3). */
function unquote(line, max = Infinity) {
  let q = 0, s = line, m;
  while (q < max && (m = s.match(/^ {0,3}>[ \t]?/))) { s = s.slice(m[0].length); q++; }
  return { q, s };
}

const LIST_ITEM = /^([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Index of the next run of exactly `n` backticks at or after `from`, or -1. */
function runAt(s, from, n) {
  const re = /`+/g;
  re.lastIndex = from;
  for (let m; (m = re.exec(s)); ) if (m[0].length === n) return m.index;
  return -1;
}

/**
 * A line with its HTML comments removed, outside code spans: { text, open },
 * `open` being where a comment starts that does not end on the line (else -1).
 * A comment ends at the first "-->" after its "<!--", so "<!-->" ends at once.
 */
function uncomment(s) {
  let out = "", i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const n = s.slice(i).match(/^`+/)[0].length, end = runAt(s, i + n, n);
      const to = end >= 0 ? end + n : i + n;
      out += s.slice(i, to); i = to;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 2);
      if (end < 0) return { text: out, open: out.length };
      out += " "; i = end + 3;
      continue;
    }
    out += s[i++];
  }
  return { text: out, open: -1 };
}

/**
 * The plan's lines as the parser reads them (R4-3). Fenced code, indented
 * code and HTML comments are blanked or dropped for every reading, and
 * blockquote markers are stripped so a quoted line is read normally.
 *
 * A light CommonMark block model decides what is code: list items are tracked
 * by their content column, so a line indented under an item is that item's
 * content (a nested list, a wrapped line), and only a line four columns past
 * its container, after something that is not a paragraph, is indented code. A
 * fence belongs to the item or quote it opens in; one that its item or quote
 * ends before a closing fence does is refused (round 5, N1), since the stray
 * closer would re-pair with a later fence and swallow what lies between.
 *
 * A comment opening a line is an HTML block and runs to the first "-->",
 * blank lines included; one never closed is refused. A comment opening
 * mid-line spans lines only up to a blank line; those lines are kept and
 * marked `suspect` - read for files and ordering (fail closed), never trusted
 * to declare the plan - because a code span across lines cannot be told apart
 * from one here.
 *
 * Returns [{ text, no, suspect, code? }]; a line that held only a comment is
 * left out, and a line skipped as code carries its raw text as `code`, read
 * for path mentions only (round 5, O1).
 */
function scan(md) {
  const raw = String(md).split(/\r?\n/);
  const out = [];
  // `code` is the raw text of a line skipped as code: read for path mentions only (round 5, O1).
  const keep = (text, no, suspect, code) => out.push(code === undefined ? { text, no, suspect } : { text, no, suspect, code });
  let fence = null;     // { ch, len, col, q, no } while inside a fenced block
  let comment = 0;      // the line a block-level comment opened on, while it is open
  let stack = [];       // content columns of the open list items, innermost last
  let prev = "blank";   // the previous line: blank | para | code | other
  let prevQ = 0;
  let suspectTo = -1;   // the last line of a mid-line comment that spans lines
  for (let i = 0; i < raw.length; i++) {
    const no = i + 1, suspect = i <= suspectTo;
    if (comment) {
      const end = raw[i].indexOf("-->");
      if (end < 0) continue;
      comment = 0; prev = "other";
      // The rest of the closing line is read (it renders as text).
      const u = uncomment(raw[i].slice(end + 3));
      if (u.open >= 0) comment = no;
      if (u.text.trim()) keep(u.text, no, suspect);
      continue;
    }
    if (fence) {
      const u = unquote(raw[i], fence.q);
      const ind = indentOf(u.s);
      // A fence ends with its quote (a line without the marker) or its list item (a line indented less).
      // Ended so, not by a closer, it is refused (round 5, N1): a closer at the wrong
      // indent, or a heredoc's EOF, would otherwise re-pair the fences after it and
      // swallow the Files lines between.
      if (u.q < fence.q || (!!u.s.trim() && ind < fence.col)) {
        fail("PLAN_UNCLOSED_FENCE", `a fenced code block opened on line ${fence.no} is ended on line ${no} by its ${u.q < fence.q ? "blockquote" : "list item"}, not by a closing fence; close it inside its container`);
      }
      const c = u.s.trim().match(/^(`{3,}|~{3,})$/);
      if (c && ind - fence.col <= 3 && c[1][0] === fence.ch && c[1].length >= fence.len) { fence = null; prev = "other"; }
      keep("", no, suspect, raw[i]);
      continue;
    }
    const { q, s } = unquote(raw[i]);
    if (!s.trim()) { keep("", no, suspect); prev = "blank"; if (q !== prevQ) { stack = []; prevQ = q; } continue; }
    if (q !== prevQ) { stack = []; prevQ = q; }
    const ind = indentOf(s), t = s.trimStart();
    const inner = [...stack].reverse().find((c) => c <= ind) ?? 0;
    const opener = ind - inner <= 3 && (LIST_ITEM.test(t) || /^#{1,6}(\s|$)/.test(t) || /^(`{3,}|~{3,})/.test(t) || THEMATIC.test(s) || t.startsWith("<!--"));
    if (prev === "para" && !opener) { const lt = lineText(s, i, false); if (lt !== null) keep(lt, no, suspect || i <= suspectTo); continue; }   // a paragraph's continuation
    while (stack.length && ind < stack[stack.length - 1]) stack.pop();
    const col = stack.length ? stack[stack.length - 1] : 0;
    if (ind - col >= 4) { keep("", no, suspect, raw[i]); prev = "code"; continue; }   // indented code
    const f = t.match(/^(`{3,}|~{3,})(.*)$/);
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) { fence = { ch: f[1][0], len: f[1].length, col, q, no }; keep("", no, suspect, raw[i]); prev = "other"; continue; }
    const li = t.match(LIST_ITEM);
    if (THEMATIC.test(s)) prev = "other";
    else if (li) {
      const gap = li[2].replace(/\t/g, "    ").length;
      stack.push(ind + li[1].length + (gap === 0 || gap > 4 ? 1 : gap));
      prev = "para";
    } else prev = /^#{1,6}(\s|$)/.test(t) ? "other" : "para";
    const text = lineText(s, i);
    if (text === null) { prev = "other"; continue; }   // a comment alone, or one opening an HTML block
    keep(text, no, suspect || i <= suspectTo);
  }
  if (fence) fail("PLAN_UNCLOSED_FENCE", `a fenced code block opened on line ${fence.no} is never closed; everything after it would be hidden`);
  if (comment) fail("PLAN_UNCLOSED_COMMENT", `an HTML comment opened on line ${comment} is never closed; everything after it would be hidden`);
  return out;

  /** The line with its comments removed; null when nothing but a comment is left. Opens a spanning comment as a side effect. */
  function lineText(s, i, block = true) {
    const u = uncomment(s);
    if (u.open < 0) return u.text.trim() || !s.includes("<!--") ? u.text : null;
    if (block && !u.text.trim()) { comment = i + 1; return null; }   // opens the line: an HTML block to the first "-->"
    // Mid-line: a comment only if "-->" comes before the paragraph ends; its lines stay readable, but suspect.
    for (let j = i + 1; j < raw.length && raw[j].trim(); j++) if (raw[j].includes("-->")) { suspectTo = Math.max(suspectTo, j); return s; }
    return s;
  }
}

/**
 * Strict plan reader. Fails closed: a plan with no tasks, a task that names a
 * backticked path but has no Files lines, a plan with no files at all, a
 * duplicate task number, or a Files line outside any task is an error, never
 * an empty answer. A task with no Files lines whose text names no backticked
 * path, or that says "**Files:** none", is accepted with `files: []`; an op
 * line saying "none" ("- Modify: none") declares nothing.
 *
 * Code (fenced or indented) and HTML comments are not read; a quoted line is
 * read as if unquoted (R4-3, see `scan`).
 *
 * A Files line continues onto the following lines while they are indented, or
 * while the line before ended with a comma; a continuation's backticked items
 * are files of the same op, and its prose obeys the same rule. Right after a
 * Files line, any unindented line that is not a bullet, a heading or a label
 * continues it too (R4-4). A Files line that yields no path (and does not say
 * "none") is read like prose for the mention check.
 *
 * A Read line touches nothing and never declares its task; one in the
 * colon-less or qualified form, or with prose beside its items, may hide a
 * write and records its items as `touch` instead (N2).
 *
 * Dependencies come from "Depends on" labels, "(after Task N)" in a title,
 * Consumes lines and loose "Depends on Task N" lines naming earlier tasks; a
 * dependency label or Consumes line outside any task is an error. A Depends on
 * label must name task ids ("Task 2", "T2", "Tasks 1 through 3", or an empty
 * label's nested list) or say "none"; anything else is PLAN_BAD_DEPENDENCY.
 * `dependencyInfo` is "declared" only when every task carries its own Depends
 * on label (R4-1), else "none", and `missingDependsOn` lists the tasks without
 * one: edges read from prose order tasks but never prove they may run in
 * parallel.
 *
 * A Files list survives blank lines while the next non-blank line is a list
 * item (not a "[ ]" step) or an indented line (S4). An empty Files label, and
 * a bare op line other than "add", must have something read under it (round 5,
 * N2). A loose "depends on" line met while a Files list is open is read both
 * as ordering and as the list's continuation (N3). A "**Files:** none" inside a
 * comment spanning lines exempts nothing (N4), and a line skipped as code still
 * counts as a path mention (O1).
 */
export function parsePlan(md) {
  const lines = scan(md);
  const tasks = [];
  const mentions = new Map();   // task -> first backticked path-like token outside a Files line
  const declared = new Set();   // tasks with a Files line that names a written file, or "**Files:** none"
  const labelled = new Set();   // tasks with their own Depends on label (R4-1)
  let cur = null;
  let level = 0;      // the current task heading's level
  // { op, comma, list, label } while a Files line may continue: `list` after a
  // bare "- Op:" or label (nested items), `label` inside a Files label's list,
  // where an unindented bullet is an item too (R2-4).
  let cont = null;
  let consumes = false;   // while a Consumes line may continue onto indented lines
  let depList = null;     // { indent, bulleted, items, no, task } after an empty Depends on label
  let emptyLabel = null;  // { at } while an empty Files label has nothing under it yet
  // CommonMark: a heading may be indented up to three spaces (R2-5).
  const heading = new RegExp(`^ {0,3}#{2,3}\\s+Task\\s+(${ID})\\s*:\\s*(.+?)\\s*$`, "i");
  const after = new RegExp(`\\(after Task (${ID})\\)`, "i");
  const afterEnd = new RegExp(`\\s*\\(after Task (${ID})\\)\\s*$`, "i");
  // A label, not prose: "Depends on:", "Depends-on:", or the words in emphasis -
  // "**Depends on:**", "**Depends on**", "__Depends on:__", "*Depends on:*" (R4-5).
  const DEP = "Depends(?:\\s+|\\s*-\\s*)on";
  const depends = new RegExp(`^\\s*(?:${BULLET}\\s*)?(?:(\\*\\*|__|\\*|_)${DEP}\\s*(?::\\s*\\1|\\1\\s*:?)|${DEP}\\s*:)\\s*(.*)$`, "i");
  // A loose "Depends on Task 2" (no label) orders like a Consumes line and never declares (R4-2).
  const loose = new RegExp(`^\\s*(?:${BULLET}\\s*)?[*_]{0,2}${DEP}\\b(.*)$`, "i");
  const consumesLine = new RegExp(`^\\s*(?:${BULLET}\\s+)?\\*{0,2}Consumes\\b([^:]*):(.*)$`, "i");
  // "**Files:**", "**Files**:", "**Files (anything):**", or a plain "Files:" (R2-5).
  const label = new RegExp(`^\\s*(?:${BULLET}\\s+)?(?:\\*\\*Files(?:\\s*\\([^)]*\\))?\\s*:?\\s*\\*\\*\\s*:?|Files(?:\\s*\\([^)]*\\))?\\s*:)\\s*(.*?)\\s*$`, "i");
  // Any other bold label ("**Step 2:**", "**Note**:") ends a lazy continuation (R4-4).
  const boldLabel = /^(\*\*|__)[^*_]*?(?::\s*\1|\1\s*:)/;
  const itemBullet = new RegExp(`^\\s*${BULLET}\\s+\``);
  const note = (line) => { if (cur && !mentions.has(cur)) { const p = tickedPaths(line)[0]; if (p) mentions.set(cur, p); } };
  const depend = (ns) => { for (const n of ns) if (!cur.dependsOn.includes(n)) cur.dependsOn.push(n); };
  // A Consumes line names only tasks earlier in the plan (R2-2), and every
  // number naming one counts (R2-1), "T5" and "Task2" included (S2). Its edges
  // order tasks but never declare the plan (S1). Depends on labels stay literal.
  const consume = (text) => {
    const before = new Set(tasks.slice(0, -1).map((t) => t.n));   // cur is the last task pushed
    depend(idsIn(spaced(text.replace(ISO_DATE, " "))).filter((n) => before.has(n)));
  };
  const STEP = new RegExp(`^\\s*${BULLET}\\s+\\[[ xX]\\]`);   // a "- [ ]" step, never a Files item
  /** The next non-blank line after `k`, or null. */
  const nextLine = (k) => { let j = k + 1; while (j < lines.length && !lines[j].text.trim()) j++; return j < lines.length ? lines[j].text : null; };
  /** After a blank line, does the next non-blank line carry a Files list on (S4)? */
  const listGoesOn = (k) => { const nx = nextLine(k); return nx !== null && !STEP.test(nx) && (BULLET_RE.test(nx) || /^\s+\S/.test(nx)); };
  /** A dependency line's text and the rest after a mid-line Files label, or null. */
  const splitLabel = (s) => { const m = s.match(MID_LABEL); return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length).trim()] : [s, null]; };
  const badDep = (w, text) => fail("PLAN_BAD_DEPENDENCY", `${w}: a "Depends on" label must name task ids ("Task 2", "T2", "Tasks 1 through 3") or say "none"; it reads "${text.trim()}"`);
  /** Does an empty Depends on label's nested list go on with this line? */
  const depItem = (raw) => BULLET_RE.test(raw) && !STEP.test(raw) && !fileLine(raw) && !label.test(raw) && !depends.test(raw) && !loose.test(raw) && !consumesLine.test(raw)
    && (!depList.bulleted || indentOf(raw) > depList.indent);
  const endDepList = () => {
    if (!depList) return;
    const d = depList; depList = null;
    if (!d.items) fail("PLAN_BAD_DEPENDENCY", `Task ${d.task.n} (line ${d.no}): an empty "Depends on" label with no list of task ids under it`);
    labelled.add(d.task);
  };
  /** Record a Files line's items under `op`; a read with prose beside its items becomes touch. */
  const record = (op, r, text) => {
    const o = op === "read" && r.prose ? "touch" : op;
    if (r.paths.length && o !== "read") declared.add(cur);
    if (!r.paths.length && !/^none\b/i.test(text)) note(text);
    for (const p of r.paths) if (!cur.files.some((x) => x.op === o && x.path === p)) cur.files.push({ op: o, path: p });
    return o;
  };
  const add = (op, rest, where, { plain = true, isLabel = false, suspect = false } = {}) => {
    // "- add:" with nothing after it introduces a step's code block; it is a
    // Files line only if indented items follow it (a nested list).
    // A label's list stays a label's list across its op lines.
    const inLabel = isLabel || !!cont?.label;
    // Any other bare op line must have something read under it, as an empty label must
    // (round 5, N2). An op line satisfies an empty label above it; only its own items
    // satisfy an empty op line.
    if (!rest && (isLabel || op !== "add")) { if (emptyLabel && (isLabel || emptyLabel.op)) failEmptyLabel(); emptyLabel = { at: where, op: isLabel ? null : op }; }
    else if (emptyLabel?.op) failEmptyLabel();
    else emptyLabel = null;
    if (!rest) { cont = { op, comma: false, list: true, label: inLabel }; return; }
    const r = pathsOf(rest, where);
    // Only the "**Files:** none" label declares a file-less task (N5), and never
    // from inside a comment spanning lines (round 5, N4).
    if (isLabel && !suspect && /^none\b/i.test(rest)) declared.add(cur);
    // A read in the colon-less or qualified form may hide a write (N2).
    const o = record(op === "read" && !plain ? "touch" : op, r, rest);
    cont = { op: o, comma: /,\s*$/.test(rest), label: inLabel };
  };
  // An empty Files label with nothing under it (its list in a code block, say) would hide its files.
  const failEmptyLabel = () => fail("PLAN_BAD_FILE_LINE", emptyLabel.op
    ? `${emptyLabel.at}: a bare "- ${emptyLabel.op}:" line with nothing under it - list its files under it`
    : `${emptyLabel.at}: a Files label with nothing under it - list the files under it, or write "**Files:** none"`);

  const step = (k) => {
    const { text: raw, no, suspect, code: skipped } = lines[k];
    // A line skipped as code still counts as a path mention, so a task whose only
    // Files lines are code is not accepted file-less (round 5, O1).
    if (skipped !== undefined) note(skipped);
    const where = () => `Task ${cur.n} (line ${no})`;
    const h = raw.match(heading);
    if (h) {
      endDepList();
      const n = id(h[1]);
      if (tasks.some((t) => t.n === n)) fail("PLAN_DUPLICATE_TASK", `Task ${h[1]} appears more than once`);
      cur = { n, title: h[2].replace(afterEnd, "").trim(), files: [], dependsOn: [] };
      level = raw.trim().match(/^#+/)[0].length;
      const a = h[2].match(after); if (a) cur.dependsOn.push(id(a[1]));
      tasks.push(cur); note(h[2]); cont = null; consumes = false; return;
    }
    // A heading at the task's level or above ("## Self-review") ends its section.
    const other = raw.match(/^ {0,3}(#{1,6})\s/);
    if (cur && other && other[1].length <= level) { endDepList(); cur = null; cont = null; consumes = false; }
    if (!cur) {
      // N1: a Files line with no open task would be silently dropped.
      if (fileLine(raw) || label.test(raw)) fail("PLAN_FILES_OUTSIDE_TASK", `line ${no}: a Files line outside any task ("${raw.trim()}") - put it under its task's heading`);
      // S3: so is a dependency line (a loose "depends on" outside a task is prose).
      if (depends.test(raw) || consumesLine.test(raw)) fail("PLAN_DEPS_OUTSIDE_TASK", `line ${no}: a dependency line outside any task ("${raw.trim()}") - put it under its task's heading`);
      return;
    }
    // An empty Depends on label's nested list: each item names ids or "none" (R4-1).
    if (depList) {
      if (!raw.trim() && !depList.items && nextLine(k) !== null && depItem(nextLine(k))) { depList.afterBlank = true; return; }
      if (raw.trim() && depItem(raw)) {
        const text = raw.replace(BULLET_RE, "");
        const ns = depIds(text);
        // An item four columns past the label after a blank line may be code: it orders, but cannot make the label declare.
        if (depList.afterBlank && indentOf(raw) - depList.indent >= 4) { depend(ns); note(raw); return; }
        if (!ns.length && !NONE.test(text)) badDep(where(), text);
        depend(ns); note(raw); depList.items++;
        return;
      }
      if (depList.items && /^\s+\S/.test(raw) && !BULLET_RE.test(raw)) { depend(depIds(raw)); note(raw); return; }
      endDepList();
    }
    // Dependency lines come before the continuation branch, so a Files line
    // ending in a comma cannot swallow them (N3). They leave an open Files list
    // open: the items after them are still its items (R2-3). A `**Files:**`
    // label later on the same line is a label (R2-5). A label that may be code
    // or a comment - inside a comment spanning lines, or indented four columns
    // or more - still orders, literally, but never declares and is never refused.
    const d = raw.match(depends);
    if (d) {
      const [text, tail] = splitLabel(d[2]);
      const ns = depIds(text);
      if (suspect || indentOf(raw) >= 4) { /* orders only */ }
      else if (ns.length || NONE.test(text)) labelled.add(cur);
      else if (!text.replace(/[\s*_]/g, "") && tail === null) depList = { indent: indentOf(raw), bulleted: BULLET_RE.test(raw), items: 0, no, task: cur };
      else badDep(where(), text);
      depend(ns); note(raw); consumes = false;
      if (tail !== null) add("touch", tail, where(), { isLabel: true, suspect });
      return;
    }
    const lo = !consumesLine.test(raw) && raw.match(loose);
    const c = raw.match(consumesLine) ?? (lo && [null, "", lo[1]]);
    // A loose line met while a Files list is open is read both ways, ordering and
    // continuation, as a wrapped Consumes line is (round 5, N3).
    let looseBoth = false;
    if (c) {
      const [text, tail] = splitLabel(c[1] + " " + c[2]);
      consume(text); note(raw); consumes = tail === null;
      if (tail !== null) add("touch", tail, where(), { isLabel: true, suspect });
      if (!(lo && cont && tail === null)) return;
      looseBoth = true;
    }
    const f = looseBoth ? null : fileLine(raw);
    if (f) { consumes = false; add(f.op, f.rest, where(), { plain: f.plain }); return; }
    // A Files label ends a Consumes line; it is never its continuation (C1).
    // Inside an open Files list a wrapped Consumes line is read both ways.
    let both = looseBoth;
    if (!both && consumes && /^\s+\S/.test(raw) && !label.test(raw)) { consume(raw); note(raw); if (!cont) return; both = true; }
    if (!both) consumes = false;
    if (!raw.trim()) {
      if (cont && listGoesOn(k)) { cont.afterBlank = true; return; }
      cont = null; return;
    }
    // A trailing comma and a lazy line carry a Files line on only when no blank line came between.
    const commaCont = !!cont?.comma && !cont.afterBlank;
    // R4-4: any unindented line that is not a bullet, heading or label continues it.
    const lazy = !!cont && !cont.afterBlank && !/^\s/.test(raw) && !BULLET_RE.test(raw) && !/^#{1,6}(\s|$)/.test(raw) && !boldLabel.test(raw);
    // An unindented bullet in a label's list is an item (R2-4), and so is one under a bare op line (R4-4).
    const bare = !!cont && (cont.label || cont.list) && !/^\s/.test(raw) && !commaCont && BULLET_RE.test(raw) && !STEP.test(raw);
    if (cont && !/^\s*#/.test(raw) && !label.test(raw) && (/^\s/.test(raw) || commaCont || bare || lazy)) {
      cont.afterBlank = false;
      emptyLabel = null;
      const text = raw.trim().replace(BULLET_RE, "");
      // In a nested item list under a bare "- Op:" or label, an item that opens its bullet is the op's object.
      const item = (!!cont.list || bare) && itemBullet.test(raw);
      const r = text.includes("`") ? tickedItems(text, where(), item) : (checkProse(text, where()), { paths: [], prose: true });
      // An unindented bullet in a label's list carries no op of its own; under a bare op line it is that op's.
      record(bare && !cont.list ? "touch" : cont.op, r, text);
      cont.comma = /,\s*$/.test(text);
      return;
    }
    // A loose line that is not the list's continuation leaves the list as it was (R4-2).
    if (looseBoth) return;
    cont = null;
    const l = raw.match(label);
    if (l) { add("touch", l[1], where(), { isLabel: true, suspect }); return; }
    note(raw);
  };
  for (let k = 0; k < lines.length; k++) {
    step(k);
    if (emptyLabel && !cont?.list) failEmptyLabel();
  }
  endDepList();
  if (emptyLabel) failEmptyLabel();
  if (!tasks.length) fail("PLAN_NO_TASKS", "no '## Task N:' or '### Task N:' headings found");
  for (const t of tasks) if (!declared.has(t) && mentions.has(t)) fail("PLAN_TASK_NO_FILES", `Task ${t.n} mentions paths but has no Files lines (first: \`${mentions.get(t)}\`)`);
  if (tasks.every((t) => !t.files.length)) fail("PLAN_NO_FILES", "no task has a Files line");
  const missingDependsOn = tasks.filter((t) => !labelled.has(t)).map((t) => t.n);
  return { tasks, dependencyInfo: missingDependsOn.length ? "none" : "declared", missingDependsOn };
}
