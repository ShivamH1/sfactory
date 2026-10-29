// Ported from skills/sdd/scripts/task-brief, itself adapted from superpowers (MIT, Jesse Vincent): see skills/sdd/ATTRIBUTION.md.
import { fail } from "./errors.mjs";

/** A task id: digits and an optional letter ("3", "3a"). */
export const TASK_ID = /^[0-9]+[a-z]?$/;

const run = (s, c) => { let k = 0; while (s[k] === c) k++; return k; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One task's full text from a plan, as the sdd skill's brief: from its heading ("## Task N:" or "### Task N:", any
 * level, case-insensitive) to the next heading at the same level or above. Fenced code (``` or ~~~, up to three
 * leading spaces, closed only by a fence of the same character at least as long with nothing after it) is never read
 * as a heading. CRLF line ends are read as LF. "" when the task is not there. (Ported from the old task-brief script.)
 */
export function taskBrief(text, n) {
  if (typeof n !== "string" || !TASK_ID.test(n)) fail("BAD_ARGS", `bad task id: ${JSON.stringify(n)} (digits and an optional letter, e.g. 3 or 3a)`);
  const head = new RegExp(`^#+[ \\t]+task[ \\t]+${esc(n)}[ \\t]*:`, "i");
  const out = [];
  let fence = null, inTask = false, level = 0;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    const t = line.replace(/^ {0,3}/, "");
    const c = t[0];
    const k = c === "`" || c === "~" ? run(t, c) : 0;
    if (fence) {
      if (c === fence.c && k >= fence.k && /^[ \t]*$/.test(t.slice(k))) fence = null;
    } else if (k >= 3) {
      fence = { c, k };
    } else if (/^#+[ \t]/.test(t)) {
      const l = run(t, "#");
      if (head.test(t)) { inTask = true; level = l; }
      else if (inTask && l <= level) inTask = false;
    }
    if (inTask) out.push(line);
  }
  return out.length ? out.join("\n") + "\n" : "";
}
