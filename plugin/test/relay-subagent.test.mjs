import assert from "node:assert/strict";
import test from "node:test";
import { attachRelayLifecycle, registerCodexSubagentTool, RELAY_PERSONA } from "../lib/relay-subagent.js";

function toolFixture(){
	let tool,request;
	const ctx={
		tools:{register(v){tool=v;}},
		subagents:{async startContinuable(v){request=v;return{childId:"child-1"};}}
	};
	const service={};
	registerCodexSubagentTool(ctx,service,async()=>({ok:true}));
	return{ctx,get tool(){return tool;},get request(){return request;}};
}

test("cli_codex_subagent creates a continuable relay with restricted tools",async()=>{
	const f=toolFixture(); const agent={session:{header:{cwd:"/repo"}}};
	const value=await f.tool.execute({description:"Codex 审查",prompt:"review"},{agent,signal:new AbortController().signal});
	assert.deepEqual(value,{kind:"continuable",subagentId:"child-1"});
	assert.equal(f.request.provider,"managed-codex-relay");
	assert.equal(f.request.label,"Codex 审查");
	assert.equal(f.request.request.parent,agent);
	assert.deepEqual(f.request.request.toolFilter,{allow:["managed_cli_submit"]});
	assert.match(f.request.request.persona,/relay bridge/);
	assert.equal(RELAY_PERSONA.includes("must call"),true);
});

test("relay lifecycle installs submit-before-report guard with disposer",()=>{
	let contribution,startListener;
	const service={
		beginChildEpoch(){},
		childCanReport(id){return id==="allowed";}
	};
	const ctx={
		on(name,fn){if(name==="subagent/start")startListener=fn;},
		subagents:{registerContinuableSetup(fn){contribution=fn;}}
	};
	attachRelayLifecycle(ctx,service);
	assert.equal(typeof contribution,"function");
	let guard;
	const dispose=()=>{};
	const returned=contribution({tools:{guard(fn){guard=fn;return dispose;}}});
	assert.equal(returned,dispose);
	assert.match(guard({name:"report",agent:{session:{id:"blocked"}}}),/has not called/);
	assert.equal(guard({name:"report",agent:{session:{id:"allowed"}}}),undefined);
	assert.equal(guard({name:"managed_cli_submit",agent:{session:{id:"blocked"}}}),undefined);
	startListener({id:"allowed"});
});
