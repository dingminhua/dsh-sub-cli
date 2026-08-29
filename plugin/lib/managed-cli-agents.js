// Host-plane managed external CLI session service. It owns product thread
// identity and exposes a programmatic seam shared by tools and future DAG/team
// integrations. Initial implementation is in-memory; records contain no keys.

import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["closed"]);

function now() { return new Date().toISOString(); }
function errorOf(code, message) { const error = new Error(message); error.code = code; return error; }
function snapshot(record) {
	return Object.freeze({
		sessionId: record.sessionId,
		cli: record.cli,
		remoteSessionId: record.remoteSessionId ?? null,
		cwd: record.cwd,
		provider: record.provider || "",
		model: record.model || "",
		reasoningEffort: record.reasoningEffort || "",
		permissionMode: record.permissionMode,
		status: record.status,
		activeTurn: record.activeTurn,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		lastError: record.lastError ?? null,
		lastPermissionDecision: record.lastPermissionDecision ? Object.freeze({ ...record.lastPermissionDecision }) : null,
		pendingPermission: record.pendingPermission ? Object.freeze({ ...record.pendingPermission }) : null
	});
}

export class ManagedCliAgentsService {
	constructor({ drivers, routeSource, permissionSource, approvalRequest }) {
		if (!drivers?.codex) throw new TypeError("managedCliAgents requires a Codex driver");
		this.drivers = drivers;
		this.routeSource = typeof routeSource === "function" ? routeSource : () => ({});
		this.permissionSource = typeof permissionSource === "function" ? permissionSource : () => "read-only";
		this.approvalRequest = typeof approvalRequest === "function" ? approvalRequest : async () => "unavailable";
		this.records = new Map();
		this.childBindings = new Map();
	}

	permissionSpec(cli) {
		const mode = this.permissionSource(cli) || "read-only";
		return { permissionMode: mode, approvalPolicy: "on-request", sandbox: mode };
	}

	async dispatch({ cli = "codex", cwd, prompt, signal, agent = null, childId = null }) {
		if (cli !== "codex") throw errorOf("CLI_UNSUPPORTED", `managed session CLI ${cli} is not supported yet`);
		if (typeof cwd !== "string" || !cwd) throw errorOf("SESSION_CWD_REQUIRED", "managed CLI session requires cwd");
		if (typeof prompt !== "string" || !prompt.trim()) throw errorOf("SESSION_PROMPT_REQUIRED", "managed CLI session prompt must not be empty");
		const route = await this.routeSource(cli) ?? {};
		const permission = this.permissionSpec(cli);
		const timestamp = now();
		const sessionId = `cli-${cli}-${randomUUID()}`;
		const record = {
			sessionId, cli, cwd,
			provider: route.provider || "", model: route.model || "", reasoningEffort: route.reasoningEffort || "",
			permissionMode: permission.permissionMode,
			status: "starting", activeTurn: true, createdAt: timestamp, updatedAt: timestamp,
			lastError: null, run: null, remoteSessionId: null, pendingPermission: null, lastPermissionDecision: null
		};
		this.records.set(sessionId, record);
		try {
			record.run = await this.drivers.codex.start({
				cwd, prompt, model: record.model || undefined, reasoningEffort: record.reasoningEffort || undefined,
				approvalPolicy: permission.approvalPolicy, sandbox: permission.sandbox, signal,
				onPermissionRequest: async (request) => {
					if (record.pendingPermission) throw errorOf("PERMISSION_REQUEST_BUSY", `managed CLI session ${sessionId} already has a pending permission request`);
					const contextual = Object.freeze({ ...request, pluginSessionId: sessionId, childId });
					record.pendingPermission = {
						requestId: contextual.requestId, remoteRequestId: contextual.remoteRequestId,
						turnId: contextual.turnId, itemId: contextual.itemId, capability: contextual.capability,
						operation: contextual.operation, target: contextual.target, reason: contextual.reason,
						createdAt: contextual.createdAt
					};
					record.status = "awaiting_permission";
					record.updatedAt = now();
					try {
						const outcome = await this.approvalRequest(contextual, { agent, signal });
						record.lastPermissionDecision = { requestId: contextual.requestId, turnId: contextual.turnId, capability: contextual.capability, outcome, decidedAt: now() };
						return outcome;
					} finally {
						if (record.pendingPermission?.requestId === contextual.requestId) record.pendingPermission = null;
						if (record.status === "awaiting_permission") record.status = "running";
						record.updatedAt = now();
					}
				}
			});
			if (!record.pendingPermission) record.status = "running";
			record.updatedAt = now();
			const result = await record.run.result;
			record.remoteSessionId = result.threadId ?? record.run.remoteSessionId ?? null;
			record.status = "ready";
			record.activeTurn = false;
			record.updatedAt = now();
			return { session: snapshot(record), output: result.text || "", stopReason: result.stopReason ?? "completed" };
		} catch (error) {
			record.pendingPermission = null;
			record.remoteSessionId = record.run?.remoteSessionId ?? record.remoteSessionId;
			record.status = signal?.aborted ? "interrupted" : "failed";
			record.activeTurn = false;
			record.lastError = error instanceof Error ? error.message : String(error);
			record.updatedAt = now();
			throw error;
		}
	}

	async followup(sessionId, prompt, signal, { agent = null, childId = null } = {}) {
		const record = this.require(sessionId);
		if (TERMINAL.has(record.status)) throw errorOf("SESSION_CLOSED", `managed CLI session ${sessionId} is closed`);
		if (record.activeTurn) throw errorOf("SESSION_BUSY", `managed CLI session ${sessionId} already has an active turn`);
		if (!record.run || typeof record.run.followup !== "function") throw errorOf("SESSION_NOT_LIVE", `managed CLI session ${sessionId} is not live in this Host`);
		if (typeof prompt !== "string" || !prompt.trim()) throw errorOf("SESSION_PROMPT_REQUIRED", "follow-up prompt must not be empty");
		record.activeTurn = true;
		record.status = "running";
		record.lastError = null;
		record.updatedAt = now();
		const onAbort = () => { void record.run.interrupt?.(); };
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await record.run.followup(prompt, {
				onPermissionRequest: async (request) => {
					if (record.pendingPermission) throw errorOf("PERMISSION_REQUEST_BUSY", `managed CLI session ${sessionId} already has a pending permission request`);
					const contextual = Object.freeze({ ...request, pluginSessionId: sessionId, childId });
					record.pendingPermission = {
						requestId: contextual.requestId, remoteRequestId: contextual.remoteRequestId,
						turnId: contextual.turnId, itemId: contextual.itemId, capability: contextual.capability,
						operation: contextual.operation, target: contextual.target, reason: contextual.reason,
						createdAt: contextual.createdAt
					};
					record.status = "awaiting_permission";
					record.updatedAt = now();
					try {
						const outcome = await this.approvalRequest(contextual, { agent, signal });
						record.lastPermissionDecision = { requestId: contextual.requestId, turnId: contextual.turnId, capability: contextual.capability, outcome, decidedAt: now() };
						return outcome;
					} finally {
						if (record.pendingPermission?.requestId === contextual.requestId) record.pendingPermission = null;
						if (record.status === "awaiting_permission") record.status = "running";
						record.updatedAt = now();
					}
				}
			});
			record.remoteSessionId = result.threadId ?? record.run.remoteSessionId ?? record.remoteSessionId;
			record.status = "ready";
			record.activeTurn = false;
			record.updatedAt = now();
			return { session: snapshot(record), output: result.text || "", stopReason: result.stopReason ?? "completed" };
		} catch (error) {
			record.pendingPermission = null;
			record.status = signal?.aborted ? "interrupted" : "failed";
			record.activeTurn = false;
			record.lastError = error instanceof Error ? error.message : String(error);
			record.updatedAt = now();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async interrupt(sessionId) {
		const record = this.require(sessionId);
		if (!record.activeTurn || !record.run) return { interrupted: false, session: snapshot(record) };
		const interrupted = await record.run.interrupt?.() === true;
		if (interrupted) {
			record.pendingPermission = null;
			record.status = "interrupted";
			record.updatedAt = now();
		}
		return { interrupted, session: snapshot(record) };
	}

	bindChild(childId, { sessionId = null, cli = "codex", parentAgent = null } = {}) {
		if (typeof childId !== "string" || !childId) throw errorOf("CHILD_ID_REQUIRED", "relay child id is required");
		const existing = this.childBindings.get(childId);
		if (existing) return Object.freeze({ ...existing });
		const binding = { childId, cli, sessionId, parentAgent, epochSubmits: 0, updatedAt: now() };
		this.childBindings.set(childId, binding);
		return Object.freeze({ ...binding });
	}

	beginChildEpoch(childId) {
		const binding = this.requireChild(childId);
		binding.epochSubmits = 0;
		binding.updatedAt = now();
	}

	async submitFromChild(childId, prompt, signal, agent = null) {
		const binding = this.requireChild(childId);
		binding.epochSubmits += 1;
		binding.updatedAt = now();
		if (binding.sessionId === null) {
			const created = await this.dispatch({ cli: binding.cli, cwd: binding.cwd, prompt, signal, agent: binding.parentAgent ?? agent, childId });
			binding.sessionId = created.session.sessionId;
			binding.updatedAt = now();
			return created;
		}
		return this.followup(binding.sessionId, prompt, signal, { agent: binding.parentAgent ?? agent, childId });
	}

	setChildCwd(childId, cwd) {
		const binding = this.requireChild(childId);
		binding.cwd = cwd;
		binding.updatedAt = now();
	}

	childCanReport(childId) { return this.requireChild(childId).epochSubmits > 0; }
	childBinding(childId) {
		const binding = this.requireChild(childId);
		return Object.freeze({ childId: binding.childId, cli: binding.cli, sessionId: binding.sessionId, cwd: binding.cwd, epochSubmits: binding.epochSubmits, updatedAt: binding.updatedAt });
	}

	status(sessionId) { return snapshot(this.require(sessionId)); }
	list({ cli } = {}) {
		return [...this.records.values()]
			.filter((record) => cli === undefined || record.cli === cli)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map(snapshot);
	}

	async close(sessionId) {
		const record = this.require(sessionId);
		await record.run?.dispose?.();
		record.run = null;
		record.activeTurn = false;
		record.pendingPermission = null;
		record.status = "closed";
		record.updatedAt = now();
		return snapshot(record);
	}

	async dispose() {
		await Promise.allSettled([...this.records.values()].map((record) => record.run?.dispose?.()));
		for (const record of this.records.values()) record.run = null;
	}

	require(sessionId) {
		const record = this.records.get(sessionId);
		if (!record) throw errorOf("SESSION_NOT_FOUND", `managed CLI session ${sessionId} was not found`);
		return record;
	}

	requireChild(childId) {
		const binding = this.childBindings.get(childId);
		if (!binding) throw errorOf("CHILD_BINDING_NOT_FOUND", `relay child ${childId} is not bound`);
		return binding;
	}
}
