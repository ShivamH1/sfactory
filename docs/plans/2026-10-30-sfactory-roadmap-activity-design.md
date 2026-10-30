# sfactory: Milestones column, External running column, import, and the Activity view

Design, 2026-10-30. Agreed with the owner in one brainstorming session (the mockups were local brainstorming files and are not in the repo; section 6 records what they settled). Builds on `docs/DESIGN.md`; where this document and DESIGN.md disagree, this one wins for the features it names.

Everything here is generic: a project that installs the plugin configures itself through `sfactory.config.json` and, if it wants its history and roadmap on the board, writes its own import file (section 11). No project's data ships with the plugin.

## 1. Goal

1. Future work sits on the board without the factory touching it: a **Milestones** column, left of Backlog. `/sfactory start M57` moves a card to Backlog and starts the run loop.
2. Work done outside the factory still shows: an **External running** column, which `run` never touches.
3. A project's history and roadmap can be put on the board once: `sfactory job import <file.json>`.
4. The board shows what the factory is doing right now: an **Activity** view with the agents running, a timeline across every card, and the selected agent's live output.
5. The person can write to the orchestrator session from the board, and read its replies there: a composer bar at the bottom of the page.
6. The board looks finished, not generated: a glass design in two themes, *smoked glass* (dark, the default) and *porcelain glass* (light).

Not in scope: a live sync from a project's own progress file; the hosting Claude Code session's transcript; live text from Claude subagents (they write nothing to disk until they finish); adopting an external card into the factory (a person can stop it and add a new card); a runner that works the board without a session.

## 2. The card model

### 2.1 Two new stages

| Stage | Column | Meaning |
|---|---|---|
| `roadmap` | Milestones | Planned work the factory has not been asked to start. |
| `external` | External running | Work being done outside the factory (another agent, a person, a mailbox process). |

`STAGES` gains both; `COLUMNS` maps them; `BOARD_COLUMNS` becomes: Milestones, Backlog, Plan, Needs you, In process, Review, Fixed, Pushed / PR, External running, Done, Stopped (Stopped stays hidden while empty, as today).

New edges in `TRANSITIONS`:

- `roadmap: ["backlog", "external"]`
- `backlog: ["planning", "external"]` (the existing edge plus one)
- `external: ["merged"]`

`stop` already accepts any non-terminal stage, so `roadmap` and `external` can be stopped. Neither is in `WORKING`: no pulse, no touch, no park. Neither counts toward `limits.parallelMilestones` (`countsAt` and the active filter list both name them as off). The run loop (orchestrator skill, section 4) skips both: a run ends when nothing is left but `roadmap`, `external`, `pushed`, `merged` and `stopped` cards, or every remaining card waits on the person.

### 2.2 The milestone number

A card may carry `number`: a string matching `^\d+(\.\d+)?$` (`"57"`, `"29.1"`). It is set by `sfactory job add ... --number <n>` or by the import, never changed after. `sfactory job add milestone "<title>" --roadmap` (and `/sfactory add milestone "<title>" --roadmap`) creates the card in `roadmap` instead of `backlog`; `--after "<text>"` sets its "after" line. The board shows it as **M57** in the card's id pill (the job id moves to the drawer); a card without one shows its job id as today.

Every command that takes a job id also takes `M<number>` (case-insensitive): one resolver in `src/store.mjs` (`resolveId(c, ref)`), called by `commands/job.mjs` before the action and by every other command that takes an id. `NOT_FOUND` when no card carries it, `AMBIGUOUS` when two do (the import and `add` both refuse a duplicate number, so this means a hand-edited job file).

*Dated 2026-10-30 (owner ruling after the Part 1 whole-branch review):* (1) a card's number is reserved from the moment it is on the board: the next free number counts every other milestone's whole number in any stage, and under `job-id` numbering an unnumbered card whose id number another card carries is refused `NUMBER_TAKEN`; (2) a decimal number (`29.1`) is history only: such a card may sit in `roadmap`, `external`, `pushed` or `merged`, and is refused `BAD_NUMBER` by `add` without `--roadmap`, by an import into `backlog`, by `start`, and on entering `planning`; (3) a number has no leading zero (`014` is refused; `0` is allowed).

**Numbering.** When a numbered milestone is cut, its record `{n}` is its number, not the next free one, for every `record.numbering` value. A card whose number is not a whole number is refused at the cut (`BAD_NUMBER`), and so is a number another unmerged card's record already holds, or a brief at that number already in the worktree (`NUMBER_TAKEN`, naming the file). An unnumbered card keeps today's rule.

### 2.3 Gates

- **start** (`sfactory job start <id>`): `roadmap -> backlog`, by the session or the board. `/sfactory start M57` runs it and then the run loop. The board's *Start* button runs the same gate and shows "Starts on the next `/sfactory run`", because the board starts no agent.
- **external** (`sfactory job external <id> --note "<who is doing it>"`): `roadmap` or `backlog -> external`; the note (at most 200 characters) is stored as `job.externalNote` and shown on the card.
- **merged** works on an `external` card as on a `pushed` one; the board's *Mark merged* appears on both.

## 3. `sfactory job import <file.json>`

Creates cards in bulk, in the five stages that need no worktree: `roadmap`, `backlog`, `external`, `pushed`, `merged`. Any other stage is refused, because a working stage implies a worktree, ports and state the import cannot create.

```json
{
  "cards": [
    { "number": "12", "kind": "milestone", "title": "Saved searches", "stage": "merged",
      "branch": "feature/saved-searches", "pr": 31, "started": "2026-09-02", "ended": "2026-09-09" },
    { "number": "13", "kind": "milestone", "title": "CSV export", "stage": "external",
      "branch": "feature/csv-export", "pr": 34, "externalNote": "pairing session", "started": "2026-09-10" },
    { "number": "14", "kind": "milestone", "title": "Audit log", "stage": "roadmap", "after": "M13" }
  ]
}
```

- Required: `kind`, `title`, `stage`. Optional: `number`, `branch`, `pr` (positive integer), `prUrl`, `started`, `ended` (ISO dates or date-times), `after` (at most 80 characters, shown as "after M56"), `externalNote` (external only), `note` (at most 2,000 characters, written to `notes.md`).
- The whole file is validated before anything is written; one bad card refuses the import (`BAD_IMPORT`, naming the card's index and field). An unknown field is refused.
- **Safe to run again:** a card whose `number` is already on the board is skipped and listed; an unnumbered card is skipped when a card with the same kind and title exists. Ids are allocated as today (`m-<n>`, `f-<n>`), in file order.
- Each card's history starts `{ from: null, to: <stage>, by: "import", reason: "imported" }`; a `merged` card gets `ended`. A card with `pr` gets `pr.md` (`PR #31 · feature/saved-searches`, and the URL when given), so the board's PR panel shows it.
- Each imported card gets one `stage` event (section 4).

## 4. The event log

Each card gets `<stateDir>/jobs/<id>/events.jsonl`, one JSON object per line, common fields `{ at, kind, by }`:

| kind | fields | written by |
|---|---|---|
| `stage` | from, to, reason | every transition, park, release, queue, stop, resume, start, external, import |
| `gate` | action: approve, request-changes, answer, parallel, merged, rework, start, external | the gate actions, whichever surface pressed |
| `agent` | phase (start, finish), role, task, vendor (claude, codex), model, log (path relative to the job folder), verdict (finish, optional) | `sfactory codex exec` and `codex review` when given `--job` (start before the spawn, finish after, with the stream's path); Claude agents through `job touch --agent` |
| `suite` | phase, log, exit, durationMs | `sfactory suite --job` |
| `service` | phase (up, down), name, port | `sfactory services` |
| `lock` | phase (take, release), name | the live, suite and commit locks, when taken for a job |
| `commit` | sha, files (count) | `sfactory commit --holder <id>` |
| `note` | text | `job touch --note` without `--agent` |

- One module, `src/events.mjs`: `appendEvent(c, id, event)` and `readEvents(c, id, { from })`. An event is one `appendFileSync` of one line, at most 1 KB (a longer field is cut, never the line split). Appends take no job lock.
- `job.json` stays the truth. A failed append prints one warning line to stderr and never fails the command.
- `job touch` keeps setting `job.activity` (the pulse and the card's note work as today) and gains `--agent start|finish --role <r> --task <n|branch> --vendor claude|codex --model <alias|profile> [--verdict ok|fixes]`; with `--agent` it writes an `agent` event, without it a `note` event.
- The sdd and orchestrator skills change their touch lines to the structured form; their wording otherwise stays.
- **An agent is running** when its `start` has no later `finish` with the same role, task and vendor, and its card is still in a working stage. An unmatched start older than six hours, or on a card that left the working stages, is shown as ended ("no finish recorded"), never as running.

## 5. Board server

New routes beside the existing ones, under the same rules (127.0.0.1 only, the Host check, the response allow-list, `X-Sfactory-Board: 1` on every POST):

- `GET /api/activity?cursor=<token>&limit=<n>`: new events across every card, oldest first, at most `limit` (default 200, clamped to 500). The cursor is an opaque base64 of `{ <jobId>: <byte offset> }`; with no cursor the server returns the newest `limit` events and a cursor at the end. A partial last line waits for the next poll; a line that does not parse is skipped. The answer also carries `running`: the agents running now (section 4's rule), each with card, role, task, vendor, model, `startedAt` and its `log`.
- `GET /api/jobs/:id/tail?file=<relative path>&from=<offset>`: up to 64 KB of one file from `from`, and the next offset; `from` beyond the end answers empty with the file's size, so a truncated file restarts. Only `.log`, `.jsonl` and `.md` files inside that job's folder are served; anything else is `403`. The drawer's existing file reads stay as they are.
- `POST /api/jobs/:id/start`: the start gate.
- `GET /api/chat?from=<offset>` and `POST /api/chat` (`{ text, card? }`, text 1–4,000 characters, `card` an existing job id or absent): the thread (section 6.4). The GET answer carries `channel: { connected, at }` from `chat/channel.json`.

## 6. Board UI

### 6.1 Look

Two themes on the same tokens. **Smoked glass** is the default whatever the OS prefers; **porcelain glass** is the light theme; the existing toggle switches them and remembers the choice in `localStorage` (try/catch, the board correct without it).

- Smoked glass: graphite `#0c0e11` with two large blurred glows behind the content (muted teal and bronze, low opacity); panels `rgba(255,255,255,.035)` with a 1 px hairline, an inner top highlight and `backdrop-filter: blur(22px) saturate(140%)`; cards a step lighter. Champagne `#dcbf86` for anything that needs the person, sage `#8fc9a8` for live work, muted rose `#d88a80` for failures.
- Porcelain glass: warm stone `#efece6`, pale sky and sand glows, white frosted panels, ink type; ochre `#8a5a17` for the person, forest `#2f6b4f` for live work.
- Type: Instrument Serif for the wordmark only; IBM Plex Sans for everything else; IBM Plex Mono for ids, numbers, branches, times and logs, with `tabular-nums`. Column headers are small capitals with the count in mono.
- Rules that keep it from looking generated: one accent per meaning, never decorative; no emoji, no gradients on text or buttons, no glow on cards (live work is a breathing dot, a static dot under reduced motion); hairlines instead of shadows for structure; radii 14 px on panels, 11 px on cards, 6 px on pills; 8 px spacing grid.
- `backdrop-filter` falls back to an opaque panel colour where unsupported.

### 6.2 The board

- **Milestones** cards: the number pill, the title, "after M56" when set; sorted by number. The drawer shows the card and a *Start* button (champagne, the view's one primary action).
- **External running** cards: a dashed champagne border and a tag with the external note and PR ("pairing session · PR #34"); *Mark merged* in the drawer.
- **Pushed / PR** and **Done** cards carry a quiet PR tag (from `pr.md`).
- **Done** shows the eight most recently ended cards and a "Show all N" row that expands the column in place; the choice is per viewer (`localStorage`).
- In-process cards keep the progress bar and add a line naming the running agent ("Codex · implementer · task 3 of 9 · 4m") from the activity feed.

### 6.3 The Activity view (split layout)

A second tab beside Board, in the top bar (`?view=activity`, an unknown value falling back to the board). The lock indicators move into the top bar for both views.

- **Running now:** one glass tile per running agent (card, title, vendor · role · task, model, elapsed time, a breathing dot); the suite shows as a tile while it holds the lock. Clicking a tile selects it; the first is selected by default. With nothing running, a quiet line: "Nothing running. Cards waiting on you: n."
- **Timeline (left, 40 %):** every event, newest first, grouped by day; each row is a time, the card pill and one sentence ("Codex code review of task 2: ✓ Approved", with the file underneath in mono). Filter chips: All cards, one per card with events in the last day, and by kind (Agents, Gates, Suite, Stages). Clicking a row that names a log opens it on the right.
- **Output (right):** the selected agent's header (card, vendor, role, task, elapsed) and four tabs:
  - *Live output*: a Codex stream rendered by type. `agent_message` as prose; `command_execution` as a block with the command, its exit status (running, exit 0, exit n) and the output, collapsed after twelve lines; `file_change` as one row per path with its +/− counts; `turn.completed` as a quiet usage line. Lines that are not JSON, and event types the renderer does not know, are shown as plain dim text, never dropped. A *Following* toggle keeps the view at the bottom and turns off when the person scrolls up.
  - *Brief*: the task's `tasks/<n>/brief.md`.
  - *Report*: the agent's stored report or review, when it exists.
  - *Raw log*: the file as written.
  - For a Claude agent, *Live output* says "Claude subagents report when they finish" with its start time, and switches to *Report* when the finish arrives. For the suite, *Live output* tails its log.
- Polling: the activity feed at `board.pollMs`; the open log every second while the tab is visible, paused when hidden.

### 6.4 Talking to the session

A composer bar fixed to the bottom of both views lets the person write to **the orchestrator session**, the Claude Code session running the factory. Codex runs take no input once started and Claude subagents are reachable only through their parent, so the session is the one party that can act: answer, redirect the work, pass a note into the next agent it dispatches, park or stop a card.

**On screen.** A glass bar: a text box (Enter sends, Shift+Enter a new line, at most 4,000 characters), a scope chip ("General", or a card, defaulting to the card open in the drawer or selected in the Activity view) and *Send*. Above it, a collapsible thread ("Conversation · 1 new reply"): the person's messages and the session's replies, newest at the bottom, each with its card pill and a status: *sent*, *delivered* (the session has it), *answered*. A small indicator says how messages travel right now: "Live" when the channel (below) is connected, otherwise "Read at the factory's next step".

**The thread is a file.** `<stateDir>/chat/thread.jsonl`, append-only, one line per entry: a message `{ id, at, from: "person", card?, text }`, a reply `{ id, at, from: "session", replyTo, card?, text }`, or a delivery mark `{ type: "delivered", id, at, via: "channel" | "step" }`. Status is derived from the lines. The board writes person messages (`POST /api/chat`, with the board header) and reads the thread by byte offset (`GET /api/chat?from=<offset>`), as it reads events.

**Delivery, two ways, one contract.**

1. **Live, through a channel.** The plugin ships a channel: an MCP server declared in `plugin.json`, spawned by Claude Code over stdio. It finds the repo's config from its working directory, watches `thread.jsonl` (`fs.watch`, with a 1 s poll as fallback), pushes each undelivered person message as a `notifications/claude/channel` event (`content` the text, `meta` `{ message_id, card }`), appends the delivery mark, and offers one tool, `reply { message_id, text }`, which appends the reply. It writes `chat/channel.json` (`pid`, `at`) every 10 s; the board calls the channel connected while that stamp is under 30 s old. The server is hand-written JSON-RPC over stdio (initialize, tools/list, tools/call, the notification), so the package keeps zero runtime dependencies. Channels are a Claude Code research preview: until sfactory's is on the approved list, the session is started with `claude --dangerously-load-development-channels plugin:sfactory@sfactory`, in an interactive session (not `-p`), with claude.ai or Console authentication. INSTALL says so plainly.
2. **At each step, always.** The orchestrator runs `sfactory chat unread` at the start of every run-loop step and at every gate it ends a turn on. It prints the undelivered person messages and marks them delivered (`via: "step"`). The session answers with `sfactory chat reply <id> "<text>"`. So the box works without the channel; it is only slower, and a session idle at a gate reads the message at the next `/sfactory run`.

**How the session treats a message.** The person's own words, from their own machine: the same standing as the board's gate buttons. The session answers every message. It acts on one only through the factory's normal commands, and a message never stands in for a gate (an approval is still the *Approve* button or `/sfactory approve`). A message tagged to a card that is mid-task is answered at once; what it asks for is applied at that card's next step, and the reply says so. The channel accepts nothing but the thread file, and the file is written only by the board (localhost, Host-checked) and the CLI.

### 6.5 Accessibility and narrow screens

Every control reachable by keyboard with a visible focus ring; colour never the only signal (verdicts carry ✓ or ✕ and words); the split stacks below 900 px (tiles, then output, then timeline); the board keeps its horizontal scroll.

## 7. Skills

- Orchestrator: `/sfactory start <id|M#>` (start gate, then the run loop); `/sfactory external <id|M#> "<note>"`; `/sfactory import <file>`; the run loop skips `roadmap` and `external`, and its end condition names them.
- Orchestrator: `sfactory chat unread` at the start of every run-loop step and before ending a turn at a gate; every message answered with `sfactory chat reply` (or the channel's `reply` tool when the message arrived through it); the standing of a board message as in section 6.4.
- sdd: every touch line becomes the structured `--agent` form, finish lines carry `--verdict` for reviewers. Between tasks it runs `sfactory chat unread` for the card it is working, so a card-tagged message reaches the next dispatch.
- New CLI command `sfactory chat`: `unread [--card <id>]`, `reply <id> "<text>"`, `list [--card <id>]`.
- README and INSTALL gain the new commands, the two columns, the Activity view, the composer and how to start a session with the channel.

## 8. Errors

- Import: refused whole on any invalid card (`BAD_IMPORT`); duplicates skipped and listed, exit 0.
- Number: `BAD_NUMBER`, `NUMBER_TAKEN`, `AMBIGUOUS`, `NOT_FOUND`, each naming the card.
- Events: an append failure warns and continues; a reader skips what it cannot parse; a missing file is an empty log.
- Tail: `403` outside the job folder or for another extension; `404` for a missing file; a truncated file restarts from 0.
- Chat: an empty or over-long message, or an unknown card, is `400`; a reply to an unknown message id is refused (`NOT_FOUND`); the channel that cannot read the config or the thread logs to stderr and keeps its heartbeat off, so the board shows "Read at the factory's next step".

## 9. Testing

Unit tests in the existing `node --test` suite:

- the new transitions and refusals; `countsAt` and the cap with `roadmap` and `external` cards present;
- the `M<n>` resolver (case, missing, duplicate); numbering at the cut (number wins, `BAD_NUMBER`, `NUMBER_TAKEN`);
- the import: every field's validation, the whole-file refusal, skip-if-present, history, `pr.md`, ids in file order;
- `appendEvent` (the 1 KB cut, the warning path) and `readEvents` (partial last line, corrupt line, missing file);
- each writer emitting its event (gates, transitions, touch with and without `--agent`, codex start and finish, suite, services, locks, commit);
- the running-agent rule (matched, unmatched, stale, card left the working stages);
- `/api/activity` (cursor round trip, limit clamp, new jobs appearing between polls) and `/api/jobs/:id/tail` (offsets, truncation, refusals);
- the snapshot's new columns and the Done ordering;
- the chat thread: append and read by offset, status derived from the lines, `unread` marking delivered once, `reply` refusals, the two routes' validation;
- the channel server over a stub stdio: the initialize handshake, tools/list, one notification per undelivered message and none twice, the delivery mark, the `reply` tool, the heartbeat;
- the Codex renderer against `test/fixtures/codex-stream.jsonl`, recorded from a real Codex run, trimmed by hand and rewritten so it names no real project, path or person, carrying every event type seen and a non-JSON line.

The page is checked by a headed walkthrough against the demo jobs, which gain a `roadmap`, an `external` and a running card with a recorded stream.

## 10. Build order

One plan, four parts, each mergeable on its own and ending green:

1. **Cards:** the two stages, numbers and the resolver, the start and external gates, `add --roadmap`, the import, the orchestrator's run-loop changes. A project can import its history once this part is merged; the current board shows the new columns plainly until part 3 lands.
2. **Events:** `events.mjs`, every writer, `job touch --agent`, the skills' touch lines, `/api/activity` and the tail route.
3. **The board:** the two themes, the new columns' cards, Done's collapse, the Activity view and its renderer.
4. **Talking to the session:** the thread, `sfactory chat`, the two chat routes, the composer, the channel server, the skills' chat steps.

## 11. Adopting the factory on a project with history

A project that already has finished and planned work writes one import file from its own records (its progress notes, its merged and open pull requests) and runs `sfactory job import` once, after `sfactory init` and `sfactory doctor`:

- finished work as `merged`, with each card's PR where known;
- branches pushed and awaiting merge as `pushed`;
- work being done outside the factory as `external`;
- planned work as `roadmap`, each with its "after".

Cards already on the board are left as they are. The import file belongs to the project and stays out of the plugin; README gains a short "Bringing an existing project" section with a small generic example.
