// Model-facing external CLI delegation tools.
//
// These tools deliberately delegate through DSH's shared subagent registry.
// The host provider owns process startup/cancellation and the built-in DSH UI
// owns lifecycle presentation. This module does not create a second task store.

import { defineTool } from "@deepseek-ai/dsh-tools";

export const CLI_SUBAGENT_TOOLS = [
	{
		cli: "codex",
		provider: "codex",
		toolName: "cli_codex",
		displayName: "Codex"
	},
	{
		cli: "claude",
		provider: "claude-code",
		toolName: "cli_claude_code",
		displayName: "Claude Code"
	}
];

function outputText(blocks) {
	return blocks.filter((block) => block && block.type === "text").map((block) => block.text).join("");
}

function stopReasonError(result) {
	switch (result.stopReason) {
		case "completed": return null;
		case "aborted": return "CLI 工作已取消";
		case "max-tokens": return "CLI 工作达到上下文或 token 上限";
		case "refusal": return "CLI 拒绝了该工作";
		case "error": return "CLI 工作失败";
		default: return `CLI 工作异常结束：${String(result.stopReason)}`;
	}
}

async function settleRun(run) {
	let result;
	let resultError;
	try {
		result = await run.result;
		const error = stopReasonError(result);
		if (error) {
			const diagnostic = result.diagnostic ? `\nDiagnostic: ${result.diagnostic}` : "";
			const partial = outputText(result.output || []);
			throw new Error(`${error}${diagnostic}${partial ? `\n部分输出：\n${partial}` : ""}`);
		}
	} catch (error) {
		resultError = error;
	}

	let disposeError;
	try {
		await run.dispose();
	} catch (error) {
		disposeError = error;
	}

	if (resultError && disposeError) throw new AggregateError([resultError, disposeError], "CLI 工作失败且清理进程失败");
	if (resultError) throw resultError;
	if (disposeError) throw disposeError;
	return {
		runId: run.id,
		output: result.output || []
	};
}

function toolDefinition(spec, ctx) {
	return defineTool({
		name: spec.toolName,
		description: `将一个自包含的软件开发任务委派给 ${spec.displayName}。由主控 AI 决定何时调用；description 是显示在主界面中的简短工作标题。执行过程进入 DSH 原生 subagent 生命周期，完成结果自动返回主控。`,
		parameters: {
			description: {
				type: "string",
				required: true,
				description: "用于主界面显示的简短任务标题（3-5 个词）。"
			},
			prompt: {
				type: "string",
				required: true,
				description: "完整、自包含的任务说明。外部 CLI 看不到当前对话上下文。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					runId: { type: "string", required: true },
					output: { type: "array", required: true, items: { type: "json" } }
				}
			},
			render: (_args, value) => [{ type: "text", text: outputText(value.output) }]
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
			return settleRun(run);
		}
	});
}

/** Register a tool only while its matching host provider is available. */
export function registerCliSubagentTools(ctx) {
	const disposers = new Map();

	function mount(spec) {
		if (disposers.has(spec.provider)) return;
		if (!ctx.subagents.getProvider(spec.provider)) return;
		disposers.set(spec.provider, ctx.tools.register(toolDefinition(spec, ctx)));
	}

	function unmount(provider) {
		const dispose = disposers.get(provider);
		if (!dispose) return;
		disposers.delete(provider);
		dispose();
	}

	for (const spec of CLI_SUBAGENT_TOOLS) mount(spec);
	ctx.on("subagent/provider-added", (provider) => {
		const spec = CLI_SUBAGENT_TOOLS.find((entry) => entry.provider === provider.name);
		if (spec) mount(spec);
	});
	ctx.on("subagent/provider-removed", (provider) => unmount(provider));
	ctx.effect(() => () => {
		for (const dispose of disposers.values()) dispose();
		disposers.clear();
	});
}
