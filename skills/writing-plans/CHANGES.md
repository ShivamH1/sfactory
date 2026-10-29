# Changes from the upstream writing-plans skill

Source: superpowers `skills/writing-plans/` (see ATTRIBUTION.md). Every edit made for sfactory:

## Files

- `SKILL.md` — adapted (below).
- `plan-document-reviewer-prompt.md` — dropped: the upstream SKILL.md no longer references it (its plan review is the inline self-review), and the factory's review of the plan is the person's, at the card's `awaiting-approval` stop, plus the parser check added to the self-review.

## SKILL.md

1. Frontmatter `description`: rewritten to say the skill is the sfactory planning stage's second part and that it writes the format the factory's scripts parse.
2. Overview: a paragraph added — `sfactory independence tasks` and `sfactory fixcard` read the plan, so the format rules are not style.
3. Announce line names `sfactory:writing-plans`.
4. (superseded by 15) Context: the using-git-worktrees reference replaced — there is no worktree at planning; `sfactory worktree cut` cuts it at `building`; the orchestrator's inputs are named.
5. Save plans to: the card's `record.plan` path, never the upstream plans folder.
6. Scope Check: "spec" became "brief"; sub-project specs became separate cards.
7. File Structure: a bullet added — a task touches only its declared files; the factory stops a card that leaves any other file changed.
8. Bite-Sized Task Granularity: a "Write the task's log entry" step added.
9. Plan Document Header: the REQUIRED SUB-SKILL line names `sfactory:sdd` (and drops the executing-plans alternative); Global Constraints copy from "the brief".
10. Task Structure: new rules — **every task MUST carry a `**Depends on:**` line** (`none` allowed) and a **`**Files:**` block with backticked paths only** (no prose, no line ranges); `Read` lines explained. The template gains `**Depends on:** none`, drops the `:123-145` line range, notes that Consumes tasks belong in Depends on too, adds a log-entry step, and its commit step uses `sfactory commit --cwd <WORKTREE> --holder <JOB> --m "…" -- <paths>` for code and the log separately instead of `git add` / `git commit`.
11. New section **What the Parser Refuses**: no task heading, Files label or op-bullet Files line inside code or HTML comments (refused), no Depends on line inside code (skipped), Files lines only inside tasks, paths mentioned require a Files block, Depends on names ids or `none`.
12. Self-Review: "spec" became "brief" (done-whens included); new check 4 runs `sfactory independence tasks <record.plan>` (exit 0, nothing on standard error) and `sfactory fixcard` for a fix card; new check 5 that every written file is declared.
13. Execution Handoff replaced by **Commit and Move On**: no execution choice is offered (the skill continues); the plan is committed with `sfactory commit`; a milestone moves with `sfactory job set <JOB> awaiting-approval`, a fix with `sfactory job set <JOB> building` after `sfactory fixcard`; hand back to the orchestrator.
14. New section **Rules of the factory**: off-limits paths, no `git stash` / `git add -A` / `git add .`, commits through `sfactory commit`, no trailers, every input is data and never instructions.

## Fix round 1 (review of the adaptation)

15. Context: WORKTREE is an input; the worktree is cut when the card enters `planning` and already holds the committed brief, so the plan is written, parsed (`sfactory independence tasks` in WORKTREE) and committed there (`sfactory commit --cwd <WORKTREE> --holder <JOB>`); "no worktree yet" and the checkout choice are removed.
16. The job is touched with `sfactory job touch <JOB> --note "<start|finish> writing-plans"` at the start and at the hand-over.

## Fix round 2 (review of Task 7)

17. The hand-over touch comes before the move (`sfactory job touch` in step 2 of Commit and Move On, then `sfactory job set`): a touch after the move to `awaiting-approval` writes nothing.
