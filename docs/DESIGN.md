# sfactory — design

*Status: draft for the owner's review, 2026-10-27. Nothing below is built.*

sfactory is a Claude Code plugin that turns a backlog of features and fixes into reviewed, verified, pushed branches, with a kanban board that shows where every card is. A Claude Code session hosts it and drives the state machine. The code is written and reviewed by whichever agents the project configures: Claude subagents, Codex, or both. Scripts own the state and every deterministic step. The human is asked only at the points the project's config names.

It was designed on a real project (a multi-tenant rewards product with a `spec/` tree of briefs, plans and decision logs, two agents sharing one machine and one dev database, and a strict review ceremony), and then generalised so the project-specific parts live in one config file the adopting repo commits.

## 1. Principles

1. **The record is the project's, not the factory's.** Briefs, plans and decision logs land where the project already keeps them. The factory's own folder holds only state, verdicts, logs and cost.
2. **Scripts decide what can be decided without a model**: state transitions, locks, worktree cuts, the test suite, commits, pushes. Agents decide what scripts cannot: what to build, whether it was built, whether it is right.
3. **One writer of state.** `job.json` is written by one script that refuses an illegal transition. The board reads state, and the only writes it makes are the human gates (approve, answer, admit a parallel card, rework, stop), each through that same script; it never starts an agent.
4. **Every stage leaves a file.** A cold reader, or a resumed session, reconstructs the run from the folder, never from a chat.
5. **Humans are gates, not pollers.** A card that needs a person parks in a visible column with the exact command that releases it.
6. **Parallel only when it is free.** Two things run at once only after a script has shown they share no file, no schema change and no serialised resource, and a parallel milestone needs the person's yes.
7. **Guardrails are refusals in scripts**, not sentences in a prompt.

## 2. Concepts

| Term | Meaning |
|---|---|
| **Card** | One unit of work with a job folder. Kind `milestone` (full ceremony: brief, plan, approval, per-task log) or `fix` (light: one-page brief, no approval stop, records itself as a dated note in an existing log). A fix that needs a schema change or alters a product rule is refused and refiled as a milestone. |
| **Stage** | The card's state in `job.json`; one of the twelve in §4. |
| **Column** | What the board shows; several stages map to one column. |
| **Record** | The project's own documents for the card: brief, plan, decision log, carried-forward list. Paths come from config (§8). |
| **Job folder** | `<stateDir>/jobs/<id>/`: `job.json`, `plan/`, `tasks/<n>/`, `review/`, `verify/`, `decisions/`, `pr.md`, `cost.json`. |
| **Worktree** | A git worktree per card under `worktrees.dir`, cut from the branch `worktrees.baseRule` names. |
| **Agent mode** | `claude`, `codex` or `mixed` (§3). |
| **Stop** | A stage that waits for the person. Which ones exist is config (§7). |
| **Lock** | A file under `<stateDir>/locks/`: `suite`, `commit`, `live`, and one per worktree. |

## 3. Agent modes and roles

The orchestrator is always the hosting Claude Code session: it runs the skill, calls the scripts, spawns subagents, shells out to Codex, and writes no code itself. Mode decides who fills each role.

| Role | `claude` | `codex` | `mixed` (recommended) |
|---|---|---|---|
| Brainstorm the brief (with the person, in the session) | the session | the session, drafting through `codex exec` | the session |
| Write the plan | Claude subagent, high effort | `codex exec` | Claude subagent, high effort |
| Implement a task | Claude subagent (implementer) | `codex exec --cd <worktree>` | `codex exec --cd <worktree>` |
| Spec-compliance review of a task | Claude subagent, read-only | `codex exec`, read-only sandbox | Claude subagent, read-only |
| Code review / bug-hunt of a task | Claude subagent, read-only | `codex review` | `codex review` |
| Whole-branch bug-hunt | Claude subagent | `codex review` | `codex review` |
| Judge against the brief | Claude subagent, high effort, read-only | `codex exec`, read-only | Claude subagent, high effort, read-only |
| Fix round | the session or a Claude subagent | `codex exec` | the session or a Claude subagent |
| Failure triage (read a red suite, route it) | Claude, lowest tier | `codex exec`, cheapest model | Claude, lowest tier |

Why the mixed split: in the comparisons the owner weighed, Codex found more defects per pass and is cheaper per token on bulk implementation, while Claude was stronger on planning, long-horizon judgement and review depth. The judge is therefore the vendor that did not write the code.

*Amendment (2026-10-28, from the Plan C review of the orchestrator skill):* the spec-compliance review of a task and failure triage are Claude subagents in every mode, `codex` included. Read the two `codex` cells above for those rows as "Claude subagent, read-only" and "Claude, lowest tier". The orchestrator is always a Claude Code session, so a Claude subagent is always at hand, and the plugin ships no Codex spec-review or triage prompt (`prompts/` holds implement, review and judge). The skills (`sfactory` and `sdd`) carry the same assignment.

Model names, effort levels and Codex profile names are config, never constants, because they change monthly. A mode whose tool is missing (`codex` not on PATH, or `claude` subagents unavailable) fails at `sfactory doctor`, not mid-run.

## 4. Stages and transitions

Only `bin/job` writes `job.json`, and only along these edges.

| Stage | Column | What runs | Leaves behind | Next |
|---|---|---|---|---|
| `backlog` | Backlog | nothing | `job.json` | `planning` |
| `planning` | Plan | the worktree is cut on entry; milestone: the adapted brainstorming skill with the person, then the adapted writing-plans skill; fix: a one-page brief | the record's brief and plan; `plan/questionnaire.md` | `awaiting-approval` (milestone) · `building` (fix) |
| `awaiting-approval` | Needs you | parked | `plan/approval.md` on release | `building` |
| `building` | In process | the task loop (§5); one log entry per task; commits at each boundary | `tasks/<n>/*`; the record's log | `reviewing` |
| `reviewing` | Review | whole-branch bug-hunt, then the judge against the brief's done-whens | `review/bug-hunt.md`, `review/judge.md` | `fixing` · `verifying` |
| `fixing` | Fixed | findings fixed, full suite, back to the judge; at most `limits.fixRounds` rounds | `review/round-<r>/*` (`<r>`: the job's round) | `reviewing` · `stopped` |
| `verifying` | Fixed | takes the `live` lock; the project's verify steps: migrations, services on the card's ports, scripted or headed walkthrough, staging calls | `verify/suite.log`, `verify/walkthrough.md` | `pushing` · `fixing` |
| `pushing` | Pushed / PR | closing section, plan ticks, carried-forward reconciled, push, PR text | `pr.md` | `pushed` |
| `pushed` | Pushed / PR | waits for the person's merge; the board checks whether the integration branch contains the head | | `merged` |
| `merged` | Done | terminal; `sfactory clean` removes the worktree | | |
| `decision-needed` | Needs you | parked from any working stage with a return stage (a parallel proposal also from `backlog` or `planning`) | `decisions/<k>.md`; `plan/parallel.md` for a parallel proposal | the return stage · `backlog` when a parallel proposal is answered no (queued; planning → backlog through the park, amended 2026-10-28) |
| `stopped` | its column, red | usage limit, a round over the limit, a failed worktree cut, a lock held too long | `stopped.md` | the previous stage |

`job.json` fields: `id`, `kind`, `title`, `stage`, `returnStage`, `branch`, `base`, `worktree`, `ports`, `record` (paths of the brief, plan, log), `tasks` (n, done, parallel), `round`, `agents` (mode and the resolved models), `cost`, `started`, `updated`, `ended`, `history` (every transition with a timestamp and a reason).

## 5. The task loop

The adapted subagent-driven-development skill, with the implementer and the code reviewer filled by mode (§3). Per task:

1. **Task brief** (script): the task from the plan, the files it may touch, the test command, the log entry it must write.
2. **Implement**: the implementer works in the card's worktree. It writes the first half of the task's log entry: what changed, deviations from the plan, what was seen red, the suite count.
3. **Spec review** (read-only): does the diff do what the task says, no more and no less, and does the log entry match the code.
4. **Code review / bug-hunt** (read-only): races, missing guards, wrong handles, untested edges, independent of what the task asked.
5. **Fix or send back**: the orchestrator fixes small findings itself and sends a wrong-shaped task back to the implementer. A finding is a claim; a decline carries a reason, written into the log entry.
6. **Suite and commit** (script, behind the `suite` and `commit` locks): full suite; code and log committed separately, named paths only, no trailers unless config allows them; the review verdict appended to the log entry.

Independent tasks run in parallel up to `limits.parallelTasks` in the same worktree, each told which files are its own. Independence is a script's reading of the plan (disjoint file lists, no shared schema change) plus the plan's own `depends on` lines. The locks mean two suites never overlap and two commits never interleave.

## 6. Parallel milestones

A second milestone card started while one is building runs `bin/independence`, which checks:

1. **Disjoint files**: the two plans name no common file or module, and neither touches a `hotspots` path beyond one small edit.
2. **At most one schema change**: one dev database, one applied-migrations list. (`migrations.dir` in config; if the project has none, the check is skipped.)
3. **No shared numbering**: a project with a carried-forward list numbers entries in one sequence; the later card takes no number until the earlier closes.
4. **Serialised resources**: each card gets its own port block; what cannot be split (a shared job queue, the one database) is behind the `live` lock, so building and reviewing overlap and verifying runs one card at a time.

Pass or fail, the card parks as `decision-needed` with the reason in `plan/parallel.md`; the person answers `sfactory parallel <id> --yes|--no`. The cap is `limits.parallelMilestones` (default 2, max 3). Cards cut from the same head merge the earlier one before pushing; never rebase.

## 7. Human stops

Config lists which stages stop (`stops`). The defaults are the owner's rulings for the reference project:

- `awaiting-approval`: every milestone's brief and plan.
- `decision-needed`: a disagreement with a binding rule of the record (a numbered decision, a stories rule, an earlier ruling), or a parallel-milestone proposal.
- Merge: always the person's; the factory never merges.

Things that run without asking by default and can be made stops by config: applying migrations to the dev database, starting services, a headed walkthrough, calls to a supplier's staging, the push. The opposite is also true: a project can make the push a stop and keep migrations automatic.

## 8. Configuration — `sfactory.config.json`

Committed in the adopting repo's root. Every path is relative to the repo unless absolute. `sfactory init` writes a starter by reading `CLAUDE.md`, `package.json` and the git layout; `sfactory doctor` validates it and the tools it names.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/ShivamH1/sfactory/main/schema/config.json",
  "project": "acme",
  "agents": {
    "mode": "mixed",                      // claude | codex | mixed
    "claude": { "plan": "opus/high", "review": "opus/high", "judge": "opus/high", "implement": "sonnet", "triage": "haiku" },
    "codex":  { "implement": "implement", "review": "review" }   // profile names: files ~/.codex/<name>.config.toml
  },
  "stateDir": "../worktrees/_sfactory",       // default: <repo>/.sfactory (gitignored by init)
  "worktrees": {
    "dir": "../worktrees",
    "branchPrefix": "feature/",
    "baseRule": "newest-feature-branch",  // newest-feature-branch | integration-branch | <branch name>
    "integrationBranch": "development",
    "afterCut": ["pnpm install"],
    "copyFromBase": ["apps/admin/.env", "apps/web/.env"],   // at the cut; never a secret (SECRET_PATH)
    "copyForVerify": ["apps/api/.env"]                       // the verify stage only: services up/copy, removed by down, stop, clean
  },
  "commands": {
    "suite": "pnpm test",
    "suiteSerial": true,                  // never two at once
    "build": "pnpm build",
    "typecheck": ["pnpm --filter @acme/web exec tsc -b --force", "pnpm --filter @acme/admin exec tsc -b --force"],
    "migrate": "pnpm migrate:deploy",
    "services": [
      { "name": "api",    "cmd": "pnpm --filter @acme/api exec tsx src/server.ts", "port": "api",   "env": { "PORT": "{port.api}", "CORS_ORIGIN": "http://localhost:{port.web}", "WEB_APP_URL": "http://localhost:{port.web}" } },
      { "name": "worker", "cmd": "pnpm --filter @acme/api exec tsx src/worker.ts", "live": true },
      { "name": "web",    "cmd": "pnpm --filter @acme/web dev --port {port.web}", "env": { "VITE_API_URL": "http://localhost:{port.api}" } }
    ]
  },
  "ports": { "base": 4100, "step": 100, "names": ["api", "admin", "web"] },
  "record": {
    "style": "spec-tree",                 // spec-tree | docs-folder
    "stories":   "spec/product/FEATURE_STORIES_*.md",
    "brief":     "spec/modules/{n}-{slug}.md",
    "plan":      "spec/plans/{n}-{slug}.md",
    "log":       "spec/decisions/{n}-{slug}.md",
    "carriedForward": "spec/modules/19.1-CARRIED-FORWARD.md",
    "postCloseHeading": "# Post-close work carried on this branch",
    "numbering": "next-milestone-number"  // reads the highest {n} in spec/modules
  },
  "rules": ["CLAUDE.md", "AGENTS.md"],    // what every agent reads; AGENTS.md kept equal to CLAUDE.md by sync
  "hotspots": ["CLAUDE.md", "AGENTS.md", "spec/modules/19.1-CARRIED-FORWARD.md", "packages/core", "apps/api/src/app.ts"],
  "migrations": { "dir": "apps/api/prisma/migrations", "appliedTo": "one shared dev database" },
  "fixCardRefusals": ["apps/api/prisma/**", "spec/modules/**"],
  "stops": ["awaiting-approval", "decision-needed"],
  "limits": { "parallelMilestones": 2, "parallelTasks": 4, "fixRounds": 3, "taskRounds": 3 },
  "git": { "trailers": false, "namedPathsOnly": true, "push": true, "merge": false },
  "secrets": { "neverHandToAgents": ["apps/api/.env"] },
  "board": { "port": 4317, "pollMs": 2000 }
}
```

The block above is the worked example of a spec-tree monorepo (`examples/spec-tree-monorepo.config.json`, with generic names), used because it exercises every key. Nothing in the pipeline depends on any value in it: `project` is only the name the board shows and the key that keeps two projects' state apart on one machine. Every key has a generic default, and `sfactory init` writes the file from what it finds in the repo, so a new adopter never starts from this block. The same file for a plain Node project, with every default left out, is this:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/ShivamH1/sfactory/main/schema/config.json",
  "project": "my-app",
  "agents": { "mode": "claude" },
  "commands": { "suite": "npm test", "build": "npm run build" }
}
```

With that, cards get worktrees under `<repo>/../my-app-worktrees/`, branches `feature/<slug>` cut from the integration branch (`main` unless the repo has `develop` or `development`), state in `<repo>/.sfactory/` (gitignored by `init`), the `docs-folder` record style — `docs/sfactory/<id>/brief.md`, `plan.md`, `log.md`, no carried-forward list — ports from 4100 in blocks of 100, the two default stops, the default limits, push on and merge off. A Python project would give `"suite": "uv run pytest"`; nothing else changes. The `spec-tree` record style, the hotspots, the migrations check and the rules sync are opt-in keys for a project that has those things.

## 9. Repository layout (the plugin)

```
sfactory/
  .claude-plugin/
    plugin.json                 name "sfactory", description, author; version bumped per release
    marketplace.json            the repo is its own marketplace: one plugin entry with source "./"
  skills/
    sfactory/SKILL.md           the orchestrator; invoked as /sfactory (fully qualified /sfactory:sfactory)
    brainstorming/              adapted from superpowers (MIT): record-aware, stories first when the project has them
    writing-plans/              adapted: writes to record.plan, task "files" and "depends on" lines the scripts read
    sdd/                        adapted subagent-driven-development: implementer and reviewer by mode
  agents/                       plugin subagents, named sfactory:<file>
    implementer.md  spec-reviewer.md  code-reviewer.md  judge.md  triage.md
  prompts/
    codex-implement.md  codex-review.md  codex-judge.md
  package.json                  name "sfactory", "bin": { "sfactory": "./src/cli.mjs" }; no runtime dependencies
  src/                          the scripts as modules: job, worktree, lock, suite, commit, push, independence,
                                ports, board, sync-rules, init, doctor, cost, install; cli.mjs dispatches sub-commands
  bin/                          on the Bash tool's PATH while the plugin is enabled; one-line shims into src/
    sfactory-job  sfactory-worktree  sfactory-lock  sfactory-suite  sfactory-commit  sfactory-push
    sfactory-independence  sfactory-ports  sfactory-board  sfactory-sync-rules  sfactory-init
    sfactory-doctor  sfactory-cost
  board/dashboard.html
  schema/config.json
  examples/
    spec-tree-monorepo.config.json  minimal-node.config.json  python-uv.config.json
    jobs/                       a finished run's job folders, for the board and the tests
  docs/DESIGN.md  INSTALL.md  README.md  LICENSE (MIT)
  test/                         node --test over bin/
```

Facts this layout relies on (plugin docs, read 2026-10-27): a plugin skill is namespaced `/<plugin>:<skill>`, and the bare `/<skill>` form works unless another command takes the name, so the skill is named `sfactory` and `/sfactory run` is the everyday form. Sub-commands are not a plugin feature: the skill parses `$ARGUMENTS` itself (`add`, `run`, `approve`, …). A plugin's `bin/` is put on the Bash tool's PATH, so the scripts carry the `sfactory-` prefix to avoid collisions, and one dispatcher, `bin/sfactory`, takes the command as its first argument (`sfactory job show <id>`), so the skills read the same in the plugin and the npm channel; inside Markdown the plugin root is `${CLAUDE_PLUGIN_ROOT}`. Plugin subagents are addressed as `sfactory:<name>`; whether the Agent tool can select one by that name is not documented and is the first thing the build tests, with "spawn a general agent with the agent file's prompt" as the fallback. State lives in `stateDir`, outside the plugin and (by default) gitignored inside the project.

## 10. Commands

Slash commands in the session; each is a thin call into the scripts with the skill around it.

| Command | Effect |
|---|---|
| `/sfactory init` | writes `sfactory.config.json` and `.gitignore` lines; prints what it guessed and what it could not |
| `/sfactory doctor` | validates config; checks git, node, the agents of the chosen mode, Codex profiles, ports free, state dir writable |
| `/sfactory add milestone "<title>"` | backlog card; takes the next number from the record |
| `/sfactory add fix "<title>" --log <n>` | backlog fix card recorded under that log |
| `/sfactory run` | works every card from its saved state; idempotent |
| `/sfactory approve <id>` | releases `awaiting-approval` |
| `/sfactory answer <id>` | releases `decision-needed` after the questionnaire is filled |
| `/sfactory parallel <id> --yes|--no` | admits or queues a second milestone |
| `/sfactory status` | one line per card |
| `/sfactory board` | starts the static board server and prints its link |
| `/sfactory rework <id> "<notes>"` | sends a reviewed or pushed card back to `building` with the notes as a task |
| `/sfactory stop <id>` · `/sfactory clean <id>` | stops a card's agents; removes a merged card's worktree |

## 11. The board

`board/dashboard.html`, served by `sfactory-board` from `stateDir` on `127.0.0.1:{board.port}` with a `/jobs.json` route, polled every `board.pollMs`. Eight columns: Backlog, Plan, Needs you, In process, Review, Fixed, Pushed / PR, Done. A card shows kind, title, branch, task progress, round, review chips, cost and elapsed; a live card pulses; a stopped card is red. A click opens a drawer with the job folder's files rendered. The footer shows running agents, who holds the `live` lock, the ports in use and the day's cost. Cost is an API-equivalent estimate from transcripts, labelled as such.

**The human gates are on the board.** A parked card carries the controls for its gate, and each one is a `POST` the server turns into the matching `sfactory-job` call, so the board can do nothing the script would refuse:

| Card state | Control on the card | What the server runs |
|---|---|---|
| `awaiting-approval` | *Approve* after the drawer has shown the brief and the plan; a *Request changes* box that becomes a planning note | `sfactory-job approve <id> --by board`, writing `plan/approval.md` |
| `decision-needed` | the questionnaire rendered as a form, one field per question; *Answer* | writes `decisions/<k>-answer.md`, then `sfactory-job answer <id>` |
| parallel proposal | *Run in parallel* / *Queue it*, with the check's reason shown | `sfactory-job parallel <id> --yes|--no` |
| `pushed` | the PR title and body with a copy button; *Mark merged* if detection lags | `sfactory-job merged <id>` |
| any working stage | *Stop*; *Rework* with a notes box on a reviewed or pushed card | `sfactory-job stop <id>` · `sfactory-job rework <id>` |

The session's `/sfactory` commands do the same things, so either surface works. The orchestrator session, when it waits on a gate, polls the card's `job.json` and continues the moment the board releases it. The server binds to localhost only, accepts no write for a card it does not hold, and starts no agent: everything that spends tokens is still begun from the session.

## 12. Guardrails (script refusals)

- `push` refuses a branch outside `branchPrefix`, a dirty tree, and any push when `git.push` is false.
- `commit` refuses `git add -A`, any stash, and trailers unless `git.trailers` is true.
- `job` refuses to leave `awaiting-approval` without `plan/approval.md`, and any edge not in §4.
- `worktree` refuses the main checkout, any directory with another holder's lock, and a cut whose base moved between the read and the add.
- `add fix` refuses a card whose plan touches `fixCardRefusals` and refiles it.
- Agents never receive `secrets.neverHandToAgents`; the implementer's prompt lists the files it may touch.
- `suite` holds its lock for the whole run; `live` is one lock for the machine.
- A fix round over `limits.fixRounds` stops the card; nothing loops unbounded.

## 13. Codex integration

- Implement: `codex exec --cd <worktree> --profile <agents.codex.implement> --sandbox workspace-write` with the task brief on stdin and the output captured to `tasks/<n>/codex.log`. The sandbox and network flags are config because `pnpm install` and generated clients differ by project; `doctor` runs a probe once and records what works.
- Review: `codex review` on the task's commit range, or the branch, with the review prompt; output to `tasks/<n>/code-review.md`.
- Profiles: `INSTALL.md` gives the two profile files, `~/.codex/implement.config.toml` and `~/.codex/review.config.toml`, selected with `-p`; the plugin never writes them.
- Rules: `bin/sync-rules.mjs` keeps every file in `rules` identical to the first (so `AGENTS.md` equals `CLAUDE.md`) and refuses to run an agent while they differ.

## 14. Install

Two channels, one codebase.

**As a Claude Code plugin** (the repo is also its marketplace). In a session:

```
/plugin marketplace add ShivamH1/sfactory
/plugin install sfactory@sfactory
```

or, on Claude Code 2.1.275 and later, the one-step `/plugin install sfactory --marketplace ShivamH1/sfactory`. Then, in the project, `/sfactory init` and `/sfactory doctor`. Updates: `/plugin marketplace update sfactory`; users get a new copy when `plugin.json`'s version changes, so every release bumps it.

**As an npm package**, for a machine that cannot add a marketplace, for CI, and for a Codex-only user who has no Claude Code plugin system:

```
npm install -g sfactory        # or: npx sfactory init
sfactory init                  # writes sfactory.config.json and .gitignore lines
sfactory install               # copies skills/, agents/ and prompts/ into the project's .claude/ (or ~/.codex/skills for Codex)
sfactory doctor
sfactory board
```

The package's `bin` is the same `sfactory` CLI the plugin's `bin/` scripts dispatch to (`sfactory job …`, `sfactory worktree …`), so the plugin and the package never diverge: the plugin is the package plus the Claude Code wrapping. Published from the same repo with `npm publish`, versions kept equal with `plugin.json`.

Requirements: Node 20+, git; Claude Code for the `claude` and `mixed` modes; Codex CLI for the `codex` and `mixed` modes.

## 15. Testing the factory

- `test/` runs under `node --test`: every edge of `job.mjs` and every refusal in §12; `independence.mjs` over fixture plans; `ports.mjs`; the config schema against the examples.
- The board is checked by hand against the example jobs in `examples/jobs/`.
- The first real run on the reference project is a fix card with the board open, before any milestone card.

## 16. Out of scope, for later

- A standalone runner that works the board unattended (the session is the runner today).
- GitHub issue intake and PR merging (the person merges; `gh` may be absent).
- A multi-machine board.

## 17. Attribution and licence

MIT. The three adapted skills derive from Jesse Vincent's superpowers (MIT), with the licence and a changelog of the adaptations kept beside each copy. The job-folder, one-writer and static-board ideas were informed by the zazencodes software factory (GPLv3); none of its code is used.
