# sfactory Part 4 — follow-ups

Part 4 (`docs/plans/2026-11-02-sfactory-part4-chat.md`) closed on 2026-11-02 on `feat/chat` (cut from `feat/board-redesign`). It had six tasks, and each passed a spec and quality review. The channel task also took one fix round and a re-review. The composer was checked in a browser in both themes and at 360 px. After the tasks came a whole-branch review ("with fixes"), one fix wave, and a re-review ("all addressed").

## Owner rulings recorded on the way
- After a send, the conversation stays as the person left it, and a short "Sent" note confirms the send. The thread no longer opens on every send.
- The standing OK from Part 3 still holds for robustness and correctness fixes to the plan's own code. Each fix is a dated note in the plan:
  - the channel's main-module check survives a symlink or junction;
  - the handshake never waits on the heartbeat;
  - the delivery copy is honest ("offered to the session", not delivered);
  - every session's channel offers unread messages, so no other session can take the live push.

## Owed before merge
- **The live check.** Start a session with `claude --dangerously-load-development-channels plugin:sfactory@sfactory`, send from the board, and see the message arrive and the reply appear. Run three cases:
  - one flagged session;
  - one unflagged session, where the message should be read at the factory's next step;
  - a flagged session plus an unflagged side session in the same repo.

  The check also confirms things no test can:
  - Claude Code's notification method and capability key;
  - the `meta` key rules;
  - the working directory Claude Code gives a plugin's MCP server (the channel finds its config from `process.cwd()`);
  - the reply tool's name and its permission prompt.

## Deferred (triaged "can wait")
- **Thread file:**
  - a torn line swallows the next entry;
  - `markPushed` takes any id;
  - a hostile `at` or reply id passes through;
  - a duplicate message id replaces the text;
  - the heartbeat write is not atomic;
  - every reader replays the whole thread on each poll (consider rotating the file);
  - two sessions can take one message through `sfactory chat unread` (documented: one flagged session per repo).
- **CLI:**
  - multi-line replies are not indented in `list`;
  - `list` with no messages prints nothing;
  - tests for `M<n>`, `list --card/--json`, a missing verb and multi-line text.
- **Routes:**
  - the card is checked before the text;
  - `JOB_CORRUPT` is not in `STATUS` (a bare 500, as on the file route);
  - tests for demo mode, a card-less message and the 200 cap.
- **Channel:**
  - no `-32600`/`-32700` errors;
  - `protocolVersion` is echoed unchecked;
  - a BOM on the first line skips it;
  - `pushNew` re-reads the whole thread;
  - a failed `markPushed` means a later process offers again (at-least-once by design).
- **Composer:**
  - a rebuild clears a text selection in the thread;
  - a failure note outlives a scope change;
  - `stop()` leaves the bar visible;
  - "Sent" can go unannounced when the poll right after it announces new replies.
- **Skills:** the channel's reply tool is not in `allowed-tools`. The skill prefers `sfactory chat reply`, which is already allowed.
