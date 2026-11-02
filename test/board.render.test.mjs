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

test("render: a value with its own toString never throws", () => {
  const b = renderCodexStream('{"type":"item.completed","item":{"id":"x","type":"agent_message","text":{"toString":1}}}\n');
  assert.deepEqual(b, [{ kind: "message", text: '{"toString":1}' }]);
});

test("render: two runs in one stream do not merge items that share an id", () => {
  const b = renderCodexStream([
    '{"type":"thread.started","thread_id":"a"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls","aggregated_output":"","exit_code":0,"status":"completed"}}',
    '{"type":"thread.started","thread_id":"b"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi"}}',
  ].join("\n"));
  assert.deepEqual(b.map((x) => x.kind), ["command", "message"]);
  assert.equal(b[0].command, "ls");
});

test("render: an id reused for another kind is a new block", () => {
  const b = renderCodexStream([
    '{"type":"item.completed","item":{"id":"i","type":"command_execution","command":"ls","aggregated_output":"","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"hi"}}',
  ].join("\n"));
  assert.deepEqual(b.map((x) => x.kind), ["command", "message"]);
});

test("render: a null item, bad changes and string usage fields do not throw", () => {
  const b = renderCodexStream([
    '{"type":"item.completed","item":null}',
    '{"type":"item.completed","item":{"id":"f","type":"file_change","changes":"x","status":"completed"}}',
    '{"type":"turn.completed","usage":{"input_tokens":"12","cached_input_tokens":null,"output_tokens":"x"}}',
  ].join("\n"));
  assert.equal(b[0].kind, "raw");
  assert.deepEqual(b[1], { kind: "files", changes: [], status: "completed" });
  assert.deepEqual(b[2], { kind: "usage", input: null, cached: null, output: null });
});

test("render: a files block's status is completed, failed or running", () => {
  const b = renderCodexStream('{"type":"item.started","item":{"id":"f","type":"file_change","changes":[],"status":"in_progress"}}\n');
  assert.equal(b[0].status, "running");
});

test("render: splitOutput collapses after max lines", () => {
  const text = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
  const s = splitOutput(text, 12);
  assert.equal(s.shown.split("\n").length, 12); assert.equal(s.hidden, 3);
  assert.deepEqual(splitOutput("a\nb", 12), { shown: "a\nb", hidden: 0 });
  assert.deepEqual(splitOutput("a\nb\n", 12), { shown: "a\nb", hidden: 0 });
});
