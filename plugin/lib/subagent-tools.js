// Model-facing external CLI delegation tools, registered on the Host tools
// registry so every Agent preset sees them unless that preset explicitly
// restricts the tool name. No LLM route is registered.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { withPermissionGuidance } from "./permission-guidance.js";
import { checkCapability } from "./capability-gate.js";

// Each CLI exposes two explicit modes: `cli_<cli>_direct` (the captain drives
// the managed session) and `cli_<cli>_subagent` (a DSH Relay child forwards the
// task). The unsuffixed one-shot tools (`cli_claude_code` / `cli_qwen`) were
// removed together with their `managed-<cli>` provider: they covered only two of
// the three CLIs, carried no session, and duplicated what `cli_dispatch` already
// does for all three. Concurrency comes from the `_subagent` native mechanism,
// so no background-job plugin is needed to run several CLIs at once.
export const CLI_SUBAGENT_TOOLS = [
	{ cli: "codex", toolName: "cli_codex_direct", displayName: "Codex", mode: "session", provider: null },
	{ cli: "claude", toolName: "cli_claude_direct", displayName: "Claude Code", mode: "session", provider: null },
	{ cli: "qwen", toolName: "cli_qwen_direct", displayName: "Qwen Code", mode: "session", provider: null }
];


// Every remaining tool is session mode and takes the ManagedCliAgentsService
// path. The unsuffixed one-shot tools and their provider are gone, so there is
// no SubagentProvider branch left here.
function definition(spec, ctx, opts) {
	const naming =
		"Direct 模式：由当前主控直接调用外部 CLI 的持续会话，不创建 DSH Relay 子代理。返回 sessionId 后可用对应的 cli_<cli>_followup 工具续接同一 thread。";
	return defineTool({
		name: spec.toolName,
		description: `${naming}\n\n把一段自包含任务交给 ${spec.displayName} 执行，以原生子代理方式无头运行并返回其输出。任务必须完整、自包含，因为外部 CLI 看不到父会话上下文。当用户说「用 ${spec.displayName} 看/检查/重构/评审/处理……某事」时调用。参数：description 是主界面显示的简短标题（3-5 个词）；prompt 是完整、自包含的任务说明。无需指定模型——该 CLI 用它在插件里配置的模型。需要并发调度多个 CLI 时改用 cli_<cli>_subagent（DSH Relay 子代理，天然并行，无需后台任务插件）。

本工具会在执行前自动检查该 CLI 的配置是否已验证（所选中转商/模型能跑通）：指纹有效则直接执行，配置有变或未验证则先用当前配置实测一次，通过才执行，失败会拦截并说明原因。若返回「认证 / 401 / API key / 未配置模型 / 代理不支持」类错误，说明该 CLI 或中转商未配置好，请如实告诉用户并建议其在插件设置里配置，**不要改用 shell 直接运行 codex/claude/qwen 绕过本工具**。Codex 的测试还会额外检查供应商是否支持 responses 工具续接新接口，不支持的供应商会直接告知「该供应商不支持 Codex 所需的新接口，请更换如 modelflare」。`,
		parameters: {
			description: { type: "string", required: true, description: "用于主界面显示的简短任务标题（3-5 个词）。" },
			prompt: { type: "string", required: true, description: "完整、自包含的任务说明；外部 CLI 看不到父会话上下文。" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: (value && value.output) || "" }]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			if (!exec.agent) throw new Error(`${spec.toolName} requires a calling agent`);
			const description = typeof args.description === "string" ? args.description.trim() : "";
			const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
			if (!description) throw new Error("description 不能为空");
			if (!prompt) throw new Error("prompt 不能为空");
			// Capability gate: refuse a task this CLI structurally cannot perform
			// (e.g. a network task for Codex/Qwen) before starting any process.
			const capability = checkCapability(spec.cli, prompt);
			if (!capability.ok) throw new Error(capability.reason);
			const preflight = async () => {
				const pre = opts && opts.preflight ? await opts.preflight(spec.cli) : null;
				if (pre && !pre.ok) throw new Error(`${spec.displayName} 未通过连通测试，已拦截本次执行：${pre.error}`);
			};
			await preflight();
			const cwd = exec.agent.session?.header?.cwd;
			try {
				const value = await opts.managedCliAgents.dispatch({ cli: spec.cli, cwd, prompt, signal: exec.signal, agent: exec.agent });
				return {
					kind: "session",
					sessionId: value.session.sessionId,
					status: value.session.status,
					output: value.output
				};
			} catch (error) {
				throw withPermissionGuidance(error, spec.cli);
			}
		}
	});
}

export function registerCliSubagentTools(ctx, opts) {
	for (const spec of CLI_SUBAGENT_TOOLS) ctx.tools.register(definition(spec, ctx, opts || {}));
}
