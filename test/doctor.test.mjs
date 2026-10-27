import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpRepo, tmpDir, writeConfig } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { runDoctor } from "../src/doctor.mjs";

const fakeExec = (present) => (cmd) => ({ status: present.includes(cmd) ? 0 : 1, stdout: present.includes(cmd) ? `${cmd} 1.0.0\n` : "", stderr: "" });

test("doctor: a healthy claude-mode project passes", () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: 47300 } });
  const r = runDoctor(loadConfig(root), { cwd: root, exec: fakeExec(["git", "claude"]) });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.ok(r.checks.some((c) => c.name === "claude" && c.ok));
  assert.ok(!r.checks.some((c) => c.name === "codex"));
});

test("doctor: mixed mode without codex fails that one check and names it", () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "mixed" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: 47400 } });
  const r = runDoctor(loadConfig(root), { cwd: root, exec: fakeExec(["git", "claude"]), codexConfigPath: "/nonexistent" });
  assert.equal(r.ok, false);
  const codex = r.checks.find((c) => c.name === "codex");
  assert.equal(codex.ok, false); assert.match(codex.detail, /not on PATH/);
});

test("doctor: no config reports NO_CONFIG and skips the dependent checks", () => {
  const root = tmpRepo();
  const r = runDoctor(null, { cwd: root, exec: fakeExec(["git"]) });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === "config" && !c.ok));
  assert.ok(!r.checks.some((c) => c.name === "stateDir"));
});
