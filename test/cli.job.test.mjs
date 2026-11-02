import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
