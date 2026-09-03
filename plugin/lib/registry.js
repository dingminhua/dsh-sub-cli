// dsh-sub-cli CLI registry: the external Agent CLIs this plugin manages.
// Each entry carries the binary name, the config-isolation env var, the install
// hint shown in the Web panel, and a headless argv template used by dispatch.
//
// Config isolation design: the plugin never touches the user's system defaults
// (~/.codex/config.toml, ~/.claude/settings.json, ...). On dispatch it points
// each CLI's config dir to <unifiedDir>/config-<cli>/ via that CLI's own env var.

import { deriveSandboxMode } from "./permissions.js";

/** The two permission tiers offered per CLI (2026-09 simplification). Default: read-only. */
export const PERMISSION_TIERS = [
	{ id: "read-only", label: "只读" },
	{ id: "danger-full-access", label: "可执行" }
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
			// No web_search flag: the three managed CLIs deliberately ship
			// without web search (2026-09 decision). Codex's web_search is a
			// Responses server-side tool that most relays never execute, and
			// the legacy `-c tools.web_search=true` form is deprecated anyway.
			// Web research stays with the controller's own search tools.
			const args = ["exec", "--json", "--skip-git-repo-check", "-s", mode];
			if (model) args.push("-m", model);
			args.push(task);
			return args;
		},
		// Protocol this CLI speaks to its model supplier; the CLI's `cli_test`
		// verifies exactly this (and the tool-continuation it needs).
		protocol: "responses",
		protocolLabel: "OpenAI Responses 协议（Codex 所需，含工具续接）",
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
			// Claude permission-mode maps the two tiers: read-only=plan (no
			// edit tools at all), executable=bypassPermissions. The middle
			// acceptEdits tier is gone with the workspace-write tier (2026-09):
			// its real boundary was wider than "just writes" (round-12 finding 6
			// — file commands incl. deletion were silently auto-accepted).
			const mode = tierOf(permission) === "read-only" ? "plan" : "bypassPermissions";
			const args = ["-p", "--output-format", "text", "--permission-mode", mode];
			if (model) args.push("--model", model);
			args.push(task);
			return args;
		},
		protocol: "anthropic",
		protocolLabel: "Anthropic Messages 协议（Claude Code 所需，含 tool_use 续接）",
		install: "安装 Claude Code，把可执行文件放到统一目录的 bin/claude。"
	}
];

// Qwen Code support was REMOVED (2026-09 product decision): the CLI proved too
// flaky in practice — its headless stream-json wire emits no tool_use events
// (driver interception was dead code), every permission tier rides on a single
// settings.json key it rewrites on startup, and real-run reliability was poor.
// The registry now manages Codex and Claude Code only.

/** Look up one CLI entry by id. */
export function cliById(id) {
	return CLI_REGISTRY.find((entry) => entry.id === id) ?? null;
}
