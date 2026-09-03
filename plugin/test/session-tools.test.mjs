import assert from "node:assert/strict";
import test from "node:test";
import { registerManagedSessionTools } from "../lib/session-tools.js";

function fixture() {
	const tools = new Map();
	const calls = [];
	const session = { sessionId: "s1", status: "ready" };
	const service = {
		async followup(id, prompt, signal) { calls.push(["followup", id, prompt, signal]); return { session, output: "next" }; },
		status(id) { calls.push(["status", id]); return session; },
		list(q) { calls.push(["list", q]); return [session]; },
		async interrupt(id) { calls.push(["interrupt", id]); return { interrupted: true, session }; }
	};
	registerManagedSessionTools({ tools: { register(tool) { tools.set(tool.name, tool); } } }, service);
	return { tools, calls };
}

test("registers followup/status/sessions/interrupt for codex and claude", () => {
	const f = fixture();
	// codex: followup, status, sessions, interrupt
	assert.ok(f.tools.has("cli_codex_followup"), "codex followup");
	assert.ok(f.tools.has("cli_codex_status"), "codex status");
	assert.ok(f.tools.has("cli_codex_sessions"), "codex sessions");
	assert.ok(f.tools.has("cli_codex_interrupt"), "codex interrupt");
	// claude: followup, status, sessions, interrupt
	assert.ok(f.tools.has("cli_claude_followup"), "claude followup");
	assert.ok(f.tools.has("cli_claude_status"), "claude status");
	assert.ok(f.tools.has("cli_claude_sessions"), "claude sessions");
	assert.ok(f.tools.has("cli_claude_interrupt"), "claude interrupt");
	// Qwen tools are gone with the CLI (2026-09 removal).
	assert.ok(!f.tools.has("cli_qwen_followup"), "qwen followup gone");
	assert.ok(!f.tools.has("cli_qwen_status"), "qwen status gone");
});

test("followup routes through managed service with sessionId and prompt", async () => {
	const f = fixture();
	const signal = new AbortController().signal;
	for (const toolName of ["cli_codex_followup", "cli_claude_followup"]) {
		f.calls.length = 0;
		const v = await f.tools.get(toolName).execute({ sessionId: "s1", prompt: "go" }, { signal });
		assert.deepEqual(v, { sessionId: "s1", status: "ready", output: "next" });
		assert.equal(f.calls[0][0], "followup");
		assert.equal(f.calls[0][1], "s1");
		assert.equal(f.calls[0][2], "go");
	}
});

test("status, sessions, interrupt use service methods", async () => {
	const f = fixture();
	// status
	assert.equal((await f.tools.get("cli_codex_status").execute({ sessionId: "s1" })).sessionId, "s1");
	// sessions lists all
	const all = await f.tools.get("cli_claude_sessions").execute({});
	assert.equal(all.sessions.length, 1);
	// interrupt
	assert.equal((await f.tools.get("cli_codex_interrupt").execute({ sessionId: "s1" })).interrupted, true);
});
