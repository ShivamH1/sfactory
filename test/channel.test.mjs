import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpRepo, writeConfig } from "./helpers.mjs";
import { createChannel, INSTRUCTIONS, REPLY_TOOL } from "../src/channel/server.mjs";
import { postMessage, messages, unread, reply } from "../src/chat.mjs";
import { loadConfig } from "../src/config.mjs";

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

test("channel: a second channel server on the same thread still offers a pushed message to its own session, and neither writes a second mark", () => {
  const { c, sent, ch } = setup();
  const m = postMessage(c, { text: "for every open session" });
  ch.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(sent.length, 1);
  assert.equal(messages(c)[0].status, "pushed");
  const sent2 = [];
  const ch2 = createChannel({ c, send: (x) => sent2.push(x), now: () => "2026-11-02T12:00:01.000Z" });
  ch2.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual(sent2, [{ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "for every open session", meta: { message_id: m.id } } }]);
  assert.equal(ch2.pushNew(), 0, "never twice from one process");
  assert.equal(ch.pushNew(), 0);
  const marks = readFileSync(join(c.stateDir, "chat", "thread.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "pushed");
  assert.equal(marks.length, 1, "one pushed mark, written by the first server");
});

test("channel: a message already seen or answered is not offered", () => {
  const { c, sent, ch } = setup();
  const m = postMessage(c, { text: "taken" });
  unread(c);
  const a = postMessage(c, { text: "answered" });
  reply(c, { replyTo: a.id, text: "done" });
  ch.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(sent.length, 0);
  assert.equal(messages(c).find((x) => x.id === m.id).status, "seen");
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

test("channel: with no config it answers the protocol, gives no instructions, lists no tools and pushes nothing", () => {
  const sent = [];
  const ch = createChannel({ c: null, send: (m) => sent.push(m) });
  ch.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].result.serverInfo.name, "sfactory");
  assert.equal("instructions" in sent[0].result, false);
  ch.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(ch.pushNew(), 0);
  assert.equal(sent.length, 1);
  ch.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 2, result: { tools: [] } });
});

test("channel: the instructions name the board as the source and both ways to answer", () => {
  assert.match(INSTRUCTIONS, /They are written from the sfactory board on this machine, with the standing of the board's buttons\./);
  assert.match(INSTRUCTIONS, /Answer every message, with the reply tool \(message_id and your text\) or `sfactory chat reply <id> "<text>"`\./);
  assert.doesNotMatch(INSTRUCTIONS, /own words from their own machine/);
  assert.match(INSTRUCTIONS, /never stands in for a gate/);
});

test("channel: the plugin manifest declares the server", () => {
  const p = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(p.mcpServers, { sfactory: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/src/channel/server.mjs"] } });
});

async function runProgram(script) {
  const repo = tmpRepo();
  writeConfig(repo, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: tmpDir("sf-chan-state-") });
  const child = spawn(process.execPath, [script], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const exited = new Promise((res) => child.once("exit", res));
  try {
    const rl = createInterface({ input: child.stdout });
    const lines = [];
    let wake = null;
    rl.on("line", (l) => { lines.push(l); if (wake) wake(); });
    const nextLine = (ms) => new Promise((res, rej) => {
      const t = setTimeout(() => { wake = null; rej(new Error("no line within " + ms + " ms")); }, ms);
      const check = () => { if (lines.length) { clearTimeout(t); wake = null; res(lines.shift()); } };
      wake = check; check();
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    const init = JSON.parse(await nextLine(5000));
    assert.equal(init.id, 1);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const cfg = loadConfig(repo);
    const m = postMessage(cfg, { text: "hello from the board" });
    const push = JSON.parse(await nextLine(5000));
    assert.equal(push.method, "notifications/claude/channel");
    assert.equal(push.params.content, "hello from the board");
    assert.deepEqual(push.params.meta, { message_id: m.id });
    child.stdin.end();
    const code = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("did not exit")), 5000))]);
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

const SCRIPT = fileURLToPath(new URL("../src/channel/server.mjs", import.meta.url));

test("channel: run as a program it pushes a posted message over stdout and exits when stdin ends", { timeout: 15000 }, () => runProgram(SCRIPT));

test("channel: the program part also runs when launched through a directory link", { timeout: 15000 }, async (t) => {
  const link = join(tmpDir("sf-chan-link-"), "src-link");
  try { symlinkSync(fileURLToPath(new URL("../src", import.meta.url)), link, "junction"); }
  catch (e) { t.skip(`cannot make a directory link here (${e.code})`); return; }
  try { await runProgram(join(link, "channel", "server.mjs")); }
  finally { unlinkSync(link); }
});
