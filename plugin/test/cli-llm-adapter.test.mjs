import { test } from "node:test";
import assert from "node:assert/strict";
import { CliLlmAdapter, promptFromMessages, registerCliLlmAdapters } from "../lib/cli-llm-adapter.js";

function output(text) {
	return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) };
}

function spawnFixture(stdout = "answer") {
	let seen;
	return {
		get seen() { return seen; },
		resolveExecutable: async (file) => file,
		spawn(spec) {
			seen = spec;
			return {
				done: Promise.resolve({ exitCode: 0, signal: null }),
				collected: { stdout: output(stdout), stderr: output("") }
			};
		}
	};
}

test("promptFromMessages includes initial work, prior answer, and followup", () => {
	const prompt = promptFromMessages([
		{ role: "user", content: [{ type: "text", text: "inspect tests" }] },
		{ role: "assistant", content: [{ type: "text", text: "found one issue" }] },
		{ role: "user", content: [{ type: "text", text: "also check Windows" }] }
	]);
	assert.match(prompt, /inspect tests/);
	assert.match(prompt, /found one issue/);
	assert.match(prompt, /also check Windows/);
});

test("adapter dispatches the durable conversation and emits a text stream", async () => {
	const spawn = spawnFixture("CLI result");
	const adapter = new CliLlmAdapter({ cli: "codex", provider: "dsh-cli-codex", dirSource: () => "/managed", spawn });
	const signal = new AbortController().signal;
	const chunks = [];
	for await (const chunk of adapter.stream({
		provider: "dsh-cli-codex",
		model: "native",
		messages: [{ role: "user", content: [{ type: "text", text: "check project" }] }],
		signal
	})) chunks.push(chunk);
	assert.equal(spawn.seen.argv[0], "/managed/bin/codex");
	assert.ok(spawn.seen.argv.includes("check project") || spawn.seen.argv.some((arg) => String(arg).includes("check project")));
	assert.equal(spawn.seen.signal, signal);
	assert.equal(chunks.find((chunk) => chunk.type === "text-delta").text, "CLI result");
	assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
});

test("adapter emits a terminal error for missing CLI", async () => {
	const spawn = { resolveExecutable: async () => null };
	const adapter = new CliLlmAdapter({ cli: "claude", provider: "dsh-cli-claude", dirSource: () => "/managed", spawn });
	const chunks = [];
	for await (const chunk of adapter.stream({ messages: [{ role: "user", content: [{ type: "text", text: "task" }] }], signal: new AbortController().signal })) chunks.push(chunk);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].type, "finish");
	assert.equal(chunks[0].reason.kind, "error");
	assert.match(chunks[0].reason.failure.message, /找不到/);
});

test("adapter implements the full LLM adapter method surface used at registration", () => {
	const adapter = new CliLlmAdapter({ cli: "codex", provider: "dsh-cli-codex", dirSource: () => "/managed", spawn: {} });
	assert.equal(typeof adapter.providerInfo, "function");
	assert.equal(typeof adapter.providerRetryPolicy, "function");
	assert.equal(typeof adapter.listModels, "function");
	assert.equal(typeof adapter.resolveModel, "function");
	assert.equal(typeof adapter.stream, "function");
	assert.equal(adapter.providerRetryPolicy("dsh-cli-codex"), undefined);
});

test("registers four isolated CLI provider routes", () => {
	const calls = [];
	const ctx = {
		llm: { registerAdapter: (providers, adapter) => calls.push({ providers, adapter }) },
		subprocess: {},
	};
	registerCliLlmAdapters(ctx, () => "/managed");
	assert.deepEqual(calls.map((call) => call.providers[0]), ["dsh-cli-codex", "dsh-cli-claude", "dsh-cli-opencode", "dsh-cli-gemini"]);
});
