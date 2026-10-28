# Installing sfactory

Requirements: Node 20 or later and git; Claude Code for the `claude` and `mixed` modes; the Codex CLI for the `codex` and `mixed` modes.

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

For a machine that cannot add a marketplace, for CI, and for a Codex-only user:

```bash
npm install -g sfactory        # or run one-off commands with: npx sfactory <command>
sfactory install               # copies skills/, agents/ and prompts/ into this repo's .claude/
sfactory install --codex       # skills only, into ~/.codex/skills/
```

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
- `board` stays up until Ctrl+C. The port is `board.port` in the config (default 4317); `--port n` overrides it. `sfactory board --demo` needs no config and shows sample cards, read-only.

In a Claude Code session the same three are `/sfactory init`, `/sfactory doctor` and `/sfactory board`. Then add a card with `/sfactory add milestone "<title>"` or `/sfactory add fix "<title>"` and start with `/sfactory run`.

## 5. Updating

- Plugin: `/plugin marketplace update sfactory`. A new copy is installed when the plugin's version changes, and every release bumps it.
- npm: `npm install -g sfactory@latest`. If you used `sfactory install`, run it again afterwards; it keeps files you have edited and tells you which, and `--force` replaces them.

Check what you have with `sfactory version`.

## 6. Uninstalling

- Plugin: `/plugin uninstall sfactory`, and optionally `/plugin marketplace remove sfactory`.
- npm: `npm uninstall -g sfactory`.
- Copied files: delete the `sfactory*` folders and agent and prompt files that `sfactory install` placed in the repo's `.claude/` (or in `~/.codex/skills/`).
- Per project: the state directory (`stateDir`, default `.sfactory/`), `sfactory.config.json` and any worktrees under `worktrees.dir` (`sfactory worktree remove <id>` for each card). Branches the factory pushed stay until you delete them.
