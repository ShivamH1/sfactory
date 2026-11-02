import { readJob, writeJob, addJob, withJobLock, listJobs, writeJobFile, jobFileExists, readJobFile } from "./store.mjs";
import { transition, park, release, queue, stop, resume, WORKING, NUMBER_RE } from "./job.mjs";
import { fail } from "./errors.mjs";
import { removeVerifyCopies, verifyCopiesLeft } from "./verify-copies.mjs";
import { withRecordLock } from "./record.mjs";

/** The gates as functions: each takes (c, args), runs under the job's lock, re-reads the job there and returns the written job. */
const nextNo = (c, id, rel) => { let k = 1; while (jobFileExists(c, id, rel(k))) k++; return k; };
const locked = (c, id, fn) => withJobLock(c, id, () => fn(readJob(c, id)));

/** Stages that never count toward limits.parallelMilestones: not started, outside the factory, or finished. */
export const OFF_STAGES = ["roadmap", "backlog", "external", "pushed", "merged", "stopped"];

/**
 * The milestones that count toward limits.parallelMilestones: from planning until pushed, merged or stopped. A card
 * in roadmap, backlog or external does not count, a queued one (parallel: queued) included, nor one parked for a
 * parallel proposal from backlog (it has not started).
 */
export function activeMilestones(c, exceptId = null) {
  return listJobs(c).filter((j) => j.id !== exceptId && j.kind === "milestone" && !OFF_STAGES.includes(j.stage) && !(j.stage === "decision-needed" && j.returnStage === "backlog"));
}

/** Is a card resting at `stage` one that counts toward the cap? (the same rule as activeMilestones, for a stage not yet written) */
const countsAt = (job, stage) => !OFF_STAGES.includes(stage) && !(stage === "decision-needed" && job.returnStage === "backlog");

/** Throws CAP_REACHED when starting `id` would exceed limits.parallelMilestones. Call under the record lock. */
function assertCap(c, id, verb) {
  const cap = c.limits?.parallelMilestones ?? 2;
  const act = activeMilestones(c, id);
  if (act.length >= cap) fail("CAP_REACHED", `${act.length} milestones are active (${act.map((j) => `${j.id} ${j.stage}`).join(", ")}) and limits.parallelMilestones is ${cap}; ${id} ${verb} until one is pushed, merged or stopped`);
}

/** A milestone built beside another active milestone needs the person's parallel yes: its own, or the other card's, approved beside it. Call under the record lock. */
function assertParallelAnswered(c, job) {
  const act = activeMilestones(c, job.id);
  const paired = job.parallel === "approved" || act.some((o) => o.parallel === "approved" && o.parallelWith === job.id);
  if (act.length && !paired) fail("PARALLEL_UNANSWERED", `${act.map((j) => j.id).join(", ")} ${act.length > 1 ? "are" : "is"} active and ${job.id} has no approved parallel answer (parallel: ${job.parallel ?? "none"}); ask with "sfactory job park ${job.id} --pending parallel --with <id> --reason ..." and approve once it is answered yes`);
}

const isWhole = (n) => /^\d+$/.test(String(n));

export const actions = {
  add(c, { kind, title, logOf, number, roadmap, after }) {
    if (!kind || !title) fail("BAD_ARGS", 'usage: sfactory job add <milestone|fix> "<title>"');
    if (kind !== "milestone" && kind !== "fix") fail("BAD_ARGS", 'kind must be "milestone" or "fix"');
    if (kind === "fix" && (number !== undefined || roadmap || after !== undefined)) fail("BAD_ARGS", "--number, --roadmap and --after are for a milestone card");
    if (after !== undefined && (typeof after !== "string" || !after.trim() || after.length > 80)) fail("BAD_ARGS", "--after needs text of at most 80 characters");
    if (number !== undefined && !NUMBER_RE.test(String(number))) fail("BAD_NUMBER", `"${number}" is not a milestone number (a whole number, or one like 29.1)`);
    if (number !== undefined && !roadmap && !isWhole(number)) fail("BAD_NUMBER", `M${number} is history only: add it with --roadmap, or import it as external, pushed or merged`);
    if (logOf !== undefined) {
      if (kind !== "fix") fail("BAD_ARGS", "--log is for a fix card: the milestone whose log takes the fix's dated note");
      if (!/^[1-9]\d*$/.test(String(logOf))) fail("BAD_ARGS", "--log needs a positive whole number");
      return addJob(c, kind, title, { logOf: Number(logOf) });
    }
    const opts = { ...(roadmap ? { stage: "roadmap" } : {}), ...(number !== undefined ? { number: String(number) } : {}), ...(after !== undefined ? { after } : {}) };
    if (number === undefined) return addJob(c, kind, title, opts);
    // The duplicate check and the write share the record lock, so two adds cannot both take one number.
    return withRecordLock(c, "add", () => {
      const held = listJobs(c).find((j) => j.number === String(number));
      if (held) fail("NUMBER_TAKEN", `M${number} is ${held.id} ("${held.title}")`);
      return addJob(c, kind, title, opts);
    });
  },
  set(c, { id, to, by = "session", reason = null }) {
    return locked(c, id, (job) => {
      if (job.stage === "verifying") {
        const left = verifyCopiesLeft(c, job);
        if (left.length) fail("VERIFY_COPIES_LEFT", `${id} still holds verify copies in its worktree (${left.join(", ")}); run "sfactory services down ${id}" before leaving verifying`);
      }
      if (job.stage === "awaiting-approval") fail("APPROVAL_REQUIRED", `${id} leaves awaiting-approval only through "sfactory job approve"`);
      if (to === "building" && ["reviewing", "pushed"].includes(job.stage)) fail("ILLEGAL_TRANSITION", `${id} goes back to building only through "sfactory job rework ${id} --notes <what to change>"`);
      const next = transition(job, to, { by, reason, limits: c.limits });
      if (!(to === "planning" && job.kind === "milestone")) return writeJob(c, next);
      if (job.number !== undefined && job.number !== null && !isWhole(job.number)) fail("BAD_NUMBER", `${id} is M${job.number}, history only; a whole-number milestone is the only one that can start`);
      // The cap is read and the start written under the shared record lock, so two starts cannot both pass it.
      return withRecordLock(c, id, () => {
        assertCap(c, id, "stays in backlog");
        return writeJob(c, next);
      });
    });
  },
  approve(c, { id, by = "session" }) {
    return locked(c, id, (job) => {
      if (job.stage !== "awaiting-approval") fail("ILLEGAL_TRANSITION", `${job.id} is ${job.stage}, not awaiting-approval`);
      const go = () => {
        writeJobFile(c, job.id, "plan/approval.md", `approved by ${by} at ${new Date().toISOString()}
`);
        return writeJob(c, transition(job, "building", { by, reason: "approved" }));
      };
      if (job.kind !== "milestone") return go();
      // The active set is read under the shared record lock, as a start's cap is, so a card started meanwhile is seen.
      return withRecordLock(c, id, () => { assertParallelAnswered(c, job); return go(); });
    });
  },
  park(c, { id, reason, pending, with: partner, by = "session" }) {
    return locked(c, id, (job) => {
      if (typeof reason !== "string") fail("BAD_ARGS", "park needs --reason");
      if (pending !== undefined && pending !== "decision" && pending !== "parallel") fail("BAD_ARGS", 'pending must be "decision" or "parallel"');
      const kind = pending === "parallel" ? "parallel" : "decision";
      // A parallel proposal names the one card it would run beside; worktree cut --base-of and merge --from check it.
      if (kind === "parallel" && (typeof partner !== "string" || !partner)) fail("BAD_ARGS", "a parallel park needs --with <the partner card's id>");
      if (kind !== "parallel" && partner !== undefined) fail("BAD_ARGS", "--with names a parallel partner; it goes with --pending parallel only");
      if (kind === "parallel") { if (partner === job.id) fail("BAD_ARGS", "--with names another card"); readJob(c, partner); }
      const next = park(job, { by, reason, pending: kind });
      if (kind === "parallel") next.parallelWith = partner;
      if (kind === "parallel") writeJobFile(c, job.id, "plan/parallel.md", `# Parallel proposal: ${job.id} beside ${partner}

${reason}

Answer with: sfactory job parallel ${job.id} --yes | --no
`);
      else {
        const k = nextNo(c, job.id, (n) => `decisions/${n}.md`);
        writeJobFile(c, job.id, `decisions/${k}.md`, `# Decision ${k}

${reason}

Write the answer to decisions/${k}-answer.md, then run: sfactory job answer ${job.id}
  `);
      }
      return writeJob(c, next);
    });
  },
  answer(c, { id, by = "session", text }) {
    return locked(c, id, (job) => {
      if (job.stage !== "decision-needed" || job.pending !== "decision") fail("ILLEGAL_TRANSITION", `${job.id} is not waiting for a decision`);
      const k = nextNo(c, job.id, (n) => `decisions/${n}.md`) - 1;
      if (k < 1) fail("ILLEGAL_TRANSITION", `${job.id} has no decision to answer (decisions/1.md is missing)`);
      if (text !== undefined) {
        if (typeof text !== "string") fail("BAD_ARGS", "the answer must be text");
        if (!String(text).trim()) fail("ANSWER_REQUIRED", "the answer is empty");
        writeJobFile(c, job.id, `decisions/${k}-answer.md`, String(text).endsWith("\n") ? text : `${text}\n`);
      }
      if (!readJobFile(c, job.id, `decisions/${k}-answer.md`)?.trim()) fail("ANSWER_REQUIRED", `write decisions/${k}-answer.md first`);
      return writeJob(c, release(job, { by }));
    });
  },
  parallel(c, { id, yes, by = "session" }) {
    return locked(c, id, (job) => {
      if (job.stage !== "decision-needed" || job.pending !== "parallel") fail("ILLEGAL_TRANSITION", `${job.id} is not a parallel proposal`);
      if (typeof yes !== "boolean") fail("BAD_ARGS", "parallel needs --yes or --no");
      const next = yes ? release(job, { by }) : queue(job, { by });
      next.parallel = yes ? "approved" : "queued";
      return writeJob(c, next);
    });
  },
  /** Stops the card and takes its verify copies (worktrees.copyForVerify) out of the worktree: a stopped card keeps no secret. */
  stop(c, { id, reason = "stopped", by = "session" }) {
    return locked(c, id, (job) => {
      const next = writeJob(c, stop(job, { by, reason }));
      const r = removeVerifyCopies(c, next);
      if (r.left.length) process.stderr.write(`warning: ${id} stopped, but ${r.left.join(", ")} could not be removed from ${next.worktree}; remove by hand\n`);
      return next;
    });
  },
  /** A stopped card re-enters the cap: resuming into an active stage re-checks limits.parallelMilestones and, past approval, the parallel answer. */
  resume(c, { id, by = "session" }) {
    return locked(c, id, (job) => {
      const next = resume(job, { by });
      if (job.kind !== "milestone" || !countsAt(job, next.stage)) return writeJob(c, next);
      return withRecordLock(c, id, () => {
        assertCap(c, id, "stays stopped");
        if (!["planning", "awaiting-approval"].includes(next.stage)) assertParallelAnswered(c, job);
        return writeJob(c, next);
      });
    });
  },
  merged(c, { id, by = "session" }) { return locked(c, id, (job) => writeJob(c, transition(job, "merged", { by, reason: "merged" }))); },
  /** A card waiting in roadmap joins the backlog; the next run starts it. */
  start(c, { id, by = "session" }) {
    return locked(c, id, (job) => {
      const next = transition(job, "backlog", { by, reason: "started" });
      if (job.number !== undefined && job.number !== null && !isWhole(job.number)) fail("BAD_NUMBER", `${id} is M${job.number}, history only; a whole-number milestone is the only one that can start`);
      return writeJob(c, next);
    });
  },
  /** A card worked outside the factory: run never touches it; merged or stop closes it. */
  external(c, { id, note, by = "session" }) {
    return locked(c, id, (job) => {
      if (typeof note !== "string" || !note.trim() || note.length > 200) fail("BAD_ARGS", 'external needs --note "<who is doing it>" of at most 200 characters');
      const next = transition(job, "external", { by, reason: "external" });
      next.externalNote = note.trim();
      return writeJob(c, next);
    });
  },
  rework(c, { id, notes, by = "session" }) {
    return locked(c, id, (job) => {
      if (typeof notes !== "string" || !notes.trim()) fail("BAD_ARGS", "rework needs --notes");
      if (!["reviewing", "pushed"].includes(job.stage)) fail("ILLEGAL_TRANSITION", `rework needs reviewing or pushed, ${job.id} is ${job.stage}`);
      const next = transition(job, "building", { by, reason: "rework" });
      writeJobFile(c, job.id, `rework/${next.rework}.md`, `# Rework ${next.rework}\n\n${notes}\n`);
      return writeJob(c, next);
    });
  },
  requestChanges(c, { id, notes, by = "session" }) {
    return locked(c, id, (job) => {
      if (typeof notes !== "string" || !notes.trim()) fail("BAD_ARGS", "request-changes needs notes");
      if (job.stage !== "awaiting-approval") fail("ILLEGAL_TRANSITION", `changes can be requested only in awaiting-approval, ${job.id} is ${job.stage}`);
      const k = nextNo(c, job.id, (n) => `plan/changes-${n}.md`);
      writeJobFile(c, job.id, `plan/changes-${k}.md`, `# Changes requested ${k}\n\n${notes}\n`);
      const next = structuredClone(job);
      next.history.push({ at: new Date().toISOString(), from: job.stage, to: job.stage, by, reason: "changes requested", file: `plan/changes-${k}.md` });
      return writeJob(c, next);
    });
  },
  /**
   * Marks a working card as live (updated + activity). Outside a working stage it writes nothing and returns
   * the job unchanged: re-stamping awaiting-approval would re-gate the board's Approve-after-viewing.
   */
  touch(c, { id, note, by = "session" }) {
    return locked(c, id, (job) => {
      if (note !== undefined && (typeof note !== "string" || note.length > 200)) fail("BAD_ARGS", "the note must be text of at most 200 characters");
      if (!WORKING.includes(job.stage)) return job;
      const next = structuredClone(job);
      next.activity = { at: new Date().toISOString(), ...(note ? { note } : {}), by };
      return writeJob(c, next);
    });
  },
  show(c, { id }) { return readJob(c, id); },
  list(c) { return listJobs(c); },
};
