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

// Extract the final text from assistant message events.
// Falls back to the `result` field when no streamed text arrived.
function extractFinalText(events) {
	const parts = [];
	for (const ev of events) {
		if (ev?.type !== "assistant") continue;
		const content = ev?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	if (parts.length) return parts.join("\n");
	const result = events.find((ev) => ev?.type === "result");
	return typeof result?.result === "string" ? result.result : "";
}

function countToolUses(events) {
	let n = 0;
	for (const ev of events) {
		if (ev?.type !== "assistant") continue;
		const content = ev?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "tool_use") n++;
		}
	}
	return n;
}

/**
 * Run one Qwen turn to completion. The returned promise resolves when the
 * CLI emits a `result` event or the process closes. Caller owns subprocess
 * disposal.
 */
function runTurn({ transport, prompt, timeoutMs }) {
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
			if (ev?.type === "result") {
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
		// Send the first user turn as one NDJSON line.
		const payload = `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`;
		transport.write(payload).catch((error) => finish(false, error));
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
		const args = [
			"-p",
			"--input-format", "stream-json",
			"--output-format", "stream-json"
		];
		if (request.model) args.push("--model", request.model);
		if (request.reasoningEffort) args.push("--effort", request.reasoningEffort);
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
				const { events, result } = await runTurn({ transport, prompt, timeoutMs: request.timeoutMs ?? this.turnTimeoutMs });
				const init = events.find((ev) => ev?.type === "system" && ev?.subtype === "init");
				const resolvedSessionId = init?.session_id || result?.session_id || resumeSessionId || ctx.sessionId;
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
