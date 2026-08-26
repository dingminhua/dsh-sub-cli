// Model-facing external CLI delegation tools, registered on the Host tools
// registry so every Agent preset sees them unless that preset explicitly
// restricts the tool name. Each tool delegates through a one-shot
// ManagedCliProvider; no LLM provider route is registered.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { MANAGED_PROVIDERS } from "./provider.js";

export const CLI_SUBAGENT_TOOLS = [
	{ cli: "codex", toolName: "cli_codex", displayName: "Codex", provider: "managed-codex" },
	{ cli: "claude", toolName: "cli_claude_code", displayName: "Claude Code", provider: "managed-claude" },
	{ cli: "opencode", toolName: "cli_opencode", displayName: "OpenCode", provider: "managed-opencode" },
	{ cli: "gemini", toolName: "cli_gemini", displayName: "Gemini CLI", provider: "managed-gemini" }
];

export { MANAGED_PROVIDERS };

function definition(spec, ctx) {
	return defineTool({
		name: spec.toolName,
		description: `将自包含任务交给 ${spec.displayName}。主控 AI 自主决定何时调用；description 是主界面显示的简短标题。执行后把 CLI 输出作为结果返回并进入 DSH 子会话历史。`,
		parameters: {
			description: { type: "string", required: true, description: "用于主界面显示的简短任务标题（3-5 个词）。" },
			prompt: { type: "string", required: true, description: "完整、自包含的任务说明；外部 CLI 看不到父会话上下文。" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: value.output || "" }]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			if (!exec.agent) throw new Error(`${spec.toolName} requires a calling agent`);
			const description = typeof args.description === "string" ? args.description.trim() : "";
			const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
			if (!description) throw new Error("description 不能为空");
			if (!prompt) throw new Error("prompt 不能为空");
			const run = await ctx.subagents.start(spec.provider, {
				label: description,
				prompt: [{ type: "text", text: prompt }],
				parent: exec.agent,
				signal: exec.signal
			});
			const result = await run.result;
			const text = (result.output || []).filter((block) => block && block.type === "text").map((block) => block.text).join("");
			try { await run.dispose(); } catch {}
			if (result.stopReason !== "completed") throw new Error(result.diagnostic || `CLI 工作结束：${String(result.stopReason)}`);
			return { runId: run.id, output: text };
		}
	});
}

export function registerCliSubagentTools(ctx) {
	for (const spec of CLI_SUBAGENT_TOOLS) ctx.tools.register(definition(spec, ctx));
}
