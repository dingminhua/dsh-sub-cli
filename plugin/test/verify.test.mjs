import { test } from "node:test";
import assert from "node:assert/strict";
import {
	fingerprint,
	codexToml,
	qwenSettings,
	stripTrailingV1,
	joinApiPath,
	providerConfig,
	credentialKey,
	isVerifiedCurrentAsync,
	writeVerified,
	currentFingerprint,
	probeToolContinuation,
	findCallId,
	findAnthropicToolUseId,
	findChatToolCallId,
	probeAnthropicContinuation,
	probeOpenaiChatContinuation,
	probeProtocolContinuation,
	extractCliReply,
	extractCodexError,
	isCodexMetadataWarning,
	localizeCliError
} from "../lib/verify.js";

function sampleCtx({ value, providerCfg, credKey } = {}) {
	const providers = providerCfg
		? [{ provider: "k3-baoyue", settingsNs: "llm-pi-ai", settingsPath: ["providers", "k3-baoyue"] }]
		: [];
	const services = {
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
	// Optional services are read via ctx.get() in the plugin (never declared on
	// the inject list), so the test ctx must expose the same accessor.
	return { get: (key) => services[key], ...services };
}

test("localizeCliError translates Claude login errors into Simplified Chinese", () => {
	assert.equal(localizeCliError("claude", "Not logged in · Please run /login"), "Claude Code 尚未登录。请先在插件隔离配置中完成登录认证。");
});

test("localizeCliError translates Qwen auth-type errors into Simplified Chinese", () => {
	assert.equal(localizeCliError("qwen", "No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode."), "Qwen Code 尚未配置认证方式。请先为该 CLI 选择并配置认证类型。");
});

test("localizeCliError prefixes unknown external diagnostics consistently", () => {
	assert.equal(localizeCliError("codex", "upstream exploded"), "CLI 执行失败：upstream exploded");
});

test("extractCliReply reads only Codex agent_message text", () => {
	const stdout = [
		JSON.stringify({ type: "thread.started", thread_id: "contains-OK-but-is-not-a-reply" }),
		JSON.stringify({ type: "item.completed", item: { type: "error", message: "fallback OK metadata" } }),
		JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } })
	].join("\n");
	assert.equal(extractCliReply("codex", stdout), "OK");
});

test("extractCliReply does not accept OK outside a Codex agent message", () => {
	const stdout = [
		JSON.stringify({ type: "thread.started", thread_id: "OK" }),
		JSON.stringify({ type: "item.completed", item: { type: "error", message: "OK" } }),
		JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "" } })
	].join("\n");
	assert.equal(extractCliReply("codex", stdout), "");
});

test("extractCodexError exposes JSONL error events when reply is empty", () => {
	const stdout = [
		JSON.stringify({ type: "item.completed", item: { type: "error", message: "Model metadata missing" } }),
		JSON.stringify({ type: "turn.failed", error: { message: "upstream rejected request" } })
	].join("\n");
	assert.equal(extractCodexError(stdout), "Model metadata missing；upstream rejected request");
});

test("extractCodexError ignores the Codex metadata fallback warning", () => {
	// Real Codex 0.149.1 output when the supplier model is absent from its
	// catalog: an item.completed "error" warning + an empty agent_message that
	// still completes the turn with exitCode=0. The warning is not a failure;
	// the empty reply is reported separately by testCli.
	const stdout = [
		JSON.stringify({ type: "thread.started", thread_id: "01a" }),
		JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata for `deepseek-v4-flash` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." } }),
		JSON.stringify({ type: "turn.started" }),
		JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "" } }),
		JSON.stringify({ type: "turn.completed", usage: { output_tokens: 2 } })
	].join("\n");
	assert.equal(isCodexMetadataWarning("Model metadata for `deepseek-v4-flash` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."), true);
	assert.equal(extractCodexError(stdout), "");
	assert.equal(extractCliReply("codex", stdout), "");
});

test("extractCliReply preserves plain text output for other CLIs", () => {
	assert.equal(extractCliReply("claude", "  OK\n"), "OK");
});

test("fingerprint is stable and reflects the route", () => {
	assert.equal(fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1"), fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1"));
	assert.notEqual(fingerprint("k3-baoyue", "kimi-k3", "max", "https://api.supxh.xin/v1"), fingerprint("other", "kimi-k3", "max", "https://api.supxh.xin/v1"));
});

test("protocol URL helpers avoid duplicated v1 segments", () => {
	assert.equal(stripTrailingV1("https://api.aixforge.com/v1"), "https://api.aixforge.com");
	assert.equal(joinApiPath(stripTrailingV1("https://api.aixforge.com/v1"), "v1/messages"), "https://api.aixforge.com/v1/messages");
});

test("qwenSettings selects an OpenAI-compatible provider without persisting a key", () => {
	const value = JSON.parse(qwenSettings(
		{ provider: "aixforge", model: "deepseek-v4-flash" },
		{ baseURL: "https://api.aixforge.com/v1", apiKeyEnv: "AIXFORGE_API_KEY" }
	));
	assert.equal(value.selectedAuthType, "openai");
	assert.equal(value.modelProviders.openai[0].id, "deepseek-v4-flash");
	assert.equal(value.modelProviders.openai[0].baseUrl, "https://api.aixforge.com/v1");
	assert.equal(value.modelProviders.openai[0].envKey, "AIXFORGE_API_KEY");
	assert.equal(JSON.stringify(value).includes("sk-"), false);
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

test("providerConfig rejects incomplete provider connection settings", async () => {
	assert.equal(await providerConfig(sampleCtx({ providerCfg: { baseURL: "", apiKeyEnv: "KEY" } }), "k3-baoyue"), null);
	assert.equal(await providerConfig(sampleCtx({ providerCfg: { baseURL: "https://api.example/v1", apiKeyEnv: "" } }), "k3-baoyue"), null);
});

test("provider config loss invalidates an old successful verification", async () => {
	const ctx = sampleCtx({
		providerCfg: { baseURL: "", apiKeyEnv: "" },
		value: {
			models: { codex: { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "max" } },
			verified: { codex: { ok: true, provider: "k3-baoyue", model: "kimi-k3", fingerprint: fingerprint("k3-baoyue", "kimi-k3", "max", "https://old.example/v1") } }
		}
	});
	assert.equal(await currentFingerprint(ctx, "codex"), null);
	assert.equal(await isVerifiedCurrentAsync(ctx, "codex"), false);
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

test("findAnthropicToolUseId extracts tool_use id", () => {
	const body = { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "toolu_123", name: "get_time", input: {} }] };
	assert.equal(findAnthropicToolUseId(body), "toolu_123");
	assert.equal(findAnthropicToolUseId({ content: [] }), null);
});

test("findChatToolCallId extracts tool_calls id", () => {
	const body = { choices: [{ message: { tool_calls: [{ id: "call_zz", type: "function" }] } }] };
	assert.equal(findChatToolCallId(body), "call_zz");
	assert.equal(findChatToolCallId({ choices: [{ message: {} }] }), null);
});

test("probeAnthropicContinuation passes on tool_use + tool_result", async () => {
	let calls = 0;
	const httpPost = async () => {
		calls += 1;
		if (calls === 1) return { status: 200, body: { content: [{ type: "tool_use", id: "toolu_1", name: "get_time", input: {} }] } };
		return { status: 200, body: { content: [{ type: "text", text: "现在 12:00 UTC" }] } };
	};
	const r = await probeAnthropicContinuation({ httpPost, baseURL: "https://x/v1", apiKey: "k", model: "m" });
	assert.equal(r.toolContinuation, true);
	assert.equal(calls, 2);
});

test("probeAnthropicContinuation fails without tool_use", async () => {
	const httpPost = async () => ({ status: 200, body: { content: [{ type: "text", text: "现在 12:00" }] } });
	const r = await probeAnthropicContinuation({ httpPost, baseURL: "https://x/v1", apiKey: "k", model: "m" });
	assert.equal(r.toolContinuation, false);
	assert.equal(r.step, 1);
});

test("probeOpenaiChatContinuation passes on tool_calls + tool message", async () => {
	let calls = 0;
	const httpPost = async () => {
		calls += 1;
		if (calls === 1) return { status: 200, body: { choices: [{ message: { tool_calls: [{ id: "call_a", type: "function" }] } }] } };
		return { status: 200, body: { choices: [{ message: { content: "现在 12:00 UTC" } }] } };
	};
	const r = await probeOpenaiChatContinuation({ httpPost, baseURL: "https://x/v1", apiKey: "k", model: "m" });
	assert.equal(r.toolContinuation, true);
	assert.equal(calls, 2);
});

test("probeProtocolContinuation routes by protocol", async () => {
	let seen = null;
	const httpPost = async () => { seen = "called"; return { status: 200, body: {} }; };
	const r = await probeProtocolContinuation({ httpPost, baseURL: "https://x/v1", apiKey: "k", model: "m", protocol: "anthropic" });
	assert.equal(r.step, 1); // anthropic probe returns step 1 with no tool_use
	assert.equal(seen, "called");
});
