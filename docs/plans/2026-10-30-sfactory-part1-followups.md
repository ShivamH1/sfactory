# sfactory Part 1 — follow-ups

Part 1 (`docs/plans/2026-10-30-sfactory-part1-cards-import.md`) closed on 2026-10-30 on `feat/roadmap-activity`: seven tasks, each spec- and quality-reviewed, a whole-branch review ("with fixes") and one fix wave, re-reviewed clean. Full suite 544 tests, 541 pass, 2 skipped; the one failure (`suite: killTree ends the shell's child too`) is a known load-sensitive process test, green when its file runs alone on a quiet machine (15/15), in code this branch did not touch.

## Owner rulings recorded on the way
- Task 4: the brief-in-worktree check runs only when `record.brief` has `{n}` and compares by number (the plan's code refused every numbered card under the default config and missed padded briefs).
- Task 5: import dates are strict ISO; impossible dates refused (the plan's `Date.parse` accepted "March 5" and rolled 2026-02-30).
- Final review: planned numbers are reserved from the moment a card is on the board; decimal numbers are history only; no leading zeros. Spec §2.2 carries the dated note.

## Deferred (triaged "can wait" by the whole-branch review)
- `--roadmap=yes` (string form) is silently ignored, as for every boolean flag in the parser.
- `park --with <id>` does not resolve `M<n>` (an orchestrator-internal flag).
- `sfactory worktree <bad verb> M99` reports `JOB_NOT_FOUND` before `UNKNOWN_COMMAND`.
- The external note's 200-character limit is checked before trimming.
- Tests not written: `AMBIGUOUS` from `resolveId`; the `M99` CLI case checks only the exit code; `M<n>` through `worktree` and `services`; a CLI run of `start`/`external`; `unheld()` after the external refusals; the board `start` route pinning `by: "board"`; *Mark merged* on an external card in the page test; `--json` output of `job import`.
- `importCards` reads every job once per card under the record lock (O(n²)); a very large import can make a concurrent cut give up with `RECORD_BUSY`. Read once and append.
- A failure writing `pr.md`/`notes.md` after the card's job.json is not repaired by a re-run (the card is skipped), and the thrown error drops the list of cards already created.
- The record-then-job lock order on a freshly created id is safe but not documented beside record.mjs's lock-order comment.
- The import accepts `after` and `roadmap` on a fix card while `add` refuses both; `add` stores `after` untrimmed, the import trims it.
- `ended` before `started` is not refused by the import (the board would show a negative elapsed time).
- Years 0000–0099 are refused by the import's calendar check; `T24:00Z` rolls to the next midnight.
- A brief pattern with `{n}` twice builds a duplicate named group (pre-existing, also in the next-free rule).
- Under `job-id` numbering, the planned-number collision is refused only at the cut (the skill stops the card and tells the person); `resume` has no decimal guard (the cut still refuses).
- A backlog card that kept a worktree and ports keeps them when it moves to `external`, and its parallel fields stay set.
- Demo cards: m-6 carries number "4" beside job id m-4, which reads as the same card; its history reason is `null` where the gate writes `"external"`.
- `docs/DESIGN.md`'s job.json field list does not name `number`, `after`, `externalNote`, `pr`, `prUrl`.
- `README.md`: "/sfactory external" could say "a Milestones or backlog card".
- `test/cli.job.test.mjs` carries a literal, invisible U+FEFF; an escaped `"﻿"` would survive edits better.
- Test-file tidiness: a duplicate import line in `test/job-actions.test.mjs`; a new snapshot test sits between the file's header constants.
- Older plan `docs/plans/2026-10-27-sfactory-agents.md` names a project-specific example config file.

## For Part 3 (the board redesign)
- The external card's tag is drawn only when a note is set; `prUrl` is never rendered. When it is, re-check the URL scheme in the page (a hand-edited job file bypasses the import's check).
