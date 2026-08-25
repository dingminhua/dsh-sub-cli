# dsh-sub-cli

A DeepSeek Harness (DSH) plugin that manages external Agent CLIs.

- Put Codex, Claude Code, OpenCode, and Gemini CLI binaries into a **unified
  dir** (default `~/dsh-clis`) instead of the system PATH;
- Each CLI uses a **mutually isolated config dir** (`config-<cli>/`, pointed to
  via that CLI's own env var) — your existing system CLI config is never
  touched;
- A Web settings card configures the unified dir plus a **three-layer model
  route** per CLI (`provider` → `model` → `reasoning effort`);
- Registers a **`cli_dispatch`** model tool so the DSH model can run an
  external CLI headless and return its output;
- Each CLI can be driven from its own conversation via `cli_dispatch`.

## Features

- **Unified dir**: all CLI binaries under `~/dsh-clis/bin/`, configs under
  `~/dsh-clis/config-<cli>/`;
- **Config isolation**: sets `CODEX_HOME` / `CLAUDE_CONFIG_DIR` /
  `OPENCODE_CONFIG` / `GEMINI_CONFIG_DIR` to the isolated config dir at dispatch;
- **Three-layer model route**: per-CLI provider → model → reasoning effort;
- **Headless dispatch**: `cli_dispatch` runs the CLI with an argv array (no
  shell-string interpolation), handling timeout, output caps, exit code and stderr;
- **Persistence**: the unified dir and model routes are written to
  `~/.dsh/settings.yaml` via `installSettingsSection`, surviving restarts.

## Install

Add it to a DSH profile as a plugin directory:

```bash
dsh plugin --profile desktop add <path>/plugin
```

Or as an npm package:

```bash
npm install dsh-sub-cli
```

## Usage

1. Open **Settings → Plugins → External Agent CLI manager (dsh-sub-cli)**;
2. Type or browse for the **unified CLI dir** (default `~/dsh-clis`);
3. Place the CLI binaries into `<dir>/bin/`;
4. Pick provider, model, and reasoning effort for each CLI, then save;
5. Ask DSH to use a CLI (the model calls `cli_dispatch`).

## Configuration

| Field | Description |
|---|---|
| `cliDir` | Unified dir; default `~/dsh-clis` |
| `models.<cli>.provider` | Provider for that CLI |
| `models.<cli>.model` | Model for that CLI |
| `models.<cli>.reasoningEffort` | Reasoning effort for that CLI |

`<cli>` is one of `codex` / `claude` / `opencode` / `gemini`.

## Env-var isolation

| CLI | Config-dir env var |
|---|---|
| Codex | `CODEX_HOME` |
| Claude Code | `CLAUDE_CONFIG_DIR` |
| OpenCode | `OPENCODE_CONFIG` |
| Gemini CLI | `GEMINI_CONFIG_DIR` |

## Development

```bash
npm test        # run unit tests
npm pack --dry-run
```

See `DEVELOPMENT.md` and `PLUGIN_REQUIREMENTS.md`.

## Licence

[MIT](LICENSE)
