import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { main } from "../src/cli.mjs";
import { DEFAULTS } from "../src/config.mjs";

const run = (argv) => {
  const out = [], err = [];
  return main(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), cwd: process.cwd() }).then((code) => ({ code, out: out.join(""), err: err.join("") }));
};

test("board --demo --once prints the demo URL and exits 0", async () => {
  const r = await run(["board", "--demo", "--once", "--port", "0"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^board \(demo, read-only\) at http:\/\/127\.0\.0\.1:\d+\/\n$/);
});

test("the default board port is 4317", () => assert.equal(DEFAULTS.board.port, 4317));

test("--port must be a whole number", async () => {
  for (const bad of ["abc", "-1", "70000", "1.5"]) {
    const r = await run(["board", "--demo", "--once", `--port=${bad}`]);
    assert.equal(r.code, 2, bad);
    assert.match(r.err, /BAD_ARGS/);
  }
  const r = await run(["board", "--demo", "--once", "--port"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /BAD_ARGS/);
});

test("a port that is taken is a refusal, not an internal error", async () => {
  const holder = createServer();
  await new Promise((res) => holder.listen(0, "127.0.0.1", res));
  try {
    const port = holder.address().port;
    const r = await run(["board", "--demo", "--once", "--port", String(port)]);
    assert.equal(r.code, 2);
    assert.match(r.err, /PORT_UNAVAILABLE/);
    assert.match(r.err, new RegExp(`127\.0\.0\.1:${port}`));
    assert.doesNotMatch(r.err, /INTERNAL/);
  } finally { await new Promise((res) => holder.close(res)); }
});
