import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpRepo, tmpDir, sh } from "./helpers.mjs";
import { main } from "../src/cli.mjs";

// I7 (Plan C final review): the git reads the skills need are sfactory verbs, so allowed-tools carry no Bash(git *)
// or Bash(bash *): sfactory brief (was skills/sdd/scripts/task-brief), sfactory diff, sfactory tree.
async function run(argv, cwd) {
  const out = [], err = [];
  const code = await main(argv, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
}

test("brief: one task, up to the next heading of its level, fences honoured, exact ids, CRLF read as LF", async () => {
  const dir = tmpDir("sf-brief-");
  const plan = join(dir, "plan.md");
  writeFileSync(plan, ["# P", "", "### Task 1: one", "", "````md", "```", "### Task 2: fake", "```", "````", "end one", "", "### Task 2: two", "two", "", "### Task 3a: three-a", "x", "", "## Self-review", "tail", ""].join("\n"));
  let r = await run(["brief", plan, "1", "--out", join(dir, "t", "1", "brief.md")], dir);
  assert.equal(r.code, 0); assert.match(r.out, /wrote .*brief\.md: 9 lines/);
  assert.equal(readFileSync(join(dir, "t", "1", "brief.md"), "utf8"), ["### Task 1: one", "", "````md", "```", "### Task 2: fake", "```", "````", "end one", "", ""].join("\n"));
  r = await run(["brief", plan, "3a", "--out", join(dir, "3a.md")], dir);
  assert.equal(readFileSync(join(dir, "3a.md"), "utf8"), ["### Task 3a: three-a", "x", "", ""].join("\n"));
  r = await run(["brief", plan, "3", "--out", join(dir, "3.md")], dir);
  assert.equal(r.code, 2); assert.match(r.err, /TASK_NOT_FOUND/); assert.equal(existsSync(join(dir, "3.md")), false, "Task 3 is not Task 3a");
  r = await run(["brief", plan, "1; rm", "--out", join(dir, "bad.md")], dir);
  assert.match(r.err, /BAD_ARGS: bad task id/);
  r = await run(["brief", plan, "1"], dir);
  assert.match(r.err, /BAD_ARGS: usage: sfactory brief/);
  const crlf = join(dir, "crlf.md");
  writeFileSync(crlf, ["# P", "", "### Task 1: one", "body", "", "### Task 2: two", "x", ""].join("\r\n"));
  await run(["brief", crlf, "1", "--out", join(dir, "c1.md")], dir);
  assert.equal(readFileSync(join(dir, "c1.md"), "latin1"), ["### Task 1: one", "body", "", ""].join("\n"));
});

function repo() {
  const r = tmpRepo();
  const base = sh("git", ["rev-parse", "HEAD"], r);
  writeFileSync(join(r, "a.txt"), "one\n"); writeFileSync(join(r, "b.txt"), "bee\n");
  sh("git", ["add", "a.txt", "b.txt"], r); sh("git", ["commit", "-q", "-m", "feat: a and b"], r);
  const head = sh("git", ["rev-parse", "HEAD"], r);
  return { r, base, head };
}

test("diff: --out writes the review package over the named paths; --names and --commits print", async () => {
  const { r, base, head } = repo();
  const out = join(tmpDir("sf-d-"), "pkg", "x.diff");
  let res = await run(["diff", "--cwd", r, base, head, "--out", out, "--", "a.txt"], r);
  assert.equal(res.code, 0, res.err);
  const pkg = readFileSync(out, "utf8");
  assert.match(pkg, new RegExp(`^# Review package: ${base}\\.\\.${head}\\n\\n## Commits\\n[0-9a-f]+ feat: a and b\\n\\n## Files changed\\n ?a\\.txt \\| 1 \\+`));
  assert.match(pkg, /## Diff\n[\s\S]*\+one/);
  assert.ok(!pkg.includes("b.txt"), "only the named paths");
  res = await run(["diff", "--cwd", r, base, head, "--names"], r);
  assert.equal(res.out, "a.txt\nb.txt\n");
  res = await run(["diff", "--cwd", r, base, "HEAD", "--commits"], r);
  assert.match(res.out, /^[0-9a-f]+ feat: a and b\n$/);
  // refusals: no mode, two modes, a ref that is an option or a range
  for (const argv of [["diff", "--cwd", r, base, head], ["diff", "--cwd", r, base, head, "--names", "--commits"], ["diff", "--cwd", r, "--all", head, "--names"], ["diff", "--cwd", r, `${base}..${head}`, head, "--names"], ["diff", base, head, "--names"]]) {
    res = await run(argv, r);
    assert.equal(res.code, 2, argv.join(" ")); assert.match(res.err, /BAD_ARGS/);
  }
});

test("diff: head WORKTREE is the working tree against base, new files included (the triage's package)", async () => {
  const { r, head } = repo();
  writeFileSync(join(r, "a.txt"), "two\n");
  writeFileSync(join(r, "new.txt"), "brand new\n");
  writeFileSync(join(r, ".gitignore"), "ignored.txt\n"); writeFileSync(join(r, "ignored.txt"), "no\n");
  const out = join(tmpDir("sf-d-"), "wip.diff");
  const res = await run(["diff", "--cwd", r, "HEAD", "WORKTREE", "--out", out, "--", "a.txt", "new.txt", "ignored.txt"], r);
  assert.equal(res.code, 0, res.err);
  const pkg = readFileSync(out, "utf8");
  assert.match(pkg, /-one\n\+two/);
  assert.match(pkg, /new\.txt \(new, untracked\)/);
  assert.match(pkg, /\+brand new/);
  assert.ok(!pkg.includes("+no"), "an ignored file is not a new file");
  const names = await run(["diff", "--cwd", r, head, "WORKTREE", "--names"], r);
  assert.deepEqual(names.out.trim().split("\n").sort(), [".gitignore", "a.txt", "new.txt"]);
});

test("tree: prints the porcelain lines (untracked files one by one) and exits 1 when dirty; clean is exit 0 and silent; --head prints HEAD", async () => {
  const { r, head } = repo();
  let res = await run(["tree", r], r);
  assert.deepEqual([res.code, res.out], [0, ""]);
  mkdirSync(join(r, "d", "e"), { recursive: true });
  writeFileSync(join(r, "d", "e", "f.txt"), "x"); writeFileSync(join(r, "a.txt"), "changed\n");
  res = await run(["tree", r], r);
  assert.equal(res.code, 1);
  assert.equal(res.out, " M a.txt\n?? d/e/f.txt\n", "the status column is kept and an untracked folder is listed file by file");
  res = await run(["tree", r, "--head"], r);
  assert.equal(res.out, `${head}\n`);
  res = await run(["tree"], r);
  assert.match(res.err, /BAD_ARGS/);
});

test("bin: sfactory-brief, sfactory-diff and sfactory-tree are committed executable shims", () => {
  const root = join(import.meta.dirname, "..");
  const modes = execFileSync("git", ["ls-files", "-s", "--", "bin/sfactory-brief", "bin/sfactory-diff", "bin/sfactory-tree"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  assert.equal(modes.length, 3);
  for (const m of modes) assert.match(m, /^100755 /, m);
  for (const v of ["brief", "diff", "tree"]) assert.ok(statSync(join(root, "bin", `sfactory-${v}`)).isFile());
});
