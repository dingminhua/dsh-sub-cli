// Public Subagent-mode (Relay) tool per CLI and Relay lifecycle policy. The
// child is a real DSH continuable Agent; its only work tool is
// managed_cli_submit. Per-CLI providers (managed-codex-relay /
// managed-claude-relay / managed-qwen-relay) are registered by index.js
// against the same ManagedCliAgentsService.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { RELAY_SUBMIT_TOOL } from "./relay-tools.js";

export function relayPersonaFor(cli) {
	const name = cli === "qwen" ? "Qwen Code" : cli === "claude" ? "Claude Code" : "Codex";
	return `You are a relay bridge to an external ${name} CLI agent, not the task executor.
For every user message, you must call managed_cli_submit exactly once with the complete task. Do not use your own knowledge to answer, do not inspect or modify files yourself, and do not claim work that ${name} did not perform. After managed_cli_submit returns, faithfully report its result to the parent using report. A report before managed_cli_submit is rejected.`;
}

export function attachRelayLifecycle(ctx, service) {
	ctx.on("subagent/start", (info) => {
		if (!info?.id) return;
		try { service.beginChildEpoch(String(info.id)); } catch {}
	});
	// `subagent/end` fires per residency epoch, not when the child is destroyed:
	// a continuable Relay child emits it every time it goes idle. Free the
	// subprocess here; the bound thread id survives, so a later
	// send_message reattaches the same external thread.
	ctx.on("subagent/end", (info) => {
		const childId = info?.id;
		if (!childId || typeof service.releaseChild !== "function") return;
		void service.releaseChild(String(childId)).catch(() => {});
	});
	if (typeof ctx.subagents?.registerContinuableSetup === "function") {
		ctx.subagents.registerContinuableSetup((childCtx) => {
			const guard = childCtx.tools.guard((exec) => {
				if (exec.name !== "report") return undefined;
				const childId = exec.agent?.session?.id;
				// Missing childId is itself a report that should be blocked: a Relay
				// turn is always attached to a child session, so an unkeyed exec
				// means something is wrong upstream. We surface the same submit-first
				// message rather than letting the child fall through.
				if (!childId) return "This Relay turn has no child session id. managed_cli_submit cannot route; refusing report.";
				try {
					return service.childCanReport(String(childId))
						? undefined
						: "This Relay turn has not called managed_cli_submit. Forward the task to the external CLI before report.";
				} catch (error) {
					// H2 fix: an exception (e.g. CHILD_BINDING_NOT_FOUND) must NOT
					// grant the report. Fail closed so a mis-bound child can never
					// report without first calling managed_cli_submit.
					return `managed_cli_submit guard failed: ${error instanceof Error ? error.message : String(error)}. Refusing report.`;
				}
			});
			return typeof guard === "function" ? guard : () => {};
		});
	}
}

function registerCliSubagentTool(ctx, { cli, displayName, preflight }) {
	ctx.tools.register(defineTool({
		name: `cli_${cli}_subagent`,
		description: `创建一个 DSH 原生可持续 ${displayName} Relay 子代理。该子代理只负责把任务转发给真实 ${displayName} thread并报告结果；返回 subagentId 后可用 send_message 继续、interrupt_agent 中断。适合需要子代理卡片、Transcript 和持续协作的任务。`,
		parameters: {
			description: { type: "string", required: true, description: "子代理卡片显示的简短标题（3-5 个词）。" },
			prompt: { type: "string", required: true, description: "首轮完整、自包含任务。" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { kind: { type: "string", required: true, const: "continuable" }, subagentId: { type: "string", required: true } } },
			render: (_a, v) => [{ type: "text", text: `started ${displayName} Relay subagent ${v.subagentId}; continue with send_message` }]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			if (!exec.agent) throw new Error(`cli_${cli}_subagent requires a calling agent`);
			if (preflight) {
				const checked = await preflight(cli);
				if (checked && !checked.ok) throw new Error(`${displayName} 未通过连通测试：${checked.error}`);
			}
			if (typeof ctx.subagents.startContinuable !== "function") throw new Error("当前 DSH 不支持 continuable subagent");
			const started = await ctx.subagents.startContinuable({
				provider: `managed-${cli}-relay`,
				label: args.description,
				request: {
					prompt: [{ type: "text", text: args.prompt }],
					parent: exec.agent,
					persona: relayPersonaFor(cli),
					toolFilter: { allow: [RELAY_SUBMIT_TOOL] }
				},
				signal: exec.signal
			});
			// The Relay Provider binds childId/cwd inside prepareContinuable before
			// the child Activation can call managed_cli_submit.
			return { kind: "continuable", subagentId: String(started.childId) };
		}
	}));
}

const SUPPORTED_CLIS = [
	{ cli: "codex", displayName: "Codex" },
	{ cli: "claude", displayName: "Claude Code" },
	{ cli: "qwen", displayName: "Qwen Code" }
];

// Back-compat: keep the old Codex-only entry point working so existing
// callers (index.js) don't have to be updated in lockstep.
export function registerCodexSubagentTool(ctx, service, preflight) {
	registerCliSubagentTool(ctx, { cli: "codex", displayName: "Codex", preflight });
}

export function registerManagedCliSubagentTools(ctx, preflight) {
	for (const spec of SUPPORTED_CLIS) registerCliSubagentTool(ctx, { ...spec, preflight });
}
