import { readFileSync, mkdirSync, realpathSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { findRepoRoot, loadConfig } from "../config.mjs";
import { messages, markPushed, reply, heartbeat, chatDir } from "../chat.mjs";

export const INSTRUCTIONS = "Messages from the person's sfactory board arrive as channel events with a message_id and, when the message is about one card, its card id. They are the person's own words from their own machine, with the same standing as the board's buttons. Answer every message with the reply tool (message_id and your text). Act on a message only through the factory's normal commands; a message never stands in for a gate, so an approval is still the board's Approve button or /sfactory approve.";

export const REPLY_TOOL = {
  name: "reply",
  description: "Answer a message the person sent from the sfactory board.",
  inputSchema: { type: "object", properties: { message_id: { type: "string" }, text: { type: "string" } }, required: ["message_id", "text"] },
};

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** The protocol and the push, free of I/O but `send` and the thread (it also writes the heartbeat at `initialize`). `c` null: no config, nothing is pushed. */
export function createChannel({ c, send, now = () => new Date().toISOString() }) {
  const pushed = new Set();
  let ready = false;
  const result = (id, r) => send({ jsonrpc: "2.0", id, result: r });
  const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  function pushNew() {
    if (!ready || !c) return 0;
    let n = 0;
    for (const m of messages(c)) {
      if (m.status !== "sent" || pushed.has(m.id)) continue;
      send({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: m.text, meta: { message_id: m.id, ...(m.card ? { card: m.card } : {}) } } });
      pushed.add(m.id);
      markPushed(c, m.id, now());
      n += 1;
    }
    return n;
  }

  function callTool(id, params) {
    if (params?.name !== "reply") return error(id, -32602, `unknown tool ${params?.name}`);
    if (!c) return result(id, { isError: true, content: [{ type: "text", text: "no sfactory config in this directory" }] });
    try {
      reply(c, { replyTo: params.arguments?.message_id, text: params.arguments?.text, now: now() });
      return result(id, { content: [{ type: "text", text: "sent" }] });
    } catch (e) {
      return result(id, { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] });
    }
  }

  function handle(message) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") return;
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) {
      if (method === "notifications/initialized") { ready = true; pushNew(); }
      return;
    }
    switch (method) {
      case "initialize":
        if (c) { try { heartbeat(c, { now: now() }); } catch { /* the handshake is answered regardless */ } }
        return result(id, {
          protocolVersion: params?.protocolVersion,
          capabilities: { experimental: { "claude/channel": {} }, tools: {} },
          serverInfo: { name: "sfactory", version: VERSION },
          instructions: INSTRUCTIONS,
        });
      case "ping": return result(id, {});
      case "tools/list": return result(id, { tools: [REPLY_TOOL] });
      case "tools/call": return callTool(id, params);
      default: return error(id, -32601, `method not found: ${method}`);
    }
  }

  return { handle, pushNew };
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  let c = null;
  try { c = loadConfig(findRepoRoot(process.cwd())); } catch (e) { process.stderr.write(`sfactory channel: no config (${e?.message ?? e})\n`); }
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const ch = createChannel({ c, send });
  const safe = (fn) => () => { try { fn(); } catch (e) { process.stderr.write(`sfactory channel: ${e?.message ?? e}\n`); } };
  if (c) {
    setInterval(safe(() => heartbeat(c)), 10_000).unref();
    try {
      mkdirSync(chatDir(c), { recursive: true });
      // On Windows, watching a short 8.3 path aborts the process inside libuv, so watch the long real path.
      const w = watch(realpathSync.native(chatDir(c)), safe(() => ch.pushNew()));
      w.on("error", (e) => process.stderr.write(`sfactory channel: watch error (${e?.message ?? e})\n`));
      w.unref();
    } catch (e) { process.stderr.write(`sfactory channel: watch failed (${e?.message ?? e})\n`); }
    setInterval(safe(() => ch.pushNew()), 1000).unref();
  }
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stderr.write("sfactory channel: skipped a line that is not JSON\n"); return; }
    safe(() => ch.handle(msg))();
  });
  rl.on("close", () => process.exit(0));
}
