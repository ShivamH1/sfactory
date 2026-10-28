import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";

const run = async (cwd, args) => { let out = "", err = ""; const code = await main(args, { cwd, stdout: (s) => (out += s), stderr: (s) => (err += s) }); return { code, out, err }; };
const setup = (rules) => { const r = tmpRepo(); writeConfig(r, { project: "p", agents: { mode: "claude" }, commands: { suite: "t" }, rules }); return r; };
const SRC = "# CLAUDE.md\n\nThis file provides guidance to Claude Code (claude.ai/code) when working here.\n\nrule one\n";

test("sync-rules: copies the source over the target, rewriting the tool name, keeping the target's CRLF", async () => {
  const r = setup(["CLAUDE.md", "AGENTS.md"]);
  writeFileSync(join(r, "CLAUDE.md"), SRC); writeFileSync(join(r, "AGENTS.md"), "old\r\nstuff\r\n");
  const o = await run(r, ["sync-rules"]);
  assert.equal(o.code, 0, o.err); assert.match(o.out, /wrote AGENTS\.md/);
  const got = readFileSync(join(r, "AGENTS.md"), "utf8");
  assert.equal(got, "# CLAUDE.md\r\n\r\nThis file provides guidance to Codex when working here.\r\n\r\nrule one\r\n");
  assert.equal(readFileSync(join(r, "CLAUDE.md"), "utf8"), SRC);
  assert.equal((await run(r, ["sync-rules"])).out.startsWith("in sync"), true);
});

test("sync-rules --check: exit 1 and writes nothing when they differ; CRLF alone is not a difference", async () => {
  const r = setup(["CLAUDE.md", "AGENTS.md"]);
  writeFileSync(join(r, "CLAUDE.md"), SRC); writeFileSync(join(r, "AGENTS.md"), "different\n");
  const o = await run(r, ["sync-rules", "--check"]);
  assert.equal(o.code, 1); assert.match(o.out, /AGENTS\.md/);
  assert.equal(readFileSync(join(r, "AGENTS.md"), "utf8"), "different\n");
  await run(r, ["sync-rules"]);
  writeFileSync(join(r, "AGENTS.md"), readFileSync(join(r, "AGENTS.md"), "utf8").replace(/\n/g, "\r\n"));
  assert.equal((await run(r, ["sync-rules", "--check"])).code, 0);
});

test("sync-rules: fewer than two rules, or a missing source, is refused; a missing target is created in the source's style", async () => {
  const one = setup(["CLAUDE.md"]); writeFileSync(join(one, "CLAUDE.md"), SRC);
  const a = await run(one, ["sync-rules"]); assert.equal(a.code, 2); assert.match(a.err, /RULES_NEEDED/);
  const none = setup(["CLAUDE.md", "AGENTS.md"]);
  assert.match((await run(none, ["sync-rules"])).err, /RULES_SOURCE_MISSING/);
  const mk = setup(["CLAUDE.md", "AGENTS.md"]); writeFileSync(join(mk, "CLAUDE.md"), "a\r\nb\r\n");
  await run(mk, ["sync-rules"]);
  assert.equal(readFileSync(join(mk, "AGENTS.md"), "utf8"), "a\r\nb\r\n");
});
