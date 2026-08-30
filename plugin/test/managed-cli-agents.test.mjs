import assert from "node:assert/strict";
import test from "node:test";
import { ManagedCliAgentsService, looksPrematureOutput, AUTO_CONTINUE_MAX, AUTO_CONTINUE_PROMPT } from "../lib/managed-cli-agents.js";

// Permission profile that grants every capability with approval=ask, so tests
// that exercise the approval seam actually reach it (the default read-only
// profile would have the capability gate auto-reject first).
const ASK_ALL = { read: true, write: true, exec: true, network: true, approval: "ask" };

function deferred() { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; }
function driverFixture() {
	const calls = [];
	let followups = [];
	let interrupted = 0;
	let disposed = 0;
	const run = {
		remoteSessionId: "thread-1",
		result: Promise.resolve({ threadId: "thread-1", text: "first", stopReason: "completed" }),
		async followup(prompt) { followups.push(prompt); return { threadId: "thread-1", text: `next:${prompt}`, stopReason: "completed" }; },
		async interrupt() { interrupted++; return true; },
		async dispose() { disposed++; }
	};
	return {
		driver: { async start(input) { calls.push(input); return run; } },
		calls, followups,
		get interrupted() { return interrupted; }, get disposed() { return disposed; }
	};
}

test("dispatch records a real remote thread and returns a stable session", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({ drivers: { codex: f.driver }, routeSource: () => ({ provider: "p", model: "m", reasoningEffort: "high" }), permissionSource: () => "workspace-write" });
	const value = await service.dispatch({ cwd: "/repo", prompt: "first" });
	assert.match(value.session.sessionId, /^cli-codex-/);
	assert.equal(value.session.remoteSessionId, "thread-1");
	assert.equal(value.session.status, "ready");
	assert.equal(value.output, "first");
	assert.equal(f.calls[0].sandbox, "workspace-write");
	assert.equal(f.calls[0].model, "m");
});

test("dispatch exposes awaiting permission and clears it after an audited decision", async () => {
	const approval = deferred();
	let input;
	const driver = { async start(value) {
		input = value;
		return { remoteSessionId: "thread-p", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-p", remoteRequestId: "remote-p", cli: "codex", turnId: "turn-p", itemId: "item-p", capability: "permissions", operation: "item/permissions/requestApproval", target: "/repo", reason: "network", createdAt: new Date().toISOString() });
			return { threadId: "thread-p", text: outcome };
		})(), dispose: async () => {} };
	} };
	const agent = { session: { id: "parent" } };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, permissionSource: () => ASK_ALL, approvalRequest: async (request, context) => { assert.equal(context.agent, agent); assert.equal(request.pluginSessionId.startsWith("cli-codex-"), true); return approval.promise; } });
	const pending = service.dispatch({ cwd: "/repo", prompt: "first", agent, childId: "child-p" });
	await new Promise((r) => setImmediate(r));
	const open = service.list()[0];
	assert.equal(input.approvalPolicy, "on-request");
	assert.equal(open.status, "awaiting_permission");
	assert.equal(open.pendingPermission.requestId, "req-p");
	assert.equal(open.pendingPermission.turnId, "turn-p");
	approval.resolve("allowed-once");
	const done = await pending;
	assert.equal(done.output, "allowed-once");
	assert.equal(done.session.pendingPermission, null);
	assert.equal(done.session.lastPermissionDecision.requestId, "req-p");
	assert.equal(done.session.lastPermissionDecision.outcome, "allowed-once");
	assert.equal(done.session.status, "ready");
});

test("relay permission approval is routed through the bound parent agent", async () => {
	const childAgent = { session: { id: "child-agent" } };
	const parentAgent = { session: { id: "parent-agent" } };
	let approvedBy;
	const driver = { async start(value) {
		return { remoteSessionId: "thread-parent", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-parent", cli: "codex", turnId: "turn-parent", itemId: "item-parent", capability: "command", operation: "command", createdAt: new Date().toISOString() });
			return { threadId: "thread-parent", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, permissionSource: () => ASK_ALL, approvalRequest: async (_request, context) => { approvedBy = context.agent; return "allowed-once"; } });
	service.bindChild("child-agent", { cli: "codex", parentAgent });
	service.setChildCwd("child-agent", "/repo");
	const value = await service.submitFromChild("child-agent", "task", undefined, childAgent);
	assert.equal(value.output, "allowed-once");
	assert.equal(approvedBy, parentAgent);
	assert.equal("parentAgent" in service.childBinding("child-agent"), false);
});

test("a second permission request is rejected while one is pending", async () => {
	const approval = deferred();
	let secondError;
	const driver = { async start(value) {
		return { remoteSessionId: "thread-b", result: (async () => {
			const first = value.onPermissionRequest({ requestId: "req-1", cli: "codex", turnId: "turn-b", itemId: "item-1", capability: "permissions", operation: "one", createdAt: new Date().toISOString() });
			try { await value.onPermissionRequest({ requestId: "req-2", cli: "codex", turnId: "turn-b", itemId: "item-2", capability: "command", operation: "two", createdAt: new Date().toISOString() }); }
			catch (error) { secondError = error; }
			await first;
			return { threadId: "thread-b", text: "done" };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, permissionSource: () => ASK_ALL, approvalRequest: () => approval.promise });
	const pending = service.dispatch({ cwd: "/repo", prompt: "first", agent: { session: { id: "parent" } } });
	await new Promise((r) => setImmediate(r));
	assert.equal(secondError.code, "PERMISSION_REQUEST_BUSY");
	assert.equal(service.list()[0].pendingPermission.requestId, "req-1");
	approval.resolve("rejected");
	await pending;
});

test("followup uses the same live driver run and status/list are secret-free", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({ drivers: { codex: f.driver } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const next = await service.followup(first.session.sessionId, "second");
	assert.equal(next.output, "next:second");
	assert.deepEqual(f.followups, ["second"]);
	assert.equal(service.status(first.session.sessionId).remoteSessionId, "thread-1");
	assert.equal(service.list().length, 1);
	assert.equal("apiKey" in service.status(first.session.sessionId), false);
});

test("concurrent followup is rejected with SESSION_BUSY", async () => {
	const gate = deferred();
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), followup: () => gate.promise, interrupt: async () => true, dispose: async () => {} }; } } } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const pending = service.followup(first.session.sessionId, "slow");
	await new Promise((r) => setImmediate(r));
	await assert.rejects(service.followup(first.session.sessionId, "overlap"), (error) => error.code === "SESSION_BUSY");
	gate.resolve({ threadId: "t", text: "done" });
	await pending;
});

test("relay child binding creates then follows up the same managed session", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({ drivers: { codex: f.driver } });
	service.bindChild("child-1", { cli: "codex" });
	service.setChildCwd("child-1", "/repo");
	service.beginChildEpoch("child-1");
	assert.equal(service.childCanReport("child-1"), false);
	const first = await service.submitFromChild("child-1", "first");
	assert.equal(first.output, "first");
	assert.equal(service.childCanReport("child-1"), true);
	const binding = service.childBinding("child-1");
	assert.equal(binding.sessionId, first.session.sessionId);
	const second = await service.submitFromChild("child-1", "second");
	assert.equal(second.output, "next:second");
	assert.equal(service.childBinding("child-1").sessionId, first.session.sessionId);
});

test("interrupt clears a pending permission and marks the session interrupted", async () => {
	const approval = deferred();
	let interruptResolve;
	const interruptedResult = new Promise((resolve) => { interruptResolve = resolve; });
	const driver = { async start(value) {
		return {
			remoteSessionId: "thread-i",
			result: (async () => { await value.onPermissionRequest({ requestId: "req-i", cli: "codex", turnId: "turn-i", itemId: "item-i", capability: "command", operation: "command", createdAt: new Date().toISOString() }); return interruptedResult; })(),
			async interrupt() { approval.resolve("cancelled"); interruptResolve({ threadId: "thread-i", text: "cancelled" }); return true; },
			async dispose() {}
		};
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, permissionSource: () => ASK_ALL, approvalRequest: () => approval.promise });
	const pending = service.dispatch({ cwd: "/repo", prompt: "task", agent: { session: { id: "parent" } } });
	await new Promise((r) => setImmediate(r));
	const sessionId = service.list()[0].sessionId;
	assert.equal(service.status(sessionId).status, "awaiting_permission");
	const stopped = await service.interrupt(sessionId);
	assert.equal(stopped.interrupted, true);
	assert.equal(stopped.session.pendingPermission, null);
	assert.equal(stopped.session.status, "interrupted");
	await pending;
});

test("interrupt delegates to active run and close disposes it", async () => {
	const gate = deferred();
	let interrupts = 0, disposed = 0;
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), followup: () => gate.promise, interrupt: async () => { interrupts++; return true; }, dispose: async () => { disposed++; } }; } } } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const pending = service.followup(first.session.sessionId, "slow");
	await new Promise((r) => setImmediate(r));
	assert.equal((await service.interrupt(first.session.sessionId)).interrupted, true);
	assert.equal(interrupts, 1);
	gate.resolve({ threadId: "t", text: "done" });
	await pending;
	await service.close(first.session.sessionId);
	assert.equal(disposed, 1);
});

test("release drops the subprocess but keeps the session and remote thread id", async () => {
	let disposed = 0;
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return { remoteSessionId: "thread-rel", result: Promise.resolve({ threadId: "thread-rel", text: "first" }), followup: async () => ({ threadId: "thread-rel", text: "later" }), dispose: async () => { disposed++; } }; } } } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const released = await service.release(first.session.sessionId);
	assert.equal(released.released, true);
	assert.equal(disposed, 1);
	assert.equal(released.session.remoteSessionId, "thread-rel");
	assert.notEqual(released.session.status, "closed");
});

test("release refuses while a turn is active", async () => {
	const gate = deferred();
	let disposed = 0;
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), followup: () => gate.promise, dispose: async () => { disposed++; } }; } } } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const pending = service.followup(first.session.sessionId, "slow");
	await new Promise((r) => setImmediate(r));
	const released = await service.release(first.session.sessionId);
	assert.equal(released.released, false);
	assert.equal(disposed, 0);
	gate.resolve({ threadId: "t", text: "done" });
	await pending;
});

test("followup after release reattaches the same remote thread", async () => {
	const calls = [];
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start(input) {
		calls.push(input);
		return { remoteSessionId: input.resumeThreadId ?? "thread-new", result: Promise.resolve({ threadId: input.resumeThreadId ?? "thread-new", text: "first" }), followup: async () => ({ threadId: input.resumeThreadId ?? "thread-new", text: "reattached" }), dispose: async () => {} };
	} } } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	assert.equal(calls.length, 1);
	await service.release(first.session.sessionId);
	const next = await service.followup(first.session.sessionId, "second");
	assert.equal(calls.length, 2);
	assert.equal(calls[1].resumeThreadId, "thread-new");
	assert.equal(next.session.remoteSessionId, "thread-new");
	assert.equal(next.output, "reattached");
});

test("releaseChild frees the bound session when a relay epoch ends", async () => {
	let disposed = 0;
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return { remoteSessionId: "thread-child", result: Promise.resolve({ threadId: "thread-child", text: "first" }), followup: async () => ({ threadId: "thread-child", text: "next" }), dispose: async () => { disposed++; } }; } } } });
	service.bindChild("child-1", { cli: "codex", parentAgent: null });
	service.setChildCwd("child-1", "/repo");
	const first = await service.submitFromChild("child-1", "first", null, null);
	assert.equal(first.session.remoteSessionId, "thread-child");
	const released = await service.releaseChild("child-1");
	assert.equal(released.released, true);
	assert.equal(disposed, 1);
	// The next epoch reattaches rather than starting a fresh thread.
	const second = await service.submitFromChild("child-1", "second", null, null);
	assert.equal(second.session.remoteSessionId, "thread-child");
});

test("releaseChild is a no-op for an unknown child", async () => {
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), dispose: async () => {} }; } } } });
	assert.deepEqual(await service.releaseChild("never-bound"), { released: false });
});

// ── Fine-grained permission gate + approval modes ────────────────────────────

test("permissionSpec derives sandbox tier and approval policy from the profile", () => {
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() {} } }, permissionSource: () => "workspace-write" });
	assert.deepEqual(service.permissionSpec("codex"), {
		permissionMode: "workspace-write",
		approvalPolicy: "on-request",
		sandbox: "workspace-write",
		profile: { read: true, write: true, exec: true, network: false, approval: "ask" }
	});
	const denied = new ManagedCliAgentsService({ drivers: { codex: { async start() {} } }, permissionSource: () => ({ read: true, write: false, exec: false, network: false, approval: "never" }) });
	assert.equal(denied.permissionSpec("codex").approvalPolicy, "never");
	assert.equal(denied.permissionSpec("codex").sandbox, "read-only");
});

test("capability gate auto-rejects a request the profile does not grant", async () => {
	let approvalCalls = 0;
	const driver = { async start(value) {
		return { remoteSessionId: "thread-g", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-g", cli: "codex", turnId: "turn-g", itemId: "item-g", capability: "permissions", operation: "one", createdAt: new Date().toISOString() });
			return { threadId: "thread-g", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, permissionSource: () => ({ ...ASK_ALL, network: false }), approvalRequest: async () => { approvalCalls++; return "allowed-once"; } });
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(done.output, "rejected");
	assert.equal(approvalCalls, 0); // never surfaced a prompt
	assert.equal(done.session.lastPermissionDecision.capability, "permissions");
	assert.equal(done.session.lastPermissionDecision.outcome, "rejected");
});

test("approval=allow auto-accepts a granted capability without prompting", async () => {
	let approvalCalls = 0;
	const driver = { async start(value) {
		return { remoteSessionId: "thread-a", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-a", cli: "codex", turnId: "turn-a", itemId: "item-a", capability: "permissions", operation: "one", createdAt: new Date().toISOString() });
			return { threadId: "thread-a", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, permissionSource: () => ({ ...ASK_ALL, approval: "allow" }), approvalRequest: async () => { approvalCalls++; return "rejected"; } });
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(done.output, "allowed-once");
	assert.equal(approvalCalls, 0);
	assert.equal(done.session.lastPermissionDecision.outcome, "allowed-once");
});

test("approval=never auto-rejects a granted capability without prompting", async () => {
	let approvalCalls = 0;
	const driver = { async start(value) {
		return { remoteSessionId: "thread-n", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-n", cli: "codex", turnId: "turn-n", itemId: "item-n", capability: "command", operation: "one", createdAt: new Date().toISOString() });
			return { threadId: "thread-n", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ drivers: { codex: driver }, permissionSource: () => ({ ...ASK_ALL, approval: "never" }), approvalRequest: async () => { approvalCalls++; return "allowed-once"; } });
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(done.output, "rejected");
	assert.equal(approvalCalls, 0);
	assert.equal(done.session.lastPermissionDecision.outcome, "rejected");
});

// ── Generalized permission matrices ──────────────────────────────────────────

test("permissionSpec matrix derives sandbox and approval policy for every input", () => {
	const cases = [
		{ label: "legacy read-only", input: "read-only", sandbox: "read-only", approvalPolicy: "on-request", approval: "ask" },
		{ label: "legacy workspace-write", input: "workspace-write", sandbox: "workspace-write", approvalPolicy: "on-request", approval: "ask" },
		{ label: "legacy danger-full-access", input: "danger-full-access", sandbox: "danger-full-access", approvalPolicy: "on-request", approval: "allow" },
		{ label: "unknown string defaults", input: "bogus", sandbox: "workspace-write", approvalPolicy: "on-request", approval: "ask" },
		{ label: "network alone escalates", input: { read: true, write: false, exec: false, network: true, approval: "allow" }, sandbox: "danger-full-access", approvalPolicy: "on-request", approval: "allow" },
		{ label: "exec+network escalates", input: { read: true, write: false, exec: true, network: true, approval: "ask" }, sandbox: "danger-full-access", approvalPolicy: "on-request", approval: "ask" },
		{ label: "exec only stays workspace", input: { read: true, write: false, exec: true, network: false, approval: "ask" }, sandbox: "workspace-write", approvalPolicy: "on-request", approval: "ask" },
		{ label: "never forces approvalPolicy never", input: { read: true, write: true, exec: true, network: false, approval: "never" }, sandbox: "workspace-write", approvalPolicy: "never", approval: "never" }
	];
	for (const c of cases) {
		const service = new ManagedCliAgentsService({ drivers: { codex: { async start() {} } }, permissionSource: () => c.input });
		const spec = service.permissionSpec("codex");
		assert.equal(spec.sandbox, c.sandbox, `sandbox ${c.label}`);
		assert.equal(spec.permissionMode, c.sandbox, `permissionMode ${c.label}`);
		assert.equal(spec.approvalPolicy, c.approvalPolicy, `approvalPolicy ${c.label}`);
		assert.equal(spec.profile.approval, c.approval, `profile.approval ${c.label}`);
	}
});

// The deterministic branches of resolvePermission — capability denied by the
// gate, approval=allow, and approval=never — must decide without ever calling
// the approval seam. The "ask" branch (routes to approvalRequest) is covered
// by the dedicated tests above. This matrix guards every capability × mode.
const RESOLVE_DECISIONS = [
	{ label: "denied command", capability: "command", profile: { ...ASK_ALL, exec: false }, expected: "rejected" },
	{ label: "denied file-change", capability: "file-change", profile: { ...ASK_ALL, write: false }, expected: "rejected" },
	{ label: "denied permissions", capability: "permissions", profile: { ...ASK_ALL, network: false }, expected: "rejected" },
	{ label: "allow command", capability: "command", profile: { ...ASK_ALL, approval: "allow" }, expected: "allowed-once" },
	{ label: "allow file-change", capability: "file-change", profile: { ...ASK_ALL, approval: "allow" }, expected: "allowed-once" },
	{ label: "allow permissions", capability: "permissions", profile: { ...ASK_ALL, approval: "allow" }, expected: "allowed-once" },
	{ label: "never command", capability: "command", profile: { ...ASK_ALL, approval: "never" }, expected: "rejected" },
	{ label: "never file-change", capability: "file-change", profile: { ...ASK_ALL, approval: "never" }, expected: "rejected" },
	{ label: "never permissions", capability: "permissions", profile: { ...ASK_ALL, approval: "never" }, expected: "rejected" }
];

test("resolvePermission decision matrix never prompts for gate/allow/never", async () => {
	for (const d of RESOLVE_DECISIONS) {
		let approvalCalls = 0;
		const driver = { async start(value) {
			return { remoteSessionId: `thread-${d.label}`, result: (async () => {
				const outcome = await value.onPermissionRequest({ requestId: `req-${d.label}`, cli: "codex", turnId: "turn", itemId: "item", capability: d.capability, operation: "one", createdAt: new Date().toISOString() });
				return { threadId: `thread-${d.label}`, text: outcome };
			})(), dispose: async () => {} };
		} };
		const service = new ManagedCliAgentsService({ drivers: { codex: driver }, permissionSource: () => d.profile, approvalRequest: async () => { approvalCalls++; return "allowed-once"; } });
		const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
		assert.equal(done.output, d.expected, `outcome ${d.label}`);
		assert.equal(approvalCalls, 0, `no prompt ${d.label}`);
		assert.equal(done.session.lastPermissionDecision.outcome, d.expected, `recorded ${d.label}`);
	}
});

// ── Auto-continue for premature turn stops ───────────────────────────────────

test("looksPrematureOutput flags an early stop whose last sentence commits to future work", () => {
	// Premature stops: the model ends right after a plan/commitment sentence.
	assert.equal(looksPrematureOutput("我会并行抓取多个 RSS/新闻源，再按时间戳筛选近 24 小时内容。抓取成功。现在解析时间戳，并按北京时间最近 24 小时筛选。", 3), true);
	assert.equal(looksPrematureOutput("`date` 已执行；现在实际运行第二条命令。", 1), true);
	assert.equal(looksPrematureOutput("抓取成功。现在解析各源的时间戳。", 2), true);
	// The model may stop even before running any tool (only stated its plan).
	assert.equal(looksPrematureOutput("我会先用 `curl` 拉取三个 RSS，再按最近 24 小时筛选、去重并整理中文摘要。", 0), true);
	assert.equal(looksPrematureOutput("现在我来解释一下这个函数的作用。", 0), true);
	// Already-complete answers are not flagged, regardless of tool work.
	assert.equal(looksPrematureOutput("Mon Aug 31 03:18:06 CST 2026", 1), false);
	assert.equal(looksPrematureOutput("全部真实场景通过", 5), false);
	assert.equal(looksPrematureOutput("这是一个完整的最终报告。\n1. 第一点\n2. 第二点", 4), false);
	assert.equal(looksPrematureOutput("OK", 1), false);
	// Empty output always deserves a nudge.
	assert.equal(looksPrematureOutput("", 1), true);
});

test("dispatch auto-continues an early-stopped turn and returns the cleaned answer", async () => {
	const followupPrompts = [];
	let followupCount = 0;
	const run = {
		remoteSessionId: "thread-ac",
		result: Promise.resolve({ threadId: "thread-ac", text: "抓取成功。现在解析各源的时间戳。", toolRounds: 2, stopReason: "completed" }),
		async followup(prompt) {
			followupPrompts.push(prompt);
			followupCount++;
			// First nudge yields a substantial final report (>100 chars so the
			// cleaning branch replaces the progress noise).
			const report = "最终报告：今天有三条重要新闻。第一条是 A 公司发布新品，市场反响热烈，分析师认为将重塑行业格局；第二条是 B 行业监管新规出台，影响深远，多家企业正在评估应对方案；第三条是 C 研究取得突破性进展。以上内容均来自已验证来源，详情见下文。";
			return { threadId: "thread-ac", text: followupCount === 1 ? report : "已无更多内容。", toolRounds: 0, stopReason: "completed" };
		},
		async dispose() {}
	};
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return run; } } }, routeSource: () => ({ provider: "p", model: "m", reasoningEffort: "high" }), permissionSource: () => "workspace-write" });
	const done = await service.dispatch({ cwd: "/repo", prompt: "调查新闻" });
	assert.equal(followupCount, 1);
	assert.deepEqual(followupPrompts, [AUTO_CONTINUE_PROMPT]);
	// A complete, substantial nudge answer replaces the progress-fragment noise.
	assert.match(done.output, /最终报告：今天有三条重要新闻/);
	assert.equal(done.output.includes("抓取成功。现在解析各源的时间戳。"), false);
	assert.equal(done.session.status, "ready");
});

test("dispatch never auto-continues a turn that already looks complete", async () => {
	let followupCount = 0;
	const run = {
		remoteSessionId: "thread-c",
		result: Promise.resolve({ threadId: "thread-c", text: "这是完整的最终报告。\n- 要点一\n- 要点二", toolRounds: 4, stopReason: "completed" }),
		async followup() { followupCount++; return { threadId: "thread-c", text: "不应发生", toolRounds: 0, stopReason: "completed" }; },
		async dispose() {}
	};
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return run; } } }, permissionSource: () => "workspace-write" });
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(followupCount, 0);
	assert.equal(done.output, "这是完整的最终报告。\n- 要点一\n- 要点二");
});

test("auto-continue stops at the bound when every nudge still looks premature", async () => {
	let followupCount = 0;
	const run = {
		remoteSessionId: "thread-loop",
		result: Promise.resolve({ threadId: "thread-loop", text: "第一步完成。现在继续第二步。", toolRounds: 1, stopReason: "completed" }),
		async followup() {
			followupCount++;
			return { threadId: "thread-loop", text: "继续推进中。现在做下一步。", toolRounds: 1, stopReason: "completed" };
		},
		async dispose() {}
	};
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return run; } } }, permissionSource: () => "workspace-write" });
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(followupCount, AUTO_CONTINUE_MAX);
	assert.equal(done.session.status, "ready");
});

test("followup also auto-continues a premature early-stop", async () => {
	let followupCount = 0;
	const run = {
		remoteSessionId: "thread-fa",
		result: Promise.resolve({ threadId: "thread-fa", text: "第一次回答", toolRounds: 0, stopReason: "completed" }),
		async followup(prompt) {
			followupCount++;
			return { threadId: "thread-fa", text: prompt === "second" ? "工具已执行。现在汇总结果。" : "最终汇总：全部完成。", toolRounds: 1, stopReason: "completed" };
		},
		async dispose() {}
	};
	const service = new ManagedCliAgentsService({ drivers: { codex: { async start() { return run; } } }, permissionSource: () => "workspace-write" });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const next = await service.followup(first.session.sessionId, "second");
	// dispatch: toolRounds 0 → no nudge; followup: premature → one nudge.
	assert.equal(followupCount, 2);
	assert.match(next.output, /最终汇总/);
});
