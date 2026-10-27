import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.mjs";
import { slugify } from "./store.mjs";

const lockPath = (c, name) => join(c.stateDir, "locks", `${slugify(name)}.lock`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function read(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }

export function status(c, name) {
  const p = lockPath(c, name);
  const body = existsSync(p) ? read(p) : null;
  return body ? { held: true, ...body } : { held: false };
}

function tryCreate(path, body) {
  let fd;
  try { fd = openSync(path, "wx"); } catch (e) { if (e.code === "EEXIST") return false; throw e; }
  writeSync(fd, JSON.stringify(body, null, 2)); closeSync(fd); return true;
}

export async function acquire(c, name, { holder, waitMs = 0, pollMs = 500, staleMs = c.limits?.lockStaleMs ?? 3_600_000 } = {}) {
  if (!holder) fail("BAD_ARGS", "acquire needs a holder");
  mkdirSync(join(c.stateDir, "locks"), { recursive: true });
  const path = lockPath(c, name);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const body = { name, holder, pid: process.pid, since: new Date().toISOString() };
    const cur = existsSync(path) ? read(path) : null;
    if (cur) {
      const stale = !alive(cur.pid) || Date.now() - Date.parse(cur.since) > staleMs;
      if (stale) { body.tookOverFrom = cur.holder; try { unlinkSync(path); } catch {} }
    }
    if (tryCreate(path, body)) return { ...body, path, release: () => release(c, name, { holder }) };
    if (Date.now() >= deadline) { const h = read(path); fail("LOCK_HELD", `${name} is held by ${h?.holder ?? "unknown"} since ${h?.since ?? "?"}`); }
    await sleep(pollMs);
  }
}

export function release(c, name, { holder }) {
  const path = lockPath(c, name);
  const cur = existsSync(path) ? read(path) : null;
  if (!cur) return false;
  if (cur.holder !== holder) fail("NOT_HOLDER", `${name} is held by ${cur.holder}, not ${holder}`);
  unlinkSync(path);
  return true;
}

export async function withLock(c, name, opts, fn) {
  const l = await acquire(c, name, opts);
  try { return await fn(l); } finally { try { l.release(); } catch {} }
}
