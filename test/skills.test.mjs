import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_PLACEHOLDERS } from "../src/placeholders.mjs";
import { READ_ONLY_TOOLS, checkCommon, selfTest } from "./skills.helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Task 7 extends the folders. agents/ are static (Claude Code renders no placeholders); prompts/ are rendered by the script.
const READ_ONLY_AGENTS = new Set(["spec-reviewer", "code-reviewer", "judge", "triage"]);

const FOLDERS = ["agents", "prompts"];
function files(dir) {
  const p = join(root, dir);
  return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(".md") && f !== "ATTRIBUTION.md").map((f) => ({ dir, f, path: join(p, f) })) : [];
}
function split(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { fm: null, body: text };
  const fm = {};
  for (const l of m[1].split("\n")) { const i = l.indexOf(":"); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { fm, body: m[2] };
}

for (const dir of FOLDERS) {
  for (const { f, path } of files(dir)) {
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    const { fm } = split(text);
    const label = `${dir}/${f}`;
    checkCommon(label, text);
    if (dir === "agents") {
      test(`${label}: static - no placeholders, frontmatter has no model`, () => {
        assert.ok(!/\{\{/.test(text), "agents are never rendered");
        assert.ok(fm, "frontmatter present");
        for (const k of ["name", "description", "tools"]) assert.ok(fm[k], `key ${k}`);
        assert.ok(!("model" in fm), "the orchestrator passes the model at dispatch");
        assert.equal(fm.name, f.replace(/\.md$/, ""));
      });
      const name = f.replace(/\.md$/, "");
      if (READ_ONLY_AGENTS.has(name)) {
        test(`${label}: read-only tools, final-message report, gate rule`, () => {
          for (const t of fm.tools.split(",").map((s) => s.trim())) assert.ok(READ_ONLY_TOOLS.has(t), `tool ${t} is not read-only`);
          assert.match(text, /final message IS the report/);
          assert.match(text, /✅ Approved/);
          assert.match(text, /❌ Needs fixes/);
          assert.match(text, /Critical or Important/);
        });
      }
      if (name === "implementer") {
        test(`${label}: commit rule, files rule, TDD evidence, fix round`, () => {
          assert.match(text, /sfactory commit --cwd <WORKTREE> --holder <JOB> --m /);
          assert.match(text, /Never `git commit`/);
          assert.match(text, /Touch only those files/);
          assert.match(text, /RED/); assert.match(text, /GREEN/);
          assert.match(text, /After review findings/);
        });
      }
    } else {
      test(`${label}: placeholders are known`, () => {
        for (const m of text.matchAll(/\{\{([^}]*)\}\}/g)) assert.ok(KNOWN_PLACEHOLDERS.has(m[1]), `unknown placeholder {{${m[1]}}}`);
      });
      test(`${label}: Codex never commits and reports by final message`, () => {
        assert.ok(!/sfactory commit --cwd/.test(text), "no commit command");
        assert.ok(!/standard output|stdout/i.test(text), "report is the final message");
        assert.match(text, /final message/);
      });
      test(`${label}: inlined inputs sit in a fenced data block after the rules`, () => {
        const i = text.indexOf("## Rules of the factory");
        const j = text.indexOf("````text");
        assert.ok(i > 0 && j > i, "fence after the rules");
        for (const m of text.matchAll(/\{\{(\w+_text)\}\}/g)) {
          const at = m.index;
          const open = text.lastIndexOf("````text\n", at);
          const close = text.indexOf("\n````", at);
          assert.ok(open > i && open < at && close > at && !text.slice(open + 9, at).includes("\n````"), `{{${m[1]}}} is inside a fence`);
        }
      });
    }
  }
}

test("secrets: example configs' neverHandToAgents entries are not named in any file", () => {
  const dir = join(root, "examples");
  const entries = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
    entries.push(...(c.secrets?.neverHandToAgents ?? []));
  }
  assert.ok(entries.length > 0);
  for (const d of FOLDERS) for (const { f, path } of files(d)) {
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    for (const e of entries) assert.ok(!text.includes(e), `${d}/${f} names ${e}`);
  }
});

test("all expected Task 6 files exist", () => {
  for (const f of ["agents/implementer.md", "agents/spec-reviewer.md", "agents/code-reviewer.md", "agents/judge.md", "agents/triage.md", "prompts/codex-implement.md", "prompts/codex-review.md", "prompts/codex-judge.md", "agents/ATTRIBUTION.md", "prompts/ATTRIBUTION.md"])
    assert.ok(existsSync(join(root, f)), f);
});

test("the Rules of the factory block is identical across agents/ and across prompts/", () => {
  const rules = (text) => /## Rules of the factory[\s\S]*?(?=\n## )/.exec(text)?.[0];
  for (const dir of FOLDERS) {
    const blocks = files(dir).map(({ f, path }) => [f, rules(readFileSync(path, "utf8"))]);
    assert.ok(blocks.length > 0);
    for (const [f, b] of blocks) { assert.ok(b, `${dir}/${f} has the block`); assert.equal(b, blocks[0][1], `${dir}/${f} differs from ${blocks[0][0]}`); }
  }
});

selfTest();

test("no tracked text file contains control bytes (a raw backspace once replaced every \b)", () => {
  const out = execFileSync("git", ["ls-files", "-z", "--", "src", "test", "board", "agents", "prompts", "skills", "examples", "bin"], { cwd: root, encoding: "utf8" });
  const bad = [];
  for (const f of out.split("\0").filter(Boolean)) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|zip)$/i.test(f)) continue;
    const p = join(root, f);
    if (!existsSync(p)) continue;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(readFileSync(p, "latin1"))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
