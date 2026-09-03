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
// Permission model (tier set before launch, 2026-09-03):
//   The CLI launches at the tier the user selected — read-only → `plan` (no
//   edit tools at all), workspace-write → `acceptEdits`, danger →
//   `bypassPermissions` — so the CLI itself enforces the boundary no matter
//   what the model tries. The driver's tool_use interception is KEPT but is
//   only a best-effort add-on on this one-way wire: a "reject" can abort the
//   turn but cannot un-execute a tool call that already ran (proven in round
//   9: file landed despite rejection). The reliable one-off authorization
//   path for Claude is the pre-flight A gate / blocked-retry B gate in
//   managed-cli-agents.js, which restart the turn at a widened tier.

import { randomUUID } from "node:crypto";
import { defineDriverCapabilities } from "./types.js";
import { SubprocessLineTransport } from "./subprocess-transport.js";
import { probeStalledTurn } from "./turn-timeout.js";
import { resolveTurnTimeoutMs } from "../turn-timeout-policy.js";
import { binPath } from "../paths.js";
import { winShimArgv } from "../dispatch.js";
import { normalizePermissionRequest, CLAUDE_APPROVAL_METHODS } from "../permissions.js";

export const CLAUDE_STREAM_JSON_CAPABILITIES = defineDriverCapabilities({
	streaming: true,
	continuable: true,
	durableResume: true,
	modelOverride: true,
	reasoningEffort: false,
	cwd: true,
	interrupt: false,
	interactivePermissions: true
});

// Map Claude Code's tool name to one of our three capability keys, or null
// when the tool is read-only (no approval required).
function claudeToolCapability(toolName) {
	if (!toolName) return null;
	if (toolName === "Bash" || toolName === "NpmcliLifecyclePlugin") return "command";
	if (toolName === "Write" || toolName === "MultiWrite" || toolName === "Edit" || toolName === "Delete") return "file-change";
	if (toolName === "WebSearch" || toolName === "WebFetcher") return "exec";
	return null; // Read, Glob, Grep, etc. — not approval-worthy
}

// 档位 → Claude 自身执法（2026-09-03 恢复映射；第三轮的「恒 bypassPermissions」
// 已被第九轮实测证伪：单向 stream-json 上拒绝撤不回已执行的写）。read-only →
// plan（无编辑工具，物理写不了）；workspace-write → acceptEdits；danger →
// bypassPermissions。未知值按最保守的 plan 处理。
function claudePermissionMode(tier) {
	switch (tier) {
		case "read-only": return "plan";
		case "workspace-write": return "acceptEdits";
		case "danger-full-access": return "bypassPermissions";
		default: return "plan";
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
 * Build a synthetic permission request for a tool_use block. The hook returned
 * to managed-cli-agents.js calls resolvePermission() on the result; that
 * function either allows silently (capability granted) or forwards the
 * request to ctx.approval.request() for an interactive ask.
 */
function buildClaudePermissionRequest({ toolName, toolInput, callId, pluginSessionId, childId, remoteSessionId, turnId }) {
	return normalizePermissionRequest("claude", toolName, {
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
 * Run one Claude turn to completion. The returned promise resolves when
 * the CLI emits a `result` event or the process closes, whichever comes
 * first. Caller owns disposal of the underlying subprocess.
 *
 * Tool interception: every `assistant` event's `tool_use` block is
 * inspected. Read-only tools pass through silently; write/exec tools
 * trigger `onPermissionRequest(toolName, toolInput, callId)`. The hook
 * returns a `managed-permission-decision` (allowed-once / rejected /
 * cancelled) and the driver thread-sleeps until the result arrives. The
 * "decision" string is recorded in the events log for traceability but
 * is NOT injected back into the wire: Claude Code's stream-json protocol
 * is one-way (no ack channel), so a "rejected" outcome aborts the turn
 * with an error so the upstream caller can react.
 */
function runTurn({ transport, prompt, timeoutMs, onPermissionRequest, signal }) {
	return new Promise((resolve, reject) => {
		const events = [];
		const decisions = []; // [{ callId, toolName, capability, outcome }]
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
			// Intercept tool_use blocks: gate them through onPermissionRequest
			// before the CLI proceeds. Since the stream-json wire is one-way
			// (the CLI does not consume anything from our side), the only way
			// to "block" a tool call is to abort the turn with an error.
			if (ev?.type === "assistant" && Array.isArray(ev?.message?.content)) {
				for (const block of ev.message.content) {
					if (block?.type !== "tool_use") continue;
					const toolName = block.name;
					const toolInput = block.input;
					const callId = block.id || null;
					if (!claudeToolCapability(toolName)) continue; // read-only — allow
					if (typeof onPermissionRequest !== "function") {
						decisions.push({ callId, toolName, capability: claudeToolCapability(toolName), outcome: "rejected", reason: "no permission hook" });
						finish(false, new Error(`Claude Code 请求执行 ${toolName} 但 driver 未提供权限钩子；拒绝以保护工作目录。`));
						return;
					}
					// Hand off to the service layer; await its decision. The
					// listener is synchronous, so we must consume the promise
					// here without awaiting — but the onPermissionRequest hook
					// is async, so we attach a then() that calls finish() once
					// the decision lands. Subsequent lines are still buffered
					// and processed by the next onLine call.
					Promise.resolve()
						.then(() => onPermissionRequest({ toolName, toolInput, callId }))
						.then((outcome) => {
							if (settled) return;
							decisions.push({ callId, toolName, capability: claudeToolCapability(toolName), outcome });
							if (outcome === "rejected" || outcome === "cancelled" || outcome === "unavailable") {
								finish(false, new Error(`用户${outcome === "cancelled" ? "取消" : "拒绝"}了 Claude Code 的 ${toolName} 操作（callId=${callId}）。`));
							}
						})
						.catch((error) => {
							if (!settled) finish(false, error instanceof Error ? error : new Error(String(error)));
						});
					// Mark settled if the decision was an instant reject (allowed-once path skips this).
					if (settled) return;
				}
			}
			if (ev?.type === "result") {
				const isError = ev.is_error === true || ev.subtype === "error_during_execution";
				if (isError) {
					const message = ev?.error?.message || ev?.result || "Claude turn failed";
					finish(false, new Error(message));
				} else {
					finish(true, { events, result: ev, decisions });
				}
			}
		});
		const offClose = transport.onClose?.((error) => {
			if (settled) return;
			finish(false, error ?? new Error("Claude process closed without a result event"));
		});
		// Hitting the deadline is not an automatic failure: probe the child and
		// only reject when it is genuinely silent (see drivers/turn-timeout.js).
		timer = setTimeout(() => {
			if (settled) return;
			const startedAt = Date.now() - timeoutMs;
			probeStalledTurn({ transport, elapsedMs: timeoutMs })
				.then((probe) => {
					if (settled) return;
					if (probe.stalled) {
						finish(false, new Error(`Claude turn stalled after ${timeoutMs}ms: ${probe.reason}`));
						return;
					}
					timer = setTimeout(() => {
						finish(false, new Error(
							`Claude turn timed out after ${Date.now() - startedAt}ms (granted extra time: ${probe.reason})`
						));
					}, probe.extendMs ?? 0);
					timer.unref?.();
				})
				.catch((error) => {
					if (!settled) finish(false, error);
				});
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
	constructor({ subprocess, dirSource, prepare, turnTimeoutMs } = {}) {
		if (!subprocess || typeof subprocess.spawn !== "function") throw new TypeError("Claude stream-json driver requires subprocess.spawn");
		if (typeof dirSource !== "function") throw new TypeError("Claude stream-json driver requires dirSource()");
		this.id = "claude-stream-json";
		this.capabilities = CLAUDE_STREAM_JSON_CAPABILITIES;
		this.subprocess = subprocess;
		this.dirSource = dirSource;
		this.prepare = typeof prepare === "function" ? prepare : null;
		this.turnTimeoutMs = resolveTurnTimeoutMs(turnTimeoutMs);
	}

	async start(request) {
		// Reattach path (managed-cli-agents.js reattach() after release()):
		// the request carries attachOnly + resumeThreadId and NO prompt — the
		// prompt arrives with the next followup(). Under the one-process-per-
		// turn model attaching spawns nothing now; we only prepare the context
		// (resolve binary, write provider config) and return a run whose
		// followup() spawns `claude -p --resume <threadId>`. Mirrors Codex's
		// attachOnly branch in codex-app-server.js.
		const attachOnly = request?.attachOnly === true;
		const ctx = await this.#prepareContext(request, { mode: attachOnly ? "attach" : "new" });
		if (attachOnly) {
			return {
				id: randomUUID(),
				product: "claude",
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
		return this.#spawnTurn(ctx, originalRequest, { mode: "resume", prompt, resumeId, options });
	}

	async #prepareContext(request, { mode }) {
		if (!request || typeof request !== "object") throw new TypeError("Claude driver request must be an object");
		if (typeof request.cwd !== "string" || !request.cwd) throw new Error("Claude driver request.cwd is required");
		if (mode === "attach") {
			// Reattach requests carry no prompt (the next followup supplies
			// it); what they MUST carry is the remote thread to resume.
			if (typeof request.resumeThreadId !== "string" || !request.resumeThreadId) throw new Error("Claude driver attach requires resumeThreadId");
		} else if (typeof request.prompt !== "string" || !request.prompt.trim()) {
			throw new Error("Claude driver request.prompt must not be empty");
		}
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
			// 本轮档位（含 A/B 门授权的临时提升）随请求穿透到 prepare，
			// 供配置渲染使用（qwen 靠它写 approvalMode；claude 仅透传）。
			const ready = await this.prepare("claude", dir, { permissionProfile: request.permissionProfile ?? null });
			if (!ready?.ok) throw new Error(ready?.reason || "Claude 配置未就绪，拒绝启动。");
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
		// 档位在启动参数里钉死（见文件头注释）：CLI 自身执法是硬保证；
		// 驱动层拦截在单向协议上只是尽力而为的加严。
		const args = [
			"-p",
			"--verbose",
			"--input-format", "stream-json",
			"--output-format", "stream-json",
			"--permission-mode", claudePermissionMode(request.sandbox)
		];
		if (request.model) args.push("--model", request.model);
		if (request.reasoningEffort) args.push("--effort", request.reasoningEffort);
		if (mode === "resume" && resumeId) args.push("--resume", resumeId);
		else if (mode === "new") args.push("--session-id", ctx.sessionId);
		// Constrain the file scope to the working directory; mirrors the
		// interactive TUI's default and matches the sandbox tier.
		args.push("--add-dir", request.cwd);
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
		// Build the per-turn permission hook. resolvePermission() in the
		// service layer returns a managed decision; the onPermissionRequest
		// passed via the service wraps that into a normalised ask flow.
		const onPermissionRequest = typeof request.onPermissionRequest === "function"
			? request.onPermissionRequest
			: (options && typeof options.onPermissionRequest === "function" ? options.onPermissionRequest : null);
		return (async () => {
			try {
				const { events, result, decisions } = await runTurn({
					transport,
					prompt,
					timeoutMs: request.timeoutMs ?? this.turnTimeoutMs,
					onPermissionRequest: onPermissionRequest
						? (tool) => onPermissionRequest(buildClaudePermissionRequest({
							toolName: tool.toolName,
							toolInput: tool.toolInput,
							callId: tool.callId
						}))
						: null,
					signal
				});
				const init = events.find((ev) => ev?.type === "system" && ev?.subtype === "init");
				const resolvedSessionId = init?.session_id || result?.session_id || resumeId || ctx.sessionId;
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
