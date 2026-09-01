// Claude Code driver. Spawns `claude -p --input-format stream-json
// --output-format stream-json --verbose` once per turn and treats NDJSON
// events on stdout as the protocol.
//
// Why one process per turn (not a long-lived app-server):
//   Claude Code has no JSON-RPC / app-server subcommand. `--print` with
//   stream-json is the only headless surface. Each turn is a fresh
//   `claude -p` invocation, so `start`/`followup` each spawn a process.
//   `--resume <id>` reattaches the on-disk history Claude keeps under
//   ~/.claude/projects/<cwd>/; we carry `remoteSessionId` across calls so
//   the next followup reuses it.
//
// Permission model:
//   stream-json does not expose interactive permission requests the way
//   Codex's app-server does. The caller picks a permission mode up-front
//   (`--permission-mode`); the driver trusts the caller's choice and does
//   not surface mid-turn permission prompts. The service layer is
//   responsible for translating the user's profile into one of Claude's
//   accepted mode values.

import { randomUUID } from "node:crypto";
import { defineDriverCapabilities } from "./types.js";
import { SubprocessLineTransport } from "./subprocess-transport.js";
import { binPath } from "../paths.js";
import { winShimArgv } from "../dispatch.js";

export const CLAUDE_STREAM_JSON_CAPABILITIES = defineDriverCapabilities({
	streaming: true,
	continuable: true,
	durableResume: true,
	modelOverride: true,
	reasoningEffort: false,
	cwd: true,
	interrupt: false,
	interactivePermissions: false
});

// Map a coarse sandbox tier (read-only / workspace-write / danger-full-access)
// to Claude's --permission-mode value. Defaults to acceptEdits so a missing
// tier still produces a workable session.
function claudePermissionMode(sandboxTier) {
	switch (sandboxTier) {
		case "read-only": return "plan";
		case "workspace-write": return "acceptEdits";
		case "danger-full-access": return "bypassPermissions";
		default: return "acceptEdits";
	}
}

// Extract the final user-visible text from the assistant message events.
// Falls back to the result event's `result` field when no streamed text
// arrived (e.g. an early error).
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
 * Run one Claude turn to completion. The returned promise resolves when
 * the CLI emits a `result` event or the process closes, whichever comes
 * first. Caller owns disposal of the underlying subprocess.
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
					const message = ev?.error?.message || ev?.result || "Claude turn failed";
					finish(false, new Error(message));
				} else {
					finish(true, { events, result: ev });
				}
			}
		});
		const offClose = transport.onClose?.((error) => {
			if (settled) return;
			finish(false, error ?? new Error("Claude process closed without a result event"));
		});
		timer = setTimeout(() => {
			finish(false, new Error(`Claude turn timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		// stream-json requires one NDJSON line per message. The wire stays
		// open so an interrupt can be sent later if the protocol grows
		// the support for it; today the driver relies on process kill.
		const payload = `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`;
		transport.write(payload).catch((error) => finish(false, error));
	});
}

export class ClaudeStreamJsonDriver {
	constructor({ subprocess, dirSource, prepare, turnTimeoutMs = 1800000 } = {}) {
		if (!subprocess || typeof subprocess.spawn !== "function") throw new TypeError("Claude stream-json driver requires subprocess.spawn");
		if (typeof dirSource !== "function") throw new TypeError("Claude stream-json driver requires dirSource()");
		this.id = "claude-stream-json";
		this.capabilities = CLAUDE_STREAM_JSON_CAPABILITIES;
		this.subprocess = subprocess;
		this.dirSource = dirSource;
		this.prepare = typeof prepare === "function" ? prepare : null;
		this.turnTimeoutMs = turnTimeoutMs;
	}

	async start(request) {
		const ctx = await this.#prepareContext(request, { mode: "new" });
		const result = this.#spawnTurn(ctx, request, { mode: "new", prompt: request.prompt });
		const runRef = { sessionId: ctx.sessionId };
		// Resolve the actual session id once the CLI announces it.
		result.then(
			(value) => { runRef.sessionId = value.threadId; },
			() => {}
		);
		return {
			id: randomUUID(),
			product: "claude",
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
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Claude followup prompt must not be empty");
		const signal = options?.signal ?? originalRequest.signal;
		if (signal?.aborted) throw new Error("Claude followup aborted before start");
		// Prefer the id we saw in the original turn, fall back to the
		// caller-supplied one, then the seeded one.
		const resumeId = options?.resumeSessionId || ctx.actualSessionId || ctx.sessionId;
		return this.#spawnTurn(ctx, originalRequest, { mode: "resume", prompt, resumeSessionId: resumeId, signal });
	}

	async #prepareContext(request, { mode }) {
		if (!request || typeof request !== "object") throw new TypeError("Claude driver request must be an object");
		if (typeof request.cwd !== "string" || !request.cwd) throw new Error("Claude driver request.cwd is required");
		if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("Claude driver request.prompt must not be empty");
		const dir = this.dirSource();
		const bin = binPath(dir, "claude");
		let resolved = null;
		try {
			resolved = this.subprocess.resolveExecutable(bin, undefined, request.signal);
		} catch {}
		// DSH's resolveExecutable may be sync (returning a path) or async
		// (returning a Promise). Normalise to a string-or-null and accept
		// either shape.
		if (resolved && typeof resolved.then === "function") {
			resolved = await resolved.catch(() => null);
		}
		if (!resolved) throw new Error(`找不到 claude，请先安装到统一目录 ${dir}/bin。`);
		let env;
		if (this.prepare) {
			const ready = await this.prepare("claude", dir);
			if (!ready?.ok) throw new Error(ready?.reason || "Claude 配置未就绪，拒绝启动。");
			env = ready.env;
		}
		const sessionId = request.sessionId || randomUUID();
		return { bin: resolved, env, dir, sessionId, actualSessionId: null };
	}

	#spawnTurn(ctx, request, { mode, prompt, resumeSessionId = null, signal = null }) {
		const args = [
			"-p",
			"--verbose",
			"--input-format", "stream-json",
			"--output-format", "stream-json",
			"--permission-mode", claudePermissionMode(request.sandbox)
		];
		if (request.model) args.push("--model", request.model);
		if (request.reasoningEffort) args.push("--effort", request.reasoningEffort);
		if (mode === "resume" && resumeSessionId) args.push("--resume", resumeSessionId);
		else if (mode === "new") args.push("--session-id", ctx.sessionId);
		// Constrain the file scope to the working directory; mirrors the
		// interactive TUI's default and matches the sandbox tier.
		args.push("--add-dir", request.cwd);
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
