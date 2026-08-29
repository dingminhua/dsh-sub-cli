import assert from "node:assert/strict";
import test from "node:test";
import { registerManagedSessionTools } from "../lib/session-tools.js";

function fixture() {
	const tools = new Map();
	const calls = [];
	const session = { sessionId: "s1", status: "ready" };
	const service = {
		async followup(id,prompt,signal){ calls.push(["followup",id,prompt,signal]); return {session,output:"next"}; },
		status(id){ calls.push(["status",id]); return session; },
		list(q){ calls.push(["list",q]); return [session]; },
		async interrupt(id){ calls.push(["interrupt",id]); return {interrupted:true,session}; }
	};
	registerManagedSessionTools({ tools: { register(tool){ tools.set(tool.name,tool); } } }, service);
	return {tools,calls};
}

test("registers followup/status/sessions/interrupt tools", () => {
	const f=fixture();
	assert.deepEqual([...f.tools.keys()], ["cli_codex_followup","cli_codex_status","cli_codex_sessions","cli_codex_interrupt"]);
});

test("followup explicitly routes through managed service", async () => {
	const f=fixture(); const signal=new AbortController().signal;
	const v=await f.tools.get("cli_codex_followup").execute({sessionId:"s1",prompt:"go"},{signal});
	assert.deepEqual(v,{sessionId:"s1",status:"ready",output:"next"});
	assert.equal(f.calls[0][0],"followup");
});

test("status list and interrupt use service", async () => {
	const f=fixture();
	assert.equal((await f.tools.get("cli_codex_status").execute({sessionId:"s1"})).sessionId,"s1");
	assert.equal((await f.tools.get("cli_codex_sessions").execute({})).sessions.length,1);
	assert.equal((await f.tools.get("cli_codex_interrupt").execute({sessionId:"s1"})).interrupted,true);
});
