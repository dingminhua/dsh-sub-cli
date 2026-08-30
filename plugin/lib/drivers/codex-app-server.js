// Experimental Codex app-server driver. One wire owns one process so Codex
// notifications that omit thread/turn ids cannot leak between concurrent runs.
// It is intentionally not wired into cli_codex yet; tests use a fake transport.

import { randomUUID } from "node:crypto";
import { createRunState, defineDriverCapabilities } from "./types.js";
import { codexApprovalResponse, normalizeCodexPermissionRequest } from "../permissions.js";

export const CODEX_APP_SERVER_CAPABILITIES = defineDriverCapabilities({
	streaming: true,
	continuable: true,
	durableResume: true,
	modelOverride: true,
	reasoningEffort: true,
	cwd: true,
	interrupt: true,
	interactivePermissions: true
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
		this.inboundListeners = new Set();
		this.closed = false;
		this.offLine = transport.onLine((line) => this.receive(line));
		this.offClose = typeof transport.onClose === "function" ? transport.onClose((error) => this.close(error)) : null;
	}

	onNotification(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onRequest(listener) {
		this.inboundListeners.add(listener);
		return () => this.inboundListeners.delete(listener);
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
		if (typeof message.method === "string" && message.id !== undefined) {
			const respond = (result) => this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
			const reject = (error) => this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: asError(error).message } })}\n`);
			for (const listener of [...this.inboundListeners]) {
				try {
					if (listener(message.method, message.params ?? {}, { respond, reject }) === true) return;
				} catch (error) { void reject(error); return; }
			}
			void reject(new Error(`Unsupported Codex server request ${message.method}`));
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
		this.inboundListeners.clear();
	}

	async dispose() {
		this.close(new Error("Codex JSON-RPC wire disposed"));
		await this.transport.dispose?.();
	}
}

class CodexAppServerSession {
	constructor({ wire, cwd, model, reasoningEffort, approvalPolicy, sandbox, onPermissionRequest, resumeThreadId = null, timeoutMs = 1800000 }) {
		this.wire = wire;
		this.cwd = cwd;
		this.model = model;
		this.reasoningEffort = reasoningEffort;
		this.approvalPolicy = approvalPolicy;
		this.sandbox = sandbox;
		this.onPermissionRequest = typeof onPermissionRequest === "function" ? onPermissionRequest : null;
		this.resumeThreadId = resumeThreadId;
		this.timeoutMs = timeoutMs;
		this.threadId = null;
		this.activeTurn = null;
		this.progress = "";
		this.usage = null;
		this.state = createRunState("starting");
		this.disposed = false;
		this.offRequest = this.wire.onRequest((method, params, reply) => this.handleServerRequest(method, params, reply));
	}

	handleServerRequest(method, params, reply) {
		const request = normalizeCodexPermissionRequest(method, params, { remoteRequestId: params?.approvalId ?? params?.itemId });
		if (!request) return false;
		const decide = this.onPermissionRequest
			? Promise.resolve().then(() => this.onPermissionRequest(request))
			: Promise.resolve("unavailable");
		this.state.transition("awaiting_permission");
		decide.then(
			(outcome) => reply.respond(codexApprovalResponse(request, outcome)).then(() => this.state.transition("running")),
			(error) => reply.reject(error).then(() => this.state.transition("failed", asError(error).message))
		).catch(() => {});
		return true;
	}

	async initialize(clientInfo = { name: "dsh-sub-cli", version: "0.1.0" }) {
		await this.wire.request("initialize", { capabilities: {}, clientInfo });
		this.state.transition("running");
	}

	// Attach the thread without running a turn. Used when reopening a released
	// session: `prompt` is empty on purpose, and starting a turn here would
	// throw on the empty input and leave a rejected promise nobody awaits.
	async attach() {
		if (this.threadId) return this.threadId;
		if (this.resumeThreadId) return this.resumeThread();
		return this.startThread();
	}

	async start(prompt) {
		if (!this.threadId) {
			if (this.resumeThreadId) await this.resumeThread();
			else await this.startThread();
		}
		return this.startTurn(prompt);
	}

	// Reattach an existing Codex thread onto this fresh wire. Lets a Host drop
	// the app-server process while idle and still continue the same thread.
	async resumeThread() {
		if (!this.resumeThreadId) throw new Error("Codex thread resume requires a resumeThreadId");
		const result = await this.wire.request("thread/resume", {
			threadId: this.resumeThreadId,
			...(this.cwd ? { cwd: this.cwd } : {}),
			...(this.model ? { model: this.model } : {}),
			...(this.approvalPolicy ? { approvalPolicy: this.approvalPolicy } : {}),
			...(this.sandbox ? { sandbox: this.sandbox } : {}),
			...(this.reasoningEffort ? { config: { model_reasoning_effort: this.reasoningEffort } } : {})
		});
		this.threadId = result?.thread?.id ?? this.resumeThreadId;
		this.state.transition("running");
		return this.threadId;
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
		let toolRounds = 0;
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
				toolRounds,
				usage: this.usage,
				stopReason: "completed"
			});
		};
		const off = this.wire.onNotification((method, params) => {
			if (method === "item/started") {
				const type = params?.item?.type ?? params?.type;
				if (type === "commandExecution" || type === "command_execution") toolRounds++;
				return;
			}
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

	async followup(prompt, options = {}) {
		if (!this.threadId) throw new Error("Codex followup requires an existing thread");
		const previous = this.onPermissionRequest;
		if (typeof options.onPermissionRequest === "function") this.onPermissionRequest = options.onPermissionRequest;
		try { return await this.startTurn(prompt); }
		finally { this.onPermissionRequest = previous; }
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
		this.offRequest?.();
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
			onPermissionRequest: request.onPermissionRequest,
			resumeThreadId: request.resumeThreadId ?? null,
			timeoutMs: request.timeoutMs ?? this.turnTimeoutMs
		});
		try {
			await session.initialize(this.clientInfo);
			// `attachOnly` reopens a released session. Await thread/resume before
			// exposing followup; otherwise callers can race the pending attach and
			// observe a session whose threadId is still null.
			let result;
			if (request.attachOnly) {
				await session.attach();
				result = Promise.resolve({ threadId: session.threadId, text: "", stopReason: "attached" });
			} else {
				result = session.start(request.prompt);
			}
			return {
				id: randomUUID(),
				product: "codex",
				capabilities: this.capabilities,
				get remoteSessionId() { return session.threadId; },
				result,
				followup: (prompt, options) => session.followup(prompt, options),
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
