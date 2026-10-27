# sfactory core — follow-ups after the whole-branch review (2026-10-27)

The core plan (`2026-10-27-sfactory-core.md`) was built subagent-driven on `feat/core`: thirteen tasks, each reviewed on Opus with fix rounds, then a whole-branch review ("with fixes"), one fix wave of twelve commits and a clean scoped re-review. Final suite: 143 tests, 0 failures. This file carries forward what the reviews found but the core did not fix, so the next plans start from it rather than rediscover it.

## Decisions taken during the build (differ from the plan text)

- The CLI's command table lives in `src/registry.mjs`; command modules import `register` from there, never from `cli.mjs` (a self-registration through `cli.mjs` deadlocked the dynamic import).
- The lock was redesigned twice after aligned-process races: per-acquire token ownership; `pid: null` for CLI-held locks (age-based staleness); durable locks for worktrees (never stale); takeover serialised through a `.takeover` guard file that is never auto-cleared (`sfactory lock clear <name> --guard` is an operator's decision); release reads before it moves; a lock naming a live pid is never stale by age (the fix wave's I2 — the plan's Revision 1 text still describes the older age rule).
- The plan parser accepts real-world Files lines (trailing prose that names no path, eleven ops, continuation lines, `**Files:**` lines, file-less tasks that name no path) and fails closed otherwise: 31 of the reference project's 47 plans parse; the 16 refusals are three design docs with no task headings, seven plans that describe files without naming them (two hide migrations), and six close-out tasks that name files in prose with no Files line.
- `commit` finds trailers with `git interpret-trailers --parse` plus a regex, checks `%(trailers)` after the commit, runs `git add`/`commit` with `--literal-pathspecs`, and refuses whole-tree pathspecs; the glob refusal was dropped (literal pathspecs make it redundant and it blocked `[id].tsx`).
- `push` uses the full refspec, fetches only its branch, refuses an empty `branchPrefix`, and never merges.

## Plan B (the board) — entry criteria

- **The job store has no concurrency control** (final review I8). Every `job` sub-command is read → transition → write with no lock; two `job add` calls can take one id; `nextDecisionNo` and `addCost` are check-then-write; `writeJob`'s temp name is fixed. The board will be a second writer. Before it writes: a per-job lock (or compare-and-swap on `updated`) inside `writeJob`, a unique temp name with a retry on EPERM/EBUSY, and `job add` creating its folder exclusively. The board writes only through `job.mjs`.
- Two cuts of one job with different slugs can both write (last wins, one worktree and durable lock orphaned); `job.mjs`'s own read-modify-write can overwrite a cut's fields. Both close with the per-job lock above.

## Plan C (orchestrator, skills, Codex) — entry criteria

- **`taskBatches` treats every task without a `Depends on` line as independent** (final review I7). None of the reference project's plans carries such lines; they express order through "Interfaces: Produces/Consumes". Before the orchestrator dispatches parallel implementers from `taskBatches`: run a plan with no dependency information sequentially or refuse it; read "Consumes" and "after Task N" as dependencies; apply the migrations rule inside a milestone; make the adapted writing-plans skill always emit `Depends on`.
- **Five parked parser holes (Task 10, N1–N5)**, none affecting the 47 real plans, each a false-ok on a crafted plan: a heading at the task's level silently ends the task and drops later Files lines (should be `PLAN_FILES_OUTSIDE_TASK`); a `read` line can hide a write and marks the task "declared"; a continuation after a trailing comma swallows a `Depends on` line; extension-less names (`Makefile`, `src`) and quote-led paths are dropped as prose; `- <op>: none` exempts a task from the "names no path" rule. Fix as one focused task with the acceptance script over the 47 plans.
- Other parser minors: brace and glob paths never overlap concrete ones (plan 02 has 19); sibling-relative bare names cannot match a full path in another plan; hotspot directories are matched one way only; case-sensitive matching; `--max` bare or above the cap.
- **Push does not re-check trailers** (I9): a commit-msg hook's trailer, or a Codex implementer's own commit, reaches `push` unseen. When `git.trailers` is not true, refuse a push if any commit in `base..HEAD` has a non-empty `%(trailers)`.
- **The fix-round cap** belongs in `transition()` (refuse `→ fixing` when `round >= limits.fixRounds`), a script refusal, not a skill rule.
- `push` should refuse the integration branch, `main` and `master` by name and require the prefix to end in `/` (a prefix `m` admits `main`).
- `resolveBase` reads local branches without a fetch (the reference project's local integration branch lags its remote by hundreds of commits): fetch or warn.
- `allocate` takes no lock: two cards can get one port block when milestones run in parallel; wrap it in `withLock("ports")`.
- `fixCardRefusals`, `secrets.neverHandToAgents` and the `services` runner are read by nothing yet.
- Worktree: `branchCreated` is set before the add (rollback could delete a branch another tool created in the window); `copyFromBase` is silent when the base has no worktree; `afterCut` has no timeout and drops stdout; `git()` error text is unbounded (fetch stderr may echo credentials).
- Commit: paths stay staged after a failed `git commit`; a leading blank line in a message is a false `TRAILER_REFUSED`.
- Doctor: creates `stateDir` and the worktrees dir as a side effect; checks the ports base only, not the block.
- A repo whose separate git dir is itself named `.git` resolves to the wrong root; a bare repo's or a submodule's worktree falls back to its own top level (config and state per worktree) — documented, not fixed.

## Before publishing to npm

- `package.json` `files` lists `board`, `skills`, `agents`, `prompts`, `INSTALL.md` that do not exist yet; confirm with `npm pack --dry-run` on a machine where it runs (EPERM here).
- README: `sfactory-ports` is "allocate and free", not "allocate and show"; the Codex profile model id must be a real one or an obvious placeholder.
- `examples/thrive-rewards.config.json` ships the reference project's name, package scope, paths and an internal note — the owner decides whether to anonymise it.
- `validateConfig` accepts unknown keys silently while the schema says `additionalProperties: false`; it does not type-check `stateDir`, `worktrees.dir`, the `limits.*` timing keys or `commands.services`.
- Tests: `node --test` discovery also runs `test/helpers.mjs` and `test/fixtures/lock-child.mjs` (harmless) and would run anything under a `test/` folder in the gitignored `.superpowers/`; the lock test (a) and the suite kill test each take seconds and can flake on a loaded machine; the M5 permissions test fails rather than skips when ACLs cannot be changed; test temp directories are never removed; the examples test passes on an empty directory; nothing pins the Thrive example to the design's §8.
- Lock: `status` hides a live holder's name while any guard exists; an EPERM from a delete-pending file at the deadline is worded as a permissions problem; `clearGuard` has no age floor and the two-holder consequence of clearing a live taker's guard is stated only as a precondition.
- Suite: the tail splits on chunk boundaries; `CI=1` overrides the user's environment (document it); a stream error during the trailer flush is silent.
- Cost: concurrent `addCost` calls can lose entries; the library does not validate its inputs.
- `sfactory suite` exits with the suite's own code, which can collide with the CLI's 2 and 3.
