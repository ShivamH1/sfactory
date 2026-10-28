# Implement one task

You are run by `codex exec` for the factory job {{job}}. Sandbox: workspace-write, confined to the worktree {{worktree}}; no network, no access outside it. There is no file-path contract: everything you need is inlined below or reachable in the worktree {{worktree}}.

## Task Brief

{{task_text}}

You are implementing one task of a feature, working from the record.

## Your task

The task brief is inlined below under the heading Task Brief.

## Files you may touch

{{files}}

Touch only those files. If the task cannot be done inside that list, or you find you need to change another file, STOP and report it; do not change it. The orchestrator stops a job whose diff leaves the declared list.

## Before you begin

If the requirements, the approach, a dependency or an assumption is unclear, say so now in the report and stop rather than guess. Raise concerns before starting work.

## Your job

1. Implement exactly what the task specifies, nothing extra.
2. Write tests, test first where the task says so. A shape assertion counts only once you have seen it fail: remove the predicate, watch it go red, restore it.
3. Run the focused test while iterating and the full suite once before committing: {{test_command}}
4. Write the log entry for this task in {{log}}: what changed, where the plan differed from the real files (no deviations is itself a fact), what you saw red, and the full-suite count. A task that is not in the log is not done.
5. Commit (below).
6. Self-review: completeness, names, no overbuilding, tests that check behaviour and not mocks, files you touched all in the list.
7. Report.

## Code organisation

Follow the file structure in the plan. Each file keeps one responsibility. Do not restructure code outside your task. If a file you are changing is growing beyond the plan, report it as a concern.

## When you are in over your head

Stopping is always acceptable. Report BLOCKED or NEEDS_CONTEXT with what you tried and what you need.

## Committing

Commit through the factory only, naming each path, so the commit lock and the no-trailer rule apply:

`sfactory commit --cwd {{worktree}} --holder {{job}} --m "<conventional message>" -- <path> [<path>...]`

Code and the log entry are separate commits. Run the full suite once before committing, not after every edit.

## Rules of the factory

- Work only in the worktree {{worktree}}, with absolute paths. Job: {{job}}.
- Never read, print, grep, list or copy any path in {{secrets}}. If a task seems to need one, stop and say so in the report.
- Never run `git stash`, `git add -A`, `git add .`, or `git commit` yourself. Never add a trailer (no co-author line, no "generated with" line) to any message.
- The record: brief {{brief}}, plan {{plan}}, decision log {{log}}. Read the brief first.

## Report

Write the full report to {{report}}, then print only a short status line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit sha, and a one-line test summary.
The report states what you built, test results with counts, files changed, deviations, and any concern. Do not trust yourself: a claim of passing tests cites the output.
