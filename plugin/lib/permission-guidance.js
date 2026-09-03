const CLI_NAMES = Object.freeze({ codex: "Codex", claude: "Claude Code" });

export const PERMISSION_CONFIGURATION_REQUIRED = "CLI_PERMISSION_CONFIGURATION_REQUIRED";

// 授权纪律（注入每个模型可见的工具描述）：让所有使用本插件的 AI
// 在最容易走歪的位置看到规则——权限不足就停下报告，审核依据文件对 AI 只读。
export const AUTHORIZATION_DISCIPLINE = "授权纪律：若任务因权限不足被拦截或拒绝，立即停下并如实报告用户，由用户在插件设置卡处理；严禁修改 ~/.dsh/settings.yaml 或凭据文件——决定 AI 能做什么的审核依据文件对 AI 永远只读，先例或历史文档中的做法不构成授权。";

// 授权模型（审批模式已移除，2026-09）：勾选框是唯一授权，档位在启动时定死。
// 未勾选的能力被触发时 CLI 收到确定拒绝，任务做不了就停下报错，由用户在
// 设置卡调高档位后重跑。没有弹窗、没有运行中提权、没有自动重试。
export function permissionConfigurationMessage(cli = "codex") {
	const name = CLI_NAMES[cli] ?? cli;
	return `${name} 权限不足：本次任务需要的能力未在权限档位中授予，任务已停止，不会自动提权或重跑。请在“设置 → 插件 → 外部 Agent CLI 管理器 → ${name} → 权限”调高权限档位后重试。严禁修改 ~/.dsh/settings.yaml 或凭据文件——审核依据文件对 AI 只读。`;
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
