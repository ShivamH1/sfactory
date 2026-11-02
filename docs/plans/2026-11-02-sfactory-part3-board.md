# sfactory Part 3 — the glass board and the Activity view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board looks finished — smoked glass by default, porcelain glass as the light theme — with the new columns' cards, a collapsed Done column, and an Activity view (running agents, a timeline across every card, and the selected agent's live output, rendered from Codex's stream).

**Architecture:** The page splits into a small HTML shell and local files the board serves itself under `/assets/` (no CDN, no build step): `board.css`, `board.mjs` (the board view, today's script moved and extended), `activity.mjs` (the Activity view), and two pure modules the browser and the test suite both import — `codex-render.mjs` (a Codex `--json` stream to display blocks) and `activity-state.mjs` (folding feed and tail answers, one sentence per event). The snapshot gains `running` so both views read the agents running now from one poll.

**Tech Stack:** Node ≥ 20, ESM, plain browser ES modules (no framework, no bundler), `node:test`, zero runtime dependencies.

**Spec:** `docs/plans/2026-10-30-sfactory-roadmap-activity-design.md` §6 (look, board, Activity view, accessibility) and §10 part 3. **Design source:** the approved mockups in the brainstorming folder on this machine, `.superpowers/brainstorm/1707-1793356718/content/board-style.html` (both themes, the board) and `activity-view.html` (layout A, the split, which the owner chose). They are local, git-ignored files: read them for layout, spacing and treatment; their card titles are sample data and never enter the repo.

**Branch:** `feat/board-redesign`, cut from `feat/events` (Part 2, pushed); its pull request targets `feat/events` until that merges.

**Where this plan departs from the spec, on purpose:**
- Codex's `file_change` events carry a path and a kind (`add`, `update`, `delete`) and no line counts, so the output pane shows each changed path with its kind, not "+64 −2".
- The page becomes a shell plus files served from `/assets/<name>` (a fixed allow-list): one inline script and a page under 900 lines (today's page tests) cannot hold the Activity view and a renderer that the suite also tests.
- Smoked glass is the default whatever the OS prefers (spec §6.1), so the `prefers-color-scheme: light` block goes; the page tests that pinned it are rewritten for the two `data-theme` themes.
- The snapshot (`/jobs.json`) carries `running`, so the board's in-process cards and the Activity view's tiles come from one poll; in demo mode the running rule judges "now" by the demo's latest moment, as the snapshot already does.

## Global Constraints

- Node 20 or later; `"dependencies": {}` stays empty. No framework, no bundler, no CDN script; browser code is plain ES modules served by the board. Fonts may come from Google Fonts (the page already loads IBM Plex from there).
- The plugin is generic: no company, product, person or machine-specific word in any file (`test/docs.test.mjs` refuses some). The mockups' sample card titles never enter the repo.
- The board stays bound to 127.0.0.1 with its Host check; every POST still carries `X-Sfactory-Board: 1`; the page never uses `innerHTML` (all text through `textContent`); no inline event handlers.
- Look (spec §6.1): one accent per meaning, never decorative — champagne/ochre for anything that needs the person, sage/forest for live work, muted rose for failures; no emoji, no gradients on text or buttons, no glow on cards (live work is a breathing dot, a static dot under reduced motion); hairlines instead of shadows for structure; radii 14 px panels, 11 px cards, 6 px pills; 8 px spacing grid; Instrument Serif for the wordmark only, IBM Plex Sans for UI, IBM Plex Mono with `tabular-nums` for ids, numbers, branches, times and logs; `backdrop-filter` falls back to an opaque panel colour.
- Accessibility (spec §6.5): every control reachable by keyboard with a visible focus ring; colour never the only signal (verdicts carry ✓ or ✕ and words); the Activity split stacks below 900 px (tiles, output, timeline); the board keeps its horizontal scroll.
- `localStorage` only for per-viewer conveniences (theme, Done expanded, last view), every read and write in try/catch, the page correct without it.
- Make every source and test edit with the Edit or Write tool, never a heredoc, sed or script rewrite (on earlier parts those dropped regex backslashes and ate spaces after operators).
- Never `git stash`; stage named paths only; commits carry no trailers.
- The full suite (`node --test`) is green at the end of every task; `test/services.test.mjs` and `test/suite.test.mjs` hold load-sensitive timing tests (rerun alone before blaming a change).

## Theme tokens

Both themes define the same names (components use only these):

| Token | Smoked glass (default, `:root` and `:root[data-theme="dark"]`) | Porcelain glass (`:root[data-theme="light"]`) |
|---|---|---|
| `--bg` | `#0c0e11` | `#efece6` |
| `--glow-a` / `--glow-b` | `rgba(70,120,118,.30)` / `rgba(168,126,72,.20)` | `rgba(150,182,205,.55)` / `rgba(222,196,160,.55)` |
| `--panel` / `--panel-line` / `--panel-hi` | `rgba(255,255,255,.035)` / `rgba(255,255,255,.07)` / `rgba(255,255,255,.05)` | `rgba(255,255,255,.42)` / `rgba(255,255,255,.75)` / `rgba(255,255,255,.6)` |
| `--panel-solid` (no backdrop-filter) | `#15181c` | `#f7f5f1` |
| `--card` / `--card-line` | `rgba(255,255,255,.055)` / `rgba(255,255,255,.08)` | `rgba(255,255,255,.78)` / `rgba(31,30,27,.07)` |
| `--pill` | `rgba(255,255,255,.08)` | `#1f1e1b` (with `--pill-ink: #f6f3ed`; smoked `--pill-ink: #efe9dc`) |
| `--ink` / `--ink-2` / `--ink-3` | `#e9e6df` / `rgba(233,230,223,.62)` / `rgba(233,230,223,.42)` | `#1f1e1b` / `rgba(31,30,27,.58)` / `rgba(31,30,27,.42)` |
| `--you` (needs the person) | `#dcbf86` | `#8a5a17` |
| `--live` | `#8fc9a8` | `#2f6b4f` |
| `--danger` | `#d88a80` | `#b4493f` |
| `--pulse` | `rgba(143,201,168,.45)` | `rgba(47,107,79,.35)` |
| `--focus` | `#dcbf86` | `#2f4a6d` |

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/board/server.mjs` | routes | `GET /assets/<name>` from an allow-list; demo "now" for activity |
| `src/board/snapshot.mjs` | the snapshot | `running` (demo-aware now) |
| `board/dashboard.html` | the page shell | markup only: top bar, tabs, board columns, activity view, drawer; one `<link>` and one module `<script src>` |
| `board/board.css` (new) | every style | themes, board, activity, drawer |
| `board/board.mjs` (new) | the board view | today's script, moved; then the redesign |
| `board/activity.mjs` (new) | the Activity view | tiles, timeline, output pane, polling |
| `board/codex-render.mjs` (new) | a Codex stream to display blocks | pure |
| `board/activity-state.mjs` (new) | feed and tail folding, event sentences, filters | pure |
| `test/board.page.test.mjs` | page source tests | read the shell and the assets |
| `test/board.render.test.mjs` (new), `test/board.state.test.mjs` (new), `test/fixtures/codex-stream.jsonl` (new) | tests | renderer and state |
| `examples/jobs/generate.mjs`, `examples/jobs/*` | demo cards | a running card with events and a stream |
| `README.md`, `docs/DESIGN.md`, `package.json`, `.claude-plugin/plugin.json` | docs, version | 0.5.0 |

---

### Task 1: The board serves its own assets; the page splits without changing

**Depends on:** none

**Files:**
- Modify: `src/board/server.mjs`
- Modify: `board/dashboard.html`
- Create: `board/board.css`, `board/board.mjs`
- Modify: `test/board.page.test.mjs`, `test/board.server.test.mjs`

**Interfaces:**
- Produces: `ASSETS` (exported from `src/board/server.mjs`): `{ "board.css": "text/css; charset=utf-8", "board.mjs": "text/javascript; charset=utf-8", "activity.mjs": ..., "codex-render.mjs": ..., "activity-state.mjs": ... }` (all `text/javascript; charset=utf-8` but the CSS); `GET /assets/<name>` answers the file from `board/` read once at `startBoard`, `Cache-Control: no-store`, 404 `NOT_FOUND` for any other name (including `..` or a nested path); a listed file missing on disk answers 404 too. `board/dashboard.html` keeps all its markup, loses its `<style>` and inline `<script>`, and gains `<link rel="stylesheet" href="/assets/board.css">` and `<script type="module" src="/assets/board.mjs"></script>`; `board.css` is the old `<style>` body, `board.mjs` the old script body. **No visual or behaviour change in this task.**

- [ ] **Step 1: Write the failing tests**

Append to `test/board.server.test.mjs`:

```js
test("server: GET /assets/<name> serves the allow-listed board files, nothing else", async () => {
  const c = mk();
  await withBoard(c, {}, async (b) => {
    const css = await fetch(`${b.url}assets/board.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /^text\/css/);
    assert.equal(css.headers.get("cache-control"), "no-store");
    const js = await fetch(`${b.url}assets/board.mjs`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /^text\/javascript/);
    for (const p of ["assets/dashboard.html", "assets/..%2Fpackage.json", "assets/x/board.css", "assets/"]) assert.equal((await fetch(`${b.url}${p}`)).status, 404, p);
  });
});
```

In `test/board.page.test.mjs`, replace the file's top so its tests read the shell and the assets together:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERDICT, BAD, BOARD_COLUMNS } from "../src/board/snapshot.mjs";

const read = (name) => readFileSync(new URL(`../board/${name}`, import.meta.url), "utf8");
const shell = read("dashboard.html");
const css = read("board.css");
const js = read("board.mjs");
const html = `${shell}\n${css}\n${js}`; // the page as the browser assembles it

test("page: the shell links its stylesheet and module, and carries no style or inline script", () => {
  assert.match(shell, /<link rel="stylesheet" href="\/assets\/board\.css">/);
  assert.match(shell, /<script type="module" src="\/assets\/board\.mjs"><\/script>/);
  assert.equal(/<style/.test(shell), false);
  assert.equal((shell.match(/<script/g) ?? []).length, 1);
  assert.ok(shell.split("\n").length < 300);
});
```

and update the existing tests:
- "page: structure, eleven columns, wiring": keep the column count on `shell`; check `fetch("/jobs.json"` and `X-Sfactory-Board` in `js`; drop the `<script` count (the new test covers it).
- "page: no lockToken, no external script, no inline handlers, no brand": run the same checks on `html`, except the external-script check, which becomes `assert.equal(/<script[^>]*\ssrc="(?!\/assets\/)/.test(shell), false)` (only local module scripts); keep `innerHTML` absent from `js`; drop the 900-line check (the shell check covers size).
- every other test that reads `html` keeps reading `html` (now the assembled page) — the CSS rules and script functions they pin are unchanged by this task.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/board.server.test.mjs test/board.page.test.mjs` — Expected: FAIL (no assets route; `board.css`/`board.mjs` do not exist).

- [ ] **Step 3: Implement**

1. Create `board/board.css` with the exact contents of the current `<style>` element in `board/dashboard.html` (without the `<style>` tags), and `board/board.mjs` with the exact contents of the current inline `<script>` (without the tags). The script is an IIFE today; in a module it runs the same way (modules are deferred and strict — check it has no sloppy-mode-only code; it uses `var` and functions, which are fine).
2. In `board/dashboard.html`, delete the `<style>…</style>` element and put `<link rel="stylesheet" href="/assets/board.css">` after the font links; replace the `<script>…</script>` element with `<script type="module" src="/assets/board.mjs"></script>`.
3. In `src/board/server.mjs`, add:

```js
/** The board's own files, served from board/ under /assets/<name>; nothing outside this list. */
export const ASSETS = {
  "board.css": "text/css; charset=utf-8",
  "board.mjs": "text/javascript; charset=utf-8",
  "activity.mjs": "text/javascript; charset=utf-8",
  "codex-render.mjs": "text/javascript; charset=utf-8",
  "activity-state.mjs": "text/javascript; charset=utf-8",
};
function loadAssets() {
  const out = {};
  for (const name of Object.keys(ASSETS)) {
    try { out[name] = readFileSync(new URL(`../../board/${name}`, import.meta.url), "utf8"); } catch { /* not built yet: 404 */ }
  }
  return out;
}
```

   In `startBoard`, next to `const page = loadPage();`, add `const assets = loadAssets();`, and before the `/jobs.json` route:

```js
      if (req.method === "GET" && parts.length === 2 && parts[0] === "assets") {
        const name = parts[1];
        if (!Object.hasOwn(ASSETS, name) || assets[name] === undefined) return sendJson(res, 404, { code: "NOT_FOUND" });
        return send(res, 200, assets[name], ASSETS[name]);
      }
```

   (`send` already sets `Cache-Control: no-store`. `parts` is the decoded path split on `/`, so `..%2F` decodes to a name that is not in the list.)

- [ ] **Step 4: Run the touched tests, then the full suite**

Run: `node --test test/board.server.test.mjs test/board.page.test.mjs test/board.command.test.mjs` — Expected: PASS. Then `node --test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/board/server.mjs board/dashboard.html board/board.css board/board.mjs test/board.page.test.mjs test/board.server.test.mjs
git commit -m "refactor(board): the page is a shell plus its own assets, served from /assets"
```

---

### Task 2: The Codex stream renderer

**Depends on:** Task 1

**Files:**
- Create: `board/codex-render.mjs`
- Create: `test/fixtures/codex-stream.jsonl`
- Create: `test/board.render.test.mjs`

**Interfaces:**
- Produces: `renderCodexStream(text) → blocks[]`, each block one of `{ kind: "message", text }`, `{ kind: "reasoning", text }`, `{ kind: "command", command, output, exit, status }` (`status` `"running" | "completed" | "failed"`, `exit` a number or null), `{ kind: "files", changes: [{ path, change }], status }`, `{ kind: "usage", input, cached, output }`, `{ kind: "raw", text }`; an item's `started`/`updated`/`completed` events merge into one block by the item's `id`, in the order the item first appeared; `thread.started` and `turn.started` produce nothing; a line that is not JSON, or an event or item type the renderer does not know, becomes a `raw` block (never dropped). `splitOutput(text, max = 12) → { shown, hidden }` (the first `max` lines, and how many more).

- [ ] **Step 1: Write the fixture and the failing tests**

Create `test/fixtures/codex-stream.jsonl` — a generic stream, hand-written in the shape a real `codex exec --json` run writes (no real project, path or person):

```text
Reading prompt from stdin...
{"type":"thread.started","thread_id":"0000-demo"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Reading the task brief and the existing search module first."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"rg -n \"searchIndex\" src","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"rg -n \"searchIndex\" src","aggregated_output":"src/search/index.mjs:12:export function searchIndex(items) {\nsrc/search/query.mjs:4:import { searchIndex } from \"./index.mjs\";\n","exit_code":0,"status":"completed"}}
2026-01-05T10:00:00.000000Z ERROR codex_core: a transient warning line the CLI printed
{"type":"item.started","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/search/saved.mjs","kind":"add"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/search/saved.mjs","kind":"add"},{"path":"src/search/index.mjs","kind":"update"}],"status":"completed"}}
{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"npm test -- saved","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"npm test -- saved","aggregated_output":"1 failing\n","exit_code":1,"status":"failed"}}
{"type":"item.completed","item":{"id":"item_4","type":"todo_list","items":[]}}
{"type":"turn.completed","usage":{"input_tokens":12000,"cached_input_tokens":8000,"output_tokens":900}}
```

Create `test/board.render.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderCodexStream, splitOutput } from "../board/codex-render.mjs";

const stream = readFileSync(new URL("./fixtures/codex-stream.jsonl", import.meta.url), "utf8");

test("render: every line becomes a block or is a known no-op; items merge by id", () => {
  const b = renderCodexStream(stream);
  assert.deepEqual(b.map((x) => x.kind), ["raw", "message", "command", "raw", "files", "command", "raw", "usage"]);
  assert.equal(b[0].text, "Reading prompt from stdin...");
  assert.equal(b[1].text, "Reading the task brief and the existing search module first.");
  assert.deepEqual(b[2], { kind: "command", command: 'rg -n "searchIndex" src', output: 'src/search/index.mjs:12:export function searchIndex(items) {\nsrc/search/query.mjs:4:import { searchIndex } from "./index.mjs";\n', exit: 0, status: "completed" });
  assert.deepEqual(b[4], { kind: "files", changes: [{ path: "src/search/saved.mjs", change: "add" }, { path: "src/search/index.mjs", change: "update" }], status: "completed" });
  assert.equal(b[5].status, "failed"); assert.equal(b[5].exit, 1);
  assert.match(b[6].text, /"todo_list"/); // an item type it does not know stays visible
  assert.deepEqual(b[7], { kind: "usage", input: 12000, cached: 8000, output: 900 });
});

test("render: a command still in progress is running with no exit", () => {
  const b = renderCodexStream('{"type":"item.started","item":{"id":"a","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}\n');
  assert.deepEqual(b, [{ kind: "command", command: "ls", output: "", exit: null, status: "running" }]);
});

test("render: blank lines, CRLF, a partial last line and non-object JSON", () => {
  const b = renderCodexStream('\r\n{"type":"turn.started"}\r\n42\r\n{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"hi"}}\r\n{"type":"item.comp');
  assert.deepEqual(b.map((x) => [x.kind, x.text]), [["raw", "42"], ["message", "hi"], ["raw", '{"type":"item.comp']]);
});

test("render: splitOutput collapses after max lines", () => {
  const text = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
  const s = splitOutput(text, 12);
  assert.equal(s.shown.split("\n").length, 12); assert.equal(s.hidden, 3);
  assert.deepEqual(splitOutput("a\nb", 12), { shown: "a\nb", hidden: 0 });
  assert.deepEqual(splitOutput("a\nb\n", 12), { shown: "a\nb", hidden: 0 });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/board.render.test.mjs` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `board/codex-render.mjs`:

```js
/**
 * A Codex `exec --json` stream as display blocks, for the board's live output pane. Pure: text in, blocks out, so
 * the browser and the test suite run the same code. An item's started/updated/completed events merge into one
 * block by its id; anything the renderer does not know is kept as a raw line, never dropped.
 */
export function renderCodexStream(text) {
  const blocks = [];
  const byId = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { blocks.push({ kind: "raw", text: line }); continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) { blocks.push({ kind: "raw", text: line }); continue; }
    if (e.type === "thread.started" || e.type === "turn.started") continue;
    if (e.type === "turn.completed" && e.usage && typeof e.usage === "object") {
      blocks.push({ kind: "usage", input: num(e.usage.input_tokens), cached: num(e.usage.cached_input_tokens), output: num(e.usage.output_tokens) });
      continue;
    }
    if ((e.type === "item.started" || e.type === "item.updated" || e.type === "item.completed") && e.item && typeof e.item === "object") {
      const b = blockOf(e.item);
      if (!b) { blocks.push({ kind: "raw", text: line }); continue; }
      const id = e.item.id;
      if (id !== undefined && byId.has(id)) Object.assign(byId.get(id), b);
      else { blocks.push(b); if (id !== undefined) byId.set(id, b); }
      continue;
    }
    blocks.push({ kind: "raw", text: line });
  }
  return blocks;
}

const num = (v) => (Number.isFinite(v) ? v : null);

function blockOf(it) {
  if (it.type === "agent_message") return { kind: "message", text: String(it.text ?? "") };
  if (it.type === "reasoning") return { kind: "reasoning", text: String(it.text ?? "") };
  if (it.type === "command_execution") {
    const status = it.status === "completed" || it.status === "failed" ? it.status : "running";
    return { kind: "command", command: String(it.command ?? ""), output: String(it.aggregated_output ?? ""), exit: Number.isInteger(it.exit_code) ? it.exit_code : null, status };
  }
  if (it.type === "file_change") {
    const changes = (Array.isArray(it.changes) ? it.changes : []).map((ch) => ({ path: String(ch?.path ?? ""), change: String(ch?.kind ?? "update") }));
    return { kind: "files", changes, status: typeof it.status === "string" ? it.status : null };
  }
  return null;
}

/** The first `max` lines of a command's output, and how many lines are hidden after them (a trailing newline is not a line). */
export function splitOutput(text, max = 12) {
  const lines = String(text ?? "").replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") return { shown: "", hidden: 0 };
  return { shown: lines.slice(0, max).join("\n"), hidden: Math.max(0, lines.length - max) };
}
```

*Dated 2026-11-02 (review fix, under the owner's standing OK for robustness fixes):* every string field goes through a safe `str(v)` (`typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)`, falling back to `""` if that throws), so a crafted value never throws and blanks the pane; items merge by id only when the id is a string and the kinds match, and `thread.started` clears the id map (a log may hold more than one run); a files block's `status` is normalised like a command's (`running`, `completed`, `failed`). Tests cover an object without `toString`, a reused id across two runs, `item: null`, `changes` not an array and string usage fields.

- [ ] **Step 4: Run the test, then the full suite** — `node --test test/board.render.test.mjs`, then `node --test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add board/codex-render.mjs test/fixtures/codex-stream.jsonl test/board.render.test.mjs
git commit -m "feat(board): render a Codex stream as messages, commands, file changes and raw lines"
```

---

### Task 3: Feed and tail state, and one sentence per event

**Depends on:** Task 1

**Files:**
- Create: `board/activity-state.mjs`
- Create: `test/board.state.test.mjs`

**Interfaces:**
- Produces: `KEEP_EVENTS = 500`; `foldActivity(state, answer) → { events, cursor, running }` (appends `answer.events`, keeps the newest `KEEP_EVENTS`, replaces `cursor` and `running`); `foldTail(view, asked, answer) → { text, next, size }` (appends when `answer.from === asked`, replaces otherwise); `describe(event) → { title, sub, tone }` (`tone` is `"live" | "ok" | "bad" | "you" | null`); `GROUPS = { Agents: ["agent"], Gates: ["gate"], Suite: ["suite"], Stages: ["stage"] }`; `matches(event, { card, group }) → boolean` (`card` null for all cards, `group` null for all kinds).

- [ ] **Step 1: Write the failing tests**

Create `test/board.state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { KEEP_EVENTS, foldActivity, foldTail, describe, matches } from "../board/activity-state.mjs";

const ev = (i) => ({ id: "m-1", at: `2026-01-05T10:00:${String(i % 60).padStart(2, "0")}.000Z`, kind: "note", text: `n${i}` });

test("state: foldActivity appends, keeps the newest, replaces cursor and running", () => {
  let s = foldActivity(null, { events: [ev(1), ev(2)], cursor: "c1", running: [{ id: "m-1" }] });
  assert.deepEqual(s.events.map((e) => e.text), ["n1", "n2"]); assert.equal(s.cursor, "c1"); assert.equal(s.running.length, 1);
  s = foldActivity(s, { events: [ev(3)], cursor: "c2", running: [] });
  assert.deepEqual(s.events.map((e) => e.text), ["n1", "n2", "n3"]); assert.equal(s.cursor, "c2"); assert.deepEqual(s.running, []);
  s = foldActivity(s, { events: Array.from({ length: KEEP_EVENTS }, (_, i) => ev(i + 10)), cursor: "c3", running: [] });
  assert.equal(s.events.length, KEEP_EVENTS); assert.equal(s.events[0].text, "n10");
});

test("state: foldTail appends when the server read from where we asked, replaces when it restarted", () => {
  let v = foldTail(null, 0, { text: "one\n", from: 0, next: 4, size: 4 });
  v = foldTail(v, 4, { text: "two\n", from: 4, next: 8, size: 8 });
  assert.deepEqual(v, { text: "one\ntwo\n", next: 8, size: 8 });
  v = foldTail(v, 8, { text: "new\n", from: 0, next: 4, size: 4 });
  assert.deepEqual(v, { text: "new\n", next: 4, size: 4 });
});

test("state: describe gives one sentence per kind", () => {
  const d = (e) => { const r = describe(e); return `${r.title}${r.sub ? ` | ${r.sub}` : ""}${r.tone ? ` | ${r.tone}` : ""}`; };
  assert.equal(d({ kind: "stage", from: null, to: "backlog", reason: "created" }), "Created in backlog | created");
  assert.equal(d({ kind: "stage", from: "building", to: "reviewing", reason: "tasks done" }), "Moved to reviewing | from building · tasks done");
  assert.equal(d({ kind: "gate", action: "approve", by: "board" }), "Approved | by board | you");
  assert.equal(d({ kind: "gate", action: "parallel", yes: false, by: "session" }), "Queued instead of running in parallel | by session | you");
  assert.equal(d({ kind: "agent", phase: "start", vendor: "codex", role: "implementer", task: "3", model: "implement" }), "Codex implementer started on task 3 | implement | live");
  assert.equal(d({ kind: "agent", phase: "finish", vendor: "claude", role: "spec-reviewer", task: "2", model: "opus", verdict: "ok" }), "Claude spec-reviewer finished on task 2: ✓ Approved | opus | ok");
  assert.equal(d({ kind: "agent", phase: "finish", vendor: "codex", role: "reviewer", ok: false }), "Codex reviewer failed | bad");
  assert.equal(d({ kind: "suite", phase: "finish", ok: true, exit: 0, durationMs: 161000, log: "verify/suite.log" }), "Suite passed in 2m 41s | verify/suite.log | ok");
  assert.equal(d({ kind: "suite", phase: "finish", ok: false, exit: 1, durationMs: 4000 }), "Suite failed (exit 1) in 4s | bad");
  assert.equal(d({ kind: "service", phase: "up", name: "api", port: 4100 }), "Service api up on :4100");
  assert.equal(d({ kind: "lock", phase: "take", name: "suite" }), "Took the suite lock");
  assert.equal(d({ kind: "commit", sha: "a41c9e2f00", files: 3 }), "Committed a41c9e2 | 3 files");
  assert.equal(d({ kind: "note", text: "reading the brief" }), "reading the brief");
  assert.equal(d({ kind: "mystery" }), "mystery");
});

test("state: matches filters by card and by group", () => {
  const e = { id: "m-1", kind: "agent" };
  assert.equal(matches(e, { card: null, group: null }), true);
  assert.equal(matches(e, { card: "m-1", group: "Agents" }), true);
  assert.equal(matches(e, { card: "m-2", group: null }), false);
  assert.equal(matches(e, { card: null, group: "Gates" }), false);
});
```

- [ ] **Step 2: Run it to see it fail** — `node --test test/board.state.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

Create `board/activity-state.mjs`:

```js
/** The Activity view's state, kept pure so the browser and the test suite run the same code. */
export const KEEP_EVENTS = 500;

/** One /activity.json answer folded in: events appended (the newest KEEP_EVENTS kept), cursor and running replaced. */
export function foldActivity(state, answer) {
  const events = [...(state?.events ?? []), ...(Array.isArray(answer?.events) ? answer.events : [])];
  return { events: events.slice(-KEEP_EVENTS), cursor: answer?.cursor ?? state?.cursor ?? null, running: Array.isArray(answer?.running) ? answer.running : [] };
}

/** One tail answer folded into a log view: appended when the server read from where we asked, replaced when it restarted (the file was replaced). */
export function foldTail(view, asked, answer) {
  const base = answer.from === asked ? (view?.text ?? "") : "";
  return { text: base + String(answer.text ?? ""), next: answer.next, size: answer.size };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const dur = (ms) => {
  if (!Number.isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const GATE = {
  approve: "Approved", "request-changes": "Changes requested", answer: "Answered", merged: "Marked merged",
  rework: "Sent back to building", start: "Started", external: "Marked as running outside the factory",
};

/** One timeline row's words: a title, a quiet second line, and a tone (live, ok, bad, you, or none). */
export function describe(e) {
  switch (e?.kind) {
    case "stage":
      return e.from == null
        ? { title: `Created in ${e.to}`, sub: e.reason ?? null, tone: null }
        : { title: `Moved to ${e.to}`, sub: [`from ${e.from}`, e.reason].filter(Boolean).join(" · "), tone: null };
    case "gate": {
      const title = e.action === "parallel" ? (e.yes ? "Approved to run in parallel" : "Queued instead of running in parallel") : (GATE[e.action] ?? cap(String(e.action)));
      return { title, sub: e.by ? `by ${e.by}` : null, tone: "you" };
    }
    case "agent": {
      const who = `${cap(e.vendor)} ${e.role}`;
      const on = e.task ? ` on task ${e.task}` : "";
      if (e.phase === "start") return { title: `${who} started${on}`, sub: e.model ?? null, tone: "live" };
      if (e.ok === false) return { title: `${who} failed${on}`, sub: e.model ?? null, tone: "bad" };
      const verdict = e.verdict === "ok" ? ": ✓ Approved" : e.verdict === "fixes" ? ": ✕ Needs fixes" : "";
      return { title: `${who} finished${on}${verdict}`, sub: e.model ?? null, tone: e.verdict === "fixes" ? "bad" : e.verdict === "ok" ? "ok" : null };
    }
    case "suite": {
      if (e.phase === "start") return { title: "Suite started", sub: e.log ?? null, tone: "live" };
      const took = dur(e.durationMs);
      const title = e.ok ? `Suite passed${took ? ` in ${took}` : ""}` : `Suite failed${Number.isInteger(e.exit) ? ` (exit ${e.exit})` : ""}${took ? ` in ${took}` : ""}`;
      return { title, sub: e.log ?? null, tone: e.ok ? "ok" : "bad" };
    }
    case "service": return { title: e.phase === "up" ? `Service ${e.name} up${e.port ? ` on :${e.port}` : ""}` : `Service ${e.name} down`, sub: null, tone: null };
    case "lock": return { title: `${e.phase === "take" ? "Took" : "Released"} the ${e.name} lock`, sub: null, tone: null };
    case "commit": return { title: `Committed ${String(e.sha ?? "").slice(0, 7)}`, sub: Number.isInteger(e.files) ? `${e.files} file${e.files === 1 ? "" : "s"}` : null, tone: null };
    case "note": return { title: String(e.text ?? ""), sub: null, tone: null };
    default: return { title: String(e?.kind ?? "event"), sub: null, tone: null };
  }
}

/** The timeline's kind filters. */
export const GROUPS = { Agents: ["agent"], Gates: ["gate"], Suite: ["suite"], Stages: ["stage"] };

/** Does an event pass the timeline's filters (card: a card id or null; group: a GROUPS key or null)? */
export function matches(e, { card = null, group = null } = {}) {
  if (card && e.id !== card) return false;
  if (group && !(GROUPS[group] ?? []).includes(e.kind)) return false;
  return true;
}
```

*Dated 2026-11-02 (review fix, under the owner's standing OK for robustness fixes):* `describe` never throws and never prints "undefined": every field it shows goes through a safe text helper (strings as they are, numbers as text, anything else empty), and a missing name falls back to a neutral word; an agent row's second line is its `log` when it has one (spec §6.3, "the file underneath"), else its model; a suite killed by a signal says so; `matches` reads only `GROUPS`' own keys; `foldTail` tolerates a missing answer. Tests cover hostile and partial events.

- [ ] **Step 4: Run the test, then the full suite.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add board/activity-state.mjs test/board.state.test.mjs
git commit -m "feat(board): fold the activity feed and log tails; one sentence per event"
```

---

### Task 4: Running agents in the snapshot, judged by the demo's own clock in demo mode

**Depends on:** Task 1

**Files:**
- Modify: `src/board/snapshot.mjs` (`buildSnapshot`)
- Modify: `src/board/server.mjs` (the activity route's `now`)
- Modify: `test/board.snapshot.test.mjs`, `test/board.server.test.mjs`

**Interfaces:**
- Consumes: `runningAgents(c, jobs, { now })` from `src/events.mjs`; `activity(c, args, { now })` from `src/board/activity.mjs`.
- Produces: `buildSnapshot(...).running` — `runningAgents` over every job, with `now` the snapshot's own `now` (the demo's latest moment in demo mode, the real clock otherwise); the `/activity.json` route passes the same demo-aware `now` to `activity`.

- [ ] **Step 1: Write the failing tests**

Append to `test/board.snapshot.test.mjs` (add `appendEvent` from `../src/events.mjs` and `actions` from `../src/job-actions.mjs` to its imports if absent):

```js
test("snapshot: running lists the agents running now", () => {
  const c = { stateDir: tmpDir("sf-snap-"), limits: { lockStaleMs: 60_000 } };
  const j = addJob(c, "milestone", "t");
  actions.set(c, { id: j.id, to: "planning" });
  appendEvent(c, j.id, { kind: "agent", phase: "start", vendor: "claude", role: "planner", model: "opus" });
  const s = buildSnapshot(c);
  assert.deepEqual(s.running.map((r) => [r.id, r.role, r.vendor]), [[j.id, "planner", "claude"]]);
});
```

Append to `test/board.server.test.mjs`:

```js
test("server: /jobs.json and /activity.json agree on the agents running now, in demo mode too", async () => {
  const demo = tmpDir("sf-demo-");
  const c = { ...mk(), stateDir: demo };
  const j = addJob(c, "milestone", "demo card");
  actions.set(c, { id: j.id, to: "planning" });
  appendEvent(c, j.id, { kind: "agent", phase: "start", vendor: "codex", role: "implementer", model: "implement" });
  for (const opts of [{}, { demoDir: demo }]) {
    await withBoard(opts.demoDir ? mk() : c, opts, async (b) => {
      const s = await (await fetch(`${b.url}jobs.json`)).json();
      const a = await (await fetch(`${b.url}activity.json`)).json();
      assert.deepEqual(s.running.map((r) => r.id), [j.id]);
      assert.deepEqual(a.running, s.running);
    });
  }
});
```

(Add `appendEvent` from `../src/events.mjs` to the file's imports. Task 7 pins the demo clock itself, against the generated demo jobs whose times are fixed in the past.)

- [ ] **Step 2: Run them to see them fail** — Expected: FAIL (`running` is undefined in the snapshot).

- [ ] **Step 3: Implement**

In `src/board/snapshot.mjs`, import `runningAgents` from `../events.mjs`, and in `buildSnapshot`'s returned object add, after `jobs,`:

```js
    running: runningAgents(c, all, { now: Date.parse(now) }),
```

In `src/board/server.mjs`, in the `/activity.json` route, pass a demo-aware clock:

```js
        const demoNow = demoDir ? Date.parse(buildSnapshot(view, { demo: true }).generatedAt) : undefined;
        return sendJson(res, 200, activity(view, { cursor: url.searchParams.get("cursor") ?? undefined, limit }, demoNow === undefined ? {} : { now: demoNow }));
```

- [ ] **Step 4: Run the touched tests, then the full suite.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/board/snapshot.mjs src/board/server.mjs test/board.snapshot.test.mjs test/board.server.test.mjs
git commit -m "feat(board): the snapshot carries the agents running now; demo mode judges them by its own clock"
```

---

### Task 5: The two glass themes and the board view

**Depends on:** Task 4

**Files:**
- Modify: `board/board.css`
- Modify: `board/dashboard.html`
- Modify: `board/board.mjs`
- Modify: `test/board.page.test.mjs`

**Interfaces:**
- Consumes: the snapshot's `running` (Task 4), job fields `number`, `after`, `externalNote`, `pr` (Part 1).
- Produces: the redesigned page (spec §6.1, §6.2): the top bar (`<span class="brand">sfactory</span>` in Instrument Serif, the project in mono, a tab bar `#tabs` with `Board` and `Activity` buttons, the lock indicators moved from the footer into the top bar, the connection dot, the theme toggle); the board view in glass; Done collapsed to the newest 8 by `ended` with a "Show all N" row; the theme defaulting to smoked glass.

**What to build** (layout and treatment as in `board-style.html`, option A for the dark theme and option B for the light one):

- **Fonts.** Add Instrument Serif to the shell's Google Fonts link (`family=Instrument+Serif`), beside IBM Plex Sans and Mono.
- **Themes.** In `board.css`, replace today's colour blocks with the token table above: `:root` and `:root[data-theme="dark"]` hold smoked glass, `:root[data-theme="light"]` porcelain glass; remove the `@media (prefers-color-scheme: light)` block. The page background is `--bg` with two large blurred glows (`body::before` / `body::after`, `filter: blur(90px)`, `--glow-a` top-left, `--glow-b` bottom-right, `position: fixed`, `z-index: -1`, `pointer-events: none`). Panels (columns, drawer, top-bar tabs): `background: var(--panel)`, `border: 1px solid var(--panel-line)`, `box-shadow: inset 0 1px 0 var(--panel-hi)`, `backdrop-filter: blur(22px) saturate(140%)`, radius 14 px, with `@supports not (backdrop-filter: blur(1px)) { … background: var(--panel-solid) }`. Cards: `--card` / `--card-line`, radius 11 px. The theme toggle keeps its `localStorage` key and now flips between `dark` and `light` with dark as the default when nothing is stored (no OS check).
- **Focus.** `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }` on every interactive element.
- **Cards** (`buildCard` in `board.mjs`): the id pill (`.num`, mono, `--pill`/`--pill-ink`, radius 6 px) shows `M<number>` when the card has one, else its id; the kind beside it in small caps; the title (13.5 px, weight 500); a mono meta line (branch, or "after M13"); for an external card a dashed `--you` border and a tag "<externalNote> · PR #<pr>" (the PR part only when `pr` is set; the tag shows even without a note when `pr` is set — fixing Part 1's gap); for pushed and merged cards a quiet PR tag `PR #<pr>` when set; in-process cards keep the progress bar and add a line with a breathing `--live` dot and the running agent, from the snapshot's `running` for that card ("Codex · implementer · task 3 · 4m"; elapsed from `startedAt` to the snapshot's `generatedAt`). The existing gates, chips, drawer and approve-after-viewing behaviour are unchanged.
- **Column headers**: small capitals, letter-spacing .12em, the count in mono; "Needs you" in `--you`.
- **Done**: show the eight cards with the newest `ended` first; a `<button class="more">` row "Show all N" expands the column in place (and "Show fewer" collapses it); the choice is stored per viewer (`localStorage` key `board-done-all`, try/catch).
- **Top bar**: the lock indicators (live, suite, commit) move out of the footer into the top bar as small mono labels with a dot (`--live` when free, `--you` when held, the holder named: "suite · m-3"); the footer keeps ports and cost.
- **Tabs**: `Board` and `Activity` buttons with `aria-pressed`; `?view=activity` selects Activity on load (an unknown value falls back to Board); switching updates the URL with `history.replaceState` and remembers the last view in `localStorage` (`board-view`). In this task the Activity button shows an empty `#activity` section with the text "Activity loads here"; Task 6 builds it.
- **Reduced motion**: the breathing dot and the active-card ring keep a static frame under `prefers-reduced-motion: reduce`.

- [ ] **Step 1: Update the page tests (they fail until the redesign lands)**

In `test/board.page.test.mjs`:
- replace "page: both light theme blocks" with:

```js
test("page: smoked glass is the default, porcelain the light theme, no OS switch", () => {
  assert.equal(/prefers-color-scheme/.test(css), false);
  for (const sel of [':root {', ':root[data-theme="dark"]', ':root[data-theme="light"]']) assert.ok(css.includes(sel), sel);
  const light = css.split(':root[data-theme="light"] {')[1].split("}")[0];
  for (const t of ["--bg:", "--panel:", "--card:", "--ink:", "--you:", "--live:", "--danger:", "--pulse:", "--focus:"]) assert.ok(light.includes(t), `light theme defines ${t}`);
  assert.match(css, /backdrop-filter: blur\(22px\)/);
  assert.match(css, /@supports not \(backdrop-filter/);
  assert.match(css, /:focus-visible/);
  assert.match(shell, /Instrument\+Serif/);
  assert.match(js, /board-theme/);
});
```

- in "page: pulse keyframes …", replace the four theme-block loop with a check that `:root {` (smoked) and `:root[data-theme="light"] {` (porcelain) each define `--danger:` and `--pulse:`;
- in "page: fix round 1 behaviours are in the source", drop the hex-colour assertion on the old light block (the tokens are now the table's); keep the rest;
- add:

```js
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
```

- [ ] **Step 2: Run them to see them fail** — `node --test test/board.page.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** the "What to build" list in `board/board.css`, `board/dashboard.html` and `board/board.mjs`. Keep every existing behaviour the page tests pin (approve-after-viewing, verdict colouring, chips, the drawer, the gates, the empty-column rules, the pulse frames); change only what this task names. Then open the board in a browser against the demo (`node src/cli.mjs board --demo`, http://127.0.0.1:4317) in both themes and at 360 px width, and compare with `board-style.html`; report what you compared.

- [ ] **Step 4: Run the page tests, then the full suite.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add board/board.css board/dashboard.html board/board.mjs test/board.page.test.mjs
git commit -m "feat(board): smoked and porcelain glass, the new cards, Done collapsed, locks in the top bar"
```

---

### Task 6: The Activity view

**Depends on:** Tasks 2, 3 and 5

**Files:**
- Create: `board/activity.mjs`
- Modify: `board/board.mjs` (mount the view when the Activity tab is selected)
- Modify: `board/dashboard.html` (the `#activity` section's skeleton)
- Modify: `board/board.css`
- Modify: `test/board.page.test.mjs`

**Interfaces:**
- Consumes: `renderCodexStream`, `splitOutput` (Task 2); `foldActivity`, `foldTail`, `describe`, `GROUPS`, `matches` (Task 3); the snapshot's `running` and `jobs`; `GET /activity.json`, `GET /jobs/:id/tail`, `GET /jobs/:id/file`.
- Produces: `mountActivity(root, { getSnapshot })` exported from `board/activity.mjs`, returning `{ start(), stop() }`; `board.mjs` imports it, calls `start()` when the Activity tab is shown and `stop()` when the Board tab is.

**What to build** (layout A of `activity-view.html`, the split):

- **Running now** (top row): one glass tile per running agent (from the latest activity answer's `running`): a breathing `--live` dot, the card pill (`M<number>` or id) and title, "Vendor · role · task n", the model and the elapsed time in mono. The suite shows as a tile while the snapshot's `locks.suite` is held (holder named). Clicking a tile selects it (`aria-pressed`); the first is selected by default; with nothing running, one quiet line: "Nothing running. Cards waiting on you: n." (n from the snapshot's jobs with `needsYou`).
- **Timeline** (left, 40 %): the folded events, newest first, grouped by day (a small-caps day label: "Today", "Yesterday", else the date); each row a mono time, the card pill and `describe(e)`'s title (the tone colours a ✓/✕ word only, never the whole row) with its `sub` underneath in mono. Filter chips: "All cards", one chip per card with events in the last day, and one per `GROUPS` key; chips are toggle buttons with `aria-pressed`. A row whose event carries a `log` (agent or suite) is a button that opens that log on the right.
- **Output** (right): the selected agent's header (dot, "card · Vendor role · task n", elapsed) and four tabs:
  - *Live output*: for a Codex agent, tail its `log` (`/jobs/:id/tail?path=<log>&from=<next>`) and render with `renderCodexStream`: a `message` as prose; `reasoning` as quiet italic; a `command` as a mono block with `$ command`, its status on the right ("running" in `--you`, "exit 0" in `--live`, "exit n" in `--danger`, each with its word), and its output collapsed after 12 lines (`splitOutput`) with a "Show n more" button; `files` as one mono row per path with its change kind ("added", "updated", "deleted"); `usage` as one quiet line; `raw` as dim mono text. For the suite, tail its log as plain mono text. For a Claude agent: "Claude subagents report when they finish." with its start time; when its finish arrives, the tab switches to *Report*.
  - *Brief*: `tasks/<n>/brief.md` (through `/jobs/:id/file`), when the agent has a task number.
  - *Report*: the newest file in `reviews/` or `tasks/<n>/report.md` that exists for this agent's task (through `/jobs/:id/file`).
  - *Raw log*: the tailed text as written.
  - A *Following* toggle keeps the pane at the bottom while new text arrives and turns off when the person scrolls up.
- **Polling**: `/activity.json` every `pollMs` (from the snapshot) with the cursor from `foldActivity`; the open log every second; both paused while the tab is hidden (`document.hidden`) and when the view is stopped. A tail answer is folded with `foldTail(view, asked, answer)`, so a restarted file replaces the text. Decode nothing by hand: the server answers text.
- **Narrow screens**: below 900 px the split stacks — tiles, output, timeline.
- **Text only**: every string reaches the page through `textContent`; no `innerHTML`.

- [ ] **Step 1: Write the failing tests**

Append to `test/board.page.test.mjs` (read `activity.mjs` beside the others: `const act = read("activity.mjs");`):

```js
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
```

Append to `test/board.render.test.mjs` a smoke test that `board/activity.mjs` parses as a module (`await import(new URL("../board/activity.mjs", import.meta.url))` succeeds and exports `mountActivity` as a function — the module must not touch `document` at import time).

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.

- [ ] **Step 3: Implement** the "What to build" list. Then run the demo board and look at the Activity view in both themes and at 360 px; report what you compared with `activity-view.html`.

- [ ] **Step 4: Run the touched tests, then the full suite.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add board/activity.mjs board/board.mjs board/dashboard.html board/board.css test/board.page.test.mjs test/board.render.test.mjs
git commit -m "feat(board): the Activity view — running tiles, the timeline and the live output pane"
```

---

### Task 7: A running demo card, the docs and the version

**Depends on:** Task 6

**Files:**
- Modify: `examples/jobs/generate.mjs` and the regenerated `examples/jobs/*`
- Modify: `test/examples.jobs.test.mjs`, `test/board.server.test.mjs`
- Modify: `README.md`, `docs/DESIGN.md`, `package.json`, `.claude-plugin/plugin.json`, `test/cli.test.mjs`

**Interfaces:**
- Produces: a demo card in `building` with an `events.jsonl` (a started Codex implementer with a `log`, a Claude spec reviewer started and finished with `--verdict ok`, a commit, a suite run) and that log (`tasks/3/codex-0/codex.jsonl`, the fixture's content), all within the demo's clock, so `board --demo` shows a running tile and live output; version 0.5.0.

- [ ] **Step 1: Write the failing tests**

In `test/examples.jobs.test.mjs`, update the pinned job count to the new total and add: the generated `examples/jobs/<the new id>/events.jsonl` exists and parses line by line, and its card is in `building`.

Append to `test/board.server.test.mjs`:

```js
test("server: the demo board shows a running Codex agent with a log it can tail", async () => {
  await withBoard(mk(), { demoDir: fileURLToPath(new URL("../examples/jobs", import.meta.url)) }, async (b) => {
    const a = await (await fetch(`${b.url}activity.json`)).json();
    const r = a.running.find((x) => x.vendor === "codex");
    assert.ok(r, "a running Codex agent");
    const t = await (await fetch(`${b.url}jobs/${r.id}/tail?path=${encodeURIComponent(r.log)}&from=0`)).json();
    assert.match(t.text, /"type":"item\.completed"/);
  });
});
```

(Import `fileURLToPath` from `node:url`.)

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.

- [ ] **Step 3: Implement**

- In `examples/jobs/generate.mjs`, add one card (the next free `m-<n>` id, title "Saved searches", number "6", branch `feature/saved-searches`) walked to `building` with `tasks: { total: 5, done: 2 }`, and write beside its `job.json` an `events.jsonl` built with `encodeEvent` from `src/events.mjs` (fixed `at` values within the hour before the card's `updated`): stage events for its walk, a gate `approve` by `board`, a Claude `spec-reviewer` start and finish (`verdict: "ok"`) on task 2, a commit, a suite start and finish (`ok: true`, `durationMs: 161000`), and a Codex `implementer` start on task 3 with `log: "tasks/3/codex-0/codex.jsonl"` and no finish; and write `tasks/3/codex-0/codex.jsonl` with the content of `test/fixtures/codex-stream.jsonl` minus its last line (the turn is still running). Make the card's `updated` the demo's latest moment. Regenerate with `node examples/jobs/generate.mjs`.
- README: in "The board", describe the two themes (smoked glass by default, porcelain light, the toggle remembers), the Activity tab (running tiles, timeline with filters, the live output pane and its four tabs), and that `board --demo` shows a running agent. In "A card in 90 seconds" mention the Activity tab.
- `docs/DESIGN.md`: a dated amendment line for Part 3, pointing at the spec's §6.
- Version 0.5.0 in `package.json`, `.claude-plugin/plugin.json` and the version test in `test/cli.test.mjs`.

- [ ] **Step 4: Run the touched tests, then the full suite.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/jobs test/examples.jobs.test.mjs test/board.server.test.mjs README.md docs/DESIGN.md package.json .claude-plugin/plugin.json test/cli.test.mjs
git commit -m "feat(board): a running demo card with live output; docs; 0.5.0"
```

**After Task 7** (the controller, on the owner's word): a headed walkthrough of `board --demo` in both themes, at desktop width and 360 px, the Board and Activity tabs, keyboard focus through the controls, with screenshots under the git-ignored `.superpowers/`, compared against the two mockups.
