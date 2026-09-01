import { test } from "node:test";
import assert from "node:assert/strict";
import { CLI_SUBAGENT_TOOLS, registerCliSubagentTools } from "../lib/subagent-tools.js";

function context() {
	const tools = new Map();
	const services = new Map();
	const ctx = {
		subagents: { start: async () => { throw new Error("subagents.start must not be used: the one-shot path was removed"); } },
		tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
		get(name) { return services.get(name); }
	};
	ctx.services = services;
	return { ctx, tools };
}

const AGENT = { id: "parent", session: { header: { cwd: "/repo" } } };
const SIGNAL = new AbortController().signal;

test("registers exactly three suffixed session-mode tools", () => {
	const fixture = context();
	registerCliSubagentTools(fixture.ctx);
	assert.deepEqual([...fixture.tools.keys()], [
		"cli_codex_direct",
		"cli_claude_direct",
		"cli_qwen_direct"
	]);
	// The unsuffixed one-shot tools are gone, and no CLI ever had a bare `cli_<cli>` alias.
	assert.equal(fixture.tools.has("cli_claude_code"), false);
	assert.equal(fixture.tools.has("cli_qwen"), false);
	assert.equal(fixture.tools.has("cli_codex"), false);
	assert.equal(CLI_SUBAGENT_TOOLS.length, 3);
});

test("each tool declares no background-job parameter", () => {
	// Concurrency comes from cli_<cli>_subagent, not from run_in_background.
	const fixture = context();
	registerCliSubagentTools(fixture.ctx);
	for (const definition of fixture.tools.values()) {
		assert.equal(definition.parameters.run_in_background, undefined, `${definition.name} must not expose run_in_background`);
	}
});

test("delegates through the managed session service and returns sessionId", async () => {
	for (const [toolName, cli] of [["cli_codex_direct", "codex"], ["cli_claude_direct", "claude"], ["cli_qwen_direct", "qwen"]]) {
		const fixture = context();
		let seen;
		const managedCliAgents = {
			async dispatch(request) { seen = request; return { session: { sessionId: `s-${request.cli}`, status: "ready" }, output: "session-text" }; }
		};
		registerCliSubagentTools(fixture.ctx, { managedCliAgents });
		const tool = fixture.tools.get(toolName);
		const result = await tool.execute({ description: "检查", prompt: "完整检查这个项目" }, { agent: AGENT, signal: SIGNAL });
		assert.equal(seen.cli, cli);
		assert.equal(seen.cwd, "/repo");
		assert.equal(seen.prompt, "完整检查这个项目");
		assert.equal(result.sessionId, `s-${cli}`);
		assert.equal(result.output, "session-text");
	}
});

test("Codex direct shows full-settings guidance after permission rejection", async () => {
	const fixture = context();
	registerCliSubagentTools(fixture.ctx, { managedCliAgents: { async dispatch() { throw new Error("permission request was denied"); } } });
	const tool = fixture.tools.get("cli_codex_direct");
	await assert.rejects(
		tool.execute({ description: "检查", prompt: "检查项目" }, { agent: AGENT, signal: SIGNAL }),
		(error) => error.code === "CLI_PERMISSION_CONFIGURATION_REQUIRED" && /外部 Agent CLI 管理器 → Codex → 权限/.test(error.message) && /“完全”/.test(error.message)
	);
});

test("a network task is refused before any CLI starts", async () => {
	// Codex/Qwen ship no web tool, so the capability gate must reject up front.
	for (const toolName of ["cli_codex_direct", "cli_qwen_direct"]) {
		const fixture = context();
		let dispatched = false;
		const managedCliAgents = { async dispatch() { dispatched = true; return { session: { sessionId: "x" }, output: "" }; } };
		registerCliSubagentTools(fixture.ctx, { managedCliAgents });
		const tool = fixture.tools.get(toolName);
		await assert.rejects(
			tool.execute({ description: "联网调查", prompt: "搜索最近 24 小时的 AI 新闻" }, { agent: AGENT, signal: SIGNAL }),
			/没有内置联网工具/
		);
		assert.equal(dispatched, false, `${toolName} must not start a CLI for a network task`);
	}
});

test("Claude Code may run a network task", async () => {
	const fixture = context();
	const managedCliAgents = { async dispatch() { return { session: { sessionId: "s-claude" }, output: "searched" }; } };
	registerCliSubagentTools(fixture.ctx, { managedCliAgents });
	const tool = fixture.tools.get("cli_claude_direct");
	const result = await tool.execute({ description: "联网调查", prompt: "搜索最近 24 小时的 AI 新闻" }, { agent: AGENT, signal: SIGNAL });
	assert.equal(result.output, "searched");
});

test("rejects empty titles and prompts before dispatching", async () => {
	const fixture = context();
	let dispatches = 0;
	registerCliSubagentTools(fixture.ctx, { managedCliAgents: { async dispatch() { dispatches += 1; return { session: { sessionId: "x" }, output: "" }; } } });
	const tool = fixture.tools.get("cli_codex_direct");
	await assert.rejects(() => tool.execute({ description: " ", prompt: "task" }, { agent: AGENT, signal: SIGNAL }), /description/);
	await assert.rejects(() => tool.execute({ description: "title", prompt: " " }, { agent: AGENT, signal: SIGNAL }), /prompt/);
	assert.equal(dispatches, 0);
});
