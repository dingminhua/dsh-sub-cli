import { test } from "node:test";
import assert from "node:assert/strict";
import {
	fingerprint,
	codexToml,
	codexBaseUrl,
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
	localizeCliError,
	isOkReply,
	permissionOf,
	ensureCliProviderConfig,
	qwenSettingsCurrent,
	classifyProbeFailure,
	probeOutcomeAdvice,
	PROBE_OUTCOMES
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

test("isOkReply accepts a plain OK reply", () => {
	assert.equal(isOkReply("OK"), true);
	assert.equal(isOkReply(" ok "), true);
});

test("isOkReply tolerates OK echo (OK\\nOK) from echo-prone models", () => {
	// 一些供应商/模型会把 "Reply with exactly: OK" 输出成两行 OK（多次 agent_message）。
	assert.equal(isOkReply("OK\nOK"), true);
	assert.equal(isOkReply("OK\r\nOK\nOK"), true);
});

test("isOkReply rejects non-OK or empty replies", () => {
	assert.equal(isOkReply(""), false);
	assert.equal(isOkReply("OK\nbye bye"), false);
	assert.equal(isOkReply("hello"), false);
	assert.equal(isOkReply(null), false);
	assert.equal(isOkReply(42), false);
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

test("qwenSettings maps the tier onto qwen's own enforcement (plan / auto-edit / yolo)", () => {
	// Qwen 的 stream-json 不发 tool_use 事件（0.22.3 实测：只有一条 result），
	// 驱动层没有拦截点——它唯一的执法就是这份 settings.json 里的
	// tools.approvalMode。因此档位必须写进 CLI 自身配置：
	//   read-only → plan（写工具根本不注册，物理写不了）
	//   workspace-write → auto-edit
	//   danger-full-access → yolo
	// 缺省/未知档位按最保守的 plan 处理（与 registry 的默认档位一致）。
	for (const [tier, expected] of [
		[{ read: true, write: false, exec: false, approval: "ask" }, "plan"],
		[{ read: true, write: true, exec: false, approval: "ask" }, "auto-edit"],
		[{ read: true, write: true, exec: true, approval: "ask" }, "yolo"],
		[undefined, "plan"],
		["danger-full-access", "yolo"]
	]) {
		const value = JSON.parse(qwenSettings(
			{ provider: "aixforge", model: "deepseek-v4-flash" },
			{ baseURL: "https://api.aixforge.com/v1", apiKeyEnv: "AIXFORGE_API_KEY" },
			tier
		));
		assert.equal(value.tools.approvalMode, expected, `tier=${JSON.stringify(tier)} must map to ${expected}`);
	}
});

test("qwenSettings never writes a webSearch block on any tier", () => {
	// 2026-09 decision: the managed CLIs ship WITHOUT web search. Qwen's
	// webSearch needs a dedicated DashScope search model + API key (the chat
	// model cannot stand in), so a webSearch block keyed to the routed chat
	// model registered a tool that could never work. No tier writes it.
	for (const perm of [
		{ read: true, write: true, exec: true },
		{ read: true, write: true, exec: false },
		{ read: true, write: false, exec: false }
	]) {
		const rendered = JSON.parse(qwenSettings(
			{ provider: "aixforge", model: "deepseek-v4-flash" },
			{ baseURL: "https://api.aixforge.com/v1", apiKeyEnv: "AIXFORGE_API_KEY" },
			perm
		));
		assert.equal(rendered.tools.webSearch, undefined, `tier ${JSON.stringify(perm)} has no webSearch block`);
	}
});

test("qwenSettingsCurrent treats a residual webSearch block as stale", () => {
	// A webSearch block on disk predates the no-web-search decision; the
	// settings must be rewritten so the stale block is cleared.
	const route = { provider: "aixforge", model: "deepseek-v4-flash" };
	const pc = { baseURL: "https://api.aixforge.com/v1", apiKeyEnv: "AIXFORGE_API_KEY" };
	const execPerm = { read: true, write: true, exec: true };
	const onDiskStale = JSON.stringify({
		selectedAuthType: "openai",
		modelProviders: { openai: [{ id: route.model, name: route.model, envKey: pc.apiKeyEnv, baseUrl: pc.baseURL }] },
		tools: { approvalMode: "yolo", webSearch: { enabled: true, model: route.model } },
		$version: 4
	}, null, 2);
	assert.equal(qwenSettingsCurrent(onDiskStale, route, pc, execPerm), false, "residual webSearch block is stale and triggers a rewrite");
	const onDiskClean = JSON.stringify({
		selectedAuthType: "openai",
		modelProviders: { openai: [{ id: route.model, name: route.model, envKey: pc.apiKeyEnv, baseUrl: pc.baseURL }] },
		tools: { approvalMode: "yolo" },
		$version: 4
	}, null, 2);
	assert.equal(qwenSettingsCurrent(onDiskClean, route, pc, execPerm), true, "clean settings without webSearch are current");
});

test("codex argv never enables web_search on any tier", async () => {
	const { CLI_REGISTRY } = await import("../lib/registry.js");
	const entry = CLI_REGISTRY.find((e) => e.id === "codex");
	for (const perm of [
		{ read: true, write: true, exec: true },
		{ read: true, write: false, exec: false }
	]) {
		const args = entry.argv("do X", "m", perm);
		// 2026-09 decision: no web search. The -c tools.web_search=true override
		// (deprecated legacy alias) is not passed on any tier, and the TUI-only
		// --search flag never was exec-compatible anyway.
		assert.ok(!args.some((a) => String(a).includes("web_search")), `tier ${JSON.stringify(perm)} passes no web_search flag`);
		assert.ok(!args.includes("--search"), "must NOT pass the TUI-only --search flag to codex exec");
	}
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

test("codexToml forces a /v1 base so Codex does not hit the bare host", () => {
	// Codex concatenates `responses` onto base_url itself, so a bare base
	// (https://host/) makes it request https://host/responses → 405 behind
	// nginx (zzztoken, 2026-09-02). The rendered base must end in /v1.
	const bare = codexToml(
		{ provider: "zzztoken", model: "deepseek-v4-flash", reasoningEffort: "max" },
		{ baseURL: "https://api.zzztoken.cn/", apiKeyEnv: "ZZZTOKEN_API_KEY" }
	);
	assert.ok(bare.includes('base_url = "https://api.zzztoken.cn/v1"'));
	const trailingSlash = codexToml(
		{ provider: "zzztoken", model: "deepseek-v4-flash", reasoningEffort: "max" },
		{ baseURL: "https://api.zzztoken.cn/v1/", apiKeyEnv: "ZZZTOKEN_API_KEY" }
	);
	assert.ok(trailingSlash.includes('base_url = "https://api.zzztoken.cn/v1"'), "an already-suffixed base is not doubled");
	const alreadyV1 = codexToml(
		{ provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "max" },
		{ baseURL: "https://api.supxh.xin/v1", apiKeyEnv: "K3_BAOYUE_API_KEY" }
	);
	assert.ok(alreadyV1.includes('base_url = "https://api.supxh.xin/v1"'));
	assert.equal(codexBaseUrl("https://api.example.com"), "https://api.example.com/v1");
	assert.equal(codexBaseUrl("https://api.example.com/v1"), "https://api.example.com/v1");
	assert.equal(codexBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
	assert.equal(codexBaseUrl("https://api.example.com/base/v1"), "https://api.example.com/base/v1");
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

// ── Probe failure taxonomy (2026-09) ──────────────────────────────────────────
// A binary pass/fail made every supplier hiccup look like a misconfiguration.
// These tests pin the six outcomes and the rule that MATTERS: only a
// deterministic verdict may advise switching relay.

test("classifyProbeFailure maps HTTP status to deterministic vs transient", () => {
	// 2xx = the probe itself succeeded (no failure to classify).
	assert.equal(classifyProbeFailure({ status: 200 }), "completed");
	// Deterministic rejections: the relay refuses this request for good.
	for (const status of [400, 401, 403, 404, 405, 422]) {
		assert.equal(classifyProbeFailure({ status }), "http-rejected", `status ${status}`);
	}
	// Transient: rate limit + every server-side/unexpected status.
	for (const status of [429, 500, 502, 503, 504, 302]) {
		assert.equal(classifyProbeFailure({ status }), "transient", `status ${status}`);
	}
});

test("classifyProbeFailure reads error text when no status is available", () => {
	assert.equal(classifyProbeFailure({ message: "request timed out" }), "timeout");
	assert.equal(classifyProbeFailure({ message: "ECONNREFUSED 127.0.0.1:443" }), "network-error");
	assert.equal(classifyProbeFailure({ message: "DNS lookup failed" }), "network-error");
	assert.equal(classifyProbeFailure({ message: "429 rate limit exceeded" }), "transient");
	assert.equal(classifyProbeFailure({ message: "internal server error" }), "transient");
	assert.equal(classifyProbeFailure({ message: "invalid api key" }), "http-rejected");
	assert.equal(classifyProbeFailure({ message: "余额不足" }), "http-rejected");
	// Unknown text with no signal: incomplete, never a confident "rejected".
	assert.equal(classifyProbeFailure({ message: "something odd happened" }), "incomplete");
	assert.equal(classifyProbeFailure({}), "incomplete");
});

test("probeOutcomeAdvice never tells the user to switch relay for transient outcomes", () => {
	const switchWording = /更换代理商|更换代理/;
	// Transient family: retry wording only (note "无需更换" is allowed — it
	// explicitly says NOT to switch).
	for (const outcome of ["transient", "timeout", "network-error"]) {
		const advice = probeOutcomeAdvice(outcome, {});
		assert.ok(advice.length > 0, `${outcome} has advice`);
		assert.match(advice, /重试|稍后/, `${outcome} advises retrying`);
		assert.doesNotMatch(advice.replace(/无需更换代理商。?/g, ""), switchWording, `${outcome} must not suggest switching relay`);
	}
	// Deterministic family: switching is the right advice.
	assert.match(probeOutcomeAdvice("http-rejected", { protocolLabel: "OpenAI Responses 协议" }), /更换/);
	assert.match(probeOutcomeAdvice("incomplete", { cliName: "Codex" }), /Codex/);
	assert.equal(probeOutcomeAdvice("completed", {}), "");
});

test("probeProtocolContinuation annotates failures with an outcome", async () => {
	// A rate-limited supplier must NOT come back as "relay cannot do the
	// protocol" — the taxonomy is what keeps the advice honest.
	const limited = async () => ({ status: 429, body: {} });
	const r = await probeProtocolContinuation({ httpPost: limited, baseURL: "https://x/v1", apiKey: "k", model: "m", protocol: "responses" });
	assert.equal(r.toolContinuation, false);
	assert.equal(r.outcome, "transient");
	const rejected = async () => ({ status: 404, body: {} });
	const r2 = await probeProtocolContinuation({ httpPost: rejected, baseURL: "https://x/v1", apiKey: "k", model: "m", protocol: "responses" });
	assert.equal(r2.outcome, "http-rejected");
});

test("probeOutcomeAdvice covers every declared outcome", () => {
	for (const outcome of PROBE_OUTCOMES) {
		if (outcome === "completed") continue;
		assert.ok(probeOutcomeAdvice(outcome, { cliName: "Codex", protocolLabel: "p" }).length > 0, `${outcome} has advice`);
	}
});

test("probeProtocolContinuation routes by protocol", async () => {
	let seen = null;
	const httpPost = async () => { seen = "called"; return { status: 200, body: {} }; };
	const r = await probeProtocolContinuation({ httpPost, baseURL: "https://x/v1", apiKey: "k", model: "m", protocol: "anthropic" });
	assert.equal(r.step, 1); // anthropic probe returns step 1 with no tool_use
	assert.equal(seen, "called");
});

test("permissionOf returns a normalized capability profile for a CLI", () => {
	// Legacy string tier is expanded to its preset profile.
	const ctx = sampleCtx({ value: { permissions: { codex: "read-only" } } });
	assert.deepEqual(permissionOf(ctx, "codex"), { read: true, write: false, exec: false });
	// Profile objects pass through normalized; a stored network:true promotes
	// exec (the three-capability carrier of egress intent). Stored approval
	// values (removed 2026-09) are dropped silently.
	const objCtx = sampleCtx({ value: { permissions: { codex: { read: true, write: true, exec: false, network: true, approval: "ask" } } } });
	assert.deepEqual(permissionOf(objCtx, "codex"), { read: true, write: true, exec: true });
	// Missing permission falls back to the default tier (read-only).
	const emptyCtx = sampleCtx({ value: { permissions: {} } });
	assert.deepEqual(permissionOf(emptyCtx, "codex"), { read: true, write: false, exec: false });
	// Other CLIs are independent.
	assert.deepEqual(permissionOf(ctx, "claude"), { read: true, write: false, exec: false });
});

test("ensureCliProviderConfig skips the qwen write when content matches", async () => {
	const { CLI_REGISTRY } = await import("../lib/registry.js");
	const qwen = CLI_REGISTRY.find((e) => e.id === "qwen");
	const route = { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "" };
	const pc = { baseURL: "https://k3.example/v1", apiKeyEnv: "K3_KEY" };
	const rendered = qwenSettings(route, pc, "read-only");
	let wrote = null;
	const ctx = sampleCtx({
		value: { models: { qwen: route }, permissions: {} },
		providerCfg: { baseURL: pc.baseURL, apiKeyEnv: pc.apiKeyEnv }
	});
	ctx.get = (key) => {
		if (key === "fs") {
			return {
				resolve: async (p) => ({ displayPath: p, targetKey: p }),
				readText: async () => rendered,
				writeText: async (target, content) => { wrote = { target, content }; }
			};
		}
		return { settings: ctx.settings, llm: ctx.llm, credentials: ctx.credentials }[key];
	};
	const r = await ensureCliProviderConfig(ctx, qwen, route);
	assert.equal(r.ok, true);
	assert.equal(r.uptodate, true);
	assert.equal(wrote, null, "no fs write when the on-disk settings match the rendered content");
});

test("ensureCliProviderConfig skips the qwen write after qwen migrated its own settings", async () => {
	// qwen 0.22.3 rewrites settings.json on startup: selectedAuthType moves into
	// security.auth.selectedType and $version is stamped. The gate must accept
	// the migrated shape (semantic match on plugin-owned fields), or every run
	// after the first hits a sandbox-denied rewrite.
	const { CLI_REGISTRY } = await import("../lib/registry.js");
	const qwen = CLI_REGISTRY.find((e) => e.id === "qwen");
	const route = { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "" };
	const pc = { baseURL: "https://k3.example/v1", apiKeyEnv: "K3_KEY" };
	// 迁移后的位形必须是「与插件当前档位一致」才能跳过写：默认档位（未配置权限
	// → read-only）对应 plan，所以这里盘上的 yolo 属于过时值，必须重写。
	const migrated = JSON.stringify({
		modelProviders: { openai: [{ id: route.model, name: route.model, envKey: pc.apiKeyEnv, baseUrl: pc.baseURL }] },
		tools: { approvalMode: "plan" },
		security: { auth: { selectedType: "openai" } },
		$version: 4
	}, null, 2);
	let wrote = null;
	const ctx = sampleCtx({
		value: { models: { qwen: route }, permissions: {} },
		providerCfg: { baseURL: pc.baseURL, apiKeyEnv: pc.apiKeyEnv }
	});
	ctx.get = (key) => {
		if (key === "fs") {
			return {
				resolve: async (p) => ({ displayPath: p, targetKey: p }),
				readText: async () => migrated,
				writeText: async (target, content) => { wrote = { target, content }; }
			};
		}
		return { settings: ctx.settings, llm: ctx.llm, credentials: ctx.credentials }[key];
	};
	const r = await ensureCliProviderConfig(ctx, qwen, route);
	assert.equal(r.ok, true);
	assert.equal(r.uptodate, true);
	assert.equal(wrote, null, "no fs write against qwen's own migrated settings shape");
});

test("ensureCliProviderConfig renders the turn-granted tier for qwen (grant must not be rolled back)", async () => {
	// 2026-09-03 修复：A/B 门授权的「本轮档位」经 prepare 穿透进来。修复前
	// 授权档先落盘、随后配置门按持久化档（read-only → plan）比对，把授权
	// 静默改写回去——用户批准的写入物理上不可能发生。修复后语义门按本轮档
	// 比对，盘上的 auto-edit 与本轮档一致，不再触发重写。
	const { CLI_REGISTRY } = await import("../lib/registry.js");
	const qwen = CLI_REGISTRY.find((e) => e.id === "qwen");
	const route = { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "" };
	const pc = { baseURL: "https://k3.example/v1", apiKeyEnv: "K3_KEY" };
	const granted = { read: true, write: true, exec: false, approval: "ask" }; // workspace-write
	const onDiskGranted = JSON.stringify({
		modelProviders: { openai: [{ id: route.model, name: route.model, envKey: pc.apiKeyEnv, baseUrl: pc.baseURL }] },
		tools: { approvalMode: "auto-edit" },
		security: { auth: { selectedType: "openai" } },
		$version: 4
	}, null, 2);
	let wrote = null;
	const ctx = sampleCtx({
		value: { models: { qwen: route }, permissions: {} },
		providerCfg: { baseURL: pc.baseURL, apiKeyEnv: pc.apiKeyEnv }
	});
	ctx.get = (key) => {
		if (key === "fs") {
			return {
				resolve: async (p) => ({ displayPath: p, targetKey: p }),
				readText: async () => onDiskGranted,
				writeText: async (target, content) => { wrote = { target, content }; }
			};
		}
		return { settings: ctx.settings, llm: ctx.llm, credentials: ctx.credentials }[key];
	};
	const r = await ensureCliProviderConfig(ctx, qwen, route, granted);
	assert.equal(r.ok, true);
	assert.equal(r.uptodate, true, "本轮授权档与盘上一致，不重写");
	assert.equal(wrote, null, "授权档绝不能被持久化档回滚");
	// 反向：不传 override（普通轮）时按持久化档比对，盘上的 auto-edit 属过时
	// 值，必须重写回 plan。（写路径需要 ctx.subprocess 供 runEnsureDir 用。）
	let wrote2 = null;
	ctx.subprocess = { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} }) };
	ctx.get = (key) => {
		if (key === "fs") {
			return {
				resolve: async (p) => ({ displayPath: p, targetKey: p }),
				readText: async () => onDiskGranted,
				writeText: async (target, content) => { wrote2 = { target, content }; }
			};
		}
		return { settings: ctx.settings, llm: ctx.llm, credentials: ctx.credentials }[key];
	};
	const r2 = await ensureCliProviderConfig(ctx, qwen, route);
	assert.equal(r2.ok, true);
	assert.equal(r2.uptodate, false, "未授权轮按持久化档重写");
	assert.ok(wrote2 && JSON.parse(wrote2.content).tools.approvalMode === "plan", "重写回 plan（授权不跨轮泄漏）");
});

test("qwenSettingsCurrent rejects a stale route in the migrated shape", () => {
	const route = { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "" };
	const pc = { baseURL: "https://k3.example/v1", apiKeyEnv: "K3_KEY" };
	const stale = JSON.stringify({
		modelProviders: { openai: [{ id: "other-model", envKey: pc.apiKeyEnv, baseUrl: pc.baseURL }] },
		tools: { approvalMode: "yolo" },
		security: { auth: { selectedType: "openai" } },
		$version: 4
	});
	assert.equal(qwenSettingsCurrent(stale, route, pc), false);
	const wrongBase = JSON.stringify({
		modelProviders: { openai: [{ id: route.model, envKey: pc.apiKeyEnv, baseUrl: "https://elsewhere/v1" }] },
		tools: { approvalMode: "yolo" },
		security: { auth: { selectedType: "openai" } },
		$version: 4
	});
	assert.equal(qwenSettingsCurrent(wrongBase, route, pc), false);
	assert.equal(qwenSettingsCurrent("not json", route, pc), false);
	assert.equal(qwenSettingsCurrent(null, route, pc), false);
});

test("ensureCliProviderConfig rewrites qwen settings when content differs", async () => {
	const { CLI_REGISTRY } = await import("../lib/registry.js");
	const qwen = CLI_REGISTRY.find((e) => e.id === "qwen");
	const route = { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "" };
	const pc = { baseURL: "https://k3.example/v1", apiKeyEnv: "K3_KEY" };
	const rendered = qwenSettings(route, pc, "read-only");
	let wrote = null;
	const ctx = sampleCtx({
		value: { models: { qwen: route }, permissions: {} },
		providerCfg: { baseURL: pc.baseURL, apiKeyEnv: pc.apiKeyEnv }
	});
	ctx.subprocess = { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} }) };
	ctx.get = (key) => {
		if (key === "fs") {
			return {
				resolve: async (p) => ({ displayPath: p, targetKey: p }),
				readText: async () => JSON.stringify({ selectedAuthType: "openai" }, null, 2),
				writeText: async (target, content) => { wrote = { target, content }; }
			};
		}
		return { settings: ctx.settings, llm: ctx.llm, credentials: ctx.credentials }[key];
	};
	const r = await ensureCliProviderConfig(ctx, qwen, route);
	assert.equal(r.ok, true);
	assert.equal(r.uptodate, false);
	assert.ok(wrote, "the write happened for stale content");
	assert.equal(wrote.content, rendered);
});

test("ensureCliProviderConfig treats a missing qwen settings file as stale", async () => {
	const { CLI_REGISTRY } = await import("../lib/registry.js");
	const qwen = CLI_REGISTRY.find((e) => e.id === "qwen");
	const route = { provider: "k3-baoyue", model: "kimi-k3", reasoningEffort: "" };
	const pc = { baseURL: "https://k3.example/v1", apiKeyEnv: "K3_KEY" };
	let wrote = null;
	const ctx = sampleCtx({
		value: { models: { qwen: route }, permissions: {} },
		providerCfg: { baseURL: pc.baseURL, apiKeyEnv: pc.apiKeyEnv }
	});
	ctx.subprocess = { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} }) };
	ctx.get = (key) => {
		if (key === "fs") {
			return {
				resolve: async (p) => ({ displayPath: p, targetKey: p }),
				readText: async () => { throw new Error("ENOENT"); },
				writeText: async (target, content) => { wrote = { target, content }; }
			};
		}
		return { settings: ctx.settings, llm: ctx.llm, credentials: ctx.credentials }[key];
	};
	const r = await ensureCliProviderConfig(ctx, qwen, route);
	assert.equal(r.ok, true);
	assert.equal(r.uptodate, false);
	assert.ok(wrote, "a missing file is (re)created");
});
