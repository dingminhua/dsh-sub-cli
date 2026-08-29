# dsh-sub-cli

A DeepSeek Harness (DSH) plugin for managing external Agent CLIs.

- Installs Codex, Claude Code, and Qwen Code under one managed directory (default `~/dsh-clis`) without using the system PATH;
- Gives every CLI an isolated config root (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `QWEN_HOME`) and never modifies the user's system CLI configuration;
- Provides a Web settings card for provider, model, reasoning effort, permission tier, installation, and protocol verification;
- Registers `cli_codex`, `cli_claude_code`, and `cli_qwen` delegation tools;
- Provides persistent-in-Host Codex thread controls: `cli_codex_followup`, `cli_codex_status`, `cli_codex_sessions`, and `cli_codex_interrupt`;
- Keeps `cli_dispatch` as an explicit one-shot headless fallback.

## Features

- **Managed layout**: binaries under `~/dsh-clis/bin/`, package installs under `vendor/`, and isolated runtime/config state under `config-<cli>/`;
- **Route verification**: verifies the CLI's required protocol and tool continuation before dispatch;
- **Codex app-server driver**: uses real `thread/start`, `turn/start`, `turn/interrupt`, streaming deltas, usage, and same-thread follow-up;
- **Secret-free session records**: records cwd, route, permission tier, status, and remote thread id, but never an API key;
- **Concurrency guard**: one active turn per managed session; overlapping follow-up calls fail with `SESSION_BUSY`.

## Install

```bash
dsh plugin --profile desktop add <path>/plugin
```

or:

```bash
npm install dsh-sub-cli
```

Restart the target DSH profile after installation or upgrade.

## Usage

1. Open **Settings → Plugins → External Agent CLI manager**;
2. Select the managed CLI directory;
3. Install the required CLI from the card;
4. Select provider, model, reasoning effort, and permission tier;
5. Run the connection/protocol test;
6. Ask DSH to use `cli_codex`, `cli_claude_code`, or `cli_qwen`.

### Codex continued sessions

First turn:

```text
cli_codex(description, prompt)
→ { sessionId, status, output }
```

Later turns and control:

```text
cli_codex_followup(sessionId, prompt)
cli_codex_status(sessionId)
cli_codex_sessions()
cli_codex_interrupt(sessionId)
```

These are plugin-specific continuation tools, not DSH native `send_message`. Follow-ups are sent to the same real Codex thread without a relay model. The current registry is Host-memory scoped, so a Host restart currently requires creating a new managed session; durable storage recovery is planned separately.

## Environment isolation

| CLI | Config root variable |
|---|---|
| Codex | `CODEX_HOME` |
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Qwen Code | `QWEN_HOME` |

## Development

```bash
npm test
npm pack --dry-run
```

## Licence

[MIT](LICENSE)
