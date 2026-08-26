import { test } from "node:test";
import assert from "node:assert/strict";
import {
	fingerprint,
	codexToml,
	providerConfig,
	credentialKey,
	isVerifiedCurrentAsync,
	writeVerified,
	currentFingerprint,
	probeToolContinuation,
	findCallId
} from "../lib/verify.js";

function sampleCtx({ value, providerCfg, credKey } = {}) {
	const providers = providerCfg
		? [{ provider: "k3-baoyue", settingsNs: "llm-pi-ai", settingsPath: ["providers", "k3-baoyue"] }]
		: [];
	return {
		settings: {
			describe: () => [
				{ ns: "dsh-sub-cli", value: value || { models: {}, verified: {} } },
				{ ns: "llm-pi-ai", value: { providers: { "k3-baoyue": providerCfg || {} } } }
			],
			async mutate() {}
		},
		llm: { listConfigurableProviders: () => providers },
		credentials: { resolve: async () => (credKey ? { value: credKey } : { value: undefined }) }
	};
}

test("fingerprint is stable and reflects the route", () => {
	assert.equal(fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1"), fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1"));
	assert.notEqual(fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1"), fingerprint("other", "kimi-k3", "max", "https://api.supxh.xin/v1"));
});

test("codexToml points Codex at the supplier with responses wire", () => {
	const toml = codexToml(
		{ provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "max" },
		{ baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY" }
	);
	assert.ok(toml.includes('model = "kimi-k3"'));
	assert.ok(toml.includes('model_provider = "k3-baoyue"'));
	assert.ok(toml.includes('base_url = "https://api.supxh.xin/v1"'));
	assert.ok(toml.includes('env_key = "K3_BAOYUE_API_KEY"'));
	assert.ok(toml.includes('wire_api = "responses"'));
});

test("providerConfig resolves baseURL + apiKeyEnv from DSH provider settings", async () => {
	const ctx = sampleCtx({ providerCfg: { baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY", displayName: "k3包月" } });
	const pc = await providerConfig(ctx, "k3-baoyue");
	assert.deepEqual(pc, { baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY", displayName: "k3包月" });
});

test("credentialKey returns the live credential value (never cached)", async () => {
	const ctx = sampleCtx({ credKey: "sk-live-key" });
	assert.equal(await credentialKey(ctx, "K3_BAOYUE_API_KEY"), "sk-live-key");
});

test("isVerifiedCurrentAsync is false when route changes (invalidated)", async () => {
	const ctx = sampleCtx({
		providerCfg: { baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY" },
		value: {
			models: { codex: { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "max" } },
			verified: { codex: { ok: true, provider: "k3-baoyue", model: "kimi-k3", fingerprint: fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1") } }
		}
	});
	assert.equal(await isVerifiedCurrentAsync(ctx, "codex"), true);
});

test("changing model invalidates a prior verification", async () => {
	const ctx = sampleCtx({
		providerCfg: { baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY" },
		value: {
			models: { codex: { provider: "k3-baoyue", model: "other-model", reasoningEffort: "max" } },
			verified: { codex: { ok: true, provider: "k3-baoyue", model: "kimi-k3", fingerprint: fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1") } }
		}
	});
	assert.equal(await isVerifiedCurrentAsync(ctx, "codex"), false);
});

test("currentFingerprint reflects baseURL", async () => {
	const ctx = sampleCtx({
		providerCfg: { baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY" },
		value: { models: { codex: { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "max" } } }
	});
	assert.equal(await currentFingerprint(ctx, "codex"), fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1"));
});

test("writeVerified stores provider + model + fingerprint", async () => {
	let written = null;
	const ctx = sampleCtx({
		providerCfg: { baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY" },
		value: { models: { codex: { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "max" } } }
	});
	ctx.settings.mutate = async (_ns, ops) => { written = ops; };
	await writeVerified(ctx, "codex", { version: "0.149.1" });
	assert.equal(written[0].op, "set");
	assert.equal(written[0].path[0], "verified");
	assert.equal(written[0].path[1], "codex");
	assert.equal(written[0].value.provider, "k3-baoyue");
	assert.equal(written[0].value.model, "kimi-k3");
	assert.ok(written[0].value.fingerprint);
});
test("findCallId extracts call_id from a function_call item", () => {
	const body = { output: [{ type: "message", content: [] }, { type: "function_call", call_id: "call_123", name: "get_time" }] };
	assert.equal(findCallId(body), "call_123");
	assert.equal(findCallId({ output: [] }), null);
});

test("probeToolContinuation passes when step2 continuation succeeds", async () => {
	let calls = 0;
	const httpPost = async () => {
		calls += 1;
		if (calls === 1) return { status: 200, body: { id: "resp_1", output: [{ type: "function_call", call_id: "call_abc", name: "get_time" }] } };
		return { status: 200, body: { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] } };
	};
	const r = await probeToolContinuation({ httpPost, baseURL: "https://api.example/v1", apiKey: "k", model: "m" });
	assert.equal(r.toolContinuation, true);
	assert.equal(calls, 2);
});

test("probeToolContinuation fails when step2 continuation is rejected (aixforge case)", async () => {
	let calls = 0;
	const httpPost = async () => {
		calls += 1;
		if (calls === 1) return { status: 200, body: { id: "resp_1", output: [{ type: "function_call", call_id: "call_abc", name: "get_time" }] } };
		// aixforge-style rejection
		return { status: 400, body: { error: { message: "function_call_output requires call_id on HTTP requests; continuation via previous_response_id is only supported on Responses WebSocket v2" } } };
	};
	const r = await probeToolContinuation({ httpPost, baseURL: "https://api.aixforge.com/v1", apiKey: "k", model: "deepseek-v4-flash" });
	assert.equal(r.toolContinuation, false);
	assert.equal(r.step, 2);
	assert.equal(r.step1Status, 200);
	assert.equal(r.step2Status, 400);
});

test("probeToolContinuation reports no function_call when model answers directly", async () => {
	const httpPost = async () => ({ status: 200, body: { id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "当前时间是..." }] }] } });
	const r = await probeToolContinuation({ httpPost, baseURL: "https://api.example/v1", apiKey: "k", model: "m" });
	assert.equal(r.toolContinuation, null);
	assert.equal(r.step, 1);
});

test("writeVerified stores capabilities when provided", async () => {
	let written = null;
	const ctx = sampleCtx({
		providerCfg: { baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY" },
		value: { models: { codex: { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "max" } } }
	});
	ctx.settings.mutate = async (_ns, ops) => { written = ops; };
	await writeVerified(ctx, "codex", { version: "0.149.1", capabilities: { toolContinuation: false } });
	assert.equal(written[0].value.capabilities.toolContinuation, false);
});

test("writeVerified stores a failure record with ok:false + error + fingerprint", async () => {
	let written = null;
	const ctx = sampleCtx({
		providerCfg: { baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY" },
		value: { models: { codex: { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "max" } } }
	});
	ctx.settings.mutate = async (_ns, ops) => { written = ops; };
	await writeVerified(ctx, "codex", { ok: false, error: "当前供应商不支持 Codex 所需的新接口" });
	assert.equal(written[0].value.ok, false);
	assert.equal(written[0].value.error, "当前供应商不支持 Codex 所需的新接口");
	assert.ok(written[0].value.fingerprint);
	assert.ok(written[0].value.provider);
});
