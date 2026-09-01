// Qwen Code driver. Spawns `qwen -p --input-format stream-json
// --output-format stream-json` once per turn and treats NDJSON events on
// stdout as the protocol.
//
// The same one-process-per-turn model as the Claude driver applies: Qwen has
// no app-server subcommand, so `--print` with stream-json is the headless
// surface. `--resume <id>` reattaches the on-disk history.
//
// Permission model:
//   Qwen maps permission tiers to CLI flags:
//     read-only        → no extra flag (default; tools that mutate fail)
//     workspace-write  → --sandbox write  (if supported; falls back silently)
//     danger-full     → --no-sandbox (if supported)
//
//   Qwen's stream-json mode does not surface interactive permission requests
//   in the same way as Codex's app-server. The caller chooses the tier
//   before spawning.

import { randomUUID } from "node:crypto";
import { defineDriverCapabilities } from "./types.js";
import { SubprocessLineTransport } from "./subprocess-transport.js";
import { probeStalledTurn } from "./turn-timeout.js";
import { binPath } from "../paths.js";
import { winShimArgv } from "../dispatch.js";
import { DEFAULT_TURN_TIMEOUT_MS } from "../turn-timeout-policy.js";

export const QWEN_STREAM_JSON_CAPABILITIES = defineDriverCapabilities({
	streaming: true,
	continuable: true,
	durableResume: true,
	modelOverride: true,
	reasoningEffort: false,
	cwd: true,
	interrupt: false,
	interactivePermissions: false
});

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

/**
 * Run one Qwen turn to completion. The returned promise resolves when the
 * CLI emits a `result` event or the process closes. Caller owns subprocess
 * disposal.
 */
function runTurn({ transport, timeoutMs }) {
	// Qwen has no --input-format, so the prompt is passed via --prompt on the
	// command line (in #spawnTurn). Here we just read the single JSON result line.
	return new Promise((resolve, reject) => {
		const events = [];
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
			// Qwen emits exactly one JSON object on stdout (single-line output mode,
			// not NDJSON). It is always the result; there is no init/assistant event.
			if (ev?.type === "result" || ev?.subtype === "error_during_execution") {
				const isError = ev.is_error === true || ev.subtype === "error_during_execution";
				if (isError) {
					const message = ev?.error?.message || ev?.result || "Qwen turn failed";
					finish(false, new Error(message));
				} else {
					finish(true, { events, result: ev });
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
	constructor({ subprocess, dirSource, prepare, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS } = {}) {
		if (!subprocess || typeof subprocess.spawn !== "function") throw new TypeError("Qwen stream-json driver requires subprocess.spawn");
		if (typeof dirSource !== "function") throw new TypeError("Qwen stream-json driver requires dirSource()");
		this.id = "qwen-stream-json";
		this.capabilities = QWEN_STREAM_JSON_CAPABILITIES;
		this.subprocess = subprocess;
		this.dirSource = dirSource;
		this.prepare = typeof prepare === "function" ? prepare : null;
		this.turnTimeoutMs = turnTimeoutMs;
	}

	async start(request) {
		const ctx = await this.#prepareContext(request, { mode: "new" });
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
		return this.#spawnTurn(ctx, originalRequest, { mode: "resume", prompt, resumeSessionId: resumeId, signal });
	}

	async #prepareContext(request, { mode }) {
		if (!request || typeof request !== "object") throw new TypeError("Qwen driver request must be an object");
		if (typeof request.cwd !== "string" || !request.cwd) throw new Error("Qwen driver request.cwd is required");
		if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("Qwen driver request.prompt must not be empty");
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
			const ready = await this.prepare("qwen", dir);
			if (!ready?.ok) throw new Error(ready?.reason || "Qwen 配置未就绪，拒绝启动。");
			env = ready.env;
		}
		const sessionId = request.sessionId || randomUUID();
		return { bin: resolved, env, dir, sessionId, actualSessionId: null };
	}

	#spawnTurn(ctx, request, { mode, prompt, resumeSessionId = null, signal = null }) {
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
		const args = [
			"-p",
			"--output-format", "stream-json"
		];
		// --prompt is required for BOTH new and resume turns; the prompt text
		// is read from stdin (see the write+closeStdin block below).
		if (typeof prompt === "string" && prompt) args.push("--prompt");
		if (request.model) args.push("--model", request.model);
		// Qwen has no --effort flag (verified against `qwen --help`); if the user
		// configured a reasoning effort we silently skip it instead of letting the
		// CLI reject the whole invocation with "Unknown argument: effort".
		if (request.reasoningEffort) console.warn(`[dsh-sub-cli] qwen driver: ignoring reasoningEffort=${request.reasoningEffort}; Qwen has no --effort flag`);
		if (mode === "resume" && resumeSessionId) args.push("--resume", resumeSessionId);
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
		return (async () => {
			try {
				// Qwen's stream-json output includes system/init/assistant events
				// (Anthropic-compatible NDJSON), not just a single result line. We
				// write the prompt with a trailing newline and then close stdin so
				// Qwen sees EOF and proceeds; without the close Qwen hangs
				// waiting for more input (verified against the real CLI on 2026-09-01).
				if (typeof prompt === "string" && prompt) {
					await transport.write(prompt + "\n");
					transport.closeStdin?.();
				}
				const { events, result } = await runTurn({ transport, timeoutMs: request.timeoutMs ?? this.turnTimeoutMs });
				// Session id comes from the result or the ctx.
				const resolvedSessionId = result?.session_id || resumeSessionId || ctx.sessionId;
				ctx.actualSessionId = resolvedSessionId;
				return {
					threadId: resolvedSessionId,
					text: extractFinalText(events),
					toolRounds: countToolUses(events),
					stopReason: result?.stop_reason || "completed",
					usage: result?.usage || null
				};
			} finally {
				await transport.dispose().catch(() => {});
			}
		})();
	}
}
