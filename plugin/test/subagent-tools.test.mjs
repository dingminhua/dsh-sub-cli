import { test } from "node:test";
import assert from "node:assert/strict";
import { CLI_SUBAGENT_TOOLS, registerCliSubagentTools } from "../lib/subagent-tools.js";

function context() {
	const tools = new Map();
	const ctx = {
		subagents: {
			startContinuable: async () => { throw new Error("start not configured"); }
		},
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			}
		}
	};
	return { ctx, tools };
}

test("registers all four CLI tools globally without product providers", () => {
	const fixture = context();
	registerCliSubagentTools(fixture.ctx);
	assert.deepEqual([...fixture.tools.keys()], ["cli_codex", "cli_claude_code", "cli_opencode", "cli_gemini"]);
	assert.equal(CLI_SUBAGENT_TOOLS.length, 4);
});

test("starts a native continuable child on the matching CLI route", async () => {
	const fixture = context();
	let seen;
	fixture.ctx.subagents.startContinuable = async (spec) => {
		seen = spec;
		return { childId: "child-1", messageId: "message-1" };
	};
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	const agent = { id: "parent" };
	const signal = new AbortController().signal;
	const result = await tool.execute({ description: "检查测试", prompt: "完整检查项目测试" }, { agent, signal });
	assert.deepEqual(result, { subagentId: "child-1" });
	assert.equal(seen.provider, "spawn");
	assert.equal(seen.label, "检查测试");
	assert.equal(seen.request.parent, agent);
	assert.deepEqual(seen.request.prompt, [{ type: "text", text: "完整检查项目测试" }]);
	assert.deepEqual(seen.request.agentOptions, { provider: "dsh-cli-codex", model: "native" });
	assert.equal(seen.signal, signal);
});

test("uses a distinct LLM route for every CLI", async () => {
	const fixture = context();
	const routes = [];
	fixture.ctx.subagents.startContinuable = async (spec) => {
		routes.push(spec.request.agentOptions.provider);
		return { childId: `child-${routes.length}`, messageId: `message-${routes.length}` };
	};
	registerCliSubagentTools(fixture.ctx);
	for (const tool of fixture.tools.values()) {
		await tool.execute({ description: "运行任务", prompt: "执行完整任务" }, { agent: { id: "parent" }, signal: new AbortController().signal });
	}
	assert.deepEqual(routes, ["dsh-cli-codex", "dsh-cli-claude", "dsh-cli-opencode", "dsh-cli-gemini"]);
});

test("rejects empty titles and prompts before creating a child", async () => {
	const fixture = context();
	let starts = 0;
	fixture.ctx.subagents.startContinuable = async () => { starts += 1; };
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	const exec = { agent: { id: "parent" }, signal: new AbortController().signal };
	await assert.rejects(() => tool.execute({ description: " ", prompt: "task" }, exec), /description/);
	await assert.rejects(() => tool.execute({ description: "title", prompt: " " }, exec), /prompt/);
	assert.equal(starts, 0);
});
