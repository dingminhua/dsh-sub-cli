// Internal Relay-only tool. Identifies the calling child by its DSH session id
// and forwards the task to the child-bound managed CLI thread.  The child knows
// its own cli (via its provider name managed-{cli}-relay), so the single shared
// tool works for all CLIs without cli parameterisation.
//
// Registration is idempotent on the same ctx (the same DSH boot registers once);
// a no-op if the tool has already been registered against that exact ctx.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { withPermissionGuidance } from "./permission-guidance.js";
import { checkCapability } from "./capability-gate.js";

export const RELAY_SUBMIT_TOOL = "managed_cli_submit";

export function registerRelaySubmitTool(ctx, service) {
	const existing = ctx?.tools?.registeredNames instanceof Set ? ctx.tools.registeredNames : null;
	if (existing && existing.has(RELAY_SUBMIT_TOOL)) return;
	if (existing) existing.add(RELAY_SUBMIT_TOOL);
	ctx.tools.register(defineTool({
		name: RELAY_SUBMIT_TOOL,
		description: "仅 CLI Relay 子代理可调用（由 cli_<cli>_subagent 创建、绑定 managed-<cli>-relay 的子代理）：把当前完整任务转发给本子代理绑定的外部 CLI。其他任何代理——主控、普通 subagent、AgentTeams 成员——一律不可调用：本工具按调用者自身会话 id 查找 CLI 绑定，未绑定的调用必然报错。绑定的 CLI Relay 子代理每回合必须先调用本工具转发任务、再报告结果，不得自行作答。",
		parameters: { prompt: { type: "string", required: true, description: "Complete task text to send to the bound external CLI." } },
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: v.output || "" }] },
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const childId = exec.agent?.session?.id;
			if (!childId) throw new Error("managed_cli_submit requires a calling relay child");
			// Capability gate on EVERY submission, not just child creation: a
			// continuable relay child lives across turns, so a later send_message
			// must not bypass the gate that cli_<cli>_subagent enforced at spawn.
			// (When dispatch/followup also call the gate this stays as the
			// authoritative refusal point for the relay channel.)
			const cli = (exec.agent?.provider || "").replace(/^managed-/, "").replace(/-relay$/, "") || "codex";
			const capability = checkCapability(cli, args.prompt);
			if (!capability.ok) throw new Error(capability.reason);
			try {
				const value = await service.submitFromChild(String(childId), args.prompt, exec.signal, exec.agent);
				return { sessionId: value.session.sessionId, status: value.session.status, output: value.output };
			} catch (error) {
				throw withPermissionGuidance(error, cli);
			}
		}
	}));
}
