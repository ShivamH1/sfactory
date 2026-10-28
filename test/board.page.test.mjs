import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERDICT, BAD } from "../src/board/snapshot.mjs";

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
  assert.match(html, /hr >= 48/);
  assert.match(html, /#board\.has-cards \.col\.is-empty/);
  assert.match(html, /"tag you", "needs you"/);
  assert.match(html, /function required/);
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(html.split("</style>")[0].split(/:root\[data-theme="light"\]/)[1].split("* {")[1]), false);
});

test("page: pulse keyframes with a reduced-motion static frame, danger token in every theme block, review chips", () => {
  assert.match(html, /@keyframes pulse/);
  assert.match(html, /prefers-reduced-motion: no-preference\)\s*\{\s*\.card\.active\s*\{\s*animation: pulse/);
  assert.match(html, /prefers-reduced-motion: reduce\)\s*\{\s*\.card\.active\s*\{\s*animation: none; box-shadow/);
  const css = html.split("</style>")[0];
  const darkDefault = css.split("@media (prefers-color-scheme: light)")[0];
  const lightMedia = css.split("@media (prefers-color-scheme: light)")[1].split(':root[data-theme="light"]')[0];
  const lightAttr = css.split(':root[data-theme="light"] {')[1].split("* {")[0];
  const darkAttr = css.split(':root[data-theme="dark"] {')[1].split("}")[0];
  for (const [name, block] of Object.entries({ darkDefault, lightMedia, lightAttr, darkAttr })) {
    assert.match(block, /--danger:/, name + " defines --danger");
    assert.match(block, /--pulse:/, name + " defines --pulse");
  }
  assert.match(html, /\.card\.stopped \{ border-color: var\(--danger\)/);
  assert.match(html, /\.tag\.danger \{ color: var\(--danger\)/);
  assert.match(html, /job\.stage === "stopped" \? "tag danger"/);
  assert.match(html, /openDrawer\(job\.id, r\.file\)/);
});

test("page: Approve is gated until every plan file has been displayed", () => {
  assert.match(html, /function unseenPlan/);
  assert.ok(html.includes('/^plan\\/[^/]+\\.md$/'));
  assert.match(html, /Open the plan files first/);
  assert.match(html, /setAttribute\("aria-disabled", "true"\)/);
  assert.match(html, /if \(b\.getAttribute\("aria-disabled"\) === "true"\) return;/);
  assert.match(html, /v\.updated !== job\.updated/);
  assert.match(html, /noteViewed\(id, rel, updatedAtStart\);/);
  assert.equal(/viewed\s*=.*(?:localStorage|sessionStorage)/.test(html), false);
});

test("page: the verdict and bad-colour rules are the server's, source and flags", () => {
  const v = /var VERDICT = \/(.*)\/(\w*);/.exec(html);
  const b = /\? "bad" : "ok"/.test(html) && /(\/\^\(\?:❌[^/]*\$\/)(\w*)\.test\(vm\[0\]\)/.exec(html);
  assert.ok(v && b, "both patterns found in the page");
  assert.equal(new RegExp(v[1], v[2]).source, VERDICT.source);
  assert.equal(v[2], VERDICT.flags);
  const pageBad = new RegExp(b[1].slice(1, -1), b[2]);
  assert.equal(pageBad.source, BAD.source);
  assert.equal(pageBad.flags, BAD.flags);
  assert.match(html, /aria-describedby/);
  assert.match(html, /job\.updated !== updated/);
});

test("page: the verdict regex matches whole words and colours them", () => {
  const m = /var VERDICT = \/(.*)\/(\w*);/.exec(html);
  assert.ok(m, "VERDICT found");
  assert.equal(/[\x00-\x08]/.test(m[1]), false, "no control bytes in the pattern");
  const re = new RegExp(m[1], m[2]);
  for (const s of ["Approved", "Needs fixes: two", "Status: ok", "red"]) assert.ok(re.exec(s), s);
  for (const s of ["covered", "Broken", "deferred"]) assert.equal(re.exec(s), null, s);
  const bad = (s) => /^(?:❌|needs fixes|red)$/i.test(re.exec(s)[0]);
  assert.equal(bad("✅ all covered"), false);
  assert.equal(bad("Needs fixes"), true);
});
