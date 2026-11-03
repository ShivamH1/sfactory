import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.mjs";
import { readAllJsonLines } from "./events.mjs";

/**
 * The board's conversation with the orchestrator session: one append-only file of person messages, session
 * replies and marks (pushed by the channel, read by the session). A message's status is the furthest mark.
 */
export const MAX_TEXT = 4000;
export const HEARTBEAT_FRESH_MS = 30_000;
export const chatDir = (c) => join(c.stateDir, "chat");
export const threadPath = (c) => join(chatDir(c), "thread.jsonl");
const heartbeatPath = (c) => join(chatDir(c), "channel.json");
const CARD_RE = /^[mf]-\d+$/;
const RANK = { sent: 0, pushed: 1, seen: 2, answered: 3 };

const newId = () => `msg-${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const append = (c, entry) => { mkdirSync(chatDir(c), { recursive: true }); appendFileSync(threadPath(c), `${JSON.stringify(entry)}\n`); return entry; };
function checkText(text) {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) fail("BAD_ARGS", `a message needs text of 1 to ${MAX_TEXT} characters`);
  return text;
}

/** A message from the person, about the whole factory or about one card. */
export function postMessage(c, { text, card = null, now = new Date().toISOString() } = {}) {
  checkText(text);
  if (card !== null && card !== undefined && !CARD_RE.test(String(card))) fail("BAD_ARGS", `"${card}" is not a card id`);
  return append(c, { type: "message", id: newId(), at: now, from: "person", ...(card ? { card: String(card) } : {}), text });
}

/** Every message, oldest first, with its status (the furthest mark) and its replies. */
export function messages(c) {
  const all = readAllJsonLines(threadPath(c));
  const byId = new Map();
  for (const e of all) {
    if (e.type === "message" && typeof e.id === "string" && typeof e.text === "string") {
      byId.set(e.id, { id: e.id, at: e.at ?? null, ...(typeof e.card === "string" ? { card: e.card } : {}), text: e.text, status: "sent", replies: [] });
    }
  }
  const raise = (m, s) => { if (RANK[s] > RANK[m.status]) m.status = s; };
  for (const e of all) {
    if ((e.type === "pushed" || e.type === "read") && byId.has(e.id)) raise(byId.get(e.id), e.type === "pushed" ? "pushed" : "seen");
    if (e.type === "reply" && byId.has(e.replyTo) && typeof e.text === "string") {
      const m = byId.get(e.replyTo);
      m.replies.push({ id: e.id ?? null, at: e.at ?? null, text: e.text });
      raise(m, "answered");
    }
  }
  return [...byId.values()];
}

/** The messages the session has not taken yet (optionally one card's); each is marked read as it is returned. */
export function unread(c, { card = null, now = new Date().toISOString() } = {}) {
  const list = messages(c).filter((m) => (m.status === "sent" || m.status === "pushed") && (!card || m.card === card));
  for (const m of list) append(c, { type: "read", id: m.id, at: now });
  return list;
}

/** The session's answer to one message. */
export function reply(c, { replyTo, text, now = new Date().toISOString() } = {}) {
  checkText(text);
  const m = messages(c).find((x) => x.id === replyTo);
  if (!m) fail("MESSAGE_NOT_FOUND", `no message ${replyTo}`);
  return append(c, { type: "reply", id: newId(), at: now, from: "session", replyTo, ...(m.card ? { card: m.card } : {}), text });
}

/** A channel server offered this message to its session (which may not have the channel flag: not proof it was read). */
export function markPushed(c, id, now = new Date().toISOString()) { return append(c, { type: "pushed", id, at: now }); }

export function heartbeat(c, { pid = process.pid, now = new Date().toISOString() } = {}) {
  mkdirSync(chatDir(c), { recursive: true });
  writeFileSync(heartbeatPath(c), `${JSON.stringify({ pid, at: now })}\n`);
}

/** Whether the channel is running: its heartbeat is fresh. */
export function channelStatus(c, { now = Date.now() } = {}) {
  try {
    const b = JSON.parse(readFileSync(heartbeatPath(c), "utf8"));
    const t = typeof b?.at === "string" ? Date.parse(b.at) : NaN;
    if (Number.isNaN(t)) return { connected: false, at: null };
    return { connected: now - t >= 0 && now - t < HEARTBEAT_FRESH_MS, at: b.at };
  } catch { return { connected: false, at: null }; }
}
