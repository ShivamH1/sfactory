import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERDICT, BAD, BOARD_COLUMNS } from "../src/board/snapshot.mjs";

const read = (name) => readFileSync(new URL(`../board/${name}`, import.meta.url), "utf8");
const shell = read("dashboard.html");
const css = read("board.css");
const js = read("board.mjs");
const act = read("activity.mjs");
const state = read("activity-state.mjs");
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
  assert.match(state, /hr >= 48/); // fmtElapsed now lives in activity-state.mjs, shared by both views
  assert.match(js, /import \{[^}]*fmtElapsed[^}]*\} from "\.\/activity-state\.mjs"/);
  assert.match(html, /#board\.has-cards \.col\.is-empty/);
  assert.match(html, /"tag you", "needs you"/);
  assert.match(html, /function required/);
});

test("page: no ring on an active card, only its sage border and the breathing dot (static under reduced motion); danger token in every theme block, review chips", () => {
  assert.equal(/@keyframes pulse/.test(css), false, "no pulse keyframes");
  for (const chunk of css.split("}")) { // "a { b { body" inside a media query: the selector is the piece before the body
    const parts = chunk.split("{");
    if (parts.length < 2) continue;
    const [sel, body] = parts.slice(-2);
    if (/\.card\.active\b/.test(sel)) assert.equal(/box-shadow|animation/.test(body), false, `no ring or animation on .card.active: ${chunk.trim()}`);
  }
  assert.match(css, /\.card\.run, \.card\.active \{ border-color: color-mix\(in srgb, var\(--live\) 40%, transparent\); \}/);
  assert.match(css, /prefers-reduced-motion: no-preference\)\s*\{\s*\.live i\s*\{\s*animation: breathe/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.live i\s*\{\s*animation: none; opacity: 1;/);
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

test("activity: review fixes — time-ordered timeline, shared helpers, unclipped focus rings, paced tails", () => {
  assert.match(act, /timelineGroups\(feed\.events, filter, now\)/);
  assert.equal(/\bdropped\b/.test(act), false, "rows are keyed by seq, not by a count of dropped events");
  for (const name of ["function fmtElapsed", "function elapsed(", "function dayLabel", "function reviewFor", "function reportPath", "function vendorName", "const vendorName ="]) {
    assert.equal(act.includes(name) || js.includes(name), false, `${name} is not duplicated in the views`);
  }
  assert.match(js, /import \{[^}]*taskLabel[^}]*\} from "\.\/activity-state\.mjs"/);
  assert.match(css, /\.act-out:focus-visible \{ outline-offset: -2px; \}/);
  assert.match(css, /\.act-running \{[^}]*padding: 4px; margin: -4px;/);
  assert.match(act, /function tailEvery/);
  assert.match(act, /startNearEnd\(body\.size, KEEP_LOG_BYTES\)/);
  assert.match(act, /createTextNode\(text\.slice\(plainLen\)\)/);
});

/** Every CSS rule as [selector, body], media-query rules included (the selector is the piece just before the body); comments are dropped first, so one above a rule is not read as part of its selector. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((chunk) => chunk.split("{")).filter((p) => p.length >= 2).map((p) => [p[p.length - 2].trim(), p[p.length - 1].trim()]);
const ruleFor = (sel) => rules.filter(([s]) => s === sel).map(([, b]) => b).join(" ");

test("page: the Milestones column is ordered by number (29.1 between 29 and 30), unnumbered after, by id as the fallback", () => {
  assert.match(js, /import \{[^}]*byMilestoneNumber[^}]*\} from "\.\/activity-state\.mjs"/);
  assert.match(js, /if \(name === "Milestones"\) milestones\.push\(job\);/);
  assert.match(js, /function renderMilestones\(list\) \{[^}]*list\.slice\(\)\.sort\(byMilestoneNumber\)/);
  assert.match(js, /renderMilestones\(milestones\);/);
  assert.match(js, /cols\["Milestones"\]\.querySelector\("\.cards"\)/);
});

test("page: champagne means only that the person is needed (a running command, the suite tile and a held lock are not)", () => {
  assert.match(act, /b\.status === "running" \? \["running", "live"\]/);
  assert.match(ruleFor(".act-live"), /color: var\(--live\)/);
  assert.equal(act.includes('"you on"'), false, "the suite's dot is the live dot");
  assert.equal(/\.act-tile\.suite/.test(css), false, "the suite tile has no tint of its own: it takes the live one");
  assert.match(ruleFor('.act-tile[aria-pressed="true"]'), /var\(--live\)/);
  assert.match(ruleFor(".locks i.held"), /background: var\(--ink-2\)/);
  assert.match(ruleFor(".locks .held-by"), /color: var\(--ink\)/);
  assert.match(js, /held \? name \+ " · " \+ \(l\.holder \|\| "held"\)/);
  const NEEDS_YOU = ['.col[data-column="Needs you"] h2', ".card.needs", ".card.ext", ".tag.you", ".tag.ext", ".btn.go"];
  for (const [sel, body] of rules) {
    if (!/var\(--you\)/.test(body) || sel.startsWith(":root")) continue;
    assert.ok(NEEDS_YOU.includes(sel), `${sel} uses --you, but only what needs the person may: ${NEEDS_YOU.join(", ")}`);
  }
  for (const sel of NEEDS_YOU) assert.match(ruleFor(sel), /var\(--you\)/, `${sel} keeps --you`);
  assert.match(ruleFor("#demo"), /color: var\(--ink-2\)/, "the demo banner is a passive status");
  assert.match(ruleFor("#demo"), /border: 1px solid var\(--panel-line\)/);
});

test("page: cheap fixes: footer labels legible, the running line's time in mono, tiles that do not re-announce each second", () => {
  assert.match(ruleFor("footer .k"), /color: var\(--ink-2\)/);
  assert.match(ruleFor(".col h2 .n"), /color: var\(--ink-3\)/);
  assert.match(ruleFor(".empty"), /color: var\(--ink-3\)/);
  assert.match(ruleFor(".live .el"), /font-family: var\(--mono\)/);
  assert.match(ruleFor(".live .el"), /font-variant-numeric: tabular-nums/);
  // the separator lives in the span, glued to the last word by a no-break space: "· 10m" never wraps onto its own line
  assert.match(ruleFor(".live .el"), /white-space: nowrap/);
  assert.match(js, /sp\.textContent = parts\.join\(" · "\);\s*if \(el\) sp\.appendChild\(h\("span", "el", NBSP \+ "· " \+ el\)\);/);
  assert.match(js, /var NBSP = String\.fromCharCode\(160\);/);
  assert.match(act, /b\.setAttribute\("aria-label", \[pillOf\(t\.id\), name, whoOf\(t\)\]\.filter\(has\)\.join\(" · "\)\)/);
  assert.match(act, /const meta = h\("span", "act-meta"\);\s*meta\.setAttribute\("aria-hidden", "true"\);/);
});

test("chat: the composer mounts on both views and talks to the chat routes", () => {
  const chat = read("chat.mjs");
  assert.match(js, /from "\.\/chat\.mjs"/);
  assert.match(chat, /export function mountChat/);
  assert.match(chat, /\/chat\.json/);
  assert.match(chat, /"\/chat"/);
  assert.match(chat, /X-Sfactory-Board/);
  assert.match(chat, /Channel running/);
  assert.match(chat, /Read at the factory's next step/);
  assert.match(chat, /handed to the session/);
  assert.match(chat, /document\.hidden/);
  assert.match(chat, /Messages are off in the demo/);
  assert.equal(chat.includes("innerHTML"), false);
  assert.match(shell, /id="chat"/);
});
