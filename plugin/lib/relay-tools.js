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
		description: "Relay-only: forward the complete current task to the external CLI bound to this child. You must call this once per turn before report and must not answer the task yourself.",
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
