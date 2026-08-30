// Experimental SubagentProvider backed by Codex app-server. It coexists with
// the current one-shot managed-codex provider until its protocol path is proven
// in the live DSH runtime.

import { randomUUID } from "node:crypto";
import { normalizePermission, deriveSandboxMode } from "../permissions.js";

const NO_START_CAPABILITIES = Object.freeze({
	outputSchema: false,
	depthLimit: false,
	toolFilter: false,
	persona: false
});

function textPrompt(prompt) {
	const blocks = Array.isArray(prompt) ? prompt : [];
	if (!blocks.length || blocks.some((block) => !block || block.type !== "text")) {
		throw new Error("Codex app-server provider accepts only non-empty text blocks");
	}
	const text = blocks.map((block) => block.text).join("\n");
	if (!text.trim()) throw new Error("Codex app-server provider prompt must not be empty");
	return text;
}

function parentCwd(request) {
	const cwd = request?.cwd ?? request?.parent?.session?.header?.cwd;
	if (typeof cwd !== "string" || !cwd) throw new Error("Codex app-server provider requires a working directory");
	return cwd;
}

export class CodexAppServerProvider {
	constructor({ name = "managed-codex-app-server", driver, routeSource, permissionSource }) {
		if (!driver || typeof driver.start !== "function") throw new TypeError("Codex app-server provider requires a driver");
		this.name = name;
		this.driver = driver;
		this.routeSource = typeof routeSource === "function" ? routeSource : () => ({});
		this.permissionSource = typeof permissionSource === "function" ? permissionSource : () => "read-only";
		this.capabilities = NO_START_CAPABILITIES;
		this.inheritsParentContext = false;
	}

	permissionRequest() {
		const profile = normalizePermission(this.permissionSource("codex"));
		// Experimental provider has no approval bridge; use the derived sandbox
		// tier so the capability profile still shapes what Codex may do.
		return { approvalPolicy: "never", sandbox: deriveSandboxMode(profile) };
	}

	async start(request) {
		if (request.signal?.aborted) throw new Error("Codex app-server request aborted before startup");
		const route = await this.routeSource("codex");
		const prompt = textPrompt(request.prompt);
		const cwd = parentCwd(request);
		const controller = new AbortController();
		const onAbort = () => controller.abort(request.signal?.reason ?? "Codex app-server request aborted");
		request.signal?.addEventListener("abort", onAbort, { once: true });
		if (request.signal?.aborted) onAbort();
		let driverRun;
		try {
			driverRun = await this.driver.start({
				cwd,
				prompt,
				model: route?.model || undefined,
				reasoningEffort: route?.reasoningEffort || undefined,
				...this.permissionRequest(),
				signal: controller.signal
			});
		} catch (error) {
			request.signal?.removeEventListener("abort", onAbort);
			throw error;
		}
		const result = driverRun.result.then(
			(value) => ({
				output: value?.text ? [{ type: "text", text: value.text }] : [],
				stopReason: value?.stopReason ?? "completed"
			}),
			(error) => ({
				output: [],
				stopReason: controller.signal.aborted ? "aborted" : "error",
				diagnostic: error instanceof Error ? error.message : String(error)
			})
		).finally(() => request.signal?.removeEventListener("abort", onAbort));
		return {
			id: randomUUID(),
			localAgent: undefined,
			result,
			readOutput: () => driverRun.status?.().progress || "running…",
			remoteSessionId: () => driverRun.remoteSessionId,
			async dispose() {
				controller.abort("Codex app-server run disposed");
				await driverRun.dispose();
			}
		};
	}
}

export function registerCodexAppServerProvider(ctx, options) {
	const provider = new CodexAppServerProvider(options);
	ctx.subagents.registerProvider(provider);
	return provider;
}
