import test from "node:test";
import assert from "node:assert/strict";

// Shared by test/skills.test.mjs and Task 7's skill tests; not a test file itself.
export const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);
export const MODEL_ID = /claude-|gpt|gemini|fable|sonnet|opus|haiku|o[1-9]|codex-mini|codex-max/i;
export const SECRET_SHAPES = [/sk-[A-Za-z0-9_-]{8,}/, /ghp_[A-Za-z0-9]{8,}/, /AKIA[0-9A-Z]{8,}/, /xox[abprs]-/, /-----BEGIN [A-Z ]*PRIVATE KEY/];

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
