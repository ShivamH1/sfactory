import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, writeConfig } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { filterEnv, runCodexExec, runCodexReview, usageOf } from "../src/codex.mjs";
import { readCost } from "../src/cost.mjs";
import { main } from "../src/cli.mjs";

function cfg(extra = {}) {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "codex" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-cx-"), worktrees: { dir: tmpDir("sf-cxw-") }, ports: { base: 47900 }, ...extra });
  return loadConfig(root);
}
const homeWith = (...names) => { const d = tmpDir("sf-chome-"); for (const n of names) writeFileSync(join(d, `${n}.config.toml`), "model = \"x\"\n"); return d; };

/** A fake spawn: records the call and the stdin text, then plays a script against the child. */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (cmd, argsOrOpts, maybeOpts) => {
    const win = typeof argsOrOpts === "object" && !Array.isArray(argsOrOpts);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false; child.kill = () => { child.killed = true; };
    let stdin = "";
    child.stdin.on("data", (d) => { stdin += d; });
    const call = { cmd, args: win ? cmd.split(" ").slice(1) : argsOrOpts, opts: win ? argsOrOpts : maybeOpts, get stdin() { return stdin; }, child };
    calls.push(call);
    child.stdin.on("finish", () => setImmediate(() => script(child, call)));
    return child;
  };
  return { spawn, calls };
}
const emit = (child, lines, code = 0) => { for (const l of lines) child.stdout.write(JSON.stringify(l) + "\n"); child.stdout.end(); setImmediate(() => child.emit("close", code)); };
const joined = (call) => call.args.join(" ");

test("exec: argv, stdin prompt, env filter, usage summed, last message read", async () => {
  const c = cfg({ secrets: { neverHandToAgents: ["MY_PRIVATE"] } });
  const out = tmpDir("sf-out-");
  const { spawn, calls } = fakeSpawn((child) => {
    writeFileSync(join(out, "last-message.md"), "done\n");
    emit(child, [{ type: "thread.started" }, { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }, { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }]);
  });
  const env = { PATH: process.env.PATH, MY_PRIVATE: "a", GH_TOKEN: "b", DB_SECRET: "c", API_KEY: "d", OPENAI_API_KEY: "e", CODEX_TOKEN: "f", HOME: "h" };
  const r = await runCodexExec(c, { cwd: "/work", profile: "implement", prompt: "do it", outDir: out, spawn, which: () => true, codexHome: homeWith("implement"), env });
  assert.equal(r.ok, true);
  assert.deepEqual(r.usage, { inputTokens: 15, outputTokens: 5 });
  assert.equal(r.lastMessage, "done\n");
  assert.equal(calls[0].stdin, "do it");
  const a = joined(calls[0]);
  for (const part of ["exec", "-C /work", "-p implement", "-s workspace-write", "--json", "-o"]) assert.ok(a.includes(part), `${part} in ${a}`);
  assert.ok(!a.includes("do it"), "prompt never in argv");
  assert.ok(!a.includes("skip-git-repo-check"));
  assert.deepEqual(Object.keys(calls[0].opts.env).sort(), ["CODEX_TOKEN", "HOME", "OPENAI_API_KEY", "PATH"]);
  assert.ok(readFileSync(r.logPath, "utf8").includes("turn.completed"));
});

test("exec: no usage events gives usage null; nonzero exit is not ok", async () => {
  const out = tmpDir("sf-out-");
  const { spawn } = fakeSpawn((child) => emit(child, [{ type: "x" }], 1));
  const r = await runCodexExec(cfg(), { cwd: "/w", profile: "implement", prompt: "p", outDir: out, spawn, which: () => true, codexHome: homeWith("implement") });
  assert.equal(r.usage, null); assert.equal(r.ok, false); assert.equal(r.exitCode, 1); assert.equal(r.lastMessage, "");
});

test("exec: refuses CODEX_MISSING and CODEX_PROFILE_MISSING before spawning", async () => {
  const { spawn, calls } = fakeSpawn(() => {});
  const base = { cwd: "/w", profile: "implement", prompt: "p", outDir: tmpDir("sf-out-"), spawn };
  await assert.rejects(runCodexExec(cfg(), { ...base, which: () => false, codexHome: homeWith("implement") }), { code: "CODEX_MISSING" });
  await assert.rejects(runCodexExec(cfg(), { ...base, which: () => true, codexHome: homeWith() }), { code: "CODEX_PROFILE_MISSING" });
  assert.equal(calls.length, 0);
});

test("exec: a timeout kills the child and reports not ok", async () => {
  const { spawn, calls } = fakeSpawn(() => { /* never answers */ });
  const r = await runCodexExec(cfg(), { cwd: "/w", profile: "implement", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true, codexHome: homeWith("implement"), timeoutMs: 30 });
  assert.equal(r.ok, false); assert.equal(r.timedOut, true);
  assert.equal(calls[0].child.killed, true);
});

test("review: base and commit argv, prompt from stdin via -", async () => {
  const { spawn, calls } = fakeSpawn((child) => { child.stdout.write("findings\n"); child.stdout.end(); setImmediate(() => child.emit("close", 0)); });
  const c = cfg();
  const r = await runCodexReview(c, { cwd: "/w", base: "main", prompt: "review this", outDir: tmpDir("sf-out-"), spawn, which: () => true });
  assert.deepEqual([r.ok, r.text], [true, "findings\n"]);
  assert.equal(joined(calls[0]), "review --base main -");
  assert.equal(calls[0].stdin, "review this");
  await runCodexReview(c, { cwd: "/w", commit: "abc123", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true });
  assert.equal(joined(calls[1]), "review --commit abc123 -");
  await assert.rejects(runCodexReview(c, { cwd: "/w", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true }), { code: "BAD_ARGS" });
  await assert.rejects(runCodexReview(c, { cwd: "/w", base: "a", commit: "b", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true }), { code: "BAD_ARGS" });
  await assert.rejects(runCodexReview(c, { cwd: "/w", base: "a", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => false }), { code: "CODEX_MISSING" });
});

test("filterEnv: secrets, *_SECRET/*_TOKEN/*_KEY dropped, CODEX_ and OPENAI_ kept", () => {
  const c = cfg({ secrets: { neverHandToAgents: ["DEPLOY_PASS", "./not-an-env-name.pem"] } });
  const r = filterEnv(c, { DEPLOY_PASS: "1", A_SECRET: "1", B_TOKEN: "1", C_KEY: "1", c_key: "1", CODEX_HOME: "1", OPENAI_API_KEY: "1", CODEX_API_KEY: "1", PATH: "1", KEYBOARD: "1" });
  assert.deepEqual(Object.keys(r).sort(), ["CODEX_API_KEY", "CODEX_HOME", "KEYBOARD", "OPENAI_API_KEY", "PATH"]);
});

test("usageOf: reads usage, token_count and bare token fields leniently; null otherwise", () => {
  assert.deepEqual(usageOf({ usage: { input_tokens: 4, output_tokens: 1 } }), { inputTokens: 4, outputTokens: 1 });
  assert.deepEqual(usageOf({ payload: { info: { last_token_usage: { input_tokens: 2, output_tokens: 2 } } } }), { inputTokens: 2, outputTokens: 2 });
  assert.deepEqual(usageOf({ input_tokens: 7 }), { inputTokens: 7, outputTokens: 0 });
  assert.equal(usageOf({ type: "message" }), null);
});

test("cli codex exec: records cost when usage and a job are given; review prints the text", async () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "codex" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-cli-"), worktrees: { dir: tmpDir("sf-clw-") }, ports: { base: 47950 } });
  const outs = [], errs = [];
  const io = (extra = {}) => ({ cwd: root, stdout: (s) => outs.push(s), stderr: (s) => errs.push(s), stdin: async () => "prompt text", ...extra });
  assert.equal(await main(["job", "add", "milestone", "t", "--json"], io()), 0, errs.join(""));
  const jid = JSON.parse(outs.join("")).id; outs.length = 0;
  const seen = [];
  const runners = {
    exec: async (c, o) => { seen.push(o); return { ok: true, exitCode: 0, lastMessage: "", usage: { inputTokens: 100, outputTokens: 20 }, logPath: "l", lastMessagePath: "m", durationMs: 1 }; },
    review: async (c, o) => { seen.push(o); return { ok: true, text: "looks fine", logPath: "l" }; },
  };
  const code = await main(["codex", "exec", "--cwd", ".", "--profile", "implement", "--out", "o", "--job", jid, "--stage", "implement", "--model", "m1"], io({ runners }));
  assert.equal(code, 0, errs.join(""));
  assert.equal(seen[0].prompt, "prompt text"); assert.equal(seen[0].profile, "implement");
  const entries = readCost(loadConfig(root), jid).entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].agent, "codex"); assert.equal(entries[0].inputTokens, 100); assert.equal(entries[0].model, "m1");
  outs.length = 0;
  assert.equal(await main(["codex", "review", "--cwd", ".", "--base", "main", "--out", "o"], io({ runners })), 0);
  assert.equal(outs.join(""), "looks fine\n"); assert.equal(seen[1].base, "main");
  assert.equal(await main(["codex", "exec", "--cwd", ".", "--out", "o"], io({ runners })), 2);
});

test("live (opt-in): codex exec -s read-only says ok", { skip: process.env.SFACTORY_CODEX_LIVE !== "1" }, () => {
  const r = spawnSync("codex", ["exec", "-s", "read-only", "say ok"], { encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync("/nonexistent"));
});
