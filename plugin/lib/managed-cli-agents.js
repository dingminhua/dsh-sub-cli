// Host-plane managed external CLI session service. It owns product thread
// identity and exposes a programmatic seam shared by tools and future DAG/team
// integrations. Initial implementation is in-memory; records contain no keys.

import { randomUUID } from "node:crypto";
import { normalizePermission, deriveSandboxMode, allowsCapability } from "./permissions.js";
import { DEFAULT_PERMISSION } from "./registry.js";
import { assertManagedCliDriver } from "./drivers/types.js";

const TERMINAL = new Set(["closed"]);

// Auto-continue: some supplier-paired models end a turn early on long
// tool-driven tasks — the turn completes with a "I will now do X" commitment
// instead of the final result. The driver faithfully waits for turn/completed;
// to still return a complete answer from a single cli_*_direct call we
// nudge the same thread (bounded). This is model/supplier-agnostic: any model
// that stops after a plan sentence benefits, including ones whose provider
// config the user changes later.
export const AUTO_CONTINUE_MAX = 3;
export const AUTO_CONTINUE_PROMPT = "请继续完成你的任务，把最终结果完整输出给我。不要只描述计划或过程。";

// An "intent tail": the last sentence still commits to future work (will do /
// about to / now I) instead of delivering the result. We look at the final
// sentence, because these models often stop right after stating a plan.
//
// Both Chinese and English tails are recognised so the same auto-continue loop
// works for Codex (often Chinese), Claude (English), and Qwen (mixed) without
// per-CLI branches. Each keyword matches when it opens a sentence-ending tail,
// so we keep the regex strict (anchored to the tail) and broad (multiple
// alternates) to balance false positives against missed premature stops.
const INTENT_HEAD_CN = "(?:我会|我将|我先|让我|现在|接下来|然后|继续|准备|马上|即将|随后|正在|打算|稍后|先)";
const INTENT_HEAD_EN = "(?:I'll|I will|I'm going to|Let me|Now (?:I|'ll)|Next,? (?:I|'ll)|Then (?:I|'ll)|Continuing|About to|Going to|I'm (?:going|about)|I plan to|I intend to|First,? (?:I|'ll))";
const INTENT_TAIL = new RegExp(`(?:${INTENT_HEAD_CN}|${INTENT_HEAD_EN})(?:[^。！？!?\\.\\n]{0,120})[。！？!?\\.]?$`);

/**
 * Decide whether a finished turn looks like a premature stop that deserves an
 * auto-continue nudge. A premature stop typically ends with an "I will do X /
 * now I'll do X" commitment instead of the deliverable — no tool work required
 * (the model may stop right after stating its plan). Pure.
 */
export function looksPrematureOutput(text, toolRounds) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return true; // empty result → nudge
	// Split on the last terminal punctuation to isolate the final sentence.
	// Mixed-language output may end with . ? ! or fullwidth equivalents; the
	// split below keeps the trailing punctuation with the last sentence so the
	// regex can match it as the boundary.
	const sentences = trimmed.split(/(?<=[。！？!?\.])\s*/u).map((s) => s.trim()).filter(Boolean);
	const last = sentences[sentences.length - 1] || trimmed;
	return INTENT_TAIL.test(last);
}

function now() { return new Date().toISOString(); }
function errorOf(code, message) { const error = new Error(message); error.code = code; return error; }

/** Durable view of a session record: never serializes live run/pending state. */
export function persistable(record) {
	return Object.freeze({
		sessionId: record.sessionId,
		cli: record.cli,
		cwd: record.cwd,
		provider: record.provider || "",
		model: record.model || "",
		reasoningEffort: record.reasoningEffort || "",
		permissionMode: record.permissionMode,
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		lastError: record.lastError ?? null,
		remoteSessionId: record.remoteSessionId ?? null
	});
}

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
		lastPermissionDecision: record.lastPermissionDecision ? Object.freeze({ ...record.lastPermissionDecision }) : null
	});
}

export class ManagedCliAgentsService {
	/**
	 * @param {{ drivers: Record<string, object>, routeSource, permissionSource, persist?, autoContinueSource?, _skipAssert? }} options
	 *   drivers maps CLI id → driver instance (codex, claude, qwen …). At least one
	 *   driver must be present; the constructor validates the map shape.
	 *   Set `_skipAssert = true` in unit tests that use minimal driver fakes;
	 *   production always asserts the full contract.
	 */
	constructor({ drivers, routeSource, permissionSource, persist = null, autoContinueSource = null, _skipAssert = false }) {
		if (!drivers || typeof drivers !== "object") throw new TypeError("managedCliAgents requires a drivers map");
		const ids = Object.keys(drivers);
		if (!ids.length) throw new TypeError("managedCliAgents requires at least one driver");
		// Validate that every entry satisfies the driver contract (skip only in tests
		// that use intentionally minimal fakes and test service logic, not driver contracts).
		if (!_skipAssert) {
			for (const id of ids) {
				try { assertManagedCliDriver(drivers[id]); } catch (e) {
					throw new TypeError(`driver "${id}" does not satisfy the managed CLI contract: ${e.message}`);
				}
			}
		}
		this.drivers = Object.freeze({ ...drivers });
		this.driverIds = Object.freeze([...ids]);
		this.routeSource = typeof routeSource === "function" ? routeSource : () => ({});
		this.permissionSource = typeof permissionSource === "function" ? permissionSource : () => "read-only";
		// Optional durable persistence seam: { load(): Promise<SavedSession[]>, save(sessions): Promise<void> }.
		// When absent the service stays in-memory. Records never contain keys.
		this.persist = persist && typeof persist.load === "function" && typeof persist.save === "function" ? persist : null;
		// Optional per-CLI auto-continue config: (cliId) => { enabled?: boolean, max?: number }.
		this.autoContinueSource = typeof autoContinueSource === "function" ? autoContinueSource : null;
		this.records = new Map();
		this.childBindings = new Map();
		// 权限决策留痕：每次 resolvePermission 的决定（放行与拒绝都记）追加到这
		// 个有界环，设置卡经 remote 方法读取展示，让「发生过什么」可审计。
		this.recentDecisions = [];
	}

	/** Recent permission decisions (newest last), as a frozen copy. */
	recentPermissionDecisions(limit = 20) {
		const n = Math.max(0, Math.min(limit, this.recentDecisions.length));
		return Object.freeze(this.recentDecisions.slice(-n).map((d) => Object.freeze({ ...d })));
	}

	#recordDecision(record, request, outcome, decidedAt) {
		record.lastPermissionDecision = { requestId: request.requestId, turnId: request.turnId, capability: request.capability, outcome, decidedAt };
		record.updatedAt = now();
		this.recentDecisions.push(Object.freeze({
			cli: record.cli,
			sessionId: record.sessionId,
			capability: request.capability,
			operation: request.operation ?? null,
			target: request.target ?? null,
			outcome,
			decidedAt
		}));
		if (this.recentDecisions.length > 50) this.recentDecisions.splice(0, this.recentDecisions.length - 50);
	}

	/** Restore durable session records from the persistence seam (idempotent). */
	async restore() {
		if (!this.persist) return { restored: 0 };
		let saved;
		try {
			saved = await this.persist.load();
		} catch {
			return { restored: 0, error: "sessions load failed" };
		}
		let restored = 0;
		for (const rec of Array.isArray(saved) ? saved : []) {
			if (!rec || typeof rec.sessionId !== "string" || !rec.remoteSessionId) continue;
			if (this.records.has(rec.sessionId)) continue;
			// Drop records whose CLI is no longer registered; persisting a stale
			// cli id (e.g. an old "claude" record after a driver was removed)
			// would force every restore path to special-case unknown ids.
			if (typeof rec.cli !== "string" || !this.drivers[rec.cli]) continue;
			if (rec.status === "closed") continue; // closed 是终态，不恢复
			// 只恢复能 reattach 的非终态会话：run 置空，followup 时走 reattach。
			const record = {
				sessionId: rec.sessionId,
				cli: rec.cli,
				cwd: rec.cwd,
				provider: rec.provider || "",
				model: rec.model || "",
				reasoningEffort: rec.reasoningEffort || "",
				permissionMode: rec.permissionMode,
				status: "ready",
				activeTurn: false,
				createdAt: rec.createdAt,
				updatedAt: rec.updatedAt,
				lastError: rec.lastError ?? null,
				run: null,
				remoteSessionId: rec.remoteSessionId,
				lastPermissionDecision: null
			};
			this.records.set(record.sessionId, record);
			restored++;
		}
		return { restored };
	}

	/** Persist all session records through the seam; failures never throw. */
	async persistNow() {
		if (!this.persist) return;
		const saved = [...this.records.values()].map(persistable);
		try {
			await this.persist.save(saved);
		} catch {
			// 持久化失败不阻断主流程；下次状态变更会再次尝试。
		}
	}

	permissionSpec(cli, override = null) {
		const profile = normalizePermission(override ?? this.permissionSource(cli) ?? DEFAULT_PERMISSION);
		const mode = deriveSandboxMode(profile);
		// The approval mode was removed (2026-09): the capability checkboxes are
		// the only grant and are fixed at launch. "on-request" keeps every
		// out-of-scope request flowing to resolvePermission below, which answers
		// deterministically by checkbox — allow checked, decline unchecked — and
		// records the decision for the audit trail.
		return { permissionMode: mode, approvalPolicy: "on-request", sandbox: mode, profile };
	}

	// Single deterministic permission resolver shared by dispatch, followup and
	// reattach: a checked capability is allowed silently; an unchecked one is
	// rejected and recorded. No interactive ask, no escalation — the CLI
	// receives the rejection and adapts or reports the task as not completable.
	//
	// Auto-continue nudge loop: when a finished turn looks like a premature stop
	// (tool work happened but the text ends with a continuation commitment), push
	// the same thread a bounded number of times so a single dispatch returns a
	// complete answer. Each nudge is a real followup turn on the same thread.
	// Per-CLI config (autoContinueSource) can disable it (enabled:false) or tune
	// the bound (max). Disabled → return the raw result unchanged.
	async settleWithAutoContinue(record, result, { agent = null, childId = null, signal = null } = {}) {
		let text = result.text || "";
		let toolRounds = Number.isInteger(result.toolRounds) ? result.toolRounds : 0;
		let last = result;
		const raw = { text, stopReason: result.stopReason ?? "completed", threadId: result.threadId ?? record.run?.remoteSessionId ?? null };
		const cfg = this.autoContinueSource ? (this.autoContinueSource(record.cli) ?? {}) : {};
		if (cfg.enabled === false) return raw;
		// The checkbox is gone: "off" is expressed as max 0. A usable max is any
		// integer 0–10; anything else falls back to the default (3).
		const max = Number.isInteger(cfg.max) && cfg.max >= 0 ? cfg.max : AUTO_CONTINUE_MAX;
		if (max === 0) return raw;
		// When nudging, remember the newest block so we can drop progress-fragment
		// noise once a real (long) answer finally lands.
		let added = "";
		for (let i = 0; i < max; i++) {
			if (!looksPrematureOutput(text, toolRounds)) break;
			record.updatedAt = now();
			last = await record.run.followup(AUTO_CONTINUE_PROMPT, {
				onPermissionRequest: (request) => this.resolvePermission(record, request)
			});
			added = (last.text || "").trim();
			if (!added) break; // nothing new — stop to avoid a useless loop
			text = `${text}\n\n${added}`.trim();
			toolRounds = Number.isInteger(last.toolRounds) ? last.toolRounds : 0;
		}
		// The loop ended because a nudge produced a non-premature answer: prefer
		// that final block when it is a substantial deliverable; keep the whole
		// concatenation otherwise (avoids discarding a report behind a tiny
		// closing line like "以上就是全部内容。").
		const cleaning = added.length > 0 && !looksPrematureOutput(text, toolRounds);
		return {
			text: cleaning && added.length >= 100 ? added : text,
			stopReason: last?.stopReason ?? "completed",
			threadId: last?.threadId ?? record.run?.remoteSessionId ?? null
		};
	}

	async resolvePermission(record, request) {
		const profile = normalizePermission(this.permissionSource(record.cli) || DEFAULT_PERMISSION);
		const decidedAt = now();
		// Decision model (approval mode removed 2026-09): the checkboxes are the
		// only grant. A checked capability is allowed silently; an unchecked one
		// is rejected and recorded — the CLI receives the rejection and adapts
		// or reports the task as not completable.
		if (allowsCapability(profile, request.capability)) {
			this.#recordDecision(record, request, "allowed-once", decidedAt);
			return "allowed-once";
		}
		this.#recordDecision(record, request, "rejected", decidedAt);
		return "rejected";
	}

	async dispatch({ cli = "codex", cwd, prompt, signal, agent = null, childId = null }) {
		const driver = this.drivers[cli];
		if (!driver) throw errorOf("CLI_UNSUPPORTED", `managed CLI "${cli}" is not registered. Available: ${this.driverIds.join(", ")}`);
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
			lastError: null, run: null, remoteSessionId: null, lastPermissionDecision: null
		};
		this.records.set(sessionId, record);
		try {
			record.run = await driver.start({
				cwd, prompt, model: record.model || undefined, reasoningEffort: record.reasoningEffort || undefined,
				approvalPolicy: permission.approvalPolicy, sandbox: permission.sandbox,
				// 本轮生效档位：穿透到 prepare，供 qwen 渲染 approvalMode——否则
				// 配置门会按持久化档把授权改写回去。
				permissionProfile: permission.profile,
				signal,
				onPermissionRequest: (request) => this.resolvePermission(record, request)
			});
			record.status = "running";
			record.updatedAt = now();
			const result = await record.run.result;
			// Nudge an early-stopped turn (bounded) so one dispatch returns a
			// complete answer instead of a progress fragment.
			const settled = await this.settleWithAutoContinue(record, result, { agent, childId, signal });
			record.remoteSessionId = settled.threadId ?? record.run.remoteSessionId ?? null;
			record.status = "ready";
			record.activeTurn = false;
			record.updatedAt = now();
			await this.persistNow();
			return { session: snapshot(record), output: settled.text || "", stopReason: settled.stopReason ?? "completed" };
		} catch (error) {
			record.remoteSessionId = record.run?.remoteSessionId ?? record.remoteSessionId;
			// Release the turn's subprocess so a failed dispatch does not leak a
			// live app-server (observed 2026-09-05: the interrupted Codex
			// app-server outlived its failed record and kept a second process
			// company). Keep the record and remote thread id so a later
			// followup reattaches the same thread instead of starting over.
			const failedRun = record.run;
			record.run = null;
			void failedRun?.dispose?.().catch(() => {});
			record.status = signal?.aborted ? "interrupted" : "failed";
			record.activeTurn = false;
			record.lastError = error instanceof Error ? error.message : String(error);
			record.updatedAt = now();
			await this.persistNow();
			throw error;
		}
	}

	async followup(sessionId, prompt, signal, { agent = null, childId = null } = {}) {
		const record = this.require(sessionId);
		if (TERMINAL.has(record.status)) throw errorOf("SESSION_CLOSED", `managed CLI session ${sessionId} is closed`);
		if (record.activeTurn) throw errorOf("SESSION_BUSY", `managed CLI session ${sessionId} already has an active turn`);
		if (typeof prompt !== "string" || !prompt.trim()) throw errorOf("SESSION_PROMPT_REQUIRED", "follow-up prompt must not be empty");
		const turnPermission = this.permissionSpec(record.cli);
		// 档位变化 → 驱动进程必须按新档重启（codex/claude 的档位在启动参数、
		// qwen 在其 settings.json，都不能热改）。设置卡调整权限后，下一轮
		// followup 自动按新档重启进程。
		if (record.run && record.permissionMode !== turnPermission.permissionMode) {
			record.remoteSessionId = record.run.remoteSessionId ?? record.remoteSessionId;
			await record.run.dispose?.().catch(() => {});
			record.run = null;
		}
		// A released session keeps its remote thread id; reattach before turning.
		if (!record.run || typeof record.run.followup !== "function") {
			record.permissionMode = turnPermission.permissionMode;
			await this.reattach(record, { agent, childId, signal, permission: turnPermission });
		}
		record.activeTurn = true;
		record.status = "running";
		record.lastError = null;
		record.updatedAt = now();
		const onAbort = () => { void record.run.interrupt?.(); };
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await record.run.followup(prompt, {
				onPermissionRequest: (request) => this.resolvePermission(record, request)
			});
			const settled = await this.settleWithAutoContinue(record, result, { agent, childId, signal });
			record.remoteSessionId = settled.threadId ?? record.run.remoteSessionId ?? record.remoteSessionId;
			record.status = "ready";
			record.activeTurn = false;
			record.updatedAt = now();
			await this.persistNow();
			return { session: snapshot(record), output: settled.text || "", stopReason: settled.stopReason ?? "completed" };
		} catch (error) {
			record.status = signal?.aborted ? "interrupted" : "failed";
			record.activeTurn = false;
			record.lastError = error instanceof Error ? error.message : String(error);
			record.updatedAt = now();
			await this.persistNow();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	// Reopen a released session: a fresh driver process reattaches the same
	// remote thread. Used so idle sessions do not hold a live subprocess.
	// Subclasses that need a different reattach protocol (e.g. subprocess+--resume)
	// can override this method.
	async reattach(record, { agent = null, childId = null, signal = null, permission = null } = {}) {
		if (!record.remoteSessionId) throw errorOf("SESSION_NOT_LIVE", `managed CLI session ${record.sessionId} has no remote thread to reattach`);
		if (record.activeTurn) throw errorOf("SESSION_BUSY", `managed CLI session ${record.sessionId} already has an active turn`);
		const driver = this.drivers[record.cli];
		if (!driver) throw errorOf("CLI_UNSUPPORTED", `cannot reattach unknown CLI "${record.cli}"`);
		const spec = permission ?? this.permissionSpec(record.cli, null);
		record.status = "starting";
		record.updatedAt = now();
		record.run = await driver.start({
			cwd: record.cwd,
			attachOnly: true,
			resumeThreadId: record.remoteSessionId,
			model: record.model || undefined,
			reasoningEffort: record.reasoningEffort || undefined,
			approvalPolicy: spec.approvalPolicy,
			sandbox: spec.sandbox,
			// 本轮生效档位：穿透到 prepare 供 qwen 渲染。
			permissionProfile: spec.profile,
			signal,
			onPermissionRequest: (request) => this.resolvePermission(record, request)
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
		record.updatedAt = now();
		await this.persistNow();
		return { released: true, session: snapshot(record) };
	}

	async interrupt(sessionId) {
		const record = this.require(sessionId);
		if (!record.activeTurn || !record.run) return { interrupted: false, session: snapshot(record) };
		const interrupted = await record.run.interrupt?.() === true;
		if (interrupted) {
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
	/** Whether this child id belongs to a live Relay binding (used by the global tool guard). */
	isRelayChild(childId) { return typeof childId === "string" && this.childBindings.has(childId); }
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
		record.status = "closed";
		record.updatedAt = now();
		await this.persistNow();
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
