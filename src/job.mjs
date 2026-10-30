import { fail } from "./errors.mjs";

export const STAGES = ["roadmap", "backlog", "planning", "awaiting-approval", "building", "reviewing", "fixing", "verifying", "pushing", "pushed", "external", "merged", "decision-needed", "stopped"];
export const TERMINAL = ["merged"];
export const WORKING = ["planning", "building", "reviewing", "fixing", "verifying", "pushing"];
export const COLUMNS = {
  roadmap: "Milestones", backlog: "Backlog", planning: "Plan", "awaiting-approval": "Needs you", building: "In process", reviewing: "Review",
  fixing: "Fixed", verifying: "Fixed", pushing: "Pushed / PR", pushed: "Pushed / PR", external: "External running", merged: "Done",
  "decision-needed": "Needs you", stopped: "Stopped",
};
/** Edges other than park/stop, which are added per call. "awaiting-approval -> building" also needs the approval file (commands/job.mjs). */
export const TRANSITIONS = {
  roadmap: ["backlog", "external"],
  backlog: ["planning", "external"],
  planning: ["awaiting-approval", "building"],
  "awaiting-approval": ["building"],
  building: ["reviewing"],
  reviewing: ["fixing", "verifying", "building"],
  fixing: ["reviewing"],
  verifying: ["pushing", "fixing"],
  pushing: ["pushed"],
  pushed: ["merged", "building"],
  external: ["merged"],
  merged: [],
  "decision-needed": [],   // only release()
  stopped: [],             // only resume()
};
/** A milestone number: a whole number or one with a single decimal part ("57", "29.1"), no leading zeros. */
export const NUMBER_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

export function newJob({ id, kind, title, now = new Date().toISOString(), stage = "backlog", number, after }) {
  if (!["milestone", "fix"].includes(kind)) fail("BAD_KIND", `kind must be milestone or fix, got ${kind}`);
  if (!["backlog", "roadmap"].includes(stage)) fail("BAD_ARGS", `a new card starts in backlog or roadmap, not ${stage}`);
  return {
    id, kind, title, stage, returnStage: null, previousStage: null, pending: null,
    branch: null, base: null, worktree: null, ports: null, record: null,
    tasks: { total: 0, done: 0, parallel: [] }, round: 0, rework: 0, parallel: null, agents: null, cost: 0,
    started: now, updated: now, ended: null,
    ...(number !== undefined ? { number } : {}),
    ...(after !== undefined ? { after } : {}),
    history: [{ at: now, from: null, to: stage, by: "session", reason: "created" }],
  };
}

const entry = (job, to, { by = "session", reason = null, now = new Date().toISOString() }) => ({ at: now, from: job.stage, to, by, reason });

export function transition(job, to, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const allowed = TRANSITIONS[job.stage] ?? [];
  if (!STAGES.includes(to) || !allowed.includes(to)) fail("ILLEGAL_TRANSITION", `${job.stage} -> ${to} is not allowed for ${job.id}`);
  if (job.stage === "planning" && to === "building" && job.kind === "milestone") fail("ILLEGAL_TRANSITION", `planning -> building needs approval for a milestone (${job.id})`);
  const cap = opts.limits?.fixRounds;
  if (to === "fixing" && Number.isInteger(cap) && job.round >= cap) fail("FIX_ROUNDS_EXHAUSTED", `${job.id} has used ${job.round} of ${cap} fix rounds; park it for a decision`);
  const next = structuredClone(job);
  next.history.push(entry(job, to, { ...opts, now }));
  next.stage = to;
  if (to === "fixing") next.round += 1;
  if (to === "building" && ["reviewing", "pushed"].includes(job.stage)) next.rework += 1;
  if (TERMINAL.includes(to)) next.ended = now;
  return next;
}

/**
 * What each stage may park as: a parallel proposal from backlog or planning (the question is asked on the
 * card's real plan, after it is committed and before awaiting-approval), a decision from any working stage.
 */
export const PARK_PENDING = Object.freeze({
  backlog: ["parallel"], planning: ["decision", "parallel"],
  ...Object.fromEntries(WORKING.filter((s) => s !== "planning").map((s) => [s, ["decision"]])),
});

export function park(job, { by = "session", reason, pending = "decision", now } = {}) {
  if (!reason) fail("BAD_ARGS", "park needs a reason");
  if (!PARK_PENDING[job.stage]) fail("ILLEGAL_TRANSITION", `${job.stage} cannot park (${job.id})`);
  const ok = PARK_PENDING[job.stage].includes(pending);
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
/** A parallel proposal answered "no": the card goes back to backlog, wherever it was parked from; its worktree and plan stay. */
export function queue(job, { by = "session", now } = {}) {
  if (job.stage !== "decision-needed" || job.pending !== "parallel") fail("ILLEGAL_TRANSITION", `${job.id} is not a parallel proposal`);
  const next = structuredClone(job);
  next.history.push(entry(job, "backlog", { by, reason: "queued", now }));
  next.stage = "backlog"; next.returnStage = null; next.pending = null;
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
