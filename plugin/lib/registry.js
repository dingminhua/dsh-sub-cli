// dsh-sub-cli CLI registry: the external Agent CLIs this plugin manages.
// Each entry carries the binary name, the config-isolation env var, the install
// hint shown in the Web panel, and a headless argv template used by dispatch.
//
// Config isolation design: the plugin never touches the user's system defaults
// (~/.codex/config.toml, ~/.claude/settings.json, ...). On dispatch it points
// each CLI's config dir to <unifiedDir>/config-<cli>/ via that CLI's own env var.

export const CLI_REGISTRY = [
	{
		id: "codex",
		name: "Codex",
		bin: "codex",
		env: "CODEX_HOME",
		configDir: "config-codex",
		npm: "@openai/codex",
		// headless argv template: {task} is the self-contained prompt, {model} optional -m.
		argv: (task, model) => {
			const args = ["exec", "--json"];
			if (model) args.push("-m", model);
			args.push(task);
			return args;
		},
		install: "安装 Codex，把可执行文件放到统一目录的 bin/codex。"
	},
	{
		id: "claude",
		name: "Claude Code",
		bin: "claude",
		env: "CLAUDE_CONFIG_DIR",
		configDir: "config-claude",
		npm: "@anthropic-ai/claude-code",
		argv: (task, model) => {
			const args = ["-p", "--output-format", "text"];
			if (model) args.push("--model", model);
			args.push(task);
			return args;
		},
		install: "安装 Claude Code，把可执行文件放到统一目录的 bin/claude。"
	},
	{
		id: "qwen",
		name: "Qwen Code",
		bin: "qwen",
		env: "QWEN_HOME",
		configDir: "config-qwen",
		npm: "@qwen-code/qwen-code",
		argv: (task, model) => {
			const args = [];
			if (model) args.push("--model", model);
			args.push("--prompt", task);
			return args;
		},
		install: "安装 Qwen Code，把可执行文件放到统一目录的 bin/qwen。"
	}
];

/** Look up one CLI entry by id. */
export function cliById(id) {
	return CLI_REGISTRY.find((entry) => entry.id === id) ?? null;
}
