import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync, renameSync, statSync, linkSync } from "node:fs";
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

/**
 * Durable: never stale. A named pid: stale only when that process is gone, however old the lock
 * (a live suite may run for hours). No pid (a CLI-held lock): stale once older than staleMs.
 */
export function isStale(body, now, staleMs) {
  if (body.durable === true) return false;
  if (body.pid != null) return !alive(body.pid);
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

const guardPath = (path) => path + ".takeover";
/** Age in ms of the takeover guard, or null when there is none. A guard is never cleared automatically, however old. */
function guardAge(path) { try { return Date.now() - statSync(guardPath(path)).mtimeMs; } catch { return null; } }

/** Operator's decision: remove a takeover guard whose taker is known to be gone. */
export function clearGuard(c, name) {
  try { unlinkSync(guardPath(lockPath(c, name))); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

export function status(c, name, { staleMs = c.limits?.lockStaleMs ?? 3_600_000 } = {}) {
  const age = guardAge(lockPath(c, name));
  if (age !== null) return { held: true, holder: "<taking over>", takeover: true, guardAge: Math.round(age) };
  const s = inspect(lockPath(c, name), staleMs);
  if (s.none) return { held: false };
  if (s.corrupt) return { held: true, holder: "unknown", corrupt: true, stale: s.stale };
  const { token: _token, ...rest } = s.body;
  return { held: true, ...rest, stale: s.stale };
}

const BUSY = ["EEXIST", "EPERM", "EBUSY", "EACCES"];
/** Exclusive create: the open fd, or null when the path is busy (its errno noted in `note.code`). */
function openNew(path, note) {
  try { return openSync(path, "wx"); } catch (e) { if (BUSY.includes(e.code)) { if (note) note.code = e.code; return null; } throw e; }
}
function tryCreate(path, body, note) {
  const fd = openNew(path, note);
  if (fd === null) return false;
  try { writeSync(fd, JSON.stringify(body, null, 2)); } finally { closeSync(fd); }
  return true;
}

function writeNew(path, body, note) { return tryCreate(path, body, note); }

const sameJudged = (judged, now) => now.stale && (judged.corrupt ? now.corrupt === true : now.body !== undefined && now.body.since === judged.body.since && now.body.token === judged.body.token);

const heldMessage = (c, name, staleMs, note = {}) => {
  const path = lockPath(c, name);
  const age = guardAge(path);
  if (age !== null) return `${name}: takeover guard present (${guardPath(path)}, ${Math.round(age / 1000)} s old); if no taker is running, remove it with: sfactory lock clear ${name} --guard`;
  const cur = inspect(path, staleMs);
  // Nothing there, yet every create failed: not a holder but a filesystem refusal.
  if (cur.none) return note.code && note.code !== "EEXIST" ? `${name}: could not create ${path} (${note.code}); check permissions` : `${name} was released while acquiring; retry`;
  return `${name} is held by ${cur.body?.holder ?? "unknown"} since ${cur.body?.since ?? "?"}`;
};

/** One attempt, shared by acquire and acquireSync: returns the Lock, or null when the lock is held or a takeover is busy. */
function tryAcquireOnce(c, name, { holder, staleMs, pid, durable }, note = {}) {
  const path = lockPath(c, name);
  const gp = guardPath(path);
  const make = (tookOverFrom) => {
    const token = randomUUID();
    const body = { name, holder, token, pid: durable ? null : pid, since: new Date().toISOString() };
    if (durable) body.durable = true;
    if (tookOverFrom !== undefined) body.tookOverFrom = tookOverFrom;
    return body;
  };
  const lockOf = (body) => ({ ...body, path, release: () => release(c, name, { holder, token: body.token }) });
  for (let i = 0; i < 4; i++) {
    const s = inspect(path, staleMs);
    if (s.none) {
      if (guardAge(path) !== null) return null;
      const body = make();
      if (writeNew(path, body, note)) return lockOf(body);
      continue;
    }
    if (!s.stale) return null;
    // Stale: serialise the takeover through the guard file; nothing ever renames onto the lock path.
    const guard = { by: holder, token: randomUUID(), since: new Date().toISOString() };
    const gfd = openNew(gp, note);
    if (gfd === null) return null; // another taker, or a guard left behind: busy either way
    let wrote = false;
    try {
      // The body is written inside the try so a failed write still reaches the cleanup below.
      try { writeSync(gfd, JSON.stringify(guard, null, 2)); wrote = true; } finally { closeSync(gfd); }
      const again = inspect(path, staleMs);
      if (!again.none) {
        if (!sameJudged(s, again)) return null;
        try { unlinkSync(path); } catch (e) { if (e.code !== "ENOENT") return null; }
      }
      const body = make(s.corrupt ? "unknown" : s.body.holder);
      return writeNew(path, body, note) ? lockOf(body) : null;
    } finally {
      // Remove the guard only if it is still ours: our token, or unparseable after our own write failed.
      try {
        const text = readFileSync(gp, "utf8");
        let mine;
        try { mine = JSON.parse(text).token === guard.token; } catch { mine = !wrote; }
        if (mine) unlinkSync(gp);
      } catch { /* gone, or unreadable: leave it */ }
    }
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
  const note = {};
  const l = tryAcquireOnce(c, name, { holder, staleMs, pid, durable }, note);
  if (!l) fail("LOCK_HELD", heldMessage(c, name, staleMs, note));
  return l;
}

export async function acquire(c, name, { holder, waitMs = 0, pollMs = 500, staleMs = c.limits?.lockStaleMs ?? 3_600_000, pid = process.pid, durable = false } = {}) {
  checkArgs(c, holder, waitMs);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const note = {};
    const l = tryAcquireOnce(c, name, { holder, staleMs, pid, durable }, note);
    if (l) return l;
    if (Date.now() >= deadline) fail("LOCK_HELD", heldMessage(c, name, staleMs, note));
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }
}

// A body with no token predates token ownership: holder alone matches it.
const owns = (cur, holder, token) => cur !== null && cur.holder === holder && (cur.token === undefined || cur.token === token);

/** Throws NOT_HOLDER unless the lock is absent or held by `holder` with `token`: the check release() makes, without releasing. */
export function assertHolder(c, name, { holder, token } = {}) {
  const path = lockPath(c, name);
  if (!existsSync(path)) return;
  const cur = parse(path);
  if (!owns(cur, holder, token)) fail("NOT_HOLDER", `${name} is held by ${cur?.holder ?? "unknown"}, not ${holder}`);
}

export function release(c, name, { holder, token } = {}) {
  const path = lockPath(c, name);
  if (!existsSync(path)) return false;
  const cur = parse(path);
  if (!owns(cur, holder, token)) fail("NOT_HOLDER", `${name} is held by ${cur?.holder ?? "unknown"}, not ${holder}`);
  const moved = `${path}.rel-${randomUUID()}`;
  try { renameSync(path, moved); } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  const got = parse(moved);
  if (got !== null && got.holder === holder && got.token === cur.token) { unlinkSync(moved); return true; }
  // We moved someone else's lock (a takeover landed between our read and our rename): put it back without overwriting.
  try { linkSync(moved, path); unlinkSync(moved); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    console.error(`lock ${name}: could not restore a lock moved by mistake; left at ${moved}`);
  }
  return false;
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
