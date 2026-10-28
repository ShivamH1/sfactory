import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, writeConfig } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { filterEnv, runCodexExec, runCodexReview, usageOf, profileModel, quoteWin } from "../src/codex.mjs";
import { readCost } from "../src/cost.mjs";
import { main } from "../src/cli.mjs";
import { runDoctor } from "../src/doctor.mjs";

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
  assert.deepEqual(r.usage, { inputTokens: 15, outputTokens: 5, cacheReadTokens: 0 });
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

test("round 4: off win32 codex spawns detached and follows the parent's signals while the child runs; win32 does neither", async () => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  const counts = () => ["SIGINT", "SIGTERM", "SIGHUP"].map((s) => process.listenerCount(s));
  const before = counts();
  const runAs = async (platform) => {
    Object.defineProperty(process, "platform", { ...desc, value: platform });
    try {
      const during = [];
      const { spawn, calls } = fakeSpawn((child) => { during.push(counts()); emit(child, [], 0); });
      const base = { cwd: "/w", prompt: "p", spawn, which: () => true };
      await runCodexExec(cfg(), { ...base, profile: "implement", outDir: tmpDir("sf-out-"), codexHome: homeWith("implement") });
      await runCodexReview(cfg(), { ...base, base: "main", profile: "review", outDir: tmpDir("sf-out-"), codexHome: homeWith("review") });
      const hung = fakeSpawn(() => { /* never answers */ });
      const t = await runCodexExec(cfg(), { ...base, spawn: hung.spawn, profile: "implement", outDir: tmpDir("sf-out-"), codexHome: homeWith("implement"), timeoutMs: 30 });
      assert.equal(t.timedOut, true); assert.equal(hung.calls[0].child.killed, true);
      return { during, calls, after: counts() };
    } finally { Object.defineProperty(process, "platform", desc); }
  };
  const posix = await runAs("linux");
  for (const call of posix.calls) assert.equal(call.opts.detached, true);
  assert.deepEqual(posix.during, [before.map((n) => n + 1), before.map((n) => n + 1)], "one handler per signal while a child runs");
  assert.deepEqual(posix.after, before, "handlers removed after close and after a timeout");
  const win = await runAs("win32");
  for (const call of win.calls) { assert.notEqual(call.opts.detached, true); assert.equal(call.opts.shell, true); }
  assert.deepEqual(win.during, [before, before]);
  assert.deepEqual(win.after, before);
});

test("review: runs exec review under the review profile and a read-only sandbox, prompt on stdin", async () => {
  const out = tmpDir("sf-out-");
  const { spawn, calls } = fakeSpawn((child) => { writeFileSync(join(out, "last-message.md"), "findings\n"); emit(child, [{ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 1 } }]); });
  const c = cfg();
  const home = homeWith("review");
  const r = await runCodexReview(c, { cwd: "/w", base: "main", profile: "review", prompt: "review this", outDir: out, spawn, which: () => true, codexHome: home });
  assert.deepEqual([r.ok, r.text], [true, "findings\n"]);
  assert.deepEqual(r.usage, { inputTokens: 9, outputTokens: 1, cacheReadTokens: 0 });
  assert.equal(joined(calls[0]), `exec -C /w -p review -s read-only review --json -o ${join(out, "last-message.md")} -`);
  assert.ok(!joined(calls[0]).includes("--base") && !joined(calls[0]).includes("--commit"), "a custom prompt cannot be combined with --base/--commit");
  assert.equal(calls[0].stdin, "Review the changes on this branch against main: run `git diff main...HEAD` to see them.\n\nreview this");
  await runCodexReview(c, { cwd: "/w", commit: "abc1234", profile: "review", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true, codexHome: home });
  assert.match(joined(calls[1]), /-s read-only review --json/);
  assert.ok(!joined(calls[1]).includes("--commit"));
  assert.equal(calls[1].stdin, "Review commit abc1234: run `git show abc1234` to see it.\n\np");
  const base = { cwd: "/w", profile: "review", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true, codexHome: home };
  await assert.rejects(runCodexReview(c, { ...base, codexHome: homeWith(), base: "a" }), { code: "CODEX_PROFILE_MISSING" });
  await assert.rejects(runCodexReview(c, base), { code: "BAD_ARGS" });
  await assert.rejects(runCodexReview(c, { ...base, base: "a", commit: "b" }), { code: "BAD_ARGS" });
  await assert.rejects(runCodexReview(c, { ...base, base: "a", which: () => false }), { code: "CODEX_MISSING" });
});

test("review: a timeout kills the child and reports timedOut", async () => {
  const { spawn, calls } = fakeSpawn(() => {});
  const r = await runCodexReview(cfg(), { cwd: "/w", base: "main", profile: "review", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true, codexHome: homeWith("review"), timeoutMs: 30 });
  assert.equal(r.ok, false); assert.equal(r.timedOut, true); assert.equal(calls[0].child.killed, true);
});

test("exec: a stale last-message.md from an earlier run is removed before spawning", async () => {
  const out = tmpDir("sf-out-");
  writeFileSync(join(out, "last-message.md"), "OLD");
  const { spawn } = fakeSpawn((child) => emit(child, [], 1));
  const r = await runCodexExec(cfg(), { cwd: "/w", profile: "implement", prompt: "p", outDir: out, spawn, which: () => true, codexHome: homeWith("implement") });
  assert.equal(r.lastMessage, ""); assert.equal(existsSync(join(out, "last-message.md")), false);
});

test("exec: cached tokens are split out; a stream with both turn usage and token_count counts one source", async () => {
  const tc = (i, o, cached) => ({ type: "token_count", payload: { info: { last_token_usage: { input_tokens: i, output_tokens: o, ...(cached ? { cached_input_tokens: cached } : {}) } } } });
  const { spawn } = fakeSpawn((child) => emit(child, [tc(50, 5, 10), { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 8 } }, tc(50, 3)]));
  const r = await runCodexExec(cfg(), { cwd: "/w", profile: "implement", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true, codexHome: homeWith("implement") });
  assert.deepEqual(r.usage, { inputTokens: 70, outputTokens: 8, cacheReadTokens: 30 });
  const { spawn: s2 } = fakeSpawn((child) => emit(child, [tc(50, 5, 10), tc(20, 2)]));
  const r2 = await runCodexExec(cfg(), { cwd: "/w", profile: "implement", prompt: "p", outDir: tmpDir("sf-out-"), spawn: s2, which: () => true, codexHome: homeWith("implement") });
  assert.deepEqual(r2.usage, { inputTokens: 60, outputTokens: 7, cacheReadTokens: 10 });
});

test("profileModel reads the model from the profile file, null when absent", () => {
  const d = tmpDir("sf-chome-");
  writeFileSync(join(d, "a.config.toml"), "# c\nmodel = \"m-9\"\nmodel_reasoning_effort = \"high\"\n");
  writeFileSync(join(d, "b.config.toml"), "model_reasoning_effort = \"high\"\n");
  writeFileSync(join(d, "c.config.toml"), "model = 'lit-1'\n");
  assert.equal(profileModel("c", d), "lit-1");
  assert.equal(profileModel("a", d), "m-9"); assert.equal(profileModel("b", d), null); assert.equal(profileModel("zz", d), null);
});

test("filterEnv: secrets, *_SECRET/*_TOKEN/*_KEY dropped, CODEX_ and OPENAI_ kept", () => {
  const c = cfg({ secrets: { neverHandToAgents: ["DEPLOY_PASS", "./not-an-env-name.pem"] } });
  const r = filterEnv(c, { DEPLOY_PASS: "1", A_SECRET: "1", B_TOKEN: "1", C_KEY: "1", c_key: "1", CODEX_HOME: "1", OPENAI_API_KEY: "1", CODEX_API_KEY: "1", PATH: "1", KEYBOARD: "1" });
  assert.deepEqual(Object.keys(r).sort(), ["CODEX_API_KEY", "CODEX_HOME", "KEYBOARD", "OPENAI_API_KEY", "PATH"]);
});

test("usageOf: reads usage, token_count and bare token fields leniently; null otherwise", () => {
  assert.deepEqual(usageOf({ usage: { input_tokens: 4, output_tokens: 1 } }), { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, source: "usage" });
  assert.deepEqual(usageOf({ payload: { info: { last_token_usage: { input_tokens: 2, output_tokens: 2 } } } }), { inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, source: "token_count" });
  assert.deepEqual(usageOf({ input_tokens: 7 }), { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, source: "usage" });
  assert.equal(usageOf({ type: "message" }), null);
});

test("cli codex: records cost (model from the profile file), validates --job before running, review uses the profile", async () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "codex" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-cli-"), worktrees: { dir: tmpDir("sf-clw-") }, ports: { base: 47950 } });
  const outs = [], errs = [];
  const io = (extra = {}) => ({ cwd: root, stdout: (s) => outs.push(s), stderr: (s) => errs.push(s), stdin: async () => "prompt text", ...extra });
  assert.equal(await main(["job", "add", "milestone", "t", "--json"], io()), 0, errs.join(""));
  const jid = JSON.parse(outs.join("")).id; outs.length = 0;
  const seen = [];
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 };
  const runners = {
    exec: async (c, o) => { seen.push(o); return { ok: true, exitCode: 0, lastMessage: "", usage, logPath: "l", lastMessagePath: "m", durationMs: 1 }; },
    review: async (c, o) => { seen.push(o); return { ok: true, text: "looks fine", usage, logPath: "l" }; },
  };
  const code = await main(["codex", "exec", "--cwd", ".", "--profile", "implement", "--out", "o", "--job", jid, "--stage", "implement", "--model", "m1"], io({ runners }));
  assert.equal(code, 0, errs.join(""));
  assert.equal(seen[0].prompt, "prompt text"); assert.equal(seen[0].profile, "implement");
  let entries = readCost(loadConfig(root), jid).entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].agent, "codex"); assert.equal(entries[0].inputTokens, 100); assert.equal(entries[0].cacheReadTokens, 30); assert.equal(entries[0].model, "m1");
  const home = tmpDir("sf-chome-"); writeFileSync(join(home, "review.config.toml"), "model = \"from-profile\"\n");
  const prev = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  try {
    outs.length = 0;
    assert.equal(await main(["codex", "review", "--cwd", ".", "--base", "main", "--profile", "review", "--out", "o", "--job", jid], io({ runners })), 0, errs.join(""));
  } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
  assert.equal(outs.join(""), "looks fine\n"); assert.equal(seen[1].base, "main"); assert.equal(seen[1].profile, "review");
  entries = readCost(loadConfig(root), jid).entries;
  assert.equal(entries.length, 2); assert.equal(entries[1].model, "from-profile"); assert.equal(entries[1].stage, "review");
  const before = seen.length;
  assert.equal(await main(["codex", "exec", "--cwd", ".", "--profile", "implement", "--out", "o", "--job", "no-such-job"], io({ runners })), 2);
  assert.equal(seen.length, before, "a bad --job must fail before Codex runs");
  // the profile defaults from the config when the flag is absent
  const n = seen.length;
  assert.equal(await main(["codex", "exec", "--cwd", ".", "--out", "o"], io({ runners })), 0, errs.join(""));
  assert.equal(seen[n].profile, "implement");
  assert.equal(await main(["codex", "review", "--cwd", ".", "--base", "main", "--out", "o"], io({ runners })), 0, errs.join(""));
  assert.equal(seen[n + 1].profile, "review");
  // a review that timed out says so
  const timedRunners = { ...runners, review: async () => ({ ok: false, text: "", timedOut: true, logPath: "l" }) };
  errs.length = 0;
  assert.equal(await main(["codex", "review", "--cwd", ".", "--base", "main", "--out", "o"], io({ runners: timedRunners })), 1);
  assert.match(errs.join(""), /timed out/);
});

test("doctor honours CODEX_HOME for the profile files", () => {
  const home = homeWith("implement", "review");
  const prev = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  try {
    const r = runDoctor(cfg({ agents: { mode: "codex" } }), { exec: () => ({ status: 0, stdout: "1.0\n", stderr: "" }) });
    const rows = r.checks.filter((k) => k.name.startsWith("codex profile"));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((k) => k.ok), JSON.stringify(r.checks));
  } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
});

// Live and opt-in: never runs unless SFACTORY_CODEX_LIVE=1. Needs implement and review profile files.
test("live (opt-in): runCodexExec read-only and the exec review form", { skip: process.env.SFACTORY_CODEX_LIVE !== "1" }, async () => {
  const root = tmpRepo(), c = cfg();
  const r = await runCodexExec(c, { cwd: root, profile: "implement", prompt: "say ok", sandbox: "read-only", outDir: tmpDir("sf-live-"), timeoutMs: 300_000 });
  assert.equal(r.ok, true, r.lastMessage);
  const v = await runCodexReview(c, { cwd: root, base: "main", profile: "review", prompt: "review the diff briefly", outDir: tmpDir("sf-live-"), timeoutMs: 300_000 });
  assert.equal(v.ok, true, v.text);
});

test("quoteWin: a trailing backslash cannot escape the closing quote; embedded quotes are escaped", () => {
  assert.equal(quoteWin("plain"), "plain");
  assert.equal(quoteWin("C:\\my dir\\"), '"C:\\my dir\\\\"');
  assert.equal(quoteWin("a b"), '"a b"');
  assert.equal(quoteWin('say "hi" now'), '"say \\"hi\\" now"');
  assert.equal(quoteWin('x\\"y z'), '"x\\\\\\"y z"');
});

test("codex inputs: base, commit, profile and sandbox are validated; win32 refuses quotes, percent and empty args", async () => {
  const c = cfg();
  const { spawn } = fakeSpawn((child) => emit(child, [], 0));
  const home = homeWith("review", "implement");
  const rv = (o) => runCodexReview(c, { cwd: "/w", profile: "review", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true, codexHome: home, ...o });
  for (const base of ["-x", "a..b", "a\nb", "a b", "", "a;b", "a/"]) await assert.rejects(rv({ base }), { code: "BAD_ARGS" }, `base ${JSON.stringify(base)}`);
  for (const commit of ["abc12", "ABCDEF1", "abc1234; rm", "-abc1234", "g".repeat(8), "a".repeat(41)]) await assert.rejects(rv({ commit }), { code: "BAD_ARGS" }, `commit ${commit}`);
  await rv({ base: "feature/x-1.2" });
  await assert.rejects(rv({ base: "main", profile: "re view" }), { code: "BAD_ARGS" });
  await assert.rejects(rv({ base: "main", profile: "a&b" }), { code: "BAD_ARGS" });
  const ex = (o) => runCodexExec(c, { cwd: "/w", profile: "implement", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true, codexHome: home, ...o });
  await assert.rejects(ex({ profile: "../x" }), { code: "BAD_ARGS" });
  await assert.rejects(ex({ sandbox: "read-only; echo" }), { code: "BAD_ARGS" });
  await ex({ sandbox: "danger-full-access" });
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...desc, value: "win32" });
  try {
    await assert.rejects(ex({ cwd: 'a "b&echo PWNED" c' }), { code: "BAD_ARGS" });
    await assert.rejects(ex({ cwd: String.raw`C:\%PATH%` }), { code: "BAD_ARGS" });
    await assert.rejects(ex({ cwd: "" }), { code: "BAD_ARGS" });
  } finally { Object.defineProperty(process, "platform", desc); }
});

test("codex command: a bare --profile is BAD_ARGS", async () => {
  const { root } = { root: cfg().repoRoot };
  const errs = [];
  const code = await main(["codex", "exec", "--cwd", ".", "--profile", "--out", "o"], { cwd: root, stdin: () => "p", stdout: () => {}, stderr: (s) => errs.push(s), runners: { exec: async () => { throw new Error("must not run"); } } });
  assert.equal(code, 2, errs.join(""));
});

test("codex command: a bare --sandbox is BAD_ARGS and nothing runs", async () => {
  const root = cfg().repoRoot;
  const errs = [];
  const code = await main(["codex", "exec", "--cwd", ".", "--profile", "implement", "--out", "o", "--sandbox"], { cwd: root, stdin: () => "p", stdout: () => {}, stderr: (s) => errs.push(s), runners: { exec: async () => { throw new Error("must not run"); } } });
  assert.equal(code, 2, errs.join(""));
  assert.match(errs.join(""), /BAD_ARGS.*--sandbox needs a value/s);
});

test("codex: win32 refuses a control character in any argument (a LF would cut the cmd.exe line)", async () => {
  const c = cfg();
  const { spawn } = fakeSpawn((child) => emit(child, [], 0));
  const home = homeWith("implement");
  const ex = (o) => runCodexExec(c, { cwd: "/w", profile: "implement", prompt: "p", outDir: tmpDir("sf-out-"), spawn, which: () => true, codexHome: home, ...o });
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...desc, value: "win32" });
  try {
    for (const ch of ["\n", "\r", "\t", "\x00", "\x1b"]) await assert.rejects(ex({ cwd: String.raw`C:\a${ch}b` }), { code: "BAD_ARGS" }, JSON.stringify(ch));
    await ex({ cwd: String.raw`C:\plain dir` });
  } finally { Object.defineProperty(process, "platform", desc); }
});
