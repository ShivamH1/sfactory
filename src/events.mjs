import { appendFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { WORKING } from "./job.mjs";

/**
 * Each card's append-only event log, one JSON object per line. job.json stays the truth: an append that fails
 * warns and carries on, and nothing here ever fails a command. This module imports only src/job.mjs, so the store
 * and the lock module can call it without an import cycle.
 */
export const EVENTS_FILE = "events.jsonl";
export const MAX_LINE_BYTES = 1024;
export const KINDS = ["stage", "gate", "agent", "suite", "service", "lock", "commit", "note"];
export const STALE_AGENT_MS = 6 * 60 * 60 * 1000;
const ID_RE = /^[mf]-\d+$/;

export const eventsPath = (c, id) => join(c.stateDir, "jobs", id, EVENTS_FILE);

/** Fields never cut: the timeline needs them whole. */
const UNCUT = new Set(["at", "by", "kind"]);
const chars = (s) => Array.from(s); // code points, so a cut never splits a character

/**
 * One event as one line of at most MAX_LINE_BYTES, by shortening its longest string fields (each cut strictly
 * shorter, by whole characters; `at`, `by` and `kind` never cut); never split. Null when it still cannot fit.
 */
export function encodeEvent(event) {
  const o = { ...event };
  let s = JSON.stringify(o);
  while (Buffer.byteLength(s) > MAX_LINE_BYTES - 1) {
    const longest = Object.keys(o).filter((k) => !UNCUT.has(k) && typeof o[k] === "string" && chars(o[k]).length > 17)
      .sort((a, b) => chars(o[b]).length - chars(o[a]).length)[0];
    if (!longest) return null;
    const cs = chars(o[longest]);
    o[longest] = `${cs.slice(0, Math.max(16, Math.floor(cs.length * 0.6))).join("")}…`;
    s = JSON.stringify(o);
  }
  return `${s}\n`;
}

/**
 * Append one event to card `id`'s log. An id that is not a card's, or a card with no folder, writes nothing and
 * says nothing (a lock or a suite run held by something that is not a card). Any other failure warns and returns false.
 */
export function appendEvent(c, id, event, { now = new Date().toISOString(), warn = (m) => process.stderr.write(m) } = {}) {
  if (!ID_RE.test(String(id))) return false;
  try {
    if (!existsSync(join(c.stateDir, "jobs", String(id)))) return false;
    if (!KINDS.includes(event?.kind)) throw new Error(`unknown event kind "${event?.kind}"`);
    const line = encodeEvent({ at: now, by: "session", ...event });
    if (line === null) throw new Error(`the event does not fit in ${MAX_LINE_BYTES} bytes`);
    appendFileSync(eventsPath(c, id), line);
    return true;
  } catch (e) {
    warn(`warning: ${id}: event not recorded (${e.message})\n`);
    return false;
  }
}

/**
 * Items of a JSON-lines file from byte offset `from`, reading at most `maxBytes`: complete lines only, each item with
 * `end`, the offset after its line; a line that does not parse is skipped. `next` is where the next read starts.
 * A missing file is empty; an offset past the end (the file was replaced) starts again from 0.
 */
export function readJsonLines(f, { from = 0, maxBytes = 256 * 1024 } = {}) {
  if (!existsSync(f)) return { items: [], next: 0, size: 0 };
  const fd = openSync(f, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Number.isInteger(from) && from >= 0 && from <= size ? from : 0;
    const len = Math.min(maxBytes, size - start);
    const buf = Buffer.alloc(Math.max(0, len));
    const n = len > 0 ? readSync(fd, buf, 0, len, start) : 0;
    const chunk = buf.subarray(0, n);
    const last = chunk.lastIndexOf(0x0a);
    const items = [];
    if (last < 0) return { items, next: start, size };
    let pos = 0;
    while (pos <= last) {
      const nl = chunk.indexOf(0x0a, pos);
      try {
        const e = JSON.parse(chunk.subarray(pos, nl).toString("utf8"));
        if (e && typeof e === "object" && !Array.isArray(e)) items.push({ ...e, end: start + nl + 1 });
      } catch { /* a line that does not parse is skipped */ }
      pos = nl + 1;
    }
    return { items, next: start + last + 1, size };
  } finally { closeSync(fd); }
}

/** Every complete item of a JSON-lines file. */
export function readAllJsonLines(f) {
  const out = [];
  let from = 0;
  for (;;) {
    const r = readJsonLines(f, { from });
    out.push(...r.items);
    if (r.next === from || r.next >= r.size) return out;
    from = r.next;
  }
}

/** Events of card `id` from byte offset `from`: see readJsonLines. */
export function readEvents(c, id, opts = {}) {
  const { items, next, size } = readJsonLines(eventsPath(c, id), opts);
  return { events: items, next, size };
}

/** Every complete event of card `id`. */
export function readAllEvents(c, id) {
  return readAllJsonLines(eventsPath(c, id));
}

/**
 * The agents running now: an agent start with no later finish of the same vendor, role and task, on a card in a
 * working stage, started less than `staleMs` ago. An older unmatched start is an agent that ended unrecorded.
 */
export function runningAgents(c, jobs, { now = Date.now(), staleMs = STALE_AGENT_MS } = {}) {
  const out = [];
  for (const j of jobs) {
    if (!WORKING.includes(j.stage)) continue;
    const open = new Map();
    for (const e of readAllEvents(c, j.id)) {
      if (e.kind !== "agent") continue;
      const key = `${e.vendor}|${e.role}|${e.task ?? ""}`;
      if (e.phase === "start") open.set(key, e);
      else if (e.phase === "finish") open.delete(key);
    }
    for (const e of open.values()) {
      const t = typeof e.at === "string" ? Date.parse(e.at) : NaN;
      if (Number.isNaN(t) || now - t > staleMs) continue;
      out.push({ id: j.id, role: e.role, task: e.task ?? null, vendor: e.vendor, model: e.model ?? null, startedAt: e.at, log: e.log ?? null });
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
