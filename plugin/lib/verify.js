// Verified-route management for managed CLIs.
//
// A CLI is "verified" only when it can actually run with the model/supplier
// currently configured in the plugin. We write the selected supplier into the
// CLI's own config (so Codex calls k3-baoyue instead of OpenAI), probe it by
// running the CLI once, then record a fingerprint of the current route. The
// settings card shows "verified" only while that fingerprint still matches the
// live configuration; a route change invalidates it and forces a re-probe.

import path from "node:path";
import os from "node:os";
import { cliById, DEFAULT_PERMISSION } from "./registry.js";
import { normalizePermission } from "./permissions.js";
import { binPath, envFor, PLATFORM } from "./paths.js";
import { winShimArgv } from "./dispatch.js";

export const SETTINGS_NS = "dsh-sub-cli";

export function stripTrailingV1(baseURL) {
	return typeof baseURL === "string" ? baseURL.replace(/\/v1\/?$/i, "") : baseURL;
}

export function joinApiPath(baseURL, endpoint) {
	return `${String(baseURL || "").replace(/\/+$/, "")}/${String(endpoint || "").replace(/^\/+/, "")}`;
}

/** Deterministic short fingerprint of a model route + supplier. */
export function fingerprint(provider, model, effort, baseURL) {
	const s = `${provider}|${model}|${effort || ""}|${baseURL || ""}`;
	let h = 0;
	for (const c of s) h = ((h * 31 + c.charCodeAt(0)) >>> 0);
	return h.toString(16);
}

/** Read the current `dsh-sub-cli` settings section (value). */
export function currentSection(ctx) {
	// The plugin registers this namespace and lifecycle-owns the source; read
	// it through the settings service for the live value. `settings`, `llm`,
	// and `credentials` are optional host services — always read them with
	// ctx.get() (they are NOT declared on the plugin's inject list).
	const settings = ctx.get("settings");
	if (!settings) return null;
	try {
		const desc = settings.describe({ redactSecrets: true });
		const ns = desc.find((x) => x.ns === SETTINGS_NS);
		return (ns && ns.value) || null;
	} catch {
		return null;
	}
}

/** Resolve the provider's { baseURL, apiKeyEnv } from DSH configurable-provider settings. */
export async function providerConfig(ctx, provider) {
	if (!provider) return null;
	const llm = ctx.get("llm");
	const settings = ctx.get("settings");
	if (!llm || !settings) return null;
	let entry = null;
	try {
		entry = llm.listConfigurableProviders().find((p) => p.provider === provider);
	} catch {
		return null;
	}
	if (!entry) return null;
	// Configurable providers live under their own settings namespace (e.g.
	// `llm-pi-ai`), each provider at `providers.<id>`. Read the live section so
	// a route change is picked up without a restart (settings-file watches disk).
	try {
		const desc = settings.describe({ redactSecrets: true });
		const ai = desc.find((x) => x.ns === entry.settingsNs);
		const p = ai && ai.value && ai.value.providers && ai.value.providers[provider];
		if (!p || typeof p.baseURL !== "string" || !p.baseURL.trim() || typeof p.apiKeyEnv !== "string" || !p.apiKeyEnv.trim()) return null;
		return { baseURL: p.baseURL.trim(), apiKeyEnv: p.apiKeyEnv.trim(), displayName: p.displayName || provider };
	} catch {
		return null;
	}
}

/** Build the spawn env for one CLI: config-isolation env + supplier API key (latest). */
export async function cliEnv(ctx, cliId, dir) {
	const entry = cliById(cliId);
	const env = entry ? envFor(entry, dir) : {};
	const route = routeOf(ctx, cliId);
	if (route && route.provider) {
		const pc = await providerConfig(ctx, route.provider);
		if (pc && pc.apiKeyEnv) {
			const key = await credentialKey(ctx, pc.apiKeyEnv);
			if (key) {
				env[pc.apiKeyEnv] = key;
				if (cliId === "claude") {
					env.ANTHROPIC_BASE_URL = stripTrailingV1(pc.baseURL);
					env.ANTHROPIC_API_KEY = key;
					env.ANTHROPIC_AUTH_TOKEN = key;
					env.ANTHROPIC_MODEL = route.model;
					env.ANTHROPIC_DEFAULT_OPUS_MODEL = route.model;
					env.ANTHROPIC_DEFAULT_SONNET_MODEL = route.model;
					env.ANTHROPIC_DEFAULT_HAIKU_MODEL = route.model;
					// Claude Code 拒绝推进未识别的模型 id（中转商模型名任意）。警告仍会
					// 出现在 stderr，但强制行为不能阻塞运行。
					env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
				}
			}
		}
	}
	return env;
}

/** Resolve the latest API key from DSH credentials (never cached). */
export async function credentialKey(ctx, apiKeyEnv) {
	const credentials = ctx.get("credentials");
	if (!apiKeyEnv || !credentials) return null;
	try {
		const r = await credentials.resolve(apiKeyEnv);
		return r && typeof r.value === "string" ? r.value : null;
	} catch {
		return null;
	}
}

/** Read the settings model-route for a CLI. */
export function routeOf(ctx, cliId) {
	const section = currentSection(ctx);
	return (section && section.models && section.models[cliId]) || null;
}

/** Current fingerprint of a runnable CLI route. Missing provider connection fields are not fingerprintable. */
export async function currentFingerprint(ctx, cliId) {
	const route = routeOf(ctx, cliId);
	if (!route || !route.provider || !route.model) return null;
	const pc = await providerConfig(ctx, route.provider);
	if (!pc || !pc.baseURL || !pc.apiKeyEnv) return null;
	return fingerprint(route.provider, route.model, route.reasoningEffort, pc.baseURL);
}

/** Read the stored permission for a CLI as a normalized capability profile. */
export function permissionOf(ctx, cliId) {
	const section = currentSection(ctx);
	const p = section && section.permissions && section.permissions[cliId];
	return normalizePermission(p || DEFAULT_PERMISSION);
}

/** Read the stored verified record for a CLI. */
export function verifiedOf(ctx, cliId) {
	const section = currentSection(ctx);
	const v = section && section.verified && section.verified[cliId];
	return v && v.ok ? v : null;
}

/** Whether the stored verification still matches the live route. */
export function isVerifiedCurrent(ctx, cliId) {
	const v = verifiedOf(ctx, cliId);
	if (!v) return false;
	// Fingerprint is authoritative: if it is missing (old record) treat as invalid.
	if (!v.fingerprint) return false;
	// Compare synchronously when possible; baseURL lookup is async, so do it here.
	return v.fingerprint === fpIfKnown(ctx, cliId);
}

/** Best-effort synchronous fingerprint (null when provider baseURL unknown without IO). */
function fpIfKnown(ctx, cliId) {
	const route = routeOf(ctx, cliId);
	if (!route || !route.provider || !route.model) return null;
	// We cannot read baseURL synchronously; return a marker so isVerifiedCurrent
	// falls back to async comparison. Simpler: recompute in async path below.
	return null;
}

/** Async authoritative "is verified current". */
export async function isVerifiedCurrentAsync(ctx, cliId) {
	const v = verifiedOf(ctx, cliId);
	if (!v || !v.fingerprint) return false;
	const fp = await currentFingerprint(ctx, cliId);
	return fp !== null && v.fingerprint === fp;
}

/** Write a verified record (with fingerprint) via settings mutate. */
export async function writeVerified(ctx, cliId, { ok = true, version, error, capabilities }) {
	const route = routeOf(ctx, cliId);
	const pc = route && route.provider ? await providerConfig(ctx, route.provider) : null;
	// Failed records still carry a deterministic route marker so the settings UI
	// can display the failure for the exact selected Provider/Model. A success
	// record is only meaningful when a complete provider connection exists.
	const fp = fingerprint(route && route.provider, route && route.model, route && route.reasoningEffort, pc?.baseURL || "<provider-config-missing>");
	const value = {
		ok: !!ok,
		version: version || "",
		at: new Date().toISOString(),
		provider: (route && route.provider) || "",
		model: (route && route.model) || "",
		reasoningEffort: (route && route.reasoningEffort) || null,
		fingerprint: fp
	};
	if (!ok && error) value.error = error;
	if (capabilities) value.capabilities = capabilities;
	const settings = ctx.get("settings");
	if (!settings) return value;
	try {
		await settings.mutate(SETTINGS_NS, [{ op: "set", path: ["verified", cliId], value }]);
		return value;
	} catch {
		return value;
	}
}

/** Clear the stored verified record for a CLI. */
export async function clearVerified(ctx, cliId) {
	const settings = ctx.get("settings");
	if (!settings) return;
	try {
		await settings.mutate(SETTINGS_NS, [{ op: "unset", path: ["verified", cliId] }]);
	} catch {
		// best-effort
	}
}

/**
 * Append the plugin's own gate section to a Codex config.toml. It embeds the
 * live fingerprint so spawn can detect a stale/foreign config file by reading
 * the file back — no manager discipline required. Pure/testable.
 */
export function gateToml(toml, route, pc, fp) {
	return `${toml}\n\n[plugins.dsh-cli]\nprovider = "${route.provider}"\nmodel = "${route.model}"\nbase_url = "${pc.baseURL}"\nfingerprint = "${fp}"\n`;
}

/** Parse the embedded fingerprint out of a config.toml text (pure). */
export function parseGateFingerprint(tomlText) {
	if (typeof tomlText !== "string") return null;
	const m = tomlText.match(/\[plugins\.dsh-cli\][\s\S]*?fingerprint\s*=\s*"([^"]+)"/);
	return m ? m[1] : null;
}

/** Read the embedded gate fingerprint from the on-disk config (or null). */
async function readGateFingerprint(ctx, cfgPath, fs) {
	if (!fs || typeof fs.resolve !== "function" || typeof fs.readText !== "function") return null;
	try {
		const target = await fs.resolve(cfgPath, {}, undefined);
		const text = await fs.readText(target, undefined);
		return parseGateFingerprint(text);
	} catch {
		return null; // file missing/unreadable → treated as not-yet-configured
	}
}

/**
 * Ensure the CLI's own config matches the CURRENT live route. Idempotent: if the
 * existing file already embeds the live fingerprint it is left untouched (so
 * user's other settings are preserved); otherwise it is rewritten. This is the
 * gate that makes "stale wrong supplier" impossible by construction.
 */
export async function ensureCliProviderConfig(ctx, entry, route) {
	if (!route || !route.provider || !route.model) return { supported: true, ok: false, error: "未为该 CLI 配置 Provider 和 Model。" };
	const pc = await providerConfig(ctx, route.provider);
	if (!pc) return { supported: true, ok: false, error: `找不到 Provider「${route.provider}」的完整配置（需要 baseURL 和 apiKeyEnv）。请在 DSH Provider 设置中补齐，或为该 CLI 选择另一个已配置的 Provider。` };
	const dir = currentDir(ctx);
	const cfgDir = path.join(dir, entry.configDir);
	const fp = fingerprint(route.provider, route.model, route.reasoningEffort, pc.baseURL);
	const fs = ctx.get("fs");
	if (entry.id === "claude") return { supported: true, ok: true, uptodate: true, cfgPath: cfgDir };
	const cfgPath = path.join(cfgDir, entry.id === "qwen" ? "settings.json" : "config.toml");
	if (entry.id === "codex") {
		const existingFp = await readGateFingerprint(ctx, cfgPath, fs);
		if (existingFp === fp) return { supported: true, ok: true, uptodate: true, cfgPath };
	}
	if (!fs || typeof fs.resolve !== "function" || typeof fs.writeText !== "function") {
		return { supported: true, ok: false, error: "当前 DSH 文件服务不支持写 CLI 配置。" };
	}
	const content = entry.id === "qwen" ? qwenSettings(route, pc) : gateToml(codexToml(route, pc), route, pc, fp);
	try {
		await runEnsureDir(ctx, cfgDir);
		const target = await fs.resolve(cfgPath, {}, undefined);
		await fs.writeText(target, content, undefined, undefined);
		return { supported: true, ok: true, uptodate: false, cfgPath };
	} catch (error) {
		return { supported: true, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Every-time run gate: derive the CLI's runnable env from the CURRENT live route
 * (config converges to live, key read fresh from credentials). This is the only
 * thing a managed spawn may use to build its environment — it does not depend on
 * any agent remembering to verify a fingerprint.
 */
export async function prepareManagedRun(ctx, cliId, dir) {
	const entry = cliById(cliId);
	if (!entry) return { ok: false, reason: `未知 CLI：${cliId}` };
	const route = routeOf(ctx, cliId);
	if (!route || !route.provider || !route.model) return { ok: false, reason: `尚未为 ${entry.name} 配置 Provider 和 Model。` };
	const cfg = await ensureCliProviderConfig(ctx, entry, route);
	if (cfg.error) return { ok: false, reason: cfg.error };
	const env = await cliEnv(ctx, cliId, dir);
	const pc = await providerConfig(ctx, route.provider);
	const fp = fingerprint(route.provider, route.model, route.reasoningEffort, pc && pc.baseURL);
	return { ok: true, env, fingerprint: fp, cfgPath: cfg.cfgPath, uptodate: cfg.uptodate };
}

async function runEnsureDir(ctx, dir) {
	const mk = PLATFORM === "win32"
		? ["cmd.exe", "/d", "/s", "/c", `if not exist "${dir}" mkdir "${dir}"`]
		: ["/bin/mkdir", "-p", dir];
	const handle = ctx.subprocess.spawn({ argv: mk, cwd: ".", stdio: { stdin: "ignore", stdout: { maxBytes: 20000 }, stderr: { maxBytes: 20000 } }, graceMs: 20000 });
	await handle.done;
}

/** The current unified dir from settings. */
export function currentDir(ctx) {
	const section = currentSection(ctx);
	const raw = section && section.cliDir;
	const d = raw && raw.length ? raw : "~/dsh-clis";
	return d.indexOf("~") === 0 ? os.homedir() + d.slice(1) : d;
}

/** Render Qwen Code settings for one OpenAI-compatible provider. */
export function qwenSettings(route, pc) {
	return JSON.stringify({
		selectedAuthType: "openai",
		modelProviders: {
			openai: [{ id: route.model, name: route.model, envKey: pc.apiKeyEnv, baseUrl: pc.baseURL }]
		}
	}, null, 2);
}

/** Render the Codex config.toml that points Codex at a supplier. Pure/testable. */
export function codexToml(route, pc) {
	return [
		`model = "${route.model}"`,
		`model_provider = "${route.provider}"`,
		`[model_providers.${route.provider}]`,
		`name = "${route.provider}"`,
		`base_url = "${pc.baseURL}"`,
		`env_key = "${pc.apiKeyEnv}"`,
		`wire_api = "responses"`
	].join("\n");
}

/**
 * Probe whether a supplier supports Responses tool continuation, which Codex
 * needs for remote-tool tasks (shell/web). Pure & testable: `httpPost` is an
 * injected async ({ url, body }) => { status, body: any }. Some suppliers
 * (e.g. aixforge) pass a one-shot text request but fail continuation with
 * "function_call_output requires call_id ... only supported on Responses
 * WebSocket v2" — such suppliers are only usable for plain text, not tools.
 */
export async function probeToolContinuation({ httpPost, baseURL, apiKey, model }) {
	const tool = { type: "function", name: "get_time", description: "returns current time", parameters: { type: "object", properties: {}, additionalProperties: false } };
	let r1;
	try {
		r1 = await httpPost({ url: `${baseURL}/responses`, body: { model, input: "请调用 get_time 工具告诉我当前时间", tools: [tool] } });
	} catch (error) {
		return { toolContinuation: false, step: 1, reason: error instanceof Error ? error.message : String(error) };
	}
	const callId = findCallId(r1 && r1.body);
	if (!callId) {
		return { toolContinuation: callIdMeaning(r1 && r1.body), step: 1, status: r1 && r1.status, reason: "step1 未产生 function_call（模型直接作答或供应商不支持工具输出）" };
	}
	let r2;
	try {
		r2 = await httpPost({
			url: `${baseURL}/responses`,
			body: {
				model,
				input: [{ type: "function_call_output", call_id: callId, output: "2026-08-27 00:00 UTC" }],
				...(r1 && r1.body && r1.body.id ? { previous_response_id: r1.body.id } : {})
			}
		});
	} catch (error) {
		return { toolContinuation: false, step: 2, reason: error instanceof Error ? error.message : String(error) };
	}
	return { toolContinuation: (r2 && r2.status) >= 200 && (r2 && r2.status) < 400, step: 2, step1Status: r1.status, step2Status: r2 && r2.status };
}

/** Pull the first `function_call` item's call_id from a responses body. */
export function findCallId(body) {
	if (!body || typeof body !== "object") return null;
	const out = Array.isArray(body.output) ? body.output : [];
	for (const item of out) {
		if (item && item.type === "function_call" && typeof item.call_id === "string") return item.call_id;
		if (item && Array.isArray(item.calls)) {
			for (const c of item.calls) if (c && c.id) return c.id;
		}
	}
	return null;
}

/** Find the first Anthropic `tool_use` block's id. Pure/testable. */
export function findAnthropicToolUseId(body) {
	if (!body || typeof body !== "object") return null;
	const content = Array.isArray(body.content) ? body.content : [];
	for (const block of content) {
		if (block && block.type === "tool_use" && typeof block.id === "string") return block.id;
	}
	return null;
}

/** Find the first Chat-Completions `tool_calls[].id`. Pure/testable. */
export function findChatToolCallId(body) {
	if (!body || typeof body !== "object") return null;
	const choices = Array.isArray(body.choices) ? body.choices : [];
	for (const c of choices) {
		const tcs = c && c.message && Array.isArray(c.message.tool_calls) ? c.message.tool_calls : [];
		for (const tc of tcs) if (tc && typeof tc.id === "string") return tc.id;
	}
	return null;
}

/**
 * Probe an Anthropic Messages supplier for tool_use continuation (Claude Code
 * needs it for real tool work). Two steps: step1 must return a `tool_use` block
 * with an id; step2 sends `tool_result` and must return a 2xx.
 */
export async function probeAnthropicContinuation({ httpPost, baseURL, apiKey, model }) {
	const tool = { name: "get_time", description: "returns current time", input_schema: { type: "object", properties: {} } };
	let r1;
	try {
		r1 = await httpPost({ url: joinApiPath(stripTrailingV1(baseURL), "v1/messages"), body: { model, max_tokens: 256, tools: [tool], messages: [{ role: "user", content: "现在几点？请调用 get_time 工具" }] } });
	} catch (error) {
		return { toolContinuation: false, step: 1, reason: error instanceof Error ? error.message : String(error) };
	}
	const toolUseId = findAnthropicToolUseId(r1 && r1.body);
	if (!toolUseId) {
		return { toolContinuation: false, step: 1, status: r1 && r1.status, reason: "step1 未返回 tool_use（供应商不支持 Anthropic 工具输出）" };
	}
	let r2;
	try {
		r2 = await httpPost({
			url: joinApiPath(stripTrailingV1(baseURL), "v1/messages"),
			body: {
				model, max_tokens: 256,
				messages: [
					{ role: "user", content: "现在几点？请调用 get_time 工具" },
					{ role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "get_time", input: {} }] },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "当前时间是 2026-08-27 12:00 UTC" }] }
				]
			}
		});
	} catch (error) {
		return { toolContinuation: false, step: 2, reason: error instanceof Error ? error.message : String(error) };
	}
	return { toolContinuation: (r2 && r2.status) >= 200 && (r2 && r2.status) < 400, step: 2, step1Status: r1.status, step2Status: r2 && r2.status };
}

/**
 * Probe an OpenAI Chat-Completions supplier for tool_calls continuation (Qwen
 * Code needs it). Step1 must return `tool_calls` with an id; step2 sends a
 * `tool` role message and must return a 2xx.
 */
export async function probeOpenaiChatContinuation({ httpPost, baseURL, apiKey, model }) {
	const tool = { type: "function", function: { name: "get_time", description: "returns current time", parameters: { type: "object", properties: {} } } };
	let r1;
	try {
		r1 = await httpPost({ url: `${baseURL}/chat/completions`, body: { model, tools: [tool], messages: [{ role: "user", content: "现在几点？请调用 get_time 工具" }] } });
	} catch (error) {
		return { toolContinuation: false, step: 1, reason: error instanceof Error ? error.message : String(error) };
	}
	const toolCallId = findChatToolCallId(r1 && r1.body);
	if (!toolCallId) {
		return { toolContinuation: false, step: 1, status: r1 && r1.status, reason: "step1 未返回 tool_calls（供应商不支持 Chat 工具输出）" };
	}
	let r2;
	try {
		r2 = await httpPost({
			url: `${baseURL}/chat/completions`,
			body: {
				model,
				messages: [
					{ role: "user", content: "现在几点？请调用 get_time 工具" },
					{ role: "assistant", content: null, tool_calls: [{ id: toolCallId, type: "function", function: { name: "get_time", arguments: "{}" } }] },
					{ role: "tool", tool_call_id: toolCallId, content: "当前时间是 2026-08-27 12:00 UTC" }
				]
			}
		});
	} catch (error) {
		return { toolContinuation: false, step: 2, reason: error instanceof Error ? error.message : String(error) };
	}
	return { toolContinuation: (r2 && r2.status) >= 200 && (r2 && r2.status) < 400, step: 2, step1Status: r1.status, step2Status: r2 && r2.status };
}

/** Interpret findCallId returning null: is tool-call absent or unsupported? */
function callIdMeaning(body) {
	if (body && body.error && typeof body.error.message === "string") return false;
	return null;
}

/**
 * Probe the CLI's own protocol tool-continuation. Routes by entry.protocol:
 * responses -> probeToolContinuation, anthropic -> probeAnthropicContinuation,
 * openai-chat -> probeOpenaiChatContinuation. Pure/testable via injected httpPost.
 */
export async function probeProtocolContinuation({ httpPost, baseURL, apiKey, model, protocol }) {
	switch (protocol) {
		case "anthropic":
			return probeAnthropicContinuation({ httpPost, baseURL, apiKey, model });
		case "openai-chat":
			return probeOpenaiChatContinuation({ httpPost, baseURL, apiKey, model });
		case "responses":
		default:
			return probeToolContinuation({ httpPost, baseURL, apiKey, model });
	}
}

/** A simple POST via the DSH subprocess (curl), shaped like the injected httpPost. */
export function curlHttpPost(ctx, apiKey) {
	return async ({ url, body }) => {
		if (!ctx.subprocess) return { status: 0, body: { error: { message: "no subprocess" } } };
		const out = await runSpawnJson(ctx, ["curl", "-sS", "-m", "40", url, "-H", `Authorization: Bearer ${apiKey}`, "-H", "Content-Type: application/json", "-d", JSON.stringify(body)]);
		let parsed = null;
		try { parsed = JSON.parse(out); } catch { parsed = { error: { message: "non-json response", raw: out.slice(0, 200) } }; }
		return { status: out ? 200 : 0, body: parsed };
	};
}

async function runSpawnJson(ctx, argv) {
	try {
		const handle = ctx.subprocess.spawn({ argv, cwd: ".", stdio: { stdin: "ignore", stdout: { maxBytes: 400000 }, stderr: { maxBytes: 20000 } }, graceMs: 50000 });
		const o = await handle.done;
		return handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
	} catch {
		return "";
	}
}

/** Convert common external-CLI diagnostics into consistent Simplified Chinese. */
export function localizeCliError(cliId, message) {
	const raw = typeof message === "string" ? message.trim() : String(message || "").trim();
	if (!raw) return "CLI 执行失败，但未返回具体原因。";
	if (/not logged in|please run \/login/i.test(raw)) return `${cliById(cliId)?.name || cliId} 尚未登录。请先在插件隔离配置中完成登录认证。`;
	if (/no auth type is selected|configure an auth type|--auth-type/i.test(raw)) return `${cliById(cliId)?.name || cliId} 尚未配置认证方式。请先为该 CLI 选择并配置认证类型。`;
	if (/unauthorized|authentication|invalid api key|api key|\b401\b/i.test(raw)) return `${cliById(cliId)?.name || cliId} 认证失败。请检查当前供应商的 API Key 或登录状态。`;
	return `CLI 执行失败：${raw}`;
}

/** Extract the actual assistant reply from a CLI's stdout. */
export function extractCliReply(cliId, stdout) {
	if (typeof stdout !== "string") return "";
	if (cliId !== "codex") return stdout.trim();
	const replies = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const item = event && event.type === "item.completed" ? event.item : null;
		if (item && item.type === "agent_message" && typeof item.text === "string") replies.push(item.text);
	}
	return replies.join("\n").trim();
}

/**
 * Whether a probe reply confirms "OK". Some suppliers/models echo the reply
 * ("OK\nOK", e.g. repeated agent_message blocks); accept only when every
 * non-empty line is exactly OK, so a real wrong answer still fails.
 */
export function isOkReply(reply) {
	if (typeof reply !== "string") return false;
	const lines = reply.split(/\r?\n+/).map((line) => line.trim().toUpperCase()).filter(Boolean);
	return lines.length > 0 && lines.every((line) => line === "OK");
}

/** Extract actionable Codex JSONL errors when the assistant reply is empty. */
export function extractCodexError(stdout) {
	if (typeof stdout !== "string") return "";
	const errors = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		const item = event && event.type === "item.completed" ? event.item : null;
		if (item && item.type === "error" && typeof item.message === "string" && !isCodexMetadataWarning(item.message)) errors.push(item.message);
		if (event && event.type === "turn.failed" && event.error && typeof event.error.message === "string") errors.push(event.error.message);
	}
	return errors.join("；").trim();
}

/**
 * Codex 0.149.1 在模型 catalog 缺少目标模型（如 `deepseek-v4-flash`）时，会在
 * `item.completed` 里发一条 `type:"error"` 的 warning：模型元数据未命中、回退到
 * fallback metadata。这条信息不是致命错误——Codex 仍会向供应商发 `/responses`
 * 请求并完成 turn（exitCode=0）。它只影响上下文窗口/输出上限等能力提示，不
 * 应被当成「CLI 验证失败」的原因反向呈现给用户。识别并过滤它，让真正的问题
 * （如 agent_message 为空、turn.failed、非零退出）才走失败分支。
 */
export function isCodexMetadataWarning(message) {
	return /model metadata .* not found|defaulting to fallback metadata/i.test(String(message || ""));
}

/**
 * Probe one CLI: write its supplier config, resolve key, run the CLI once, and
 * confirm it answers. Returns { ok, reply, version } or { ok:false, error }.
 */
export async function testCli(ctx, cliId, signal) {
	const entry = cliById(cliId);
	if (!entry) return { ok: false, error: "未知或不存在的 CLI。" };
	const route = routeOf(ctx, cliId);
	if (!route || !route.provider || !route.model) return { ok: false, error: `尚未为 ${entry.name} 配置 Provider 和 Model。` };
	const cfg = await ensureCliProviderConfig(ctx, entry, route);
	if (cfg.error) return { ok: false, error: cfg.error };
	const pc = await providerConfig(ctx, route.provider);
	const key = await credentialKey(ctx, pc && pc.apiKeyEnv);
	const dir = currentDir(ctx);
	const env = await cliEnv(ctx, cliId, dir);
	const bin = binPath(dir, entry.bin, PLATFORM);
	const resolved = await ctx.subprocess.resolveExecutable(bin, env, signal).catch(() => null);
	if (!resolved) return { ok: false, error: `未找到 ${entry.bin}，请先安装到统一目录 ${dir}/bin。` };
	const argv = winShimArgv(resolved, entry.argv("Reply with exactly: OK"), PLATFORM);
	let reply = "";
	let stdout = "";
	try {
		const handle = ctx.subprocess.spawn({ argv, cwd: dir, env, signal, stdio: { stdin: "ignore", stdout: { maxBytes: 200000 }, stderr: { maxBytes: 200000 } }, graceMs: 60000 });
		const outcome = await handle.done;
		const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
		stdout = out;
		const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
		if (outcome.exitCode !== 0) return { ok: false, error: localizeCliError(cliId, err.trim() || extractCodexError(out) || out.trim() || `退出码 ${outcome.exitCode}`) };
		reply = extractCliReply(cliId, out);
	} catch (error) {
		return { ok: false, error: localizeCliError(cliId, error instanceof Error ? error.message : String(error)) };
	}
	// 兼容模型回声：isOkReply 接受 "OK\nOK"（多次 agent_message），只要每行
	// 都是 OK 就算通过，避免把正常供应商/模型误判为连通失败。
	if (!isOkReply(reply)) {
		const codexError = cliId === "codex" ? extractCodexError(stdout) : "";
		if (codexError) return { ok: false, error: localizeCliError(cliId, codexError) };
		// 模型没有按预期返回 OK。对用户最实用的提示是：当前代理/中转商可能不提供
		// 该 CLI 所需的能力（或模型配置不对），引导其更换代理商再重测。
		return { ok: false, error: `当前代理/中转商（${route.provider}${route.model ? ` / ${route.model}` : ""}）未返回预期的 OK（实际：${reply.slice(0, 40) || "空"}）。可能不提供 ${entry.name} 所需的能力或模型配置有误，请更换代理/中转商后重试。` };
	}
	// Protocol-level tool-continuation gate: each CLI needs its own protocol's
	// tool continuation to actually work (Codex=responses, Claude=anthropic
	// tool_use, Qwen=openai chat tool_calls). A provider that only answers plain
	// text can't drive the CLI's tools, so these are hard failures with a
	// user-facing reason — not a pass.
	let capabilities = null;
	if (pc && pc.baseURL && key) {
		const gate = await probeProtocolContinuation({
			httpPost: curlHttpPost(ctx, key),
			baseURL: pc.baseURL,
			apiKey: key,
			model: route.model,
			protocol: entry.protocol
		});
		capabilities = { toolContinuation: gate.toolContinuation, protocol: entry.protocol };
		if (!gate.toolContinuation) {
			return {
				ok: false,
				error: `当前代理/中转商（${route.provider}）不提供 ${entry.name} 所需的 ${entry.protocolLabel.split("（")[0]}工具续接能力，CLI 无法运行工具/联网任务。请更换支持该协议的代理商（Codex 可试 modelflare）。`,
				capabilities
			};
		}
	} else {
		capabilities = { toolContinuation: false, protocol: entry.protocol };
	}
	// Version
	let version = null;
	try {
		const vh = ctx.subprocess.spawn({ argv: winShimArgv(resolved, ["--version"], PLATFORM), cwd: dir, env, signal, stdio: { stdin: "ignore", stdout: { maxBytes: 20000 }, stderr: { maxBytes: 20000 } }, graceMs: 20000 });
		const vo = await vh.done;
		const outv = vh.collected && vh.collected.stdout ? vh.collected.stdout.readFrom(0).text : "";
		if (vo.exitCode === 0) version = outv.trim().split("\n")[0] || null;
	} catch {
		// version best-effort
	}
	return { ok: true, reply, version, capabilities };
}
