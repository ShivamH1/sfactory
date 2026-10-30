import { test } from "node:test";
import assert from "node:assert/strict";
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
