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
