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
// The network flag is gone: exec carries egress intent (npm install / git pull
// are ordinary commands, and Codex cannot run them under workspace-write).
// The approval mode (ask/never) was removed 2026-09: the checkboxes are the
// only grant and are fixed at launch — unchecked capabilities are answered
// deterministically (rejected and recorded), never asked interactively.

test("presets cover the three legacy tiers with distinct capability profiles", () => {
	assert.deepEqual(PERMISSION_PRESETS.map((p) => p.id), ["read-only", "workspace-write", "danger-full-access"]);
	const [readOnly, workspaceWrite, full] = PERMISSION_PRESETS;
	assert.deepEqual(readOnly.profile, { read: true, write: false, exec: false });
	// "workspace-write" no longer implies exec: write-only grants a
	// workspace-writable sandbox without command execution.
	assert.deepEqual(workspaceWrite.profile, { read: true, write: true, exec: false });
	assert.deepEqual(full.profile, { read: true, write: true, exec: true });
});

test("normalizePermission maps legacy strings, unknowns, objects and missing values", () => {
	assert.deepEqual(normalizePermission("read-only"), { read: true, write: false, exec: false });
	assert.deepEqual(normalizePermission("workspace-write"), { read: true, write: true, exec: false });
	assert.deepEqual(normalizePermission("danger-full-access"), { read: true, write: true, exec: true });
	// Unknown strings and missing values fall back to the default tier.
	assert.deepEqual(normalizePermission("bogus"), { ...DEFAULT_PROFILE });
	assert.deepEqual(normalizePermission(undefined), { ...DEFAULT_PROFILE });
	assert.deepEqual(normalizePermission(null), { ...DEFAULT_PROFILE });
	// A stored network key is dropped; its egress intent migrates onto exec.
	assert.deepEqual(normalizePermission({ network: true }), { read: true, write: false, exec: true });
	assert.deepEqual(normalizePermission({ read: true, write: true, exec: true, network: true }), { read: true, write: true, exec: true });
	// Stored approval values (removed 2026-09) are dropped silently.
	assert.deepEqual(normalizePermission({ read: true, approval: "ask" }), { read: true, write: false, exec: false });
	assert.deepEqual(normalizePermission({ read: true, approval: "always" }), { read: true, write: false, exec: false });
});

test("legacy approval:'allow' migrates its intent into the checkboxes", () => {
	// An auto-allow approval used to mean "just do it" — under the checkbox-only
	// model that intent becomes checked capabilities, so old stored profiles do
	// not silently tighten when the setting is next saved.
	assert.deepEqual(
		normalizePermission({ read: true, write: true, exec: true, network: true, approval: "allow" }),
		{ read: true, write: true, exec: true }
	);
	// A legacy allow with only some booleans stored: missing ones default to the
	// old allow-tier's reach (all true).
	assert.deepEqual(
		normalizePermission({ approval: "allow" }),
		{ read: true, write: true, exec: true }
	);
});

test("deriveSandboxMode picks the closest coarse tier for headless argv", () => {
	assert.equal(deriveSandboxMode("read-only"), "read-only");
	assert.equal(deriveSandboxMode("workspace-write"), "workspace-write");
	assert.equal(deriveSandboxMode("danger-full-access"), "danger-full-access");
	// exec escalates to full access: allowing command execution implies the
	// ordinary commands that reach the network (npm install, git pull).
	assert.equal(deriveSandboxMode({ read: true, write: true, exec: true }), "danger-full-access");
	// write alone stays at workspace-write (file edits, no commands).
	assert.equal(deriveSandboxMode({ read: true, write: true, exec: false }), "workspace-write");
	assert.equal(deriveSandboxMode({ read: true, write: false, exec: false }), "read-only");
	// Legacy network:true without a stored exec also escalates (egress intent).
	assert.equal(deriveSandboxMode({ read: true, network: true }), "danger-full-access");
	// Stored approval keys must never influence the tier.
	assert.equal(deriveSandboxMode({ read: true, write: true, exec: true, approval: "ask" }), "danger-full-access");
});

test("capability gate maps Codex capabilities to profile keys", () => {
	assert.equal(capabilityKey("command"), "exec");
	assert.equal(capabilityKey("file-change"), "write");
	// Codex's escalation request routes to exec under the three-capability
	// model: a checked exec already implies egress.
	assert.equal(capabilityKey("permissions"), "exec");
	assert.equal(capabilityKey("unknown-thing"), null);
	// The gate enforces each capability independently.
	assert.equal(allowsCapability({ ...DEFAULT_PROFILE, exec: true }, "command"), true);
	assert.equal(allowsCapability({ ...DEFAULT_PROFILE, exec: false }, "command"), false);
	assert.equal(allowsCapability({ ...DEFAULT_PROFILE, exec: false }, "permissions"), false);
	// Unknown capabilities are not hard-blocked.
	assert.equal(allowsCapability(DEFAULT_PROFILE, "mystery"), true);
});

// ── Generalized matrices (shared derivation rules) ───────────────────────────
// The coarse-tier rule is defined ONCE here and asserted for every capability
// combination, so a regression fails loudly for all CLIs at once.

// The documented derivation rule. Keeping the expected value next to the
// implementation makes the intent explicit and the matrix self-checking.
// Legacy network:true promotes exec on read, so the expected tier must account
// for the migrated exec, not the raw one.
function expectedTier({ write, exec, network }) {
	const effectiveExec = exec === true || network === true;
	if (effectiveExec) return "danger-full-access";
	if (write) return "workspace-write";
	return "read-only";
}

// Every combination of the three capability booleans (2^3 = 8), plus sweeps
// for legacy network values (promote exec) and the removed approval keys
// ("ask"/"never" are dropped silently; "allow" has migration semantics and is
// covered by its dedicated legacy test above).
const CAPABILITY_COMBOS = (() => {
	const combos = [];
	for (const read of [true, false]) {
		for (const write of [true, false]) {
			for (const exec of [true, false]) {
				combos.push({ read, write, exec });
				// Legacy network values must only ever promote, never demote.
				for (const network of [true, false]) combos.push({ read, write, exec, network });
				// Removed approval keys must be dropped without effect.
				for (const approval of ["ask", "never"]) combos.push({ read, write, exec, approval });
			}
		}
	}
	return combos;
})();

test("deriveSandboxMode matches the documented rule for every capability combination", () => {
	for (const combo of CAPABILITY_COMBOS) {
		const tier = expectedTier(combo);
		assert.equal(deriveSandboxMode(combo), tier, `profile ${JSON.stringify(combo)}`);
	}
});

test("normalizePermission round-trips every capability combination exactly", () => {
	for (const combo of CAPABILITY_COMBOS) {
		const expected = {
			read: combo.read,
			write: combo.write,
			// A legacy network:true migrates onto exec (egress intent).
			exec: combo.network === true ? true : combo.exec
		};
		// Stored network/approval keys are dropped on read; the model is three
		// capabilities.
		assert.deepEqual(normalizePermission(combo), expected, `round-trip ${JSON.stringify(combo)}`);
	}
});

test("normalizePermission coerces partial and malformed inputs to a complete profile", () => {
	const cases = [
		[{}, { ...DEFAULT_PROFILE }],
		[{ read: false }, { ...DEFAULT_PROFILE, read: false }],
		[{ write: true }, { ...DEFAULT_PROFILE, write: true }],
		[{ exec: true }, { ...DEFAULT_PROFILE, exec: true }],
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
	// exec on ⇒ command AND permissions allowed; write on ⇒ file-change allowed.
	for (const combo of CAPABILITY_COMBOS) {
		const p = normalizePermission(combo);
		assert.equal(allowsCapability(p, "command"), p.exec === true, `command gate ${JSON.stringify(combo)}`);
		assert.equal(allowsCapability(p, "file-change"), p.write === true, `file-change gate ${JSON.stringify(combo)}`);
		assert.equal(allowsCapability(p, "permissions"), p.exec === true, `permissions gate ${JSON.stringify(combo)}`);
	}
});

// ── Unified permission request normalizer for all three CLIs ─────────────────

import { normalizePermissionRequest, CLAUDE_APPROVAL_METHODS, QWEN_APPROVAL_METHODS } from "../lib/permissions.js";

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

test("normalizePermissionRequest maps Qwen Code tool names to the canonical capability keys", () => {
	assert.equal(QWEN_APPROVAL_METHODS.Bash, "command");
	assert.equal(QWEN_APPROVAL_METHODS.Write, "file-change");
	assert.equal(QWEN_APPROVAL_METHODS.Edit, "file-change");
	assert.equal(QWEN_APPROVAL_METHODS.WebSearch, "exec");
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

test("normalizePermissionRequest returns a canonical request for a Qwen Write tool_use", () => {
	const request = normalizePermissionRequest("qwen", "Write", {
		toolInput: { file_path: "/tmp/test.md", content: "hello" }
	}, { pluginSessionId: "session-1" });
	assert.equal(request.cli, "qwen");
	assert.equal(request.capability, "file-change");
	assert.equal(request.target, "/tmp/test.md");
	assert.match(request.operation, /Qwen Code:Write/);
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
