# sfactory

sfactory is a software factory for Claude Code and Codex. You add a card (a feature or a fix) to a backlog, and the factory moves it through plan, build, review, verify and push on its own branch in its own git worktree, using Claude subagents, Codex, or both. Scripts own the state and every deterministic step (stage moves, locks, worktrees, the test suite, commits, pushes); agents do the thinking. A localhost kanban board shows where every card is and carries the two human gates. The factory pushes branches and never merges: you do.

It ships as a Claude Code plugin (the `/sfactory` command) and as an npm package with the same `sfactory` CLI; the npm package is the CLI and the Codex skills, and Claude Code uses the plugin. Zero runtime dependencies; Node 20 or later. Built and tested on Windows; the POSIX paths are reasoned and unit-tested, not yet run on Linux or macOS. Install: see [INSTALL.md](INSTALL.md). The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## A card in 90 seconds

In a repository with the plugin installed:

```text
/sfactory init                      writes sfactory.config.json from what it finds, and says what it guessed
/sfactory doctor                    checks git, node, the agents of your mode, Codex profile files, ports
/sfactory add milestone "Gift cards"
/sfactory board                     prints the board's link; open it in a browser
/sfactory run
```

What you see on the board (http://127.0.0.1:4317), left to right: Backlog, Plan, Needs you, In process, Review, Fixed, Pushed / PR, Done.

1. The card sits in **Backlog**, then moves to **Plan**: the factory cuts a worktree and a branch for it, and the planning skills work with you in the session to write a brief and a plan into your project's own record (the paths come from `record` in the config).
2. **Stop one, approval.** The card parks in **Needs you** as `awaiting-approval`. Open it, read the plan in the drawer (the *Approve* button stays off until you have viewed every plan file), then press *Approve*, or send notes with *Request changes*. The terminal equivalent is `/sfactory approve <id>`.
3. **In process:** the task loop. Each task is implemented, spec-reviewed, code-reviewed, fixed, put through the full suite and committed, with the card's progress ticking on the board.
4. **Review, Fixed:** a whole-branch bug-hunt and a judge against the brief. Findings are fixed, up to `limits.fixRounds` rounds. Then verification: services on the card's own ports, a walkthrough, whatever your config names.
5. **Stop two, decisions.** Whenever an agent meets a binding rule it should not break, or needs a call only you can make, the card parks as `decision-needed` with a questionnaire. Answer it on the board (or `/sfactory answer <id>`) and the factory carries on from where it parked.
6. **Pushed / PR:** the branch is pushed and the card shows the PR title and body. You open the PR and merge it. The card moves to **Done** once the integration branch contains the head (or press *Mark merged*).

`/sfactory run` is idempotent: run it again after any stop and it carries on from the saved state.

To try the board with no repo and no config: `sfactory board --demo` (read-only, eight sample cards).

## The board

`sfactory board` serves a kanban view of your jobs, read from the same job files the commands write. It prints a URL (default port 4317, or `board.port` in the config; `--port n` overrides) and stays up until Ctrl+C or SIGTERM; in a session, stop the background task `/sfactory board` started.

- **At a glance:** a job in a working stage updated within `board.activeMs` (default 120000) has a softly pulsing card (a static ring under reduced motion); a stopped job's card and stage chip are red; a card shows up to three chips for the latest files in `reviews/` (a tick or a cross by the file's first line; click to open it in the drawer).
- **Approve after viewing:** on a plan awaiting approval the board's *Approve* stays off until the drawer has shown every `plan/*.md` file; *Request changes* is always available.
- **The gates:** each button calls the same gate function the `sfactory job` commands call, so an illegal move, a missing approval or a busy job is refused with the same reason. Each write is made under the job lock, and a POST must carry the `X-Sfactory-Board: 1` header. The board starts no agent.
- **Local only:** the server binds to 127.0.0.1 and refuses any Host header other than `127.0.0.1:<port>` or `localhost:<port>`. It is not reachable from another machine.
- **Service logs:** the drawer also lists a card's service logs (`verify/<name>.log`); they are read from the job folder on your machine and shown only there.
- **Demo:** `--demo` reads `examples/jobs`, needs no config, and is read-only: the page renders no gate controls and a hand-sent POST answers 403.

## The three modes

`agents.mode` in `sfactory.config.json`. The orchestrator is always the hosting Claude Code session; it writes no code itself.

| Role | `claude` | `codex` | `mixed` (recommended) |
|---|---|---|---|
| Brainstorm the brief (with you) | the session | the session | the session |
| Write the plan | Claude subagent | `codex exec` | Claude subagent |
| Implement a task | Claude subagent | `codex exec` | `codex exec` |
| Spec review of a task | Claude subagent | Claude subagent | Claude subagent |
| Code review of a task, whole-branch bug-hunt | Claude subagent | `codex review` | `codex review` |
| Judge against the brief | Claude subagent | `codex exec`, read-only | Claude subagent |
| Fix round | the session or a Claude subagent | `codex exec` | the session or a Claude subagent |
| Failure triage | Claude, lowest tier | Claude, lowest tier | Claude, lowest tier |

In `mixed`, the judge is the vendor that did not write the code. Model names, effort levels and Codex profile names are config, never constants. A mode whose tool is missing fails at `doctor`, not mid-run.

## Commands

In a Claude Code session (each is a thin call into the CLI with the skill around it):

- `/sfactory init` and `/sfactory doctor` — write and check the config
- `/sfactory add milestone "<title>"` and `/sfactory add fix "<title>" --log <n>` — a backlog card
- `/sfactory run [--resume <id>]` — work every card from its saved state
- `/sfactory approve <id>` — release `awaiting-approval`
- `/sfactory answer <id>` — release `decision-needed` once the questionnaire is answered
- `/sfactory parallel <id> --yes` or `--no` — admit or queue a second milestone
- `/sfactory status` — one line per card
- `/sfactory board` — start the board and print its link
- `/sfactory rework <id> "<notes>"` — send a reviewed or pushed card back to building
- `/sfactory stop <id>`, `/sfactory clean <id>`, `/sfactory merged <id>`

The CLI (npm users run `sfactory <command>`; plugin users also get an `sfactory-<command>` shim for each):

- `sfactory job` — create, move and inspect cards (`add`, `set`, `approve`, `park`, `answer`, `parallel`, `stop`, `resume`, `merged`, `rework`, `request-changes`, `touch`, `show`, `list`)
- `sfactory lock` — take and release the suite and resource locks
- `sfactory worktree` — cut, remove and merge job worktrees; `worktree base` prints the base branch
- `sfactory ports` — allocate and free a job's port block
- `sfactory services` — start, stop and inspect a card's services on its port block
- `sfactory commit` — commit named paths only, with no trailers
- `sfactory push` — push a job's branch
- `sfactory suite` — run the test suite under the lock
- `sfactory independence` — check that planned tasks or milestones do not overlap
- `sfactory cost` — record and report token cost
- `sfactory doctor` — check the environment and config
- `sfactory codex` — run Codex `exec` and `review` with usage capture
- `sfactory fixcard` — check a fix card's plan against `fixCardRefusals`
- `sfactory brief` — extract one task of a plan into its brief (`sfactory brief <plan> <n> --out <file>`)
- `sfactory diff` — a worktree's review package, changed files or commits between two refs (`--out <file>`, `--names`, `--commits`; head `WORKTREE` is the working tree, new files included)
- `sfactory tree` — a worktree's porcelain status, exit 1 when anything is listed (`--head` prints HEAD)
- `sfactory board` — the kanban board (above)
- `sfactory init` — guess a `sfactory.config.json` for this repo (`--force` replaces one)
- `sfactory install` — `--codex`: copy the skills into `~/.codex/skills/`; without it, copy the skills, agents and prompts into `.claude/` for reading (Claude Code uses the plugin; `--dest <dir>`; `--force`)
- `sfactory sync-rules` — make every file in the config's `rules` match the first (`--check` only reports)
- `sfactory version`

## Safety rules

These are refusals in the scripts, not sentences in a prompt.

- **No secrets to agents.** Paths in `secrets.neverHandToAgents` are never read, listed or named by an agent, and a Codex child gets your environment without `*_SECRET`, `*_TOKEN`, `*_KEY`, `*_PASSWORD` or `*_CREDENTIALS` variables (except `CODEX_*` and `OPENAI_*`), without `DATABASE_URL` and `PGPASSWORD`, and without any `*_URL` whose value carries credentials (`scheme://user:pass@`). **Claude subagents are not filtered: they inherit the Claude Code session's environment**, so start the session without credentials you would not hand an agent.
- **Named-path commits.** `sfactory commit` stages only the paths it is given; it refuses `git add -A` and any stash.
- **No trailers.** Commits carry no `Co-Authored-By` or "generated by" line unless `git.trailers` is true.
- **Never main, never the integration branch, never your checkout.** `commit` and `push` refuse a branch outside `worktrees.branchPrefix` (and main, master and the integration branch), the main checkout and any tree that is not a card's worktree; `push` also refuses a dirty tree and any push when `git.push` is false.
- **The person merges.** The factory pushes and stops. The only merge it makes is one parallel card's pushed branch into its partner's.
- **Gates are enforced.** A card cannot leave `awaiting-approval` without `plan/approval.md`, no stage edge outside the state machine is accepted, a milestone does not start above `limits.parallelMilestones`, and two active milestones are not both approved without your parallel yes.
- **Bounded loops.** A fix round over `limits.fixRounds` is refused and the card parks for you (rework or stop it).

## Config

`sfactory init` writes the starter. A worked example of a spec-tree monorepo, exercising every key, is `examples/spec-tree-monorepo.config.json`; two smaller ones are `examples/minimal-node.config.json` and `examples/python-uv.config.json`. The schema is `schema/config.json`.

## Codex profiles

For `codex` and `mixed` modes, create `~/.codex/implement.config.toml` and `~/.codex/review.config.toml`; see [INSTALL.md](INSTALL.md).

## Licence and attribution

MIT (see LICENSE). The three adapted skills (brainstorming, writing-plans and subagent-driven development) derive from the superpowers skills by Jesse Vincent (MIT), with the licence and a changelog of the adaptations kept beside each copy. The job-folder, one-writer and static-board ideas were informed by the zazencodes software factory; sfactory takes ideas only and none of its code.
