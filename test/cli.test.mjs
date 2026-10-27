import { test } from "node:test";
import assert from "node:assert/strict";
import { main, parseArgs, register } from "../src/cli.mjs";
import { SfactoryError } from "../src/errors.mjs";

test("cli: version prints the package version and exits 0", async () => {
  const out = [];
  const code = await main(["version"], { stdout: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.match(out.join(""), /^sfactory 0\.1\.0/);
});

test("cli: unknown command exits 2 with an error line", async () => {
  const err = [];
  const code = await main(["nope"], { stderr: (s) => err.push(s) });
  assert.equal(code, 2);
  assert.match(err.join(""), /error UNKNOWN_COMMAND: nope/);
});

test("parseArgs: booleans, values, and -- rest", () => {
  const { positional, flags } = parseArgs(["x", "--m", "msg", "--json", "pos", "--", "a.txt", "b.txt"]);
  assert.deepEqual(positional, ["x", "pos"]);
  assert.equal(flags.m, "msg");
  assert.equal(flags.json, true);
  assert.deepEqual(flags.rest, ["a.txt", "b.txt"]);
});

test("parseArgs: force is a boolean and never consumes the next token", () => {
  const { positional, flags } = parseArgs(["remove", "m-1", "--force", "x"]);
  assert.deepEqual(positional, ["remove", "m-1", "x"]);
  assert.equal(flags.force, true);
});

test("cli: SfactoryError from a handler exits 2 with its code", async () => {
  register("boom", () => { throw new SfactoryError("BOOM", "it broke"); });
  const err = [];
  const code = await main(["boom"], { stderr: (s) => err.push(s) });
  assert.equal(code, 2);
  assert.match(err.join(""), /error BOOM: it broke/);
});

test("cli: a plain Error from a handler exits 3 as INTERNAL", async () => {
  register("crash", () => { throw new Error("oops"); });
  const err = [];
  const code = await main(["crash"], { stderr: (s) => err.push(s) });
  assert.equal(code, 3);
  assert.match(err.join(""), /error INTERNAL:/);
});

test("cli: a handler returning undefined exits 0", async () => {
  register("quiet", () => {});
  assert.equal(await main(["quiet"]), 0);
});
