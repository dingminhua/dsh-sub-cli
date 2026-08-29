// Internal Relay-only tool. It identifies the calling child by its DSH session
// id and forwards every task to the child-bound managed CLI thread.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { withPermissionGuidance } from "./permission-guidance.js";

export const RELAY_SUBMIT_TOOL = "managed_cli_submit";

export function registerRelaySubmitTool(ctx, service) {
	ctx.tools.register(defineTool({
		name: RELAY_SUBMIT_TOOL,
		description: "Relay-only: forward the complete current task to the external CLI bound to this child. You must call this once per turn before report and must not answer the task yourself.",
		parameters: { prompt: { type: "string", required: true, description: "Complete task text to send to the bound external CLI." } },
		output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: v.output || "" }] },
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const childId = exec.agent?.session?.id;
			if (!childId) throw new Error("managed_cli_submit requires a calling relay child");
			try {
				const value = await service.submitFromChild(String(childId), args.prompt, exec.signal, exec.agent);
				return { sessionId: value.session.sessionId, status: value.session.status, output: value.output };
			} catch (error) {
				throw withPermissionGuidance(error, "codex");
			}
		}
	}));
}
