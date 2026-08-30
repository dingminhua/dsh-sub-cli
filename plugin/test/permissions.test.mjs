import assert from "node:assert/strict";
import test from "node:test";
import { codexApprovalResponse, normalizeCodexPermissionRequest, permissionReason } from "../lib/permissions.js";
import { normalizePermission, deriveSandboxMode, allowsCapability, capabilityKey, APPROVAL_MODES, PERMISSION_PRESETS, DEFAULT_PROFILE } from "../lib/permissions.js";

test("normalizes Codex structured permission requests with routing identity", () => {
	const request = normalizeCodexPermissionRequest("item/permissions/requestApproval", {
		threadId: "thread-1", turnId: "turn-1", itemId: "item-1", cwd: "/repo",
		reason: "network needed", permissions: { network: { enabled: true } }
	}, { requestId: "request-1", childId: "child-1", pluginSessionId: "session-1" });
	assert.equal(request.requestId, "request-1");
	assert.equal(request.childId, "child-1");
	assert.equal(request.pluginSessionId, "session-1");
	assert.equal(request.remoteSessionId, "thread-1");
	assert.equal(request.turnId, "turn-1");
	assert.equal(request.capability, "permissions");
	assert.deepEqual(request.requestedScope, { network: { enabled: true } });
	assert.match(permissionReason(request), /仅放行当前请求/);
});

test("normalizes command and file-change targets without exposing secrets", () => {
	const command = normalizeCodexPermissionRequest("item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn", itemId: "item", command: "npm install", reason: "dependency" });
	assert.equal(command.capability, "command");
	assert.equal(command.target, "npm install");
	const file = normalizeCodexPermissionRequest("item/fileChange/requestApproval", { threadId: "thread", turnId: "turn", itemId: "item-file", grantRoot: "/outside", reason: "write" });
	assert.equal(file.capability, "file-change");
	assert.equal(file.target, "/outside");
	assert.equal("apiKey" in command, false);
});

test("maps DSH one-shot outcomes to Codex permission responses", () => {
	const permissions = normalizeCodexPermissionRequest("item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
	assert.deepEqual(codexApprovalResponse(permissions, "allowed-once"), { permissions: { network: { enabled: true } }, scope: "turn" });
	assert.deepEqual(codexApprovalResponse(permissions, "rejected"), { permissions: {}, scope: "turn" });
	const command = normalizeCodexPermissionRequest("item/commandExecution/requestApproval", { itemId: "item" });
	assert.deepEqual(codexApprovalResponse(command, "allowed-once"), { decision: "accept" });
	assert.deepEqual(codexApprovalResponse(command, "rejected"), { decision: "decline" });
	assert.deepEqual(codexApprovalResponse(command, "cancelled"), { decision: "cancel" });
});

// ── Fine-grained permission profile model ────────────────────────────────────

test("presets cover the three legacy tiers with distinct capability profiles", () => {
	assert.deepEqual(PERMISSION_PRESETS.map((p) => p.id), ["read-only", "workspace-write", "danger-full-access"]);
	assert.deepEqual(APPROVAL_MODES, ["ask", "allow", "never"]);
	const [readOnly, workspaceWrite, full] = PERMISSION_PRESETS;
	assert.deepEqual(readOnly.profile, { read: true, write: false, exec: false, network: false, approval: "ask" });
	assert.deepEqual(workspaceWrite.profile, { read: true, write: true, exec: true, network: false, approval: "ask" });
	assert.deepEqual(full.profile, { read: true, write: true, exec: true, network: true, approval: "allow" });
});

test("normalizePermission maps legacy strings, unknowns, objects and missing values", () => {
	// Legacy string tiers keep their semantics.
	assert.deepEqual(normalizePermission("read-only"), { read: true, write: false, exec: false, network: false, approval: "ask" });
	assert.deepEqual(normalizePermission("workspace-write"), { read: true, write: true, exec: true, network: false, approval: "ask" });
	assert.deepEqual(normalizePermission("danger-full-access"), { read: true, write: true, exec: true, network: true, approval: "allow" });
	// Unknown strings and missing values fall back to the default tier.
	assert.deepEqual(normalizePermission("bogus"), { ...DEFAULT_PROFILE });
	assert.deepEqual(normalizePermission(undefined), { ...DEFAULT_PROFILE });
	assert.deepEqual(normalizePermission(null), { ...DEFAULT_PROFILE });
	// Partial profile objects merge over defaults.
	assert.deepEqual(normalizePermission({ network: true }), { read: true, write: true, exec: true, network: true, approval: "ask" });
	// Invalid approval falls back to the default.
	assert.deepEqual(normalizePermission({ read: true, approval: "always" }).approval, "ask");
});

test("deriveSandboxMode picks the closest coarse tier for headless argv", () => {
	assert.equal(deriveSandboxMode("read-only"), "read-only");
	assert.equal(deriveSandboxMode("workspace-write"), "workspace-write");
	assert.equal(deriveSandboxMode("danger-full-access"), "danger-full-access");
	// A profile that writes or executes grants workspace-write; adding network
	// escalates to full access; read-only profiles stay read-only.
	assert.equal(deriveSandboxMode({ read: true, write: true, exec: true, network: false, approval: "ask" }), "workspace-write");
	assert.equal(deriveSandboxMode({ read: true, write: true, exec: true, network: true, approval: "ask" }), "danger-full-access");
	assert.equal(deriveSandboxMode({ read: true, write: false, exec: false, network: false, approval: "ask" }), "read-only");
	// Network alone (even without write) must escalate to full access: Codex's
	// sandbox only opens the network under danger-full-access.
	assert.equal(deriveSandboxMode({ read: true, write: false, exec: true, network: true, approval: "allow" }), "danger-full-access");
});

test("capability gate maps Codex capabilities to profile keys", () => {
	assert.equal(capabilityKey("command"), "exec");
	assert.equal(capabilityKey("file-change"), "write");
	assert.equal(capabilityKey("permissions"), "network");
	assert.equal(capabilityKey("unknown-thing"), null);
	// The gate enforces each capability independently.
	assert.equal(allowsCapability({ ...DEFAULT_PROFILE, exec: true }, "command"), true);
	assert.equal(allowsCapability({ ...DEFAULT_PROFILE, exec: false }, "command"), false);
	assert.equal(allowsCapability({ ...DEFAULT_PROFILE, network: false }, "permissions"), false);
	// Unknown capabilities are not hard-blocked.
	assert.equal(allowsCapability(DEFAULT_PROFILE, "mystery"), true);
});
