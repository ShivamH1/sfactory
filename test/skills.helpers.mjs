import test from "node:test";
import assert from "node:assert/strict";
import { commands, usages } from "../src/registry.mjs";

// Shared by test/skills.test.mjs and Task 7's skill tests; not a test file itself.
export const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);
export const MODEL_ID = /\bclaude-|\bgpt|gemini|fable|sonnet|opus|haiku|\bo[1-9]\b|codex-mini|codex-max/i;
export const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{8,}/, /\bghp_[A-Za-z0-9]{8,}/, /\bAKIA[0-9A-Z]{8,}/, /\bxox[abprs]-/, /-----BEGIN [A-Z ]*PRIVATE KEY/];

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

export function selfTest() {
  test("self-test: MODEL_ID and SECRET_SHAPES match their samples", () => {
    for (const s of ["gpt-5", "use o3 here", "claude-x", "gemini", "an Opus run", "codex-mini"]) assert.match(s, MODEL_ID, s);
    for (const s of ["no gpt-ish word? no", "protocol", "to3"]) if (s === "protocol" || s === "to3") assert.doesNotMatch(s, MODEL_ID, s);
    const samples = ["sk-abcdefgh1234", "ghp_abcdefgh1234", "AKIAABCDEFGH1234", "xoxb-1234", "-----BEGIN RSA PRIVATE KEY-----"];
    assert.equal(samples.length, SECRET_SHAPES.length);
    SECRET_SHAPES.forEach((re, i) => assert.match(samples[i], re, `shape ${i}`));
  });
}

/** The `sfactory …` command lines of a Markdown text: single-backtick spans, and lines inside fenced code that start with "sfactory ". */
export function commandLines(text) {
  const out = [];
  for (const m of text.matchAll(/(?<!`)`(sfactory [^`\n]+)`(?!`)/g)) out.push(m[1]);
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
      else if (/^\s*sfactory /.test(line)) out.push(line.trim());
    } else if (f) fence = f;
  }
  return out;
}

/** Problems of one command line against the CLI's own usage tables (src/commands/*, registered with each command). */
export function commandProblems(line) {
  const words = line.split(/\s+/);
  const verb = words[1];
  if (!commands.has(verb)) return [`unknown command "sfactory ${verb}"`];
  const u = usages.get(verb);
  if (!u) return [`"sfactory ${verb}" has no usage table`];
  const out = [];
  if (u.verbs && words[2] && /^[a-z]/.test(words[2]) && !u.verbs.includes(words[2])) out.push(`unknown "sfactory ${verb} ${words[2]}"`);
  for (const w of words) {
    if (w === "--") break; // the rest are paths (sfactory commit … -- <paths>)
    const f = /^--([a-z-]+)/.exec(w)?.[1];
    if (f && !u.flags.includes(f)) out.push(`"sfactory ${verb}" has no --${f}`);
  }
  return out;
}
