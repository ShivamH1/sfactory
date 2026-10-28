import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpRepo, tmpDir, writeConfig } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { main } from "../src/cli.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fakeExec = (present) => (cmd) => { const w = String(cmd).split(" ")[0]; const ok = present.includes(w); return { status: ok ? 0 : 1, stdout: ok ? `${w} 1.0.0
` : "", stderr: "" }; };

test("doctor: a healthy claude-mode project passes", () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: 47300 } });
  const r = runDoctor(loadConfig(root), { exec: fakeExec(["git", "claude"]) });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.ok(r.checks.some((c) => c.name === "claude" && c.ok));
  assert.ok(!r.checks.some((c) => c.name === "codex"));
});

test("doctor: mixed mode without codex fails that one check and names it", () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "mixed" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: 47400 } });
  const r = runDoctor(loadConfig(root), { cwd: root, exec: fakeExec(["git", "claude"]), codexHome: "/nonexistent" });
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

function mixedCfg(port) {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "mixed" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: port } });
  return loadConfig(root);
}
const homeWith = (...names) => { const d = tmpDir("sf-home-"); for (const n of names) writeFileSync(join(d, `${n}.config.toml`), 'model = "x"'); return d; };
const prof = (r, n) => r.checks.find((c) => c.name === `codex profile ${n}`);
const all = ["git", "claude", "codex"];

test("doctor: both profile files present pass", () => {
  const r = runDoctor(mixedCfg(47500), { exec: fakeExec(all), codexHome: homeWith("implement", "review") });
  assert.ok(prof(r, "implement").ok && prof(r, "review").ok, JSON.stringify(r.checks));
});

test("doctor: an empty codex home fails both profile rows", () => {
  const r = runDoctor(mixedCfg(47510), { exec: fakeExec(all), codexHome: homeWith() });
  assert.equal(prof(r, "implement").ok, false); assert.equal(prof(r, "review").ok, false);
});

test("doctor: a [profiles.*] table in config.toml does not count; one missing file still fails", () => {
  const d = homeWith("review");
  writeFileSync(join(d, "config.toml"), "[profiles.implement]\nmodel = \"x\"\n");
  const r = runDoctor(mixedCfg(47520), { exec: fakeExec(all), codexHome: d });
  assert.equal(prof(r, "review").ok, true); assert.equal(prof(r, "implement").ok, false);
});

test("doctor: rules files differing only by line endings are the same", () => {
  const root = tmpRepo();
  writeFileSync(join(root, "A.md"), "a\nb\n"); writeFileSync(join(root, "B.md"), "a\r\nb\r\n");
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "npm test" }, rules: ["A.md", "B.md"], stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: 47530 } });
  const r = runDoctor(loadConfig(root), { exec: fakeExec(["git", "claude"]) });
  assert.equal(r.checks.find((x) => x.name === "rules").ok, true);
});

test("doctor command: a bad config shows the error code on the config row and exits 1", async () => {
  const out = [];
  const code = await main(["doctor"], { cwd: tmpRepo(), stdout: (s) => out.push(s), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(out.join(""), /FAIL\s+config\s+NO_CONFIG/);
});

test("doctor command: a good config prints a ports.base row", async () => {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "npm test" }, stateDir: tmpDir("sf-d-"), worktrees: { dir: tmpDir("sf-dw-") }, ports: { base: 47540 } });
  const out = [];
  await main(["doctor"], { cwd: root, stdout: (s) => out.push(s), stderr: () => {} });
  assert.match(out.join(""), /ports\.base\s+47540/);
});
