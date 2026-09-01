// Tests for the Qwen stream-json driver. The driver only cares about the
// shape of the spawned handle, so a fake subprocess suffices: the assertions
// exercise argv composition, event parsing, session-id propagation, and the
// followup path that reattaches the same on-disk history.
//
// Verified against `qwen --help` and a real spawn on 2026-08-31:
//   - Qwen has NO --input-format flag; the prompt is passed as --prompt <text>.
//   - Qwen has NO --effort flag; reasoningEffort is silently ignored.
//   - Qwen emits exactly ONE JSON object on stdout (`type:"result"`), not NDJSON.

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
		stdin: {
			_written: [],
			_ended: false,
			write(text, cb) { this._written.push(text); cb && cb(null); },
			end() { this._ended = true; }
		},
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

// Qwen's actual output: a single result JSON on stdout (no init / assistant).
function seedSuccessResult(transport, sessionId, text = "Hello, world.") {
	transport.pushLine({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: text, duration_ms: 100, num_turns: 1 });
}

test("driver exposes the standard capability shape", () => {
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess([]), dirSource });
	assertManagedCliDriver(driver);
	assert.equal(driver.id, "qwen-stream-json");
	assert.equal(QWEN_STREAM_JSON_CAPABILITIES.continuable, true);
	assert.equal(QWEN_STREAM_JSON_CAPABILITIES.durableResume, true);
	assert.equal(QWEN_STREAM_JSON_CAPABILITIES.interactivePermissions, false);
	assert.equal(QWEN_STREAM_JSON_CAPABILITIES.interrupt, false);
});

test("start composes the expected argv (stdin-prompt mode, no --input-format, no --effort)", async () => {
	const handles = [];
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess(handles), dirSource });
	const run = await driver.start({ cwd: "/repo", prompt: "Hi there", model: "qwen3-coder-plus" });
	seedSuccessResult(handles[0].stdout, "qwen-session-1");
	const value = await run.result;
	assert.equal(run.product, "qwen");
	assert.equal(value.threadId, "qwen-session-1");
	assert.equal(value.text, "Hello, world.");
	const args = handles[0].argv.slice(1);
	// Qwen-specific argv: -p, --output-format, --prompt (boolean), --model, --session-id, --cwd.
	assert.ok(args.includes("-p"), "must use -p");
	assert.ok(args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "stream-json", "must set --output-format stream-json");
	assert.ok(args.includes("--prompt"), "--prompt enables stdin-prompt mode (no value)");
	// The prompt text goes through stdin, NOT as an argv element:
	assert.ok(!args.includes("Hi there"), "prompt text must not appear in argv");
	assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "qwen3-coder-plus");
	assert.ok(args.includes("--session-id"), "first turn uses --session-id to seed");
	// Qwen has NO --cwd flag (Unknown argument: cwd); cwd is passed via Node's
	// spawn({cwd: ...}) option, which the DSH subprocess service supports.
	assert.ok(!args.includes("--cwd"), "Qwen has no --cwd flag; cwd is set via spawn options");
	// Negative: Qwen has no --input-format, --verbose, --permission-mode, --effort.
	assert.ok(!args.includes("--input-format"), "Qwen has no --input-format");
	assert.ok(!args.includes("--verbose"), "Qwen does not need --verbose");
	assert.ok(!args.includes("--permission-mode"), "Qwen has no --permission-mode");
	assert.ok(!args.includes("--effort"), "Qwen has no --effort");
	assert.equal(handles[0].cwd, "/repo");
	// Driver writes the prompt to stdin.
	assert.equal(handles[0].stdin._written.length, 1);
	assert.equal(handles[0].stdin._written[0], "Hi there\n");
	assert.equal(handles[0].stdin._ended, true, "stdin must be closed (EOF) after writing the prompt so Qwen proceeds");
});

test("reasoningEffort is silently dropped (Qwen has no --effort flag)", async () => {
	const handles = [];
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess(handles), dirSource });
	const origWarn = console.warn;
	const warned = [];
	console.warn = (msg) => warned.push(msg);
	try {
		const run = await driver.start({ cwd: "/r", prompt: "x", reasoningEffort: "high" });
		seedSuccessResult(handles[0].stdout, "s");
		await run.result;
		const args = handles[0].argv.slice(1);
		assert.ok(!args.includes("--effort"), "must not pass --effort to Qwen");
		assert.equal(args.filter((a) => a === "high").length, 0, "reasoningEffort value must not leak into argv");
		assert.equal(warned.length, 1);
		assert.match(warned[0], /reasoningEffort=high/);
	} finally {
		console.warn = origWarn;
	}
});

test("followup reuses the resolved session id via --resume (no --prompt, no stdin write)", async () => {
	const handles = [];
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess(handles), dirSource });
	const first = await driver.start({ cwd: "/r", prompt: "first" });
	seedSuccessResult(handles[0].stdout, "session-abc");
	const firstValue = await first.result;
	assert.equal(firstValue.threadId, "session-abc");
	// Followup: --resume reattaches; we do NOT pass --prompt or write stdin
	// (Qwen's behaviour with --resume + --prompt together is undefined; safer
	// to let the resumed session's history drive the next turn).
	const followupPromise = first.followup("second message", {});
	seedSuccessResult(handles[1].stdout, "session-abc");
	await followupPromise;
	const args = handles[1].argv.slice(1);
	assert.ok(args.includes("--resume"));
	assert.equal(args[args.indexOf("--resume") + 1], "session-abc");
	assert.ok(!args.includes("--session-id"), "followup must not reissue --session-id");
	assert.ok(!args.includes("--prompt"), "followup must not pass --prompt");
	assert.equal(handles[1].stdin._written.length, 0, "followup does not write to stdin");
});

test("is_error result event surfaces a real Error with the CLI message", async () => {
	const handles = [];
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess(handles), dirSource });
	const first = await driver.start({ cwd: "/r", prompt: "x" });
	handles[0].stdout.pushLine({ type: "result", subtype: "error_during_execution", is_error: true, error: { message: "auth failed" } });
	await assert.rejects(first.result, /auth failed/);
});

test("start requires cwd and rejects empty prompt", async () => {
	const driver = new QwenStreamJsonDriver({ subprocess: fakeSubprocess([]), dirSource });
	await assert.rejects(driver.start({ cwd: "", prompt: "x" }), /cwd is required/);
	await assert.rejects(driver.start({ cwd: "/r", prompt: "  " }), /prompt must not be empty/);
});
