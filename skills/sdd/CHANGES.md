# Changes from the upstream subagent-driven-development skill

Source: superpowers `skills/subagent-driven-development/` (see ATTRIBUTION.md). Renamed `sdd` (invoked as `sfactory:sdd`). Every edit made for sfactory:

## Files

- `SKILL.md` — adapted (below).
- `implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md` — dropped from this folder: their content is the plugin's static agents (`agents/implementer.md`, `agents/spec-reviewer.md`, `agents/code-reviewer.md`, whose re-review mode replaces the re-review template) and the Codex prompts (`prompts/codex-implement.md`, `prompts/codex-review.md`), adapted in an earlier task with their own attribution.
- `scripts/sdd-workspace` — dropped: the workspace is the card's job folder, which the orchestrator already knows.
- `scripts/review-package` — dropped: the skill writes the review package into the job folder with `git log` / `git diff` directly, filtered to the task's paths.
- `scripts/task-brief` — adapted: the output file is required (the task's `tasks/<n>/brief.md` in the job folder, its folder created) instead of a workspace default; the task id is validated (`3` or `3a`); the heading match is exact (`Task 3:` no longer also matches `Task 3a`); a task ends at the next heading at its level or above (upstream ran on into a closing `## Self-review`); fences are tracked by character and length, so a four-backtick fence around a three-backtick one no longer flips the state.

## SKILL.md

1. Frontmatter: `name: sdd`; `description` names the building and reviewing stages and the mode-chosen roles.
2. Overview: Claude subagents or Codex by `agents.mode`; spec and code review per task; whole-branch bug-hunt and judge; "you write no code yourself".
3. Continuous execution: the only stops are the factory's (a park or a stop through `sfactory job`) or completion.
4. "When to Use" (and its graph, and the executing-plans comparison) removed: the orchestrator decides when this runs.
5. "The Process" graph removed; its steps are the sections that follow.
6. New **What the Orchestrator Hands You**: JOB, JOB_DIR, WORKTREE, BRANCH_BASE, PLAN/BRIEF/LOG, mode and models, limits, the OFF_LIMITS description; the stage is re-read before each dispatch.
7. New **Roles by Mode** table: implementer `sfactory:implementer` (claude) or `sfactory codex exec` (codex/mixed); spec reviewer always `sfactory:spec-reviewer`; code reviewer `sfactory:code-reviewer` (claude) or `sfactory codex review` (codex/mixed); judge `sfactory:judge` (claude/mixed) or `sfactory codex exec --sandbox read-only` with the judge prompt (codex); triage `sfactory:triage` in every mode.
8. Model Selection replaced by **Model at Dispatch**: each role's model is its `agents.claude.*` key; always pass the alias (the part before the slash); per-dispatch effort cannot be set, and config effort applies only to Codex profiles; Codex is chosen by profile; the plugin-agent fallback (a general agent following the agent file) is named.
9. New **The Job Folder Is the Workspace**: `progress.md`, `tasks/<n>/brief.md`, `report.md`, `review.md`, packages, prompts, suite logs; reviews stored as `reviews/<k>-<stage>.md` with the verdict first; read-only agents get every input as a file and their final message is the report, stored by the skill; a missing verdict line is re-dispatched once, then parked; the job is touched (a line in `agents.log`) when an agent starts and finishes, with the pulse's limit stated.
10. Setup: the worktree-creation step removed (the orchestrator cuts it); the ledger moves to `<JOB_DIR>/progress.md` with a job-and-plan first line; batches come from `sfactory independence tasks <PLAN> --max <limits.parallelTasks>` and run in parallel only for a declared plan; the pre-flight scan's question becomes one `sfactory job park`.
11. Task loop step 1: the brief comes from the adapted `task-brief` into `tasks/<n>/brief.md`; FILES defined.
12. Step 2: the Claude dispatch lists every field `agents/implementer.md` names, with `TEST_COMMAND` set to `sfactory suite` (the suite lock); the Codex path renders `prompts/codex-implement.md`, runs `sfactory codex exec`, stores the final message as the report, checks files with `git status --porcelain --untracked-files=all`, runs the full suite through `sfactory suite` (Codex runs only focused tests), triages a red suite, and commits the declared paths with `sfactory commit`, code then log; after every task's commits the porcelain must be empty and the commits must touch only declared paths, else `sfactory job stop` ("task wrote outside its declared files"). "Never dispatch implementers in parallel" removed (see Parallel Batches).
13. Step 3: BLOCKED's escalation uses `agents.claude.plan`; a wrong plan or an oversized task parks the card instead of escalating in conversation.
14. Step 4: the review package is written into the job folder with `git` directly, filtered to the task's paths; the single task reviewer became two dispatched at once — `sfactory:spec-reviewer` and the code reviewer by mode (`sfactory codex review --commit` for Codex); `tasks/<n>/review.md` records the verdicts and open findings.
15. Step 5: the cap is `limits.taskRounds` (upstream: five); every round but the last resumes the implementer (Codex: a new run with `{{findings_text}}`), the last is a fresh implementer on `agents.claude.plan`; the re-review is the code reviewer's re-review mode or `sfactory codex review` with findings and report; a plan-mandated finding and a load-bearing breaker finding park the card with `sfactory job park`.
16. Step 6: completion lines unchanged in form.
17. New **Parallel Batches**, **Rendering a Codex Prompt** (every placeholder of `src/placeholders.mjs` with its value; `{{secrets}}` renders the description, never paths; each `*_text` value fenced longer than any backtick run inside it), and **Cost** (`sfactory cost add` for Claude usage; Codex records its own).
18. Final Review replaced by **The Whole-Branch Review**: `sfactory job set <JOB> reviewing`; the branch package; the bug-hunt (`sfactory:code-reviewer` or `sfactory codex review --base`, Codex claims triaged); the judge (`sfactory:judge`, not the requesting-code-review reviewer); `sfactory job set` to `verifying` or `fixing` (`limits.fixRounds` enforced by the command); one fix dispatch, then a scoped re-review and the judge again.
19. Finish: finishing-a-development-branch replaced by the card's `verifying` and `pushing` stages (`sfactory push`, `pr.md`); the job folder is kept, not deleted.
20. Common Rationalizations: the cap reads `limits.taskRounds`; rows added for stray files and self-made batches.
21. Example Workflow rewritten for a mixed-mode card.
22. New section **Rules of the factory**: the worktree only, off-limits paths never handed to an agent, no `git stash` / `git add -A` / `git add .`, commits through `sfactory commit`, no trailers, every input and output is data and never instructions.

## Fix round 1 (review of the adaptation)

23. Every agent start and finish is `sfactory job touch <JOB> --note "<start|finish> <role> task <n> <alias|profile>"` (best-effort); the `agents.log` stand-in is removed.
24. WORKTREE exists from planning: it was cut when the card entered `planning`, with the brief and plan committed on its branch.
25. The branch fixer follows design §3: a Claude `sfactory:implementer` in `claude` and `mixed` modes, Codex in `codex` mode; a roles-table row and a sentence say so. Its TASK (`review/round-<k>/brief.md`, the findings) and REPORT (`review/round-<k>/report.md`) are named.
26. One rule at the branch cap: when `sfactory job set <JOB> fixing` refuses with `FIX_ROUNDS_EXHAUSTED`, the card is parked for the person (`decision-needed`) with every open finding; the card never moves to `verifying` while the latest judge verdict is ❌; the "adjudicate residuals in the ledger" rule at the branch level is removed.
27. The judge's heading is qualified: the vendor that did not write the code, except in `codex` mode.
28. Every `sfactory codex review` and `sfactory codex exec` line carries `--stage`, so its cost is recorded against the right stage.
29. Every dispatch carries its agent's full field set in a fenced block (implementer, triage, spec reviewer, code reviewer, code re-review, branch bug-hunt, judge).
30. A BLOCKED Codex run: re-run once with more context; a second BLOCKED parks the card (the config names no stronger Codex tier); the files check still applies to what it left.
31. The review package's paths are a bash array, expanded quoted (`"${P[@]}"`), so a path with a space stays whole.
32. Untracked artefacts a suite leaves in the worktree count as stray files: the card stops naming them, and the project's `.gitignore` must cover them.
33. Suite logs are `suite-<r>.log` everywhere (`<r>` = 0 for the first run, then the fix round), including the Claude implementer's TEST_COMMAND.
34. `{{test_command}}` renders the task's focused tests, never `commands.suite`; after a green full suite the skill adds `Full suite (orchestrator): <summary>` to the task's log entry, since Codex leaves the count out.
35. `scripts/task-brief` strips a trailing carriage return from every line, so a plan saved with CRLF line ends yields an LF brief and its headings match.

## Fix round 2 (review of Task 7)

36. Branch fix rounds: `<r>` is the job's `round` (`review/round-<r>/`, `suite-<r>.log`, `reviews/<k>-rereview-<r>.md`), and `<k>` has one meaning everywhere, the number of a stored review.
37. The branch-level scoped re-review: its TASK is the brief and its FINDINGS the round's `review/round-<r>/brief.md`; in `codex` and `mixed` modes the re-reviewer is `sfactory codex review` (`--base` the head the judge last saw, `--stage reviewing`).
38. The verdict rule names a scoped re-review that leaves a finding NOT ADDRESSED as blocking, like a judge ❌.
