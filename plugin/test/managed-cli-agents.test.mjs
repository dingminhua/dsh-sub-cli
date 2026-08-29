import assert from "node:assert/strict";
import test from "node:test";
import { ManagedCliAgentsService } from "../lib/managed-cli-agents.js";

function deferred() { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; }
function driverFixture() {
	const calls = [];
	let followups = [];
	let interrupted = 0;
	let disposed = 0;
	const run = {
		remoteSessionId: "thread-1",
		result: Promise.resolve({ threadId: "thread-1", text: "first", stopReason: "completed" }),
		async followup(prompt) { followups.push(prompt); return { threadId: "thread-1", text: `next:${prompt}`, stopReason: "completed" }; },
		async interrupt() { interrupted++; return true; },
		async dispose() { disposed++; }
	};
	return {
		driver: { async start(input) { calls.push(input); return run; } },
		calls, followups,
		get interrupted() { return interrupted; }, get disposed() { return disposed; }
	};
}

test("dispatch records a real remote thread and returns a stable session", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({ drivers: { codex: f.driver }, routeSource: () => ({ provider: "p", model: "m", reasoningEffort: "high" }), permissionSource: () => "workspace-write" });
	const value = await service.dispatch({ cwd: "/repo", prompt: "first" });
	assert.match(value.session.sessionId, /^cli-codex-/);
	assert.equal(value.session.remoteSessionId, "thread-1");
	assert.equal(value.session.status, "ready");
	assert.equal(value.output, "first");
	assert.equal(f.calls[0].sandbox, "workspace-write");
	assert.equal(f.calls[0].model, "m");
});

test("dispatch exposes awaiting permission and clears it after an audited decision", async () => {
	const approval = deferred();
	let input;
	const driver = { async start(value) {
		input = value;
		return { remoteSessionId: "thread-p", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-p", remoteRequestId: "remote-p", cli: "codex", turnId: "turn-p", itemId: "item-p", capability: "permissions", operation: "item/permissions/requestApproval", target: "/repo", reason: "network", createdAt: new Date().toISOString() });
			return { threadId: "thread-p", text: outcome };
		})(), dispose: async () => {} };
	} };
	const agent = { session: { id: "parent" } };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, approvalRequest: async (request, context) => { assert.equal(context.agent, agent); assert.equal(request.pluginSessionId.startsWith("cli-codex-"), true); return approval.promise; } });
	const pending = service.dispatch({ cwd: "/repo", prompt: "first", agent, childId: "child-p" });
	await new Promise((r) => setImmediate(r));
	const open = service.list()[0];
	assert.equal(input.approvalPolicy, "on-request");
	assert.equal(open.status, "awaiting_permission");
	assert.equal(open.pendingPermission.requestId, "req-p");
	assert.equal(open.pendingPermission.turnId, "turn-p");
	approval.resolve("allowed-once");
	const done = await pending;
	assert.equal(done.output, "allowed-once");
	assert.equal(done.session.pendingPermission, null);
	assert.equal(done.session.lastPermissionDecision.requestId, "req-p");
	assert.equal(done.session.lastPermissionDecision.outcome, "allowed-once");
	assert.equal(done.session.status, "ready");
});

test("relay permission approval is routed through the bound parent agent", async () => {
	const childAgent = { session: { id: "child-agent" } };
	const parentAgent = { session: { id: "parent-agent" } };
	let approvedBy;
	const driver = { async start(value) {
		return { remoteSessionId: "thread-parent", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-parent", cli: "codex", turnId: "turn-parent", itemId: "item-parent", capability: "command", operation: "command", createdAt: new Date().toISOString() });
			return { threadId: "thread-parent", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, approvalRequest: async (_request, context) => { approvedBy = context.agent; return "allowed-once"; } });
	service.bindChild("child-agent", { cli: "codex", parentAgent });
	service.setChildCwd("child-agent", "/repo");
	const value = await service.submitFromChild("child-agent", "task", undefined, childAgent);
	assert.equal(value.output, "allowed-once");
	assert.equal(approvedBy, parentAgent);
	assert.equal("parentAgent" in service.childBinding("child-agent"), false);
});

test("a second permission request is rejected while one is pending", async () => {
	const approval = deferred();
	let secondError;
	const driver = { async start(value) {
		return { remoteSessionId: "thread-b", result: (async () => {
			const first = value.onPermissionRequest({ requestId: "req-1", cli: "codex", turnId: "turn-b", itemId: "item-1", capability: "permissions", operation: "one", createdAt: new Date().toISOString() });
			try { await value.onPermissionRequest({ requestId: "req-2", cli: "codex", turnId: "turn-b", itemId: "item-2", capability: "command", operation: "two", createdAt: new Date().toISOString() }); }
			catch (error) { secondError = error; }
			await first;
			return { threadId: "thread-b", text: "done" };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, approvalRequest: () => approval.promise });
	const pending = service.dispatch({ cwd: "/repo", prompt: "first", agent: { session: { id: "parent" } } });
	await new Promise((r) => setImmediate(r));
	assert.equal(secondError.code, "PERMISSION_REQUEST_BUSY");
	assert.equal(service.list()[0].pendingPermission.requestId, "req-1");
	approval.resolve("rejected");
	await pending;
});

test("followup uses the same live driver run and status/list are secret-free", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({ drivers: { codex: f.driver } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const next = await service.followup(first.session.sessionId, "second");
	assert.equal(next.output, "next:second");
	assert.deepEqual(f.followups, ["second"]);
	assert.equal(service.status(first.session.sessionId).remoteSessionId, "thread-1");
	assert.equal(service.list().length, 1);
	assert.equal("apiKey" in service.status(first.session.sessionId), false);
});

test("concurrent followup is rejected with SESSION_BUSY", async () => {
	const gate = deferred();
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), followup: () => gate.promise, interrupt: async () => true, dispose: async () => {} }; } } } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const pending = service.followup(first.session.sessionId, "slow");
	await new Promise((r) => setImmediate(r));
	await assert.rejects(service.followup(first.session.sessionId, "overlap"), (error) => error.code === "SESSION_BUSY");
	gate.resolve({ threadId: "t", text: "done" });
	await pending;
});

test("relay child binding creates then follows up the same managed session", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({ drivers: { codex: f.driver } });
	service.bindChild("child-1", { cli: "codex" });
	service.setChildCwd("child-1", "/repo");
	service.beginChildEpoch("child-1");
	assert.equal(service.childCanReport("child-1"), false);
	const first = await service.submitFromChild("child-1", "first");
	assert.equal(first.output, "first");
	assert.equal(service.childCanReport("child-1"), true);
	const binding = service.childBinding("child-1");
	assert.equal(binding.sessionId, first.session.sessionId);
	const second = await service.submitFromChild("child-1", "second");
	assert.equal(second.output, "next:second");
	assert.equal(service.childBinding("child-1").sessionId, first.session.sessionId);
});

test("interrupt clears a pending permission and marks the session interrupted", async () => {
	const approval = deferred();
	let interruptResolve;
	const interruptedResult = new Promise((resolve) => { interruptResolve = resolve; });
	const driver = { async start(value) {
		return {
			remoteSessionId: "thread-i",
			result: (async () => { await value.onPermissionRequest({ requestId: "req-i", cli: "codex", turnId: "turn-i", itemId: "item-i", capability: "command", operation: "command", createdAt: new Date().toISOString() }); return interruptedResult; })(),
			async interrupt() { approval.resolve("cancelled"); interruptResolve({ threadId: "thread-i", text: "cancelled" }); return true; },
			async dispose() {}
		};
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, approvalRequest: () => approval.promise });
	const pending = service.dispatch({ cwd: "/repo", prompt: "task", agent: { session: { id: "parent" } } });
	await new Promise((r) => setImmediate(r));
	const sessionId = service.list()[0].sessionId;
	assert.equal(service.status(sessionId).status, "awaiting_permission");
	const stopped = await service.interrupt(sessionId);
	assert.equal(stopped.interrupted, true);
	assert.equal(stopped.session.pendingPermission, null);
	assert.equal(stopped.session.status, "interrupted");
	await pending;
});

test("interrupt delegates to active run and close disposes it", async () => {
	const gate = deferred();
	let interrupts = 0, disposed = 0;
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), followup: () => gate.promise, interrupt: async () => { interrupts++; return true; }, dispose: async () => { disposed++; } }; } } } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const pending = service.followup(first.session.sessionId, "slow");
	await new Promise((r) => setImmediate(r));
	assert.equal((await service.interrupt(first.session.sessionId)).interrupted, true);
	assert.equal(interrupts, 1);
	gate.resolve({ threadId: "t", text: "done" });
	await pending;
	await service.close(first.session.sessionId);
	assert.equal(disposed, 1);
});
