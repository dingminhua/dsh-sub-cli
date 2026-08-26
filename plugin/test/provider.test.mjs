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

test("declares four managed providers with no LLM capabilities", () => {
	assert.deepEqual(MANAGED_PROVIDERS.map((entry) => entry.name), ["managed-codex", "managed-claude", "managed-opencode", "managed-gemini"]);
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

test("registers each provider on the subagents registry", () => {
	const registrations = [];
	const ctx = { subagents: { registerProvider: (provider) => registrations.push(provider.name) }, subprocess: {} };
	registerManagedCliProviders(ctx, () => "/managed");
	assert.deepEqual(registrations, ["managed-codex", "managed-claude", "managed-opencode", "managed-gemini"]);
});
