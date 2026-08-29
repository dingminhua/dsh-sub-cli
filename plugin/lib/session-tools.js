// Model-facing continuation controls for managed external CLI sessions.
// These are plugin-specific tools, not DSH native send_message semantics.

import { defineTool } from "@deepseek-ai/dsh-tools";

function sessionOutput(value) {
	return { sessionId: value.session.sessionId, status: value.session.status, output: value.output };
}

export function registerManagedSessionTools(ctx, service) {
	ctx.tools.register(defineTool({
		name: "cli_codex_followup",
		description: "继续一个由 cli_codex 创建的 Codex 会话，把新任务发送到同一个真实 Codex thread。它不是 DSH 原生 send_message；必须传 cli_codex 首轮返回的 sessionId。",
		parameters: {
			sessionId: { type: "string", required: true, description: "cli_codex 返回的稳定会话 ID。" },
			prompt: { type: "string", required: true, description: "发送给同一个 Codex thread 的后续任务。" }
		},
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: v.output || "" }] },
		isConcurrencySafe: () => true,
		execute: async (args, exec) => sessionOutput(await service.followup(args.sessionId, args.prompt, exec.signal))
	}));
	ctx.tools.register(defineTool({
		name: "cli_codex_status",
		description: "读取一个托管 Codex 会话的状态、工作目录、模型、权限和最近错误；不运行新回合。",
		parameters: { sessionId: { type: "string", required: true, description: "cli_codex 返回的会话 ID。" } },
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
		execute: async (args) => service.status(args.sessionId)
	}));
	ctx.tools.register(defineTool({
		name: "cli_codex_sessions",
		description: "列出当前 Host 中已登记的 Codex 持续会话，按最近更新时间排序；不包含 API Key。",
		parameters: {},
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
		execute: async () => ({ sessions: service.list({ cli: "codex" }) })
	}));
	ctx.tools.register(defineTool({
		name: "cli_codex_interrupt",
		description: "中断一个托管 Codex 会话当前正在运行的 turn，但保留 thread，之后仍可使用 cli_codex_followup。",
		parameters: { sessionId: { type: "string", required: true, description: "cli_codex 返回的会话 ID。" } },
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
		execute: async (args) => service.interrupt(args.sessionId)
	}));
}
