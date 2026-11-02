# sfactory Part 2 — follow-ups

Part 2 (`docs/plans/2026-11-02-sfactory-part2-events.md`) closed on 2026-11-02 on `feat/events` (cut from `feat/roadmap-activity`): seven tasks, each spec- and quality-reviewed; a whole-branch review ("with fixes", nothing Critical or Important) and one fix wave, re-reviewed.

## Owner rulings recorded on the way
- Task 1: `encodeEvent` always shortens a field by whole characters, never cuts `at`, `by` or `kind`, and refuses an event that still cannot fit (one warning, no hang); the plan's loop could spin for ever.
- Task 6: a cut activity cursor uses the offset actually read, so a shrunken log never repeats a batch; the merge compares timestamps with a plain `<`.

## Deferred (triaged "can wait" by the whole-branch review)
- A single foreign line over 256 KiB with no newline stalls `readAllEvents` (our lines are at most 1 KiB).
- A crashed half-write joins the next line, which is then skipped (accepted).
- A gate's event is written after the job lock is released, so another writer's event can land between a gate's stage and gate events.
- The default `by` is decided in two places (each gate and the gate wrapper).
- Tests not written: every gate's event (only start, request-changes and approve are pinned; `parallel`'s `yes` is not), the suite's `log` inside a card folder, `suiteSerial: false`, no events on `LOCK_HELD`, `acquireSync` taking a timeline lock, the activity limit's clamp above 500, demo mode, a non-string `at` in `runningAgents`.
- `--note` together with `--agent`: the note labels the pulse but reaches no event; a whitespace-only note writes a blank note event; agent-only flags without `--agent` are now refused.
- A Codex agent event names the profile as its model while cost recording prefers `--model` or the profile's model.
- `rel.startsWith("..")` omits `log` for a folder whose name starts with `..`.
- `servicesUp`'s rollback kills started services without `down` events; a stale-lock takeover leaves the old holder a `take` with no `release` (Part 3 must not derive live service or lock state from events alone).
- `runningAgents` re-reads every working card's whole log on each poll; the first load of the activity feed reads every log. A size-keyed cache belongs with Part 3's polling.
- The activity cursor is checked for shape, not provenance; a forged offset at worst skips one fragment.
- A tail read can split a UTF-8 character at its cut; I/O errors on the tail become 500; a symlink or junction inside a card folder is followed; the tail's extension check differs from `/jobs/:id/file`'s; empty `from=`/`limit=` read as 0.
- A crafted `at` with its own `toString` key can throw in the merge; a log shrinking during a multi-chunk read reads inconsistently; a same-length replacement is invisible to a byte cursor.
- The orchestrator's touch rule is asserted twice in the skills tests.
- The CLI's 40-character cap on `--by` measures the trimmed value but passes the untrimmed one on, so a short name padded with spaces can still make events unfittable (the board trims before use); a Codex event records `--role`/`--task` untrimmed while a touch trims them.
- `skills/sdd/CHANGES.md` item 39 sits under the Plan C section heading; it belongs under a Part 2 heading.

## For Part 3 (the board redesign)
- A tail whose `from` is past the end answers from 0 with `from: 0`: the client compares the answer's `from` with what it asked for and replaces its text when they differ.
- Decode tailed bytes as a stream (or back off to a character boundary) so a cut never shows a broken character.
- Render agent state from `running`, and service and lock state from the snapshot's live data, not from events alone.
