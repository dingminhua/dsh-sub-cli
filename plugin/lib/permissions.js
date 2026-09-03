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
// Authorization model (two tiers, 2026-09 simplification): the middle
// "workspace-write" tier was REMOVED — it was the murkiest of the three
// (Codex cannot write files without exec anyway since its write path is
// exec_command; Claude's acceptEdits silently auto-accepts file commands
// including deletion, wider than "just writes" — round-12 finding 6). What
// remains is honest and simple:
//   read-only  → look, never modify;
//   executable → run commands, write/delete files, install deps.
// The checkboxes are still the only grant and are fixed at launch — checked
// capabilities are allowed silently, unchecked ones are answered
// deterministically. No interactive ask, no runtime escalation.

export const PERMISSION_PRESETS = Object.freeze([
	{ id: "read-only", label: "只读", profile: Object.freeze({ read: true, write: false, exec: false }) },
	// id stays "danger-full-access" (matches the CLI sandbox name and keeps
	// stored-string compatibility); the label is the user-facing 可执行.
	{ id: "danger-full-access", label: "可执行", profile: Object.freeze({ read: true, write: true, exec: true }) }
]);

export const DEFAULT_PROFILE = Object.freeze({ read: true, write: false, exec: false });

/**
 * Normalize a stored permission value (legacy string tier, partial object, or
 * full profile) into a complete three-capability profile. Stored `network`
 * values are dropped: exec carries that intent. Stored `approval` values
 * ("ask"/"never", removed 2026-09) are dropped silently. Legacy mappings:
 * `approval:"allow"` and the removed `workspace-write` tier (and any profile
 * with write or exec checked) normalize to the executable tier — widening,
 * never silently tightening what the user had configured.
 */
export function normalizePermission(raw) {
	if (typeof raw === "string") {
		if (raw === "read-only") return { read: true, write: false, exec: false };
		// The removed mutation tiers (workspace-write / danger-full-access)
		// normalize to executable — widening, never silently tightening.
		if (raw === "workspace-write" || raw === "danger-full-access") return { read: true, write: true, exec: true };
		// Unknown strings keep the read-only default.
		return { read: true, write: false, exec: false };
	}
	if (raw && typeof raw === "object") {
		const legacyAllow = raw.approval === "allow";
		const read = raw.read !== undefined ? !!raw.read : true;
		// Any mutation capability the user had (write, exec, legacy network,
		// legacy allow) grants the executable tier.
		const mutating = legacyAllow || raw.network === true || raw.write === true || raw.exec === true;
		if (mutating) return { read, write: true, exec: true };
		return { read, write: false, exec: false };
	}
	return { ...DEFAULT_PROFILE };
}

/** Derive the CLI sandbox tier from a profile: read-only or executable. */
export function deriveSandboxMode(profile) {
	const p = normalizePermission(profile);
	// Any mutation capability → the executable tier (CLI sandbox:
	// danger-full-access / bypassPermissions). Exec implies write: commands
	// can create files, so there is no "exec but not write" tier.
	if (p.exec || p.write) return "danger-full-access";
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
 * @param {"codex"|"claude"} cli
 * @param {string} method  — protocol method (Codex) or tool name (Claude)
 * @param {object} params  — protocol params or { toolName, toolInput, ... }
 * @param {object} context — { requestId, childId, pluginSessionId, remoteSessionId, turnId, signal }
 */
export function normalizePermissionRequest(cli, method, params = {}, context = {}) {
	if (!cli || !method) return null;

	if (cli === "codex") {
		// Delegate to existing Codex normalizer for protocol-level method mapping.
		return normalizeCodexPermissionRequest(method, params, context);
	}

	// Claude Code: method is the tool name; map to capability.
	const capability = toolCapability(method);
	if (!capability) return null; // read tool or unknown

	const cliName = "Claude Code";
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
