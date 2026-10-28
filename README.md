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
- `sfactory-board` — open the kanban board (see below)

## The board

`sfactory board` serves a kanban view of your jobs, read from the same job files the commands write. It prints a URL (default port 4317, or `board.port` in the config; `--port n` overrides) and stays up until Ctrl+C.

- **Demo:** `sfactory board --demo` shows six sample jobs from `examples/jobs`. It needs no config and no repo, and it is read-only: the page renders no gate controls, and a hand-sent POST answers 403.
- **The gates:** each button calls the same gate function the `sfactory job` commands call, so an illegal move, a missing approval or a busy job is refused with the same reason (*Request changes* exists only on the board). Each write is made under the job lock, and a POST must carry the `X-Sfactory-Board: 1` header.
- **Local only:** the server binds to 127.0.0.1 and refuses any Host header other than `127.0.0.1:<port>` or `localhost:<port>`. It is not reachable from another machine.
- `examples/jobs/generate.mjs` rebuilds the demo folders through the job state functions, so they follow the schema.

## Codex profiles

For `codex` and `mixed` modes, add these blocks to `~/.codex/config.toml` (`sfactory-doctor` checks for them):

```toml
[profiles.implement]
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"

[profiles.review]
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
```

npm users run `sfactory <command>`; plugin users also get the `sfactory-<command>` shims.

## Licence

MIT. The three adapted skills derive from Jesse Vincent's superpowers (MIT), with the licence and a changelog of the adaptations kept beside each copy. The job-folder, one-writer and static-board ideas were informed by the zazencodes software factory (GPLv3); none of its code is used.
