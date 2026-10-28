import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listJobs, readJobFile, jobDir } from "../store.mjs";
import { readCost } from "../cost.mjs";
import { status } from "../lock.mjs";
import { COLUMNS } from "../job.mjs";

export const BOARD_COLUMNS = ["Backlog", "Plan", "Needs you", "In process", "Review", "Fixed", "Pushed / PR", "Done", "Stopped"];

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

export function buildSnapshot(c, { now: nowArg, demo = false } = {}) {
  const all = listJobs(c);
  // demo jobs carry fixed past stamps: measure them against their own latest moment, not the real clock
  const latest = demo ? all.flatMap((j) => [j.started, j.updated, j.ended]).filter(Boolean).sort().at(-1) : null;
  const now = nowArg ?? latest ?? new Date().toISOString();
  const jobs = all.map((j) => {
    const cost = readCost(c, j.id).total ?? { usd: 0, unpriced: 0 };
    return {
      id: j.id, kind: j.kind, title: j.title, stage: j.stage, column: COLUMNS[j.stage] ?? null,
      pending: j.pending ?? null, returnStage: j.returnStage ?? null, branch: j.branch ?? null, base: j.base ?? null,
      worktree: j.worktree ?? null, ports: j.ports ?? null, slug: j.slug ?? null,
      tasks: j.tasks ?? null, round: j.round ?? 0, rework: j.rework ?? 0, parallel: j.parallel ?? null,
      started: j.started ?? null, updated: j.updated ?? null, ended: j.ended ?? null,
      elapsedMs: Date.parse(j.ended ?? now) - Date.parse(j.started),
      cost: { usd: cost.usd ?? 0, unpriced: cost.unpriced ?? 0 },
      files: collectFiles(jobDir(c, j.id)),
      needsYou: needsYou(c, j),
      prText: readJobFile(c, j.id, "pr.md"),
    };
  });
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
