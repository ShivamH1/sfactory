import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.mjs";
import { slugify } from "./store.mjs";

export const GRACE_MS = 5000;
const lockPath = (c, name) => join(c.stateDir, "locks", `${slugify(name)}.lock`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function parse(path) {
  try { const b = JSON.parse(readFileSync(path, "utf8")); return b && typeof b === "object" && typeof b.holder === "string" ? b : null; } catch { return null; }
}
function mtimeAge(path, now) { try { return now - statSync(path).mtimeMs; } catch { return 0; } }

export function isStale(body, now, staleMs) {
  if (body.durable === true) return false;
  if (body.pid != null && !alive(body.pid)) return true;
  return now - Date.parse(body.since) > staleMs;
}

/** What is at `path`: { none } | { body, stale } | { corrupt, stale }. */
function inspect(path, staleMs) {
  if (!existsSync(path)) return { none: true };
  const now = Date.now();
  const body = parse(path);
  if (body) return { body, stale: isStale(body, now, staleMs) };
  // Unparseable or empty: a writer mid-create (young) or a crashed one (older than GRACE_MS).
  return { corrupt: true, stale: mtimeAge(path, now) > GRACE_MS };
}

export function status(c, name, { staleMs = c.limits?.lockStaleMs ?? 3_600_000 } = {}) {
  const s = inspect(lockPath(c, name), staleMs);
  if (s.none) return { held: false };
  if (s.corrupt) return { held: true, holder: "unknown", corrupt: true, stale: s.stale };
  const { token: _token, ...rest } = s.body;
  return { held: true, ...rest, stale: s.stale };
}

function tryCreate(path, body) {
  let fd;
  try { fd = openSync(path, "wx"); } catch (e) { if (e.code === "EEXIST") return false; throw e; }
  try { writeSync(fd, JSON.stringify(body, null, 2)); } finally { closeSync(fd); }
  return true;
}

/** Atomically remove a stale lock by renaming it away. Returns the removed holder's name, or null if another process got there first. */
function takeOver(path, judged) {
  const moved = `${path}.stale-${randomUUID()}`;
  try { renameSync(path, moved); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const now = parse(moved);
  const same = judged.corrupt ? now === null : now !== null && now.since === judged.body.since && now.token === judged.body.token;
  if (!same) { try { renameSync(moved, path); } catch { /* a newer lock is already in place */ } return null; }
  try { unlinkSync(moved); } catch { /* already gone */ }
  return judged.corrupt ? "unknown" : judged.body.holder;
}

const heldMessage = (name, cur) => `${name} is held by ${cur.body?.holder ?? "unknown"} since ${cur.body?.since ?? "?"}`;

/** One attempt, shared by acquire and acquireSync: returns the Lock, or null when the lock is held. */
function tryAcquireOnce(c, name, { holder, staleMs, pid, durable }) {
  const path = lockPath(c, name);
  let tookOverFrom;
  for (let i = 0; i < 3; i++) {
    const s = inspect(path, staleMs);
    if (!s.none && s.stale) {
      const from = takeOver(path, s);
      if (from !== null) tookOverFrom = from;
    }
    if (!s.none && !s.stale) return null;
    const token = randomUUID();
    const body = { name, holder, token, pid: durable ? null : pid, since: new Date().toISOString() };
    if (durable) body.durable = true;
    if (tryCreate(path, body)) {
      const out = { ...body, path, release: () => release(c, name, { holder, token }) };
      if (tookOverFrom !== undefined) out.tookOverFrom = tookOverFrom;
      return out;
    }
    if (inspect(path, staleMs).none) continue;
    return null;
  }
  return null;
}

function checkArgs(c, holder, waitMs) {
  if (!holder) fail("BAD_ARGS", "acquire needs a holder");
  if (!Number.isInteger(waitMs) || waitMs < 0) fail("BAD_ARGS", "waitMs must be an integer >= 0");
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
}

export function acquireSync(c, name, { holder, staleMs = c.limits?.lockStaleMs ?? 3_600_000, pid = process.pid, durable = false } = {}) {
  checkArgs(c, holder, 0);
  const l = tryAcquireOnce(c, name, { holder, staleMs, pid, durable });
  if (!l) fail("LOCK_HELD", heldMessage(name, inspect(lockPath(c, name), staleMs)));
  return l;
}

export async function acquire(c, name, { holder, waitMs = 0, pollMs = 500, staleMs = c.limits?.lockStaleMs ?? 3_600_000, pid = process.pid, durable = false } = {}) {
  checkArgs(c, holder, waitMs);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const l = tryAcquireOnce(c, name, { holder, staleMs, pid, durable });
    if (l) return l;
    if (Date.now() >= deadline) fail("LOCK_HELD", heldMessage(name, inspect(lockPath(c, name), staleMs)));
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }
}

export function release(c, name, { holder, token } = {}) {
  const path = lockPath(c, name);
  const moved = `${path}.rel-${randomUUID()}`;
  try { renameSync(path, moved); } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  const cur = parse(moved);
  // A body with no token predates token ownership (worktree.mjs writes one): holder alone matches it.
  const ok = cur !== null && cur.holder === holder && (cur.token === undefined || cur.token === token);
  if (!ok) {
    try { renameSync(moved, path); } catch { /* a newer lock is already in place */ }
    fail("NOT_HOLDER", `${name} is held by ${cur?.holder ?? "unknown"}, not ${holder}`);
  }
  unlinkSync(moved);
  return true;
}

export async function withLock(c, name, opts, fn) {
  const l = await acquire(c, name, opts);
  let result;
  try { result = await fn(l); } catch (e) {
    try { l.release(); } catch (re) { console.error(`lock ${name}: release failed: ${re.message}`); }
    throw e;
  }
  l.release();
  return result;
}
