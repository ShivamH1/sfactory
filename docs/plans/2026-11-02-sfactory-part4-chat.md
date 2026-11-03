# sfactory Part 4 — talking to the session from the board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A composer bar at the bottom of the board lets the person write to the orchestrator session (generally or about one card) and read its replies in a thread; messages reach the session live through a Claude Code channel when the session runs with one, and always at the factory's next step.

**Architecture:** The thread is one append-only file, `<stateDir>/chat/thread.jsonl`, written by the board (person messages), the CLI and the channel (marks and replies) through one module, `src/chat.mjs`. `sfactory chat` gives the session `unread`, `reply` and `list`. The board gains `GET /chat.json` and `POST /chat` and a composer module. The plugin ships a channel: a hand-written JSON-RPC-over-stdio MCP server (`src/channel/server.mjs`, zero dependencies) declared in the plugin manifest, which pushes each new person message into the session as a `notifications/claude/channel` event and offers a `reply` tool.

**Tech Stack:** Node ≥ 20, ESM, plain browser ES modules, `node:test`, zero runtime dependencies.

**Spec:** `docs/plans/2026-10-30-sfactory-roadmap-activity-design.md` §6.4 (talking to the session), §5 (the chat routes), §7 (the skills' chat steps), §10 part 4.

**Branch:** `feat/chat`, cut from `feat/board-redesign` (Part 3); its pull request targets `feat/board-redesign` until that merges.

**Where this plan departs from the spec, on purpose:**
- **Delivery marks.** The channel cannot know whether the session was started with channels enabled (an MCP server runs either way, and a push to a session without channels is dropped silently). So a channel push writes a `pushed` mark, not "delivered": a message leaves the session's `unread` list only when the session itself takes it (`sfactory chat unread`, which writes a `read` mark) or answers it. Statuses are *sent* → *pushed* (the channel handed it to the session) → *seen* (the session read it at a step) → *answered*. A message the channel pushed into a session without channels still reaches it at the next step. The board's indicator says "Channel running" when the channel's heartbeat is fresh, otherwise "Read at the factory's next step".
- **The chat read.** `GET /chat.json` answers the derived thread (the newest 200 messages with their status and replies) and the channel status, not raw lines by offset: a thread is small, and folding marks on the client would duplicate `src/chat.mjs`.
- **The channel's declaration** is inline in `.claude-plugin/plugin.json` (`mcpServers`), not a repo-root `.mcp.json`, which a session opened in the plugin's own repo would read as a project server with no `${CLAUDE_PLUGIN_ROOT}`.

*Note (2026-11-02, final review):* the spec's `GET /api/chat?from=<offset>` and `POST /api/chat` were built as `GET /chat.json` (the derived thread and the channel status) and `POST /chat`. The final fix wave, on top of the six tasks: the `pushed` status reads "offered to the session" and the indicator's tooltip says live delivery needs the session's channel flag (Claude Code starts the channel server in every session where the plugin is enabled, and an unflagged session drops its pushes); each channel server offers every message not yet taken (`sent` or `pushed`) to its own session once per server process (a restarted server offers again whatever is still unread), and only the first offer writes the mark; the channel's instructions name the board as the source and both ways to answer, and with no config it gives no instructions and lists no tools; `sfactory chat` refuses a `--card` with no value, resolves it only for `unread` and `list`, and takes a reply's text after `--` as it is; a successful send leaves the thread as the person left it and shows a short "Sent" note, the scope chip holds its choice while the box holds a draft, `POST /chat` times out after 15 s with "The message may not have been sent.", a held Enter sends once, and the demo's empty thread says messages are off; the orchestrator skill lists `chat`, prefers `sfactory chat reply`, and carries on when `sfactory chat unread` fails; `readJsonLines` skips past a complete line longer than its window, so it always advances; and README, INSTALL, DESIGN and the spec's §6.4 (a dated note) say the same.

## Global Constraints

- Node 20 or later; `"dependencies": {}` stays empty (the MCP server is hand-written JSON-RPC over stdio, newline-delimited).
- The plugin is generic: no company, product, person or machine-specific word in any file.
- Every `sfactory ...` command line in README, INSTALL, DESIGN or a skill uses a registered verb and flag (`test/docs.test.mjs`).
- The board stays bound to 127.0.0.1 with its Host check; every POST carries `X-Sfactory-Board: 1`; text only through `textContent`; no inline handlers; `localStorage` in try/catch; the look rules of Part 3 hold (one accent per meaning: champagne only for what needs the person; sage for live; hairlines; no glow).
- A message is 1–4,000 characters; a card tag is an existing card's id.
- A board message has the person's own standing, like the board's gate buttons, and never stands in for a gate: approval stays the *Approve* button or `/sfactory approve`.
- Nothing about the chat may fail a factory command: a chat write that fails reports its error to the caller of that chat command only.
- Make every source and test edit with the Edit or Write tool, never a heredoc, sed or script rewrite. Never `git stash`; stage named paths only; commits carry no trailers.
- The full suite (`node --test`) is green at the end of every task; `test/services.test.mjs`, `test/suite.test.mjs` and `test/lock.test.mjs` hold load-sensitive timing tests (rerun alone before blaming a change).

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/events.mjs` | JSON-lines reading | `readJsonLines` / `readAllJsonLines` exported; `readEvents` uses them |
| `src/chat.mjs` (new) | the thread: post, read, statuses, unread, reply, marks, heartbeat | all of it |
| `src/commands/chat.mjs` (new), `src/cli.mjs` | `sfactory chat unread|reply|list` | new command |
| `src/board/server.mjs` | routes | `GET /chat.json`, `POST /chat`, `chat.mjs` asset |
| `src/channel/server.mjs` (new) | the channel MCP server | all of it |
| `.claude-plugin/plugin.json` | manifest | `mcpServers.sfactory` |
| `board/chat.mjs` (new), `board/dashboard.html`, `board/board.css`, `board/board.mjs` | the composer | new module, markup, styles, mount |
| `skills/sfactory/SKILL.md`, `skills/sdd/SKILL.md` | the chat steps | `sfactory chat unread` at each step; replies |
| `README.md`, `INSTALL.md`, `docs/DESIGN.md`, `package.json`, `.claude-plugin/plugin.json`, `test/cli.test.mjs` | docs, version | 0.6.0 |

---

### Task 1: The thread

**Depends on:** none

**Files:**
- Modify: `src/events.mjs`
- Create: `src/chat.mjs`
- Create: `test/chat.test.mjs`

**Interfaces:**
- Produces in `src/events.mjs`: `readJsonLines(path, { from = 0, maxBytes = 262144 }) → { items, next, size }` (each item carries `end`; complete lines only; unparseable lines skipped; an offset past the end starts at 0; a missing file is empty) and `readAllJsonLines(path) → items[]`; `readEvents` and `readAllEvents` keep their behaviour and names, now thin wrappers (`readEvents` returns `{ events: items, next, size }`).
- Produces in `src/chat.mjs`: `MAX_TEXT = 4000`, `HEARTBEAT_FRESH_MS = 30000`, `chatDir(c)`, `threadPath(c)`; `postMessage(c, { text, card, now }) → entry` (`{ type: "message", id, at, from: "person", card?, text }`); `messages(c) → [{ id, at, card?, text, status, replies: [{ id, at, text }] }]` oldest first, `status` one of `sent | pushed | seen | answered` (the furthest mark wins); `unread(c, { card, now }) → messages` (status `sent` or `pushed`, optionally only one card's; writes a `read` mark for each); `reply(c, { replyTo, text, now }) → entry` (`{ type: "reply", id, at, from: "session", replyTo, card?, text }`; `MESSAGE_NOT_FOUND` for an unknown id); `markPushed(c, id, now)`; `heartbeat(c, { pid, now })` (writes `chat/channel.json`); `channelStatus(c, { now }) → { connected, at }` (`connected` when the heartbeat is under `HEARTBEAT_FRESH_MS` old). Ids are `msg-<base36 time>-<8 hex>`. A bad text is `BAD_ARGS` ("a message needs text of 1 to 4000 characters"); a card that is not an `m-<n>`/`f-<n>` id is `BAD_ARGS`.

- [x] **Step 1: Write the failing tests**

Create `test/chat.test.mjs`:

```js
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
```

- [x] **Step 2: Run it to see it fail** — `node --test test/chat.test.mjs`. Expected: FAIL (module missing).

- [x] **Step 3: Implement**

In `src/events.mjs`, move the body of `readEvents` into an exported `readJsonLines(path, { from = 0, maxBytes = 256 * 1024 } = {})` that returns `{ items, next, size }` (same logic, `items` in place of `events`), add `readAllJsonLines(path)` (loop as `readAllEvents` does), and make `readEvents(c, id, opts)` return `({ events, next, size })` from `readJsonLines(eventsPath(c, id), opts)` and `readAllEvents(c, id)` return `readAllJsonLines(eventsPath(c, id))`. Keep every current export and behaviour.

Create `src/chat.mjs`:

```js
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

/** The channel handed this message to the session (which may not have channels enabled: not proof it was read). */
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
```

- [x] **Step 4: Run the tests, then the full suite** — `node --test test/chat.test.mjs test/events.test.mjs`, then `node --test`. Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/events.mjs src/chat.mjs test/chat.test.mjs
git commit -m "feat(chat): the board's thread with the session — messages, marks, replies, the channel heartbeat"
```

---

### Task 2: `sfactory chat`

**Depends on:** Task 1

**Files:**
- Create: `src/commands/chat.mjs`
- Modify: `src/cli.mjs` (register the command)
- Create: `test/cli.chat.test.mjs`

**Interfaces:**
- Consumes: `unread`, `reply`, `messages` (Task 1).
- Produces: `sfactory chat unread [--card <id>] [--json]` (prints each message as `<id>  <card or "general">  <at>` then its text and a blank line, or "No new messages."; marks each read), `sfactory chat reply <id> "<text>"` (prints the reply's id), `sfactory chat list [--card <id>] [--json]` (one line per message: id, card or general, status, then its text; replies indented); `ACCEPTS = { verbs: ["unread", "reply", "list"], flags: ["card", "json"] }`; `M<n>` resolves for `--card` through `resolveId`.

- [x] **Step 1: Write the failing tests**

Create `test/cli.chat.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpRepo, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadConfig } from "../src/config.mjs";
import { postMessage, messages } from "../src/chat.mjs";

const repo = () => { const r = tmpRepo(); writeConfig(r, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } }); return r; };
async function run(cwd, args) {
  const out = [], err = [];
  const code = await main(args, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
}

test("cli chat: unread prints and marks, reply answers, list shows statuses", async () => {
  const r0 = repo();
  const c = loadConfig(r0);
  const m = postMessage(c, { text: "Why is m-1 parked?", card: "m-1", now: "2026-11-02T12:00:00.000Z" });
  let r = await run(r0, ["chat", "unread"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${m.id}  m-1  2026-11-02T12:00:00.000Z\nWhy is m-1 parked?\n\n`);
  assert.equal((await run(r0, ["chat", "unread"])).out, "No new messages.\n");
  r = await run(r0, ["chat", "reply", m.id, "It is waiting for your answer on decision 2."]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^msg-/);
  assert.equal(messages(c)[0].status, "answered");
  r = await run(r0, ["chat", "list"]);
  assert.match(r.out, new RegExp(`^${m.id}  m-1  answered\\nWhy is m-1 parked\\?\\n  ↳ It is waiting for your answer on decision 2\\.\\n`));
});

test("cli chat: --card filters, --json prints objects, refusals exit non-zero", async () => {
  const r0 = repo();
  const c = loadConfig(r0);
  postMessage(c, { text: "general" });
  const b = postMessage(c, { text: "about m-2", card: "m-2" });
  const r = await run(r0, ["chat", "unread", "--card", "m-2", "--json"]);
  assert.deepEqual(JSON.parse(r.out).map((x) => x.id), [b.id]);
  assert.notEqual((await run(r0, ["chat", "reply", "msg-none", "hi"])).code, 0);
  assert.notEqual((await run(r0, ["chat", "reply", b.id])).code, 0);
  assert.notEqual((await run(r0, ["chat", "shout"])).code, 0);
});
```

- [x] **Step 2: Run it to see it fail.** Expected: FAIL (`chat` is an unknown command).

- [x] **Step 3: Implement**

Create `src/commands/chat.mjs` following the shape of the other commands (`register(name, handler, ACCEPTS)`, `loadConfig(findRepoRoot(io.cwd))`): verb `unread` → `unread(c, { card })` with `card` resolved through `resolveId` when given, printing as the interface says (`--json` prints `JSON.stringify(list, null, 2)`); verb `reply` → the id is `positional[1]`, the text the rest of the positionals joined by a space (refuse `BAD_ARGS` "usage: sfactory chat reply <id> \"<text>\"" when either is missing), print the new reply's id; verb `list` → `messages(c)` filtered by card, printed as the interface says (replies as `  ↳ <text>` lines). An unknown or missing verb is `UNKNOWN_COMMAND` / `BAD_ARGS` with the usage. Add `import("./commands/chat.mjs"),` to the command list in `src/cli.mjs` (keep it alphabetical).

- [x] **Step 4: Run the tests, then the full suite.** Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/commands/chat.mjs src/cli.mjs test/cli.chat.test.mjs
git commit -m "feat(chat): sfactory chat unread, reply and list"
```

---

### Task 3: The board's chat routes

**Depends on:** Task 1

**Files:**
- Modify: `src/board/server.mjs`
- Modify: `test/board.server.test.mjs`

**Interfaces:**
- Consumes: `postMessage`, `messages`, `channelStatus` (Task 1); `readJob` (store).
- Produces: `GET /chat.json` → `{ messages: <the newest 200 of messages(view)>, channel: channelStatus(view) }` (demo mode: the demo folder's thread, usually empty); `POST /chat` with the board header and a JSON body `{ text, card? }` → `200 { message: <the entry> }`; `card` must be an existing card (`JOB_NOT_FOUND` 404 otherwise); a bad text is 400; demo mode is 403 (`DEMO`), as for the gates; `STATUS` gains `MESSAGE_NOT_FOUND: 404`; `ASSETS` gains `"chat.mjs": "text/javascript; charset=utf-8"`.

- [x] **Step 1: Write the failing tests**

Append to `test/board.server.test.mjs`:

```js
test("server: POST /chat and GET /chat.json", async () => {
  const c = mk();
  actions.add(c, { kind: "milestone", title: "One" });
  await withBoard(c, {}, async (b) => {
    let r = await post(b, "chat", { text: "How is m-1 going?", card: "m-1" });
    assert.equal(r.status, 200);
    const { message } = await r.json();
    assert.equal(message.card, "m-1");
    const s = await (await fetch(`${b.url}chat.json`)).json();
    assert.deepEqual(s.messages.map((m) => [m.id, m.status]), [[message.id, "sent"]]);
    assert.deepEqual(s.channel, { connected: false, at: null });
    assert.equal((await post(b, "chat", { text: "" })).status, 400);
    assert.equal((await post(b, "chat", { text: "hi", card: "m-9" })).status, 404);
    assert.equal((await post(b, "chat", { text: "hi" }, { "Content-Type": "application/json" })).status, 403);
  });
});
```

(`post(b, path, body, headers)` is the file's helper; the last call omits the board header.)

- [x] **Step 2: Run it to see it fail.** Expected: FAIL (404).

- [x] **Step 3: Implement** in `src/board/server.mjs`: import from `../chat.mjs`; add the asset entry and the status code; before the gate POST route add:

```js
      if (req.method === "GET" && url.pathname === "/chat.json") {
        return sendJson(res, 200, { messages: messages(view).slice(-200), channel: channelStatus(view) });
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        if (demoDir) return sendJson(res, 403, { code: "DEMO" });
        if (req.headers["x-sfactory-board"] !== "1") return sendJson(res, 403, { code: "NO_HEADER" });
        const body = await readBody(req);
        if (body.card !== undefined && body.card !== null) {
          if (typeof body.card !== "string") throw new SfactoryError("BAD_ARGS", '"card" must be a card id');
          readJob(view, body.card);
        }
        return sendJson(res, 200, { message: postMessage(view, { text: body.text, card: body.card ?? null }) });
      }
```

- [x] **Step 4: Run the tests, then the full suite.** Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/board/server.mjs test/board.server.test.mjs
git commit -m "feat(board): the chat routes"
```

---

### Task 4: The channel

**Depends on:** Task 1

**Files:**
- Create: `src/channel/server.mjs`
- Modify: `.claude-plugin/plugin.json`
- Create: `test/channel.test.mjs`

**Interfaces:**
- Consumes: `messages`, `markPushed`, `reply`, `heartbeat` (Task 1); `findRepoRoot`, `loadConfig` (config).
- Produces: `createChannel({ c, send, now }) → { handle(message), pushNew() }` exported from `src/channel/server.mjs` (pure of I/O but `send` and the thread); `INSTRUCTIONS` (the text sent at `initialize`); `REPLY_TOOL` (the tool's definition); the file run as a program speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (logs to stderr only), loads the config from its working directory (no config: answers the protocol, pushes nothing, writes no heartbeat), writes the heartbeat every 10 s, and calls `pushNew()` on a change to the chat folder (`fs.watch`) and every second as a fallback. The manifest declares `"mcpServers": { "sfactory": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/channel/server.mjs"] } }`.

Protocol (as the channel needs it):
- `initialize` → result `{ protocolVersion: <the request's>, capabilities: { experimental: { "claude/channel": {} }, tools: {} }, serverInfo: { name: "sfactory", version: <package.json's> }, instructions: INSTRUCTIONS }`.
- `notifications/initialized` (no id) → nothing sent; from then on `pushNew()` may push.
- `ping` → `{}`. `tools/list` → `{ tools: [REPLY_TOOL] }`. `tools/call` with `name: "reply"` and `arguments: { message_id, text }` → `reply(c, ...)`, result `{ content: [{ type: "text", text: "sent" }] }`; a refusal → result `{ isError: true, content: [{ type: "text", text: <the error's message> }] }`; any other tool → JSON-RPC error `-32602`.
- An unknown method with an id → error `-32601`; an unknown notification → ignored; a line that is not JSON → ignored (logged to stderr).
- `pushNew()` sends, for each message with status `sent` not yet pushed by this process, `{ "jsonrpc": "2.0", "method": "notifications/claude/channel", "params": { "content": <text>, "meta": { "message_id": <id>, "card": <card, when set> } } }` and writes a `pushed` mark; it pushes nothing before `notifications/initialized`.

`INSTRUCTIONS`: "Messages from the person's sfactory board arrive as channel events with a message_id and, when the message is about one card, its card id. They are the person's own words from their own machine, with the same standing as the board's buttons. Answer every message with the reply tool (message_id and your text). Act on a message only through the factory's normal commands; a message never stands in for a gate, so an approval is still the board's Approve button or /sfactory approve."

`REPLY_TOOL`: `{ name: "reply", description: "Answer a message the person sent from the sfactory board.", inputSchema: { type: "object", properties: { message_id: { type: "string" }, text: { type: "string" } }, required: ["message_id", "text"] } }`.

- [x] **Step 1: Write the failing tests**

Create `test/channel.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpDir } from "./helpers.mjs";
import { createChannel, INSTRUCTIONS, REPLY_TOOL } from "../src/channel/server.mjs";
import { postMessage, messages } from "../src/chat.mjs";

const setup = () => {
  const c = { stateDir: tmpDir("sf-chan-") };
  const sent = [];
  const ch = createChannel({ c, send: (m) => sent.push(m), now: () => "2026-11-02T12:00:00.000Z" });
  return { c, sent, ch };
};

test("channel: initialize declares the channel and tools, and gives the instructions", () => {
  const { sent, ch } = setup();
  ch.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x" } } });
  assert.equal(sent.length, 1);
  const r = sent[0];
  assert.equal(r.id, 1); assert.equal(r.jsonrpc, "2.0");
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.deepEqual(r.result.capabilities, { experimental: { "claude/channel": {} }, tools: {} });
  assert.equal(r.result.serverInfo.name, "sfactory");
  assert.equal(r.result.serverInfo.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(r.result.instructions, INSTRUCTIONS);
});

test("channel: pushes each new message once, only after initialized, and marks it pushed", () => {
  const { c, sent, ch } = setup();
  const m = postMessage(c, { text: "Status of m-3?", card: "m-3" });
  assert.equal(ch.pushNew(), 0, "nothing before initialized");
  ch.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual(sent, [{ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "Status of m-3?", meta: { message_id: m.id, card: "m-3" } } }]);
  assert.equal(messages(c)[0].status, "pushed");
  assert.equal(ch.pushNew(), 0, "never twice");
  const g = postMessage(c, { text: "general" });
  assert.equal(ch.pushNew(), 1);
  assert.deepEqual(sent.at(-1).params.meta, { message_id: g.id });
});

test("channel: tools/list and the reply tool", () => {
  const { c, sent, ch } = setup();
  const m = postMessage(c, { text: "q" });
  ch.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(sent.at(-1).result, { tools: [REPLY_TOOL] });
  ch.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reply", arguments: { message_id: m.id, text: "answer" } } });
  assert.deepEqual(sent.at(-1).result, { content: [{ type: "text", text: "sent" }] });
  assert.equal(messages(c)[0].status, "answered");
  ch.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "reply", arguments: { message_id: "msg-none", text: "x" } } });
  assert.equal(sent.at(-1).result.isError, true);
  ch.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "shout", arguments: {} } });
  assert.equal(sent.at(-1).error.code, -32602);
});

test("channel: ping, unknown methods and notifications", () => {
  const { sent, ch } = setup();
  ch.handle({ jsonrpc: "2.0", id: 6, method: "ping" });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 6, result: {} });
  ch.handle({ jsonrpc: "2.0", id: 7, method: "resources/list" });
  assert.equal(sent.at(-1).error.code, -32601);
  const n = sent.length;
  ch.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
  assert.equal(sent.length, n);
});

test("channel: with no config it answers the protocol and pushes nothing", () => {
  const sent = [];
  const ch = createChannel({ c: null, send: (m) => sent.push(m) });
  ch.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  ch.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(ch.pushNew(), 0);
  assert.equal(sent.length, 1);
});

test("channel: the plugin manifest declares the server", () => {
  const p = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(p.mcpServers, { sfactory: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/src/channel/server.mjs"] } });
});
```

Add one end-to-end test that spawns `node src/channel/server.mjs` with `cwd` a temp repo holding a config (`tmpRepo` + `writeConfig`), writes `initialize` and `notifications/initialized` lines to its stdin, posts a message with `postMessage`, and reads one `notifications/claude/channel` line from its stdout within 5 s; then ends stdin and confirms the process exits (bounded wait, `{ timeout: 15000 }` on the test).

- [x] **Step 2: Run it to see it fail.** Expected: FAIL (module missing).

- [x] **Step 3: Implement** `src/channel/server.mjs`: `createChannel` as the interface and protocol say (track pushed ids in a `Set`; read the version from `package.json` once); then the program part, guarded by `if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)`: load the config (`try { loadConfig(findRepoRoot(process.cwd())) } catch { null }`), `send = (m) => process.stdout.write(JSON.stringify(m) + "\n")`, a `readline` on stdin feeding `handle` (a line that does not parse is logged to stderr and skipped), the heartbeat every 10 s and once at `initialize` (only with a config), `fs.watch` on the chat folder (created if missing) plus a 1 s `setInterval` calling `pushNew()`, every timer `unref`'d, and `process.exit(0)` when stdin ends. Add the `mcpServers` entry to `.claude-plugin/plugin.json`.

  > **Dated note, 2026-11-02 (standing OK, Task 4 review):** the guard above compares an unresolved argv path with the real path in `import.meta.url`, so a server launched through a symlink or junction silently ran nothing. It uses `src/cli.mjs`'s `isMain()` pattern instead (both sides through `realpathSync`). The `initialize` heartbeat cannot block the handshake's answer; a watch error is logged; a pushed id is remembered only after `send` returns.

- [x] **Step 4: Run the tests, then the full suite.** Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/channel/server.mjs .claude-plugin/plugin.json test/channel.test.mjs
git commit -m "feat(chat): the channel — a zero-dependency MCP server that pushes board messages into the session"
```

---

### Task 5: The composer

**Depends on:** Task 3

**Files:**
- Create: `board/chat.mjs`
- Modify: `board/dashboard.html`, `board/board.css`, `board/board.mjs`
- Modify: `test/board.page.test.mjs`

**Interfaces:**
- Consumes: `GET /chat.json`, `POST /chat`; the snapshot's jobs; the board's context card (the card open in the drawer, or the agent selected in the Activity view).
- Produces: `mountChat(root, { getSnapshot, getContextCard })` exported from `board/chat.mjs`, returning `{ start(), stop() }`; `board.mjs` mounts it once and starts it on load (both views).

**What to build** (spec §6.4; Part 3's look rules and tokens; no mockup exists, so match the Activity view's glass panels and type):
- **The bar**, fixed to the bottom of the page across both views, a glass panel: a text box (auto-growing to about six lines; Enter sends, Shift+Enter a new line; a character count appears from 3,600 and turns `--danger` past 4,000, when *Send* refuses), a scope chip ("General", or the context card's pill — `M<n>` or id — when there is one; clicking it toggles between the card and General; `aria-pressed`), and a *Send* button (`.btn.go`, the view's one champagne action) disabled while the text is empty or sending. The page's bottom padding grows so the bar never covers a card.
- **The thread**, a collapsible panel just above the bar: a toggle "Conversation" with "· n new" when replies arrived since the person last opened it (remembered per viewer in `localStorage`, try/catch); messages oldest at the top, newest at the bottom, each with its card pill (or "General"), its time in mono and a status word — "sent", "handed to the session" (pushed), "seen", "answered" — and its replies indented under it, in a calmer surface. It scrolls to the newest when opened or when a message is sent.
- **The indicator** at the bar's right: "Channel running" (sage dot) when `channel.connected`, else "Read at the factory's next step" (ink dot), with a `title` explaining the other way.
- **Polling**: `/chat.json` every `pollMs` (from the snapshot), one request in flight, paused while the tab is hidden or the chat stopped; after a send, poll at once. A failed send keeps the text in the box and shows the server's message quietly under it; a failed poll shows nothing but keeps the last thread.
- **Demo mode**: the bar shows, disabled, with "Messages are off in the demo".
- **Accessibility**: the text box has a label; the thread toggle is `aria-expanded`; new replies are announced politely only when the count changes (a dedicated, otherwise silent element), never on every poll; focus visible; colour never the only signal.
- Text only through `textContent`; no `innerHTML`; `board/chat.mjs` touches no `document` at import time.

- [x] **Step 1: Write the failing tests**

Append to `test/board.page.test.mjs` (read `chat.mjs` beside the others):

```js
test("chat: the composer mounts on both views and talks to the chat routes", () => {
  const chat = read("chat.mjs");
  assert.match(js, /from "\.\/chat\.mjs"/);
  assert.match(chat, /export function mountChat/);
  assert.match(chat, /\/chat\.json/);
  assert.match(chat, /"\/chat"/);
  assert.match(chat, /X-Sfactory-Board/);
  assert.match(chat, /Channel running/);
  assert.match(chat, /Read at the factory's next step/);
  assert.match(chat, /handed to the session/);
  assert.match(chat, /document\.hidden/);
  assert.match(chat, /Messages are off in the demo/);
  assert.equal(chat.includes("innerHTML"), false);
  assert.match(shell, /id="chat"/);
});
```

Append to `test/board.render.test.mjs` a smoke test that `board/chat.mjs` imports in node and exports `mountChat` as a function.

- [x] **Step 2: Run them to see them fail.** Expected: FAIL.

- [x] **Step 3: Implement** the list. Then look at it in a browser on the demo board (disabled state) and on a throwaway server outside the repo that serves the real page with a chat thread (a sent, a seen and an answered message; the channel connected and not), in both themes and at 360 px; stop everything you start and confirm by the process list; screenshots under `.superpowers/screens/part4/`.

- [x] **Step 4: Run the touched tests, then the full suite.** Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add board/chat.mjs board/dashboard.html board/board.css board/board.mjs test/board.page.test.mjs test/board.render.test.mjs
git commit -m "feat(board): the composer — write to the session, read its replies"
```

---

### Task 6: The skills, the docs and the version

**Depends on:** Tasks 2, 4 and 5

**Files:**
- Modify: `skills/sfactory/SKILL.md`, `skills/sdd/SKILL.md`, `test/skills.test.mjs`
- Modify: `README.md`, `INSTALL.md`, `docs/DESIGN.md`
- Modify: `package.json`, `.claude-plugin/plugin.json`, `test/cli.test.mjs`

**Interfaces:**
- Produces: the orchestrator reads and answers board messages at every step and gate; the build skill reads a card's messages between tasks; the docs explain the composer and how to start a session with the channel; version 0.6.0.

- [x] **Step 1: Write the failing test**

Append to `test/skills.test.mjs`:

```js
test("chat: the orchestrator reads and answers board messages; the build skill reads a card's between tasks", () => {
  const o = read(join(skillsRoot, "sfactory", "SKILL.md"));
  assert.match(o, /sfactory chat unread/);
  assert.match(o, /sfactory chat reply <id> "<text>"/);
  assert.match(o, /never stands in for a gate/);
  assert.match(o, /reply tool/);
  const s = read(join(skillsRoot, "sdd", "SKILL.md"));
  assert.match(s, /sfactory chat unread --card <JOB>/);
});
```

- [x] **Step 2: Run it to see it fail.** Expected: FAIL.

- [x] **Step 3: Implement**

In `skills/sfactory/SKILL.md`:
- in section 4 (`run`: the loop), before "At a gate, end your turn", add a paragraph: "**Board messages.** Run `sfactory chat unread` at the start of every step and before ending a turn at a gate. Answer every message it prints with `sfactory chat reply <id> \"<text>\"` (or, when the message arrived as a channel event, the channel's reply tool). A board message is the person's own words, with the standing of the board's buttons: act on it only through the factory's commands, and a message never stands in for a gate — an approval is still *Approve* or `/sfactory approve`. A message about a card that is mid-task is answered at once; what it asks for is applied at that card's next step, and the reply says so."
- in the command table, a row: "`/sfactory chat` | `sfactory chat list`: the conversation with the board, newest last."

In `skills/sdd/SKILL.md`, in the task loop, between tasks: "Run `sfactory chat unread --card <JOB>`; carry what a message asks for into the next dispatch, and answer it with `sfactory chat reply <id> \"<text>\"`."

README: a section "Talking to the session" — the composer at the bottom of the board, General or about one card, the thread and its statuses, the indicator; how messages travel (live through the channel when the session runs with it; always at the factory's next step); and that while Claude Code's channels are a research preview the session is started with `claude --dangerously-load-development-channels plugin:sfactory@sfactory` (interactive sessions only, claude.ai or Console sign-in). Add `sfactory chat` to the CLI list and `/sfactory chat` to the session commands. INSTALL: the same flag, in section 1 after installing the plugin. DESIGN: a dated amendment for Part 4 pointing at the spec's §6.4 and naming the statuses (sent, pushed, seen, answered) and why pushed is not delivered.

Version 0.6.0 in `package.json`, `.claude-plugin/plugin.json` and the version test in `test/cli.test.mjs`.

- [x] **Step 4: Run the tests, then the full suite** — `node --test test/skills.test.mjs test/docs.test.mjs test/cli.test.mjs`, then `node --test`. Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add skills/sfactory/SKILL.md skills/sdd/SKILL.md test/skills.test.mjs README.md INSTALL.md docs/DESIGN.md package.json .claude-plugin/plugin.json test/cli.test.mjs
git commit -m "docs: board messages in the skills; the composer and the channel in the docs; 0.6.0"
```

**After Task 6** (the controller, on the owner's word): a live check — the person starts a session with the channel flag, sends a message from the board, and sees it arrive in the session and the reply appear on the board.
