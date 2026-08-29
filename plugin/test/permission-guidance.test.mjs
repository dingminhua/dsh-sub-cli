import assert from "node:assert/strict";
import test from "node:test";
import {
	PERMISSION_CONFIGURATION_REQUIRED,
	isPermissionRejection,
	permissionConfigurationError,
	permissionConfigurationMessage,
	withPermissionGuidance
} from "../lib/permission-guidance.js";

test("permission guidance points to the exact CLI settings path and full tier", () => {
	const text = permissionConfigurationMessage("codex");
	assert.match(text, /设置 → 插件 → 外部 Agent CLI 管理器 → Codex → 权限/);
	assert.match(text, /“完全”/);
	assert.match(text, /不会自动提权或重复运行/);
	assert.match(permissionConfigurationMessage("claude"), /Claude Code → 权限/);
	assert.match(permissionConfigurationMessage("qwen"), /Qwen Code → 权限/);
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
