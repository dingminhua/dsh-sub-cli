// dsh-sub-cli CLI registry: the external Agent CLIs this plugin manages.
// Each entry carries the binary name, the config-isolation env var, the install
// hint shown in the Web panel, and a headless argv template used by dispatch.
//
// Config isolation design: the plugin never touches the user's system defaults
// (~/.codex/config.toml, ~/.claude/settings.json, ...). On dispatch it points
// each CLI's config dir to <unifiedDir>/config-<cli>/ via that CLI's own env var.

import { deriveSandboxMode } from "./permissions.js";

/** The three permission tiers offered per CLI. Default: workspace-write. */
export const PERMISSION_TIERS = [
	{ id: "read-only", label: "只读" },
	{ id: "workspace-write", label: "工作区可写" },
	{ id: "danger-full-access", label: "完全" }
];

export const DEFAULT_PERMISSION = "read-only";

/**
 * Resolve the coarse sandbox tier for a headless run from a permission value
 * (legacy string tier or fine-grained capability profile object).
 */
function tierOf(permission) {
	return deriveSandboxMode(permission) || DEFAULT_PERMISSION;
}

export const CLI_REGISTRY = [
	{
		id: "codex",
		name: "Codex",
		bin: "codex",
		env: "CODEX_HOME",
		configDir: "config-codex",
		npm: "@openai/codex",
		// headless argv template: {task} is the self-contained prompt, {model} optional -m,
		// {permission} a legacy tier string or capability profile mapped to Codex's -s sandbox mode.
		// --skip-git-repo-check: the unified dir is usually not a git repo.
		// -s <mode>: read-only / workspace-write / danger-full-access — the tier the
		//   user selected for this CLI (default workspace-write). Unattended (no TTY).
		argv: (task, model, permission) => {
			const mode = tierOf(permission);
			const args = ["exec", "--json", "--skip-git-repo-check", "-s", mode];
			if (model) args.push("-m", model);
			args.push(task);
			return args;
		},
		// Protocol this CLI speaks to its model supplier; the CLI's `cli_test`
		// verifies exactly this (and the tool-continuation it needs).
		protocol: "responses",
		protocolLabel: "OpenAI Responses 协议（Codex 所需，含工具续接）",
		// The CLI ships no web tool of its own, so a network task must be refused
		// before launch rather than failing once the process is already running.
		webTools: false,
		install: "安装 Codex，把可执行文件放到统一目录的 bin/codex。"
	},
	{
		id: "claude",
		name: "Claude Code",
		bin: "claude",
		env: "CLAUDE_CONFIG_DIR",
		configDir: "config-claude",
		npm: "@anthropic-ai/claude-code",
		argv: (task, model, permission) => {
			// Claude permission-mode maps the tier: read-only=plan (no edits),
			// workspace-write=acceptEdits (auto-accept workspace edits),
			// danger-full-access=bypassPermissions.
			const mode = {
				"read-only": "plan",
				"workspace-write": "acceptEdits",
				"danger-full-access": "bypassPermissions"
			}[tierOf(permission)] || "acceptEdits";
			const args = ["-p", "--output-format", "text", "--permission-mode", mode];
			if (model) args.push("--model", model);
			args.push(task);
			return args;
		},
		protocol: "anthropic",
		protocolLabel: "Anthropic Messages 协议（Claude Code 所需，含 tool_use 续接）",
		// Claude Code is the only managed CLI shipping WebSearch + WebFetch.
		webTools: true,
		install: "安装 Claude Code，把可执行文件放到统一目录的 bin/claude。"
	},
	{
		id: "qwen",
		name: "Qwen Code",
		bin: "qwen",
		env: "QWEN_HOME",
		configDir: "config-qwen",
		npm: "@qwen-code/qwen-code",
		argv: (task, model, permission) => {
			// Qwen only exposes a boolean `--sandbox`; map read-only → sandbox on,
			// workspace-write / danger-full-access → no flag (Qwen has no finer
			// granularity; document this limitation).
			const args = [];
			if (tierOf(permission) === "read-only") args.push("--sandbox");
			if (model) args.push("--model", model);
			args.push("--prompt", task);
			return args;
		},
		protocol: "openai-chat",
		protocolLabel: "Chat Completions 协议（Qwen Code 所需，含 tool_calls 续接）",
		// No built-in web tool; network tasks are refused before launch.
		webTools: false,
		install: "安装 Qwen Code，把可执行文件放到统一目录的 bin/qwen。"
	}
];

/** Look up one CLI entry by id. */
export function cliById(id) {
	return CLI_REGISTRY.find((entry) => entry.id === id) ?? null;
}
