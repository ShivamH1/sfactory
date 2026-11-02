import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderCodexStream, splitOutput } from "../board/codex-render.mjs";

const stream = readFileSync(new URL("./fixtures/codex-stream.jsonl", import.meta.url), "utf8");

test("render: every line becomes a block or is a known no-op; items merge by id", () => {
  const b = renderCodexStream(stream);
  assert.deepEqual(b.map((x) => x.kind), ["raw", "message", "command", "raw", "files", "command", "raw", "usage"]);
  assert.equal(b[0].text, "Reading prompt from stdin...");
  assert.equal(b[1].text, "Reading the task brief and the existing search module first.");
  assert.deepEqual(b[2], { kind: "command", command: 'rg -n "searchIndex" src', output: 'src/search/index.mjs:12:export function searchIndex(items) {\nsrc/search/query.mjs:4:import { searchIndex } from "./index.mjs";\n', exit: 0, status: "completed" });
  assert.deepEqual(b[4], { kind: "files", changes: [{ path: "src/search/saved.mjs", change: "add" }, { path: "src/search/index.mjs", change: "update" }], status: "completed" });
  assert.equal(b[5].status, "failed"); assert.equal(b[5].exit, 1);
  assert.match(b[6].text, /"todo_list"/); // an item type it does not know stays visible
  assert.deepEqual(b[7], { kind: "usage", input: 12000, cached: 8000, output: 900 });
});

test("render: a command still in progress is running with no exit", () => {
  const b = renderCodexStream('{"type":"item.started","item":{"id":"a","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}\n');
  assert.deepEqual(b, [{ kind: "command", command: "ls", output: "", exit: null, status: "running" }]);
});

test("render: blank lines, CRLF, a partial last line and non-object JSON", () => {
  const b = renderCodexStream('\r\n{"type":"turn.started"}\r\n42\r\n{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"hi"}}\r\n{"type":"item.comp');
  assert.deepEqual(b.map((x) => [x.kind, x.text]), [["raw", "42"], ["message", "hi"], ["raw", '{"type":"item.comp']]);
});

test("render: splitOutput collapses after max lines", () => {
  const text = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
  const s = splitOutput(text, 12);
  assert.equal(s.shown.split("\n").length, 12); assert.equal(s.hidden, 3);
  assert.deepEqual(splitOutput("a\nb", 12), { shown: "a\nb", hidden: 0 });
  assert.deepEqual(splitOutput("a\nb\n", 12), { shown: "a\nb", hidden: 0 });
});
