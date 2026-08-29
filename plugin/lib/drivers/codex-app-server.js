// Experimental Codex app-server driver. One wire owns one process so Codex
// notifications that omit thread/turn ids cannot leak between concurrent runs.
// It is intentionally not wired into cli_codex yet; tests use a fake transport.

import { randomUUID } from "node:crypto";
import { createRunState, defineDriverCapabilities } from "./types.js";

export const CODEX_APP_SERVER_CAPABILITIES = defineDriverCapabilities({
	streaming: true,
	continuable: true,
	durableResume: true,
	modelOverride: true,
	reasoningEffort: true,
	cwd: true,
	interrupt: true
});

function asError(value) {
	return value instanceof Error ? value : new Error(String(value));
}

function turnStatus(params) {
	return params?.turn?.status ?? params?.status ?? params?.turnStatus;
}

function turnFailure(params) {
	return params?.turn?.error?.message ?? params?.error?.message ?? params?.message ?? "Codex turn failed";
}

function sandboxPolicyType(sandboxMode) {
	return {
		"read-only": "readOnly",
		"workspace-write": "workspaceWrite",
		"danger-full-access": "dangerFullAccess"
	}[sandboxMode] ?? sandboxMode;
}

function messageDelta(params) {
	const delta = params?.delta ?? params?.text ?? params?.item?.delta;
	return typeof delta === "string" ? delta : "";
}

function finalMessage(params) {
	const item = params?.item;
	if (item?.type === "agentMessage" || item?.type === "agent_message") {
		return typeof item.text === "string" ? item.text : "";
	}
	return "";
}

export class JsonRpcLineWire {
	constructor({ transport, requestTimeoutMs = 30000 }) {
		if (!transport || typeof transport.write !== "function" || typeof transport.onLine !== "function") {
			throw new TypeError("Codex JSON-RPC wire requires transport.write and transport.onLine");
		}
		this.transport = transport;
		this.requestTimeoutMs = requestTimeoutMs;
		this.sequence = 0;
		this.pending = new Map();
		this.listeners = new Set();
		this.closed = false;
		this.offLine = transport.onLine((line) => this.receive(line));
		this.offClose = typeof transport.onClose === "function" ? transport.onClose((error) => this.close(error)) : null;
	}

	onNotification(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	receive(line) {
		if (this.closed || typeof line !== "string" || !line.trim()) return;
		let message;
		try { message = JSON.parse(line); } catch { return; }
		if (message.id !== undefined && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(`Codex RPC ${message.error.code ?? ""} ${message.error.message ?? "error"}`.trim()));
			else pending.resolve(message.result);
			return;
		}
		if (typeof message.method === "string") {
			for (const listener of [...this.listeners]) {
				try { listener(message.method, message.params ?? {}); } catch {}
			}
		}
	}

	request(method, params = {}) {
		if (this.closed) return Promise.reject(new Error("Codex JSON-RPC wire is closed"));
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(new Error(`Codex RPC ${method} timed out after ${this.requestTimeoutMs}ms`));
			}, this.requestTimeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			Promise.resolve(this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)).catch((error) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer);
				reject(asError(error));
			});
		});
	}

	close(reason = new Error("Codex JSON-RPC wire closed")) {
		if (this.closed) return;
		this.closed = true;
		this.offLine?.();
		this.offClose?.();
		const error = asError(reason);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.listeners.clear();
	}

	async dispose() {
		this.close(new Error("Codex JSON-RPC wire disposed"));
		await this.transport.dispose?.();
	}
}

class CodexAppServerSession {
	constructor({ wire, cwd, model, reasoningEffort, approvalPolicy, sandbox, timeoutMs = 1800000 }) {
		this.wire = wire;
		this.cwd = cwd;
		this.model = model;
		this.reasoningEffort = reasoningEffort;
		this.approvalPolicy = approvalPolicy;
		this.sandbox = sandbox;
		this.timeoutMs = timeoutMs;
		this.threadId = null;
		this.activeTurn = null;
		this.progress = "";
		this.usage = null;
		this.state = createRunState("starting");
		this.disposed = false;
	}

	async initialize(clientInfo = { name: "dsh-sub-cli", version: "0.1.0" }) {
		await this.wire.request("initialize", { capabilities: {}, clientInfo });
		this.state.transition("running");
	}

	async start(prompt) {
		if (!this.threadId) await this.startThread();
		return this.startTurn(prompt);
	}

	async startThread() {
		const config = {};
		if (this.approvalPolicy) config.approval_policy = this.approvalPolicy;
		if (this.sandbox) config.sandbox_mode = this.sandbox;
		if (this.reasoningEffort) config.model_reasoning_effort = this.reasoningEffort;
		const result = await this.wire.request("thread/start", {
			cwd: this.cwd,
			model: this.model,
			approvalPolicy: this.approvalPolicy,
			sandbox: this.sandbox,
			config,
			baseInstructions: null,
			developerInstructions: null,
			experimentalRawEvents: false,
			persistExtendedHistory: false
		});
		this.threadId = result?.thread?.id ?? result?.threadId ?? null;
		if (!this.threadId) throw new Error("Codex thread/start returned no thread id");
		return this.threadId;
	}

	async startTurn(prompt) {
		if (this.disposed) throw new Error("Codex session is disposed");
		if (this.activeTurn) throw new Error("Codex session already has an active turn");
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Codex turn prompt must not be empty");
		this.progress = "";
		this.state.transition("running");
		const started = await this.wire.request("turn/start", {
			threadId: this.threadId,
			input: [{ type: "text", text: prompt }],
			cwd: this.cwd,
			approvalPolicy: this.approvalPolicy,
			sandboxPolicy: this.sandbox ? { type: sandboxPolicyType(this.sandbox) } : undefined,
			model: this.model
		});
		const turnId = started?.turn?.id ?? started?.turnId;
		if (!turnId) throw new Error("Codex turn/start returned no turn id");
		return this.awaitTurn(turnId);
	}

	awaitTurn(turnId) {
		let settled = false;
		let finalText = "";
		let timer;
		const finish = (resolve, reject, outcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			this.activeTurn = null;
			if (outcome.error) {
				this.state.transition(outcome.cancelled ? "cancelled" : "failed", outcome.error.message);
				reject(outcome.error);
				return;
			}
			this.state.transition("completed");
			resolve({
				threadId: this.threadId,
				turnId,
				text: finalText || this.progress,
				usage: this.usage,
				stopReason: "completed"
			});
		};
		const off = this.wire.onNotification((method, params) => {
			if (method === "item/agentMessage/delta") {
				const delta = messageDelta(params);
				if (delta) this.progress += delta;
				return;
			}
			if (method === "item/completed") {
				const text = finalMessage(params);
				if (text) finalText += text;
				return;
			}
			if (method === "thread/tokenUsage/updated") {
				this.usage = params?.tokenUsage ?? params?.usage ?? params;
				return;
			}
			if (method === "turn/failed") {
				finish(this.activeTurn.resolve, this.activeTurn.reject, { error: new Error(turnFailure(params)) });
				return;
			}
			if (method === "turn/completed") {
				const status = turnStatus(params);
				if (status === "interrupted" || status === "cancelled") {
					finish(this.activeTurn.resolve, this.activeTurn.reject, { error: new Error("Codex turn interrupted"), cancelled: true });
				} else if (status === "failed") {
					finish(this.activeTurn.resolve, this.activeTurn.reject, { error: new Error(turnFailure(params)) });
				} else {
					finish(this.activeTurn.resolve, this.activeTurn.reject, {});
				}
			}
		});
		const promise = new Promise((resolve, reject) => {
			this.activeTurn = { turnId, resolve, reject };
			timer = setTimeout(() => {
				void this.interrupt().finally(() => finish(resolve, reject, { error: new Error(`Codex turn timed out after ${this.timeoutMs}ms`), cancelled: true }));
			}, this.timeoutMs);
			timer.unref?.();
		});
		return promise;
	}

	async followup(prompt) {
		if (!this.threadId) throw new Error("Codex followup requires an existing thread");
		return this.startTurn(prompt);
	}

	async interrupt() {
		if (!this.activeTurn || !this.threadId) return false;
		await this.wire.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurn.turnId }).catch(() => {});
		return true;
	}

	snapshot() {
		return {
			id: this.threadId,
			threadId: this.threadId,
			turnId: this.activeTurn?.turnId ?? null,
			progress: this.progress,
			usage: this.usage,
			...this.state.snapshot()
		};
	}

	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		await this.interrupt();
		await this.wire.dispose();
	}
}

export class CodexAppServerDriver {
	constructor({ createTransport, requestTimeoutMs = 30000, turnTimeoutMs = 1800000, clientInfo } = {}) {
		if (typeof createTransport !== "function") throw new TypeError("Codex app-server driver requires createTransport(request)");
		this.id = "codex-app-server";
		this.capabilities = CODEX_APP_SERVER_CAPABILITIES;
		this.createTransport = createTransport;
		this.requestTimeoutMs = requestTimeoutMs;
		this.turnTimeoutMs = turnTimeoutMs;
		this.clientInfo = clientInfo ?? { name: "dsh-sub-cli", version: "0.1.0" };
	}

	async start(request) {
		if (!request || typeof request !== "object") throw new TypeError("Codex driver request must be an object");
		if (typeof request.cwd !== "string" || !request.cwd) throw new Error("Codex driver request.cwd is required");
		const transport = await this.createTransport(request);
		const wire = new JsonRpcLineWire({ transport, requestTimeoutMs: this.requestTimeoutMs });
		const session = new CodexAppServerSession({
			wire,
			cwd: request.cwd,
			model: request.model,
			reasoningEffort: request.reasoningEffort,
			approvalPolicy: request.approvalPolicy ?? "never",
			sandbox: request.sandbox ?? "readOnly",
			timeoutMs: request.timeoutMs ?? this.turnTimeoutMs
		});
		try {
			await session.initialize(this.clientInfo);
			const result = session.start(request.prompt);
			return {
				id: randomUUID(),
				product: "codex",
				capabilities: this.capabilities,
				get remoteSessionId() { return session.threadId; },
				result,
				followup: (prompt) => session.followup(prompt),
				interrupt: () => session.interrupt(),
				status: () => session.snapshot(),
				dispose: () => session.dispose()
			};
		} catch (error) {
			await session.dispose().catch(() => {});
			throw error;
		}
	}
}
