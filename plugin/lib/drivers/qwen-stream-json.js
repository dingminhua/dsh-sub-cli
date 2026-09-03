// Qwen Code driver. Spawns `qwen -p --input-format stream-json
// --output-format stream-json` once per turn and treats NDJSON events on
// stdout as the protocol.
//
// The same one-process-per-turn model as the Claude driver applies: Qwen has
// no app-server subcommand, so `--print` with stream-json is the headless
// surface. `--resume <id>` reattaches the on-disk history.
//
// Permission model (unified across all three managed CLIs):
//   Qwen's headless -p mode composes its toolset from settings.json's
//   `tools.approvalMode` (written by qwenSettings in verify.js). Previously
//   the tier was read-only/workspace-write/danger — and lower tiers registered
//   no tools at all, so a low-privileged turn could not even attempt
//   `write_file`. Now the CLI always runs at `tools.approvalMode: "yolo"`
//   so it registers every tool, and the driver intercepts each `tool_use`
//   in the stream-json output and routes it through the same
//   `onPermissionRequest` hook that Codex's app-server uses. resolvePermission
//   in managed-cli-agents.js answers each request deterministically against
//   the user's stored capability checkboxes (the approval mode was removed
//   2026-09: no dialog — unchecked capabilities are rejected and recorded).

import { randomUUID } from "node:crypto";
import { defineDriverCapabilities } from "./types.js";
import { SubprocessLineTransport } from "./subprocess-transport.js";
import { probeStalledTurn } from "./turn-timeout.js";
import { binPath } from "../paths.js";
import { winShimArgv } from "../dispatch.js";
import { resolveTurnTimeoutMs } from "../turn-timeout-policy.js";
import { normalizePermissionRequest, QWEN_APPROVAL_METHODS } from "../permissions.js";

export const QWEN_STREAM_JSON_CAPABILITIES = defineDriverCapabilities({
	streaming: true,
	continuable: true,
	durableResume: true,
	modelOverride: true,
	reasoningEffort: false,
	cwd: true,
	interrupt: false,
	interactivePermissions: true
});

// Qwen's tool name → capability key. The actual set of tool names emitted by
// Qwen under -p mode mirrors Claude's surface; the same mapping applies.
function qwenToolCapability(toolName) {
	if (!toolName) return null;
	if (toolName === "Bash" || toolName === "NpmcliLifecyclePlugin") return "command";
	if (toolName === "Write" || toolName === "MultiWrite" || toolName === "Edit" || toolName === "Delete") return "file-change";
	if (toolName === "WebSearch" || toolName === "WebFetcher") return "exec";
	return null; // read tool
}

// Extract final text from Qwen's result object. Qwen has no streaming events
// (no assistant/user/...), so we look for the result field on the result event.
function extractFinalText(events) {
	// Qwen emits only a single "result" event. Try the typed field first.
	const result = events.find((ev) => ev?.type === "result");
	if (typeof result?.result === "string") return result.result;
	// Fallback: serialize the raw result event (covers content/output fields too).
	if (result) {
		const flat = JSON.stringify(result).replace(/[{}"]/g, " ").replace(/\s+/g, " ").trim();
		return flat.slice(0, 500);
	}
	return "";
}

// Qwen's single-line result has no separate tool_use tracking; surface whatever
// the result event reports. Returns 0 when no counter is present.
function countToolUses(events) {
	const result = events.find((ev) => ev?.type === "result");
	const n = result?.num_turns ?? result?.toolRounds ?? 0;
	return Number.isInteger(n) ? n : 0;
}

function buildQwenPermissionRequest({ toolName, toolInput, callId, pluginSessionId, childId, remoteSessionId, turnId }) {
	return normalizePermissionRequest("qwen", toolName, {
		toolInput: toolInput ?? null,
		approvalId: callId ?? null,
		itemId: callId ?? null
	}, {
		childId: childId ?? null,
		pluginSessionId: pluginSessionId ?? null,
		remoteSessionId: remoteSessionId ?? null,
		turnId: turnId ?? null
	});
}

/**
 * Run one Qwen turn to completion. The returned promise resolves when
 * the CLI emits a `result` event or the process closes. Caller owns subprocess
 * disposal.
 *
 * Tool interception: every `assistant` event's `tool_use` block is
 * inspected. Read-only tools pass through silently; write/exec tools
 * trigger `onPermissionRequest(toolName, toolInput, callId)`. The hook
 * returns a `managed-permission-decision` (allowed-once / rejected /
 * cancelled) and the driver thread-sleeps until the result arrives. A
 * "rejected" outcome aborts the turn with an error so the upstream caller
 * can react.
 */
function runTurn({ transport, timeoutMs, onPermissionRequest, signal }) {
	return new Promise((resolve, reject) => {
		const events = [];
		const decisions = [];
		let settled = false;
		let timer;
		const finish = (ok, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			offLine();
			offClose?.();
			ok ? resolve(value) : reject(value);
		};
		const offLine = transport.onLine((line) => {
			if (settled) return;
			const trimmed = line.trim();
			if (!trimmed) return;
			let ev;
			try { ev = JSON.parse(trimmed); } catch { return; }
			events.push(ev);
			// Tool interception. Qwen's NDJSON includes assistant events with
			// tool_use blocks mirroring Claude's wire format.
			if (ev?.type === "assistant" && Array.isArray(ev?.message?.content)) {
				for (const block of ev.message.content) {
					if (block?.type !== "tool_use") continue;
					const toolName = block.name;
					const toolInput = block.input;
					const callId = block.id || null;
					if (!qwenToolCapability(toolName)) continue;
					if (typeof onPermissionRequest !== "function") {
						decisions.push({ callId, toolName, capability: qwenToolCapability(toolName), outcome: "rejected", reason: "no permission hook" });
						finish(false, new Error(`Qwen Code 请求执行 ${toolName} 但 driver 未提供权限钩子；拒绝以保护工作目录。`));
						return;
					}
					// Synchronous listener: hand the async decision off via
					// Promise.resolve().then() so the line parser can return
					// and continue buffering. The decision handler calls
					// finish() if the outcome is a reject/cancel.
					Promise.resolve()
						.then(() => onPermissionRequest({ toolName, toolInput, callId }))
						.then((outcome) => {
							if (settled) return;
							decisions.push({ callId, toolName, capability: qwenToolCapability(toolName), outcome });
							if (outcome === "rejected" || outcome === "cancelled" || outcome === "unavailable") {
								finish(false, new Error(`用户${outcome === "cancelled" ? "取消" : "拒绝"}了 Qwen Code 的 ${toolName} 操作（callId=${callId}）。`));
							}
						})
						.catch((error) => {
							if (!settled) finish(false, error instanceof Error ? error : new Error(String(error)));
						});
				}
			}
			// Qwen emits exactly one JSON object on stdout (single-line output mode,
			// not NDJSON). It is always the result; there is no init/assistant event.
			if (ev?.type === "result" || ev?.subtype === "error_during_execution") {
				const isError = ev.is_error === true || ev?.subtype === "error_during_execution";
				if (isError) {
					const message = ev?.error?.message || ev?.result || "Qwen turn failed";
					finish(false, new Error(message));
				} else {
					finish(true, { events, result: ev, decisions });
				}
			}
		});
		const offClose = transport.onClose?.((error) => {
			if (settled) return;
			finish(false, error ?? new Error("Qwen process closed without a result event"));
		});
		// Hitting the deadline is not an automatic failure. Probe the child: an
		// exited process is left to the close handler (which carries the real
		// result), and a turn that is still emitting output gets more time. Only a
		// genuinely silent turn is rejected.
		timer = setTimeout(() => {
			if (settled) return;
			const startedAt = Date.now() - timeoutMs;
			probeStalledTurn({ transport, elapsedMs: timeoutMs })
				.then((probe) => {
					if (settled) return;
					if (probe.stalled) {
						finish(false, new Error(`Qwen turn stalled after ${timeoutMs}ms: ${probe.reason}`));
						return;
					}
					// Grant more time and keep listening.
					timer = setTimeout(() => {
						finish(false, new Error(
							`Qwen turn timed out after ${formatElapsed(startedAt)}ms (granted extra time: ${probe.reason})`
						));
					}, probe.extendMs ?? 0);
					timer.unref?.();
				})
				.catch((error) => {
					if (!settled) finish(false, error);
				});
		}, timeoutMs);
		timer.unref?.();
	});
}

function formatElapsed(startedAt) {
	return String(Math.max(0, Date.now() - startedAt));
}

export class QwenStreamJsonDriver {
	constructor({ subprocess, dirSource, prepare, turnTimeoutMs } = {}) {
		if (!subprocess || typeof subprocess.spawn !== "function") throw new TypeError("Qwen stream-json driver requires subprocess.spawn");
		if (typeof dirSource !== "function") throw new TypeError("Qwen stream-json driver requires dirSource()");
		this.id = "qwen-stream-json";
		this.capabilities = QWEN_STREAM_JSON_CAPABILITIES;
		this.subprocess = subprocess;
		this.dirSource = dirSource;
		this.prepare = typeof prepare === "function" ? prepare : null;
		// Sanitize like Claude does: null/0/NaN/negative must fall back to the
		// default instead of arming an immediate timeout.
		this.turnTimeoutMs = resolveTurnTimeoutMs(turnTimeoutMs);
	}

	async start(request) {
		// Reattach path (managed-cli-agents.js reattach() after release()):
		// the request carries attachOnly + resumeThreadId and NO prompt — the
		// prompt arrives with the next followup(). Under the one-process-per-
		// turn model attaching spawns nothing now; we only prepare the context
		// (resolve binary, write provider config) and return a run whose
		// followup() spawns `qwen -p --resume <threadId>`. Mirrors Codex's
		// attachOnly branch in codex-app-server.js.
		const attachOnly = request?.attachOnly === true;
		const ctx = await this.#prepareContext(request, { mode: attachOnly ? "attach" : "new" });
		if (attachOnly) {
			return {
				id: randomUUID(),
				product: "qwen",
				capabilities: this.capabilities,
				get remoteSessionId() { return request.resumeThreadId; },
				result: Promise.resolve({ threadId: request.resumeThreadId, text: "", stopReason: "attached" }),
				followup: (prompt, options) => this.#followup(request, ctx, prompt, options),
				interrupt: async () => false,
				status: () => ({ state: "ready", sessionId: request.resumeThreadId, driverId: this.id }),
				dispose: async () => {}
			};
		}
		const result = this.#spawnTurn(ctx, request, { mode: "new", prompt: request.prompt });
		const runRef = { sessionId: ctx.sessionId };
		result.then(
			(value) => { runRef.sessionId = value.threadId; },
			() => {}
		);
		return {
			id: randomUUID(),
			product: "qwen",
			capabilities: this.capabilities,
			get remoteSessionId() { return runRef.sessionId; },
			result,
			followup: (prompt, options) => this.#followup(request, ctx, prompt, options),
			interrupt: async () => false,
			status: () => ({ state: "completed", sessionId: runRef.sessionId, driverId: this.id }),
			dispose: async () => { try { await result; } catch {} }
		};
	}

	async #followup(originalRequest, ctx, prompt, options) {
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Qwen followup prompt must not be empty");
		const signal = options?.signal ?? originalRequest.signal;
		if (signal?.aborted) throw new Error("Qwen followup aborted before start");
		const resumeId = options?.resumeSessionId || ctx.actualSessionId || ctx.sessionId;
		return this.#spawnTurn(ctx, originalRequest, { mode: "resume", prompt, resumeId, options, signal });
	}

	async #prepareContext(request, { mode }) {
		if (!request || typeof request !== "object") throw new TypeError("Qwen driver request must be an object");
		if (typeof request.cwd !== "string" || !request.cwd) throw new Error("Qwen driver request.cwd is required");
		if (mode === "attach") {
			// Reattach requests carry no prompt (the next followup supplies
			// it); what they MUST carry is the remote thread to resume.
			if (typeof request.resumeThreadId !== "string" || !request.resumeThreadId) throw new Error("Qwen driver attach requires resumeThreadId");
		} else if (typeof request.prompt !== "string" || !request.prompt.trim()) {
			throw new Error("Qwen driver request.prompt must not be empty");
		}
		const dir = this.dirSource();
		const bin = binPath(dir, "qwen");
		let resolved = null;
		try {
			resolved = this.subprocess.resolveExecutable(bin, undefined, request.signal);
		} catch {}
		if (resolved && typeof resolved.then === "function") {
			resolved = await resolved.catch(() => null);
		}
		if (!resolved) throw new Error(`找不到 qwen，请先安装到统一目录 ${dir}/bin。`);
		let env;
		if (this.prepare) {
			// 本轮档位（含 A/B 门授权的临时提升）随请求穿透到 prepare——
			// qwen 的执法点就是这份配置（approvalMode），授权档位必须在
			// spawn 前写进去，否则语义门会按持久化档位把它改写回去。
			const ready = await this.prepare("qwen", dir, { permissionProfile: request.permissionProfile ?? null });
			if (!ready?.ok) throw new Error(ready?.reason || "Qwen 配置未就绪，拒绝启动。");
			env = ready.env;
		}
		const sessionId = request.sessionId || randomUUID();
		// In attach mode the "actual" session is the remote thread we reattach
		// to; followup() resolves its --resume id from ctx.actualSessionId
		// first, so the post-attach turn resumes the right thread.
		const actualSessionId = mode === "attach" ? request.resumeThreadId : null;
		return { bin: resolved, env, dir, sessionId, actualSessionId };
	}

	#spawnTurn(ctx, request, { mode, prompt, resumeId, options, signal = null }) {
		// Qwen's real protocol (verified against `qwen --help` on 2026-09-01):
		//   - --output-format stream-json : one JSON object per turn on stdout
		//   - --prompt (no value)         : enable stdin-prompt mode (Qwen reads
		//                                   from stdin until EOF). Required for
		//                                   BOTH new and resume turns; without it
		//                                   Qwen prints "No input provided via stdin".
		//   - --session-id <uuid>         : seed a new session id
		//   - --resume <id>               : reattach the on-disk session history
		//   - --model <name>              : model id (from settings.json providers)
		// No --input-format, no --effort, no --permission-mode, no --cwd.
		// tools.approvalMode is fixed to "yolo" in qwenSettings (verify.js); the
		// driver enforces per-tool permissions.
		const args = [
			"-p",
			"--output-format", "stream-json"
		];
		if (typeof prompt === "string" && prompt) args.push("--prompt");
		if (request.model) args.push("--model", request.model);
		if (request.reasoningEffort) console.warn(`[dsh-sub-cli] qwen driver: ignoring reasoningEffort=${request.reasoningEffort}; Qwen has no --effort flag`);
		if (mode === "resume" && resumeId) args.push("--resume", resumeId);
		else if (mode === "new") args.push("--session-id", ctx.sessionId);
		const argv = winShimArgv(ctx.bin, args);
		const handle = this.subprocess.spawn({
			argv,
			cwd: request.cwd,
			env: ctx.env ?? request.env,
			signal,
			stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
			graceMs: request.timeoutMs ?? this.turnTimeoutMs
		});
		const transport = new SubprocessLineTransport(handle);
		const onPermissionRequest = typeof request.onPermissionRequest === "function"
			? request.onPermissionRequest
			: (options && typeof options.onPermissionRequest === "function" ? options.onPermissionRequest : null);
		return (async () => {
			try {
				if (typeof prompt === "string" && prompt) {
					await transport.write(prompt + "\n");
					transport.closeStdin?.();
				}
				const { events, result, decisions } = await runTurn({
					transport,
					timeoutMs: request.timeoutMs ?? this.turnTimeoutMs,
					onPermissionRequest: onPermissionRequest
						? (tool) => onPermissionRequest(buildQwenPermissionRequest({
							toolName: tool.toolName,
							toolInput: tool.toolInput,
							callId: tool.callId
						}))
						: null,
					signal
				});
				const resolvedSessionId = result?.session_id || resumeId || ctx.sessionId;
				ctx.actualSessionId = resolvedSessionId;
				return {
					threadId: resolvedSessionId,
					text: extractFinalText(events),
					toolRounds: countToolUses(events),
					stopReason: result?.stop_reason || "completed",
					usage: result?.usage || null,
					decisions
				};
			} finally {
				await transport.dispose().catch(() => {});
			}
		})();
	}
}
