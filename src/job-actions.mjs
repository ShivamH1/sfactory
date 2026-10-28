import { readJob, writeJob, addJob, withJobLock, listJobs, writeJobFile, jobFileExists, readJobFile } from "./store.mjs";
import { transition, park, release, queue, stop, resume, WORKING } from "./job.mjs";
import { fail } from "./errors.mjs";

/** The gates as functions: each takes (c, args), runs under the job's lock, re-reads the job there and returns the written job. */
const nextNo = (c, id, rel) => { let k = 1; while (jobFileExists(c, id, rel(k))) k++; return k; };
const locked = (c, id, fn) => withJobLock(c, id, () => fn(readJob(c, id)));

export const actions = {
  add(c, { kind, title }) {
    if (!kind || !title) fail("BAD_ARGS", 'usage: sfactory job add <milestone|fix> "<title>"');
    if (kind !== "milestone" && kind !== "fix") fail("BAD_ARGS", 'kind must be "milestone" or "fix"');
    return addJob(c, kind, title);
  },
  set(c, { id, to, by = "session", reason = null }) {
    return locked(c, id, (job) => {
      if (job.stage === "awaiting-approval") fail("APPROVAL_REQUIRED", `${id} leaves awaiting-approval only through "sfactory job approve"`);
      if (to === "building" && ["reviewing", "pushed"].includes(job.stage)) fail("ILLEGAL_TRANSITION", `${id} goes back to building only through "sfactory job rework ${id} --notes <what to change>"`);
      return writeJob(c, transition(job, to, { by, reason, limits: c.limits }));
    });
  },
  approve(c, { id, by = "session" }) {
    return locked(c, id, (job) => {
      if (job.stage !== "awaiting-approval") fail("ILLEGAL_TRANSITION", `${job.id} is ${job.stage}, not awaiting-approval`);
      writeJobFile(c, job.id, "plan/approval.md", `approved by ${by} at ${new Date().toISOString()}\n`);
      return writeJob(c, transition(job, "building", { by, reason: "approved" }));
    });
  },
  park(c, { id, reason, pending, by = "session" }) {
    return locked(c, id, (job) => {
      if (typeof reason !== "string") fail("BAD_ARGS", "park needs --reason");
      if (pending !== undefined && pending !== "decision" && pending !== "parallel") fail("BAD_ARGS", 'pending must be "decision" or "parallel"');
      const kind = pending === "parallel" ? "parallel" : "decision";
      const next = park(job, { by, reason, pending: kind });
      if (kind === "parallel") writeJobFile(c, job.id, "plan/parallel.md", `# Parallel proposal

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
  stop(c, { id, reason = "stopped", by = "session" }) { return locked(c, id, (job) => writeJob(c, stop(job, { by, reason }))); },
  resume(c, { id, by = "session" }) { return locked(c, id, (job) => writeJob(c, resume(job, { by }))); },
  merged(c, { id, by = "session" }) { return locked(c, id, (job) => writeJob(c, transition(job, "merged", { by, reason: "merged" }))); },
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
