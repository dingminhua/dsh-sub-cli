import assert from "node:assert/strict";
import test from "node:test";
import { ManagedCodexRelayProvider, registerManagedCodexRelayProvider } from "../lib/relay-provider.js";

function service() {
	const calls=[];
	return { calls, bindChild(id,v){calls.push(["bind",id,v]);}, setChildCwd(id,cwd){calls.push(["cwd",id,cwd]);} };
}

test("relay provider binds child and cwd during prepareContinuable", async () => {
	const s=service(); const provider=new ManagedCodexRelayProvider({service:s});
	assert.equal(provider.name,"managed-codex-relay");
	assert.equal(provider.capabilities.persona,true);
	assert.equal(provider.capabilities.toolFilter,true);
	assert.deepEqual(await provider.prepareContinuable({sessionId:"child-1",parent:{session:{header:{cwd:"/repo"}}}}),{seed:[]});
	assert.deepEqual(s.calls,[["bind","child-1",{cli:"codex",parentAgent:{session:{header:{cwd:"/repo"}}}}],["cwd","child-1","/repo"]]);
	await assert.rejects(provider.start(),/continuable-only/);
});

test("relay provider registers on subagent registry", () => {
	let seen; const s=service();
	const provider=registerManagedCodexRelayProvider({subagents:{registerProvider(v){seen=v;}}},s);
	assert.equal(seen,provider);
});
