import { fail } from "./errors.mjs";

export const STAGES = ["backlog", "planning", "awaiting-approval", "building", "reviewing", "fixing", "verifying", "pushing", "pushed", "merged", "decision-needed", "stopped"];
export const TERMINAL = ["merged"];
export const WORKING = ["planning", "building", "reviewing", "fixing", "verifying", "pushing"];
export const COLUMNS = {
  backlog: "Backlog", planning: "Plan", "awaiting-approval": "Needs you", building: "In process", reviewing: "Review",
  fixing: "Fixed", verifying: "Fixed", pushing: "Pushed / PR", pushed: "Pushed / PR", merged: "Done",
  "decision-needed": "Needs you", stopped: "Stopped",
};
/** Edges other than park/stop, which are added per call. "awaiting-approval -> building" also needs the approval file (commands/job.mjs). */
export const TRANSITIONS = {
  backlog: ["planning"],
  planning: ["awaiting-approval", "building"],
  "awaiting-approval": ["building"],
  building: ["reviewing"],
  reviewing: ["fixing", "verifying", "building"],
  fixing: ["reviewing"],
  verifying: ["pushing", "fixing"],
  pushing: ["pushed"],
  pushed: ["merged", "building"],
  merged: [],
  "decision-needed": [],   // only release()
  stopped: [],             // only resume()
};

export function newJob({ id, kind, title, now = new Date().toISOString() }) {
  if (!["milestone", "fix"].includes(kind)) fail("BAD_KIND", `kind must be milestone or fix, got ${kind}`);
  return {
    id, kind, title, stage: "backlog", returnStage: null, previousStage: null, pending: null,
    branch: null, base: null, worktree: null, ports: null, record: null,
    tasks: { total: 0, done: 0, parallel: [] }, round: 0, rework: 0, parallel: null, agents: null, cost: 0,
    started: now, updated: now, ended: null,
    history: [{ at: now, from: null, to: "backlog", by: "session", reason: "created" }],
  };
}

const entry = (job, to, { by = "session", reason = null, now = new Date().toISOString() }) => ({ at: now, from: job.stage, to, by, reason });

export function transition(job, to, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const allowed = TRANSITIONS[job.stage] ?? [];
  if (!STAGES.includes(to) || !allowed.includes(to)) fail("ILLEGAL_TRANSITION", `${job.stage} -> ${to} is not allowed for ${job.id}`);
  if (job.stage === "planning" && to === "building" && job.kind === "milestone") fail("ILLEGAL_TRANSITION", `planning -> building needs approval for a milestone (${job.id})`);
  const next = structuredClone(job);
  next.history.push(entry(job, to, { ...opts, now }));
  next.stage = to;
  if (to === "fixing") next.round += 1;
  if (to === "building" && ["reviewing", "pushed"].includes(job.stage)) next.rework += 1;
  if (TERMINAL.includes(to)) next.ended = now;
  return next;
}

export function park(job, { by = "session", reason, pending = "decision", now } = {}) {
  if (!reason) fail("BAD_ARGS", "park needs a reason");
  if (!WORKING.includes(job.stage) && job.stage !== "backlog") fail("ILLEGAL_TRANSITION", `${job.stage} cannot park (${job.id})`);
  const ok = job.stage === "backlog" ? pending === "parallel" : pending === "decision";
  if (!ok) fail("ILLEGAL_TRANSITION", `${job.stage} cannot park with pending "${pending}" (${job.id})`);
  const next = structuredClone(job);
  next.history.push(entry(job, "decision-needed", { by, reason, now }));
  next.returnStage = job.stage; next.pending = pending; next.stage = "decision-needed";
  return next;
}
export function release(job, { by = "session", now } = {}) {
  if (job.stage !== "decision-needed" || !job.returnStage) fail("ILLEGAL_TRANSITION", `${job.id} is not parked`);
  const next = structuredClone(job);
  next.history.push(entry(job, job.returnStage, { by, reason: "released", now }));
  next.stage = job.returnStage; next.returnStage = null; next.pending = null;
  return next;
}
export function stop(job, { by = "session", reason = "stopped", now } = {}) {
  if (TERMINAL.includes(job.stage) || job.stage === "stopped") fail("ILLEGAL_TRANSITION", `${job.stage} cannot stop (${job.id})`);
  const next = structuredClone(job);
  next.history.push(entry(job, "stopped", { by, reason, now }));
  next.previousStage = job.stage; next.stage = "stopped";
  return next;
}
export function resume(job, { by = "session", now } = {}) {
  if (job.stage !== "stopped" || !job.previousStage) fail("ILLEGAL_TRANSITION", `${job.id} is not stopped`);
  const next = structuredClone(job);
  next.history.push(entry(job, job.previousStage, { by, reason: "resumed", now }));
  next.stage = job.previousStage; next.previousStage = null;
  return next;
}
