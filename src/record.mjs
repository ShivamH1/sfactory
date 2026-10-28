import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.mjs";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A record pattern ("spec/modules/{n}-{slug}.md") as a regex over repo-relative paths; `fixed` pins placeholders to values. */
function patternRegex(pattern, fixed = {}) {
  const parts = pattern.split(/(\{(?:n|slug|id)\})/);
  let re = "";
  for (const p of parts) {
    const m = /^\{(n|slug|id)\}$/.exec(p);
    if (!m) re += esc(p);
    else if (fixed[m[1]] !== undefined) re += esc(String(fixed[m[1]]));
    else re += m[1] === "n" ? "(?<n>\\d+)" : "[^/]+";
  }
  return new RegExp(`^${re}$`);
}

/** Repo-relative files under the pattern's static prefix (the directories before its first placeholder), at most `depth` levels down. */
function filesUnder(root, pattern, depth = 4) {
  const segs = pattern.split("/");
  const fixedSegs = [];
  for (const s of segs.slice(0, -1)) { if (/\{/.test(s)) break; fixedSegs.push(s); }
  const out = [];
  const walk = (rel, d) => {
    const abs = join(root, ...rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const next = [...rel, e.name];
      if (e.isDirectory()) { if (d > 0) walk(next, d - 1); } else out.push(next.join("/"));
    }
  };
  walk(fixedSegs, depth);
  return out;
}

const fill = (pattern, v) => pattern.replace(/\{id\}/g, v.id).replace(/\{slug\}/g, v.slug).replace(/\{n\}/g, v.n === null ? "" : String(v.n));

/**
 * The card's record paths, relative to its worktree: { brief, plan, log, stories, n }.
 * {n}: a fix with logOf takes that number and its log is the one existing file matching record.log with it
 * (LOG_NOT_FOUND otherwise); "next-milestone-number" is one more than the highest {n} of a brief in the
 * worktree and of every other unmerged card's record; any other numbering is the number in the card's id.
 */
export function resolveRecord(c, job, worktree, others = []) {
  const r = c.record;
  const idNo = Number(/\d+$/.exec(job.id)?.[0] ?? NaN);
  let n;
  if (Number.isInteger(job.logOf)) n = job.logOf;
  else if (r.numbering === "next-milestone-number") {
    const re = patternRegex(r.brief);
    let max = 0;
    for (const f of filesUnder(worktree, r.brief)) { const m = re.exec(f); if (m?.groups?.n) max = Math.max(max, Number(m.groups.n)); }
    for (const o of others) if (o.id !== job.id && o.stage !== "merged" && Number.isInteger(o.record?.n) && !Number.isInteger(o.logOf)) max = Math.max(max, o.record.n);
    n = max + 1;
  } else n = Number.isInteger(idNo) ? idNo : null;
  const v = { id: job.id, slug: job.slug, n };
  let log = fill(r.log, v);
  if (Number.isInteger(job.logOf)) {
    const re = patternRegex(r.log, { n: job.logOf, id: `m-${job.logOf}` });
    const hits = filesUnder(worktree, r.log).filter((f) => re.test(f)).sort();
    if (hits.length !== 1) fail("LOG_NOT_FOUND", hits.length ? `--log ${job.logOf} matches more than one log (${hits.join(", ")}); refile the fix naming one` : `--log ${job.logOf}: no file in the worktree matches ${r.log}`);
    log = hits[0];
  }
  return { brief: fill(r.brief, v), plan: fill(r.plan, v), log, stories: r.stories ?? null, n };
}
