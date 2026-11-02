# sfactory Part 3 — follow-ups

Part 3 (`docs/plans/2026-11-02-sfactory-part3-board.md`) closed on 2026-11-02 on `feat/board-redesign` (cut from `feat/events`): seven tasks, each spec- and quality-reviewed (the two visual tasks also checked in a browser against the approved mockups in both themes and at 360 px); a whole-branch review ("with fixes") and one fix wave, re-reviewed.

## Owner rulings recorded on the way
- A standing OK for robustness and correctness fixes to the plan's own code (Parts 3 and 4), each recorded as a dated note in the plan: the Codex renderer never throws and merges items only within a run and a kind; event sentences never throw or say "undefined"; readable light-theme small text and no polling live region; the timeline orders by time.
- No ring on active cards: a working card shows its sage border tint and the breathing dot (spec §6.1, "no glow on cards").
- Champagne means only "needs you": live work (a running command, the suite tile) is sage, a held lock is plain ink with its holder named.

## Deferred (triaged "can wait")
- The asset route: no test for a listed file missing on disk or for assets in demo mode; the external-script page check is narrow; `ASSETS` is not frozen.
- The renderer: no explicit `id: null` test.
- `foldTail` coerces `answer.text` with `String()` (the server's own text); `matches(null)` throws (callers filter non-objects first).
- Demo `/activity.json` builds a whole snapshot for its clock; `/jobs.json` and `/activity.json` each run `runningAgents`, which re-reads whole working-card logs every poll — a size-keyed cache later; the Activity view could take `running` from the snapshot it already holds.
- The Codex pane re-parses the whole log (up to 1 MB) on each new chunk; parse incrementally later.
- The extra radii (8 px buttons, 9 px "Show all") come from the mockup; a redundant `.tag.pr` rule; Done sorts with `localeCompare` on ISO strings.
- A truncated pill in the timeline has no tooltip; the retry countdown does not tick; a `BAD_ARGS` cursor reset waits one back-off.
- An aborted tail read can trigger one early extra read; a throw while painting the output leaves an unhandled rejection (the next tick heals it).
- In demo mode the card's running-line elapsed time is measured against the frozen demo clock while the tile ticks.
- Porcelain viewers see smoked glass for a moment on load (the theme is applied by the deferred module; an inline script is not allowed).
- Spec §6.2 put *Start* in the drawer; it is on the card. Review chips use ✗ where the timeline uses ✕. Demo pills can read confusingly (m-7 shows M6).
- The demo banner uses champagne; `--pulse` is defined but unused; a snapshot test name still says "pulse"; an event that carried its own `seq` field would have it overwritten by the timeline's arrival number.
- The demo's gate event shares its stage event's time (a real gate event is a moment later; the stable sort keeps the order).
- Part 2's activity test depended on the real clock (fixed on this branch by stamping its notes in 2099); `feat/events` keeps the latent failure until this branch merges into it.

## For Part 4 (talking to the session)
- The composer bar sits at the bottom of both views; keep the one-accent rule (champagne only for what needs the person) and the polling hygiene (one request in flight, paused when hidden).
