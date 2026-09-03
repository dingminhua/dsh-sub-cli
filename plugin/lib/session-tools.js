// Model-facing continuation controls for managed external CLI sessions.
// These are plugin-specific tools, not DSH native send_message semantics.
// Generated for all session-capable CLI backends (codex, claude).

import { defineTool } from "@deepseek-ai/dsh-tools";

const CLI_IDS = ["codex", "claude"];

function sessionOutput(value) {
	return { sessionId: value.session.sessionId, status: value.session.status, output: value.output };
}

function toolFor(ctx, service, cli) {
	const displayName = cli === "codex" ? "Codex" : "Claude Code";
	const safe = cli; // tool name prefix

	ctx.tools.register(defineTool({
		name: `cli_${safe}_followup`,
		description: `继续一个由 cli_${safe} 创建的 ${displayName} 会话，把新任务发送到同一个真实 thread。它不是 DSH 原生 send_message；必须传 cli_${safe} 首轮返回的 sessionId。`,
		parameters: {
			sessionId: { type: "string", required: true, description: `cli_${safe} 返回的稳定会话 ID。` },
			prompt: { type: "string", required: true, description: "发送给同一个 session thread 的后续任务。" }
		},
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: v.output || "" }] },
		isConcurrencySafe: () => true,
		execute: async (args, exec) => sessionOutput(await service.followup(args.sessionId, args.prompt, exec.signal))
	}));

	ctx.tools.register(defineTool({
		name: `cli_${safe}_status`,
		description: `读取一个托管 ${displayName} 会话的状态、工作目录、模型、权限和最近错误；不运行新回合。`,
		parameters: { sessionId: { type: "string", required: true, description: `cli_${safe} 返回的会话 ID。` } },
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
		execute: async (args, _exec) => service.status(args.sessionId)
	}));

	ctx.tools.register(defineTool({
		name: `cli_${safe}_sessions`,
		description: `列出当前 Host 中已登记的 ${displayName} 持续会话，按最近更新时间排序；不包含 API Key。`,
		parameters: {},
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
		execute: async () => ({ sessions: service.list({ cli }) })
	}));

	ctx.tools.register(defineTool({
		name: `cli_${safe}_interrupt`,
		description: `中断一个托管 ${displayName} 会话当前正在运行的 turn，但保留 thread，之后仍可使用 cli_${safe}_followup。`,
		parameters: { sessionId: { type: "string", required: true, description: `cli_${safe} 返回的会话 ID。` } },
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
		execute: async (args, _exec) => service.interrupt(args.sessionId)
	}));
}

export function registerManagedSessionTools(ctx, service) {
	for (const cli of CLI_IDS) toolFor(ctx, service, cli);
}
