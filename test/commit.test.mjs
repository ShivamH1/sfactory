import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
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
  for (const bad of [[], ["."], ["-A"], ["--all"]]) assert.throws(() => assertNamedPaths(bad), (e) => e.code === "UNNAMED_PATHS", JSON.stringify(bad));
  // literal pathspecs: bracket, star and question-mark names are file names, not globs
  assertNamedPaths(["src/a.mjs", "docs/b.md", "[ab].txt", "src/*", "*", "a?.txt", "app/[id]/page.tsx"]);
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

test("commit: trailers as git parses them are refused", async () => {
  const r = tmpRepo();
  writeFileSync(join(r, "a.txt"), "a");
  const rows = [
    "feat: a\n\nCo-Authored-By: X <x@y>\n# a comment",
    "feat: a\n\nSome prose here\nSigned-off-by: me <a@b>",
    "feat: a\n\nCo-Authored-By: X <x@y>\n  continued here",
    "feat: a\n\nCo-Authored-By:X <x@y>",
    "feat: a\n\nCo-Authored-By : X",
    "feat: a\n\nX2-Ref: 123",
  ];
  for (const m of rows) await assert.rejects(commit(cfg(), { cwd: r, paths: ["a.txt"], message: m, holder: "t" }), (e) => e.code === "TRAILER_REFUSED", m);
  await assert.rejects(commit(cfg(), { cwd: r, paths: ["a.txt"], message: 5, holder: "t" }), (e) => e.code === "BAD_ARGS");
});

test("commit: strict path guard", async () => {
  const r = tmpRepo();
  mkdirSync(join(r, "src")); writeFileSync(join(r, "src", "a.mjs"), "a");
  for (const bad of ["./", ":/", "src/", "", "..", ":(top)", process.platform === "win32" ? "C:/x" : "/etc/x"]) assert.throws(() => assertNamedPaths([bad], { cwd: r }), (e) => e.code === "UNNAMED_PATHS", JSON.stringify(bad));
  assert.throws(() => assertNamedPaths(["src"], { cwd: r }), (e) => e.code === "NOT_A_FILE");
  await assert.rejects(commit(cfg(), { cwd: r, paths: [":/"], message: "feat: a", holder: "t" }), (e) => e.code === "UNNAMED_PATHS");
});

test("commit: only a real true allows trailers", async () => {
  const r = tmpRepo();
  writeFileSync(join(r, "a.txt"), "a");
  await assert.rejects(commit(cfg("false"), { cwd: r, paths: ["a.txt"], message: "feat: a\n\nCo-Authored-By: X <x@y>", holder: "t" }), (e) => e.code === "TRAILER_REFUSED");
});

test("commit: a bracketed route file commits as its literal name", async () => {
  const r = tmpRepo();
  mkdirSync(join(r, "app", "[id]"), { recursive: true });
  writeFileSync(join(r, "app", "[id]", "page.tsx"), "export default 1;");
  mkdirSync(join(r, "app", "i"));
  writeFileSync(join(r, "app", "i", "page.tsx"), "a sibling the glob app/[id]/page.tsx would match");
  await commit(cfg(), { cwd: r, paths: ["app/[id]/page.tsx"], message: "feat: route", holder: "t" });
  assert.equal(git(["show", "--name-only", "--format=", "HEAD"], { cwd: r }), "app/[id]/page.tsx");
});
