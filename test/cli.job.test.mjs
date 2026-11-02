import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { tmpRepo, writeConfig } from "./helpers.mjs";
import { main } from "../src/cli.mjs";

const repo = () => { const r = tmpRepo(); writeConfig(r, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } }); return r; };
async function run(cwd, args) {
  const out = [], err = [];
  const code = await main(args, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
}

test("cli: job add --number --roadmap --after, and M<n> accepted as an id", async () => {
  const r0 = repo();
  let r = await run(r0, ["job", "add", "milestone", "Audit", "log", "--number", "14", "--roadmap", "--after", "M13"]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^m-1 roadmap/);
  r = await run(r0, ["job", "show", "M14"]);
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).id, "m-1");
  assert.notEqual((await run(r0, ["job", "show", "M99"])).code, 0);
});

test("cli: --roadmap is a boolean flag, so a title word may follow it", async () => {
  const r0 = repo();
  let r = await run(r0, ["job", "add", "milestone", "--roadmap", "Audit", "log"]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^m-1 roadmap/);
  r = await run(r0, ["job", "show", "m-1"]);
  const j = JSON.parse(r.out);
  assert.equal(j.title, "Audit log"); assert.equal(j.stage, "roadmap");
  r = await run(r0, ["job", "add", "milestone", "Later", "--roadmap", "item"]);
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse((await run(r0, ["job", "show", "m-2"])).out).title, "Later item");
});

test("cli: job import prints one line per card and refuses a missing file", async () => {
  const r0 = repo();
  writeFileSync(join(r0, "cards.json"), JSON.stringify({ cards: [{ number: "3", kind: "milestone", title: "Later", stage: "roadmap" }, { kind: "milestone", title: "Done thing", stage: "merged", pr: 2 }] }));
  let r = await run(r0, ["job", "import", "cards.json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "created m-1 M3 roadmap\ncreated m-2 merged\n2 created, 0 skipped\n");
  r = await run(r0, ["job", "import", "cards.json"]);
  assert.match(r.out, /skipped #0: M3 is m-1\n/);
  assert.notEqual((await run(r0, ["job", "import", "missing.json"])).code, 0);
});

test("cli: job import refuses a file listed in secrets.neverHandToAgents and creates no card", async () => {
  const r0 = tmpRepo();
  writeConfig(r0, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, secrets: { neverHandToAgents: ["cards.json"] } });
  writeFileSync(join(r0, "cards.json"), JSON.stringify({ cards: [{ kind: "milestone", title: "Later", stage: "roadmap" }] }));
  let r = await run(r0, ["job", "import", "cards.json"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /SECRET_PATH/);
  r = await run(r0, ["job", "list"]);
  assert.equal(r.out, "");
});

test("cli: job import reads a BOM-prefixed file, and names a read error by its code", async () => {
  const r0 = repo();
  writeFileSync(join(r0, "bom.json"), "﻿" + JSON.stringify({ cards: [{ kind: "milestone", title: "Later", stage: "roadmap" }] }));
  let r = await run(r0, ["job", "import", "bom.json"]);
  assert.equal(r.code, 0, r.err);
  mkdirSync(join(r0, "dir.json"));
  r = await run(r0, ["job", "import", "dir.json"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /dir\.json: EISDIR/);
  writeFileSync(join(r0, "bad.json"), "{nope");
  r = await run(r0, ["job", "import", "bad.json"]);
  assert.match(r.err, /BAD_IMPORT/);
});

test("cli: job touch --agent records an agent event", async () => {
  const r0 = repo();
  await run(r0, ["job", "add", "milestone", "x"]);
  await run(r0, ["job", "set", "m-1", "planning"]);
  const r = await run(r0, ["job", "touch", "m-1", "--agent", "start", "--role", "implementer", "--vendor", "codex", "--task", "1", "--model", "implement"]);
  assert.equal(r.code, 0, r.err);
  const show = JSON.parse((await run(r0, ["job", "show", "m-1"])).out);
  assert.equal(show.activity.note, "start codex implementer task 1 implement");
  assert.notEqual((await run(r0, ["job", "touch", "m-1", "--agent", "start", "--role", "x", "--vendor", "nope"])).code, 0);
});

test("cli: job touch refuses valueless agent flags and agent flags without --agent, recording nothing", async () => {
  const r0 = repo();
  await run(r0, ["job", "add", "milestone", "x"]);
  await run(r0, ["job", "set", "m-1", "planning"]);
  const ev = () => { try { return readFileSync(join(loadConfig(r0).stateDir, "jobs", "m-1", "events.jsonl"), "utf8"); } catch { return ""; } };
  const before = ev();
  const base = ["job", "touch", "m-1", "--agent", "finish", "--role", "reviewer", "--vendor", "claude"];
  for (const flag of ["--verdict", "--task", "--model"]) {
    const r = await run(r0, [...base, flag]);
    assert.notEqual(r.code, 0, flag);
    assert.match(r.err, new RegExp(`${flag} needs a value`));
  }
  for (const extra of [["--role", "x"], ["--vendor", "claude"], ["--task", "1"], ["--model", "m"], ["--verdict", "ok"]]) {
    const r = await run(r0, ["job", "touch", "m-1", "--note", "n", ...extra]);
    assert.notEqual(r.code, 0, extra[0]);
    assert.match(r.err, /go with --agent/);
  }
  assert.equal(ev(), before, "no event was recorded");
  const ok = await run(r0, [...base, "--task", "1", "--verdict", "ok"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ev(), /"verdict":"ok"/);
});

test("cli: a --by of more than 40 characters is refused", async () => {
  const r0 = repo();
  await run(r0, ["job", "add", "milestone", "x"]);
  const r = await run(r0, ["job", "set", "m-1", "planning", "--by", "x".repeat(41)]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /at most 40 characters/);
  assert.equal((await run(r0, ["job", "touch", "m-1", "--note", "n", "--by", "x".repeat(40)])).code, 0);
});
