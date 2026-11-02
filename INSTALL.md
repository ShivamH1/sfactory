# Installing sfactory

Requirements: Node 20 or later and git; Claude Code for the `claude` and `mixed` modes; the Codex CLI for the `codex` and `mixed` modes.

Platform: sfactory is built and its suite run on Windows. The POSIX paths (process groups, `ps`, signal forwarding, detached children) are reasoned and unit-tested with stand-ins, but have not yet been run on Linux or macOS.

There are two channels, one codebase: the Claude Code plugin, and the npm package. Use either, or both.

## 1. As a Claude Code plugin

The repository is also its own marketplace. In a Claude Code session:

```text
/plugin marketplace add ShivamH1/sfactory
/plugin install sfactory@sfactory
```

Newer Claude Code versions also take a one-step form, `/plugin install sfactory --marketplace ShivamH1/sfactory`; the two-step form above works everywhere.

The plugin gives you the `/sfactory` command (and `/sfactory:sfactory`), the factory's skills and agents, and an `sfactory-<command>` shim for every CLI command on the Bash tool's PATH. Then, in your project:

```text
/sfactory init
/sfactory doctor
```

## 2. From npm

The npm package is **the CLI and the Codex skills**: for CI, for scripting the state and the board, and for a Codex-only user. **Claude Code gets the factory from the plugin (section 1)**, which namespaces its skills and agents as `sfactory:<name>`; the skills call each other and the agents by those names, so copies under `.claude/` are not a working Claude Code setup.

```bash
npm install -g sfactory        # or run one-off commands with: npx sfactory <command>
sfactory install --codex       # the skills, into ~/.codex/skills/
```

`sfactory install` without `--codex` still copies `skills/`, `agents/` and `prompts/` into this repo's `.claude/`, for reading or adapting; it does not install the plugin.

`sfactory install` never overwrites a file that differs from the plugin's copy: it reports it as kept and exits 1; add `--force` to replace. `--dest <dir>` chooses another destination.

## 3. Codex profiles (codex and mixed modes)

Codex profiles are files in `~/.codex/` (or `$CODEX_HOME`), one per name, selected with `-p` / `--profile`. A `[profiles.*]` table in `config.toml` is not read. The names must match `agents.codex` in your `sfactory.config.json` (the defaults are `implement` and `review`). The sandbox comes from the flag the runner passes, so the files carry only the model and effort.

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

The factory never writes these files; `sfactory doctor` checks that they exist.

## 4. Set up a project

Run these in the repository root.

```bash
sfactory init      # writes sfactory.config.json from CLAUDE.md, package.json and the git layout, and adds .gitignore lines
sfactory doctor    # validates the config; checks git, node, the agents of your mode, the Codex profile files, ports, the state dir
sfactory board     # serves the kanban board on http://127.0.0.1:4317
```

- `init` prints what it guessed and what it could not; edit the file, then commit it. `sfactory init --force` replaces an existing config. A worked example is `examples/spec-tree-monorepo.config.json`.
- `doctor` must exit 0 before any card moves; it prints a `FAIL` row for each problem and what fixes it.
- **Secrets.** List credential files in `secrets.neverHandToAgents`. Agents work in a card's worktree from planning on, so `worktrees.copyFromBase` (copied at the cut) never carries one: the cut refuses it with `SECRET_PATH`, and `doctor` warns. A file the verify stage needs (an API's `.env`, say) goes in `worktrees.copyForVerify`: `sfactory services copy <id>` or `sfactory services up <id>` copies it into the worktree, and `sfactory services down <id>`, `sfactory job stop <id>` and `sfactory worktree remove <id>` remove it.
- `board` stays up until Ctrl+C (or SIGTERM); in a Claude Code session, where `/sfactory board` runs it as a background task, stop that task. The port is `board.port` in the config (default 4317); `--port n` overrides it. `sfactory board --demo` needs no config and shows sample cards, read-only.
- An existing project can import its finished and planned work once: see README, "Bringing an existing project".

In a Claude Code session the same three are `/sfactory init`, `/sfactory doctor` and `/sfactory board`. Then add a card with `/sfactory add milestone "<title>"` or `/sfactory add fix "<title>"` and start with `/sfactory run`.

## 5. Updating

- Plugin: `/plugin marketplace update sfactory`. A new copy is installed when the plugin's version changes, and every release bumps it.
- npm: `npm install -g sfactory@latest`. If you used `sfactory install`, run it again afterwards; it keeps files you have edited and tells you which, and `--force` replaces them.

Check what you have with `sfactory version`.

## 6. Uninstalling

- Plugin: `/plugin uninstall sfactory`, and optionally `/plugin marketplace remove sfactory`.
- npm: `npm uninstall -g sfactory`.
- Copied files: `sfactory install` placed these, and you delete them by hand. In the repo's `.claude/`: `skills/sfactory/`, `skills/brainstorming/`, `skills/writing-plans/`, `skills/sdd/`; `agents/implementer.md`, `agents/spec-reviewer.md`, `agents/code-reviewer.md`, `agents/judge.md`, `agents/triage.md`; `prompts/codex-implement.md`, `prompts/codex-review.md`, `prompts/codex-judge.md`, `prompts/ATTRIBUTION.md`. With `--codex`, in `~/.codex/skills/`: `sfactory/`, `brainstorming/`, `writing-plans/`, `sdd/`.
- Per project: the state directory (`stateDir`, default `.sfactory/`), `sfactory.config.json` and any worktrees under `worktrees.dir` (`sfactory worktree remove <id>` for each card). Branches the factory pushed stay until you delete them.
