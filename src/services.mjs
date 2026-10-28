import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.mjs";
import { jobDir, readJobFile, writeJobFile } from "./store.mjs";
import { substitute } from "./ports.mjs";
import { status as lockStatus } from "./lock.mjs";
import { secretNames } from "./codex.mjs";

const RECORD = "verify/services.json";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** A pid whose process began this long after we recorded the start is a reused pid, not our service. */
const REUSE_SLACK_MS = 5000;
const GRACE_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Start time (ms since epoch) of a live pid, or null when it cannot be read cheaply. */
export function processStart(pid) {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      const t = Date.parse(String(r.stdout).trim());
      return Number.isFinite(t) ? t : null;
    }
    const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    const m = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(String(r.stdout));
    if (!m) return null;
    const secs = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
    return Date.now() - secs * 1000;
  } catch { return null; }
}

/** "dead", "ours" or "foreign" (alive but began after our record: a reused pid). */
function judge(rec, startOf) {
  if (!pidAlive(rec.pid)) return "dead";
  const began = startOf(rec.pid);
  if (began !== null && began !== undefined && began > rec.startedAt + REUSE_SLACK_MS) return "foreign";
  return "ours";
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
function childEnv(c, extra) {
  const drop = new Set(secretNames(c).map((s) => s.toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries({ ...process.env, ...extra })) if (v !== undefined && !drop.has(k.toUpperCase())) out[k] = v;
  return out;
}

function liveHeldBy(c, job) {
  const s = lockStatus(c, "live");
  return s.held && !s.takeover && !s.corrupt && s.holder === job.id;
}

export function servicesStatus(c, job, { startOf = processStart } = {}) {
  const rec = readRecord(c, job);
  if (!rec) return [];
  return rec.services.map((r) => ({ name: r.name, pid: r.pid, startedAt: r.startedAt, state: judge(r, startOf) }));
}

function killPid(pid) {
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}
async function killAndWait(pid) {
  killPid(pid);
  const until = Date.now() + GRACE_MS;
  while (pidAlive(pid) && Date.now() < until) await sleep(50);
  if (pidAlive(pid) && process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    const u2 = Date.now() + GRACE_MS;
    while (pidAlive(pid) && Date.now() < u2) await sleep(50);
  }
}

/** Starts every service detached so it outlives this process; nothing starts unless every entry resolves. */
export async function servicesUp(c, job, { log = () => {}, startOf = processStart } = {}) {
  if (!job.worktree) fail("WORKTREE_REQUIRED", `job ${job.id} has no worktree; run "sfactory worktree cut" first`);
  const entries = resolveEntries(c, job);
  const rec = readRecord(c, job);
  if (rec) {
    const running = rec.services.filter((r) => judge(r, startOf) === "ours");
    if (running.length) fail("SERVICES_RUNNING", `services already running for ${job.id}: ${running.map((r) => `${r.name}(${r.pid})`).join(", ")}; run "sfactory services down ${job.id}"`);
  }
  if (entries.some((e) => e.live) && !liveHeldBy(c, job)) fail("LIVE_LOCK_REQUIRED", `a live service needs the live lock held by ${job.id}; run "sfactory lock acquire live --holder ${job.id} --durable"`);
  const dir = join(jobDir(c, job.id), "verify");
  mkdirSync(dir, { recursive: true });
  const started = [];
  try {
    for (const e of entries) {
      const logPath = join(dir, `${e.name}.log`);
      const fd = openSync(logPath, "a");
      let child;
      try {
        child = spawn(e.cmd, { cwd: job.worktree, shell: true, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: childEnv(c, e.env) });
      } finally { closeSync(fd); }
      child.on("error", () => { /* a spawn failure shows as a dead pid in status */ });
      if (!child.pid) fail("SERVICE_START_FAILED", `could not start ${e.name}`);
      child.unref();
      started.push({ name: e.name, pid: child.pid, startedAt: Date.now(), cmd: e.cmd, log: logPath });
      log(`started ${e.name} pid ${child.pid}`);
    }
  } catch (err) {
    for (const r of started) await killAndWait(r.pid);
    throw err;
  }
  writeJobFile(c, job.id, RECORD, JSON.stringify({ services: started }, null, 2) + "\n");
  return started.map(({ name, pid, log: l }) => ({ name, pid, log: l }));
}

/** Kills each recorded service this record can attribute; a reused pid is reported and left alone. */
export async function servicesDown(c, job, { log = () => {}, startOf = processStart } = {}) {
  const rec = readRecord(c, job);
  const killed = [], skipped = [];
  if (!rec) return { killed, skipped };
  for (const r of rec.services) {
    const j = judge(r, startOf);
    if (j === "ours") { await killAndWait(r.pid); killed.push(r.name); log(`stopped ${r.name} pid ${r.pid}`); }
    else if (j === "foreign") { skipped.push({ name: r.name, pid: r.pid, reason: "pid now belongs to another process" }); log(`left pid ${r.pid} alone: not ${r.name}`); }
    else skipped.push({ name: r.name, pid: r.pid, reason: "already stopped" });
  }
  try { unlinkSync(join(jobDir(c, job.id), RECORD)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return { killed, skipped };
}
