import assert from "node:assert/strict";
import test from "node:test";
import {
	PERMISSION_CONFIGURATION_REQUIRED,
	isPermissionRejection,
	permissionConfigurationError,
	permissionConfigurationMessage,
	withPermissionGuidance
} from "../lib/permission-guidance.js";

test("permission guidance stops at reporting and forbids self-authorization", () => {
	const text = permissionConfigurationMessage("codex");
	assert.match(text, /设置 → 插件 → 外部 Agent CLI 管理器 → Codex → 权限/);
	// 授权模型（审批模式已移除，2026-09）：勾选框是唯一授权，档位启动时定死。
	// 未勾选的能力被触发 → 确定拒绝 → 任务停止报告，没有弹窗或绕行开关。
	assert.match(text, /未在权限档位中授予/);
	assert.match(text, /不会自动提权或重跑/);
	assert.match(text, /严禁修改 ~\/\.dsh\/settings\.yaml/);
	assert.doesNotMatch(text, /弹窗/);
	assert.doesNotMatch(text, /“完全”/);
	assert.match(permissionConfigurationMessage("claude"), /Claude Code → 权限/);
});

test("recognizes approval rejection diagnostics but not ordinary failures", () => {
	assert.equal(isPermissionRejection('Rejected("rejected by user")'), true);
	assert.equal(isPermissionRejection("Approval prompts are disabled in this session"), true);
	assert.equal(isPermissionRejection("permission request was denied"), true);
	assert.equal(isPermissionRejection("network DNS lookup failed"), false);
});

test("wraps only permission rejection with a structured configuration error", () => {
	const cause = new Error("rejected by user");
	const wrapped = withPermissionGuidance(cause, "codex");
	assert.equal(wrapped.code, PERMISSION_CONFIGURATION_REQUIRED);
	assert.equal(wrapped.cli, "codex");
	assert.equal(wrapped.cause, cause);
	const ordinary = new Error("timeout");
	assert.equal(withPermissionGuidance(ordinary, "codex"), ordinary);
	assert.equal(permissionConfigurationError("qwen").code, PERMISSION_CONFIGURATION_REQUIRED);
});
