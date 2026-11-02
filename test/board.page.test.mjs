import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERDICT, BAD, BOARD_COLUMNS } from "../src/board/snapshot.mjs";

const read = (name) => readFileSync(new URL(`../board/${name}`, import.meta.url), "utf8");
const shell = read("dashboard.html");
const css = read("board.css");
const js = read("board.mjs");
const act = read("activity.mjs");
const html = `${shell}\n${css}\n${js}`; // the page as the browser assembles it

test("page: the shell links its stylesheet and module, and carries no style or inline script", () => {
  assert.match(shell, /<link rel="stylesheet" href="\/assets\/board\.css">/);
  assert.match(shell, /<script type="module" src="\/assets\/board\.mjs"><\/script>/);
  assert.equal(/<style/.test(shell), false);
  assert.equal((shell.match(/<script/g) ?? []).length, 1);
  assert.ok(shell.split("\n").length < 300);
});

test("page: structure, eleven columns, wiring", () => {
  assert.match(html, /id="board"/);
  assert.equal((shell.match(/<section class="col" data-column="/g) ?? []).length, 11);
  assert.ok(js.includes('fetch("/jobs.json"'));
  assert.ok(js.includes("X-Sfactory-Board"));
});

test("page: no lockToken, no external script, no inline handlers, no brand", () => {
  assert.equal(html.includes("lockToken"), false);
  assert.equal(/<script[^>]*\ssrc="(?!\/assets\/)/.test(shell), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(/thrive/i.test(html), false);
  assert.equal(js.includes("innerHTML"), false);
});

test("page: smoked glass is the default, porcelain the light theme, no OS switch", () => {
  assert.equal(/prefers-color-scheme/.test(css), false);
  for (const sel of [':root {', ':root[data-theme="dark"]', ':root[data-theme="light"]']) assert.ok(css.includes(sel), sel);
  const light = css.split(':root[data-theme="light"] {')[1].split("}")[0];
  for (const t of ["--bg:", "--panel:", "--card:", "--ink:", "--you:", "--live:", "--danger:", "--pulse:", "--focus:"]) assert.ok(light.includes(t), `light theme defines ${t}`);
  assert.match(css, /backdrop-filter: blur\(22px\)/);
  assert.match(css, /@supports not \(\(?backdrop-filter/);
  assert.match(css, /:focus-visible/);
  assert.match(shell, /Instrument\+Serif/);
  assert.match(js, /board-theme/);
});

test("page: fix round 1 behaviours are in the source", () => {
  assert.match(html, /function portsText/);
  assert.match(html, /k !== "block"/);
  assert.match(html, /hr >= 48/);
  assert.match(html, /#board\.has-cards \.col\.is-empty/);
  assert.match(html, /"tag you", "needs you"/);
  assert.match(html, /function required/);
});

test("page: pulse keyframes with a reduced-motion static frame, danger token in every theme block, review chips", () => {
  assert.match(html, /@keyframes pulse/);
  assert.match(html, /prefers-reduced-motion: no-preference\)\s*\{\s*\.card\.active\s*\{\s*animation: pulse/);
  assert.match(html, /prefers-reduced-motion: reduce\)\s*\{\s*\.card\.active\s*\{\s*animation: none; box-shadow/);
  const smoked = css.split(":root {")[1].split("}")[0];
  const porcelain = css.split(':root[data-theme="light"] {')[1].split("}")[0];
  for (const [name, block] of Object.entries({ smoked, porcelain })) {
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

test("page: a section per board column, the start gate and the number pill", () => {
  for (const col of BOARD_COLUMNS) assert.ok(html.includes(`data-column="${col}"`), col);
  assert.ok(html.indexOf('data-column="Milestones"') < html.indexOf('data-column="Backlog"'));
  assert.ok(html.indexOf('data-column="External running"') < html.indexOf('data-column="Done"'));
  assert.match(html, /"start"/);
  assert.match(html, /Starts on the next \/sfactory run/);
  assert.match(html, /"M" \+ job\.number/);
});

test("page: top bar, tabs, Done collapse and the running line", () => {
  assert.match(shell, /class="brand"[^>]*>sfactory</);
  assert.match(shell, /id="tabs"/);
  assert.match(shell, /id="activity"/);
  assert.match(js, /board-done-all/);
  assert.match(js, /Show all/);
  assert.match(js, /board-view/);
  assert.match(js, /\.running/);
  assert.match(js, /view=activity|"activity"/);
});

test("page: review fixes — no live region on the clock, legible secondary text, the fallback names both prefixes", () => {
  assert.equal(/id="conn"[^>]*role="status"/.test(shell), false, "#conn is not a live region");
  assert.match(shell, /id="locks"[^>]*role="group"|role="group"[^>]*id="locks"/);
  for (const sel of [".meta {", ".hint {", ".conn {"]) {
    const rule = css.split(sel)[1].split("}")[0];
    assert.match(rule, /color: var\(--ink-2\)/, `${sel} uses --ink-2`);
  }
  const light = css.split(':root[data-theme="light"] {')[1].split("}")[0];
  assert.match(light, /--ink-2: rgba\(31, ?30, ?27, ?\.68\)/);
  assert.match(css, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  assert.match(js, /b\.classList\.toggle\("on", on\); b\.setAttribute\("aria-pressed", on \? "true" : "false"\);/);
  assert.match(js, /b\.setAttribute\("aria-pressed", f === drawerFile \? "true" : "false"\)/);
  assert.match(js, /var sinceAt = Date\.parse\(l\.since\);\s*if \(!Number\.isNaN\(sinceAt\)\)/);
  assert.match(css, /\.cards \{ padding: 4px 8px 10px;/);
});

test("activity: the view mounts from the board and uses the pure modules", () => {
  assert.match(js, /from "\.\/activity\.mjs"/);
  assert.match(act, /export function mountActivity/);
  assert.match(act, /from "\.\/codex-render\.mjs"/);
  assert.match(act, /from "\.\/activity-state\.mjs"/);
  assert.match(act, /\/activity\.json/);
  assert.match(act, /\/tail\?path=/);
  assert.match(act, /foldTail\(/);
  assert.match(act, /document\.hidden/);
  assert.match(act, /Claude subagents report when they finish\./);
  assert.match(act, /Nothing running\./);
  assert.match(act, /Following/);
  assert.equal(act.includes("innerHTML"), false);
  assert.match(css, /@media \(max-width: 900px\)/);
});
