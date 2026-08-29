const CLI_NAMES = Object.freeze({ codex: "Codex", claude: "Claude Code", qwen: "Qwen Code" });

export const PERMISSION_CONFIGURATION_REQUIRED = "CLI_PERMISSION_CONFIGURATION_REQUIRED";

export function permissionConfigurationMessage(cli = "codex") {
	const name = CLI_NAMES[cli] ?? cli;
	return `${name} 权限不足，且当前会话无法批准本次权限申请。请前往“设置 → 插件 → 外部 Agent CLI 管理器 → ${name} → 权限”，将权限调整为“完全”，保存后重新执行任务。当前任务已停止，不会自动提权或重复运行。`;
}

export function permissionConfigurationError(cli = "codex", cause) {
	const error = new Error(permissionConfigurationMessage(cli), cause === undefined ? undefined : { cause });
	error.code = PERMISSION_CONFIGURATION_REQUIRED;
	error.cli = cli;
	return error;
}

export function isPermissionRejection(error) {
	const text = error instanceof Error ? `${error.message}\n${error.cause ?? ""}` : String(error ?? "");
	return /rejected by user|approval prompts are disabled|approval.*(?:rejected|unavailable)|sandbox_permissions.*(?:denied|rejected)|permission(?: request)?(?: was)? (?:denied|rejected)/i.test(text);
}

export function withPermissionGuidance(error, cli = "codex") {
	return isPermissionRejection(error) ? permissionConfigurationError(cli, error) : error;
}
