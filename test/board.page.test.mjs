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

test("page: fix round 1 behaviours are in the source", () => {
  assert.match(html, /function portsText/);
  assert.match(html, /k !== "block"/);
  assert.ok(html.includes("\b(?:Approved|Needs fixes|ok|red)\b"));
  assert.match(html, /hr >= 48/);
  assert.match(html, /#board\.has-cards \.col\.is-empty/);
  assert.match(html, /"tag you", "needs you"/);
  assert.match(html, /function required/);
  assert.equal(/#[0-9a-f]{3,8}/i.test(html.split("</style>")[0].split(/:root\[data-theme="light"\]/)[1].split("* {")[1]), false);
});
