import { test } from "node:test";
import assert from "node:assert/strict";
import { main, parseArgs, register } from "../src/cli.mjs";
import { SfactoryError } from "../src/errors.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { usages } from "../src/registry.mjs";

const COMMANDS_DIR = new URL("../src/commands/", import.meta.url);

/** The flags a command module reads: flags.x, flags["x"], and (job.mjs) the sub table's f.x; flags.rest is the "--" remainder, not a flag. */
function flagsRead(src) {
  const out = new Set();
  for (const m of src.matchAll(/(?<![A-Za-z0-9_$])flags\.([a-z][A-Za-z]*)/g)) out.add(m[1]); // args.flags.x too
  for (const m of src.matchAll(/(?<![A-Za-z0-9_$.])f\.([a-z][A-Za-z]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/flags\["([a-z-]+)"\]/g)) out.add(m[1]);
  for (const m of src.matchAll(/\(flags, "([a-z-]+)"\)/g)) out.add(m[1]); // a helper given the flags and a name (codex.mjs need)
  out.delete("rest");
  return [...out].sort();
}

test("cli: every command module registers a usage table equal to the flags it reads, and its sub-verbs appear in its source", () => {
  let n = 0;
  for (const f of readdirSync(COMMANDS_DIR).filter((x) => x.endsWith(".mjs"))) {
    const src = readFileSync(new URL(f, COMMANDS_DIR), "utf8");
    for (const m of src.matchAll(/register\("([a-z-]+)"/g)) {
      const u = usages.get(m[1]);
      assert.ok(u, `${f}: "${m[1]}" registers no usage table`);
      assert.deepEqual([...u.flags].sort(), flagsRead(src), `${f}: usage flags differ from the flags the module reads`);
      assert.ok(u.verbs === null || (Array.isArray(u.verbs) && u.verbs.length > 0), `${f}: verbs is null or a non-empty list`);
      for (const v of u.verbs ?? []) assert.ok(src.includes(`"${v}"`) || src.includes(`  ${v}: `), `${f}: sub-verb "${v}" does not appear in the module`);
      n++;
    }
  }
  assert.ok(n >= 17, `only ${n} commands seen`);
});

test("cli: the job command's sub-verbs are the keys of its parsing table", () => {
  const src = readFileSync(new URL("job.mjs", COMMANDS_DIR), "utf8");
  const keys = [...src.matchAll(/^ {2}"?([a-z-]+)"?: \(/gm)].map((m) => m[1]);
  assert.deepEqual([...usages.get("job").verbs].sort(), keys.sort());
});

test("cli: version prints the package version and exits 0", async () => {
  const out = [];
  const code = await main(["version"], { stdout: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.match(out.join(""), /^sfactory 0\.3\.0/);
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

test("parseArgs: guard and durable are booleans and never consume the next token", () => {
  const { positional, flags } = parseArgs(["clear", "--guard", "suite"]);
  assert.deepEqual(positional, ["clear", "suite"]);
  assert.equal(flags.guard, true);
  const b = parseArgs(["acquire", "--durable", "worktree:x", "--holder", "m-1"]);
  assert.deepEqual(b.positional, ["acquire", "worktree:x"]);
  assert.equal(b.flags.durable, true);
  assert.equal(b.flags.holder, "m-1");
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

test("cli: bin/sfactory dispatches the command named first, as the skills call it", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const shim = fileURLToPath(new URL("../bin/sfactory", import.meta.url));
  const r = spawnSync(process.execPath, [shim, "version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^sfactory \d+\.\d+\.\d+/);
});
