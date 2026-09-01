import assert from "node:assert/strict";
import test from "node:test";
import { registerRelaySubmitTool, RELAY_SUBMIT_TOOL } from "../lib/relay-tools.js";

function fixture(){
	let tool, seen;
	const registeredNames = new Set();
	const service = { async submitFromChild(id, prompt, signal) { seen = { id, prompt, signal }; return { session: { sessionId: "s1", status: "ready" }, output: "codex result" }; } };
	registerRelaySubmitTool({ tools: { registeredNames, register(v) { tool = v; } } }, service);
	return { get tool() { return tool; }, get seen() { return seen; } };
}

test("relay submit identifies caller child and forwards to service",async()=>{
	const f=fixture(); const signal=new AbortController().signal;
	const value=await f.tool.execute({prompt:"task"},{agent:{session:{id:"child-1"}},signal});
	assert.equal(f.tool.name,RELAY_SUBMIT_TOOL);
	assert.deepEqual(value,{sessionId:"s1",status:"ready",output:"codex result"});
	assert.deepEqual(f.seen,{id:"child-1",prompt:"task",signal});
});

test("relay submit replaces permission rejection with full-settings guidance",async()=>{
	let tool;
	const registeredNames = new Set();
	registerRelaySubmitTool({tools:{registeredNames, register(v){tool=v;}}}, {async submitFromChild(){throw new Error('Rejected("rejected by user")');}});
	await assert.rejects(
		tool.execute({prompt:"task"},{agent:{session:{id:"child-1"},provider:"managed-codex-relay"},signal:new AbortController().signal}),
		(error)=>error.code==="CLI_PERMISSION_CONFIGURATION_REQUIRED" && /Codex → 权限/.test(error.message) && /“完全”/.test(error.message)
	);
});

test("relay submit rejects calls without relay child identity",async()=>{
	const f=fixture();
	await assert.rejects(f.tool.execute({prompt:"x"},{agent:null,signal:new AbortController().signal}),/relay child/);
});
