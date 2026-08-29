import assert from "node:assert/strict";
import test from "node:test";

import {
	CodexAppServerProvider,
	registerCodexAppServerProvider
} from "../lib/drivers/codex-provider.js";
import { registerExperimentalCodexProvider } from "../lib/drivers/index.js";

function request(overrides = {}) {
	return {
		prompt: [{ type: "text", text: "inspect" }],
		parent: { session: { header: { cwd: "/repo" } } },
		signal: new AbortController().signal,
		...overrides
	};
}

function fakeDriver() {
	const calls = [];
	let disposed = false;
	return {
		calls,
		get disposed() { return disposed; },
		async start(input) {
			calls.push(input);
			return {
				remoteSessionId: "thread-1",
				result: Promise.resolve({ text: "answer", stopReason: "completed" }),
				status: () => ({ progress: "halfway" }),
				async dispose() { disposed = true; }
			};
		}
	};
}

test("Codex provider maps DSH request and live route into the driver", async () => {
	const driver = fakeDriver();
	const provider = new CodexAppServerProvider({
		driver,
		routeSource: async () => ({ model: "kimi-k3", reasoningEffort: "high" }),
		permissionSource: () => "workspace-write"
	});
	const run = await provider.start(request());
	assert.equal(driver.calls.length, 1);
	assert.equal(driver.calls[0].cwd, "/repo");
	assert.equal(driver.calls[0].prompt, "inspect");
	assert.equal(driver.calls[0].model, "kimi-k3");
	assert.equal(driver.calls[0].reasoningEffort, "high");
	assert.equal(driver.calls[0].approvalPolicy, "never");
	assert.equal(driver.calls[0].sandbox, "workspace-write");
	assert.deepEqual(await run.result, { output: [{ type: "text", text: "answer" }], stopReason: "completed" });
	assert.equal(run.readOutput(), "halfway");
	assert.equal(run.remoteSessionId(), "thread-1");
	await run.dispose();
	assert.equal(driver.disposed, true);
});

test("Codex provider maps driver failure to a subagent error result", async () => {
	const driver = {
		async start() {
			return {
				result: Promise.reject(new Error("turn failed")),
				status: () => ({ progress: "" }),
				async dispose() {}
			};
		}
	};
	const run = await new CodexAppServerProvider({ driver }).start(request());
	assert.deepEqual(await run.result, { output: [], stopReason: "error", diagnostic: "turn failed" });
});

test("Codex provider rejects non-text prompts and missing cwd", async () => {
	const provider = new CodexAppServerProvider({ driver: fakeDriver() });
	await assert.rejects(provider.start(request({ prompt: [{ type: "image", source: "x" }] })), /only non-empty text/);
	await assert.rejects(provider.start(request({ parent: { session: { header: {} } } })), /working directory/);
});

test("provider registration keeps the experimental name separate", () => {
	const registered = [];
	const driver = fakeDriver();
	const provider = registerCodexAppServerProvider({ subagents: { registerProvider(value) { registered.push(value); } } }, { driver });
	assert.equal(provider.name, "managed-codex-app-server");
	assert.equal(registered[0], provider);
	assert.equal(provider.inheritsParentContext, false);
});

test("experimental provider assembly accepts an injected driver set", () => {
	const registered = [];
	const driver = fakeDriver();
	const provider = registerExperimentalCodexProvider({
		subagents: { registerProvider(value) { registered.push(value); } },
		subprocess: {}
	}, {
		drivers: { codex: driver },
		name: "experimental-codex",
		dirSource: () => "/managed"
	});
	assert.equal(provider.name, "experimental-codex");
	assert.equal(registered.length, 1);
});
