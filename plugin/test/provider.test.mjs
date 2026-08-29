import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedCliProvider, MANAGED_PROVIDERS, registerManagedCliProviders } from "../lib/provider.js";

function output(text) { return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }; }

function spawnFixture(stdout = "ok") {
	return {
		resolveExecutable: async (path) => path,
		spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output(stdout), stderr: output("") } })
	};
}

test("declares three managed providers with no LLM capabilities", () => {
	assert.deepEqual(MANAGED_PROVIDERS.map((entry) => entry.name), ["managed-codex", "managed-claude", "managed-qwen"]);
	const provider = new ManagedCliProvider({ name: "managed-codex", cli: "codex", dirSource: () => "/managed", spawn: spawnFixture() });
	assert.deepEqual(provider.capabilities, { outputSchema: false, depthLimit: false, toolFilter: false, persona: false });
	assert.equal(provider.inheritsParentContext, false);
});

test("one-shot run returns CLI stdout as the child result", async () => {
	const provider = new ManagedCliProvider({ name: "managed-codex", cli: "codex", dirSource: () => "/managed", spawn: spawnFixture("DSH CLI connection OK") });
	const run = await provider.start({
		prompt: [{ type: "text", text: "check" }],
		parent: { id: "parent" },
		signal: new AbortController().signal
	});
	const result = await run.result;
	assert.equal(result.stopReason, "completed");
	assert.equal(result.output[0].text, "DSH CLI connection OK");
	await run.dispose();
});

test("rejects empty prompts before launching a CLI", async () => {
	const provider = new ManagedCliProvider({ name: "managed-codex", cli: "codex", dirSource: () => "/managed", spawn: spawnFixture() });
	await assert.rejects(() => provider.start({ prompt: [], signal: new AbortController().signal }), /empty/);
});

test("maps a missing binary to an error result, not a throw", async () => {
	const provider = new ManagedCliProvider({ name: "managed-codex", cli: "codex", dirSource: () => "/managed", spawn: { resolveExecutable: async () => null } });
	const run = await provider.start({ prompt: [{ type: "text", text: "task" }], signal: new AbortController().signal });
	const result = await run.result;
	assert.equal(result.stopReason, "error");
	assert.match(result.diagnostic, /找不到/);
	await run.dispose();
});

test("one-shot Claude and Qwen permission rejection diagnostics point to full settings", async () => {
	for (const [cli, name] of [["claude", "Claude Code"], ["qwen", "Qwen Code"]]) {
		const provider = new ManagedCliProvider({
			name: `managed-${cli}`,
			cli,
			dirSource: () => "/managed",
			spawn: {
				resolveExecutable: async (path) => path,
				spawn: () => ({ done: Promise.resolve({ exitCode: 1 }), collected: { stdout: output(""), stderr: output("Permission request was denied") } })
			}
		});
		const run = await provider.start({ prompt: [{ type: "text", text: "task" }], signal: new AbortController().signal });
		const result = await run.result;
		assert.equal(result.stopReason, "error");
		assert.match(result.diagnostic, new RegExp(`${name} → 权限`));
		assert.match(result.diagnostic, /“完全”/);
	}
});

test("uses the prepared env from the run gate when provided", async () => {
	let calledWith = null;
	const provider = new ManagedCliProvider({
		name: "managed-claude",
		cli: "claude",
		dirSource: () => "/managed",
		spawn: {
			resolveExecutable: async (path) => path,
			spawn: (opts) => { calledWith = opts; return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output("ok"), stderr: output("") } }; }
		},
		prepare: async () => ({ ok: true, env: { ANTHROPIC_MODEL: "deepseek-v4-flash", ANTHROPIC_API_KEY: "sk-test", CLAUDE_CONFIG_DIR: "/managed/config-claude" } })
	});
	const run = await provider.start({ prompt: [{ type: "text", text: "task" }], signal: new AbortController().signal });
	const result = await run.result;
	assert.equal(result.stopReason, "completed");
	assert.equal(calledWith.env.ANTHROPIC_MODEL, "deepseek-v4-flash");
	assert.equal(calledWith.env.CLAUDE_CONFIG_DIR, "/managed/config-claude");
	await run.dispose();
});

test("blocks startup when the run gate is not ready", async () => {
	const provider = new ManagedCliProvider({
		name: "managed-claude",
		cli: "claude",
		dirSource: () => "/managed",
		spawn: { resolveExecutable: async (path) => path },
		prepare: async () => ({ ok: false, reason: "尚未为 Claude Code 配置 Provider 和 Model。" })
	});
	const run = await provider.start({ prompt: [{ type: "text", text: "task" }], signal: new AbortController().signal });
	const result = await run.result;
	assert.equal(result.stopReason, "error");
	assert.match(result.diagnostic, /尚未为 Claude Code 配置/);
	await run.dispose();
});

test("registers each provider on the subagents registry", () => {
	const registrations = [];
	const ctx = { subagents: { registerProvider: (provider) => registrations.push(provider.name) }, subprocess: {} };
	registerManagedCliProviders(ctx, () => "/managed");
	assert.deepEqual(registrations, ["managed-codex", "managed-claude", "managed-qwen"]);
});

test("registering providers never touches the llm adapter registry", () => {
	let adapterCalls = 0;
	const ctx = {
		subagents: { registerProvider: () => {} },
		subprocess: {},
		llm: { registerAdapter: () => { adapterCalls += 1; } }
	};
	registerManagedCliProviders(ctx, () => "/managed");
	assert.equal(adapterCalls, 0);
});
