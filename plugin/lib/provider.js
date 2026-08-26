// Managed-CLI subagent provider. Each CLI is a proper one-shot SubagentProvider
// (like the official codex/claude-code providers), so no LLM route is ever
// registered and the model selector stays clean. The managed CLI binary and its
// isolated config are used directly; output is captured as the child result.

import { randomUUID } from "node:crypto";
import { binPath, envFor } from "./paths.js";
import { cliById } from "./registry.js";
import { MAX_OUTPUT_BYTES, GRACE_MS, winShimArgv } from "./dispatch.js";

const NO_START_CAPABILITIES = Object.freeze({
	outputSchema: false,
	depthLimit: false,
	toolFilter: false,
	persona: false
});

export const MANAGED_PROVIDERS = [
	{ cli: "codex", name: "managed-codex" },
	{ cli: "claude", name: "managed-claude" },
	{ cli: "qwen", name: "managed-qwen" }
];

function textPrompt(prompt) {
	const texts = (prompt || []).filter((block) => block && block.type === "text").map((block) => block.text);
	if (texts.length === 0 || texts.every((text) => !text.trim())) throw new Error("CLI provider prompt must not be empty");
	return texts.join("\n");
}

export class ManagedCliProvider {
	constructor({ name, cli, dirSource, spawn, prepare }) {
		this.name = name;
		this.cli = cli;
		this.dirSource = dirSource;
		this.spawn = spawn;
		this.prepare = prepare; // optional (cliId, dir) => { ok, env, reason } — run gate
		this.capabilities = NO_START_CAPABILITIES;
		this.inheritsParentContext = false;
	}

	start(request) {
		const entry = cliById(this.cli);
		if (!entry) return Promise.reject(new Error(`unknown managed CLI ${this.cli}`));
		const dir = this.dirSource();
		const bin = binPath(dir, entry.bin);
		let task;
		try {
			task = textPrompt(request.prompt);
		} catch (error) {
			return Promise.reject(error);
		}
		const controller = new AbortController();
		const onAbort = () => controller.abort(request.signal.reason ?? "managed CLI run aborted");
		request.signal.addEventListener("abort", onAbort, { once: true });
		if (request.signal.aborted) onAbort();
		const id = randomUUID();
		let handle = null;
		const result = (async () => {
			try {
				const resolved = await this.spawn.resolveExecutable(bin, undefined, controller.signal).catch(() => null);
				if (!resolved) return { output: [], stopReason: "error", diagnostic: `找不到 ${entry.bin}，请先安装到统一目录 ${dir}/bin。` };
				// Run gate: derive env from the CURRENT live route; refuse if not ready.
				let mergedEnv;
				if (this.prepare) {
					const prep = await this.prepare(this.cli, dir);
					if (!prep.ok) return { output: [], stopReason: "error", diagnostic: prep.reason || "CLI 配置未就绪，拒绝启动。" };
					mergedEnv = prep.env;
				} else {
					mergedEnv = envFor(entry, dir);
				}
				handle = this.spawn.spawn({
					argv: winShimArgv(resolved, entry.argv(task)),
					cwd: dir,
					env: mergedEnv,
					signal: controller.signal,
					stdio: { stdin: "ignore", stdout: { maxBytes: MAX_OUTPUT_BYTES }, stderr: { maxBytes: MAX_OUTPUT_BYTES } },
					graceMs: GRACE_MS
				});
				const outcome = await handle.done;
				const out = handle.collected?.stdout ? handle.collected.stdout.readFrom(0).text : "";
				const err = handle.collected?.stderr ? handle.collected.stderr.readFrom(0).text : "";
				if (outcome.exitCode !== 0) return { output: [], stopReason: controller.signal.aborted ? "aborted" : "error", diagnostic: err.trim() || `CLI exited ${String(outcome.exitCode)}` };
				const text = out.trim();
				return { output: text ? [{ type: "text", text }] : [], stopReason: "completed" };
			} catch (error) {
				return { output: [], stopReason: controller.signal.aborted ? "aborted" : "error", diagnostic: error instanceof Error ? error.message : String(error) };
			} finally {
				request.signal.removeEventListener("abort", onAbort);
			}
		})();
		return {
			id,
			localAgent: undefined,
			result,
			dispose() {
				controller.abort("managed CLI run disposed");
				if (handle) { try { handle.terminate?.(); } catch {} const active = handle; return active.done.catch(() => {}); }
				return Promise.resolve();
			}
		};
	}
}

export function registerManagedCliProviders(ctx, dirSource, envForEntry) {
	for (const spec of MANAGED_PROVIDERS) {
		ctx.subagents.registerProvider(new ManagedCliProvider({
			name: spec.name,
			cli: spec.cli,
			dirSource,
			spawn: ctx.subprocess,
			envFor: envForEntry
		}));
	}
}
