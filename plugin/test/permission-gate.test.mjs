import assert from "node:assert/strict";
import test from "node:test";
import { ManagedCliAgentsService } from "../lib/managed-cli-agents.js";
import { requiredCapabilities, missingCapabilities, profileWith, isPermissionBlocked } from "../lib/permissions.js";

// A / B 权限门：权限不足只有两种合法动作——「询问」时向 human 发一次性申请，
// 「自动拒绝」时不申请、直接报告做不了。没有开关、没有绕行。
const NEVER_WRITE = { read: true, write: false, exec: false, approval: "never" };
const ASK_WRITE = { read: true, write: false, exec: false, approval: "ask" };

function driverFixture({ failsWith = null, failTimes = failsWith ? 1 : 0 } = {}) {
	const starts = [];
	let started = 0;
	function makeRun() {
		started += 1;
		const fails = failsWith && started <= failTimes;
		return {
			remoteSessionId: `thread-${started}`,
			result: fails ? Promise.reject(failsWith) : Promise.resolve({ threadId: `thread-${started}`, text: "done", stopReason: "completed" }),
			async followup() { return { threadId: `thread-${started}`, text: "next", stopReason: "completed" }; },
			async interrupt() { return true; },
			async dispose() {}
		};
	}
	return {
		driver: { async start(input) { starts.push(input); return makeRun(); } },
		starts, get started() { return started; }
	};
}

test("requiredCapabilities reads write/exec intent out of a prompt", () => {
	assert.deepEqual(requiredCapabilities("读一下 README 并总结"), { write: false, exec: false });
	assert.deepEqual(requiredCapabilities("请把结果写入 a.md"), { write: true, exec: false });
	assert.deepEqual(requiredCapabilities("运行 npm test"), { write: false, exec: true });
	assert.deepEqual(missingCapabilities(NEVER_WRITE, "写入文件 a.md"), ["write"]);
	assert.deepEqual(missingCapabilities(NEVER_WRITE, "跑一下测试"), ["exec"]);
	assert.deepEqual(missingCapabilities(NEVER_WRITE, "总结一下代码"), []);
	assert.deepEqual(profileWith(NEVER_WRITE, ["write"]), { read: true, write: true, exec: false, approval: "never" });
});

test("isPermissionBlocked recognizes driver rejections and CLI-side refusals", () => {
	assert.equal(isPermissionBlocked(new Error("审批系统拒绝：当前审批策略被设置为 never")), true);
	assert.equal(isPermissionBlocked(new Error('Rejected by user / approval request failed')), true);
	assert.equal(isPermissionBlocked(new Error("tool not available in plan mode")), true);
	assert.equal(isPermissionBlocked(new Error("permission request was denied")), true);
	assert.equal(isPermissionBlocked(new Error("network DNS lookup failed")), false);
});

test("A: approval=never reports cannot-complete without asking and without starting the CLI", async () => {
	const f = driverFixture();
	let asked = 0;
	const service = new ManagedCliAgentsService({
		_skipAssert: true, drivers: { codex: f.driver },
		routeSource: () => ({ provider: "p", model: "m" }),
		permissionSource: () => NEVER_WRITE,
		approvalRequest: async () => { asked += 1; return "allowed-once"; }
	});
	await assert.rejects(
		service.dispatch({ cwd: "/repo", prompt: "请把结果写入 a.md" }),
		(error) => error.code === "CLI_PERMISSION_BLOCKED" && /无法完成/.test(error.message) && /自动拒绝/.test(error.message)
	);
	assert.equal(asked, 0, "never 策略下不发起任何申请");
	assert.equal(f.started, 0, "未拿到能力就不启动进程");
});

test("A: approval=ask asks once and launches the turn with the widened tier", async () => {
	const f = driverFixture();
	const requests = [];
	const service = new ManagedCliAgentsService({
		_skipAssert: true, drivers: { codex: f.driver },
		routeSource: () => ({ provider: "p", model: "m" }),
		permissionSource: () => ASK_WRITE,
		approvalRequest: async (request) => { requests.push(request); return "allowed-once"; }
	});
	const value = await service.dispatch({ cwd: "/repo", prompt: "请把结果写入 a.md" });
	assert.equal(requests.length, 1);
	assert.equal(requests[0].capability, "file-change");
	assert.equal(requests[0].cli, "codex");
	assert.equal(requests[0].gated, true);
	assert.equal(f.started, 1);
	assert.equal(f.starts[0].sandbox, "workspace-write", "本轮以提升后的档位启动");
	assert.equal(value.session.permissionMode, "workspace-write");
});

test("A: a denied gate stops the task and never starts the CLI", async () => {
	const f = driverFixture();
	const service = new ManagedCliAgentsService({
		_skipAssert: true, drivers: { codex: f.driver },
		routeSource: () => ({ provider: "p", model: "m" }),
		permissionSource: () => ASK_WRITE,
		approvalRequest: async () => "rejected"
	});
	await assert.rejects(
		service.dispatch({ cwd: "/repo", prompt: "写入文件 a.md" }),
		(error) => error.code === "CLI_PERMISSION_BLOCKED" && /无法完成/.test(error.message)
	);
	assert.equal(f.started, 0);
});

test("B: a blocked turn under never is reported, not retried", async () => {
	const f = driverFixture({ failsWith: new Error("审批系统拒绝：当前审批策略被设置为 never，其写入操作均被拒绝。") });
	let asked = 0;
	const service = new ManagedCliAgentsService({
		_skipAssert: true, drivers: { codex: f.driver },
		routeSource: () => ({ provider: "p", model: "m" }),
		permissionSource: () => NEVER_WRITE,
		approvalRequest: async () => { asked += 1; return "allowed-once"; }
	});
	await assert.rejects(
		service.dispatch({ cwd: "/repo", prompt: "读一下 README" }),
		(error) => error.code === "CLI_PERMISSION_BLOCKED" && /写入文件/.test(error.message) && /自动拒绝/.test(error.message)
	);
	assert.equal(asked, 0, "never 策略下不发起任何申请");
	assert.equal(f.started, 1, "不允许重开第二轮");
});

test("B: a blocked turn under ask is re-run once with the widened tier", async () => {
	const f = driverFixture({ failsWith: new Error("审批系统拒绝：写入操作均被拒绝。") });
	const requests = [];
	const service = new ManagedCliAgentsService({
		_skipAssert: true, drivers: { codex: f.driver },
		routeSource: () => ({ provider: "p", model: "m" }),
		permissionSource: () => ASK_WRITE,
		approvalRequest: async (request) => { requests.push(request); return "allowed-once"; }
	});
	const value = await service.dispatch({ cwd: "/repo", prompt: "读一下 README" });
	assert.equal(requests.length, 1, "只允许申请一次");
	assert.match(requests[0].operation, /重开一轮/);
	assert.equal(f.started, 2, "受阻后重开一轮");
	assert.equal(f.starts[1].sandbox, "workspace-write");
	assert.equal(value.output, "done");
});

test("B: a rejection without an extractable capability is reported, not retried", async () => {
	const f = driverFixture({ failsWith: new Error('Rejected("rejected by user")') });
	const service = new ManagedCliAgentsService({
		_skipAssert: true, drivers: { codex: f.driver },
		routeSource: () => ({ provider: "p", model: "m" }),
		permissionSource: () => ASK_WRITE,
		approvalRequest: async () => "allowed-once"
	});
	await assert.rejects(service.dispatch({ cwd: "/repo", prompt: "读一下 README" }), /rejected by user/);
	assert.equal(f.started, 1, "算不出缺口就不盲目重跑");
});

test("B: a rejection does not loop — the second blocked turn is the last", async () => {
	let n = 0;
	const driver = { async start() { n += 1; return { remoteSessionId: "t", result: Promise.reject(new Error("审批系统拒绝：写入操作均被拒绝。")), dispose: async () => {} }; } };
	const service = new ManagedCliAgentsService({
		_skipAssert: true, drivers: { codex: driver },
		routeSource: () => ({ provider: "p", model: "m" }),
		permissionSource: () => NEVER_WRITE,
		approvalRequest: async () => "allowed-once"
	});
	await assert.rejects(service.dispatch({ cwd: "/repo", prompt: "读一下 README" }), (error) => error.code === "CLI_PERMISSION_BLOCKED");
	assert.equal(n, 1);
});
