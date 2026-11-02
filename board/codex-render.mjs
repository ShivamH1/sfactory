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
    if (e.type === "thread.started" || e.type === "turn.started") continue;
    if (e.type === "turn.completed" && e.usage && typeof e.usage === "object") {
      blocks.push({ kind: "usage", input: num(e.usage.input_tokens), cached: num(e.usage.cached_input_tokens), output: num(e.usage.output_tokens) });
      continue;
    }
    if ((e.type === "item.started" || e.type === "item.updated" || e.type === "item.completed") && e.item && typeof e.item === "object") {
      const b = blockOf(e.item);
      if (!b) { blocks.push({ kind: "raw", text: line }); continue; }
      const id = e.item.id;
      if (id !== undefined && byId.has(id)) Object.assign(byId.get(id), b);
      else { blocks.push(b); if (id !== undefined) byId.set(id, b); }
      continue;
    }
    blocks.push({ kind: "raw", text: line });
  }
  return blocks;
}

const num = (v) => (Number.isFinite(v) ? v : null);

function blockOf(it) {
  if (it.type === "agent_message") return { kind: "message", text: String(it.text ?? "") };
  if (it.type === "reasoning") return { kind: "reasoning", text: String(it.text ?? "") };
  if (it.type === "command_execution") {
    const status = it.status === "completed" || it.status === "failed" ? it.status : "running";
    return { kind: "command", command: String(it.command ?? ""), output: String(it.aggregated_output ?? ""), exit: Number.isInteger(it.exit_code) ? it.exit_code : null, status };
  }
  if (it.type === "file_change") {
    const changes = (Array.isArray(it.changes) ? it.changes : []).map((ch) => ({ path: String(ch?.path ?? ""), change: String(ch?.kind ?? "update") }));
    return { kind: "files", changes, status: typeof it.status === "string" ? it.status : null };
  }
  return null;
}

/** The first `max` lines of a command's output, and how many lines are hidden after them (a trailing newline is not a line). */
export function splitOutput(text, max = 12) {
  const lines = String(text ?? "").replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") return { shown: "", hidden: 0 };
  return { shown: lines.slice(0, max).join("\n"), hidden: Math.max(0, lines.length - max) };
}
