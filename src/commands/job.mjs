import { register } from "../registry.mjs";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { readJob, writeJob, nextId, listJobs, writeJobFile, jobFileExists, readJobFile } from "../store.mjs";
import { newJob, transition, park, release, stop, resume } from "../job.mjs";
import { fail } from "../errors.mjs";

const ctx = (io) => { const root = findRepoRoot(io.cwd); return { root, c: loadConfig(root) }; };
const done = (io, job, flags) => { io.stdout(flags.json ? JSON.stringify(job, null, 2) + "\n" : `${job.id} ${job.stage}\n`); return 0; };
const by = (flags) => (typeof flags.by === "string" ? flags.by : "session");
const nextDecisionNo = (c, id) => { let k = 1; while (jobFileExists(c, id, `decisions/${k}.md`)) k++; return k; };

const sub = {
  add(p, f, io) {
    const { c } = ctx(io);
    const [kind, ...title] = p;
    if (!kind || !title.length) fail("BAD_ARGS", 'usage: sfactory job add <milestone|fix> "<title>"');
    const job = newJob({ id: nextId(c, kind), kind, title: title.join(" ") });
    return done(io, writeJob(c, job), f);
  },
  set(p, f, io) {
    const { c } = ctx(io);
    const [id, to] = p;
    const job = readJob(c, id);
    if (job.stage === "awaiting-approval") fail("APPROVAL_REQUIRED", `${id} leaves awaiting-approval only through "sfactory job approve"`);
    if (to === "building" && ["reviewing", "pushed"].includes(job.stage)) fail("ILLEGAL_TRANSITION", `${id} goes back to building only through "sfactory job rework ${id} --notes <what to change>"`);
    return done(io, writeJob(c, transition(job, to, { by: by(f), reason: f.reason ?? null })), f);
  },
  approve(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (job.stage !== "awaiting-approval") fail("ILLEGAL_TRANSITION", `${job.id} is ${job.stage}, not awaiting-approval`);
    writeJobFile(c, job.id, "plan/approval.md", `approved by ${by(f)} at ${new Date().toISOString()}\n`);
    return done(io, writeJob(c, transition(job, "building", { by: by(f), reason: "approved" })), f);
  },
  park(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (typeof f.reason !== "string") fail("BAD_ARGS", "park needs --reason");
    const pending = f.pending === "parallel" ? "parallel" : "decision";
    const next = park(job, { by: by(f), reason: f.reason, pending });
    if (pending === "parallel") writeJobFile(c, job.id, "plan/parallel.md", `# Parallel proposal

${f.reason}

Answer with: sfactory job parallel ${job.id} --yes | --no
`);
    else {
      const k = nextDecisionNo(c, job.id);
      writeJobFile(c, job.id, `decisions/${k}.md`, `# Decision ${k}

${f.reason}

Write the answer to decisions/${k}-answer.md, then run: sfactory job answer ${job.id}
`);
    }
    return done(io, writeJob(c, next), f);
  },
  answer(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (job.stage !== "decision-needed" || job.pending !== "decision") fail("ILLEGAL_TRANSITION", `${job.id} is not waiting for a decision`);
    const k = nextDecisionNo(c, job.id) - 1;
    if (!readJobFile(c, job.id, `decisions/${k}-answer.md`)?.trim()) fail("ANSWER_REQUIRED", `write decisions/${k}-answer.md first`);
    return done(io, writeJob(c, release(job, { by: by(f) })), f);
  },
  parallel(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (job.stage !== "decision-needed" || job.pending !== "parallel") fail("ILLEGAL_TRANSITION", `${job.id} is not a parallel proposal`);
    if (f.yes === f.no) fail("BAD_ARGS", "parallel needs --yes or --no");
    const next = release(job, { by: by(f) });
    next.parallel = f.yes ? "approved" : "queued";
    return done(io, writeJob(c, next), f);
  },
  stop(p, f, io) { const { c } = ctx(io); return done(io, writeJob(c, stop(readJob(c, p[0]), { by: by(f), reason: f.reason ?? "stopped" })), f); },
  resume(p, f, io) { const { c } = ctx(io); return done(io, writeJob(c, resume(readJob(c, p[0]), { by: by(f) })), f); },
  merged(p, f, io) { const { c } = ctx(io); return done(io, writeJob(c, transition(readJob(c, p[0]), "merged", { by: by(f), reason: "merged" })), f); },
  rework(p, f, io) {
    const { c } = ctx(io);
    const job = readJob(c, p[0]);
    if (typeof f.notes !== "string") fail("BAD_ARGS", "rework needs --notes");
    if (!["reviewing", "pushed"].includes(job.stage)) fail("ILLEGAL_TRANSITION", `rework needs reviewing or pushed, ${job.id} is ${job.stage}`);
    const next = transition(job, "building", { by: by(f), reason: "rework" });
    writeJobFile(c, job.id, `rework/${next.rework}.md`, `# Rework ${next.rework}\n\n${f.notes}\n`);
    return done(io, writeJob(c, next), f);
  },
  show(p, f, io) { const { c } = ctx(io); return done(io, readJob(c, p[0]), { json: true }); },
  list(p, f, io) {
    const { c } = ctx(io);
    const jobs = listJobs(c);
    io.stdout(f.json ? JSON.stringify(jobs, null, 2) + "\n" : jobs.map((j) => `${j.id.padEnd(6)} ${j.stage.padEnd(18)} ${j.kind.padEnd(9)} ${j.title}\n`).join(""));
    return 0;
  },
};

register("job", async ({ positional, flags }, io) => {
  const [name, ...rest] = positional;
  const fn = sub[name];
  if (!fn) fail("UNKNOWN_COMMAND", `job ${name ?? ""}; one of ${Object.keys(sub).join(", ")}`);
  return fn(rest, flags, io);
});
