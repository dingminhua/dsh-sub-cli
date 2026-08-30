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

// ── Generalized matrices (shared derivation rules) ───────────────────────────
// The coarse-tier rule is defined ONCE here and asserted for every capability
// combination, so a regression like the network→workspace-write bug fails
// loudly for all CLIs instead of silently only affecting one of them.

// The documented derivation rule. Keeping the expected value next to the
// implementation makes the intent explicit and the matrix self-checking.
function expectedTier({ write, exec, network }) {
	if (network) return "danger-full-access";
	if (write || exec) return "workspace-write";
	return "read-only";
}

// Every combination of the four capability booleans (2^4 = 16), plus a sweep
// over the approval mode to prove it never influences the sandbox tier.
const CAPABILITY_COMBOS = (() => {
	const combos = [];
	for (const read of [true, false]) {
		for (const write of [true, false]) {
			for (const exec of [true, false]) {
				for (const network of [true, false]) {
					for (const approval of APPROVAL_MODES) combos.push({ read, write, exec, network, approval });
				}
			}
		}
	}
	return combos;
})();

test("deriveSandboxMode matches the documented rule for all 16 capability combinations", () => {
	assert.equal(CAPABILITY_COMBOS.length, 16 * APPROVAL_MODES.length);
	for (const combo of CAPABILITY_COMBOS) {
		const { read, write, exec, network, approval } = combo;
		const tier = expectedTier(combo);
		assert.equal(deriveSandboxMode(combo), tier, `profile ${JSON.stringify(combo)}`);
		// The approval mode must never change the coarse tier.
		if (approval === "allow") assert.equal(deriveSandboxMode({ read, write, exec, network, approval: "ask" }), tier, `approval independence ${JSON.stringify(combo)}`);
	}
});

test("normalizePermission round-trips every capability combination exactly", () => {
	for (const combo of CAPABILITY_COMBOS) {
		const { read, write, exec, network, approval } = combo;
		assert.deepEqual(normalizePermission({ read, write, exec, network, approval }), { read, write, exec, network, approval }, `round-trip ${JSON.stringify(combo)}`);
	}
});

test("normalizePermission coerces partial and malformed inputs to a complete profile", () => {
	const cases = [
		[{}, { ...DEFAULT_PROFILE }],
		[{ read: false }, { ...DEFAULT_PROFILE, read: false }],
		[{ write: true }, { ...DEFAULT_PROFILE, write: true }],
		[{ exec: true, network: true }, { ...DEFAULT_PROFILE, exec: true, network: true }],
		[{ read: 0 }, { ...DEFAULT_PROFILE, read: false }],
		[{ write: "yes" }, { ...DEFAULT_PROFILE, write: true }],
		[{ approval: "always" }, { ...DEFAULT_PROFILE }],
		[{ approval: 42 }, { ...DEFAULT_PROFILE }],
		["", { ...DEFAULT_PROFILE }],
		[" ", { ...DEFAULT_PROFILE }],
		[42, { ...DEFAULT_PROFILE }],
		[true, { ...DEFAULT_PROFILE }]
	];
	for (const [input, expected] of cases) assert.deepEqual(normalizePermission(input), expected, `input ${JSON.stringify(input)}`);
});

test("capability gate agrees with the derived tier for every combination", () => {
	// Whatever the coarse tier says, the capability gate must be consistent:
	// network on ⇒ permissions allowed; exec on ⇒ command allowed; write on ⇒ file-change allowed.
	for (const combo of CAPABILITY_COMBOS) {
		const p = normalizePermission(combo);
		assert.equal(allowsCapability(p, "command"), p.exec === true, `command gate ${JSON.stringify(combo)}`);
		assert.equal(allowsCapability(p, "file-change"), p.write === true, `file-change gate ${JSON.stringify(combo)}`);
		assert.equal(allowsCapability(p, "permissions"), p.network === true, `permissions gate ${JSON.stringify(combo)}`);
	}
});
