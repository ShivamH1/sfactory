import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";

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
