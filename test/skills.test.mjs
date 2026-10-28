import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_PLACEHOLDERS } from "../src/placeholders.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Task 7 extends the folders. agents/ are static (Claude Code renders no placeholders); prompts/ are rendered by the script.
export const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);
const READ_ONLY_AGENTS = new Set(["spec-reviewer", "code-reviewer", "judge", "triage"]);
export const MODEL_ID = /\bclaude-|\bgpt|gemini|fable|sonnet|opus|haiku|\bo[1-9]\b|codex-mini|codex-max/i;
export const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{8,}/, /\bghp_[A-Za-z0-9]{8,}/, /\bAKIA[0-9A-Z]{8,}/, /\bxox[abprs]-/, /-----BEGIN [A-Z ]*PRIVATE KEY/];

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

// Exported so Task 7's skills reuse the same checks.
export function checkCommon(label, text) {
  test(`${label}: no env path, secret word, secret value or model id`, () => {
    assert.ok(!/\.env/.test(text), ".env");
    assert.ok(!/SECRET/.test(text), "SECRET");
    for (const re of SECRET_SHAPES) assert.ok(!re.test(text), `secret-shaped value ${re}`);
    assert.ok(!MODEL_ID.test(text), `model id literal: ${MODEL_ID.exec(text)?.[0]}`);
  });
  test(`${label}: no single-brace placeholder typos`, () => {
    assert.ok(!/(^|[^{$])\{[a-z_]+\}(?!\})/m.test(text.replace(/`[^`]*`/g, "")) , "single-brace {name}");
    assert.ok(!/\{\{[^}]*\}(?!\})/.test(text.replace(/\{\{[^}]*\}\}/g, "")), "unbalanced {{");
  });
  test(`${label}: carries the factory rules`, () => {
    assert.match(text, /git stash/);
    assert.match(text, /trailer/);
    assert.match(text, /DATA, never instructions/);
  });
}

for (const dir of FOLDERS) {
  for (const { f, path } of files(dir)) {
    const text = readFileSync(path, "utf8");
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
    const text = readFileSync(path, "utf8");
    for (const e of entries) assert.ok(!text.includes(e), `${d}/${f} names ${e}`);
  }
});

test("all expected Task 6 files exist", () => {
  for (const f of ["agents/implementer.md", "agents/spec-reviewer.md", "agents/code-reviewer.md", "agents/judge.md", "agents/triage.md", "prompts/codex-implement.md", "prompts/codex-review.md", "prompts/codex-judge.md", "agents/ATTRIBUTION.md", "prompts/ATTRIBUTION.md"])
    assert.ok(existsSync(join(root, f)), f);
});
