import test from "node:test";
import assert from "node:assert/strict";

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
