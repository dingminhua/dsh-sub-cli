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

// ── Deadline stall probe (2026-09) ────────────────────────────────────────────
// The deadline used to be an automatic interrupt. Now it probes the wire for
// liveness: a turn with NO app-server notifications at all is genuinely stuck
// and gets interrupted; a turn that keeps receiving notifications (even across
// many grace windows) is healthy and keeps running.

test("Codex driver interrupts a turn that produced no app-server events", async () => {
	// turn/start succeeds but the fake server never emits any notification:
	// lastNotificationAt stays null → the first probe says "stalled" →
	// interrupt + reject with the stall reason.
	const transport = new FakeTransport((message, target) => {
		if (message.method === "initialize") target.emit({ jsonrpc: "2.0", id: message.id, result: {} });
		else if (message.method === "thread/start") target.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-s" } } });
		else if (message.method === "turn/start") target.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-s" } } });
		else if (message.method === "turn/interrupt") target.emit({ jsonrpc: "2.0", id: message.id, result: {} });
	});
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 30 });
	const run = await driver.start({ cwd: "/repo", prompt: "silence", approvalPolicy: "on-request" });
	await assert.rejects(run.result, (error) => {
		assert.match(error.message, /stalled/);
		assert.match(error.message, /no app-server notification observed/);
		assert.equal(error.stopReason, "cancelled");
		return true;
	});
	assert.ok(transport.requests.some((entry) => entry.method === "turn/interrupt"), "the stuck turn was interrupted");
	await run.dispose();
});

test("Codex driver keeps waiting for a turn that keeps emitting events", async () => {
	// A slow but healthy turn: the fake server keeps emitting delta
	// notifications well past the deadline. The probe sees recent
	// lastNotificationAt on every check and must NOT interrupt; the turn
	// completes when the server finally says so.
	let ticks = 0;
	let timer = null;
	const transport = new FakeTransport((message, target) => {
		if (message.method === "initialize") target.emit({ jsonrpc: "2.0", id: message.id, result: {} });
		else if (message.method === "thread/start") target.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-h" } } });
		else if (message.method === "turn/start") {
			target.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-h" } } });
			// Emit a delta every 20ms — well within the 60s grace window —
			// and complete the turn after 6 ticks (≈120ms, i.e. 4 deadlines).
			timer = setInterval(() => {
				ticks++;
				target.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: `chunk-${ticks} ` } });
				if (ticks >= 6) {
					clearInterval(timer);
					target.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-h", status: "completed" } } });
				}
			}, 20);
		} else if (message.method === "turn/interrupt") {
			throw new Error("healthy turn must not be interrupted");
		}
	});
	try {
		const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 30 });
		const run = await driver.start({ cwd: "/repo", prompt: "slow", approvalPolicy: "on-request" });
		const result = await run.result;
		assert.equal(result.stopReason, "completed");
		assert.match(result.text, /chunk-6/);
		assert.ok(ticks >= 6);
		await run.dispose();
	} finally {
		clearInterval(timer);
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

test("Codex driver resumes an existing thread instead of starting a new one", async () => {
	const transport = new FakeTransport((message, self) => {
		if (message.method === "initialize") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
			return;
		}
		if (message.method === "thread/resume") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId }, model: "m1", cwd: "/repo" } });
			return;
		}
		if (message.method === "turn/start") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-resumed" } } });
			queueMicrotask(() => {
				self.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "resumed" } });
				self.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-resumed", status: "completed" } } });
			});
		}
	});
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 1000 });
	const run = await driver.start({ cwd: "/repo", prompt: "again", resumeThreadId: "thread-orig", model: "m1", reasoningEffort: "high" });
	const result = await run.result;
	assert.equal(result.threadId, "thread-orig");
	assert.equal(result.text, "resumed");
	assert.equal(run.remoteSessionId, "thread-orig");
	// No thread/start: the remote thread was reattached, not recreated.
	assert.equal(transport.requests.some((entry) => entry.method === "thread/start"), false);
	const resume = transport.requests.find((entry) => entry.method === "thread/resume");
	assert.equal(resume.params.threadId, "thread-orig");
	assert.equal(resume.params.model, "m1");
	assert.equal(resume.params.config.model_reasoning_effort, "high");
	await run.dispose();
});

test("Codex driver without resumeThreadId starts a fresh thread", async () => {
	const transport = new FakeTransport(responder());
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 1000 });
	const run = await driver.start({ cwd: "/repo", prompt: "first" });
	await run.result;
	assert.equal(transport.requests.some((entry) => entry.method === "thread/start"), true);
	assert.equal(transport.requests.some((entry) => entry.method === "thread/resume"), false);
	await run.dispose();
});

test("Codex driver attachOnly binds the thread without starting a turn", async () => {
	const transport = new FakeTransport((message, self) => {
		if (message.method === "initialize") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
			return;
		}
		if (message.method === "thread/resume") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId } } });
			return;
		}
		if (message.method === "turn/start") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-attached" } } });
			queueMicrotask(() => {
				self.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "attached-turn" } });
				self.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-attached", status: "completed" } } });
			});
		}
	});
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 1000 });
	const run = await driver.start({ cwd: "/repo", attachOnly: true, resumeThreadId: "thread-idle" });
	assert.deepEqual(await run.result, { threadId: "thread-idle", text: "", stopReason: "attached" });
	assert.equal(run.remoteSessionId, "thread-idle");
	// No turn/start: an empty prompt here would have thrown into an unawaited promise.
	assert.equal(transport.requests.some((entry) => entry.method === "turn/start"), false);
	assert.equal(transport.requests.some((entry) => entry.method === "thread/resume"), true);
	// The reattached session can still run a real turn afterwards.
	const followed = await run.followup("later");
	assert.equal(followed.threadId, "thread-idle");
	assert.equal(followed.text, "attached-turn");
	await run.dispose();
});

test("Codex driver counts commandExecution rounds for auto-continue decisions", async () => {
	const transport = new FakeTransport((message, self) => {
		if (message.method === "initialize") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
			return;
		}
		if (message.method === "thread/start") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-tools" } } });
			return;
		}
		if (message.method === "turn/start") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-tools" } } });
			queueMicrotask(() => {
				self.emit({ jsonrpc: "2.0", method: "item/started", params: { item: { id: "cmd-1", type: "commandExecution", thread_id: "thread-tools", turn_id: "turn-tools" } } });
				self.emit({ jsonrpc: "2.0", method: "item/completed", params: { item: { id: "cmd-1", type: "commandExecution" } } });
				self.emit({ jsonrpc: "2.0", method: "item/started", params: { item: { id: "msg-1", type: "agentMessage", thread_id: "thread-tools", turn_id: "turn-tools" } } });
				self.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { text: "抓取成功。现在解析时间戳。" } });
				self.emit({ jsonrpc: "2.0", method: "item/completed", params: { item: { id: "msg-1", type: "agentMessage", text: "抓取成功。现在解析时间戳。" } } });
				self.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-tools", status: "completed" } } });
			});
		}
	});
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 1000 });
	const run = await driver.start({ cwd: "/repo", prompt: "调查" });
	const result = await run.result;
	assert.equal(result.toolRounds, 1);
	assert.match(result.text, /现在解析时间戳/);
	await run.dispose();
});

test("Codex driver resolves text from completed agent messages, falling back to delta progress", async () => {
	const transport = new FakeTransport((message, self) => {
		if (message.method === "initialize") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
			return;
		}
		if (message.method === "thread/start") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-fb" } } });
			return;
		}
		if (message.method === "turn/start") {
			self.emit({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-fb" } } });
			queueMicrotask(() => {
				// Only deltas stream; no item/completed agentMessage arrives before
				// turn/completed — the fallback path must still surface progress.
				self.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { text: "正在生成" } });
				self.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { text: "…最终报告。" } });
				self.emit({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-fb", status: "completed" } } });
			});
		}
	});
	const driver = new CodexAppServerDriver({ createTransport: async () => transport, requestTimeoutMs: 1000, turnTimeoutMs: 1000 });
	const run = await driver.start({ cwd: "/repo", prompt: "调查" });
	const result = await run.result;
	assert.equal(result.toolRounds, 0);
	assert.equal(result.text, "正在生成…最终报告。");
	await run.dispose();
});
