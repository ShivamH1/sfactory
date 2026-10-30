import { readdirSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { listJobs, readJobFile, jobDir } from "../store.mjs";
import { readCost } from "../cost.mjs";
import { status } from "../lock.mjs";
import { COLUMNS } from "../job.mjs";

export const BOARD_COLUMNS = ["Milestones", "Backlog", "Plan", "Needs you", "In process", "Review", "Fixed", "Pushed / PR", "External running", "Done", "Stopped"];

/** Every .md and .log under the job folder, relative with forward slashes, sorted; temp files and job.json left out. */
function collectFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (e.isFile() && !e.name.endsWith(".tmp") && e.name !== "job.json" && /\.(md|log)$/.test(e.name)) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

function latestDecision(c, id) {
  const dir = join(jobDir(c, id), "decisions");
  if (!existsSync(dir)) return null;
  const ks = readdirSync(dir).map((n) => /^(\d+)\.md$/.exec(n)?.[1]).filter(Boolean).map(Number);
  if (!ks.length) return null;
  return readJobFile(c, id, `decisions/${Math.max(...ks)}.md`);
}

function needsYou(c, j) {
  if (j.stage === "awaiting-approval") return { action: "approve", command: `sfactory job approve ${j.id}` };
  if (j.stage === "pushed") return { action: "merged", command: `sfactory job merged ${j.id}` };
  if (j.stage === "decision-needed") {
    if (j.pending === "parallel") return { action: "parallel", reason: readJobFile(c, j.id, "plan/parallel.md") ?? "", command: `sfactory job parallel ${j.id} --yes|--no` };
    return { action: "answer", question: latestDecision(c, j.id) ?? "", command: `sfactory job answer ${j.id}` };
  }
  return null;
}

function lockView(c, name) {
  const s = status(c, name);
  return { held: !!s.held, holder: s.holder ?? null, since: s.since ?? null };
}

const WORKING = ["planning", "building", "reviewing", "fixing", "verifying", "pushing"];
export const VERDICT = /✅|❌|\b(?:Approved|Needs fixes|ok|red)\b/i; // the drawer's badge uses the same rule
export const BAD = /^(?:❌|needs fixes|red)$/i;

/** First line of a job file, at most 256 bytes read; null when unreadable. */
function firstLine(c, id, rel) {
  let fd;
  try {
    fd = openSync(join(jobDir(c, id), rel), "r");
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    return buf.toString("utf8", 0, n).split("\n")[0].trim();
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

/** The latest three review files (by name) with a verdict; one whose first line says neither is left out. */
function reviewChips(c, id, files) {
  const names = files.filter((f) => /^reviews\/[^/]+\.md$/.test(f)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).slice(-3);
  const out = [];
  for (const file of names) {
    const m = VERDICT.exec(firstLine(c, id, file) ?? "");
    if (m) out.push({ file, verdict: BAD.test(m[0]) ? "bad" : "good" });
  }
  return out;
}

/** The one allow-list of a job as the board shows it: snapshot and POST answers both use it, so job.json's other fields (lockToken, history) never leave. */
export function jobView(c, j, now = new Date().toISOString()) {
  const cost = readCost(c, j.id).total ?? { usd: 0, unpriced: 0 };
  const files = collectFiles(jobDir(c, j.id));
  const activeMs = c.board?.activeMs ?? 120000;
  const age = Date.parse(now) - Date.parse(j.updated);
  const active = WORKING.includes(j.stage) && age >= 0 && age <= activeMs;
  const reviews = reviewChips(c, j.id, files);
  return {
    id: j.id, kind: j.kind, title: j.title, stage: j.stage, column: COLUMNS[j.stage] ?? null,
    pending: j.pending ?? null, returnStage: j.returnStage ?? null, branch: j.branch ?? null, base: j.base ?? null,
    worktree: j.worktree ?? null, ports: j.ports ?? null, slug: j.slug ?? null,
    tasks: j.tasks ?? null, round: j.round ?? 0, rework: j.rework ?? 0, parallel: j.parallel ?? null,
    started: j.started ?? null, updated: j.updated ?? null, ended: j.ended ?? null,
    elapsedMs: Date.parse(j.ended ?? now) - Date.parse(j.started),
    cost: { usd: cost.usd ?? 0, unpriced: cost.unpriced ?? 0 },
    files,
    needsYou: needsYou(c, j),
    prText: readJobFile(c, j.id, "pr.md"),
    // A touch describes work in progress: once the card has left the working stages its note is stale, so it is not shown.
    ...(j.activity?.note && WORKING.includes(j.stage) ? { activity: { at: j.activity.at ?? null, note: String(j.activity.note).slice(0, 200) } } : {}),
    ...(active ? { active: true } : {}),
    ...(reviews.length ? { reviews } : {}),
  };
}

export function buildSnapshot(c, { now: nowArg, demo = false } = {}) {
  const all = listJobs(c);
  // demo jobs carry fixed past stamps: measure them against their own latest moment, not the real clock
  const latest = demo ? all.flatMap((j) => [j.started, j.updated, j.ended]).filter(Boolean).sort().at(-1) : null;
  const now = nowArg ?? latest ?? new Date().toISOString();
  const jobs = all.map((j) => jobView(c, j, now));
  return {
    project: c.project ?? null,
    board: { pollMs: c.board?.pollMs ?? 2000 },
    generatedAt: now,
    columns: [...BOARD_COLUMNS],
    jobs,
    locks: { live: lockView(c, "live"), suite: lockView(c, "suite"), commit: lockView(c, "commit") },
    ports: jobs.filter((j) => j.ports && j.stage !== "merged").map((j) => ({ id: j.id, ports: j.ports })),
    ...(demo ? { demo: true } : {}),
  };
}
