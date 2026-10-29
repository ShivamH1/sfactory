import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, tmpDir } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { pluginRoot } from "../src/install.mjs";

const put = (root, rel, body) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), body); };
const fakePlugin = () => { const p = tmpDir("sf-plug-"); put(p, "skills/a/SKILL.md", "A\n"); put(p, "agents/x.md", "X\n"); writeFileSync(join(p, "package.json"), JSON.stringify({ name: "sfactory" })); return p; }; // no prompts/
const run = async (cwd, args, extra = {}) => { let out = "", err = ""; const code = await main(args, { cwd, stdout: (s) => (out += s), stderr: (s) => (err += s), ...extra }); return { code, out, err }; };

test("install: copies what exists under the plugin root into <repo>/.claude and names what was absent", async () => {
  const root = tmpRepo(), plug = fakePlugin();
  const r = await run(root, ["install"], { env: { CLAUDE_PLUGIN_ROOT: plug } });
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(root, ".claude/skills/a/SKILL.md"), "utf8"), "A\n");
  assert.equal(readFileSync(join(root, ".claude/agents/x.md"), "utf8"), "X\n");
  assert.match(r.out, /2 copied/); assert.match(r.out, /not in the plugin: prompts/);
  const again = await run(root, ["install"], { env: { CLAUDE_PLUGIN_ROOT: plug } });
  assert.equal(again.code, 0); assert.match(again.out, /0 copied, 2 already identical/);
});

test("install: a differing file is kept (exit 1) unless --force", async () => {
  const root = tmpRepo(), plug = fakePlugin();
  put(root, ".claude/skills/a/SKILL.md", "mine\n");
  const r = await run(root, ["install"], { env: { CLAUDE_PLUGIN_ROOT: plug } });
  assert.equal(r.code, 1); assert.match(r.out, /kept    skills\/a\/SKILL\.md/);
  assert.equal(readFileSync(join(root, ".claude/skills/a/SKILL.md"), "utf8"), "mine\n");
  const f = await run(root, ["install", "--force"], { env: { CLAUDE_PLUGIN_ROOT: plug } });
  assert.equal(f.code, 0); assert.equal(readFileSync(join(root, ".claude/skills/a/SKILL.md"), "utf8"), "A\n");
});

test("install --codex: skills only, straight into the destination; --dest overrides", async () => {
  const root = tmpRepo(), plug = fakePlugin(), dest = tmpDir("sf-codex-");
  const r = await run(root, ["install", "--codex", "--dest", dest], { env: { CLAUDE_PLUGIN_ROOT: plug } });
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(dest, "a/SKILL.md"), "utf8"), "A\n");
  assert.ok(!existsSync(join(dest, "agents")) && !existsSync(join(dest, "x.md")));
  const home = tmpDir("sf-home-");
  assert.equal((await run(root, ["install", "--codex"], { env: { CLAUDE_PLUGIN_ROOT: plug }, home })).code, 0);
  assert.ok(existsSync(join(home, ".codex/skills/a/SKILL.md")));
  assert.equal((await run(root, ["install", "--dest"], { env: { CLAUDE_PLUGIN_ROOT: plug } })).code, 2);
});

test("pluginRoot: the env var wins, else the package directory (never the repo)", () => {
  assert.equal(pluginRoot({ CLAUDE_PLUGIN_ROOT: "/x/y" }), "/x/y");
  assert.ok(existsSync(join(pluginRoot({}), "package.json")));
});

test("install: a symlink in the plugin is skipped and reported; a directory in the way is an error; no folder at all exits 1", async () => {
  const root = tmpRepo(), plug = fakePlugin();
  let linked = false;
  try { symlinkSync("SKILL.md", join(plug, "skills/a/link.md")); linked = true; } catch { /* no symlink right here */ }
  const r = await run(root, ["install"], { env: { CLAUDE_PLUGIN_ROOT: plug } });
  assert.equal(r.code, 0, r.err);
  if (linked) { assert.match(r.out, /skipped symlink skills\/a\/link\.md/); assert.equal(existsSync(join(root, ".claude/skills/a/link.md")), false); }
  const root2 = tmpRepo(); mkdirSync(join(root2, ".claude/agents/x.md"), { recursive: true });
  const e = await run(root2, ["install"], { env: { CLAUDE_PLUGIN_ROOT: plug } });
  assert.equal(e.code, 2); assert.match(e.err, /INSTALL_TARGET_IS_DIRECTORY/);
  const empty = tmpDir("sf-plug-"); writeFileSync(join(empty, "package.json"), JSON.stringify({ name: "sfactory" }));
  const n = await run(tmpRepo(), ["install"], { env: { CLAUDE_PLUGIN_ROOT: empty } });
  assert.equal(n.code, 1); assert.match(n.out, /nothing to install/);
});

test("install: CLAUDE_PLUGIN_ROOT must be this package (package.json name)", async () => {
  const other = tmpDir("sf-plug-"); put(other, "skills/a/SKILL.md", "A\n"); writeFileSync(join(other, "package.json"), JSON.stringify({ name: "something-else" }));
  const r = await run(tmpRepo(), ["install"], { env: { CLAUDE_PLUGIN_ROOT: other } });
  assert.equal(r.code, 2); assert.match(r.err, /BAD_PLUGIN_ROOT/);
  const none = tmpDir("sf-plug-"); put(none, "skills/a/SKILL.md", "A\n");
  assert.match((await run(tmpRepo(), ["install"], { env: { CLAUDE_PLUGIN_ROOT: none } })).err, /BAD_PLUGIN_ROOT/);
});
