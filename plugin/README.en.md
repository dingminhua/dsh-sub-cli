# dsh-sub-cli

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#install">Install</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/dingminhua/dsh-sub-cli/issues">Feedback</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-sub-cli"><img src="https://img.shields.io/npm/v/dsh-sub-cli?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-sub-cli"><img src="https://img.shields.io/npm/d18m/dsh-sub-cli?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/dingminhua/dsh-sub-cli/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dingminhua/dsh-sub-cli/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dingminhua/dsh-sub-cli?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dingminhua/dsh-sub-cli/stargazers"><img src="https://img.shields.io/github/stars/dingminhua/dsh-sub-cli?style=flat-square" alt="GitHub stars"></a>
  <a href="https://dshfind.com/plugins/dingminhua/dsh-sub-cli"><img src="https://dshfind.com/api/badge/dingminhua/dsh-sub-cli" alt="dshfind plugin"></a>
</p>

A DeepSeek Harness (DSH) plugin for managing external Agent CLIs.

- Puts Codex and Claude Code under one **managed directory** (default `~/dsh-clis`) without touching the system PATH (Qwen Code support was removed in 2026-09);
- Gives every CLI an **isolated config directory** (`config-<cli>/`) pointed at via the CLI's own environment variables — your system-installed CLI configuration is **never touched**;
- The Web settings card configures the managed directory plus a **three-layer model route** (provider → model → reasoning effort) per CLI;
- Registers **18 model tools** covering "CLI × mode" (**suffixed entry points only**):
  - Continued sessions (per CLI): `cli_codex_direct` / `cli_claude_direct` (first turn; returns a `sessionId`) plus `cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions` / `cli_<cli>_interrupt`;
  - Relay subagents (per CLI): `cli_codex_subagent` / `cli_claude_subagent` (creates a DSH continuable child that forwards the task to the real thread via `managed_cli_submit`);
  - Headless dispatch: `cli_dispatch`;
  - Lifecycle: `cli_check` / `cli_install` / `cli_test` / `cli_remove` (install / detect / verify / remove);
  - **18 = 2 direct + 2 subagent + 8 session tools (followup/status/sessions/interrupt × 2) + 1 dispatch + 4 lifecycle + 1 internal `managed_cli_submit`**;
  - The `cli_codex` alias is gone; the unsuffixed one-shot tools `cli_claude_code` / `cli_qwen` and their `managed-<cli>` provider **were removed** — they had no session capability and duplicated `cli_dispatch`;
    > **To run several CLIs at once use `cli_<cli>_subagent`**: it returns a subagent id immediately and the children run in parallel — **no background-job (jobs) plugin required**.
- Every CLI has a continued-session driver (Codex: app-server; Claude: stream-json), exposing **`cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions` / `cli_<cli>_interrupt`**;
- Registers the **`cli_dispatch`** model tool for one-shot headless CLI invocation with output returned to the conversation.

## Features

- **Managed layout**: all CLI binaries under `~/dsh-clis/bin/`, all config under `~/dsh-clis/config-<cli>/`;
- **Config isolation**: launches set `CODEX_HOME` / `CLAUDE_CONFIG_DIR` to the managed dirs; system defaults are never touched;
- **Three-layer model route**: provider → model → reasoning effort, configured per CLI;
- **Headless dispatch**: `cli_dispatch` executes the CLI with an argv array (no shell string concatenation) and handles timeouts, output caps, exit codes, and stderr;
- **Continued sessions for two CLIs**: the first `cli_<cli>_direct` returns a stable `sessionId`; later tools enter the same thread — Codex over a long-lived app-server connection, Claude via stream-json one-process-per-turn plus `--session-id`/`--resume` file-level persistence — no relay model in between;
- **Settings persistence**: the managed directory and model routes are written to `~/.dsh/settings.yaml` via `installSettingsSection` and survive restarts;
- **Session persistence**: the session registry (including remote thread ids) is written to `sessions.json` in the managed directory; after a Host restart `cli_<cli>_followup` reattaches the same thread from `sessionId` directly, no re-creation needed;
- **Auto-continue**: when an answer looks like a premature stop (plans only, no deliverable), the service nudges the same conversation until the result is complete, so a single `cli_<cli>_direct` call returns the full report. Each CLI has a `max` setting in the card (default 3; **0 disables it** — there is no separate switch). **Generalization note**: the nudge depends on same-thread follow-up, so it applies to every continued-session call (Codex/Claude); the `INTENT_TAIL` regex recognizes both Chinese and English intent sentences.

## Built-in tool capabilities per CLI

This plugin does not touch the CLIs' tools — whatever a CLI has, it uses. What the two CLIs can actually invoke on the `cli_<cli>_direct` / `cli_<cli>_subagent` continued-session paths:

| Capability | Codex (app-server) | Claude Code (stream-json) |
|------|:------------------:|:--------------------------:|
| File read/write (Read / Write / Edit / Glob / Grep) | ✅ | ✅ |
| Shell commands (exec / Bash) | ✅ | ✅ |
| Internal subagents (Agent / Task / spawn) | ✅ | ✅ |

> Qwen Code support was removed in 2026-09 — its real-world reliability was insufficient (stream-json emits no tool_use events, its permission model depends on a single config key the CLI rewrites at startup, and repeated live runs hit transient failures). The managed CLIs are Codex and Claude Code.

**Division of labour: the controller researches online, the CLIs work offline.**

- **Web search / research / URL fetching**: done by the controller with DSH's own `advanced_search` / `web_fetch` / `platform_search` — **both managed CLIs deliberately ship WITHOUT web search** (2026-09 product decision). Rationale: Codex web_search and Claude WebSearch are provider-side server tools that relays generally never execute. The controller's own search stack has none of these limits;
- **Code work (read / write / edit / run commands)**: two CLIs are fully symmetric — pick by preference;
- **Multi-step complex tasks**: use a Relay subagent (`cli_<cli>_subagent`) and let the child keep pushing;
- **If a CLI must handle research material**: the controller researches first, then hands the material over as task content.

> Permissions in the settings card are a single two-tier dropdown: **read-only / executable** (2026-09 simplification — the middle "writable" tier was removed because it was the vaguest of the three: on that tier Codex could not actually write files (its write path is `exec_command`), while Claude's `acceptEdits` boundary was wider than "files only" (verified: a delete command was silently accepted and executed, see VERIFICATION-FLOW round 12 finding 6)). The two tiers are unambiguous: **read-only = look only**; **executable = run commands, write/delete files, install dependencies**. Reading is allowed in both tiers. The tier is fixed at startup — no prompts, no runtime escalation — and ungranted capabilities are deterministically rejected with a clear error when triggered. File access is limited to the current working area (each CLI's own sandbox treats anything outside the workspace as requiring escalation).

## Install

Add via the plugin directory in DSH:

```bash
dsh plugin --profile desktop add <path>/plugin
```

or install as an npm package:

```bash
npm install dsh-sub-cli
```

## Usage

1. Open **Settings → Plugins → External Agent CLI manager (dsh-sub-cli)**;
2. Fill in or browse to the **managed CLI directory** (default `~/dsh-clis`);
3. Install the required CLI binaries into `<dir>/bin/`;
4. Pick provider, model, and reasoning effort for each CLI and save;
5. Ask DSH to use the CLIs in conversation: day-to-day delegation via `cli_<cli>_direct` (continued session, direct) or `cli_<cli>_subagent` (DSH Relay subagent forwarding the task); **to schedule several CLIs at once use `cli_<cli>_subagent`** (it returns a subagent id immediately and the CLIs run in parallel); use `cli_dispatch` only when you explicitly want a one-shot headless run.

### Continued sessions (all CLIs)

First turn:

```text
cli_<cli>_direct(description, prompt)  # codex / claude
→ { sessionId, status, output }
```

Later (`cli` = codex / claude):

```text
cli_<cli>_followup(sessionId, prompt)  # same real thread
cli_<cli>_status(sessionId)            # status, cwd, model, permissions
cli_<cli>_sessions()                   # session list for this Host
cli_<cli>_interrupt(sessionId)         # interrupt the current turn
```

### Relay subagents (all CLIs)

Every CLI has a Relay subagent — a DSH-native continuable child that forwards tasks to the real CLI via `managed_cli_submit`:

```text
cli_<cli>_subagent(description, prompt)  # codex / claude
→ { kind: "continuable", subagentId }
```

Continue with `send_message`, interrupt with `interrupt_agent`. These are plugin-specific continuation tools, not DSH-native `send_message`. One active turn per session; overlapping follow-ups fail with `SESSION_BUSY`.

## Configuration

| Field | Description |
|---|---|
| `cliDir` | Managed directory, default `~/dsh-clis` |
| `models.<cli>.provider` | Provider for this CLI |
| `models.<cli>.model` | Model for this CLI |
| `models.<cli>.reasoningEffort` | Reasoning effort for this CLI |
| `autoContinue.<cli>.max` | Auto-continue nudges (0–10, default 3; **0 = off**. Legacy `enabled:false` normalizes to 0; the field itself is deprecated) |
| `turnTimeoutMinutes.<cli>` | Silence probe point in minutes (3/5/10, default 5). At the deadline the driver probes first: an exited process delivers its real result, a still-emitting one keeps waiting with every active window renewed, and only 60s of continuous silence counts as stuck |

`<cli>` is `codex` / `claude`.

## How it works

On startup the plugin registers 18 model tools with the DSH Host and isolates each managed CLI's config directory under the unified `config-<cli>/` subdirectory.

**Session lifecycle** (example: `cli_claude_direct`):

1. **Install** (`cli_install`): puts the CLI binary into `bin/` under the unified directory;
2. **Config isolation**: at launch, `CODEX_HOME` / `CLAUDE_CONFIG_DIR` point at the plugin's own config directory, leaving the system install untouched;
3. **First call** (`cli_<cli>_direct`): spawns the CLI process, returns a stable `sessionId`;
4. **Resume** (`cli_<cli>_followup`): subsequent calls reuse the same `sessionId`, and the CLI reattaches to the same thread via `--session-id` / `--resume`;
5. **Persistence**: `sessions.json` records each session's remote thread id, surviving Host restarts;
6. **Relay subagent** (`cli_<cli>_subagent`): forwards the task to the real CLI via `managed_cli_submit`, with permissions governed by the plugin's two-tier model (read-only / executable).

**Two permission tiers**: the `permissions.<cli>` tier in `## Configuration` fixes the sandbox mode at startup (Codex `-s`, Claude `--permission-mode`) and never escalates mid-run; triggering an ungranted capability deterministically rejects without prompting.

## Environment isolation

| CLI | Config root variable |
|---|---|
| Codex | `CODEX_HOME` |
| Claude Code | `CLAUDE_CONFIG_DIR` |

## Development

```bash
npm test        # unit tests
npm pack --dry-run
```

See `DEVELOPMENT.md` and `PLUGIN_REQUIREMENTS.md`.

## Acknowledgements

This plugin builds on work others have published. Sources and licenses are credited honestly below; we hold that in genuine respect.

### Principal reference for CLI management and the Relay subagent

- [dingminhua/dsh-subagent-default-model](https://github.com/dingminhua/dsh-subagent-default-model) (MIT, Copyright (c) 2026 LaoDing) — **the principal reference for this project.** The multi-CLI registry, argv templates, three-layer model route, isolated config directory, the `managed_cli_submit` Relay-subagent shape, the DSH Web card styling, and the npm release engineering were all studied from it and independently reimplemented. The local `reference/dsh-subagent-default-model/` directory in this repository is the archived implementation of that project; it is consulted only during local development and is not shipped in the npm package.

### Reference for external-CLI dispatch

- [MJorgin/dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor) (MIT, Copyright (c) 2026 MJorgin) — `subprocess.spawn`-based headless dispatch of 11 external Agent CLIs in a DSH session. The argv-array dispatch, timeout and error reporting, and exit-code handling in this plugin were refined against its implementation.

### Protocol research (not on the main path)

- [wujfeng712-ui/codex-bridge](https://github.com/wujfeng712-ui/codex-bridge) (MIT) — Responses API ↔ Chat Completions two-way translation with `previous_response_id` resume, recorded during research as an alternative protocol path. **It is not referenced on the main path**; no source or binary dependency is taken from it.

### Note

Copyright in each project above belongs to its respective author. This project follows a **learn-the-design, write-our-own-code** approach and does not copy any reference project's source wholesale; key modules are written independently and each file's header comment names the specific project and pattern it draws on. If you find an attribution missing or incorrect, please open an issue and we will correct it promptly.

## Third-party open-source dependencies

The open-source projects referenced here, together with their licenses and compliance notes, are recorded in full in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). When introducing new external dependencies or reusing code from other projects, update that file and honor the upstream licenses.

## Changelog

Full version history and change records live in [CHANGELOG.md](CHANGELOG.md). The most recent release:

- **0.1.0** (2026-09-05) — first release: Codex + Claude Code continued sessions, Relay subagent, headless dispatch, config isolation, auto-continue; Qwen Code support removed; permissions collapsed to two tiers (read-only / executable).
- See the `Added / Changed / Fixed / Removed` sections inside CHANGELOG.md.

## Licence

This project is licensed under the MIT License, Copyright (c) 2026 LaoDing. See [LICENSE](LICENSE).
