// Model-facing external CLI delegation tools, registered on the Host tools
// registry so every Agent preset sees them unless that preset explicitly
// restricts the tool name.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { CLI_LLM_ROUTES } from "./cli-llm-adapter.js";

export const CLI_SUBAGENT_TOOLS = [
	{ cli: "codex", toolName: "cli_codex", displayName: "Codex", route: CLI_LLM_ROUTES[0] },
	{ cli: "claude", toolName: "cli_claude_code", displayName: "Claude Code", route: CLI_LLM_ROUTES[1] },
	{ cli: "opencode", toolName: "cli_opencode", displayName: "OpenCode", route: CLI_LLM_ROUTES[2] },
	{ cli: "gemini", toolName: "cli_gemini", displayName: "Gemini CLI", route: CLI_LLM_ROUTES[3] }
];

function definition(spec, ctx) {
	return defineTool({
		name: spec.toolName,
		description: `将自包含任务交给 ${spec.displayName}。主控 AI 自主决定何时调用；description 是主界面显示的简短标题。默认建立可继续的 DSH 子会话，完成当前轮次后自动通知主控；后续可用 send_message 继续，用 interrupt_agent 停止当前轮次。`,
		parameters: {
			description: { type: "string", required: true, description: "用于主界面显示的简短任务标题（3-5 个词）。" },
			prompt: { type: "string", required: true, description: "完整、自包含的任务说明；外部 CLI 看不到父会话上下文。" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { subagentId: { type: "string", required: true } }
			},
			render: (_args, value) => [{ type: "text", text: `started ${spec.displayName} child ${value.subagentId}` }]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			if (!exec.agent) throw new Error(`${spec.toolName} requires a calling agent`);
			const description = typeof args.description === "string" ? args.description.trim() : "";
			const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
			if (!description) throw new Error("description 不能为空");
			if (!prompt) throw new Error("prompt 不能为空");
			const started = await ctx.subagents.startContinuable({
				provider: "spawn",
				label: description,
				request: {
					label: description,
					prompt: [{ type: "text", text: prompt }],
					parent: exec.agent,
					agentOptions: { provider: spec.route.provider, model: spec.route.model }
				},
				signal: exec.signal
			});
			return { subagentId: started.childId };
		}
	});
}

/** Register all CLI tools globally; scoped preset restrictions still apply. */
export function registerCliSubagentTools(ctx) {
	for (const spec of CLI_SUBAGENT_TOOLS) ctx.tools.register(definition(spec, ctx));
}
