import assert from "node:assert/strict";
import test from "node:test";
import { codexApprovalResponse, normalizeCodexPermissionRequest } from "../lib/permissions.js";
import { normalizePermission, deriveSandboxMode, allowsCapability, capabilityKey, PERMISSION_PRESETS, DEFAULT_PROFILE } from "../lib/permissions.js";

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

// ── Three-capability permission model (read / write / exec) ───────────────────
// ── Two-tier permission model (read-only / executable), 2026-09 ───────────────
// The middle "workspace-write" tier was removed: it was the murkiest of the
// three (Codex cannot write without exec; Claude's acceptEdits silently
// auto-accepts file commands incl. deletion — round-12 finding 6). Any stored
// mutation capability (write/exec/network/legacy allow) normalizes to the
// executable tier — widening, never silently tightening.

test("presets are exactly read-only and executable", () => {
	assert.deepEqual(PERMISSION_PRESETS.map((p) => p.id), ["read-only", "danger-full-access"]);
	const [readOnly, executable] = PERMISSION_PRESETS;
	assert.deepEqual(readOnly.profile, { read: true, write: false, exec: false });
	assert.deepEqual(executable.profile, { read: true, write: true, exec: true });
});

test("normalizePermission maps legacy strings to the two tiers", () => {
	assert.deepEqual(normalizePermission("read-only"), { read: true, write: false, exec: false });
	// The removed mutation tiers normalize to executable (widening).
	assert.deepEqual(normalizePermission("workspace-write"), { read: true, write: true, exec: true });
	assert.deepEqual(normalizePermission("danger-full-access"), { read: true, write: true, exec: true });
	// Unknown strings keep the read-only default.
	assert.deepEqual(normalizePermission("bogus"), { read: true, write: false, exec: false });
	assert.deepEqual(normalizePermission(undefined), { read: true, write: false, exec: false });
	assert.deepEqual(normalizePermission(null), { read: true, write: false, exec: false });
});

test("any mutation capability in a profile normalizes to the executable tier", () => {
	for (const p of [
		{ write: true }, { exec: true }, { network: true },
		{ read: true, write: true, exec: false }, { read: true, write: false, exec: true },
		{ approval: "allow" }
	]) {
		assert.deepEqual(normalizePermission(p), { read: true, write: true, exec: true }, `profile ${JSON.stringify(p)} → executable`);
	}
	// Pure-read and no-signal profiles stay read-only; stored approval keys
	// (removed 2026-09) are dropped without effect.
	assert.deepEqual(normalizePermission({ read: true }), { read: true, write: false, exec: false });
	assert.deepEqual(normalizePermission({ read: true, approval: "ask" }), { read: true, write: false, exec: false });
	assert.deepEqual(normalizePermission({ read: false }), { read: false, write: false, exec: false });
});

test("deriveSandboxMode collapses everything to read-only or executable", () => {
	assert.equal(deriveSandboxMode("read-only"), "read-only");
	assert.equal(deriveSandboxMode("workspace-write"), "danger-full-access");
	assert.equal(deriveSandboxMode("danger-full-access"), "danger-full-access");
	assert.equal(deriveSandboxMode({ read: true }), "read-only");
	assert.equal(deriveSandboxMode({ read: true, write: true, exec: false }), "danger-full-access");
	assert.equal(deriveSandboxMode({ read: true, write: false, exec: true }), "danger-full-access");
	// Stored approval keys must never influence the tier.
	assert.equal(deriveSandboxMode({ read: true, write: true, exec: true, approval: "ask" }), "danger-full-access");
});

test("capability gate maps Codex capabilities to profile keys", () => {
	assert.equal(capabilityKey("command"), "exec");
	assert.equal(capabilityKey("file-change"), "write");
	assert.equal(capabilityKey("permissions"), "exec");
	assert.equal(capabilityKey("unknown-thing"), null);
	assert.equal(allowsCapability({ read: true, write: true, exec: true }, "command"), true);
	assert.equal(allowsCapability({ read: true, write: false, exec: false }, "command"), false);
	assert.equal(allowsCapability({ read: true, write: false, exec: false }, "permissions"), false);
	assert.equal(allowsCapability({ read: true, write: false, exec: false }, "mystery"), true);
});

// ── Generalized matrix: every combination collapses to one of the two tiers ──

const CAPABILITY_COMBOS = (() => {
	const combos = [];
	for (const read of [true, false]) {
		for (const write of [true, false]) {
			for (const exec of [true, false]) {
				combos.push({ read, write, exec });
				for (const network of [true, false]) combos.push({ read, write, exec, network });
				for (const approval of ["ask", "never"]) combos.push({ read, write, exec, approval });
			}
		}
	}
	return combos;
})();

test("deriveSandboxMode returns exactly two possible tiers for every combination", () => {
	for (const combo of CAPABILITY_COMBOS) {
		const tier = deriveSandboxMode(combo);
		assert.ok(tier === "read-only" || tier === "danger-full-access", `tier ${tier} for ${JSON.stringify(combo)}`);
		// Any mutation signal (write/exec/network) selects executable.
		const mutating = combo.write === true || combo.exec === true || combo.network === true;
		assert.equal(tier, mutating ? "danger-full-access" : "read-only", `profile ${JSON.stringify(combo)}`);
	}
});

test("normalizePermission round-trips every combination into one of the two profiles", () => {
	for (const combo of CAPABILITY_COMBOS) {
		const normalized = normalizePermission(combo);
		const mutating = combo.write === true || combo.exec === true || combo.network === true || combo.approval === "allow";
		const expected = mutating
			? { read: combo.read !== false, write: true, exec: true }
			: { read: combo.read !== false, write: false, exec: false };
		assert.deepEqual(normalized, expected, `round-trip ${JSON.stringify(combo)}`);
	}
});

test("capability gate agrees with the normalized profile for every combination", () => {
	for (const combo of CAPABILITY_COMBOS) {
		const p = normalizePermission(combo);
		assert.equal(allowsCapability(p, "command"), p.exec === true, `command gate ${JSON.stringify(combo)}`);
		assert.equal(allowsCapability(p, "file-change"), p.write === true, `file-change gate ${JSON.stringify(combo)}`);
		assert.equal(allowsCapability(p, "permissions"), p.exec === true, `permissions gate ${JSON.stringify(combo)}`);
	}
});

// ── Unified permission request normalizer for all three CLIs ─────────────────

import { normalizePermissionRequest, CLAUDE_APPROVAL_METHODS } from "../lib/permissions.js";

test("normalizePermissionRequest maps Claude Code tool names to the canonical capability keys", () => {
	// Each tool name maps to one of: command, file-change, exec, or null (read-only).
	assert.equal(CLAUDE_APPROVAL_METHODS.Bash, "command");
	assert.equal(CLAUDE_APPROVAL_METHODS.Write, "file-change");
	assert.equal(CLAUDE_APPROVAL_METHODS.MultiWrite, "file-change");
	assert.equal(CLAUDE_APPROVAL_METHODS.Edit, "file-change");
	assert.equal(CLAUDE_APPROVAL_METHODS.Delete, "file-change");
	assert.equal(CLAUDE_APPROVAL_METHODS.WebSearch, "exec");
	// Read tools are not enumerated — they pass through silently.
});

test("normalizePermissionRequest returns a canonical request for a Claude Write tool_use", () => {
	const request = normalizePermissionRequest("claude", "Write", {
		toolInput: { file_path: "/Users/dmh2002/DshProject/dsh-brain-compaction/test.md" },
		approvalId: "toolu_abc"
	}, {
		childId: "child-1",
		pluginSessionId: "session-1",
		remoteSessionId: "thread-1",
		turnId: "turn-1"
	});
	assert.ok(request, "request should be returned for write tools");
	assert.equal(request.cli, "claude");
	assert.equal(request.capability, "file-change");
	assert.equal(request.target, "/Users/dmh2002/DshProject/dsh-brain-compaction/test.md");
	assert.equal(request.operation, "Claude Code:Write /Users/dmh2002/DshProject/dsh-brain-compaction/test.md");
	assert.equal(request.remoteRequestId, "toolu_abc");
	assert.equal(request.childId, "child-1");
	assert.equal(request.pluginSessionId, "session-1");
	assert.match(request.requestId, /^cli-permission-/);
});

test("normalizePermissionRequest returns a canonical request for a Claude Bash tool_use", () => {
	const request = normalizePermissionRequest("claude", "Bash", {
		toolInput: { command: "rm -rf build" }
	}, { pluginSessionId: "session-1" });
	assert.equal(request.cli, "claude");
	assert.equal(request.capability, "command");
	assert.equal(request.target, "rm -rf build");
	assert.match(request.operation, /Claude Code:Bash/);
});

test("normalizePermissionRequest returns null for read-only tools (Read, Glob, Grep, etc.)", () => {
	assert.equal(normalizePermissionRequest("claude", "Read", { toolInput: { file_path: "/x" } }), null);
	assert.equal(normalizePermissionRequest("claude", "Glob", { toolInput: { pattern: "*.ts" } }), null);
	assert.equal(normalizePermissionRequest("claude", "Grep", { toolInput: { pattern: "x" } }), null);
	assert.equal(normalizePermissionRequest("claude", undefined, {}), null);
	assert.equal(normalizePermissionRequest("claude", null, {}), null);
});

test("normalizePermissionRequest routes Codex calls through the existing normalizer", () => {
	// Codex path keeps its protocol-specific shape: method is the protocol name.
	const request = normalizePermissionRequest("codex", "item/commandExecution/requestApproval", {
		threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "npm install"
	}, { pluginSessionId: "session-1" });
	assert.equal(request.cli, "codex");
	assert.equal(request.capability, "command");
	assert.equal(request.target, "npm install");
	assert.equal(request.remoteSessionId, "thread-1");
});