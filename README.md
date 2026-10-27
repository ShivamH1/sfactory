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
