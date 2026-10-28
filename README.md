# sfactory

A software factory for Claude Code and Codex: cards move from backlog to pushed through plan, build, review and verify, with file-based state. It ships as a Node CLI and a Claude Code plugin.

Status: built are the core (jobs, locks, worktrees, ports, services, commit, push, suite, cost, doctor), the kanban board, the Codex runner and the services runner. The skills and the orchestrator that drive them follow.

## Requirements

Node >= 20, git, and Claude Code and/or Codex CLI depending on `agents.mode`.

## Install

- Plugin: `/plugin marketplace add ShivamH1/sfactory`, then `/plugin install sfactory@sfactory`
- npm: `npm install -g sfactory`

## Commands today

- `sfactory-job` — create and inspect job state
- `sfactory-lock` — take and release the suite and resource locks
- `sfactory-worktree` — cut and remove job worktrees
- `sfactory-ports` — allocate and show a job's port block
- `sfactory-services` — start, stop and inspect a card's services on its port block
- `sfactory-commit` — commit named paths only, with no trailers
- `sfactory-push` — push a job's branch
- `sfactory-suite` — run the test suite under the lock
- `sfactory-independence` — check that planned tasks do not overlap
- `sfactory-cost` — report token cost
- `sfactory-doctor` — check the environment and config
- `sfactory-codex` — run Codex exec and review with usage capture
- `sfactory-fixcard` — check a fix card's plan against `fixCardRefusals`
- `sfactory-board` — open the kanban board (see below)
- `sfactory-init` — guess a `sfactory.config.json` for this repo (`--force` replaces one)
- `sfactory-install` — copy the plugin's skills, agents and prompts into `.claude/` (`--codex`: skills into `~/.codex/skills/`; `--dest <dir>`; `--force`)
- `sfactory-sync-rules` — make every file in the config's `rules` match the first (`--check` only reports)

## The board

`sfactory board` serves a kanban view of your jobs, read from the same job files the commands write. It prints a URL (default port 4317, or `board.port` in the config; `--port n` overrides) and stays up until Ctrl+C.

- **Demo:** `sfactory board --demo` shows six sample jobs from `examples/jobs`. It needs no config and no repo, and it is read-only: the page renders no gate controls, and a hand-sent POST answers 403.
- **At a glance:** a job in a working stage updated within `board.activeMs` (default 120000) has a softly pulsing card (a static ring under reduced motion); a stopped job's card and stage chip are red; a card shows up to three chips for the latest files in `reviews/` (a tick or a cross by the file's first line; click to open it in the drawer).
- **Approve after viewing:** on a plan awaiting approval the board's *Approve* stays off until the drawer has shown every `plan/*.md` file (page state only, reset when the job changes); *Request changes* is always available, and `sfactory job approve` is unchanged.
- **The gates:** each button calls the same gate function the `sfactory job` commands call, so an illegal move, a missing approval or a busy job is refused with the same reason (*Request changes* exists only on the board). Each write is made under the job lock, and a POST must carry the `X-Sfactory-Board: 1` header.
- **Local only:** the server binds to 127.0.0.1 and refuses any Host header other than `127.0.0.1:<port>` or `localhost:<port>`. It is not reachable from another machine.
- **Service logs:** the drawer's file view also lists a card's service logs (`verify/<name>.log`, from `sfactory services`); they are read from the job folder on your machine and shown only there, never sent anywhere.
- `examples/jobs/generate.mjs` rebuilds the demo folders through the job state functions, so they follow the schema.

## Codex profiles

For `codex` and `mixed` modes, create two files in `~/.codex/` (or `$CODEX_HOME`); Codex selects them with `-p <name>` and `sfactory-doctor` checks that they exist. A `[profiles.*]` table in `config.toml` is not read by this Codex. The sandbox is left to the `-s` flag the runner passes.

`~/.codex/implement.config.toml`:

```toml
model = "<your-model>"
model_reasoning_effort = "high"
```

`~/.codex/review.config.toml`:

```toml
model = "<your-model>"
model_reasoning_effort = "high"
```

Run Codex through `sfactory codex exec --cwd <dir> --profile implement --out <dir> < prompt` and `sfactory codex review --cwd <dir> --profile review --base <branch> --out <dir> < prompt`. The child gets your environment without any `*_SECRET`, `*_TOKEN` or `*_KEY` variable (except `CODEX_*` and `OPENAI_*`) and without any variable named in `secrets.neverHandToAgents`. Review runs as `codex exec -C <dir> -p review -s read-only review --base <branch> --json -o <file> -`, so it uses the `review` profile and a read-only sandbox (plain `codex review` has no profile flag).

npm users run `sfactory <command>`; plugin users also get the `sfactory-<command>` shims.

## Licence

MIT. The three adapted skills derive from Jesse Vincent's superpowers (MIT), with the licence and a changelog of the adaptations kept beside each copy. The job-folder, one-writer and static-board ideas were informed by the zazencodes software factory (GPLv3); none of its code is used.
