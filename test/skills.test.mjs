import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Task 7 extends the folders and this set.
export const KNOWN_PLACEHOLDERS = new Set([
  "model", "files", "brief", "plan", "log", "worktree", "job", "secrets", "report",
  "task", "task_text", "brief_text", "test_command", "base", "head", "diff",
  "implementer_report", "findings", "raw",
]);
export const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "Bash(git log *)", "Bash(git diff *)"]);
const READ_ONLY_AGENTS = new Set(["spec-reviewer", "code-reviewer", "judge", "triage"]);
const MODEL_ID = /\bclaude-|\bgpt-|\bo\d-|sonnet|opus|haiku/i;

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
    const text = readFileSync(path, "utf8");
    const { fm, body } = split(text);
    test(`${dir}/${f}: placeholders are known`, () => {
      for (const m of text.matchAll(/\{\{([^}]*)\}\}/g)) assert.ok(KNOWN_PLACEHOLDERS.has(m[1]), `unknown placeholder {{${m[1]}}}`);
    });
    test(`${dir}/${f}: no env path, secret word or model id`, () => {
      assert.ok(!/\.env/.test(text), ".env");
      assert.ok(!/SECRET/.test(text), "SECRET");
      assert.ok(!MODEL_ID.test(text), `model id literal: ${MODEL_ID.exec(text)?.[0]}`);
    });
    test(`${dir}/${f}: carries the factory rules`, () => {
      assert.match(body ?? text, /\{\{secrets\}\}/);
      assert.match(text, /git stash/);
    });
    if (dir === "agents") {
      test(`agents/${f}: frontmatter`, () => {
        assert.ok(fm, "frontmatter present");
        for (const k of ["name", "description", "model", "tools"]) assert.ok(fm[k], `key ${k}`);
        assert.equal(fm.name, f.replace(/\.md$/, ""));
        assert.equal(fm.model, "{{model}}");
      });
      if (READ_ONLY_AGENTS.has(f.replace(/\.md$/, ""))) {
        test(`agents/${f}: read-only tools and a verdict line`, () => {
          const tools = fm.tools.split(/,\s*(?![^()]*\))/).map((t) => t.trim());
          for (const t of tools) assert.ok(READ_ONLY_TOOLS.has(t), `tool ${t} is not read-only`);
          assert.match(text, /✅ Approved/);
          assert.match(text, /❌ Needs fixes/);
        });
      }
    }
  }
}

test("all expected Task 6 files exist", () => {
  for (const f of ["agents/implementer.md", "agents/spec-reviewer.md", "agents/code-reviewer.md", "agents/judge.md", "agents/triage.md", "prompts/codex-implement.md", "prompts/codex-review.md", "prompts/codex-judge.md", "agents/ATTRIBUTION.md", "prompts/ATTRIBUTION.md"])
    assert.ok(existsSync(join(root, f)), f);
});
