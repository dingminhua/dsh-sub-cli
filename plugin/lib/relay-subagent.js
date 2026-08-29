// Public Codex Subagent-mode tool and Relay lifecycle policy. The child is a
// real DSH continuable Agent; its only work tool is managed_cli_submit.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { RELAY_SUBMIT_TOOL } from "./relay-tools.js";

export const RELAY_PERSONA = `You are a relay bridge to an external Codex CLI agent, not the task executor.
For every user message, you must call managed_cli_submit exactly once with the complete task. Do not use your own knowledge to answer, do not inspect or modify files yourself, and do not claim work that Codex did not perform. After managed_cli_submit returns, faithfully report its result to the parent using report. A report before managed_cli_submit is rejected.`;

export function attachRelayLifecycle(ctx, service) {
	ctx.on("subagent/start", (info) => {
		if (!info?.id) return;
		try { service.beginChildEpoch(String(info.id)); } catch {}
	});
	if (typeof ctx.subagents?.registerContinuableSetup === "function") {
		ctx.subagents.registerContinuableSetup((childCtx) => {
			const guard = childCtx.tools.guard((exec) => {
				if (exec.name !== "report") return undefined;
				const childId = exec.agent?.session?.id;
				if (!childId) return undefined;
				try {
					return service.childCanReport(String(childId))
						? undefined
						: "This Relay turn has not called managed_cli_submit. Forward the task to Codex before report.";
				} catch { return undefined; }
			});
			return typeof guard === "function" ? guard : () => {};
		});
	}
}

export function registerCodexSubagentTool(ctx, service, preflight) {
	ctx.tools.register(defineTool({
		name: "cli_codex_subagent",
		description: "创建一个 DSH 原生可持续 Codex Relay 子代理。该子代理只负责把任务转发给真实 Codex CLI thread并报告结果；返回 subagentId 后可用 send_message 继续、interrupt_agent 中断。适合需要子代理卡片、Transcript 和持续协作的任务。",
		parameters: {
			description: { type: "string", required: true, description: "子代理卡片显示的简短标题（3-5 个词）。" },
			prompt: { type: "string", required: true, description: "首轮完整、自包含任务。" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { kind: { type: "string", required: true, const: "continuable" }, subagentId: { type: "string", required: true } } },
			render: (_a, v) => [{ type: "text", text: `started Codex Relay subagent ${v.subagentId}; continue with send_message` }]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			if (!exec.agent) throw new Error("cli_codex_subagent requires a calling agent");
			if (preflight) {
				const checked = await preflight("codex");
				if (checked && !checked.ok) throw new Error(`Codex 未通过连通测试：${checked.error}`);
			}
			if (typeof ctx.subagents.startContinuable !== "function") throw new Error("当前 DSH 不支持 continuable subagent");
			const started = await ctx.subagents.startContinuable({
				provider: "managed-codex-relay",
				label: args.description,
				request: {
					prompt: [{ type: "text", text: args.prompt }],
					parent: exec.agent,
					persona: RELAY_PERSONA,
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
