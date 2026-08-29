import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerDriver, JsonRpcLineWire } from "../lib/drivers/codex-app-server.js";

class FakeTransport {
	constructor(handler) {
		this.handler = handler;
		this.lines = new Set();
		this.closes = new Set();
		this.requests = [];
		this.disposed = false;
	}
	onLine(listener) { this.lines.add(listener); return () => this.lines.delete(listener); }
	onClose(listener) { this.closes.add(listener); return () => this.closes.delete(listener); }
	write(text) {
		const message = JSON.parse(text);
		this.requests.push(message);
		queueMicrotask(() => this.handler(message, this));
	}
	emit(message) {
		const line = JSON.stringify(message);
		for (const listener of [...this.lines]) listener(line);
	}
	async dispose() { this.disposed = true; for (const listener of [...this.closes]) listener(new Error("disposed")); }
}

function responder() {
	let nextTurn = 0;
	return (message, transport) => {
		if (message.method === "initialize") {
			transport.emit({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
			return;
		}
		if (message.method === "thread/start") {
			transport.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } });
			return;
		}
		if (message.method === "turn/start") {
			const turnId = `turn-${++nextTurn}`;
			transport.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turnId } } });
			queueMicrotask(() => {
				transport.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: `delta-${nextTurn}` } });
				transport.emit({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { tokenUsage: { input: nextTurn } } });
				transport.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
			});
			return;
		}
		if (message.method === "turn/interrupt") {
			transport.emit({ jsonrpc: "2.0", id: message.id, result: {} });
		}
	};
}

test("JsonRpcLineWire correlates responses and surfaces notifications", async () => {
	const transport = new FakeTransport((message, target) => {
		target.emit({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } });
		target.emit({ jsonrpc: "2.0", method: "notice", params: { value: 1 } });
	});
	const wire = new JsonRpcLineWire({ transport, requestTimeoutMs: 1000 });
	const notifications = [];
	wire.onNotification((method, params) => notifications.push({ method, params }));
	assert.deepEqual(await wire.request("hello", { a: 1 }), { echoed: "hello" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(notifications, [{ method: "notice", params: { value: 1 } }]);
	await wire.dispose();
});

test("JsonRpcLineWire handles inbound server requests and writes responses", async () => {
	const transport = new FakeTransport(() => {});
	const wire = new JsonRpcLineWire({ transport, requestTimeoutMs: 1000 });
	wire.onRequest((method, params, reply) => {
		if (method !== "item/permissions/requestApproval") return false;
		assert.equal(params.turnId, "turn-approval");
		void reply.respond({ permissions: params.permissions, scope: "turn" });
		return true;
	});
	transport.emit({ jsonrpc: "2.0", id: 91, method: "item/permissions/requestApproval", params: { turnId: "turn-approval", permissions: { network: { enabled: true } } } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(transport.requests.at(-1), {
		jsonrpc: "2.0",
		id: 91,
		result: { permissions: { network: { enabled: true } }, scope: "turn" }
	});
	await wire.dispose();
});

test("JsonRpcLineWire rejects unsupported inbound server requests", async () => {
	const transport = new FakeTransport(() => {});
	const wire = new JsonRpcLineWire({ transport, requestTimeoutMs: 1000 });
	transport.emit({ jsonrpc: "2.0", id: 92, method: "unknown/request", params: {} });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(transport.requests.at(-1).id, 92);
	assert.equal(transport.requests.at(-1).error.code, -32000);
	assert.match(transport.requests.at(-1).error.message, /Unsupported Codex server request/);
	await wire.dispose();
});

test("Codex driver bridges a permission request and resumes the same turn", async () => {
	let approvalResponse;
	const transport = new FakeTransport((message, target) => {
		if (message.method === "initialize") target.emit({ jsonrpc: "2.0", id: message.id, result: {} });
		else if (message.method === "thread/start") target.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-p" } } });
		else if (message.method === "turn/start") {
			target.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-p" } } });
			queueMicrotask(() => target.emit({ jsonrpc: "2.0", id: 90, method: "item/permissions/requestApproval", params: {
				threadId: "thread-p", turnId: "turn-p", itemId: "item-p", cwd: "/repo", reason: "network", permissions: { network: { enabled: true } }
			} }));
		} else if (message.id === 90 && message.result) {
			approvalResponse = message.result;
			target.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "approved" } });
			target.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-p", status: "completed" } } });
		}
	});
	let seen;
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 1000 });
	const run = await driver.start({ cwd: "/repo", prompt: "network", approvalPolicy: "on-request", onPermissionRequest: async (request) => { seen = request; return "allowed-once"; } });
	const result = await run.result;
	assert.equal(seen.turnId, "turn-p");
	assert.equal(seen.capability, "permissions");
	assert.deepEqual(approvalResponse, { permissions: { network: { enabled: true } }, scope: "turn" });
	assert.equal(result.text, "approved");
	assert.equal(result.turnId, "turn-p");
	await run.dispose();
});

test("Codex driver maps rejected and cancelled approvals without restarting the turn", async () => {
	for (const [outcome, expected] of [["rejected", "decline"], ["cancelled", "cancel"]]) {
		let decision;
		const transport = new FakeTransport((message, target) => {
			if (message.method === "initialize") target.emit({ jsonrpc: "2.0", id: message.id, result: {} });
			else if (message.method === "thread/start") target.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-r" } } });
			else if (message.method === "turn/start") {
				target.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-r" } } });
				queueMicrotask(() => target.emit({ jsonrpc: "2.0", id: 93, method: "item/commandExecution/requestApproval", params: { threadId: "thread-r", turnId: "turn-r", itemId: "item-r", command: "curl example.com" } }));
			} else if (message.id === 93 && message.result) {
				decision = message.result.decision;
				target.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-r", status: "completed" } } });
			}
		});
		const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 1000 });
		const run = await driver.start({ cwd: "/repo", prompt: "request", approvalPolicy: "on-request", onPermissionRequest: async () => outcome });
		const result = await run.result;
		assert.equal(decision, expected);
		assert.equal(result.turnId, "turn-r");
		assert.equal(transport.requests.filter((entry) => entry.method === "turn/start").length, 1);
		await run.dispose();
	}
});

test("Codex driver maps file-change approvals on the same turn", async () => {
	let response;
	const transport = new FakeTransport((message, target) => {
		if (message.method === "initialize") target.emit({ jsonrpc: "2.0", id: message.id, result: {} });
		else if (message.method === "thread/start") target.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-file" } } });
		else if (message.method === "turn/start") {
			target.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-file" } } });
			queueMicrotask(() => target.emit({ jsonrpc: "2.0", id: 94, method: "item/fileChange/requestApproval", params: { threadId: "thread-file", turnId: "turn-file", itemId: "item-file", grantRoot: "/repo/outside", reason: "write file", startedAtMs: Date.now() } }));
		} else if (message.id === 94 && message.result) {
			response = message.result;
			target.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-file", status: "completed" } } });
		}
	});
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 1000 });
	const run = await driver.start({ cwd: "/repo", prompt: "write", approvalPolicy: "on-request", onPermissionRequest: async (request) => { assert.equal(request.capability, "file-change"); assert.equal(request.target, "/repo/outside"); return "allowed-once"; } });
	await run.result;
	assert.deepEqual(response, { decision: "accept" });
	await run.dispose();
});

test("Codex driver initializes, streams, and follows up on the same thread", async () => {
	const transports = [];
	const driver = new CodexAppServerDriver({
		createTransport: async () => {
			const transport = new FakeTransport(responder());
			transports.push(transport);
			return transport;
		},
		requestTimeoutMs: 1000,
		turnTimeoutMs: 1000
	});
	const run = await driver.start({ cwd: "/repo", prompt: "first", model: "m1", reasoningEffort: "high" });
	const first = await run.result;
	assert.equal(first.threadId, "thread-1");
	assert.equal(first.text, "delta-1");
	assert.equal(first.usage.input, 1);
	assert.equal(run.remoteSessionId, "thread-1");
	const second = await run.followup("second");
	assert.equal(second.threadId, "thread-1");
	assert.equal(second.text, "delta-2");
	const starts = transports[0].requests.filter((entry) => entry.method === "turn/start");
	assert.equal(starts.length, 2);
	assert.equal(starts[0].params.threadId, "thread-1");
	assert.equal(starts[1].params.threadId, "thread-1");
	assert.equal(starts[0].params.sandboxPolicy.type, "readOnly");
	assert.equal(transports.length, 1);
	await run.dispose();
	assert.equal(transports[0].disposed, true);
});

test("Codex driver sends turn interrupt and settles interrupted turns", async () => {
	let pendingTurn;
	const transport = new FakeTransport((message, target) => {
		if (message.method === "initialize") target.emit({ jsonrpc: "2.0", id: message.id, result: {} });
		else if (message.method === "thread/start") target.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-x" } } });
		else if (message.method === "turn/start") {
			pendingTurn = "turn-x";
			target.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: pendingTurn } } });
		} else if (message.method === "turn/interrupt") {
			target.emit({ jsonrpc: "2.0", id: message.id, result: {} });
			queueMicrotask(() => target.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: pendingTurn, status: "interrupted" } } }));
		}
	});
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 5000 });
	const run = await driver.start({ cwd: "/repo", prompt: "wait" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await run.interrupt(), true);
	await assert.rejects(run.result, /interrupted/);
	assert.equal(run.status().state, "cancelled");
	assert.ok(transport.requests.some((entry) => entry.method === "turn/interrupt"));
	await run.dispose();
});

test("parallel Codex runs use independent transports", async () => {
	const transports = [];
	const driver = new CodexAppServerDriver({
		createTransport: async () => {
			const transport = new FakeTransport(responder());
			transports.push(transport);
			return transport;
		},
		requestTimeoutMs: 1000,
		turnTimeoutMs: 1000
	});
	const [a, b] = await Promise.all([
		driver.start({ cwd: "/a", prompt: "a" }),
		driver.start({ cwd: "/b", prompt: "b" })
	]);
	const [ra, rb] = await Promise.all([a.result, b.result]);
	assert.equal(transports.length, 2);
	assert.equal(ra.text, "delta-1");
	assert.equal(rb.text, "delta-1");
	await Promise.all([a.dispose(), b.dispose()]);
});
