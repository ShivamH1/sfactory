import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, writeConfig } from "./helpers.mjs";
import { loadConfig, validateConfig } from "../src/config.mjs";
import { newJob } from "../src/job.mjs";
import { cut, remove } from "../src/worktree.mjs";
import { branchExists } from "../src/git.mjs";
import { servicesUp, servicesDown } from "../src/services.mjs";
import { actions } from "../src/job-actions.mjs";
import { withJobLock, writeJob, readJob } from "../src/store.mjs";
import { runDoctor } from "../src/doctor.mjs";

// C1 (Plan C final review): a secret is never copied into a card's worktree at the cut; copyForVerify lands it for
// the verify stage only, and services down, job stop and worktree remove take it out again.
function setup(worktrees = {}, secrets = []) {
  const root = tmpRepo();
  writeConfig(root, { project: "p", agents: { mode: "claude" }, commands: { suite: "x" }, stateDir: tmpDir("sf-st-"), worktrees: { dir: tmpDir("sf-wt-"), ...worktrees }, secrets: { neverHandToAgents: secrets } });
  return { root, c: loadConfig(root) };
}
const save = (c, job) => withJobLock(c, job.id, () => writeJob(c, job));

test("verify copies: a copyFromBase entry covered by secrets is refused at the cut (SECRET_PATH), and nothing is cut or copied", () => {
  const { root, c } = setup({ copyFromBase: ["apps/api/.env"] }, ["apps/api/.env"]);
  mkdirSync(join(root, "apps", "api"), { recursive: true });
  writeFileSync(join(root, "apps", "api", ".env"), "KEY=1\n");
  assert.throws(() => cut(c, newJob({ id: "m-1", kind: "milestone", title: "Leaky" }), {}), (e) => e.code === "SECRET_PATH" && /copyForVerify/.test(e.message));
  assert.equal(existsSync(join(c.worktrees.dir, "leaky")), false);
  assert.equal(branchExists(root, "feature/leaky"), false);
  // A directory entry that contains the secret is refused too.
  const { c: c2 } = setup({ copyFromBase: ["apps/api"] }, ["apps/api/.env"]);
  assert.throws(() => cut(c2, newJob({ id: "m-2", kind: "milestone", title: "Leaky dir" }), {}), (e) => e.code === "SECRET_PATH");
});

test("verify copies: services up copies copyForVerify into the worktree, services down removes only what it copied", async () => {
  const { root, c } = setup({ copyForVerify: ["apps/api/.env", "keep.txt", "absent.txt"] }, ["apps/api/.env"]);
  mkdirSync(join(root, "apps", "api"), { recursive: true });
  writeFileSync(join(root, "apps", "api", ".env"), "KEY=1\n");
  writeFileSync(join(root, "keep.txt"), "from base\n");
  const job = { ...cut(c, newJob({ id: "m-1", kind: "milestone", title: "Verify me" }), {}), stage: "verifying" };
  save(c, job);
  assert.equal(existsSync(join(job.worktree, "apps", "api", ".env")), false, "nothing secret at the cut");
  writeFileSync(join(job.worktree, "keep.txt"), "the worktree's own\n"); // already there: not ours to copy over or remove
  const logs = [];
  await servicesUp(c, job, { log: (m) => logs.push(m) });
  assert.equal(readFileSync(join(job.worktree, "apps", "api", ".env"), "utf8"), "KEY=1\n");
  assert.equal(readFileSync(join(job.worktree, "keep.txt"), "utf8"), "the worktree's own\n");
  assert.ok(logs.some((l) => /absent\.txt not found/.test(l)), "a missing source is reported");
  const r = await servicesDown(c, job);
  assert.deepEqual(r.copiesRemoved, ["apps/api/.env"]);
  assert.equal(existsSync(join(job.worktree, "apps", "api", ".env")), false);
  assert.equal(readFileSync(join(job.worktree, "keep.txt"), "utf8"), "the worktree's own\n");
  remove(c, readJob(c, "m-1"), { force: true });
});

test("verify copies: job stop and worktree remove take the copies out of the worktree", async () => {
  const { root, c } = setup({ copyForVerify: [".env"] }, [".env"]);
  writeFileSync(join(root, ".gitignore"), ".env\n");
  writeFileSync(join(root, ".env"), "KEY=1\n");
  const a = { ...cut(c, newJob({ id: "m-1", kind: "milestone", title: "Stop me" }), {}), stage: "verifying" };
  save(c, a);
  await servicesUp(c, a);
  assert.ok(existsSync(join(a.worktree, ".env")));
  actions.stop(c, { id: "m-1", reason: "by the person" });
  assert.equal(existsSync(join(a.worktree, ".env")), false, "stop removed the copy");

  const b = { ...cut(c, newJob({ id: "m-2", kind: "milestone", title: "Clean me" }), {}), stage: "verifying" };
  save(c, b);
  await servicesUp(c, b);
  assert.ok(existsSync(join(b.worktree, ".env")));
  remove(c, readJob(c, "m-2")); // no --force: the copy is removed first, so the tree is clean
  assert.equal(existsSync(b.worktree), false);
});

test("verify copies: copyForVerify is validated like the other lists, inside the repo only", () => {
  const base = { project: "p", agents: { mode: "claude" }, commands: { suite: "x" } };
  assert.ok(validateConfig({ ...base, worktrees: { copyForVerify: [".env", 3] } }).some((e) => /worktrees\.copyForVerify/.test(e)));
  assert.ok(validateConfig({ ...base, worktrees: { copyForVerify: ["../x/.env"] } }).some((e) => /copyForVerify: "\.\.\/x\/\.env" must be a path inside the repo/.test(e)));
  assert.ok(validateConfig({ ...base, worktrees: { copyFromBase: ["C:/x"] } }).some((e) => /copyFromBase: "C:\/x" must be a path inside the repo/.test(e)));
  assert.deepEqual(validateConfig({ ...base, worktrees: { copyForVerify: ["apps/api/.env"] } }), []);
});

test("verify copies: doctor warns (WARN, not FAIL) on a copyFromBase entry covered by secrets", () => {
  const { c } = setup({ copyFromBase: ["apps/api/.env"], copyForVerify: ["apps/web/.env"] }, ["apps/api/.env", "apps/web/.env"]);
  const r = runDoctor(c, { exec: () => ({ status: 0, stdout: "x 1\n" }) });
  const w = r.checks.filter((x) => x.warn);
  assert.equal(w.length, 1);
  assert.equal(w[0].ok, true);
  assert.match(w[0].detail, /apps\/api\/\.env.*SECRET_PATH.*copyForVerify/);
});

test("verify copies: sfactory services copy <id> lands them without starting anything (a migration may need them first)", async () => {
  const { main } = await import("../src/cli.mjs");
  const { root, c } = setup({ copyForVerify: [".env", "nope.txt"] }, [".env"]);
  writeFileSync(join(root, ".env"), "KEY=1\n");
  const job = { ...cut(c, newJob({ id: "m-1", kind: "milestone", title: "Copy only" }), {}), stage: "verifying" };
  save(c, job);
  const out = [], err = [];
  const code = await main(["services", "copy", "m-1"], { cwd: root, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  assert.equal(code, 1, "a missing source is exit 1");
  assert.match(out.join(""), /copied 1, missing nope\.txt/);
  assert.ok(existsSync(join(job.worktree, ".env")));
  assert.equal(existsSync(join(c.stateDir, "jobs", "m-1", "verify", "services.json")), false, "no service started");
  const r = await servicesDown(c, job);
  assert.deepEqual(r.copiesRemoved, [".env"]);
  remove(c, readJob(c, "m-1"), { force: true });
});
