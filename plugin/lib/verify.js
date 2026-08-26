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
import { cliById } from "./registry.js";
import { binPath, envFor, PLATFORM } from "./paths.js";
import { winShimArgv } from "./dispatch.js";

export const SETTINGS_NS = "dsh-sub-cli";

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
	// it through the settings service for the live value.
	try {
		const desc = ctx.settings.describe({ redactSecrets: true });
		const ns = desc.find((x) => x.ns === SETTINGS_NS);
		return (ns && ns.value) || null;
	} catch {
		return null;
	}
}

/** Resolve the provider's { baseURL, apiKeyEnv } from DSH configurable-provider settings. */
export async function providerConfig(ctx, provider) {
	if (!provider) return null;
	let entry = null;
	try {
		entry = ctx.llm.listConfigurableProviders().find((p) => p.provider === provider);
	} catch {
		return null;
	}
	if (!entry) return null;
	try {
		const desc = ctx.settings.describe({ redactSecrets: true });
		const ai = desc.find((x) => x.ns === entry.settingsNs);
		const p = ai && ai.value && ai.value.providers && ai.value.providers[provider];
		if (!p) return null;
		return { baseURL: p.baseURL, apiKeyEnv: p.apiKeyEnv, displayName: p.displayName || provider };
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
			if (key) env[pc.apiKeyEnv] = key;
		}
	}
	return env;
}

/** Resolve the latest API key from DSH credentials (never cached). */
export async function credentialKey(ctx, apiKeyEnv) {
	if (!apiKeyEnv || !ctx.credentials) return null;
	try {
		const r = await ctx.credentials.resolve(apiKeyEnv);
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

/** Current fingerprint of a CLI's live route (needs provider baseURL). */
export async function currentFingerprint(ctx, cliId) {
	const route = routeOf(ctx, cliId);
	if (!route || !route.provider || !route.model) return null;
	const pc = await providerConfig(ctx, route.provider);
	return fingerprint(route.provider, route.model, route.reasoningEffort, pc && pc.baseURL);
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
	const fp = fingerprint(route && route.provider, route && route.model, route && route.reasoningEffort, pc && pc.baseURL);
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
	try {
		await ctx.settings.mutate(SETTINGS_NS, [{ op: "set", path: ["verified", cliId], value }]);
		return value;
	} catch {
		return value;
	}
}

/** Clear the stored verified record for a CLI. */
export async function clearVerified(ctx, cliId) {
	try {
		await ctx.settings.mutate(SETTINGS_NS, [{ op: "unset", path: ["verified", cliId] }]);
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
	if (entry.id !== "codex") return { supported: false };
	if (!route || !route.provider || !route.model) return { supported: true, ok: false, error: "未为该 CLI 配置 Provider 和 Model。" };
	const pc = await providerConfig(ctx, route.provider);
	if (!pc) return { supported: true, ok: false, error: `找不到 Provider「${route.provider}」的配置（baseURL/apiKeyEnv）。` };
	const dir = currentDir(ctx);
	const cfgDir = path.join(dir, entry.configDir);
	const cfgPath = path.join(cfgDir, "config.toml");
	const fp = fingerprint(route.provider, route.model, route.reasoningEffort, pc.baseURL);
	const fs = ctx.get("fs");
	const existingFp = await readGateFingerprint(ctx, cfgPath, fs);
	if (existingFp === fp) return { supported: true, ok: true, uptodate: true, cfgPath };
	if (!fs || typeof fs.resolve !== "function" || typeof fs.writeText !== "function") {
		return { supported: true, ok: false, error: "当前 DSH 文件服务不支持写 CLI 配置。" };
	}
	const toml = gateToml(codexToml(route, pc), route, pc, fp);
	try {
		await runEnsureDir(ctx, cfgDir);
		const target = await fs.resolve(cfgPath, {}, undefined);
		await fs.writeText(target, toml, undefined, undefined);
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

/** Interpret findCallId returning null: is tool-call absent or unsupported? */
function callIdMeaning(body) {
	if (body && body.error && typeof body.error.message === "string") return false;
	return null;
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
	const env = envFor(entry, dir);
	if (key && pc && pc.apiKeyEnv) env[pc.apiKeyEnv] = key;
	const bin = binPath(dir, entry.bin, PLATFORM);
	const resolved = await ctx.subprocess.resolveExecutable(bin, env, signal).catch(() => null);
	if (!resolved) return { ok: false, error: `未找到 ${entry.bin}，请先安装到统一目录 ${dir}/bin。` };
	const argv = winShimArgv(resolved, entry.argv("Reply with exactly: OK"), PLATFORM);
	let reply = "";
	try {
		const handle = ctx.subprocess.spawn({ argv, cwd: dir, env, signal, stdio: { stdin: "ignore", stdout: { maxBytes: 200000 }, stderr: { maxBytes: 200000 } }, graceMs: 60000 });
		const outcome = await handle.done;
		const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
		const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
		if (outcome.exitCode !== 0) return { ok: false, error: err.trim() || out.trim() || `CLI 退出码 ${outcome.exitCode}` };
		reply = out.trim();
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!reply.toUpperCase().includes("OK")) return { ok: false, error: `该代理/中转商的模型未返回预期（含 OK），实际：${reply.slice(0, 80) || "（空）"}。` };
	// Tool-continuation capability: Codex needs it for real tool/web tasks.
	// A provider that only answers plain text cannot drive Codex's tools, so the
	// Codex test must fail (not pass) and tell the user the new interface is
	// unsupported. claude/qwen keep the text-only check.
	let capabilities = null;
	if (entry.id === "codex" && pc && pc.baseURL && key) {
		const probe = await probeToolContinuation({ httpPost: curlHttpPost(ctx, key), baseURL: pc.baseURL, apiKey: key, model: route.model });
		if (probe.toolContinuation !== true) {
			const why = probe.reason || (probe.step === 1 ? "供应商未返回 function_call" : "供应商未支持 responses 工具续接");
			return {
				ok: false,
				error: `当前供应商（${route.provider}）不支持 Codex 所需的 responses 工具续接新接口，Codex 无法运行工具/联网任务（${why}）。请更换支持该接口的供应商（如 modelflare），或联系供应商支持。`,
				capabilities: { toolContinuation: false, probeReason: why }
			};
		}
		capabilities = { toolContinuation: true };
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
