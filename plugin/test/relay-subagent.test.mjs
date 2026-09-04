import assert from "node:assert/strict";
import test from "node:test";
import { attachRelayLifecycle, registerManagedCliSubagentTools, relayPersonaFor } from "../lib/relay-subagent.js";
import { ManagedCliRelayProvider } from "../lib/relay-provider.js";

function toolFixture() {
	// registerManagedCliSubagentTools registers one tool per CLI; keep them by
	// name so the codex assertions below still target cli_codex_subagent.
	const tools = new Map();
	let request;
	const ctx = {
		tools: { register(v) { tools.set(v.name, v); } },
		subagents: { async startContinuable(v) { request = v; return { childId: "child-1" }; } }
	};
	const service = {};
	registerManagedCliSubagentTools(ctx, async () => ({ ok: true }));
	return { ctx, get tool() { return tools.get("cli_codex_subagent"); }, get request() { return request; } };
}

test("relayPersonaFor generates the right persona for each CLI", () => {
	assert.match(relayPersonaFor("codex"), /Codex/);
	assert.match(relayPersonaFor("claude"), /Claude Code/);
	// unknown cli falls back to Codex (legacy compat)
	assert.match(relayPersonaFor("unknown"), /Codex/);
	for (const persona of [relayPersonaFor("codex"), relayPersonaFor("claude")]) {
		assert.match(persona, /must call managed_cli_submit/);
		assert.match(persona, /relay bridge/);
		// round-15: the persona now states up front that re-delegation is
		// denied at the execution layer, not merely discouraged.
		assert.match(persona, /denied at the execution layer/);
	}
});

test("cli_codex_subagent creates a continuable relay with restricted tools", async () => {
	const f = toolFixture();
	const agent = { session: { header: { cwd: "/repo" } } };
	const value = await f.tool.execute({ description: "Codex 审查", prompt: "review" }, { agent, signal: new AbortController().signal });
	assert.deepEqual(value, { kind: "continuable", subagentId: "child-1" });
	assert.equal(f.request.provider, "managed-codex-relay");
	assert.equal(f.request.label, "Codex 审查");
	assert.equal(f.request.request.parent, agent);
	assert.deepEqual(f.request.request.toolFilter, { allow: ["managed_cli_submit"] });
	assert.match(f.request.request.persona, /relay bridge/);
	assert.match(f.request.request.persona, /must call/);
});

test("registerManagedCliSubagentTools registers 2 CLI Relay tools", () => {
	const tools = [];
	const ctx = {
		tools: { register(v) { tools.push(v.name); } },
		subagents: { async startContinuable() { return { childId: "x" }; } }
	};
	const service = {};
	registerManagedCliSubagentTools(ctx, async () => ({ ok: true }));
	assert.deepEqual(tools.sort(), ["cli_claude_subagent", "cli_codex_subagent"]);
});

test("each registered CLI subagent tool binds the matching Relay provider", async () => {
	const seen = [];
	const tools = [];
	const ctx = {
		tools: { register(v) { tools.push(v); } },
		subagents: { async startContinuable(v) { seen.push({ provider: v.provider, persona: v.request.persona }); return { childId: v.provider + "-x" }; } }
	};
	const service = {};
	registerManagedCliSubagentTools(ctx, async () => ({ ok: true }));
	for (const tool of tools) {
		await tool.execute({ description: "test", prompt: "do" }, { agent: { session: { header: {} } }, signal: new AbortController().signal });
	}
	const byProvider = Object.fromEntries(seen.map((s) => [s.provider, s]));
	assert.ok(byProvider["managed-codex-relay"], "codex Relay tool should bind managed-codex-relay");
	assert.ok(byProvider["managed-claude-relay"], "claude Relay tool should bind managed-claude-relay");
	assert.match(byProvider["managed-claude-relay"].persona, /Claude Code/);
});

test("ManagedCliRelayProvider binds the child to the right CLI", () => {
	const bound = [];
	const provider = new ManagedCliRelayProvider({ name: "managed-claude-relay", cli: "claude", service: { bindChild(id, opts) { bound.push({ id, cli: opts.cli }); }, setChildCwd() {} } });
	provider.prepareContinuable({ sessionId: "child-42", parent: { session: { header: { cwd: "/work" } } } });
	assert.deepEqual(bound, [{ id: "child-42", cli: "claude" }]);
	assert.equal(provider.name, "managed-claude-relay");
});

test("ManagedCliRelayProvider.start rejects (continuable-only)", async () => {
	const provider = new ManagedCliRelayProvider({ name: "managed-claude-relay", cli: "claude", service: {} });
	await assert.rejects(provider.start(), /continuable-only/);
});

test("relay lifecycle installs submit-before-report guard with disposer", () => {
	let contribution, startListener;
	const service = {
		beginChildEpoch() {},
		childCanReport(id) { return id === "allowed"; }
	};
	const ctx = {
		on(name, fn) { if (name === "subagent/start") startListener = fn; },
		subagents: { registerContinuableSetup(fn) { contribution = fn; } }
	};
	attachRelayLifecycle(ctx, service);
	assert.equal(typeof contribution, "function");
	let guard;
	const dispose = () => {};
	const returned = contribution({ tools: { guard(fn) { guard = fn; return dispose; } } });
	assert.equal(returned, dispose);
	assert.match(guard({ name: "report", agent: { session: { id: "blocked" } } }), /has not called/);
	assert.equal(guard({ name: "report", agent: { session: { id: "allowed" } } }), undefined);
	assert.equal(guard({ name: "managed_cli_submit", agent: { session: { id: "blocked" } } }), undefined);
	startListener({ id: "allowed" });
});

test("relay guard denies every tool outside the relay allowlist (round-15 re-delegation fix)", () => {
	let contribution;
	const service = { beginChildEpoch() {}, childCanReport() { return true; } };
	const ctx = {
		on() {},
		subagents: { registerContinuableSetup(fn) { contribution = fn; } }
	};
	attachRelayLifecycle(ctx, service);
	let guard;
	contribution({ tools: { guard(fn) { guard = fn; return () => {}; } } });
	// The exact escape observed live in round 15 was the native `subagent`
	// tool (its grandchild inherited the captain's sandbox and wrote the
	// file); everything except the two allowed names must be denied.
	for (const name of ["subagent", "subagent_fork", "write", "bash", "read", "glob", "edit", "send_message", "run_code", "skill"]) {
		assert.match(
			guard({ name, agent: { session: { id: "allowed" } } }),
			/may only call managed_cli_submit and report/,
			`tool "${name}" should be denied by the allowlist guard`
		);
	}
	// The two allowed tools pass the allowlist untouched (report ordering is
	// still enforced by the same guard's later branch, tested above).
	assert.equal(guard({ name: "managed_cli_submit", agent: { session: { id: "allowed" } } }), undefined);
	assert.equal(guard({ name: "report", agent: { session: { id: "allowed" } } }), undefined);
});

test("relay guard fails closed on a malformed exec without a tool name", () => {
	let contribution;
	const ctx = {
		on() {},
		subagents: { registerContinuableSetup(fn) { contribution = fn; } }
	};
	attachRelayLifecycle(ctx, { beginChildEpoch() {} });
	let guard;
	contribution({ tools: { guard(fn) { guard = fn; return () => {}; } } });
	// An exec with no name (or a non-string name) must never slip through the
	// allowlist: undefined !== "managed_cli_submit" && !== "report" → denied.
	assert.match(guard({ agent: { session: { id: "allowed" } } }), /may only call/);
});

test("relay lifecycle releases the CLI subprocess when a residency epoch ends", async () => {
	const released = [];
	const listeners = {};
	const ctx = { on: (event, listener) => { listeners[event] = listener; }, subagents: {} };
	attachRelayLifecycle(ctx, { beginChildEpoch: () => {}, releaseChild: async (id) => { released.push(id); return { released: true }; } });
	assert.equal(typeof listeners["subagent/end"], "function");
	listeners["subagent/end"]({ id: "child-epoch-1" });
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(released, ["child-epoch-1"]);
});

test("relay lifecycle ignores epoch end without a child id", async () => {
	const released = [];
	const listeners = {};
	const ctx = { on: (event, listener) => { listeners[event] = listener; }, subagents: {} };
	attachRelayLifecycle(ctx, { beginChildEpoch: () => {}, releaseChild: async (id) => { released.push(id); } });
	listeners["subagent/end"]({});
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(released, []);
});
