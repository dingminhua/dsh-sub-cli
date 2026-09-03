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
// Glob, Grep, etc.) are always allowed silently.
// Note: WebSearch/WebFetcher stay mapped even though the managed CLIs
// deliberately ship WITHOUT web search (2026-09 decision) — the map is a
// permission classification, not a feature grant. If one of these tools is
// ever triggered (user-configured CLI, protocol drift), the exec capability
// still decides; unmapping would silently allow an unknown tool instead.
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
//   { read, write, exec }
// Three capabilities only — the network flag is gone. Granting "exec" already
// means the CLI process may reach the network: npm install / git pull are
// ordinary parts of command execution, and a sandbox that allows commands but
// blocks the network cannot run them. Users who want no egress simply leave
// exec unchecked; Codex then lands in read-only.
// Legacy string tiers are accepted everywhere and normalized to a profile.
//
// Authorization model (approval mode removed 2026-09): the checkboxes are the
// only grant and are fixed at launch — checked capabilities are allowed
// silently, unchecked ones are answered deterministically (the CLI receives a
// rejection and adapts or reports the task as not completable). There is no
// interactive ask, no runtime escalation, and no retry-with-widening; a task
// that cannot proceed under the configured tier stops with a clear message
// pointing at the settings card.

export const PERMISSION_PRESETS = Object.freeze([
	// Default: only read is granted; write/exec are NOT granted and the CLI is
	// launched with a fixed, narrow sandbox tier. No popup, no runtime
	// escalation — the tier is decided at launch and cannot widen mid-turn.
	{ id: "read-only", label: "只读", profile: Object.freeze({ read: true, write: false, exec: false }) },
	{ id: "workspace-write", label: "工作区可写", profile: Object.freeze({ read: true, write: true, exec: false }) },
	{ id: "danger-full-access", label: "完全", profile: Object.freeze({ read: true, write: true, exec: true }) }
]);

export const DEFAULT_PROFILE = Object.freeze({ read: true, write: false, exec: false });

/**
 * Normalize a stored permission value (legacy string tier, partial object, or
 * full profile) into a complete three-capability profile. Stored `network`
 * values are dropped: exec now carries that intent (checked exec implies the
 * process may egress). Stored `approval` values ("ask"/"never", removed
 * 2026-09) are dropped silently: the strategy is always the deterministic
 * one. Legacy `approval: "allow"` migrates to checked capabilities.
 */
export function normalizePermission(raw) {
	if (typeof raw === "string") {
		const preset = PERMISSION_PRESETS.find((p) => p.id === raw);
		if (preset) return { ...preset.profile };
		// Unknown string → default tier (read-only), not a new capability.
		return { ...DEFAULT_PROFILE };
	}
	if (raw && typeof raw === "object") {
		// Legacy "allow": the auto-accept dial is gone, so that intent migrates
		// to the checkboxes themselves — grant read/write/exec (the old "allow"
		// tier's reach).
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
		return { read, write, exec };
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
