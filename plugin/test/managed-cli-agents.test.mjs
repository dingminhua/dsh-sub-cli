import assert from "node:assert/strict";
import test from "node:test";
import { ManagedCliAgentsService, looksPrematureOutput, persistable, AUTO_CONTINUE_MAX, AUTO_CONTINUE_PROMPT } from "../lib/managed-cli-agents.js";

// Permission profile that grants every capability, so tests that exercise the
// checked-branch decisions reach the driver with grants.
const GRANT_ALL = { read: true, write: true, exec: true };

// The approval mode was removed (2026-09): resolvePermission answers every
// request deterministically by checkbox. These fixtures keep specific
// capabilities unchecked to exercise the rejection branch.
const UNCHECKED_EXEC = { read: true, write: true, exec: false };

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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: f.driver }, routeSource: () => ({ provider: "p", model: "m", reasoningEffort: "high" }), permissionSource: () => "workspace-write" });
	const value = await service.dispatch({ cwd: "/repo", prompt: "first" });
	assert.match(value.session.sessionId, /^cli-codex-/);
	assert.equal(value.session.remoteSessionId, "thread-1");
	assert.equal(value.session.status, "ready");
	assert.equal(value.output, "first");
	assert.equal(f.calls[0].sandbox, "workspace-write");
	assert.equal(f.calls[0].model, "m");
});

test("dispatch records a deterministic rejection for an unchecked capability", async () => {
	// The approval mode is gone: an unchecked capability is answered
	// deterministically ("rejected") and recorded for the audit trail — no
	// pending state, no interactive seam.
	let input;
	const driver = { async start(value) {
		input = value;
		return { remoteSessionId: "thread-p", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-p", remoteRequestId: "remote-p", cli: "codex", turnId: "turn-p", itemId: "item-p", capability: "command", operation: "item/commandExecution/requestApproval", target: "npm install", reason: "dependency", createdAt: new Date().toISOString() });
			return { threadId: "thread-p", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: driver }, permissionSource: () => UNCHECKED_EXEC });
	const done = await service.dispatch({ cwd: "/repo", prompt: "first", agent: { session: { id: "parent" } }, childId: "child-p" });
	assert.equal(input.approvalPolicy, "on-request");
	assert.equal(done.output, "rejected");
	assert.equal(done.session.lastPermissionDecision.requestId, "req-p");
	assert.equal(done.session.lastPermissionDecision.outcome, "rejected");
	assert.equal(done.session.status, "ready");
});

test("relay child permission request is answered deterministically and recorded", async () => {
	const childAgent = { session: { id: "child-agent" } };
	const parentAgent = { session: { id: "parent-agent" } };
	const driver = { async start(value) {
		return { remoteSessionId: "thread-parent", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-parent", cli: "codex", turnId: "turn-parent", itemId: "item-parent", capability: "command", operation: "command", createdAt: new Date().toISOString() });
			return { threadId: "thread-parent", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: driver }, permissionSource: () => UNCHECKED_EXEC });
	service.bindChild("child-agent", { cli: "codex", parentAgent });
	service.setChildCwd("child-agent", "/repo");
	const value = await service.submitFromChild("child-agent", "task", undefined, childAgent);
	assert.equal(value.output, "rejected");
	assert.equal(value.session.lastPermissionDecision.outcome, "rejected");
	assert.equal("parentAgent" in service.childBinding("child-agent"), false);
});

test("followup uses the same live driver run and status/list are secret-free", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: f.driver } });
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), followup: () => gate.promise, interrupt: async () => true, dispose: async () => {} }; } } } });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const pending = service.followup(first.session.sessionId, "slow");
	await new Promise((r) => setImmediate(r));
	await assert.rejects(service.followup(first.session.sessionId, "overlap"), (error) => error.code === "SESSION_BUSY");
	gate.resolve({ threadId: "t", text: "done" });
	await pending;
});

test("relay child binding creates then follows up the same managed session", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: f.driver } });
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

test("interrupt delegates to active run and close disposes it", async () => {
	const gate = deferred();
	let interrupts = 0, disposed = 0;
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), followup: () => gate.promise, interrupt: async () => { interrupts++; return true; }, dispose: async () => { disposed++; } }; } } } });
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return { remoteSessionId: "thread-rel", result: Promise.resolve({ threadId: "thread-rel", text: "first" }), followup: async () => ({ threadId: "thread-rel", text: "later" }), dispose: async () => { disposed++; } }; } } } });
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), followup: () => gate.promise, dispose: async () => { disposed++; } }; } } } });
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start(input) {
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return { remoteSessionId: "thread-child", result: Promise.resolve({ threadId: "thread-child", text: "first" }), followup: async () => ({ threadId: "thread-child", text: "next" }), dispose: async () => { disposed++; } }; } } } });
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return { remoteSessionId: "t", result: Promise.resolve({ threadId: "t", text: "x" }), dispose: async () => {} }; } } } });
	assert.deepEqual(await service.releaseChild("never-bound"), { released: false });
});

// ── Fine-grained permission gate (deterministic) ─────────────────────────────

test("permissionSpec derives the sandbox tier from the profile", () => {
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() {} } }, permissionSource: () => "workspace-write" });
	assert.deepEqual(service.permissionSpec("codex"), {
		permissionMode: "workspace-write",
		// The approval mode is gone: policy stays on-request so every
		// out-of-scope request flows to the deterministic resolver.
		approvalPolicy: "on-request",
		sandbox: "workspace-write",
		// Three capabilities: the workspace-write preset is write-only (no exec).
		profile: { read: true, write: true, exec: false }
	});
	const denied = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() {} } }, permissionSource: () => ({ read: true, write: false, exec: false }) });
	assert.equal(denied.permissionSpec("codex").approvalPolicy, "on-request");
	assert.equal(denied.permissionSpec("codex").sandbox, "read-only");
});

test("a checked capability is allowed silently", async () => {
	// The checkbox is the only grant: a checked capability is allowed without
	// any interactive step.
	const driver = { async start(value) {
		return { remoteSessionId: "thread-a", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-a", cli: "codex", turnId: "turn-a", itemId: "item-a", capability: "permissions", operation: "one", createdAt: new Date().toISOString() });
			return { threadId: "thread-a", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: driver }, permissionSource: () => GRANT_ALL });
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(done.output, "allowed-once");
	assert.equal(done.session.lastPermissionDecision.outcome, "allowed-once");
});

test("an UNCHECKED capability is rejected deterministically without prompting", async () => {
	const driver = { async start(value) {
		return { remoteSessionId: "thread-n", result: (async () => {
			const outcome = await value.onPermissionRequest({ requestId: "req-n", cli: "codex", turnId: "turn-n", itemId: "item-n", capability: "command", operation: "one", createdAt: new Date().toISOString() });
			return { threadId: "thread-n", text: outcome };
		})(), dispose: async () => {} };
	} };
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: driver }, permissionSource: () => ({ read: true, write: true, exec: false }) });
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(done.output, "rejected");
	assert.equal(done.session.lastPermissionDecision.outcome, "rejected");
});

// ── Generalized permission matrices ──────────────────────────────────────────

test("permissionSpec matrix derives the sandbox tier for every input", () => {
	const cases = [
		{ label: "legacy read-only", input: "read-only", sandbox: "read-only" },
		{ label: "legacy workspace-write", input: "workspace-write", sandbox: "workspace-write" },
		{ label: "legacy danger-full-access", input: "danger-full-access", sandbox: "danger-full-access" },
		{ label: "unknown string defaults to read-only", input: "bogus", sandbox: "read-only" },
		{ label: "legacy allow migrates to full grant", input: { read: true, write: true, exec: true, network: true, approval: "allow" }, sandbox: "danger-full-access" },
		{ label: "network-only escalates via exec migration", input: { read: true, write: false, exec: false, network: true, approval: "ask" }, sandbox: "danger-full-access" },
		{ label: "exec+network escalates", input: { read: true, write: false, exec: true, network: true, approval: "ask" }, sandbox: "danger-full-access" },
		{ label: "exec alone escalates (egress intent)", input: { read: true, write: false, exec: true, approval: "ask" }, sandbox: "danger-full-access" },
		{ label: "stored approval keys never influence the tier", input: { read: true, write: true, exec: true, network: false, approval: "never" }, sandbox: "danger-full-access" }
	];
	for (const c of cases) {
		const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() {} } }, permissionSource: () => c.input });
		const spec = service.permissionSpec("codex");
		assert.equal(spec.sandbox, c.sandbox, `sandbox ${c.label}`);
		assert.equal(spec.permissionMode, c.sandbox, `permissionMode ${c.label}`);
		assert.equal(spec.approvalPolicy, "on-request", `approvalPolicy ${c.label}`);
		assert.equal("approval" in spec.profile, false, `profile.approval dropped ${c.label}`);
	}
});

// The deterministic resolvePermission branches — checked (allowed silently)
// and unchecked (rejected and recorded). This matrix guards every capability ×
// checkbox combination.
const RESOLVE_DECISIONS = [
	// Checked capabilities are allowed.
	{ label: "checked command", capability: "command", profile: { ...GRANT_ALL }, expected: "allowed-once" },
	{ label: "checked file-change", capability: "file-change", profile: { ...GRANT_ALL }, expected: "allowed-once" },
	{ label: "checked permissions", capability: "permissions", profile: { ...GRANT_ALL }, expected: "allowed-once" },
	// Unchecked → rejected without prompting.
	{ label: "unchecked command", capability: "command", profile: { read: true, write: true, exec: false }, expected: "rejected" },
	{ label: "unchecked file-change", capability: "file-change", profile: { read: true, write: false, exec: true }, expected: "rejected" },
	{ label: "unchecked permissions", capability: "permissions", profile: { read: true, write: true, exec: false }, expected: "rejected" }
];

test("resolvePermission decision matrix decides deterministically", async () => {
	for (const d of RESOLVE_DECISIONS) {
		const driver = { async start(value) {
			return { remoteSessionId: `thread-${d.label}`, result: (async () => {
				const outcome = await value.onPermissionRequest({ requestId: `req-${d.label}`, cli: "codex", turnId: "turn", itemId: "item", capability: d.capability, operation: "one", createdAt: new Date().toISOString() });
				return { threadId: `thread-${d.label}`, text: outcome };
			})(), dispose: async () => {} };
		} };
		const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: driver }, permissionSource: () => d.profile });
		const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
		assert.equal(done.output, d.expected, `outcome ${d.label}`);
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return run; } } }, routeSource: () => ({ provider: "p", model: "m", reasoningEffort: "high" }), permissionSource: () => "workspace-write" });
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return run; } } }, permissionSource: () => "workspace-write" });
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return run; } } }, permissionSource: () => "workspace-write" });
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
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return run; } } }, permissionSource: () => "workspace-write" });
	const first = await service.dispatch({ cwd: "/repo", prompt: "first" });
	const next = await service.followup(first.session.sessionId, "second");
	// dispatch: toolRounds 0 → no nudge; followup: premature → one nudge.
	assert.equal(followupCount, 2);
	assert.match(next.output, /最终汇总/);
});

test("persistable never serializes live run or permission state", () => {
	const record = {
		sessionId: "s", cli: "codex", cwd: "/repo", provider: "p", model: "m", reasoningEffort: "high",
		permissionMode: "danger-full-access", status: "ready", createdAt: "t0", updatedAt: "t1",
		lastError: null, remoteSessionId: "thread-x",
		run: { fake: true }, activeTurn: true, lastPermissionDecision: { outcome: "allowed-once" }
	};
	const saved = persistable(record);
	assert.equal(saved.sessionId, "s");
	assert.equal(saved.remoteSessionId, "thread-x");
	assert.equal(saved.run, undefined);
	assert.equal(saved.activeTurn, undefined);
	assert.equal(saved.lastPermissionDecision, undefined);
});

test("restore reloads durable sessions so followup reattaches the same thread", async () => {
	const calls = [];
	const store = [];
	const persist = {
		async load() { return store; },
		async save(sessions) { store.length = 0; store.push(...sessions); }
	};
	const driver = { async start(input) {
		calls.push(input);
		return { remoteSessionId: input.resumeThreadId ?? "thread-new", result: Promise.resolve({ threadId: input.resumeThreadId ?? "thread-new", text: "first" }), followup: async () => ({ threadId: input.resumeThreadId ?? "thread-new", text: "reattached" }), dispose: async () => {} };
	} };
	// First process: dispatch persists the ready session, then release keeps
	// it reattachable (run dropped, status ready, remote thread id preserved).
	const first = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: driver }, persist, permissionSource: () => "workspace-write" });
	const created = await first.dispatch({ cwd: "/repo", prompt: "first" });
	await first.release(created.session.sessionId);
	assert.equal(store.length, 1);
	assert.equal(store[0].status, "ready");
	// "Restart": a fresh service instance restores from the same store.
	const second = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: driver }, persist, permissionSource: () => "workspace-write" });
	const restored = await second.restore();
	assert.equal(restored.restored, 1);
	const status = second.list({ cli: "codex" });
	assert.equal(status[0].sessionId, created.session.sessionId);
	// Followup on the restored (run-less) session reattaches via resumeThreadId.
	const next = await second.followup(created.session.sessionId, "second");
	assert.equal(calls.some((c) => c.resumeThreadId === "thread-new" || c.resumeThreadId === created.session.remoteSessionId), true);
	assert.equal(next.output, "reattached");
	assert.equal(next.session.status, "ready");
	await second.dispose();
});

test("restore skips closed sessions and records without a remote thread id", async () => {
	const persist = {
		async load() { return [
			{ sessionId: "s1", cli: "codex", cwd: "/a", provider: "p", model: "m", reasoningEffort: "", permissionMode: "read-only", status: "ready", createdAt: "t0", updatedAt: "t1", lastError: null, remoteSessionId: "thread-1" },
			{ sessionId: "s2", cli: "codex", cwd: "/a", provider: "p", model: "m", reasoningEffort: "", permissionMode: "read-only", status: "closed", createdAt: "t0", updatedAt: "t1", lastError: null, remoteSessionId: "thread-2" },
			{ sessionId: "s3", cli: "codex", cwd: "/a", provider: "p", model: "m", reasoningEffort: "", permissionMode: "read-only", status: "ready", createdAt: "t0", updatedAt: "t1", lastError: null, remoteSessionId: null }
		]; },
		async save() {}
	};
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { throw new Error("should not start"); } } }, persist });
	const restored = await service.restore();
	assert.equal(restored.restored, 1);
	assert.equal(service.list({ cli: "codex" }).length, 1);
	assert.equal(service.list({ cli: "codex" })[0].sessionId, "s1");
});

test("dispatch writes the persisted store through the seam on success", async () => {
	let saved = null;
	const persist = {
		async load() { return []; },
		async save(sessions) { saved = { ...sessions[0] }; }
	};
	const service = new ManagedCliAgentsService({ _skipAssert: true,
		drivers: { codex: { async start() { return { remoteSessionId: "thread-p", result: Promise.resolve({ threadId: "thread-p", text: "done", stopReason: "completed" }), followup: async () => ({ threadId: "thread-p", text: "x" }), dispose: async () => {} }; } } },
		persist,
		permissionSource: () => "workspace-write"
	});
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.ok(saved, "persist.save should have been called");
	assert.equal(saved.sessionId, done.session.sessionId);
	assert.equal(saved.remoteSessionId, "thread-p");
	assert.equal(saved.run, undefined);
});

test("followup after restore reattaches without a pre-existing run", async () => {
	const calls = [];
	const persist = {
		async load() { return [{ sessionId: "s-r", cli: "codex", cwd: "/repo", provider: "p", model: "m", reasoningEffort: "", permissionMode: "read-only", status: "ready", createdAt: "t0", updatedAt: "t1", lastError: null, remoteSessionId: "thread-r" }]; },
		async save() {}
	};
	const service = new ManagedCliAgentsService({ _skipAssert: true,
		drivers: { codex: { async start(input) { calls.push(input); return { remoteSessionId: input.resumeThreadId ?? "x", result: Promise.resolve({ threadId: input.resumeThreadId ?? "x", text: "ok" }), followup: async () => ({ threadId: input.resumeThreadId ?? "x", text: "reattached" }), dispose: async () => {} }; } } },
		persist
	});
	await service.restore();
	assert.equal(service.list({ cli: "codex" }).length, 1);
	const next = await service.followup("s-r", "continue");
	assert.equal(next.output, "reattached");
	assert.equal(calls[0].attachOnly, true);
	assert.equal(calls[0].resumeThreadId, "thread-r");
});

test("autoContinueSource with enabled:false skips nudging entirely", async () => {
	let followupCount = 0;
	const run = {
		remoteSessionId: "thread-off",
		result: Promise.resolve({ threadId: "thread-off", text: "第一步完成。现在继续第二步。", toolRounds: 1, stopReason: "completed" }),
		async followup() { followupCount++; return { threadId: "thread-off", text: "更多内容。", stopReason: "completed" }; },
		async dispose() {}
	};
	const service = new ManagedCliAgentsService({ _skipAssert: true,
		drivers: { codex: { async start() { return run; } } },
		autoContinueSource: () => ({ enabled: false }),
		permissionSource: () => "workspace-write"
	});
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(followupCount, 0);
	assert.equal(done.output, "第一步完成。现在继续第二步。");
});

test("autoContinueSource max 0 disables nudging (the checkbox is gone)", async () => {
	// The UI no longer has an enabled checkbox: "off" is max 0, and the service
	// must honour it instead of falling back to the default of 3.
	let followupCount = 0;
	const run = {
		remoteSessionId: "thread-zero",
		result: Promise.resolve({ threadId: "thread-zero", text: "第一步完成。现在继续第二步。", toolRounds: 1, stopReason: "completed" }),
		async followup() { followupCount++; return { threadId: "thread-zero", text: "更多内容。", stopReason: "completed" }; },
		async dispose() {}
	};
	const service = new ManagedCliAgentsService({ _skipAssert: true,
		drivers: { codex: { async start() { return run; } } },
		autoContinueSource: () => ({ max: 0 }),
		permissionSource: () => "workspace-write"
	});
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(followupCount, 0, "max 0 must not nudge");
	assert.equal(done.output, "第一步完成。现在继续第二步。");
});

test("autoContinueSource max caps nudge rounds below the default", async () => {
	let followupCount = 0;
	const run = {
		remoteSessionId: "thread-cap",
		result: Promise.resolve({ threadId: "thread-cap", text: "第一步完成。现在继续第二步。", toolRounds: 1, stopReason: "completed" }),
		async followup() { followupCount++; return { threadId: "thread-cap", text: "继续推进中。现在做下一步。", toolRounds: 1, stopReason: "completed" }; },
		async dispose() {}
	};
	const service = new ManagedCliAgentsService({ _skipAssert: true,
		drivers: { codex: { async start() { return run; } } },
		autoContinueSource: () => ({ enabled: true, max: 1 }),
		permissionSource: () => "workspace-write"
	});
	const done = await service.dispatch({ cwd: "/repo", prompt: "task" });
	assert.equal(followupCount, 1);
	assert.equal(done.session.status, "ready");
});

// ── Multi-CLI driver dispatch (Round 1 refactor) ────────────────────────────
// These tests cover the move from a single hard-coded `drivers.codex` to a
// `drivers[cli]` map. The fake drivers here are intentionally minimal — the
// service-level tests above use `_skipAssert: true` for the same reason.

test("dispatch routes to the driver registered under the requested CLI id", async () => {
	const codexStartCalls = [];
	const claudeStartCalls = [];
	const codexDriver = { async start(input) { codexStartCalls.push(input); return { remoteSessionId: "codex-t", result: Promise.resolve({ threadId: "codex-t", text: "from-codex", stopReason: "completed" }), followup: async () => ({ threadId: "codex-t", text: "x" }), dispose: async () => {} }; } };
	const claudeDriver = { async start(input) { claudeStartCalls.push(input); return { remoteSessionId: "claude-t", result: Promise.resolve({ threadId: "claude-t", text: "from-claude", stopReason: "completed" }), followup: async () => ({ threadId: "claude-t", text: "x" }), dispose: async () => {} }; } };
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: codexDriver, claude: claudeDriver }, permissionSource: () => "read-only" });
	const codex = await service.dispatch({ cli: "codex", cwd: "/r", prompt: "hi" });
	const claude = await service.dispatch({ cli: "claude", cwd: "/r", prompt: "hi" });
	assert.equal(codex.output, "from-codex");
	assert.equal(codex.session.cli, "codex");
	assert.equal(claude.output, "from-claude");
	assert.equal(claude.session.cli, "claude");
	assert.equal(codexStartCalls.length, 1);
	assert.equal(claudeStartCalls.length, 1);
});

test("dispatch rejects an unregistered CLI id with CLI_UNSUPPORTED", async () => {
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return { remoteSessionId: "x", result: Promise.resolve({ threadId: "x", text: "", stopReason: "completed" }), followup: async () => ({}), dispose: async () => {} }; } } }, permissionSource: () => "read-only" });
	await assert.rejects(
		service.dispatch({ cli: "qwen", cwd: "/r", prompt: "hi" }),
		(error) => error.code === "CLI_UNSUPPORTED" && /qwen/.test(error.message) && /codex/.test(error.message)
	);
});

test("constructor validates every driver against the contract when assertion is enabled", () => {
	const invalid = { async start() { return { remoteSessionId: "x", result: Promise.resolve({ threadId: "x", text: "", stopReason: "completed" }), followup: async () => ({}), dispose: async () => {} }; } };
	// Missing `id` and `capabilities` → must reject.
	assert.throws(() => new ManagedCliAgentsService({ drivers: { codex: invalid }, permissionSource: () => "read-only" }), /id must be non-empty/);
	// A driver that passes the contract → must succeed.
	const valid = { id: "codex-app-server", capabilities: { streaming: true, continuable: true, durableResume: true, modelOverride: true, reasoningEffort: true, cwd: true, interrupt: true, interactivePermissions: true, structuredOutput: false, toolFilter: false, persona: false }, async start() { return { remoteSessionId: "x", result: Promise.resolve({ threadId: "x", text: "", stopReason: "completed" }), followup: async () => ({}), dispose: async () => {} }; } };
	assert.doesNotThrow(() => new ManagedCliAgentsService({ drivers: { codex: valid }, permissionSource: () => "read-only" }));
});

test("restore skips records whose CLI is no longer registered", async () => {
	let saved = [
		{ sessionId: "cli-codex-1", cli: "codex", cwd: "/r", remoteSessionId: "t-1", permissionMode: "read-only", provider: "", model: "", reasoningEffort: "", status: "ready", createdAt: "x", updatedAt: "x", lastError: null },
		{ sessionId: "cli-claude-1", cli: "claude", cwd: "/r", remoteSessionId: "t-2", permissionMode: "read-only", provider: "", model: "", reasoningEffort: "", status: "ready", createdAt: "x", updatedAt: "x", lastError: null }
	];
	const persist = { async load() { return saved; }, async save() {} };
	const service = new ManagedCliAgentsService({ _skipAssert: true, drivers: { codex: { async start() { return { remoteSessionId: "t-1", result: Promise.resolve({ threadId: "t-1", text: "", stopReason: "completed" }), followup: async () => ({}), dispose: async () => {} }; } } }, permissionSource: () => "read-only", persist });
	const { restored } = await service.restore();
	assert.equal(restored, 1); // only codex; claude has no driver registered
	assert.equal(service.list().length, 1);
	assert.equal(service.list()[0].cli, "codex");
});

test("looksPrematureOutput flags English intent tails like 'I will now ...'", () => {
	// Round 1: English tails are now recognised alongside the Chinese ones.
	assert.equal(looksPrematureOutput("Investigating the bug. I will now check the failing test.", 0), true);
	assert.equal(looksPrematureOutput("Looking at this. Let me look at the routes file.", 0), true);
	assert.equal(looksPrematureOutput("Working through it. Now I'll fetch the test logs.", 0), true);
	// Mixed-language content also detected.
	assert.equal(looksPrematureOutput("Bug found. 我会修复它.", 0), true);
	// Genuinely finished answers are not flagged.
	assert.equal(looksPrematureOutput("The fix is in src/fix.js. Tests pass: 12/12.", 5), false);
	assert.equal(looksPrematureOutput("Done — no further action needed.", 0), false);
});

test("autoContinuePrompt is preserved (中文模板未变)", () => {
	assert.equal(AUTO_CONTINUE_PROMPT, "请继续完成你的任务，把最终结果完整输出给我。不要只描述计划或过程。");
	assert.equal(AUTO_CONTINUE_MAX, 3);
});
