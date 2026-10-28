# sfactory

A software factory for Claude Code and Codex: cards move from backlog to pushed through plan, build, review and verify, with file-based state. It ships as a Node CLI and a Claude Code plugin.

Status: core only; the board, the skills and the Codex integration follow.

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
- `sfactory-commit` — commit named paths only, with no trailers
- `sfactory-push` — push a job's branch
- `sfactory-suite` — run the test suite under the lock
- `sfactory-independence` — check that planned tasks do not overlap
- `sfactory-cost` — report token cost
- `sfactory-doctor` — check the environment and config
- `sfactory-codex` — run Codex exec and review with usage capture

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
