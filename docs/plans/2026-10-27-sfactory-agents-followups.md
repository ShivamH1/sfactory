# sfactory agents (Plan C) — follow-ups after the whole-branch review (2026-10-28)

Plan C (`2026-10-27-sfactory-agents.md`) was built subagent-driven on `feat/agents` (with `feat/agents-skills` merged in): nine tasks, each reviewed on Opus with fix rounds, then a whole-branch review on Opus over `e9381c9..44a04e1` ("Ready to merge: with fixes") and one fix wave. This file carries every item that was parked or deferred, with its ruling, so nothing rests in the controller's ledger alone.

## The whole-branch review and its fix wave

Verdict: with fixes. The controller's mitigation came first: the reference project's `worktrees.copyFromBase` was emptied (it copied the API's credentials file into a card's worktree from planning on); the one card there (`f-1`) was still in backlog with no worktree, so nothing leaked. Every finding below was taken and built in the fix wave, each red first where testable:

| Id | Finding | Ruling, as built |
|---|---|---|
| C1 | A `copyFromBase` entry covered by `secrets.neverHandToAgents` reached the worktree, where agents work | Refused at the cut (`SECRET_PATH`, before anything is made); a new `worktrees.copyForVerify` is copied in by `services up` (or `services copy`, for a migration that needs it first) and removed by `services down`, `job stop` and `worktree remove`; `doctor` shows a `WARN` row on the overlap; INSTALL and the verify step say so |
| I1 | Long commands run in the foreground, past the Bash tool's timeout | The skills run Codex, the suite, build, typecheck, migrate and an afterCut-bearing cut with `run_in_background`; the suite lock records the suite's child pid and counts live while it lives |
| I2 | A fix card took a milestone's numbered brief and plan, and reserved its `{n}` | A fix card's brief and plan are in its job folder (`plan/brief.md`, `plan/plan.md`) unless `record.fix` gives patterns; it never reserves `{n}`; a `--log <n>` fix writes its entries and close in a dated section under `record.postCloseHeading` (sdd and pushing) |
| I3 | `commit` and `push` would run in the main checkout | Both refuse a tree that is not a registered worktree under `worktrees.dir`, and the main checkout itself (`MAIN_CHECKOUT`); `commit` also runs `assertFactoryBranch` |
| I4 | The cap and the parallel answer were skill text only | `job set planning` refuses a milestone at the cap (`CAP_REACHED`; queued cards do not count); `job approve` refuses a milestone beside an active one without a parallel yes (`PARALLEL_UNANSWERED`) |
| I5 | Brainstorming invoked writing-plans itself | It hands back to the orchestrator, whose plan role runs writing-plans |
| I6 | A fix card could be left in planning | The orchestrator moves it to building on `fixcard` exit 0 when it is still in planning, also on resume |
| I7 | allowed-tools granted `Bash(git *)` and `Bash(bash *)` | The git reads are `sfactory brief`, `sfactory diff` and `sfactory tree`; the task-brief script is ported and removed; allowed-tools are `Bash(sfactory *)`, `Bash(sfactory-* *)`, `Bash(agent-browser *)` and the non-Bash tools |
| I8 | Deferred items lived only in the ledger; the plan's boxes were unticked | This file; Tasks 1 to 8 ticked (Task 9 after the first real run) |
| Minor 1 | The Codex child kept database URLs and passwords | It also loses `DATABASE_URL`, `PGPASSWORD`, `*_PASSWORD`, `*_CREDENTIALS` and any `*_URL` carrying credentials; README says Claude subagents inherit the session's environment |
| Minor 2 | DESIGN drift | Status line, §11 (no polling), §4's fixing row, §12 (and the skill's verbatim copy) match what was built |
| Minor 3 | The npm channel promised Claude skills | Documented as the CLI and the Codex skills; INSTALL §6 names every copied file |
| Minor 4 | No way out of a stranded `live` lock | The verify step gives the recovery, on the person's word |
| Minor 5 | Queued cards counted toward the cap | They do not (I4) |
| Minor 6 | The cap park did not name the person's options | It names rework or stop |
| Minor 7 | A bare `--max` read as 1; `--max` above the limit; a Depends on label hidden in code | `BAD_ARGS`; capped at `limits.parallelTasks`; `PLAN_CODE_HIDES_TASK` |
| Minor 8 | The triage's diff left out new files | `sfactory diff ... WORKTREE` adds every new untracked file whole (I7) |
| Minor 9 | `afterCut` had no timeout | `worktrees.afterCutTimeoutMs` (default 30 minutes); the command's tree is killed at it and the cut undone (`AFTER_CUT_TIMEOUT`) |
| Minor 10 | How to stop the board | In the skill's board row, INSTALL and README |
| Minor 11 | No platform note | INSTALL and README: built and run on Windows; POSIX reasoned and unit-tested only |
| Minor 12 | Tests read the machine's global git config | `GIT_CONFIG_GLOBAL` points at an empty file, with a fixed identity |

One addition beyond the rulings, needed by C1: `sfactory services copy <id>` lands the verify copies without starting a service, because `commands.migrate` runs before `services up` and may need them.

## Parked by owner ruling (Task 1, the plan parser) — still open

Ruled 2026-10-28: one extra scoped round, then park. Mitigation in place: only a plan where every task carries its own Depends on label runs tasks in parallel (none of the reference project's 47 plans), and the orchestrator stops a card on any file left outside the declared list.

1. The comma state is lost on other wrapped lines (a plain wrap, a Consumes label naming no task), so the next path bullet is dropped.
2. A path bullet beside prose, or after a blank line, outside a label is dropped.
3. Dependency lines inside code were skipped, not refused. **Partly closed by Minor 7:** a Depends on label inside code is now refused. Still open: a loose "depends on" line or a Consumes line inside code is skipped, and a Depends on label indented under a list item after a blank line is read as the item's content, neither a label nor code (pinned in `plan.entry.test.mjs`).
4. A sibling path bullet inside code is skipped.
5. HTML comments are not covered by R1 (ruled).

Minors with them: R2 can newly refuse "- `b.ts` . `c.ts`"; R2 lets a Read-only task count as declared via a sibling bullet; B1 carries the comma across a blank line (fails closed); "Task 1, 10-07 ruling" over-serialises to [1, 7] (fail-safe); a pre-task `- Read:` line refuses the whole plan (brief-literal, kept); two Consumes lines in the reference plans 02 and 14 read as dependencies.

## Task 8 concerns, accepted

- Concern 1, ruled: kept as built. A card planned while another milestone is active is cut by `worktrees.baseRule` (`newest-feature-branch` stacks it on the partner, the owner's rule); `--base-of` is for a card the person asks to run side by side before it starts.
- Concern 2 (a `--log` fix's brief and plan sat beside the milestone's numbered files): **closed by I2**; a fix card's brief and plan are its own.
- Concern 3 (`worktree remove` should clear `job.record`): fixed in Task 8 fix round 2 and tested.

## Never run: POSIX

Every POSIX path is reasoned and unit-tested with stand-ins on Windows, never run on Linux or macOS: process groups and `kill(-pid)` in `killTree`, `followSignals`, `groupIsOurs` (`ps -A -o pgid=,sid=`, and pgid only on macOS), `ps -o etime` start times, detached suites and Codex runs, the suite lock's `childPid` (the orphan case exists only where the suite is detached), and the afterCut wrapper's group kill. Run the suite on a Linux and a macOS host before a release. Known gaps there: `killTree` skips surviving group members once the leader has exited; a detached Codex loses its graceful SIGINT; SIGQUIT and SIGTSTP are not followed; `fetchEnv` treats `GIT_SSH_COMMAND=""` as unset.

## Deferred minors (by task), left on purpose

- **Task 2:** the ports lock is held through every probe bind; `%(trailers)` refuses a "Refs: #12" body (brief-mandated); `integration()` reads local refs only (only `origin/development` falls back to `main`); `copyFromBase` copies from the base branch's checkout at its local commit.
- **Task 3:** `secrets.neverHandToAgents` mixes environment names and files (consider `secrets.envNames`); `quoteWin`'s `%VAR%` and trailing-backslash cases are untested; `profileModel`'s `^model=` can match a key under a later TOML table; the cached-token subtraction is unconfirmed against real Codex output.
- **Task 4:** `services down` exits 1 on a foreign pid (dropped from the record; the next `down` exits 0): the orchestrator reads the reason, not just the code; an unreadable start time is reported, never killed.
- **Task 5:** `init` reports defaults at top level only; untested: the 10-line window, the `packages/*` scan, develop/main precedence, the undo order.
- **Task 6:** a test title's backslash-b printed as a backspace (since guarded by the control-byte test); the `MODEL_ID` negative loop's first sample is dead; the rules-identity test did not normalise CRLF (**fixed in the fix wave**); commit's relative secret entries resolve against cwd (config makes them absolute).
- **Tests:** temp directories are not removed (plan.entry, independence.deps and most others).
- **Known load flakes:** `suite.test` killTree, the ports lock, concurrent `addCost`, and the services file under load; each passes alone.

## Found during the fix wave

- On win32 a plain `spawnSync` timeout left an afterCut grandchild holding the worktree folder, so the undo could not remove it; the command now runs under a wrapper that kills its tree.
- On win32 a non-detached suite dies with the CLI that started it (libuv's kill-on-close job), so the orphan the suite lock now guards against exists only on POSIX, where the suite is detached.
- The working copy on the build machine holds CRLF files (`core.autocrlf`); git normalises them on commit.
