// A host-plane provider dedicated to DSH continuable Relay children. Binding
// happens in prepareContinuable before the child Activation can call tools.

export class ManagedCodexRelayProvider {
	constructor({ name = "managed-codex-relay", service }) {
		this.name = name;
		this.service = service;
		this.inheritsParentContext = false;
		this.capabilities = Object.freeze({ outputSchema: false, depthLimit: false, toolFilter: true, persona: true });
	}
	start() {
		return Promise.reject(new Error("managed-codex-relay is continuable-only"));
	}
	prepareContinuable(request) {
		const childId = String(request.sessionId);
		// Approval requests are audited and presented on the parent/controller turn.
		// Delegated child approval policy is intentionally pinned to never, so the
		// Relay may forward requests but can never approve its own escalation.
		this.service.bindChild(childId, { cli: "codex", parentAgent: request.parent ?? null });
		this.service.setChildCwd(childId, request.parent?.session?.header?.cwd);
		return Promise.resolve({ seed: [] });
	}
}

export function registerManagedCodexRelayProvider(ctx, service) {
	const provider = new ManagedCodexRelayProvider({ service });
	ctx.subagents.registerProvider(provider);
	return provider;
}
