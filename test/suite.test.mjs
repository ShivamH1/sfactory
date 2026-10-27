import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.mjs";
import { runSuite } from "../src/suite.mjs";
import { acquire } from "../src/lock.mjs";

const cfg = (suite) => ({ stateDir: tmpDir("sf-s-"), commands: { suite, suiteSerial: true }, limits: { suiteWaitMs: 300, lockStaleMs: 60_000 } });

test("suite: green run logs and returns ok", async () => {
  const c = cfg('node -e "console.log(\'12 passing\')"');
  const log = join(tmpDir(), "suite.log");
  const r = await runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: log });
  assert.equal(r.ok, true); assert.equal(r.code, 0);
  assert.match(readFileSync(log, "utf8"), /=== .* node -e/); assert.match(r.tail, /12 passing/);
});

test("suite: red run returns ok=false with the exit code, no throw", async () => {
  const c = cfg('node -e "console.error(\'1 failing\'); process.exit(1)"');
  const r = await runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: join(tmpDir(), "s.log") });
  assert.equal(r.ok, false); assert.equal(r.code, 1); assert.match(r.tail, /1 failing/);
});

test("suite: waits for the lock and gives up with LOCK_HELD", async () => {
  const c = cfg("node -e 0");
  const l = await acquire(c, "suite", { holder: "other" });
  await assert.rejects(runSuite(c, { cwd: process.cwd(), jobId: "m-1", logPath: join(tmpDir(), "s.log") }), (e) => e.code === "LOCK_HELD");
  l.release();
});
