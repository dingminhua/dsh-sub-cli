# dsh-sub-cli

A DeepSeek Harness (DSH) plugin for managing external Agent CLIs.

- Puts Codex, Claude Code, and Qwen Code under one **managed directory** (default `~/dsh-clis`) without touching the system PATH;
- Gives every CLI an **isolated config directory** (`config-<cli>/`) pointed at via the CLI's own environment variables — your system-installed CLI configuration is **never touched**;
- The Web settings card configures the managed directory plus a **three-layer model route** (provider → model → reasoning effort) per CLI;
- Registers **15 model tools** covering "CLI × mode" (**suffixed entry points only**):
  - Continued sessions (per CLI): `cli_codex_direct` / `cli_claude_direct` / `cli_qwen_direct` (first turn; returns a `sessionId`) plus `cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions` (qwen has no `sessions`);
  - Relay subagents (per CLI): `cli_codex_subagent` / `cli_claude_subagent` / `cli_qwen_subagent` (creates a DSH continuable child that forwards the task to the real thread via `managed_cli_submit`);
  - Interrupt (codex/claude): `cli_codex_interrupt` / `cli_claude_interrupt` (Qwen does not support it);
  - **15 = 3 direct + 3 subagent + 8 session tools (followup/status/sessions × 3 → 8 because qwen has no sessions) + 1 dispatch + 1 internal `managed_cli_submit`**;
  - The `cli_codex` alias is gone; the unsuffixed one-shot tools `cli_claude_code` / `cli_qwen` and their `managed-<cli>` provider **were removed** — they covered only two of the three CLIs, had no session capability, and duplicated `cli_dispatch`;
    > **To run several CLIs at once use `cli_<cli>_subagent`**: it returns a subagent id immediately and the children run in parallel — **no background-job (jobs) plugin required**.
- Every CLI has a continued-session driver (Codex: app-server; Claude/Qwen: stream-json), exposing **`cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions` / `cli_<cli>_interrupt`** (qwen has no interrupt);
- Registers the **`cli_dispatch`** model tool for one-shot headless CLI invocation with output returned to the conversation.

## Features

- **Managed layout**: all CLI binaries under `~/dsh-clis/bin/`, all config under `~/dsh-clis/config-<cli>/`;
- **Config isolation**: launches set `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `QWEN_HOME` to the managed dirs; system defaults are never touched;
- **Three-layer model route**: provider → model → reasoning effort, configured per CLI;
- **Headless dispatch**: `cli_dispatch` executes the CLI with an argv array (no shell string concatenation) and handles timeouts, output caps, exit codes, and stderr;
- **Continued sessions for all three CLIs**: the first `cli_<cli>_direct` returns a stable `sessionId`; later tools enter the same thread — Codex over a long-lived app-server connection, Claude/Qwen via stream-json one-process-per-turn plus `--session-id`/`--resume` file-level persistence — no relay model in between;
- **Settings persistence**: the managed directory and model routes are written to `~/.dsh/settings.yaml` via `installSettingsSection` and survive restarts;
- **Session persistence**: the session registry (including remote thread ids) is written to `sessions.json` in the managed directory; after a Host restart `cli_<cli>_followup` reattaches the same thread from `sessionId` directly, no re-creation needed;
- **Auto-continue**: when an answer looks like a premature stop (plans only, no deliverable), the service nudges the same conversation until the result is complete, so a single `cli_<cli>_direct` call returns the full report. Each CLI has a `max` setting in the card (default 3; **0 disables it** — there is no separate switch). **Generalization note**: the nudge depends on same-thread follow-up, so it applies to every continued-session call (Codex/Claude/Qwen); the `INTENT_TAIL` regex recognizes both Chinese and English intent sentences.

## Built-in tool capabilities per CLI

This plugin does not touch the CLIs' tools — whatever a CLI has, it uses. What the three CLIs can actually invoke on the `cli_<cli>_direct` / `cli_<cli>_subagent` continued-session paths:

| Capability | Codex (app-server) | Claude Code (stream-json) | Qwen Code (stream-json) |
|------|:------------------:|:--------------------------:|:-----------------------:|
| File read/write (Read / Write / Edit / Glob / Grep) | ✅ | ✅ | ✅ |
| Shell commands (exec / Bash) | ✅ | ✅ | ✅ |
| Internal subagents (Agent / Task / spawn) | ✅ | ✅ | ✅ |

**Division of labour: the controller researches, the CLIs execute.**

- **Web research / URL fetching**: done by the controller with DSH's own `advanced_search` / `web_fetch` / `platform_search`, **never delegated to a CLI** — dispatch attempts are refused by the capability gate with this explanation. Claude Code does ship WebSearch/WebFetch, but they are Anthropic server-side tools that only work when the provider executes them (official API or fully passthrough relays; chat-style relays measured non-working), so they are not a supported path;
- **Code work (read / write / edit / run commands)**: all three CLIs are fully symmetric — pick by preference;
- **Multi-step complex tasks**: use a Relay subagent (`cli_<cli>_subagent`) and let the child keep pushing;
- **If a CLI must handle research material**: the controller researches first, then hands the material over as task content.

> Permissions in the settings card are a single tier dropdown: **read-only ⊆ writable ⊆ full tool access**. Reading is granted in every tier (reads never prompt at runtime); capabilities granted by the tier pass silently, capabilities outside the tier prompt interactively when triggered (or are auto-rejected under "auto-reject"). "Full tool access" (exec) already carries egress intent: npm install / git clone are ordinary command execution — there is no separate network switch.

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
cli_<cli>_direct(description, prompt)  # codex / claude / qwen
→ { sessionId, status, output }
```

Later (`cli` = codex / claude / qwen):

```text
cli_<cli>_followup(sessionId, prompt)  # same real thread
cli_<cli>_status(sessionId)            # status, cwd, model, permissions
cli_<cli>_sessions()                   # session list for this Host (qwen has no such API)
cli_<cli>_interrupt(sessionId)         # interrupt the current turn (unsupported on qwen)
```

### Relay subagents (all CLIs)

Every CLI has a Relay subagent — a DSH-native continuable child that forwards tasks to the real CLI via `managed_cli_submit`:

```text
cli_<cli>_subagent(description, prompt)  # codex / claude / qwen
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
| `turnTimeoutMinutes.<cli>` | Turn timeout in minutes (10/20/30, default 20). On expiry the driver probes first: an exited process delivers its real result, a still-emitting one keeps waiting, and only a genuinely silent turn fails |

`<cli>` is `codex` / `claude` / `qwen`.

## Environment isolation

| CLI | Config root variable |
|---|---|
| Codex | `CODEX_HOME` |
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Qwen Code | `QWEN_HOME` |

## Development

```bash
npm test        # unit tests
npm pack --dry-run
```

See `DEVELOPMENT.md` and `PLUGIN_REQUIREMENTS.md`.

## Licence

[MIT](LICENSE)
