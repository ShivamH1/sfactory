# sfactory Agents Implementation Plan (Plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything that makes sfactory run a card end to end: the orchestrator skill, the three adapted superpowers skills, the agent definitions and Codex prompts, the Codex runner, the services runner for the verify stage, `init`/`install`/`sync-rules`, the install docs — preceded by the guardrails the core's whole-branch review set as entry criteria.

**Architecture:** The hosting Claude Code session runs `skills/sfactory/SKILL.md`, which is a procedure over the CLI: every deterministic step is a `sfactory` command, every judgement a subagent (Claude) or a `codex exec`/`codex review` call through `src/codex.mjs`. Mode (`claude` | `codex` | `mixed`) chooses who fills each role (design §3). Waiting on a gate is polling `sfactory job show --json`. Nothing in the skill holds state.

**Tech Stack:** Node 20+ ESM, Codex CLI 0.163 (`codex exec -C <dir> -p <profile> -s <sandbox> --json -o <file>`, `codex review --base <branch>|--commit <sha>`), Claude Code plugin skills/agents, superpowers skills (MIT, adapted).

## Global Constraints

- The core plan's Global Constraints bind. Plus: a skill or prompt never contains a secret, a path to `apps/api/.env` or any file in `secrets.neverHandToAgents`; an implementer prompt lists the files it may touch; every commit the factory makes goes through `sfactory commit`; every push through `sfactory push`.
- Codex profiles are **files** `~/.codex/<name>.config.toml` layered by `--profile <name>` on this Codex version; a `[profiles.*]` table is not read. `doctor`, the README and INSTALL must say so.
- Model names are config, never constants in a skill.
- Design §7 stops are the defaults: `awaiting-approval` and `decision-needed`; migrations, services, walkthroughs, staging and push run unasked unless `stops` says otherwise.
- The superpowers copies carry an `ATTRIBUTION.md` (MIT, Jesse Vincent) and a `CHANGES.md` listing every edit.

---

## File structure

```
src/
  plan.mjs  independence.mjs           (Task 1: entry criteria)
  push.mjs  job.mjs  ports.mjs  worktree.mjs  (Task 2: guardrails)
  codex.mjs                            runCodexExec, runCodexReview, parseCodexUsage
  services.mjs                         up/down of commands.services with port substitution
  rules.mjs                            syncRules, checkRules
  init.mjs  install.mjs
  commands/ codex.mjs services.mjs init.mjs install.mjs sync-rules.mjs fixcard.mjs
scripts/acceptance-plans.mjs           parse every plan in a dir, print the table
agents/ implementer.md spec-reviewer.md code-reviewer.md judge.md triage.md
prompts/ codex-implement.md codex-review.md codex-judge.md
skills/
  sfactory/SKILL.md
  brainstorming/  writing-plans/  sdd/   (adapted copies + ATTRIBUTION.md + CHANGES.md)
INSTALL.md  README.md (rewritten)  .claude-plugin/plugin.json (version 0.2.0)
bin/ sfactory-codex sfactory-services sfactory-init sfactory-install sfactory-sync-rules sfactory-fixcard
test/ plan.entry.test.mjs independence.deps.test.mjs push.guard.test.mjs job.cap.test.mjs ports.lock.test.mjs
      codex.test.mjs services.test.mjs rules.test.mjs init.test.mjs install.test.mjs fixcard.test.mjs skills.test.mjs
```

---

### Task 1: Parser entry criteria — N1–N5 and dependency inference

**Files:** Modify `src/plan.mjs`, `src/independence.mjs`, `src/commands/independence.mjs`; create `scripts/acceptance-plans.mjs`, `test/plan.entry.test.mjs`, `test/independence.deps.test.mjs`.

**Interfaces:**
- `parsePlan` additionally: a Files line or `**Files:**` label met while no task is open → `PLAN_FILES_OUTSIDE_TASK`; `read` lines never add to the task's "declared" state, and a read line in the colon-less form or carrying prose beside its items records its items as `touch`; `Depends on`/`**Depends on:**` is tested before the continuation branch; the first backticked item after an op counts as a path when it is a bare `[\w.-]+` word, and an allow-list (`Makefile Dockerfile Containerfile Procfile Gemfile Rakefile Jenkinsfile Vagrantfile Brewfile Justfile justfile LICENSE LICENCE COPYING NOTICE README CHANGELOG AUTHORS CODEOWNERS VERSION`) applies in any position; a Files line yielding no paths and not saying `none` passes its text to the mention check; `- <op>: none` no longer exempts a task (only the `**Files:** none` label does). Dependencies also come from `**Consumes:**` lines naming `Task N` and from `(after Task N)`; `plan.dependencyInfo` is `"declared"` when any task has a dependency line, else `"none"`.
- `taskBatches(plan, max, { allowUndeclared = false })`: when `plan.dependencyInfo === "none"` and `allowUndeclared` is false, every task is its own batch in plan order (sequential); the migrations rule applies inside a batch (two tasks each adding a file under `migrations.dir` never share one). `checkMilestones` unchanged.
- `scripts/acceptance-plans.mjs <dir>` prints `file | tasks | code` and a summary line; the test runs it over `test/fixtures/plans/`.

- [x] Tests for each item (crafted plans), seen red first; the acceptance over the reference project's `spec/plans/` run by the implementer outside the repo and pasted in the report: expected still 31 parse / 16 fail, with no plan newly failing. Commit `fix(plan): the five parked holes closed; dependencies from Consumes; undeclared plans run sequentially`.

---

### Task 2: Guardrails — push trailer re-check, protected branches, fix-round cap, ports lock, base fetch, fix-card refusals

**Files:** Modify `src/push.mjs`, `src/job.mjs`, `src/ports.mjs`, `src/worktree.mjs`, `src/config.mjs`; create `src/fixcard.mjs`, `src/commands/fixcard.mjs`, tests.

**Interfaces:**
- `push`: when `c.git.trailers !== true`, refuse `PUSH_TRAILERS` if any commit in `origin/<integration>..HEAD` (or the branch's first commit when no remote branch) has a non-empty `%(trailers)`, naming the first offending sha; refuse `BRANCH_REFUSED` for `main`, `master` and `worktrees.integrationBranch`; `validateConfig` requires `branchPrefix` to end in `/`.
- `transition(job, "fixing")` refuses `FIX_ROUNDS_EXHAUSTED` when `job.round >= limits.fixRounds` (the limit passed in `opts.limits`; the CLI passes `c.limits`).
- `allocate` runs under `withLock(c, "ports", { holder: HOLDER, waitMs: 10_000 })`.
- `resolveBase`: when a remote `origin` exists, `git fetch --quiet origin` first; a fetch failure is a warning on stderr, never a stop; `--no-fetch` skips it.
- `checkFixCard(c, plan) -> { ok, hits: [{ file, pattern }] }` over `fixCardRefusals` patterns (`**` = any depth, `*` = one segment); `sfactory fixcard <plan>` exits 1 and names the hits; a hit means the card is refiled as a milestone (the skill does the refiling).
- [x] Tests for each; commit `feat: push trailer re-check and protected branches, fix-round cap, ports lock, base fetch, fix-card refusals`.

---

### Task 3: The Codex runner

**Files:** Create `src/codex.mjs`, `src/commands/codex.mjs`, `bin/sfactory-codex`, `test/codex.test.mjs`; modify `src/doctor.mjs` (profile check), `README.md` (Codex section).

**Interfaces:**
- `runCodexExec(c, { cwd, profile, prompt, sandbox = "workspace-write", outDir, timeoutMs = 3_600_000, spawn = child_process.spawn })` → `{ ok, exitCode, lastMessage, usage: { inputTokens, outputTokens } | null, logPath, lastMessagePath, durationMs }`. Spawns `codex exec -C <cwd> -p <profile> -s <sandbox> --json -o <outDir>/last-message.md --skip-git-repo-check=false` with the prompt on stdin (always stdin, never argv), env without any key named in `secrets` (and without `*_SECRET`, `*_TOKEN`, `*_KEY` beyond `CODEX_*`/`OPENAI_*`), streams the JSONL to `<outDir>/codex.jsonl`, parses usage leniently from events carrying `usage`/`token_count`/`input_tokens` (null when none), kills the tree on timeout. Refuses `CODEX_MISSING` when `codex` is not on PATH, `CODEX_PROFILE_MISSING` when `~/.codex/<profile>.config.toml` is absent.
- `runCodexReview(c, { cwd, base, commit, prompt, profile, outDir })` → `{ ok, text, logPath }` via `codex review [--base|--commit] -` with the prompt on stdin.
- `doctor`: the profile rows check `~/.codex/<name>.config.toml` exists (not a `[profiles.*]` table); README's Codex section gives two files `implement.config.toml` / `review.config.toml` (model and `model_reasoning_effort` keys, sandbox left to the flag).
- CLI `sfactory codex exec --cwd <dir> --profile <p> --out <dir> [--sandbox s] < prompt` and `sfactory codex review --cwd <dir> --base <b>|--commit <sha> --out <dir> < prompt`; both record cost with `addCost` when usage is known.
- [x] Tests with an injected `spawn` that fakes the JSONL stream (no real Codex call); one opt-in integration test `SFACTORY_CODEX_LIVE=1` that runs `codex exec -s read-only "say ok"` (skipped by default). Commit `feat(codex): exec and review runners with usage capture; doctor checks profile files`.

---

### Task 4: Services runner for the verify stage

**Files:** Create `src/services.mjs`, `src/commands/services.mjs`, `bin/sfactory-services`, `test/services.test.mjs`.

**Interfaces:**
- `servicesUp(c, job, { log })` starts every `commands.services` entry for the card: `cmd` and `env` values with `{port.<name>}` substituted from `job.ports`, cwd the job's worktree, stdout/stderr to `<jobDir>/verify/<name>.log`, pids recorded in `<jobDir>/verify/services.json`; `servicesDown(c, job)` kills them (tree kill on win32) and removes the record; `servicesStatus(c, job)` reports alive pids. An entry with `"live": true` requires the `live` lock to be held by this job (`LIVE_LOCK_REQUIRED`). `sfactory services up|down|status <id>`.
- [x] Tests with `node -e` sleepers; commit `feat(services): start, stop and inspect a card's services on its port block`.

---

### Task 5: `init`, `install`, `sync-rules`

**Files:** Create `src/init.mjs`, `src/install.mjs`, `src/rules.mjs`, their commands and shims, tests; modify `README.md`.

**Interfaces:**
- `sfactory init [--force]`: refuses an existing config without `--force`; inspects `package.json` (`scripts.test` → `commands.suite`, `scripts.build`, workspaces → hotspots suggestion `packages/*`), `pyproject.toml`/`uv.lock` (`uv run pytest`), `git` (branches `development`/`develop`/`main` → `integrationBranch`; `feature/*` present → `baseRule: newest-feature-branch`), a `spec/` tree with `modules`/`plans`/`decisions` → `record.style: spec-tree` with the templates, `CLAUDE.md`/`AGENTS.md` → `rules`, `prisma/migrations` → `migrations.dir`; writes the config with a `// generated by sfactory init` first-line comment stripped (JSON) and prints every guess and every key it left at the default; appends `.sfactory/` to `.gitignore` when `stateDir` is inside the repo.
- `sfactory install [--codex] [--dest <dir>]`: copies `skills/`, `agents/` and `prompts/` from the plugin root (`${CLAUDE_PLUGIN_ROOT}` or the package's own dir) into `<repo>/.claude/` (or `~/.codex/skills/` with `--codex`); never overwrites a file that differs without `--force`; prints what it copied.
- `sfactory sync-rules [--check]`: copies `rules[0]` over every other `rules` entry (CRLF-normalised compare; `--check` exits 1 when they differ and writes nothing); the first line of a copy is rewritten from "guidance to Claude Code" to the other tool's name when it matches that phrase.
- [x] Tests on temp repos; commit per command.

---

### Task 6: Agents and Codex prompts

**Files:** Create `agents/implementer.md`, `agents/spec-reviewer.md`, `agents/code-reviewer.md`, `agents/judge.md`, `agents/triage.md`, `prompts/codex-implement.md`, `prompts/codex-review.md`, `prompts/codex-judge.md`, `test/skills.test.mjs` (frontmatter and placeholder checks).

**Interfaces:**
- Each agent file: frontmatter `name`, `description`, `model` (from a placeholder the skill fills from config), `tools` (reviewers and judge: read-only — `Read, Grep, Glob, Bash(git log *), Bash(git diff *)`); body built from superpowers' `implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md` and `code-reviewer.md` with the factory's additions: the files it may touch (`{{files}}`), the record paths (`{{brief}}`, `{{plan}}`, `{{log}}`), the commit rule (`sfactory commit --cwd {{worktree}} --holder {{job}} --m "…" -- <paths>`; never `git commit`), no trailers, never read `{{secrets}}`, the report path.
- Codex prompts: the same content shaped for `codex exec` (a single Markdown prompt with the brief inlined under a heading, since Codex has no file-path contract), the sandbox rule, and the report contract (write the report file, print the short status).
- Placeholders are `{{name}}`; the test asserts every placeholder used in a file is in the known set and no file contains `.env`, `SECRET` or a model id literal.
- [x] Commit `feat(agents): agent definitions and Codex prompts`.

---

### Task 7: The three adapted skills

**Files:** Create `skills/brainstorming/`, `skills/writing-plans/`, `skills/sdd/` as copies of `~/.claude/skills/{brainstorming,writing-plans,subagent-driven-development}` (the copies of superpowers on this machine) with `ATTRIBUTION.md` and `CHANGES.md` each; extend `test/skills.test.mjs`.

**Changes to make (each listed in `CHANGES.md`):**
- brainstorming: the design doc goes to `record.brief` (the project's brief path for the card), not `docs/superpowers/specs/`; the visual companion section is removed; the "commit the design document" step becomes `sfactory commit`; a milestone's brainstorm ends by writing `plan/questionnaire.md` when questions remain, and the stage moves to `awaiting-approval` through `sfactory job set` after writing-plans; stories first when `record.stories` exists.
- writing-plans: the plan goes to `record.plan`; **every task MUST carry a `**Depends on:**` line** (`none` allowed) and a `**Files:**` block with backticked paths only; the header's "REQUIRED SUB-SKILL" names `sfactory:sdd`; the execution handoff offers nothing (the skill continues).
- sdd: the workspace is the job folder (`tasks/<n>/brief.md`, `report.md`, `review.md`); the implementer is `sfactory:implementer` (claude) or `sfactory codex exec` (codex/mixed); the code reviewer is `sfactory:code-reviewer` (claude) or `sfactory codex review` (codex/mixed); the spec reviewer is always `sfactory:spec-reviewer`; BASE/HEAD and review packages use the same `review-package`-style diff file written by `sfactory` (add `sfactory diff <base> <head> --out <file>` to Task 2's guardrails? — no: the skill shells `git diff` into the job folder directly); the fix loop's cap is `limits.taskRounds`; the final whole-branch review is the judge (`sfactory:judge`), not `requesting-code-review`; "finishing-a-development-branch" is replaced by the pushing stage.
- [x] The test checks: each skill folder has `SKILL.md`, `ATTRIBUTION.md`, `CHANGES.md`; no `docs/superpowers` string remains; `writing-plans/SKILL.md` contains "Depends on"; `sdd/SKILL.md` names `sfactory codex exec`. Commit `feat(skills): adapted brainstorming, writing-plans and sdd with attribution`.

---

### Task 8: The orchestrator skill

**Files:** Create `skills/sfactory/SKILL.md`; extend `test/skills.test.mjs`.

**Content (sections, in order):**
1. Frontmatter: `name: sfactory`, `description` (when to trigger: any `/sfactory …` or a request to run the factory), `allowed-tools` listing `Bash(sfactory *)`, `Bash(sfactory-* *)`, `Bash(git log *)`, `Bash(git diff *)`, `Read`, `Agent`.
2. **Argument parsing** of `$ARGUMENTS`: the eleven commands of design §10 (`init doctor add run approve answer parallel status board rework stop clean`), each mapped to the CLI line it runs or the procedure it starts; unknown → print usage.
3. **Orientation**: `sfactory doctor` must be green before `run`; read `sfactory.config.json` for mode and record paths; never read any file in `secrets.neverHandToAgents`.
4. **`run`**: list cards (`sfactory job list --json`); for each in stage order work one step: `backlog` → `planning` (milestone: §5 of this doc; fix: write a one-page brief at `record.brief`, run `sfactory fixcard <brief>` and refile on a hit); `planning` → brief + plan written → `awaiting-approval` (milestone) or `building` (fix); `awaiting-approval` → wait (poll `sfactory job show <id> --json` every 30 s; the board or `/sfactory approve` releases it); `building` → cut the worktree if none (`sfactory worktree cut`), allocate ports, then the task loop (the sdd skill) with `sfactory independence tasks <plan> --max <limits.parallelTasks>` deciding batches (sequential when undeclared), each task's commit via `sfactory commit`, each task's log entry in `record.log`; after the last task → `reviewing`; `reviewing` → bug-hunt (`sfactory codex review --base <base>` or `sfactory:code-reviewer`) then the judge (`sfactory:judge` with the brief's done-whens) → `verifying` or `fixing`; `fixing` → fix the findings (a subagent or codex), `sfactory suite`, back to `reviewing` (the cap is enforced by `job set`); `verifying` → take the `live` lock (`sfactory lock acquire live --holder <id> --durable`), `commands.migrate`, `sfactory services up`, the walkthrough (headed `agent-browser` when present, else the brief's scripted checks), `sfactory services down`, release `live` → `pushing` (or `fixing` on a finding); `pushing` → the record's closing section, plan ticks, `sfactory push`, write `pr.md` (title: the card's title; body: summary, the review verdicts, the base branch) → `pushed`; `pushed` → nothing (the board detects the merge; `/sfactory merged` by hand); `decision-needed` → wait as for approval; `stopped` → `sfactory job resume` only on `/sfactory run` with `--resume <id>`.
5. **Parallel milestones**: when `add milestone` is called while another is `building`, run `sfactory independence milestones <planA> <planB>`; park the new card `--pending parallel` with the rows in `plan/parallel.md`; after `--yes`, cut from the same base head and work both, serialising on the `suite` and `live` locks; the second to finish merges the first before pushing.
6. **Roles by mode** (the table of design §3) as the single place the skill decides who runs; the model names come from `agents.claude.*` and the profile names from `agents.codex.*`.
7. **Cost**: after every subagent or Codex call record `sfactory cost add` when usage is known.
8. **Stops**: the `stops` list; anything in it parks the card instead of running.
9. **Never**: the design §12 list, verbatim.
- [x] The test checks the eleven commands are each mentioned with their CLI line and that no model id or secret path appears. Commit `feat(skill): the sfactory orchestrator`.

---

**Amendment (2026-10-28, controller, from the Plan C reviews; binding for Task 8):**
- The worktree is cut when a card ENTERS planning, not at building: on `backlog` -> `planning` run `sfactory worktree cut <id>` (milestone and fix cards alike) before brainstorming, skip it when `job.worktree` is already set (resume, changes requested), and hand WORKTREE to brainstorming and writing-plans; the brief, stories and plan are written and committed inside the worktree. At `awaiting-approval`, tell the person the brief and plan are on the card branch in WORKTREE (the board shows only job-folder files). `building` no longer cuts.
- `fixcard` and `independence` take the plan as `<WORKTREE>/<record.plan>` (absolute path).
- allowed-tools must cover what the skills really run: `Bash(sfactory *)`, `Bash(sfactory-* *)`, `Bash(git *)` (the sdd skill uses `git -C <WORKTREE> ...`, `git ... status --porcelain`, `git diff`), `Bash(bash *)` (the sdd `task-brief` script), `Read`, `Write` (job-folder files), `Agent`.
- Agent activity: `sfactory job touch <id> --note "<start|finish> <role> ..."` at every agent start and finish (best effort; skipped outside working stages).
- Every subagent dispatch passes a model ALIAS from `agents.claude.*`; per-dispatch effort cannot be set (config effort applies to Codex profiles only).
- Codex never commits; its final message is its report; the orchestrator commits the declared paths with `sfactory commit` and runs the full suite through `sfactory suite` after each Codex task.
- After each task commit `git -C <WORKTREE> status --porcelain` must be empty, else STOP the card ("task wrote outside its declared files").
- Reviews are stored as `reviews/<n>-<stage>.md` in the job folder, verdict on the first line.
- At the branch fix-round cap (`FIX_ROUNDS_EXHAUSTED`), park the card `decision-needed` with the open findings; never move to `verifying` while the judge, the bug-hunt or a scoped re-review says Needs fixes.
- A second commit in this task, `fix(skills): Task 7 review minors`, carries: writing-plans hand-over touch moved before `job set awaiting-approval`; writing-plans CHANGES item 4 and brainstorming CHANGES item 8 marked "(superseded by 15)"; the sdd Fixing paragraph (branch fixer logs to `suite-<r>.log`; one meaning of `<k>`; branch-level TASK/FINDINGS are the brief and `review/round-<k>/brief.md`; codex/mixed re-reviewer is `sfactory codex review`); the sdd verdict rule names a scoped re-review NOT ADDRESSED as blocking; `cutJob` undo in src/commands/worktree.mjs runs `git worktree prune` before `branch -D` when it added the worktree.

**Note (2026-10-28, Task 8 fix round 1, from the Opus review):** item 4's "`awaiting-approval` → wait (poll `sfactory job show <id> --json` every 30 s …)" and "`decision-needed` → wait as for approval" are replaced: at a gate the session ends its turn, naming what releases each card (`/sfactory approve|answer|parallel <id>` or the board) and then `/sfactory run`, which is idempotent. Only when the person asks to keep watching does it run a bounded Monitor loop (a check every 30 s, at most 30 minutes); there is no `sleep` polling and `Bash(sleep *)` is not in allowed-tools (`Monitor` is). Item 5's parallel check moves from `add milestone` to the card's real plan, after the plan commit and before `awaiting-approval` (`park --pending parallel` is legal from `planning`), and the four CLI additions (`worktree cut --base-of`, `job request-changes`, `job add fix --log` with `job.record` resolved at the cut, `worktree merge --from`) replace the skill's workarounds.

**Note (2026-10-28, Plan C final review, I7):** the amendment's allowed-tools list above (`Bash(git *)` for the sdd skill's git reads, `Bash(bash *)` for its `task-brief` script) is replaced. The git reads are sfactory verbs: `sfactory brief <plan> <n> --out <file>` (the script, ported to src/brief.mjs and removed), `sfactory diff --cwd <worktree> <base> <head|WORKTREE> (--out <file> | --names | --commits) [-- <paths>]` and `sfactory tree <worktree> [--head]`. allowed-tools are `Bash(sfactory *)`, `Bash(sfactory-* *)`, `Bash(agent-browser *)` and the non-Bash tools only; the skills test refuses a skill that runs git or bash directly.

### Task 9: Install docs, versions, package check, first run

**Files:** Create `INSTALL.md`; rewrite `README.md`; modify `.claude-plugin/plugin.json` and `package.json` (version `0.2.0`), `examples/thrive-rewards.config.json` (anonymise if the owner says so).

- [ ] INSTALL.md: the plugin channel (the two commands and the one-step form), the npm channel, the Codex profile files, `init`, `doctor`, `board`, updating. README: what it is, a 90-second walkthrough of one card, the board, the modes, the commands, licence and attribution.
- [ ] `npm pack --dry-run` on a machine where it runs, or `npm pack` into a temp dir here and list the tarball; the plugin loads in a fresh Claude Code session (`/plugin marketplace add <local path>` then `/plugin install sfactory@sfactory`; `/sfactory status` answers) — the controller does this step and records the result.
- [ ] **First real run (controller, with the user informed)**: install the plugin in the Thrive repo, `sfactory init` (expect the Thrive example), `doctor` green after the two profile files exist, add one small **fix** card (user ruling, 2026-10-28: `19.1-CARRIED-FORWARD.md` entry 9, bullet 1 — `listAwards` runs 3N+2 queries; derive `hasNominations` from the cycle summaries it already loads — in Thrive's nomination-awards module; the earlier candidate, M54 F1, was settled as an observation and is not a defect), run it end to end in `mixed` mode with the board open, and stop before `pushing` to let the user see the branch; then push. Record the run in the plan's workspace and the outcome in this plan's closing notes.

---

## Self-review

Spec coverage: design §3 (modes) → Tasks 6–8; §5 (task loop) → Task 7's sdd + Task 8; §6 → Task 8 §5 + Task 1; §7 → Task 8 §8; §9 (layout) → every task; §10 (commands) → Task 8 §2; §12 (guardrails) → Task 2 + Task 8 §9; §13 (Codex) → Task 3 (with the profile-file correction); §14 (install) → Task 5 + 9; the core review's Plan C entry criteria (N1–N5, I7, I9, M8, M10, M12, M13) → Tasks 1–2. Placeholders: the Markdown deliverables (Tasks 6–8) are specified by section and sentence, not full text, because they are adaptations of existing files the implementer copies. Types: `runCodexExec`/`runCodexReview` (Task 3) are what Task 7's sdd and Task 8 call through the CLI; `servicesUp/Down` (Task 4) through `sfactory services`; `checkFixCard` (Task 2) through `sfactory fixcard`.

**Note (2026-10-28, Plan C final review, I8):** Tasks 1 to 8 are ticked; Task 9 is ticked after the first real run. Every item the reviews parked or deferred, with its ruling, is in `2026-10-27-sfactory-agents-followups.md`.
