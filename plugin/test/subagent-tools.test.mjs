import { test } from "node:test";
import assert from "node:assert/strict";
import { CLI_SUBAGENT_TOOLS, registerCliSubagentTools } from "../lib/subagent-tools.js";

function context() {
	const tools = new Map();
	const services = new Map();
	const ctx = {
		subagents: { start: async () => { throw new Error("start not configured"); } },
		tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
		get(name) { return services.get(name); }
	};
	ctx.services = services;
	return { ctx, tools };
}

test("registers all three CLI tools globally without any LLM provider", () => {
	const fixture = context();
	registerCliSubagentTools(fixture.ctx);
	assert.deepEqual([...fixture.tools.keys()], ["cli_codex", "cli_claude_code", "cli_qwen"]);
	assert.equal(CLI_SUBAGENT_TOOLS.length, 3);
});

test("delegates through its one-shot managed provider and returns CLI text", async () => {
	const fixture = context();
	let seen;
	fixture.ctx.subagents.start = async (provider, request) => {
		seen = { provider, request };
		return {
			id: "run-1",
			result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "found issues" }] }),
			dispose: async () => {}
		};
	};
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	const agent = { id: "parent" };
	const signal = new AbortController().signal;
	const result = await tool.execute({ description: "检查测试", prompt: "完整检查项目测试" }, { agent, signal });
	assert.equal(seen.provider, "managed-codex");
	assert.equal(seen.request.label, "检查测试");
	assert.deepEqual(seen.request.prompt, [{ type: "text", text: "完整检查项目测试" }]);
	assert.equal(seen.request.parent, agent);
	assert.equal(seen.request.signal, signal);
	assert.equal(result.output, "found issues");
});

test("all three CLI tools support the same background job contract", async () => {
	for (const toolName of ["cli_codex", "cli_claude_code", "cli_qwen"]) {
		const fixture = context();
		let spec;
		fixture.ctx.services.set("jobs", {
			start(value) { spec = value; return `${value.kind}-1`; }
		});
		fixture.ctx.subagents.start = async () => ({
			id: "run-bg",
			result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "background done" }] }),
			dispose: async () => {}
		});
		registerCliSubagentTools(fixture.ctx);
		const tool = fixture.tools.get(toolName);
		const agent = { id: "parent" };
		const value = await tool.execute({ description: "后台检查", prompt: "检查项目", run_in_background: true }, { agent, signal: new AbortController().signal });
		assert.equal(value.kind, "background");
		assert.match(value.jobId, /^cli-(codex|claude|qwen)-1$/);
		assert.equal(spec.owner, agent);
		assert.equal(spec.label, "后台检查");
		const hooks = spec.run();
		assert.equal(typeof hooks.cancel, "function");
		assert.deepEqual(await hooks.done, { status: "completed", output: "background done" });
	}
});

test("background mode fails clearly when the jobs service is absent", async () => {
	const fixture = context();
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	await assert.rejects(() => tool.execute({ description: "后台检查", prompt: "检查项目", run_in_background: true }, { agent: { id: "parent" }, signal: new AbortController().signal }), /后台任务不可用/);
});

test("surfaces a non-completed provider result as a tool error", async () => {
	const fixture = context();
	fixture.ctx.subagents.start = async () => ({
		id: "run-2",
		result: Promise.resolve({ stopReason: "error", diagnostic: "auth missing", output: [] }),
		dispose: async () => {}
	});
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	await assert.rejects(() => tool.execute({ description: "检查认证", prompt: "检查认证" }, { agent: { id: "parent" }, signal: new AbortController().signal }), /auth missing/);
});

test("rejects empty titles and prompts before starting a provider", async () => {
	const fixture = context();
	let starts = 0;
	fixture.ctx.subagents.start = async () => { starts += 1; };
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	const exec = { agent: { id: "parent" }, signal: new AbortController().signal };
	await assert.rejects(() => tool.execute({ description: " ", prompt: "task" }, exec), /description/);
	await assert.rejects(() => tool.execute({ description: "title", prompt: " " }, exec), /prompt/);
	assert.equal(starts, 0);
});
