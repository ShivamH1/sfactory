/**
 * A Codex `exec --json` stream as display blocks, for the board's live output pane. Pure: text in, blocks out, so
 * the browser and the test suite run the same code. An item's started/updated/completed events merge into one
 * block by its id; anything the renderer does not know is kept as a raw line, never dropped.
 */
export function renderCodexStream(text) {
  const blocks = [];
  const byId = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { blocks.push({ kind: "raw", text: line }); continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) { blocks.push({ kind: "raw", text: line }); continue; }
    if (e.type === "thread.started") { byId.clear(); continue; } // item ids are numbered per run
    if (e.type === "turn.started") continue;
    if (e.type === "turn.completed" && e.usage && typeof e.usage === "object") {
      blocks.push({ kind: "usage", input: num(e.usage.input_tokens), cached: num(e.usage.cached_input_tokens), output: num(e.usage.output_tokens) });
      continue;
    }
    if ((e.type === "item.started" || e.type === "item.updated" || e.type === "item.completed") && e.item && typeof e.item === "object") {
      const b = blockOf(e.item);
      if (!b) { blocks.push({ kind: "raw", text: line }); continue; }
      const id = e.item.id;
      const prior = typeof id === "string" ? byId.get(id) : undefined;
      if (prior && prior.kind === b.kind) Object.assign(prior, b);
      else { blocks.push(b); if (typeof id === "string") byId.set(id, b); }
      continue;
    }
    blocks.push({ kind: "raw", text: line });
  }
  return blocks;
}

const num = (v) => (Number.isFinite(v) ? v : null);

/** Any JSON value as display text, never throwing. */
const str = (v, fallback = "") => {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  try { return JSON.stringify(v) ?? fallback; } catch { return fallback; }
};

const statusOf = (s) => (s === "completed" || s === "failed" ? s : "running");

function blockOf(it) {
  if (it.type === "agent_message") return { kind: "message", text: str(it.text) };
  if (it.type === "reasoning") return { kind: "reasoning", text: str(it.text) };
  if (it.type === "command_execution") {
    return { kind: "command", command: str(it.command), output: str(it.aggregated_output), exit: Number.isInteger(it.exit_code) ? it.exit_code : null, status: statusOf(it.status) };
  }
  if (it.type === "file_change") {
    const changes = (Array.isArray(it.changes) ? it.changes : []).map((ch) => ({ path: str(ch?.path), change: str(ch?.kind, "update") }));
    return { kind: "files", changes, status: statusOf(it.status) };
  }
  return null;
}

/** The first `max` lines of a command's output, and how many lines are hidden after them (a trailing newline is not a line). */
export function splitOutput(text, max = 12) {
  const lines = String(text ?? "").replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") return { shown: "", hidden: 0 };
  return { shown: lines.slice(0, max).join("\n"), hidden: Math.max(0, lines.length - max) };
}
