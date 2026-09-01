// Tests for the Qwen stream-json driver. The driver only cares about the
// shape of the spawned handle, so a fake subprocess suffices: the assertions
// exercise argv composition, event parsing, session-id propagation, and the
// followup path that reattaches the same on-disk history.

import assert from "node:assert/strict";
import test from "node:test";
import { QwenStreamJsonDriver, QWEN_STREAM_JSON_CAPABILITIES } from "../lib/drivers/qwen-stream-json.js";
import { assertManagedCliDriver } from "../lib/drivers/types.js";

function fakeHandle({ argv, env, cwd, stdio, signal, graceMs }) {
	const argvCopy = argv.slice();
	let resolveDone;
	const donePromise = new Promise((r) => { resolveDone = r; });
	return {
		argv: argvCopy, env, cwd, stdio, signal, graceMs,
		stdin: { _written: [], write(text, cb) { this._written.push(text); cb && cb(null); } },
		stdout: {
			_listeners: new Set(),
			on(event, listener) { if (event === "data") this._listeners.add(listener); },
			off(event, listener) { if (event === "data") this._listeners.delete(listener); },
			emit(chunk) { for (const l of this._listeners) l(chunk); },
			pushLine(obj) { this.emit(JSON.stringify(obj) + "\n"); }
		},
		done: donePromise,
		finishWith(exitCode = 0) { resolveDone({ exitCode }); },
		terminateCalled: 0,
		terminate() { this.terminateCalled++; this.finishWith(0); }
	};
}

function fakeSubprocess(handles) {
	return {
		spawnCalls: [],
		resolveExecutable(bin) { return bin; },
		spawn(opts) {
			this.spawnCalls.push(opts);
			const handle = fakeHandle(opts);
			handles.push(handle);
			return handle;
		}
	};
}

function dirSource() { return "/dsh-clis"; }

function seedAnswer(transport, sessionId) {
	transport.pushLine({ type: "system", subtype: "init", session_id: sessionId, model: "qwen3-coder-plus" });
	transport.pushLine({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello, world." }] } });
	transport.pushLine({ type: "result", subtype: "success", is_error: false, result: "Hello, world.", session_id: sessionId });
}

test("driver exposes the standard capability shape", () => {
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess([]), dirSource });
	assertManagedCliDriver(driver);
	assert.equal(driver.id, "qwen-stream-json");
	assert.equal(QWEN_STREAM_JSON_CAPABILITIES.continuable, true);
	assert.equal(QWEN_STREAM_JSON_CAPABILITIES.durableResume, true);
	assert.equal(QWEN_STREAM_JSON_CAPABILITIES.interactivePermissions, false);
});

test("start composes the expected argv and surfaces the system/init session id", async () => {
	const handles = [];
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess(handles), dirSource });
	const run = await driver.start({ cwd: "/repo", prompt: "Hi", model: "qwen3-coder-plus" });
	seedAnswer(handles[0].stdout, "qwen-session-1");
	const value = await run.result;
	assert.equal(run.product, "qwen");
	assert.equal(value.threadId, "qwen-session-1");
	assert.equal(value.text, "Hello, world.");
	const args = handles[0].argv.slice(1);
	assert.ok(args.includes("-p"));
	assert.ok(args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json");
	assert.ok(args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "stream-json");
	assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "qwen3-coder-plus");
	assert.ok(args.includes("--session-id"));
	assert.ok(args.includes("--cwd") && args[args.indexOf("--cwd") + 1] === "/repo");
	// Qwen does NOT use --permission-mode or --verbose.
	assert.ok(!args.includes("--permission-mode"), "Qwen has no --permission-mode");
	assert.ok(!args.includes("--verbose"), "Qwen does not need --verbose for stream-json");
	assert.equal(handles[0].cwd, "/repo");
});

test("followup reuses the resolved session id via --resume", async () => {
	const handles = [];
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess(handles), dirSource });
	const first = await driver.start({ cwd: "/r", prompt: "first" });
	seedAnswer(handles[0].stdout, "session-abc");
	const firstValue = await first.result;
	assert.equal(firstValue.threadId, "session-abc");
	const followupPromise = first.followup("second", {});
	seedAnswer(handles[1].stdout, "session-abc");
	await followupPromise;
	const args = handles[1].argv.slice(1);
	assert.ok(args.includes("--resume"));
	assert.equal(args[args.indexOf("--resume") + 1], "session-abc");
	assert.ok(!args.includes("--session-id"));
});

test("is_error result event surfaces a real Error with the CLI message", async () => {
	const handles = [];
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess(handles), dirSource });
	const first = await driver.start({ cwd: "/r", prompt: "x" });
	handles[0].stdout.pushLine({ type: "system", subtype: "init", session_id: "s" });
	handles[0].stdout.pushLine({ type: "result", subtype: "error_during_execution", is_error: true, error: { message: "auth failed" } });
	await assert.rejects(first.result, /auth failed/);
});

test("start requires cwd and rejects empty prompt", async () => {
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess([]), dirSource });
	await assert.rejects(driver.start({ cwd: "", prompt: "x" }), /cwd is required/);
	await assert.rejects(driver.start({ cwd: "/r", prompt: "  " }), /prompt must not be empty/);
});
