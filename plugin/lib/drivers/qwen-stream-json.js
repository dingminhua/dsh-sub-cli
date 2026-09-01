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
import { binPath } from "../paths.js";
import { winShimArgv } from "../dispatch.js";

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
		timer = setTimeout(() => {
			finish(false, new Error(`Qwen turn timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
	});
}

export class QwenStreamJsonDriver {
	constructor({ subprocess, dirSource, prepare, turnTimeoutMs = 1800000 } = {}) {
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
		// Qwen has no --input-format flag: a single user message is appended as
		// `--prompt <text>` (the value, not a stream). The output, however, is a
		// single JSON object on stdout when `--output-format stream-json` is set.
		const args = [
			"-p",
			"--output-format", "stream-json"
		];
		// Both new and resume turns pass the prompt explicitly via --prompt
		// (Qwen has no stdin protocol). The first turn also seeds a session id;
		// subsequent turns use --resume to reattach the on-disk history.
		if (typeof prompt === "string" && prompt) args.push("--prompt", prompt);
		if (request.model) args.push("--model", request.model);
		// Qwen has no --effort flag (verified against `qwen --help`); if the user
		// configured a reasoning effort we silently skip it instead of letting the
		// CLI reject the whole invocation with "Unknown argument: effort".
		if (request.reasoningEffort) console.warn(`[dsh-sub-cli] qwen driver: ignoring reasoningEffort=${request.reasoningEffort}; Qwen has no --effort flag`);
		if (mode === "resume" && resumeSessionId) args.push("--resume", resumeSessionId);
		else if (mode === "new") args.push("--session-id", ctx.sessionId);
		args.push("--cwd", request.cwd);
		const argv = winShimArgv(ctx.bin, args);
		const handle = this.subprocess.spawn({
			argv,
			cwd: request.cwd,
			env: ctx.env,
			signal,
			stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
			graceMs: request.timeoutMs ?? this.turnTimeoutMs
		});
		const transport = new SubprocessLineTransport(handle);
		return (async () => {
			try {
				const { events, result } = await runTurn({ transport, timeoutMs: request.timeoutMs ?? this.turnTimeoutMs });
				// Qwen emits no init event; session id comes from the result or the ctx.
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
