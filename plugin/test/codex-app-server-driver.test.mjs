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
