import { randomUUID } from "node:crypto";

export const CODEX_APPROVAL_METHODS = Object.freeze({
	"item/commandExecution/requestApproval": "command",
	"item/fileChange/requestApproval": "file-change",
	"item/permissions/requestApproval": "permissions"
});

export const MANAGED_PERMISSION_DECISIONS = Object.freeze(["allowed-once", "rejected", "cancelled", "unavailable"]);

// ── Fine-grained permission profiles ─────────────────────────────────────────
// Each CLI's permission is stored as a capability object:
//   { read, write, exec, network, approval }
// Legacy string tiers are accepted everywhere and normalized to a profile.

// The checkbox is the only grant: checked = allowed silently at runtime.
// `approval` is no longer an "auto-allow" dial — it is the strategy for what
// happens when an UNCHECKED capability is requested: ask interactively, or
// auto-reject. "allow" is accepted on read (stored profiles) and migrated:
// an "allow" approval meant the user wanted that capability to just work, so it
// becomes a checkbox.

export const APPROVAL_MODES = Object.freeze(["ask", "never"]);

export const PERMISSION_PRESETS = Object.freeze([
	// Default: only read is granted; write/exec/network come up at runtime and
	// are handled by the approval strategy (ask by default).
	{ id: "read-only", label: "只读", profile: Object.freeze({ read: true, write: false, exec: false, network: false, approval: "ask" }) },
	{ id: "workspace-write", label: "工作区可写", profile: Object.freeze({ read: true, write: true, exec: true, network: false, approval: "ask" }) },
	{ id: "danger-full-access", label: "完全", profile: Object.freeze({ read: true, write: true, exec: true, network: true, approval: "ask" }) }
]);

export const DEFAULT_PROFILE = Object.freeze({ read: true, write: false, exec: false, network: false, approval: "ask" });

/**
 * Normalize a stored permission value (legacy string tier, partial object, or
 * full profile) into a complete profile under the checkbox-only model. Legacy
 * `approval: "allow"` migrates to checked capabilities + ask: an auto-allow
 * approval expressed "just do it", which is now what a checkbox means.
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
		// reach) and keep network explicit, with ask as the strategy for the rest.
		const legacyAllow = raw.approval === "allow";
		const read = raw.read !== undefined ? !!raw.read : (legacyAllow ? true : DEFAULT_PROFILE.read);
		const write = raw.write !== undefined ? !!raw.write : (legacyAllow ? true : DEFAULT_PROFILE.write);
		const exec = raw.exec !== undefined ? !!raw.exec : (legacyAllow ? true : DEFAULT_PROFILE.exec);
		const network = raw.network !== undefined ? !!raw.network : (legacyAllow ? true : DEFAULT_PROFILE.network);
		return {
			read, write, exec, network,
			approval: APPROVAL_MODES.includes(raw.approval) ? raw.approval : DEFAULT_PROFILE.approval
		};
	}
	return { ...DEFAULT_PROFILE };
}

/** Derive the closest coarse CLI sandbox tier from a profile. */
export function deriveSandboxMode(profile) {
	const p = normalizePermission(profile);
	// Codex only opens the network under danger-full-access, so a profile that
	// enables network must escalate to it (write stays gated by the approval
	// bridge and the argv mapping, not by the coarse sandbox tier).
	if (p.network) return "danger-full-access";
	if (p.write || p.exec) return "workspace-write";
	return "read-only";
}

/** Which capability key gates a Codex permission request capability. */
export function capabilityKey(capability) {
	switch (capability) {
		case "command": return "exec";
		case "file-change": return "write";
		case "permissions": return "network";
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

export function permissionReason(request) {
	const actor = request.childId ? `Codex 子代理 ${request.childId}` : "Codex CLI";
	const target = request.target ? `，目标：${request.target}` : "";
	const reason = request.reason ? `，原因：${request.reason}` : "";
	return `${actor} 请求 ${request.capability} 权限${target}${reason}。本次仅放行当前请求；拒绝后原 Codex turn 将收到拒绝结果并继续或结算。`;
}
