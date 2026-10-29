import { existsSync, readdirSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { fail } from "./errors.mjs";
import { acquireSync } from "./lock.mjs";
import { jobDir } from "./store.mjs";

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run fn holding the machine-wide "record" lock, so two cuts never take the same {n}: each reads the briefs and
 * every other card's record.n, and writes its own, inside it. Synchronous (the cut is), retried like the job lock;
 * RECORD_BUSY once the retries are spent. Lock order: job:<id> (outer, cutJob) then record (inner), never the reverse.
 */
export function withRecordLock(c, holder, fn, { retries = 100, delayMs = 50 } = {}) {
  let lock;
  for (let i = 0; ; i++) {
    try { lock = acquireSync(c, "record", { holder }); break; }
    catch (e) {
      if (e.code !== "LOCK_HELD") throw e;
      if (i >= retries) fail("RECORD_BUSY", `another cut is resolving its record paths: ${e.message}`);
      sleepSync(delayMs);
    }
  }
  try { return fn(); } finally { try { lock.release(); } catch { /* lock already gone */ } }
}

const outside = (p) => isAbsolute(p) || /^(\/|\\|[A-Za-z]:)/.test(p) || p.split(/[\/\\]/).includes("..");

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

/** Milestone n's one log in the worktree (a fix filed with --log n); LOG_NOT_FOUND for none or several. */
function milestoneLog(c, worktree, n) {
  const r = c.record;
  const re = patternRegex(r.log, { n, id: `m-${n}` });
  const hits = filesUnder(worktree, r.log).filter((f) => re.test(f)).sort();
  if (hits.length !== 1) fail("LOG_NOT_FOUND", hits.length ? `--log ${n} matches more than one log (${hits.join(", ")}); refile the fix naming one` : `--log ${n}: no file in the worktree matches ${r.log}`);
  return hits[0];
}

const checkInside = (out, keys, what = "record") => {
  for (const k of keys) if (typeof out[k] === "string" && outside(out[k])) fail("BAD_RECORD_PATH", `${what}.${k} resolves to "${out[k]}", outside the worktree`);
};

/**
 * A fix card's record: its own, never a milestone's numbered brief and plan, and it reserves no {n}. Its brief and
 * plan are in its job folder (plan/brief.md, plan/plan.md: absolute paths, the factory's files, never committed)
 * unless record.fix gives patterns ({id} and {slug}, relative to the worktree). Its log: with --log n, milestone
 * n's one log, where its per-task entries and its close go into one dated section under record.postCloseHeading
 * (n is then that milestone's number); else record.fix.log; else log.md in its job folder.
 */
function fixRecord(c, job, worktree) {
  const f = c.record.fix ?? {};
  const v = { id: job.id, slug: job.slug, n: null };
  const dir = resolve(jobDir(c, job.id));
  const logOf = Number.isInteger(job.logOf) ? job.logOf : null;
  const out = {
    brief: typeof f.brief === "string" ? fill(f.brief, v) : join(dir, "plan", "brief.md"),
    plan: typeof f.plan === "string" ? fill(f.plan, v) : join(dir, "plan", "plan.md"),
    log: logOf !== null ? milestoneLog(c, worktree, logOf) : typeof f.log === "string" ? fill(f.log, v) : join(dir, "log.md"),
    stories: c.record.stories ?? null,
    n: logOf,
  };
  checkInside(out, [...["brief", "plan"].filter((k) => typeof f[k] === "string"), ...(logOf !== null || typeof f.log === "string" ? ["log"] : []), "stories"], "record.fix");
  return out;
}

/**
 * The card's record paths: { brief, plan, log, stories, n }. A milestone's are relative to its worktree; a fix
 * card's are its own (fixRecord), and any of them in its job folder is absolute.
 * {n} (milestones): "next-milestone-number" is one more than the highest {n} of a brief in the worktree and of
 * every other unmerged milestone's record (a fix never counts); any other numbering is the number in the card's id.
 */
export function resolveRecord(c, job, worktree, others = []) {
  if (job.kind === "fix") return fixRecord(c, job, worktree);
  const r = c.record;
  const idNo = Number(/\d+$/.exec(job.id)?.[0] ?? NaN);
  let n;
  if (r.numbering === "next-milestone-number") {
    const re = patternRegex(r.brief);
    let max = 0;
    for (const f of filesUnder(worktree, r.brief)) { const m = re.exec(f); if (m?.groups?.n) max = Math.max(max, Number(m.groups.n)); }
    for (const o of others) if (o.id !== job.id && o.kind !== "fix" && o.stage !== "merged" && Number.isInteger(o.record?.n) && !Number.isInteger(o.logOf)) max = Math.max(max, o.record.n);
    n = max + 1;
  } else n = Number.isInteger(idNo) ? idNo : null;
  const v = { id: job.id, slug: job.slug, n };
  const out = { brief: fill(r.brief, v), plan: fill(r.plan, v), log: fill(r.log, v), stories: r.stories ?? null, n };
  checkInside(out, ["brief", "plan", "log", "stories"]);
  return out;
}
