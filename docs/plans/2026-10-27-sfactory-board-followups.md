# sfactory board — follow-ups after the whole-branch review (2026-10-28)

The board plan (`2026-10-27-sfactory-board.md`) was built subagent-driven on `feat/board`: six tasks, each reviewed on Opus with fix rounds, a controller headed check (demo board, light and dark, desktop and 400 px, the drawer, a refused demo POST) and a recheck, then a whole-branch review ("with fixes"), one fix wave and a clean scoped re-review. Final suite: 190 tests, 0 failures. The core's Plan B entry criterion (I8, the job-store lock) is closed and was probed across processes.

## Decisions taken during the build (differ from the plan text)

- The default board port is **4317**, not 5900 (5900 is VNC's well-known port and was taken on the build machine). A port that cannot be bound is `PORT_UNAVAILABLE`, naming `--port` and `board.port`.
- Every board response is allow-listed: one `jobView` serves the snapshot and the POST answer; no response carries `lockToken`, `history` or a lock body.
- `withJobLock` re-throws anything but `LOCK_HELD`, and refuses a thenable result (`LOCK_ASYNC`) — callers stay synchronous.
- `writeJobFile` refuses `job.json` and `cost.json`; `addCost` runs under the job lock with a unique temp name.
- The server refuses an empty body, untyped fields and a malformed path encoding with `BAD_ARGS`; `rework`, `answer` and `request-changes` require text; `answer` with no decision on file is refused.
- A demo snapshot measures elapsed time against the fixtures' own latest timestamp; below 640 px empty columns are hidden so a card that needs you is seen first; approval, decision and parallel cards all carry the "needs you" badge.

## For the owner to decide (design §11 items the plan did not cover)

- A questionnaire is answered through one *Request changes* notes box; per-question answer fields are not built.
- No live-card pulse, no red stopped card, no review chips; the footer shows the summed cost of the listed jobs, not the day's.
- *Approve* can be pressed without the drawer having shown the brief and the plan.
- The decision card shows the whole decisions file, including the CLI instruction lines.

## Minor, left on purpose

- A gate that committed can answer 500 if building its view then fails (a hand-corrupted cost.json); a retry gets 409. The snapshot fails the same way and the page names the code.
- `writeJobFile`'s refusal compares names case-sensitively (Windows `JOB.JSON`); every caller passes fixed names.
- `LOCK_ASYNC` fires after an async callback has started; it is a programmer guard.
- The cross-process lock tests rely on the ~2 s retry budget; watch them under load. Other timing tests (killTree, lock (a), suite log, concurrent addCost) are known load flakes.
- An oversized body sometimes resets the connection instead of answering 413.
- `BOARD_COLUMNS` duplicates the order of `COLUMNS`; the lock↔store import cycle remains; test temp directories are not removed; the decisions template carries trailing spaces.
