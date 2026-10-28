import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../board/dashboard.html", import.meta.url), "utf8");

test("page: structure, nine columns, wiring", () => {
  assert.match(html, /id="board"/);
  assert.equal((html.match(/<section class="col" data-column="/g) ?? []).length, 9);
  assert.ok(html.includes('fetch("/jobs.json"'));
  assert.ok(html.includes("X-Sfactory-Board"));
  assert.equal((html.match(/<script/g) ?? []).length, 1);
});

test("page: no lockToken, no external script, no inline handlers, no brand", () => {
  assert.equal(html.includes("lockToken"), false);
  assert.equal(/<script[^>]*\ssrc=/.test(html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(/thrive/i.test(html), false);
  assert.equal(html.includes("innerHTML"), false);
  assert.ok(html.split("\n").length < 900);
});

test("page: both light theme blocks", () => {
  assert.match(html, /prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)/);
  assert.match(html, /:root\[data-theme="light"\]/);
});
