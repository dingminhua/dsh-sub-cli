// A host-plane provider dedicated to DSH continuable Relay children. Binding
// happens in prepareContinuable before the child Activation can call tools.
// One provider per CLI (codex / claude / qwen) so a Relay child binds itself
// to the right managed thread without the child having to know which CLI it
// is bound to.

export class ManagedCliRelayProvider {
	constructor({ name, cli, service }) {
		this.name = name;
		this.cli = cli;
		this.service = service;
		this.inheritsParentContext = false;
		this.capabilities = Object.freeze({ outputSchema: false, depthLimit: false, toolFilter: true, persona: true });
	}
	start() {
		return Promise.reject(new Error(`${this.name} is continuable-only`));
	}
	prepareContinuable(request) {
		const childId = String(request.sessionId);
		// Approval requests are audited and presented on the parent/controller turn.
		// Delegated child approval policy is intentionally pinned to never, so the
		// Relay may forward requests but can never approve its own escalation.
		this.service.bindChild(childId, { cli: this.cli, parentAgent: request.parent ?? null });
		this.service.setChildCwd(childId, request.parent?.session?.header?.cwd);
		return Promise.resolve({ seed: [] });
	}
}

// Back-compat: kept so existing imports continue to work; new code should
// construct ManagedCliRelayProvider directly.
export class ManagedCodexRelayProvider extends ManagedCliRelayProvider {
	constructor({ name = "managed-codex-relay", service } = {}) {
		super({ name, cli: "codex", service });
	}
}

export function registerManagedCodexRelayProvider(ctx, service) {
	const provider = new ManagedCodexRelayProvider({ service });
	ctx.subagents.registerProvider(provider);
	return provider;
}

export function registerManagedCliRelayProvider(ctx, { cli, service }) {
	if (!cli || typeof cli !== "string") throw new TypeError("registerManagedCliRelayProvider requires { cli }");
	const provider = new ManagedCliRelayProvider({ name: `managed-${cli}-relay`, cli, service });
	ctx.subagents.registerProvider(provider);
	return provider;
}
