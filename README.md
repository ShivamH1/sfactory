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

What you see on the board (http://127.0.0.1:4317), left to right: Milestones, Backlog, Plan, Needs you, In process, Review, Fixed, Pushed / PR, External running, Done. **Milestones** holds planned work the factory leaves alone until you start it (`/sfactory start M14`); **External running** shows work being done outside the factory, which `run` never touches. Beside the Board tab, the **Activity** tab shows the agents running now, a timeline of what happened and the live output of the selected agent.

1. The card sits in **Backlog**, then moves to **Plan**: the factory cuts a worktree and a branch for it, and the planning skills work with you in the session to write a brief and a plan into your project's own record (the paths come from `record` in the config).
2. **Stop one, approval.** The card parks in **Needs you** as `awaiting-approval`. Open it, read the plan in the drawer (the *Approve* button stays off until you have viewed every plan file), then press *Approve*, or send notes with *Request changes*. The terminal equivalent is `/sfactory approve <id>`.
3. **In process:** the task loop. Each task is implemented, spec-reviewed, code-reviewed, fixed, put through the full suite and committed, with the card's progress ticking on the board.
4. **Review, Fixed:** a whole-branch bug-hunt and a judge against the brief. Findings are fixed, up to `limits.fixRounds` rounds. Then verification: services on the card's own ports, a walkthrough, whatever your config names.
5. **Stop two, decisions.** Whenever an agent meets a binding rule it should not break, or needs a call only you can make, the card parks as `decision-needed` with a questionnaire. Answer it on the board (or `/sfactory answer <id>`) and the factory carries on from where it parked.
6. **Pushed / PR:** the branch is pushed and the card shows the PR title and body. You open the PR and merge it. The card moves to **Done** once the integration branch contains the head (or press *Mark merged*).

`/sfactory run` is idempotent: run it again after any stop and it carries on from the saved state.

To try the board with no repo and no config: `sfactory board --demo` (read-only, nine sample cards, one of them with a Codex agent running and its live output; open the Activity tab to see it).

## The board

`sfactory board` serves a kanban view of your jobs, read from the same job files the commands write. It prints a URL (default port 4317, or `board.port` in the config; `--port n` overrides) and stays up until Ctrl+C or SIGTERM; in a session, stop the background task `/sfactory board` started.

- **Two themes:** smoked glass (dark) is the default whatever your system prefers; porcelain glass is the light one. The toggle in the top bar switches them and remembers your choice in the browser; the board works without that memory.
- **At a glance:** a job in a working stage updated within `board.activeMs` (default 120000) has a sage border, and each agent running on it a line with a breathing dot (a static dot under reduced motion); champagne marks only what needs you; a stopped job's card and stage chip are red; a card shows up to three chips for the latest files in `reviews/` (a tick or a cross by the file's first line; click to open it in the drawer).
- **Columns:** **Milestones** lists its cards by number (29.1 between 29 and 30). **Done** shows the newest 8 by the time they finished; the rest sit behind *Show all N*, and that choice is remembered per viewer in the browser.
- **Approve after viewing:** on a plan awaiting approval the board's *Approve* stays off until the drawer has shown every `plan/*.md` file; *Request changes* is always available.
- **The gates:** each button calls the same gate function the `sfactory job` commands call, so an illegal move, a missing approval or a busy job is refused with the same reason. Each write is made under the job lock, and a POST must carry the `X-Sfactory-Board: 1` header. The board starts no agent.
- **Local only:** the server binds to 127.0.0.1 and refuses any Host header other than `127.0.0.1:<port>` or `localhost:<port>`. It is not reachable from another machine. The log views show whatever agents printed, so keep secrets out of agents' output.
- **Service logs:** the drawer also lists a card's service logs (`verify/<name>.log`); they are read from the job folder on your machine and shown only there.
- **The Activity tab** (`?view=activity`, beside Board): *Running now* shows one tile per running agent (card, vendor, role, task, elapsed time); a timeline of every event, newest first, with filters by card and by kind (Agents, Gates, Suite, Stages); and an output pane for the selected agent with four tabs: *Live output* (a Codex stream rendered by type, with a Following toggle), *Brief*, *Report* and *Raw log*. `sfactory board --demo` shows a running agent with a log it can tail.
- **Activity data:** every card keeps an append-only `events.jsonl` (stage moves, gates, agent starts and finishes, suite runs, services, locks, commits). The board serves the recent events across all cards and the agents running now at `/activity.json`, and the tail of any log in a card's folder at `/jobs/<id>/tail?path=<file>&from=<offset>`. A Codex run records itself; a Claude agent is recorded by `sfactory job touch <id> --agent start|finish --role <role> --vendor claude`.
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

## Talking to the session

The composer at the bottom of the board sends a message to the orchestrator session: General, or about one card. The thread shows each message with a status: *sent*, *offered to the session*, *seen* or *answered*. "Offered to the session" means the plugin's channel server offered it, not that the session has read it. An indicator says how messages travel: "Channel running" when the plugin's channel server is running, otherwise "Read at the factory's next step". Claude Code starts the channel server in every session where the plugin is enabled, but its pushes reach the session only when the session was started with the channel flag below; without the flag they are dropped, and the message waits for the factory's next step.

Messages travel live through the channel when the session was started with the flag, and always at the factory's next step: the session runs `sfactory chat unread` at every step and before it ends a turn at a gate. A session idle at a gate with no channel reads messages when the person runs `/sfactory run` again. A message never stands in for a gate; approvals stay *Approve* or `/sfactory approve`.

Keep one channel-flagged session per repo: another flagged session in the same repo would also receive, and may answer, the person's messages.

While Claude Code's channels are a research preview, start the session with:

```text
claude --dangerously-load-development-channels plugin:sfactory@sfactory
```

Interactive sessions only, signed in with claude.ai or the Console.

## Commands

In a Claude Code session (each is a thin call into the CLI with the skill around it):

- `/sfactory init` and `/sfactory doctor` — write and check the config
- `/sfactory add milestone "<title>" [--number <n>] [--roadmap] [--after "<text>"]` and `/sfactory add fix "<title>" --log <n>` — a backlog card (a roadmap card with `--roadmap`)
- `/sfactory run [--resume <id>]` — work every card from its saved state
- `/sfactory start <id>` — move a Milestones card to backlog
- `/sfactory external <id> "<note>"` — mark a card as worked outside the factory
- `/sfactory import <file>` — create cards in bulk from a JSON file
- `<id>` may be `M<n>` for a numbered card
- `/sfactory approve <id>` — release `awaiting-approval`
- `/sfactory answer <id>` — release `decision-needed` once the questionnaire is answered
- `/sfactory parallel <id> --yes` or `--no` — admit or queue a second milestone
- `/sfactory status` — one line per card
- `/sfactory board` — start the board and print its link
- `/sfactory rework <id> "<notes>"` — send a reviewed or pushed card back to building
- `/sfactory stop <id>`, `/sfactory clean <id>`, `/sfactory merged <id>`
- `/sfactory chat` — the conversation with the board, newest last

The CLI (npm users run `sfactory <command>`; plugin users also get an `sfactory-<command>` shim for each):

- `sfactory job` — create, move and inspect cards (`add`, `set`, `approve`, `park`, `answer`, `parallel`, `stop`, `resume`, `merged`, `rework`, `request-changes`, `touch` (with `--agent`, `--role`, `--task`, `--vendor`, `--model`, `--verdict`), `show`, `list`, `start`, `external`, `import`)
- `sfactory chat` — read and answer the board's messages (`unread [--card <id>] [--json]`, `reply <id> [--] "<text>"`, `list [--card <id>] [--json]`; after `--`, a reply is taken as it is, dashes and all)
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
- `sfactory codex` — run Codex `exec` and `review` with usage capture (`--role` and `--task` name a run on the board)
- `sfactory fixcard` — check a fix card's plan against `fixCardRefusals`
- `sfactory brief` — extract one task of a plan into its brief (`sfactory brief <plan> <n> --out <file>`)
- `sfactory diff` — a worktree's review package, changed files or commits between two refs (`--out <file>`, `--names`, `--commits`; head `WORKTREE` is the working tree, new files included)
- `sfactory tree` — a worktree's porcelain status, exit 1 when anything is listed (`--head` prints HEAD)
- `sfactory board` — the kanban board (above)
- `sfactory init` — guess a `sfactory.config.json` for this repo (`--force` replaces one)
- `sfactory install` — `--codex`: copy the skills into `~/.codex/skills/`; without it, copy the skills, agents and prompts into `.claude/` for reading (Claude Code uses the plugin; `--dest <dir>`; `--force`)
- `sfactory sync-rules` — make every file in the config's `rules` match the first (`--check` only reports)
- `sfactory version`

## Bringing an existing project

A project with finished and planned work can put it on the board once. Write a JSON file from your own records and run `sfactory job import cards.json` after `sfactory init` and `sfactory doctor`:

```json
{ "cards": [
  { "number": "12", "kind": "milestone", "title": "Saved searches", "stage": "merged", "branch": "feature/saved-searches", "pr": 31 },
  { "number": "13", "kind": "milestone", "title": "CSV export", "stage": "external", "externalNote": "pairing session" },
  { "number": "14", "kind": "milestone", "title": "Audit log", "stage": "roadmap", "after": "M13" }
] }
```

Stages: `roadmap` (Milestones), `backlog`, `external`, `pushed`, `merged`. Other fields: `branch`, `pr`, `prUrl`, `started`, `ended` (merged only), `after`, `externalNote` (external only), `note`. The whole file is checked before anything is written, and cards already on the board are skipped, so running it again is safe.

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
