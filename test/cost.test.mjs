import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { jobDir } from "../src/store.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir, tmpRepo, writeConfig } from "./helpers.mjs";
import { addCost, readCost, totalUsd } from "../src/cost.mjs";
import { DEFAULT_PRICES } from "../src/prices.mjs";
import { main } from "../src/cli.mjs";

const cfg = () => ({ stateDir: tmpDir("sf-cost-"), prices: DEFAULT_PRICES });

test("cost: priced and unpriced entries, running total", () => {
  const c = cfg();
  const e = addCost(c, "m-1", { stage: "building", agent: "claude", model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 100_000 });
  assert.equal(e.usd, 2.0 + 1.0); assert.equal(e.priced, true);
  const u = addCost(c, "m-1", { stage: "building", agent: "codex", model: "gpt-6.1-sol", inputTokens: 5, outputTokens: 5 });
  assert.equal(u.usd, null); assert.equal(u.priced, false);
  const all = readCost(c, "m-1");
  assert.equal(all.entries.length, 2);
  assert.deepEqual(totalUsd(all.entries), { usd: 3.0, unpriced: 1 });
  assert.equal(all.total.usd, 3.0);
});

test("cost: CLI add prints a priced figure; bad agent is BAD_ARGS", async () => {
  const repo = tmpRepo();
  writeConfig(repo, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: "state", worktrees: { dir: tmpDir() } });
  const run = async (argv) => {
    let out = "", err = "";
    const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s), cwd: repo });
    return { code, out, err };
  };
  assert.equal((await run(["job", "add", "milestone", "x"])).code, 0);
  const ok = await run(["cost", "add", "m-1", "--stage", "building", "--agent", "claude", "--model", "claude-haiku-5-5", "--in", "1000", "--out", "100"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /m-1 claude-haiku-5-5 \d/);
  const bad = await run(["cost", "add", "m-1", "--stage", "building", "--agent", "nobody", "--model", "x", "--in", "1", "--out", "1"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /BAD_ARGS/);
});

test("cost: corrupt cost.json is COST_CORRUPT", () => {
  const c = cfg();
  mkdirSync(jobDir(c, "m-1"), { recursive: true });
  writeFileSync(join(jobDir(c, "m-1"), "cost.json"), "{bad");
  assert.throws(() => readCost(c, "m-1"), (e) => e.code === "COST_CORRUPT");
});

test("cost: CLI refuses an unknown job and a loose --usd", async () => {
  const repo = tmpRepo();
  const state = tmpDir("sf-state-");
  writeConfig(repo, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: state, worktrees: { dir: tmpDir() } });
  const run = async (argv) => { let err = ""; const code = await main(argv, { stdout() {}, stderr: (s) => (err += s), cwd: repo }); return { code, err }; };
  const r = await run(["cost", "add", "m-99", "--stage", "building", "--agent", "claude", "--model", "x", "--in", "1", "--out", "1"]);
  assert.equal(r.code, 2); assert.match(r.err, /JOB_NOT_FOUND/);
  assert.equal(existsSync(join(state, "jobs", "m-99")), false);
  assert.equal((await run(["job", "add", "milestone", "x"])).code, 0);
  const u = await run(["cost", "add", "m-1", "--stage", "building", "--agent", "claude", "--model", "x", "--in", "1", "--out", "1", "--usd", "1e3"]);
  assert.equal(u.code, 2); assert.match(u.err, /BAD_ARGS/);
});
