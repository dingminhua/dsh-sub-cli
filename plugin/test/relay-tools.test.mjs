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
		(error)=>error.code==="CLI_PERMISSION_CONFIGURATION_REQUIRED" && /Codex → 权限/.test(error.message) && /审批策略为“从不”/.test(error.message) && /严禁修改 ~\/\.dsh\/settings\.yaml/.test(error.message)
	);
});

test("relay submit rejects calls without relay child identity",async()=>{
	const f=fixture();
	await assert.rejects(f.tool.execute({prompt:"x"},{agent:null,signal:new AbortController().signal}),/relay child/);
});

test("relay submit forwards web research to the CLI (no up-front refuse)",async()=>{
	// Web research is no longer refused at the capability gate (2026-09-03): it
	// flows per turn to the permission A-gate like any other exec task, so a
	// research prompt now reaches submitFromChild instead of being rejected.
	let forwarded=0;
	const registeredNames=new Set();
	const service={async submitFromChild(){forwarded+=1;return {session:{sessionId:"s1",status:"ready"},output:""};}};
	let tool;
	registerRelaySubmitTool({tools:{registeredNames,register(v){tool=v;}}},service);
	// Web research is no longer refused at the gate (2026-09-03): it flows to
	// the permission A-gate like any other exec task. So a research prompt now
	// reaches submitFromChild instead of being rejected up front.
	const value = await tool.execute({prompt:"联网搜索最近 24 小时 AI 新闻"},{agent:{session:{id:"child-1"},provider:"managed-codex-relay"},signal:new AbortController().signal});
	assert.equal(forwarded, 1, "the research prompt now reaches the CLI (permission tier decides)");
	assert.equal(value.sessionId, "s1");
});
