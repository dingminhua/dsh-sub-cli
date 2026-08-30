// Host-plane managed external CLI session service. It owns product thread
// identity and exposes a programmatic seam shared by tools and future DAG/team
// integrations. Initial implementation is in-memory; records contain no keys.

import { randomUUID } from "node:crypto";
import { normalizePermission, deriveSandboxMode, allowsCapability } from "./permissions.js";
import { DEFAULT_PERMISSION } from "./registry.js";

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
		const profile = normalizePermission(this.permissionSource(cli) || DEFAULT_PERMISSION);
		const mode = deriveSandboxMode(profile);
		// `never` asks Codex to deny out-of-scope operations without emitting a
		// request; every other mode keeps on-request so the capability gate and
		// approval seam below can decide each request.
		const approvalPolicy = profile.approval === "never" ? "never" : "on-request";
		return { permissionMode: mode, approvalPolicy, sandbox: mode, profile };
	}

	// Single permission path shared by dispatch, followup and reattach: enforce
	// the capability gate first, then either auto-decide (allow/never) or ask
	// the bound approval seam, and record the decision.
	async resolvePermission(record, request, { agent = null, childId = null, signal = null } = {}) {
		const sessionId = record.sessionId;
		const profile = normalizePermission(this.permissionSource(record.cli) || DEFAULT_PERMISSION);
		const allowed = allowsCapability(profile, request.capability);
		const decidedAt = now();
		// Capability gate: the profile does not grant this capability at all →
		// reject without surfacing an approval prompt.
		if (!allowed) {
			record.lastPermissionDecision = { requestId: request.requestId, turnId: request.turnId, capability: request.capability, outcome: "rejected", decidedAt };
			record.updatedAt = now();
			return "rejected";
		}
		// approval=allow: the capability is granted and the profile auto-accepts.
		if (profile.approval === "allow") {
			record.lastPermissionDecision = { requestId: request.requestId, turnId: request.turnId, capability: request.capability, outcome: "allowed-once", decidedAt };
			record.updatedAt = now();
			return "allowed-once";
		}
		// approval=never: granted but never interactively confirmed → reject.
		if (profile.approval === "never") {
			record.lastPermissionDecision = { requestId: request.requestId, turnId: request.turnId, capability: request.capability, outcome: "rejected", decidedAt };
			record.updatedAt = now();
			return "rejected";
		}
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
				onPermissionRequest: (request) => this.resolvePermission(record, request, { agent, childId, signal })
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
		if (typeof prompt !== "string" || !prompt.trim()) throw errorOf("SESSION_PROMPT_REQUIRED", "follow-up prompt must not be empty");
		// A released session keeps its remote thread id; reattach before turning.
		if (!record.run || typeof record.run.followup !== "function") await this.reattach(record, { agent, childId, signal });
		record.activeTurn = true;
		record.status = "running";
		record.lastError = null;
		record.updatedAt = now();
		const onAbort = () => { void record.run.interrupt?.(); };
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await record.run.followup(prompt, {
				onPermissionRequest: (request) => this.resolvePermission(record, request, { agent, childId, signal })
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

	// Reopen a released session: a fresh app-server process reattaches the same
	// remote Codex thread. Used so idle sessions do not hold a live subprocess.
	async reattach(record, { agent = null, childId = null, signal = null } = {}) {
		if (!record.remoteSessionId) throw errorOf("SESSION_NOT_LIVE", `managed CLI session ${record.sessionId} has no remote thread to reattach`);
		if (record.activeTurn) throw errorOf("SESSION_BUSY", `managed CLI session ${record.sessionId} already has an active turn`);
		record.status = "starting";
		record.updatedAt = now();
		record.run = await this.drivers.codex.start({
			cwd: record.cwd,
			attachOnly: true,
			resumeThreadId: record.remoteSessionId,
			model: record.model || undefined,
			reasoningEffort: record.reasoningEffort || undefined,
			approvalPolicy: this.permissionSpec(record.cli).approvalPolicy,
			sandbox: record.permissionMode,
			signal,
			onPermissionRequest: (request) => this.resolvePermission(record, request, { agent, childId, signal })
		});
		record.status = "ready";
		record.updatedAt = now();
		return record.run;
	}

	// Drop the live subprocess but keep the session record and remote thread id,
	// so a later turn can reattach. Never touches a session with an active turn.
	async release(sessionId) {
		const record = this.require(sessionId);
		if (record.activeTurn || !record.run) return { released: false, session: snapshot(record) };
		await record.run.dispose?.().catch(() => {});
		record.run = null;
		record.pendingPermission = null;
		record.updatedAt = now();
		return { released: true, session: snapshot(record) };
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

	// Called when a Relay child's residency epoch ends: free the app-server
	// subprocess while keeping the bound thread id for the next send_message.
	async releaseChild(childId) {
		let binding;
		try { binding = this.requireChild(childId); } catch { return { released: false }; }
		if (!binding.sessionId) return { released: false };
		try { return await this.release(binding.sessionId); } catch { return { released: false }; }
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
