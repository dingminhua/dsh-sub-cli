// Model-facing external CLI delegation tools, registered on the Host tools
// registry so every Agent preset sees them unless that preset explicitly
// restricts the tool name. Codex delegates through the validated app-server
// provider; Claude/Qwen keep their one-shot providers. No LLM route is registered.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { MANAGED_PROVIDERS } from "./provider.js";

export const CLI_SUBAGENT_TOOLS = [
	{ cli: "codex", toolName: "cli_codex", displayName: "Codex", provider: "managed-codex-app-server" },
	{ cli: "claude", toolName: "cli_claude_code", displayName: "Claude Code", provider: "managed-claude" },
	{ cli: "qwen", toolName: "cli_qwen", displayName: "Qwen Code", provider: "managed-qwen" }
];

export { MANAGED_PROVIDERS };

function outputText(result) {
	return (result.output || []).filter((block) => block && block.type === "text").map((block) => block.text).join("");
}

async function settleForeground(run) {
	try {
		const result = await run.result;
		const text = outputText(result);
		if (result.stopReason !== "completed") throw new Error(result.diagnostic || `CLI 工作结束：${String(result.stopReason)}`);
		return { kind: "foreground", runId: run.id, output: text };
	} finally {
		try { await run.dispose(); } catch {}
	}
}

async function settleBackground(start, signal) {
	let run;
	try {
		run = await start;
		const result = await run.result;
		const text = outputText(result);
		if (result.stopReason === "completed") return { status: "completed", output: text };
		if (result.stopReason === "aborted" || signal.aborted) return { status: "killed", detail: "CLI 任务已取消", output: text };
		return { status: "failed", detail: result.diagnostic || `CLI 工作结束：${String(result.stopReason)}`, output: text };
	} catch (error) {
		return signal.aborted ? { status: "killed", detail: "CLI 任务已取消" } : { status: "failed", detail: String(error) };
	} finally {
		if (run) try { await run.dispose(); } catch {}
	}
}

function definition(spec, ctx, opts) {
	const isSessionCli = spec.cli === "codex" && opts.managedCliAgents;
	return defineTool({
		name: spec.toolName,
		description: `把一段自包含任务交给 ${spec.displayName} 执行，以原生子代理方式无头运行并返回其输出。任务必须完整、自包含，因为外部 CLI 看不到父会话上下文。当用户说「用 ${spec.displayName} 看/检查/重构/评审/处理……某事」时调用。参数：description 是主界面显示的简短标题（3-5 个词）；prompt 是完整、自包含的任务说明。无需指定模型——该 CLI 用它在插件里配置的模型。长任务可传 run_in_background:true，立即返回后台 jobId；之后用 job_output 增量读取、用 job_kill 取消。所有托管 CLI 都使用同一套后台任务机制。

本工具会在执行前自动检查该 CLI 的配置是否已验证（所选中转商/模型能跑通）：指纹有效则直接执行，配置有变或未验证则先用当前配置实测一次，通过才执行，失败会拦截并说明原因。若返回「认证 / 401 / API key / 未配置模型 / 代理不支持」类错误，说明该 CLI 或中转商未配置好，请如实告诉用户并建议其在插件设置里配置，**不要改用 shell 直接运行 codex/claude/qwen 绕过本工具**。Codex 的测试还会额外检查供应商是否支持 responses 工具续接新接口，不支持的供应商会直接告知「该供应商不支持 Codex 所需的新接口，请更换如 modelflare」。`,
		parameters: {
			description: { type: "string", required: true, description: "用于主界面显示的简短任务标题（3-5 个词）。" },
			prompt: { type: "string", required: true, description: "完整、自包含的任务说明；外部 CLI 看不到父会话上下文。" },
			run_in_background: { type: "boolean", description: "长任务设为 true：立即返回后台 jobId；用 job_output 读取进展、job_kill 取消。默认 false。" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: value && value.kind === "background" ? `已启动 ${spec.displayName} 后台任务 ${value.jobId}；用 job_output 读取输出，用 job_kill 取消。` : (value && value.output) || "" }]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			if (!exec.agent) throw new Error(`${spec.toolName} requires a calling agent`);
			const description = typeof args.description === "string" ? args.description.trim() : "";
			const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
			if (!description) throw new Error("description 不能为空");
			if (!prompt) throw new Error("prompt 不能为空");
			const preflight = async () => {
				const pre = opts && opts.preflight ? await opts.preflight(spec.cli) : null;
				if (pre && !pre.ok) throw new Error(`${spec.displayName} 未通过连通测试，已拦截本次执行：${pre.error}`);
			};
			if (isSessionCli) {
				if (args.run_in_background === true) throw new Error("Codex 持续会话暂不使用 jobs；请前台创建会话，再用 cli_codex_followup 继续同一 thread。");
				await preflight();
				const cwd = exec.agent.session?.header?.cwd;
				const value = await opts.managedCliAgents.dispatch({ cli: "codex", cwd, prompt, signal: exec.signal });
				return {
					kind: "session",
					sessionId: value.session.sessionId,
					status: value.session.status,
					output: value.output
				};
			}
			const request = (signal) => ctx.subagents.start(spec.provider, {
				label: description,
				prompt: [{ type: "text", text: prompt }],
				parent: exec.agent,
				signal
			});
			if (args.run_in_background === true) {
				const jobs = ctx.get && ctx.get("jobs");
				if (!jobs) throw new Error("后台任务不可用：当前 Agent 组合未加载 @deepseek-ai/dsh-tool-jobs");
				const jobId = jobs.start({
					kind: `cli-${spec.cli}`,
					label: description,
					owner: exec.agent,
					run: () => {
						const controller = new AbortController();
						const started = preflight().then(() => request(controller.signal));
						return {
							cancel: (reason) => controller.abort(reason || `${spec.displayName} 后台任务已取消`),
							done: settleBackground(started, controller.signal)
						};
					}
				});
				return { kind: "background", cli: spec.cli, jobId };
			}
			await preflight();
			return settleForeground(await request(exec.signal));
		}
	});
}

export function registerCliSubagentTools(ctx, opts) {
	for (const spec of CLI_SUBAGENT_TOOLS) ctx.tools.register(definition(spec, ctx, opts || {}));
}
