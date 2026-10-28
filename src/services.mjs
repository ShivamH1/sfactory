import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.mjs";
import { jobDir, readJobFile, writeJobFile } from "./store.mjs";
import { substitute } from "./ports.mjs";
import { status as lockStatus, withLock } from "./lock.mjs";
import { dropNamedSecrets } from "./secrets.mjs";
import { copyForVerify, removeVerifyCopies } from "./verify-copies.mjs";

const RECORD = "verify/services.json";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** A pid whose process began this long after we recorded the start is a reused pid, not our service. */
const REUSE_SLACK_MS = process.platform === "win32" ? 1000 : 2000; // StartTime has ms precision; ps etime whole seconds
const GRACE_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
/** POSIX: is any member of the process group led by pid still there? (EPERM: it exists, though not ours to signal.) */
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
/**
 * POSIX: a group with no live leader is ours when no one else can have its id. A group id cannot be reused while a member
 * lives, so on Linux the group is ours if it sits in the session the leader started (sid === pid), which also rules out a
 * new setsid'd process that reused the pid. macOS/BSD `ps` has no `sid` keyword, so there the judgement is pgid-only: a
 * live group whose id is the recorded pid is ours (trade-off: a reused pid that became its own group leader reads as ours).
 * `ps -A` is the portable "every process" (`-e` on BSD means "show environment"). Reasoned on Windows (POSIX only), not run on macOS.
 * `run(args)` (stdout or null) and `platform` are injectable for tests.
 */
export function groupIsOurs(pid, { run, platform = process.platform, exists = (g) => { try { process.kill(-g, 0); return true; } catch { return false; } } } = {}) {
  if (!exists(pid)) return false; // gone, or EPERM: another user's group, foreign
  const bsd = platform === "darwin";
  const args = bsd ? ["-A", "-o", "pgid="] : ["-A", "-o", "pgid=,sid="];
  let out;
  if (run) out = run(args);
  else {
    const r = spawnSync("ps", args, { encoding: "utf8", timeout: 5000 });
    out = r.error || r.status !== 0 ? null : String(r.stdout);
  }
  if (out == null) return false;
  for (const line of String(out).split("\n")) {
    const m = /^\s*(\d+)(?:\s+(\d+))?\s*$/.exec(line);
    if (!m || Number(m[1]) !== pid) continue;
    if (bsd || Number(m[2]) === pid) return true;
  }
  return false;
}

const unreadable = (why) => fail("START_TIMES_UNREADABLE", `start times could not be read (${why}); retry`);

/**
 * Start times (ms since epoch) of the live pids, in one call: Map pid -> ms, absent for a pid the query did not list.
 * A query that itself failed (error, timeout, bad status) throws START_TIMES_UNREADABLE: retryable, not "unknown".
 */
export function processStarts(pids) {
  const out = new Map();
  if (!pids.length) return out;
  const list = pids.map(Number).filter((p) => Number.isInteger(p) && p > 0);
  {
    if (process.platform === "win32") {
      // CIM, not Get-Process: StartTime is unreadable for other users' and SYSTEM processes, CreationDate is not.
      // CreationDate is local wall-clock time converted by CIM: in the hour a daylight-saving fall-back repeats it is
      // ambiguous, an error of up to an hour that can mislabel a reused pid in that one hour (accepted).
      const filter = list.map((p) => `ProcessId=${p}`).join(" OR ");
      const cmd = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" }`;
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
      if (r.error || r.status !== 0) unreadable(r.error ? r.error.code ?? "powershell failed" : `powershell status ${r.status}`);
      for (const line of String(r.stdout).split(/\r?\n/)) {
        const m = /^(\d+) (\S+)$/.exec(line.trim());
        const t = m ? Date.parse(m[2]) : NaN;
        if (m && Number.isFinite(t)) out.set(Number(m[1]), t);
      }
      return out;
    }
    const r = spawnSync("ps", ["-o", "pid=,etime=", "-p", list.join(",")], { encoding: "utf8", timeout: 5000 });
    // ps exits 1 when none of the pids is there any more: an empty answer, not a failure.
    if (r.error || (r.status !== 0 && r.status !== 1)) unreadable(r.error ? r.error.code ?? "ps failed" : `ps status ${r.status}`);
    for (const line of String(r.stdout).split("\n")) {
      const m = /^\s*(\d+)\s+(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(line);
      if (!m) continue;
      const secs = ((Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 60 + Number(m[4])) * 60 + Number(m[5]);
      out.set(Number(m[1]), Date.now() - secs * 1000);
    }
  }
  return out;
}

/**
 * One verdict per record: "dead"; "ours" (alive, began no later than we recorded); "foreign" (alive but began after
 * the record: a reused pid); "unknown" (alive, start time unreadable: neither attributed nor killed).
 * `startOf(pid)` is injectable for tests; by default one call reads every live pid.
 */
function judgeAll(recs, startOf, startsFn = processStarts, tolerant = false) {
  const live = recs.filter((r) => pidAlive(r.pid));
  // POSIX: a group id cannot be reused while a member lives, so a dead leader's live group is ours when its session is the
  // one the leader started (sid === pid); EPERM on the group means another user's. (Reasoned on Windows, not run there; see groupIsOurs.)
  const groupOnly = (r) => process.platform !== "win32" && !pidAlive(r.pid) && groupIsOurs(r.pid);
  let starts = null, unread = false;
  if (!startOf) {
    try { starts = startsFn(live.map((r) => r.pid)); } catch (e) { if (!tolerant || e?.code !== "START_TIMES_UNREADABLE") throw e; unread = true; }
  }
  return recs.map((rec) => {
    if (groupOnly(rec)) return "ours";
    if (!live.includes(rec)) return "dead";
    if (unread) return "unreadable";
    const began = startOf ? startOf(rec.pid) : starts.get(rec.pid);
    if (began === null || began === undefined) return "unknown";
    return began > rec.startedAt + REUSE_SLACK_MS ? "foreign" : "ours";
  });
}

function readRecord(c, job) {
  const text = readJobFile(c, job.id, RECORD);
  if (text === null) return null;
  try {
    const r = JSON.parse(text);
    if (r && Array.isArray(r.services)) return r;
  } catch { /* fall through */ }
  fail("SERVICES_CORRUPT", `${join(jobDir(c, job.id), RECORD)} is not readable; inspect it and delete it by hand`);
}

function resolveEntries(c, job) {
  const entries = c.commands?.services ?? [];
  const ports = job.ports;
  if (entries.length && (!ports || typeof ports !== "object")) fail("PORTS_REQUIRED", `job ${job.id} has no ports; run "sfactory ports allocate ${job.id}" first`);
  const seen = new Set();
  return entries.map((e) => {
    if (!e || typeof e.name !== "string" || !NAME_RE.test(e.name)) fail("BAD_ARGS", `commands.services: "${e?.name}" is not a usable service name`);
    if (typeof e.cmd !== "string" || !e.cmd) fail("BAD_ARGS", `commands.services.${e.name}: cmd is required`);
    if (seen.has(e.name)) fail("BAD_ARGS", `commands.services: duplicate name ${e.name}`);
    seen.add(e.name);
    const sub = (s, what) => {
      const out = substitute(s, ports);
      const left = /\{port\.([a-z0-9_-]+)\}/i.exec(out);
      if (left) fail("BAD_ARGS", `commands.services.${e.name}: ${what} names unknown port "${left[1]}" (job ports: ${Object.keys(ports).join(", ")})`);
      return out;
    };
    if (e.port != null && !(Object.hasOwn(ports, e.port) && ports[e.port] != null)) fail("BAD_ARGS", `commands.services.${e.name}: port "${e.port}" is not one of the job ports`);
    const env = {};
    for (const [k, v] of Object.entries(e.env ?? {})) env[k] = sub(v, `env ${k}`);
    return { name: e.name, cmd: sub(e.cmd, "cmd"), env, live: e.live === true };
  });
}

/** The parent environment plus the entry's own, minus every variable named in secrets. */
const childEnv = (c, extra) => dropNamedSecrets(c, { ...process.env, ...extra });

function liveHeldBy(c, job) {
  const s = lockStatus(c, "live");
  return s.held && !s.takeover && !s.corrupt && !s.stale && s.holder === job.id;
}

const writeRecord = (c, job, services) => writeJobFile(c, job.id, RECORD, JSON.stringify({ services }, null, 2) + "\n");
const removeRecord = (c, job) => { try { unlinkSync(join(jobDir(c, job.id), RECORD)); } catch (e) { if (e.code !== "ENOENT") throw e; } };
const guard = (c, job, fn) => withLock(c, `services:${job.id}`, { holder: `services:${process.pid}`, waitMs: 30_000, pollMs: 50 }, fn);

export function servicesStatus(c, job, { startOf, startsFn } = {}) {
  const rec = readRecord(c, job);
  if (!rec) return [];
  const states = judgeAll(rec.services, startOf, startsFn, true); // a failed start-time query is reported, never thrown
  return rec.services.map((r, i) => ({ name: r.name, pid: r.pid, startedAt: r.startedAt, state: states[i] }));
}

/** Ends the process tree. True once nothing of it is left (win32: the root pid is the only member that can be checked), else the reason. */
async function killAndWait(pid, { kill } = {}) {
  if (kill) return (await kill(pid)) ? true : "still running after the kill";
  if (process.platform === "win32") {
    let status = null;
    try { status = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 }).status; } catch { /* checked below */ }
    const until = Date.now() + GRACE_MS;
    while (pidAlive(pid) && Date.now() < until) await sleep(50);
    // 128 is "process not found": already gone. Any other failure may have left part of the tree running.
    if (pidAlive(pid)) return "still running after the kill";
    if (status !== 0 && status !== 128) return `taskkill reported status ${status}; part of its tree may still be running`;
    return true;
  }
  const gone = async () => { const until = Date.now() + GRACE_MS; while (groupAlive(pid) && Date.now() < until) await sleep(50); return !groupAlive(pid); };
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  if (await gone()) return true;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  return (await gone()) || "still running after the kill";
}

/**
 * win32: a detached cmd.exe opens a visible console (libuv gives DETACHED_PROCESS precedence over CREATE_NO_WINDOW). So the
 * detached process is a node wrapper, which has no console of its own, and the wrapper runs the shell command hidden
 * and non-detached, sharing the log file. The recorded pid is the wrapper, whose tree taskkill ends.
 */
const WRAP = "const c=require('node:child_process').spawn(process.argv[1],{shell:true,windowsHide:true,stdio:'inherit'});c.on('exit',(code)=>process.exit(code??1));c.on('error',()=>process.exit(1));";
function spawnService(cmd, opts) {
  if (process.platform === "win32") return spawn(process.execPath, ["-e", WRAP, cmd], { ...opts, shell: false });
  return spawn(cmd, { ...opts, shell: true });
}

/** Starts every service detached so it outlives this process; nothing starts unless every entry resolves. */
export function servicesUp(c, job, { log = () => {}, startOf, startsFn } = {}) {
  return guard(c, job, async () => {
    if (!job.worktree) fail("WORKTREE_REQUIRED", `job ${job.id} has no worktree; run "sfactory worktree cut" first`);
    const entries = resolveEntries(c, job);
    const rec = readRecord(c, job);
    if (rec) {
      const states = judgeAll(rec.services, startOf, startsFn);
      const named = (st) => rec.services.filter((_, i) => states[i] === st).map((r) => `${r.name}(${r.pid})`).join(", ");
      if (states.includes("ours")) fail("SERVICES_RUNNING", `services already running for ${job.id}: ${named("ours")}; run "sfactory services down ${job.id}"`);
      if (states.includes("unknown")) fail("SERVICES_UNKNOWN", `recorded pids of ${job.id} are alive but their start time cannot be read: ${named("unknown")}; check these pids are yours (they may be unrelated processes that reused the pids); if they are yours, retry "sfactory services down ${job.id}"; if not, delete the record ${join(jobDir(c, job.id), RECORD)}`);
    }
    if (entries.some((e) => e.live) && !liveHeldBy(c, job)) fail("LIVE_LOCK_REQUIRED", `a live service needs a fresh live lock held by ${job.id}; run "sfactory lock acquire live --holder ${job.id} --durable"`);
    const dir = join(jobDir(c, job.id), "verify");
    mkdirSync(dir, { recursive: true });
    const started = [];
    try {
      // worktrees.copyForVerify: the files the services need (an .env) land in the worktree for this stage only.
      for (const rel of copyForVerify(c, job, { log }).copied) log(`copied ${rel} into the worktree for verify`);
      for (const e of entries) {
        const logPath = join(dir, `${e.name}.log`);
        const fd = openSync(logPath, "a");
        let child;
        try {
          child = spawnService(e.cmd, { cwd: job.worktree, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: childEnv(c, e.env) });
        } finally { closeSync(fd); }
        child.on("error", () => { /* a spawn failure shows as a dead pid in status */ });
        if (!child.pid) fail("SERVICE_START_FAILED", `could not start ${e.name}`);
        child.unref();
        started.push({ name: e.name, pid: child.pid, startedAt: Date.now(), cmd: e.cmd, log: logPath });
        writeRecord(c, job, started); // as each starts, so a later failure still leaves every started pid recorded
        log(`started ${e.name} pid ${child.pid}`);
      }
    } catch (err) {
      const left = [];
      try {
        for (const r of started) if ((await killAndWait(r.pid)) !== true) left.push(r);
        if (left.length) writeRecord(c, job, left); else removeRecord(c, job);
        removeVerifyCopies(c, job);
      } catch { /* the original error is the one to report */ }
      throw err;
    }
    return started.map(({ name, pid, log: l }) => ({ name, pid, log: l }));
  });
}

/**
 * Kills each recorded service this record can attribute. `skipped` entries carry `alive: true` when a pid is
 * still running (foreign, unknown or a survivor of the kill); a survivor and an unknown pid stay in the record.
 */
export function servicesDown(c, job, { log = () => {}, startOf, startsFn, kill } = {}) {
  return guard(c, job, async () => {
    const rec = readRecord(c, job);
    const killed = [], skipped = [];
    // The verify copies go whatever the services' fate: a secret never outlives the stage that needed it.
    const copies = () => {
      const r = removeVerifyCopies(c, job);
      for (const rel of r.removed) log(`removed ${rel} from the worktree`);
      return r.removed.length || r.left.length ? { copiesRemoved: r.removed, copiesLeft: r.left } : {};
    };
    if (!rec) return { killed, skipped, ...copies() };
    const states = judgeAll(rec.services, startOf, startsFn);
    const keep = [];
    for (let i = 0; i < rec.services.length; i++) {
      const r = rec.services[i], st = states[i];
      if (st === "ours") {
        const k = await killAndWait(r.pid, { kill });
        if (k === true) { killed.push(r.name); log(`stopped ${r.name} pid ${r.pid}`); }
        else { skipped.push({ name: r.name, pid: r.pid, alive: true, reason: k }); keep.push(r); }
      } else if (st === "foreign") {
        skipped.push({ name: r.name, pid: r.pid, alive: true, reason: "pid now belongs to another process" }); log(`left pid ${r.pid} alone: not ${r.name}`);
      } else if (st === "unknown") {
        skipped.push({ name: r.name, pid: r.pid, alive: true, reason: "alive but its start time cannot be read, so it is not attributed" }); keep.push(r);
      } else skipped.push({ name: r.name, pid: r.pid, alive: false, reason: "already stopped" });
    }
    if (keep.length) writeRecord(c, job, keep); else removeRecord(c, job);
    return { killed, skipped, ...copies() };
  });
}
