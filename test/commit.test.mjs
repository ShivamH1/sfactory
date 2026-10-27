import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir } from "./helpers.mjs";
import { hasTrailers, assertNamedPaths, commit } from "../src/commit.mjs";
import { git, isClean } from "../src/git.mjs";

const cfg = (trailers = false) => ({ stateDir: tmpDir("sf-c-"), git: { trailers, namedPathsOnly: true }, limits: { lockStaleMs: 1000 } });

test("commit: trailer detection", () => {
  assert.deepEqual(hasTrailers("feat: x\n\nbody\n\nCo-Authored-By: Someone <a@b>\nSigned-off-by: me"), ["Co-Authored-By: Someone <a@b>", "Signed-off-by: me"]);
  assert.deepEqual(hasTrailers("feat: x\n\nNote: this is prose in the body, not a trailer paragraph\nmore"), []);
  assert.deepEqual(hasTrailers("feat: x"), []);
});

test("commit: named paths only", () => {
  for (const bad of [[], ["."], ["-A"], ["--all"], ["src/*"], ["*"]]) assert.throws(() => assertNamedPaths(bad), (e) => e.code === "UNNAMED_PATHS", JSON.stringify(bad));
  assertNamedPaths(["src/a.mjs", "docs/b.md"]);
});

test("commit: commits named paths only, refuses trailers, leaves other changes unstaged", async () => {
  const r = tmpRepo();
  writeFileSync(join(r, "a.txt"), "a"); writeFileSync(join(r, "b.txt"), "b");
  await assert.rejects(commit(cfg(), { cwd: r, paths: ["a.txt"], message: "feat: a\n\nCo-Authored-By: X <x@y>", holder: "t" }), (e) => e.code === "TRAILER_REFUSED");
  const sha = await commit(cfg(), { cwd: r, paths: ["a.txt"], message: "feat: a", holder: "t" });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(git(["show", "--stat", "--format=", "HEAD"], { cwd: r }).includes("a.txt"), true);
  assert.equal(isClean(r), false);   // b.txt is still untracked
  await commit(cfg(true), { cwd: r, paths: ["b.txt"], message: "feat: b\n\nCo-Authored-By: X <x@y>", holder: "t" });
  assert.match(git(["log", "-1", "--format=%B"], { cwd: r }), /Co-Authored-By/);
});
