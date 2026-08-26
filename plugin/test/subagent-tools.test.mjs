import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCliSubagentTools } from "../lib/subagent-tools.js";

function context(initialProviders = []) {
	const providers = new Map(initialProviders.map((name) => [name, { name }]));
	const tools = new Map();
	const listeners = new Map();
	const cleanups = [];
	const ctx = {
		subagents: {
			getProvider: (name) => providers.get(name),
			start: async () => { throw new Error("start not configured"); }
		},
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			}
		},
		on(name, listener) {
			listeners.set(name, listener);
			return () => listeners.delete(name);
		},
		effect(factory) {
			const cleanup = factory();
			if (cleanup) cleanups.push(cleanup);
			return cleanup;
		}
	};
	return { ctx, providers, tools, listeners, cleanups };
}

test("registers only tools whose native providers exist", () => {
	const fixture = context(["codex"]);
	registerCliSubagentTools(fixture.ctx);
	assert.deepEqual([...fixture.tools.keys()], ["cli_codex"]);
});

test("mounts and unmounts a tool with provider lifecycle", () => {
	const fixture = context();
	registerCliSubagentTools(fixture.ctx);
	fixture.providers.set("claude-code", { name: "claude-code" });
	fixture.listeners.get("subagent/provider-added")({ name: "claude-code" });
	assert.ok(fixture.tools.has("cli_claude_code"));
	fixture.listeners.get("subagent/provider-removed")("claude-code");
	assert.equal(fixture.tools.has("cli_claude_code"), false);
});

test("delegates through subagents with display label and self-contained prompt", async () => {
	const fixture = context(["codex"]);
	let seen;
	let disposed = false;
	fixture.ctx.subagents.start = async (provider, request) => {
		seen = { provider, request };
		return {
			id: "run-1",
			result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "done" }] }),
			dispose: async () => { disposed = true; }
		};
	};
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	const agent = { id: "parent" };
	const signal = new AbortController().signal;
	const result = await tool.execute({ description: "检查测试", prompt: "完整检查项目测试" }, { agent, signal });
	assert.equal(seen.provider, "codex");
	assert.equal(seen.request.label, "检查测试");
	assert.deepEqual(seen.request.prompt, [{ type: "text", text: "完整检查项目测试" }]);
	assert.equal(seen.request.parent, agent);
	assert.equal(seen.request.signal, signal);
	assert.equal(result.runId, "run-1");
	assert.equal(result.output[0].text, "done");
	assert.equal(disposed, true);
});

test("rejects empty titles and prompts before starting a provider", async () => {
	const fixture = context(["codex"]);
	let starts = 0;
	fixture.ctx.subagents.start = async () => { starts += 1; };
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	const exec = { agent: { id: "parent" }, signal: new AbortController().signal };
	await assert.rejects(() => tool.execute({ description: " ", prompt: "task" }, exec), /description/);
	await assert.rejects(() => tool.execute({ description: "title", prompt: " " }, exec), /prompt/);
	assert.equal(starts, 0);
});

test("surfaces failed provider results and still disposes", async () => {
	const fixture = context(["codex"]);
	let disposed = false;
	fixture.ctx.subagents.start = async () => ({
		id: "run-2",
		result: Promise.resolve({ stopReason: "error", diagnostic: "auth missing", output: [] }),
		dispose: async () => { disposed = true; }
	});
	registerCliSubagentTools(fixture.ctx);
	const tool = fixture.tools.get("cli_codex");
	await assert.rejects(
		() => tool.execute({ description: "检查认证", prompt: "检查认证是否有效" }, { agent: { id: "parent" }, signal: new AbortController().signal }),
		/auth missing/
	);
	assert.equal(disposed, true);
});
