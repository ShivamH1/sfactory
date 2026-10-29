import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir, sh } from "./helpers.mjs";
import { hasTrailers, assertNamedPaths, assertNotSecret, commit } from "../src/commit.mjs";
import { git, isClean } from "../src/git.mjs";

// I3: commit works only in a registered worktree under worktrees.dir, on a branch the factory may write. wtRepo() makes
// one (feature/card, beside a main checkout) and cfg() carries its repoRoot and worktrees.dir.
let ctx = {};
const cfg = (trailers = false) => ({ stateDir: tmpDir("sf-c-"), git: { trailers, namedPathsOnly: true }, limits: { lockStaleMs: 1000 }, ...ctx });
function wtRepo() {
  const root = tmpRepo();
  const dir = tmpDir("sf-cw-");
  const wt = join(dir, "card");
  sh("git", ["worktree", "add", "-q", "-b", "feature/card", wt], root);
  ctx = { repoRoot: root, worktrees: { dir, branchPrefix: "feature/", integrationBranch: "main" } };
  return wt;
}

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
  const r = wtRepo();
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
  const r = wtRepo();
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
  const r = wtRepo();
  mkdirSync(join(r, "src")); writeFileSync(join(r, "src", "a.mjs"), "a");
  for (const bad of ["./", ":/", "src/", "", "..", ":(top)", process.platform === "win32" ? "C:/x" : "/etc/x"]) assert.throws(() => assertNamedPaths([bad], { cwd: r }), (e) => e.code === "UNNAMED_PATHS", JSON.stringify(bad));
  assert.throws(() => assertNamedPaths(["src"], { cwd: r }), (e) => e.code === "NOT_A_FILE");
  await assert.rejects(commit(cfg(), { cwd: r, paths: [":/"], message: "feat: a", holder: "t" }), (e) => e.code === "UNNAMED_PATHS");
});

test("commit: only a real true allows trailers", async () => {
  const r = wtRepo();
  writeFileSync(join(r, "a.txt"), "a");
  await assert.rejects(commit(cfg("false"), { cwd: r, paths: ["a.txt"], message: "feat: a\n\nCo-Authored-By: X <x@y>", holder: "t" }), (e) => e.code === "TRAILER_REFUSED");
});

test("commit: a bracketed route file commits as its literal name", async () => {
  const r = wtRepo();
  mkdirSync(join(r, "app", "[id]"), { recursive: true });
  writeFileSync(join(r, "app", "[id]", "page.tsx"), "export default 1;");
  mkdirSync(join(r, "app", "i"));
  writeFileSync(join(r, "app", "i", "page.tsx"), "a sibling the glob app/[id]/page.tsx would match");
  await commit(cfg(), { cwd: r, paths: ["app/[id]/page.tsx"], message: "feat: route", holder: "t" });
  assert.equal(git(["show", "--name-only", "--format=", "HEAD"], { cwd: r }), "app/[id]/page.tsx");
});

test("commit: refuses a path listed in secrets.neverHandToAgents (SECRET_PATH), before any lock or git call", async () => {
  const r = wtRepo();
  mkdirSync(join(r, "apps/api"), { recursive: true });
  writeFileSync(join(r, "apps/api/.env"), "X=1"); writeFileSync(join(r, "ok.txt"), "ok");
  const c = { ...cfg(), secrets: { neverHandToAgents: [join(ctx.repoRoot, "apps/api/.env")] } };
  await assert.rejects(() => commit(c, { cwd: r, paths: ["apps/api/.env"], message: "feat: x" }), (e) => e.code === "SECRET_PATH");
  await assert.rejects(() => commit(c, { cwd: r, paths: ["ok.txt", "apps/api/../api/.env"], message: "feat: x" }), (e) => e.code === "SECRET_PATH");
  // from a worktree elsewhere the same repo-relative path is still refused
  const wt = tmpDir("sf-wt-");
  mkdirSync(join(wt, "apps/api"), { recursive: true });
  await assert.rejects(() => commit(c, { cwd: wt, paths: ["apps/api/.env"], message: "feat: x" }), (e) => e.code === "SECRET_PATH");
  assert.ok(await commit(c, { cwd: r, paths: ["ok.txt"], message: "feat: ok" }));
});

test("commit: SECRET_PATH covers ancestors, children, case and backslashes", async () => {
  const r = tmpRepo();
  const c = { ...cfg(), repoRoot: r, secrets: { neverHandToAgents: [join(r, "apps", "api", ".env")] } };
  const refused = (p) => assert.throws(() => assertNotSecret(c, [p], { cwd: r }), (e) => e.code === "SECRET_PATH", p);
  refused("apps/api/.env");            // equal
  refused(["apps", "api", ".env"].join(String.fromCharCode(92)));  // backslashes
  refused("apps/api");                 // ancestor
  refused("apps");                     // ancestor
  refused("apps/api/.env/x");          // inside
  refused("./apps/api/./.env");        // normalised
  if (process.platform === "win32") refused("APPS/API/.ENV"); // case-insensitive on win32
  assertNotSecret(c, ["apps/api/index.mjs", "apps/apix", "other/.env"], { cwd: r });
});

test("I3: commit refuses the main checkout, a worktree outside worktrees.dir or not registered, and a branch outside the prefix", async () => {
  const wt = wtRepo();
  const root = ctx.repoRoot;
  writeFileSync(join(root, "m.txt"), "m");
  await assert.rejects(commit(cfg(), { cwd: root, paths: ["m.txt"], message: "feat: m", holder: "t" }), (e) => e.code === "MAIN_CHECKOUT" && /main checkout/.test(e.message));
  // a registered worktree, but outside worktrees.dir
  const stray = join(tmpDir("sf-cs-"), "stray");
  sh("git", ["worktree", "add", "-q", "-b", "feature/stray", stray], root);
  writeFileSync(join(stray, "s.txt"), "s");
  await assert.rejects(commit(cfg(), { cwd: stray, paths: ["s.txt"], message: "feat: s", holder: "t" }), (e) => e.code === "MAIN_CHECKOUT" && /not a card's worktree/.test(e.message));
  // a clone under worktrees.dir that is not a worktree of this repository
  const clone = join(ctx.worktrees.dir, "clone");
  sh("git", ["clone", "-q", root, clone], root);
  writeFileSync(join(clone, "k.txt"), "k");
  await assert.rejects(commit(cfg(), { cwd: clone, paths: ["k.txt"], message: "feat: k", holder: "t" }), (e) => e.code === "MAIN_CHECKOUT");
  // the card's worktree on a branch outside the prefix
  sh("git", ["checkout", "-q", "-b", "other/x"], wt);
  writeFileSync(join(wt, "o.txt"), "o");
  await assert.rejects(commit(cfg(), { cwd: wt, paths: ["o.txt"], message: "feat: o", holder: "t" }), (e) => e.code === "BRANCH_REFUSED");
  sh("git", ["checkout", "-q", "feature/card"], wt);
  assert.match(await commit(cfg(), { cwd: wt, paths: ["o.txt"], message: "feat: o", holder: "t" }), /^[0-9a-f]{40}$/);
  // no repoRoot at all (a caller that bypassed loadConfig) is refused, never waved through
  await assert.rejects(commit({ ...cfg(), repoRoot: undefined }, { cwd: wt, paths: ["o.txt"], message: "feat: o2", holder: "t" }), (e) => e.code === "MAIN_CHECKOUT");
});
