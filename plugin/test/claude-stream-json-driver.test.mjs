// Tests for the Claude stream-json driver. The driver only cares about the
// shape of the spawned handle, so a fake subprocess suffices: the assertions
// exercise argv composition, event parsing, session-id propagation, and the
// followup path that reattaches the same on-disk history.

import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeStreamJsonDriver, CLAUDE_STREAM_JSON_CAPABILITIES } from "../lib/drivers/claude-stream-json.js";
import { assertManagedCliDriver } from "../lib/drivers/types.js";

// In-memory pipe that mimics DSH's subprocess handle: write/read lines,
// record argv for assertion, and resolve `done` on demand.
function fakeHandle({ argv, env, cwd, stdio, signal, graceMs }) {
	const argvCopy = argv.slice();
	let resolveDone;
	const donePromise = new Promise((r) => { resolveDone = r; });
	const handle = {
		argv: argvCopy,
		env,
		cwd,
		stdio,
		signal,
		graceMs,
		stdin: {
			_written: [],
			write(text, cb) { this._written.push(text); cb && cb(null); }
		},
		stdout: {
			_listeners: new Set(),
			on(event, listener) { if (event === "data") this._listeners.add(listener); },
			off(event, listener) { if (event === "data") this._listeners.delete(listener); },
			emit(chunk) { for (const l of this._listeners) l(chunk); },
			// Test helper: emit one NDJSON line at a time.
			pushLine(obj) { this.emit(JSON.stringify(obj) + "\n"); }
		},
		done: donePromise,
		// Test helper: settle the `done` promise so transport.dispose() can complete.
		finishWith(exitCode = 0) { resolveDone({ exitCode }); },
		terminateCalled: 0,
		terminate() { this.terminateCalled++; this.finishWith(0); }
	};
	return handle;
}

function fakeSubprocess(handles) {
	return {
		spawnCalls: [],
		resolveExecutable(bin) { return bin; }, // sync, returns bin directly
		spawn(opts) { // sync: return handle immediately so #spawnTurn can use it
			this.spawnCalls.push(opts);
			const handle = fakeHandle(opts);
			handles.push(handle);
			return handle;
		}
	};
}

function dirSource() { return "/dsh-clis"; }

function seedAnswer(transport, sessionId) {
	// Drive a minimal successful Claude turn over the fake transport.
	transport.pushLine({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-4-5", tools: [], permissionMode: "acceptEdits" });
	transport.pushLine({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello, world." }] } });
	transport.pushLine({ type: "result", subtype: "success", is_error: false, result: "Hello, world.", session_id: sessionId, stop_reason: "end_turn" });
}

test("driver exposes the standard capability shape", () => {
	const driver = new ClaudeStreamJsonDriver({ subprocess: fakeSubprocess([]), dirSource, turnTimeoutMs: 250 });
	assertManagedCliDriver(driver);
	assert.equal(driver.id, "claude-stream-json");
	assert.equal(CLAUDE_STREAM_JSON_CAPABILITIES.continuable, true);
	assert.equal(CLAUDE_STREAM_JSON_CAPABILITIES.durableResume, true);
	assert.equal(CLAUDE_STREAM_JSON_CAPABILITIES.interrupt, false);
	// interactivePermissions is now true: the driver intercepts every tool_use
	// and routes it through the same onPermissionRequest hook as Codex. This
	// unifies permission UX across all three CLIs.
	assert.equal(CLAUDE_STREAM_JSON_CAPABILITIES.interactivePermissions, true);
});

test("start composes the expected argv and surfaces the system/init session id", async () => {
	const handles = [];
	const subprocess = fakeSubprocess(handles);
	const driver = new ClaudeStreamJsonDriver({ subprocess, dirSource, turnTimeoutMs: 250 });
	const run = await driver.start({ cwd: "/repo", prompt: "Hi", model: "claude-sonnet-4-5", sandbox: "workspace-write" });
	// Drive the result over the transport immediately — the listener is
	// already registered by the time the spawn() promise resolves.
	seedAnswer(handles[0].stdout, "init-session-123");
	const value = await run.result;
	assert.equal(run.product, "claude");
	assert.deepEqual(value, {
		threadId: "init-session-123",
		text: "Hello, world.",
		toolRounds: 0,
		stopReason: "end_turn",
		usage: null,
		decisions: []
	});
	// argv sanity: -p, stream-json pair, permission-mode (always bypassPermissions), model, session-id, --add-dir
	const args = handles[0].argv.slice(1); // strip bin
	assert.ok(args.includes("-p"));
	assert.ok(args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json");
	assert.ok(args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "stream-json");
	assert.ok(args.includes("--permission-mode") && args[args.indexOf("--permission-mode") + 1] === "bypassPermissions", "always bypassPermissions (driver enforces per-tool)");
	assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "claude-sonnet-4-5");
	assert.ok(args.includes("--session-id"));
	assert.ok(args.includes("--add-dir") && args[args.indexOf("--add-dir") + 1] === "/repo");
	assert.equal(handles[0].cwd, "/repo");
	// The first user message was written to stdin.
	assert.equal(handles[0].stdin._written.length, 1);
	const userMsg = JSON.parse(handles[0].stdin._written[0]);
	assert.equal(userMsg.type, "user");
	assert.equal(userMsg.message.role, "user");
	assert.equal(userMsg.message.content, "Hi");
	assert.equal(run.remoteSessionId, "init-session-123");
});

test("sandbox tier is ignored — Claude Code always runs at bypassPermissions", async () => {
	// Permission enforcement is now entirely at the driver layer
	// (onPermissionRequest hook → resolvePermission → ctx.approval.request).
	// The CLI always runs at "bypassPermissions" so it registers all tools
	// internally; the driver intercepts each tool_use and gates it against
	// the user's stored permission profile. This unifies the UX across all
	// three CLIs.
	const handles = [];
	const subprocess = fakeSubprocess(handles);
	const driver = new ClaudeStreamJsonDriver({ subprocess, dirSource, turnTimeoutMs: 250 });
	for (const sandbox of ["read-only", "workspace-write", "danger-full-access"]) {
		const run = await driver.start({ cwd: "/r", prompt: "x", sandbox });
		seedAnswer(handles[handles.length - 1].stdout, "s-" + sandbox);
		await run.result;
		const args = handles[handles.length - 1].argv.slice(1);
		const idx = args.indexOf("--permission-mode");
		assert.equal(args[idx + 1], "bypassPermissions", `sandbox=${sandbox} must always be bypassPermissions`);
	}
});

test("followup reuses the resolved session id via --resume", async () => {
	const handles = [];
	const subprocess = fakeSubprocess(handles);
	const driver = new ClaudeStreamJsonDriver({ subprocess, dirSource, turnTimeoutMs: 250 });
	const first = await driver.start({ cwd: "/r", prompt: "first" });
	seedAnswer(handles[0].stdout, "session-abc");
	const firstValue = await first.result;
	assert.equal(firstValue.threadId, "session-abc");
	// Now drive a followup — must spawn a new process and pass --resume.
	const followupPromise = first.followup("second", {});
	seedAnswer(handles[1].stdout, "session-abc");
	await followupPromise;
	const args = handles[1].argv.slice(1);
	assert.ok(args.includes("--resume"), "followup should use --resume");
	assert.equal(args[args.indexOf("--resume") + 1], "session-abc");
	assert.ok(!args.includes("--session-id"), "followup must not reissue --session-id");
});

test("followup rejects empty prompts", async () => {
	const handles = [];
	const subprocess = fakeSubprocess(handles);
	const driver = new ClaudeStreamJsonDriver({ subprocess, dirSource, turnTimeoutMs: 250 });
	const first = await driver.start({ cwd: "/r", prompt: "x" });
	seedAnswer(handles[0].stdout, "s");
	await first.result;
	await assert.rejects(first.followup("   ", {}), /prompt must not be empty/);
});

test("is_error result event surfaces a real Error with the CLI message", async () => {
	const handles = [];
	const subprocess = fakeSubprocess(handles);
	const driver = new ClaudeStreamJsonDriver({ subprocess, dirSource, turnTimeoutMs: 250 });
	const first = await driver.start({ cwd: "/r", prompt: "x" });
	handles[0].stdout.pushLine({ type: "system", subtype: "init", session_id: "s" });
	handles[0].stdout.pushLine({ type: "result", subtype: "error_during_execution", is_error: true, error: { message: "auth failed" } });
	await assert.rejects(first.result, /auth failed/);
});

test("extractFinalText concatenates multiple assistant text blocks", async () => {
	const handles = [];
	const subprocess = fakeSubprocess(handles);
	const driver = new ClaudeStreamJsonDriver({ subprocess, dirSource, turnTimeoutMs: 250 });
	const first = await driver.start({ cwd: "/r", prompt: "x", onPermissionRequest: () => "allowed-once" });
	handles[0].stdout.pushLine({ type: "system", subtype: "init", session_id: "s" });
	handles[0].stdout.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "Part 1. " }] } });
	handles[0].stdout.pushLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } });
	handles[0].stdout.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "Part 2." }] } });
	handles[0].stdout.pushLine({ type: "result", subtype: "success", is_error: false, session_id: "s" });
	const value = await first.result;
	assert.equal(value.text, "Part 1. \nPart 2.");
	assert.equal(value.toolRounds, 1);
});

test("start requires cwd and rejects empty prompt", async () => {
	const driver = new ClaudeStreamJsonDriver({ subprocess: fakeSubprocess([]), dirSource, turnTimeoutMs: 250 });
	await assert.rejects(driver.start({ cwd: "", prompt: "x" }), /cwd is required/);
	await assert.rejects(driver.start({ cwd: "/r", prompt: "  " }), /prompt must not be empty/);
});
