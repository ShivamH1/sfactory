import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { MAX_TEXT, threadPath, chatDir, postMessage, messages, unread, reply, markPushed, heartbeat, channelStatus } from "../src/chat.mjs";
import { readJsonLines, readEvents } from "../src/events.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-chat-") });
const AT = "2026-11-02T12:00:00.000Z";

test("chat: a posted message is one line; messages derives its status from later marks", () => {
  const c = cfg();
  const m = postMessage(c, { text: "Is M14 blocked on anything?", card: "m-14", now: AT });
  assert.match(m.id, /^msg-[0-9a-z]+-[0-9a-f]{8}$/);
  assert.deepEqual(JSON.parse(readFileSync(threadPath(c), "utf8").trim()), { type: "message", id: m.id, at: AT, from: "person", card: "m-14", text: "Is M14 blocked on anything?" });
  assert.equal(messages(c)[0].status, "sent");
  markPushed(c, m.id, AT);
  assert.equal(messages(c)[0].status, "pushed");
  assert.deepEqual(unread(c, { now: AT }).map((x) => x.id), [m.id]);
  assert.equal(messages(c)[0].status, "seen");
  assert.deepEqual(unread(c, { now: AT }), [], "a message is unread once");
  const r = reply(c, { replyTo: m.id, text: "No — it is waiting on the suite lock.", now: AT });
  assert.equal(r.card, "m-14");
  const [after] = messages(c);
  assert.equal(after.status, "answered");
  assert.deepEqual(after.replies.map((x) => x.text), ["No — it is waiting on the suite lock."]);
  markPushed(c, m.id, AT);
  assert.equal(messages(c)[0].status, "answered", "a later mark never moves a status back");
});

test("chat: unread filters by card and skips answered messages", () => {
  const c = cfg();
  const a = postMessage(c, { text: "general question", now: AT });
  const b = postMessage(c, { text: "about m-2", card: "m-2", now: AT });
  const d = postMessage(c, { text: "answered already", now: AT });
  reply(c, { replyTo: d.id, text: "done", now: AT });
  assert.deepEqual(unread(c, { card: "m-2", now: AT }).map((x) => x.id), [b.id]);
  assert.deepEqual(unread(c, { now: AT }).map((x) => x.id), [a.id]);
});

test("chat: refusals", () => {
  const c = cfg();
  for (const text of ["", "   ", "x".repeat(MAX_TEXT + 1), 42]) assert.throws(() => postMessage(c, { text }), (e) => e.code === "BAD_ARGS");
  assert.throws(() => postMessage(c, { text: "hi", card: "../x" }), (e) => e.code === "BAD_ARGS");
  assert.throws(() => reply(c, { replyTo: "msg-none", text: "hi" }), (e) => e.code === "MESSAGE_NOT_FOUND");
  assert.equal(postMessage(c, { text: "x".repeat(MAX_TEXT) }).text.length, MAX_TEXT);
});

test("chat: the thread ignores junk lines and unknown marks", () => {
  const c = cfg();
  const m = postMessage(c, { text: "hello", now: AT });
  writeFileSync(threadPath(c), readFileSync(threadPath(c), "utf8") + 'not json\n{"type":"read","id":"msg-unknown"}\n{"type":"reply","replyTo":"msg-unknown","text":"x"}\n');
  assert.deepEqual(messages(c).map((x) => [x.id, x.status]), [[m.id, "sent"]]);
});

test("chat: heartbeat and channel status", () => {
  const c = cfg();
  assert.deepEqual(channelStatus(c, { now: Date.parse(AT) }), { connected: false, at: null });
  heartbeat(c, { pid: 123, now: AT });
  assert.deepEqual(channelStatus(c, { now: Date.parse(AT) + 10_000 }), { connected: true, at: AT });
  assert.equal(channelStatus(c, { now: Date.parse(AT) + 31_000 }).connected, false);
  mkdirSync(chatDir(c), { recursive: true });
  writeFileSync(join(chatDir(c), "channel.json"), "garbage");
  assert.equal(channelStatus(c, { now: Date.parse(AT) }).connected, false);
});

test("events: readJsonLines is the shared reader; readEvents keeps its shape", () => {
  const c = cfg();
  mkdirSync(join(c.stateDir, "jobs", "m-1"), { recursive: true });
  const f = join(c.stateDir, "jobs", "m-1", "events.jsonl");
  writeFileSync(f, '{"kind":"note","text":"a"}\nbad\n{"kind":"note","text":"b"}\n{"kind":"no');
  const r = readJsonLines(f);
  assert.deepEqual(r.items.map((x) => x.text), ["a", "b"]);
  assert.ok(r.next < r.size);
  assert.deepEqual(readEvents(c, "m-1").events.map((x) => x.text), ["a", "b"]);
  assert.deepEqual(readJsonLines(join(c.stateDir, "missing.jsonl")), { items: [], next: 0, size: 0 });
});
