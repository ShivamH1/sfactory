import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, sep, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.mjs";
import { acquireSync, status } from "./lock.mjs";
import { newJob } from "./job.mjs";

/** One per process: the holder every job lock of this process is taken under. */
export const HOLDER = `sfactory:${process.pid}:${randomUUID()}`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}
export const jobsDir = (c) => join(c.stateDir, "jobs");
const ID_RE = /^[mf]-\d+$/;
function assertId(id) {
  if (!ID_RE.test(String(id))) fail("BAD_ID", `"${id}" is not a job id (m-<n> or f-<n>)`);
}
export function jobDir(c, id) {
  assertId(id);
  return join(jobsDir(c), id);
}
function jobPath(c, id, rel) {
  const base = resolve(jobDir(c, id)); // resolve, as f is: a drive-less absolute stateDir gains its drive on Windows
  const f = resolve(base, rel);
  if (!f.startsWith(base + sep)) fail("BAD_PATH", `"${rel}" escapes the job folder`);
  return f;
}
const jobFile = (c, id) => join(jobDir(c, id), "job.json");

export function listJobIds(c) {
  const d = jobsDir(c);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => existsSync(join(d, n, "job.json")));
}
export function listJobs(c) {
  return listJobIds(c).map((id) => readJob(c, id)).sort((a, b) => String(a.started).localeCompare(String(b.started)) || a.id.localeCompare(b.id));
}
export function readJob(c, id) {
  const f = jobFile(c, id);
  if (!existsSync(f)) fail("JOB_NOT_FOUND", `no job ${id} under ${jobsDir(c)}`);
  try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { fail("JOB_CORRUPT", `${f}: ${e.message}`); }
}
/** Run fn holding the job's lock (job:<id>), retrying a held lock; JOB_BUSY once the retries are spent. */
export function withJobLock(c, id, fn, { retries = 40, delayMs = 50 } = {}) {
  assertId(id);
  let lock;
  for (let i = 0; ; i++) {
    try { lock = acquireSync(c, `job:${id}`, { holder: HOLDER, pid: process.pid }); break; }
    catch (e) {
      if (e.code !== "LOCK_HELD") throw e;
      if (i >= retries) fail("JOB_BUSY", `${id} is being written by another process: ${e.message}`);
      sleepSync(delayMs);
    }
  }
  try {
    const out = fn();
    if (out && typeof out.then === "function") fail("LOCK_ASYNC", "withJobLock runs a synchronous callback; an async one would run outside the lock");
    return out;
  } finally { try { lock.release(); } catch { /* lock already gone */ } }
}

/** Write text to f atomically: a unique temp file, then a rename (retried on the EPERM/EBUSY a reader can cause on Windows). */
export function atomicWrite(f, text) {
  const tmp = `${f}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, f); return; }
    catch (e) { if (!["EPERM", "EBUSY"].includes(e.code) || i >= 2) { try { unlinkSync(tmp); } catch { /* best effort */ } throw e; } sleepSync(20); }
  }
}

/** Called inside withJobLock by the job commands (src/job-actions.mjs, src/commands/*) and by addJob. Atomic via atomicWrite. */
export function writeJob(c, job) {
  const s = status(c, `job:${job.id}`);
  if (!s.held || s.holder !== HOLDER) fail("JOB_LOCK_REQUIRED", `writeJob(${job.id}) needs withJobLock`);
  mkdirSync(jobDir(c, job.id), { recursive: true });
  job.updated = new Date().toISOString();
  const f = jobFile(c, job.id);
  atomicWrite(f, JSON.stringify(job, null, 2) + "\n");
  return job;
}

/** Create the job's folder exclusively: JOB_EXISTS if it is already there. */
export function createJobFolder(c, id) {
  assertId(id);
  mkdirSync(jobsDir(c), { recursive: true });
  try { mkdirSync(jobDir(c, id)); } catch (e) { if (e.code === "EEXIST") fail("JOB_EXISTS", `${id} already exists`); throw e; }
}

export function addJob(c, kind, title, { now } = {}) {
  for (let i = 0; i < 20; i++) {
    const id = nextId(c, kind);
    try { createJobFolder(c, id); } catch (e) { if (e.code === "JOB_EXISTS") continue; throw e; }
    return withJobLock(c, id, () => writeJob(c, newJob({ id, kind, title, now })));
  }
  fail("JOB_BUSY", `could not allocate a ${kind} id after 20 tries`);
}
export function nextId(c, kind) {
  const prefix = kind === "milestone" ? "m-" : "f-";
  const d = jobsDir(c);
  const ids = existsSync(d) ? readdirSync(d).filter((n) => ID_RE.test(n)) : []; // folders count even before their job.json lands
  const max = ids.filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(2))).filter(Number.isInteger).reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}${max + 1}`;
}
export function writeJobFile(c, id, rel, text) {
  const f = jobPath(c, id, rel);
  if (["job.json", "cost.json"].includes(relative(resolve(jobDir(c, id)), f).split(sep).join("/"))) fail("BAD_PATH", `"${rel}" is the job's own state file`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
}
export function readJobFile(c, id, rel) {
  const f = jobPath(c, id, rel);
  return existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : null;
}
export const jobFileExists = (c, id, rel) => existsSync(jobPath(c, id, rel));
