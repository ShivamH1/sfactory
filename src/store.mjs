import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fail } from "./errors.mjs";

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
  const base = jobDir(c, id);
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
/** Only src/job.mjs may call this. Atomic: write a temp file, then rename over job.json. */
export function writeJob(c, job) {
  mkdirSync(jobDir(c, job.id), { recursive: true });
  job.updated = new Date().toISOString();
  const f = jobFile(c, job.id);
  const tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify(job, null, 2) + "\n");
  renameSync(tmp, f);
  return job;
}
export function nextId(c, kind) {
  const prefix = kind === "milestone" ? "m-" : "f-";
  const max = listJobIds(c).filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(2))).filter(Number.isInteger).reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}${max + 1}`;
}
export function writeJobFile(c, id, rel, text) {
  const f = jobPath(c, id, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
}
export function readJobFile(c, id, rel) {
  const f = jobPath(c, id, rel);
  return existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : null;
}
export const jobFileExists = (c, id, rel) => existsSync(jobPath(c, id, rel));
