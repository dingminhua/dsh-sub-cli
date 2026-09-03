import { randomUUID } from "node:crypto";

// ── CLI-specific approval method → capability 映射 ───────────────────────────
// Codex: app-server protocol — each protocol method maps to one capability key.
export const CODEX_APPROVAL_METHODS = Object.freeze({
	"item/commandExecution/requestApproval": "command",
	"item/fileChange/requestApproval": "file-change",
	"item/permissions/requestApproval": "permissions"
});

// Claude Code: stream-json protocol — each tool_use name maps to one capability.
// These are the write-capable tools Claude Code may emit; read tools (Read,
// WebFetch, Glob, Grep, etc.) are always allowed silently.
export const CLAUDE_APPROVAL_METHODS = Object.freeze({
	"Bash": "command",
	"Write": "file-change",
	"MultiWrite": "file-change",
	"Edit": "file-change",
	"Delete": "file-change",
	"NpmcliLifecyclePlugin": "command",
	"WebSearch": "exec",
	"WebFetcher": "exec"
});

// Qwen Code: stream-json protocol — same mapping as Claude (Wenxin/Workspace-compatible tool names).
export const QWEN_APPROVAL_METHODS = Object.freeze({
	"Bash": "command",
	"Write": "file-change",
	"MultiWrite": "file-change",
	"Edit": "file-change",
	"Delete": "file-change",
	"NpmcliLifecyclePlugin": "command",
	"WebSearch": "exec",
	"WebFetcher": "exec"
});

export const MANAGED_PERMISSION_DECISIONS = Object.freeze(["allowed-once", "rejected", "cancelled", "unavailable"]);

// ── Fine-grained permission profiles ─────────────────────────────────────────
// Each CLI's permission is stored as a capability object:
//   { read, write, exec, approval }
// Three capabilities only — the network flag is gone. Granting "exec" already
// means the CLI process may reach the network: npm install / git pull are
// ordinary parts of command execution, and a sandbox that allows commands but
// blocks the network cannot run them. Users who want no egress simply leave
// exec unchecked; Codex then lands in read-only.
// Legacy string tiers are accepted everywhere and normalized to a profile.

// The checkbox is the only grant: checked = allowed silently at runtime.
// `approval` is the strategy for what happens when an UNCHECKED capability is
// requested: ask interactively, or auto-reject.

export const APPROVAL_MODES = Object.freeze(["ask", "never"]);

export const PERMISSION_PRESETS = Object.freeze([
	// Default: only read is granted; write/exec are NOT granted and the CLI is
	// launched with a fixed, narrow sandbox tier. There is no ask/deny toggle:
	// an ungranted capability simply means the task stops and is reported as
	// not-completable. No popup, no runtime escalation — the tier is decided at
	// launch and cannot widen mid-turn.
	{ id: "read-only", label: "只读", profile: Object.freeze({ read: true, write: false, exec: false, approval: "never" }) },
	{ id: "workspace-write", label: "工作区可写", profile: Object.freeze({ read: true, write: true, exec: false, approval: "never" }) },
	{ id: "danger-full-access", label: "完全", profile: Object.freeze({ read: true, write: true, exec: true, approval: "never" }) }
]);

export const DEFAULT_PROFILE = Object.freeze({ read: true, write: false, exec: false, approval: "never" });

/**
 * Normalize a stored permission value (legacy string tier, partial object, or
 * full profile) into a complete three-capability profile. Stored `network`
 * values are dropped: exec now carries that intent (checked exec implies the
 * process may egress). Legacy `approval: "allow"` migrates to checked
 * capabilities + ask: an auto-allow approval expressed "just do it", which is
 * now what a checkbox means.
 */
export function normalizePermission(raw) {
	if (typeof raw === "string") {
		const preset = PERMISSION_PRESETS.find((p) => p.id === raw);
		if (preset) return { ...preset.profile };
		// Unknown string → default tier (read-only), not a new capability.
		return { ...DEFAULT_PROFILE };
	}
	if (raw && typeof raw === "object") {
		// Legacy "allow": the auto-accept dial is gone, so that intent migrates to
		// the checkboxes themselves — grant read/write/exec (the old "allow" tier's
		// reach), with ask as the strategy for anything unchecked.
		const legacyAllow = raw.approval === "allow";
		const read = raw.read !== undefined ? !!raw.read : (legacyAllow ? true : DEFAULT_PROFILE.read);
		const write = raw.write !== undefined ? !!raw.write : (legacyAllow ? true : DEFAULT_PROFILE.write);
		// Legacy network:true meant "the process may egress" — under the
		// three-capability model exec is the carrier of that intent (a checked
		// exec escalates the sandbox to danger-full-access). Old profiles always
		// stored all four booleans, so "network checked but exec unchecked" is a
		// legacy artifact, not a live choice: promote exec rather than lose the
		// egress the user had configured.
		const exec = legacyAllow ? true : (raw.network === true ? true : (raw.exec !== undefined ? !!raw.exec : DEFAULT_PROFILE.exec));
		return {
			read, write, exec,
			approval: APPROVAL_MODES.includes(raw.approval) ? raw.approval : DEFAULT_PROFILE.approval
		};
	}
	return { ...DEFAULT_PROFILE };
}

/** Derive the closest coarse CLI sandbox tier from a profile. */
export function deriveSandboxMode(profile) {
	const p = normalizePermission(profile);
	// exec escalates to danger-full-access: allowing command execution means
	// allowing ordinary commands that reach the network (npm install, git
	// pull); Codex cannot run those under workspace-write. write alone stays at
	// workspace-write; nothing checked stays read-only.
	if (p.exec) return "danger-full-access";
	if (p.write) return "workspace-write";
	return "read-only";
}

/** Which capability key gates a Codex permission request capability. */
export function capabilityKey(capability) {
	switch (capability) {
		case "command": return "exec";
		case "file-change": return "write";
		// Codex's escalation request ("permissions") used to map to the removed
		// network flag. Under the three-capability model it is an exec-level
		// escalation: a checked exec already implies egress, so route it there.
		case "permissions": return "exec";
		default: return null;
	}
}

/** Whether a profile allows the given Codex permission capability. */
export function allowsCapability(profile, capability) {
	const p = normalizePermission(profile);
	const key = capabilityKey(capability);
	if (key === null) return true; // unknown capability → do not hard-block
	return p[key] === true;
}

// ── Pre-flight / in-flight gate (A / B) ───────────────────────────────────────
// 授权纪律（2026-09-02）：权限不足时只有两种合法动作——
//   profile.approval === "ask"   → 向 human 发一次性申请（弹窗），同意才放行；
//   profile.approval === "never" → 不申请，直接报告「做不了」。
// 没有第三种：不提供任何开关，AI 与用户都不绕过这一步。

/**
 * Which capabilities a prompt is likely to need. Conservative by design: an
 * uncertain prompt is treated as needing write, because a pre-flight question
 * costs one popup while a missed write costs an unreviewed side effect.
 * @returns {{ write: boolean, exec: boolean }}
 */
export function requiredCapabilities(prompt) {
	const text = String(prompt ?? "");
	const write = /(写入|写文件|写出|保存(到|为|文件)|创建(文件|目录|文件夹)|新建(文件|目录|文件夹)|修改(文件|代码)|改动|编辑|删除(文件|目录)|覆盖|重命名|补丁|patch|write|create|overwrite|delete|remove|rename|refactor|重构)/i.test(text);
	const exec = /(执行(命令|脚本)?|运行(命令|脚本|测试)?|跑一下|跑(测试|命令|脚本)|安装|启动|构建|编译|部署|git\s|npm\s|pnpm\s|npx\s|node\s|bash|shell|powershell|pytest|make\s|run\s|exec|install|build|test)/i.test(text);
	return { write, exec };
}

/** Capabilities a prompt needs that the current profile does not grant. */
export function missingCapabilities(profile, prompt) {
	const p = normalizePermission(profile);
	const need = requiredCapabilities(prompt);
	const missing = [];
	if (need.write && !p.write) missing.push("write");
	if (need.exec && !p.exec) missing.push("exec");
	return missing;
}

/** The widened profile that would satisfy the missing capabilities. */
export function profileWith(profile, capabilities) {
	const p = normalizePermission(profile);
	let out = p;
	for (const c of capabilities ?? []) {
		if (c === "write") out = { ...out, write: true };
		else if (c === "exec") out = { ...out, exec: true };
	}
	return out;
}

/**
 * Diagnose a turn that failed because a capability was unavailable. Covers the
 * plugin's own driver rejections (Chinese + English) and the CLIs' own refusals
 * (Codex审批拒绝、Claude/Qwen 在其自身档位下不注册写工具/拒绝执行)。
 * @returns {boolean}
 */
export function isPermissionBlocked(error) {
	const text = error instanceof Error ? `${error.message}\n${error.cause ?? ""}` : String(error ?? "");
	if (isPermissionRejectionText(text)) return true;
	// CLI 自身执法：只读档下根本没有写工具 / 拒绝执行。
	return /审批系统拒绝|审批拒绝|approval request failed|Rejected by user|permission(?: request)?(?: was)? (?:denied|rejected)|not available in (?:plan|read-only) mode|tool not (?:available|registered)|requires approval|cannot write|read-only/i.test(text);
}

function isPermissionRejectionText(text) {
	return /rejected by user|approval prompts are disabled|approval.*(?:rejected|unavailable)|sandbox_permissions.*(?:denied|rejected)|permission(?: request)?(?: was)? (?:denied|rejected)|被用户拒绝|操作被拒绝|无法完成|写入操作均被/i.test(text);
}

function freeze(value) { return Object.freeze(value); }

export function normalizeCodexPermissionRequest(method, params = {}, context = {}) {
	const capability = CODEX_APPROVAL_METHODS[method];
	if (!capability) return null;
	const remoteRequestId = context.remoteRequestId ?? params.approvalId ?? params.itemId;
	return freeze({
		requestId: context.requestId ?? `cli-permission-${randomUUID()}`,
		remoteRequestId: remoteRequestId == null ? "" : String(remoteRequestId),
		childId: context.childId ?? null,
		cli: "codex",
		pluginSessionId: context.pluginSessionId ?? null,
		remoteSessionId: params.threadId ?? context.remoteSessionId ?? null,
		turnId: params.turnId ?? null,
		itemId: params.itemId ?? null,
		capability,
		operation: method,
		target: params.cwd ?? params.grantRoot ?? params.command ?? null,
		reason: params.reason ?? null,
		requestedScope: capability === "permissions" ? params.permissions ?? null : null,
		supportedDecisions: capability === "permissions"
			? ["allowed-once", "rejected"]
			: ["allowed-once", "rejected", "cancelled"],
		createdAt: new Date().toISOString(),
		raw: freeze({ ...params })
	});
}

export function codexApprovalResponse(request, outcome) {
	if (!request || request.cli !== "codex") throw new TypeError("Codex permission request is required");
	if (!MANAGED_PERMISSION_DECISIONS.includes(outcome)) throw new TypeError(`Unsupported permission outcome ${outcome}`);
	if (outcome === "unavailable") outcome = "rejected";
	if (request.capability === "permissions") {
		return outcome === "allowed-once"
			? { permissions: request.requestedScope ?? {}, scope: "turn" }
			: { permissions: {}, scope: "turn" };
	}
	return { decision: outcome === "allowed-once" ? "accept" : outcome === "cancelled" ? "cancel" : "decline" };
}

/**
 * Human behavior verb for an approval request (DESIGN-approval-copy.md §4:
 * 文案写「要做什么」，不写「要什么权限」；capability 机器词不进正文）。
 * Operation names refine the generic capability verb where possible.
 */
function behaviorOf(request) {
	const op = String(request.operation || "");
	if (/delete/i.test(op)) return "删除文件";
	if (/write/i.test(op)) return "写入文件";
	if (/edit/i.test(op)) return "修改文件";
	if (request.capability === "file-change") return "修改文件";
	if (request.capability === "command") return "执行命令";
	if (request.capability === "exec") return "访问网络资源";
	if (request.capability === "permissions") return "扩大本次会话的权限范围";
	return `执行 ${request.capability || "未分类"} 操作`;
}

export function permissionReason(request) {
	const cliName = request.cli === "codex" ? "Codex" : request.cli === "claude" ? "Claude Code" : "Qwen Code";
	const actor = request.childId ? `${cliName} 子代理 ${request.childId}` : `${cliName} CLI`;
	const target = request.target ? `：${request.target}` : "";
	const reason = request.reason ? `（${request.reason}）` : "";
	// 四要素：谁(actor) · 做什么(behavior+target，行为语言) · 多久(仅本次放行) · 拒绝会怎样。
	const gate = request.gated === true
		? `是为放行${request.operation || "所需能力"}而发起的一次申请：仅本次一轮放行；拒绝则本轮任务报“无法完成”并停止，不会换方式继续，也不会申请第二次。`
		: `仅本次放行；拒绝则该操作被跳过，${cliName} 会收到拒绝结果并换方式继续或结束本轮。`;
	return `${actor} 想${behaviorOf(request)}${target}${reason}。${gate}`;
}

// ── Unified permission request normalizer for all three CLIs ─────────────────
// Transforms each CLI's native event into the canonical form that
// resolvePermission() in managed-cli-agents.js consumes.

/** Map a tool name to the normalized permission capability key. */
function toolCapability(toolName) {
	if (!toolName || typeof toolName !== "string") return null;
	if (toolName === "Bash" || toolName === "NpmcliLifecyclePlugin") return "command";
	if (toolName === "Write" || toolName === "MultiWrite" || toolName === "Edit" || toolName === "Delete") return "file-change";
	if (toolName === "WebSearch" || toolName === "WebFetcher") return "exec";
	return null; // read tool — not an approval-worthy capability
}

/**
 * Normalize a permission request from any managed CLI into the canonical form:
 * { requestId, remoteRequestId, childId, cli, pluginSessionId, remoteSessionId,
 *   turnId, itemId, capability, operation, target, reason, requestedScope,
 *   supportedDecisions, createdAt, raw }
 *
 * @param {"codex"|"claude"|"qwen"} cli
 * @param {string} method  — protocol method (Codex) or tool name (Claude/Qwen)
 * @param {object} params  — protocol params or { toolName, toolInput, ... }
 * @param {object} context — { requestId, childId, pluginSessionId, remoteSessionId, turnId, signal }
 */
export function normalizePermissionRequest(cli, method, params = {}, context = {}) {
	if (!cli || !method) return null;

	if (cli === "codex") {
		// Delegate to existing Codex normalizer for protocol-level method mapping.
		return normalizeCodexPermissionRequest(method, params, context);
	}

	// Claude Code / Qwen Code: method is the tool name; map to capability.
	const capability = toolCapability(method);
	if (!capability) return null; // read tool or unknown

	const cliName = cli === "claude" ? "Claude Code" : "Qwen Code";
	const remoteRequestId = context.remoteRequestId ?? params.approvalId ?? params.itemId ?? null;

	// Build a human-readable operation label.
	const toolName = method;
	const toolInput = params?.toolInput;
	let operation = `${cliName}:${toolName}`;
	if (toolInput) {
		if (toolInput.file_path || toolInput.path) operation += ` ${toolInput.file_path || toolInput.path}`;
		else if (toolInput.command) operation += ` → ${String(toolInput.command).slice(0, 60)}`;
		else if (toolInput.url) operation += ` → ${toolInput.url}`;
	}

	// Determine the target for display.
	let target = null;
	if (toolInput) {
		target = toolInput.file_path || toolInput.path || toolInput.command || toolInput.url || null;
	}

	return Object.freeze({
		requestId: context.requestId ?? `cli-permission-${randomUUID()}`,
		remoteRequestId: remoteRequestId == null ? "" : String(remoteRequestId),
		childId: context.childId ?? null,
		cli,
		pluginSessionId: context.pluginSessionId ?? null,
		remoteSessionId: context.remoteSessionId ?? params.threadId ?? null,
		turnId: context.turnId ?? null,
		itemId: params.itemId ?? null,
		capability,         // "command" | "file-change" | "exec"
		operation,
		target,
		reason: params.reason ?? null,
		requestedScope: null,
		supportedDecisions: ["allowed-once", "rejected", "cancelled"],
		createdAt: new Date().toISOString(),
		raw: Object.freeze({ ...params })
	});
}
