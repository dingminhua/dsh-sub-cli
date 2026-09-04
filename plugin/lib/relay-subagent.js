// Public Subagent-mode (Relay) tool per CLI and Relay lifecycle policy. The
// child is a real DSH continuable Agent; its only work tool is
// managed_cli_submit. Per-CLI providers (managed-codex-relay /
// managed-claude-relay / managed-qwen-relay) are registered by index.js
// against the same ManagedCliAgentsService.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { RELAY_SUBMIT_TOOL } from "./relay-tools.js";
import { AUTHORIZATION_DISCIPLINE } from "./permission-guidance.js";

export function relayPersonaFor(cli) {
	const name = cli === "claude" ? "Claude Code" : "Codex";
	return `You are a relay bridge to an external ${name} CLI agent, not the task executor.
For every user message, you must call managed_cli_submit exactly once with the complete task. Do not use your own knowledge to answer, do not inspect or modify files yourself, and do not claim work that ${name} did not perform. You have no other tools: spawning subagents, running commands, or writing files yourself is denied at the execution layer and will fail — forward everything through managed_cli_submit. After managed_cli_submit returns, faithfully report its result to the parent using report. A report before managed_cli_submit is rejected.`;
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
	// Hard allowlist (execution layer, round-15 fix; round-17 re-anchor after
	// the upstream 0.1.2-rc.1 subagent runtime rewrite). The schema-level
	// toolFilter (allow: [managed_cli_submit]) masks only the INHERITED tool
	// surface: agent-plane (preset-contributed) tools are registered in the
	// child's OWN layer, which toolFilter restrictions never strip — `subagent`
	// stayed visible to relay children even after upstream fixed restrictions
	// to filter ancestor layers (verified live: a relay child's LLM request
	// listed managed_cli_submit + report + subagent on DSH 0.1.2-rc.1). A
	// re-delegation through the native `subagent` tool hands the task to a
	// grandchild that inherits the captain's sandbox — bypassing the external
	// CLI's permission tier entirely (observed live: a read-only-tier write
	// succeeded because the relay's grandchild wrote the file 21 seconds before
	// the CLI even spawned; the CLI then "verified" the pre-written file and
	// returned OK). Guards run on every tool execution and cannot be
	// force-allowed by another guard, so they are the reliable boundary:
	// allow exactly the submit tool and report.
	const relayGuard = (exec) => {
		// The global channel (fallback for runtimes without
		// registerContinuableSetup) fires for EVERY agent in the process, so
		// scope it by Relay binding: only a bound relay child is constrained.
		const childId = exec.agent?.session?.id;
		if (!childId || !service.isRelayChild(String(childId))) return undefined;
		if (exec.name !== RELAY_SUBMIT_TOOL && exec.name !== "report") {
			return `Relay children may only call ${RELAY_SUBMIT_TOOL} and report. Tool "${exec.name}" is denied: re-delegating the task to another agent would bypass the external CLI's permission tier. Forward the complete task with ${RELAY_SUBMIT_TOOL} instead.`;
		}
		if (exec.name !== "report") return undefined;
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
	};
	if (typeof ctx.subagents?.registerContinuableSetup === "function") {
		// DSH <= 0.1.1: per-child setup channel installs the guard into each
		// relay child's own scope. Preferred when available.
		ctx.subagents.registerContinuableSetup((childCtx) => {
			const guard = childCtx.tools.guard(relayGuard);
			return typeof guard === "function" ? guard : () => {};
		});
	} else if (typeof ctx.tools?.guard === "function") {
		// DSH 0.1.2+: registerContinuableSetup and its setupRegistry were
		// removed (child composition is now inlined by the subagent runtime,
		// with no provider hook into the child scope). A plain-context
		// tools.guard() applies to every agent in this Host process, so the
		// binding predicate inside relayGuard is what keeps it scoped to
		// relay children. Fail loud rather than silently running unguarded.
		ctx.tools.guard(relayGuard);
	} else {
		throw new Error("dsh-sub-cli relay guard unavailable: this DSH exposes neither subagents.registerContinuableSetup nor tools.guard");
	}
}

function registerCliSubagentTool(ctx, { cli, displayName, preflight }) {
	ctx.tools.register(defineTool({
		name: `cli_${cli}_subagent`,
		description: `创建一个 DSH 原生可持续 ${displayName} Relay 子代理。该子代理只负责把任务转发给真实 ${displayName} thread并报告结果；返回 subagentId 后可用 send_message 继续、interrupt_agent 中断。适合需要子代理卡片、Transcript 和持续协作的任务。\n\n${AUTHORIZATION_DISCIPLINE}`,
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
	{ cli: "claude", displayName: "Claude Code" }
];

export function registerManagedCliSubagentTools(ctx, preflight) {
	for (const spec of SUPPORTED_CLIS) registerCliSubagentTool(ctx, { ...spec, preflight });
}
