import { openSync, readSync, closeSync, fstatSync, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { listJobs, readJob, jobDir } from "../store.mjs";
import { readEvents, runningAgents } from "../events.mjs";
import { fail } from "../errors.mjs";

export const ACTIVITY_LIMIT = 200;
export const ACTIVITY_MAX = 500;
export const TAIL_MAX = 64 * 1024;

/** A card at offset 0 is left out: a missing key already means 0, so a board of history cards keeps a short cursor. */
const encodeCursor = (o) => Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v > 0)))).toString("base64url");
function decodeCursor(s) {
  try {
    const o = JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
    if (o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every((v) => Number.isInteger(v) && v >= 0)) return o;
  } catch { /* refused below */ }
  fail("BAD_ARGS", "the cursor is not one this board gave");
}

/**
 * Every complete event of one card from `from`, each with its end offset, and `start`, the offset actually read
 * from: 0 when the log is now shorter than `from` (readEvents restarts a replaced file), so a cut cursor never
 * keeps a stale offset.
 */
function eventsFrom(c, id, from) {
  const out = [];
  let off = from, start = null;
  for (;;) {
    const r = readEvents(c, id, { from: off });
    if (start === null) start = off <= r.size ? off : 0;
    out.push(...r.events.map((e) => ({ ...e, id })));
    if (r.next === off || r.next >= r.size) return { events: out, start, end: r.next };
    off = r.next;
  }
}

/**
 * The board's timeline. With no cursor: the newest `limit` events across every card, oldest first, and a cursor
 * at the end of every card's log. With a cursor: what was written since, oldest first, at most `limit`, merged by
 * time without ever skipping within a card (each card's cursor is the end of its last returned event).
 */
export function activity(c, { cursor, limit } = {}, { now = Date.now() } = {}) {
  const n = Math.min(ACTIVITY_MAX, Math.max(1, Number.isInteger(limit) ? limit : ACTIVITY_LIMIT));
  const jobs = listJobs(c);
  const from = cursor === undefined || cursor === null || cursor === "" ? null : decodeCursor(cursor);
  const queues = jobs.map((j) => ({ id: j.id, ...eventsFrom(c, j.id, from ? (from[j.id] ?? 0) : 0) }));
  // A k-way merge by `at`: each card's events stay in file order, so a prefix of the merge is a prefix of every card.
  const merged = [];
  const heads = queues.map(() => 0);
  for (;;) {
    let best = -1;
    for (let i = 0; i < queues.length; i++) {
      const e = queues[i].events[heads[i]];
      if (e && (best < 0 || String(e.at) < String(queues[best].events[heads[best]].at))) best = i;
    }
    if (best < 0) break;
    merged.push(queues[best].events[heads[best]++]);
  }
  const next = Object.fromEntries(queues.map((q) => [q.id, q.end]));
  let events;
  if (!from) events = merged.slice(-n);
  else if (merged.length <= n) events = merged;
  else {
    events = merged.slice(0, n);
    for (const q of queues) next[q.id] = q.start;
    for (const e of events) next[e.id] = Math.max(next[e.id], e.end);
  }
  return { events: events.map(({ end, ...e }) => e), cursor: encodeCursor(next), running: runningAgents(c, jobs, { now }) };
}

/**
 * Up to TAIL_MAX bytes of one log in a card's folder from `from` (past the end: from 0), cut after the last
 * newline when the read is full and holds one. Only .log, .jsonl and .md files inside the card's folder.
 */
export function tail(c, id, rel, from = 0) {
  readJob(c, id);
  const base = resolve(jobDir(c, id));
  const f = resolve(base, String(rel ?? ""));
  if (!f.startsWith(base + sep) || !/\.(log|jsonl|md)$/i.test(f)) fail("FORBIDDEN_FILE", `"${rel}" is not a log in ${id}'s folder`);
  if (!existsSync(f) || !statSync(f).isFile()) fail("FILE_NOT_FOUND", `${id} has no ${rel}`);
  const fd = openSync(f, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Number.isInteger(from) && from >= 0 && from <= size ? from : 0;
    const len = Math.min(TAIL_MAX, size - start);
    const buf = Buffer.alloc(Math.max(0, len));
    const got = len > 0 ? readSync(fd, buf, 0, len, start) : 0;
    let used = got;
    if (got === TAIL_MAX) { const nl = buf.subarray(0, got).lastIndexOf(0x0a); if (nl >= 0) used = nl + 1; }
    return { text: buf.subarray(0, used).toString("utf8"), from: start, next: start + used, size };
  } finally { closeSync(fd); }
}
