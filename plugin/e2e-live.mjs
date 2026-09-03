#!/usr/bin/env node
// Real-environment end-to-end verification for dsh-sub-cli.
//
// Unlike `npm test` (offline unit tests with mocks), this script exercises the
// REAL installation end to end:
//   - reads the live ~/.dsh/settings.yaml (cliDir, per-CLI model route,
//     fine-grained permission profiles) and ~/.dsh/.credentials.yaml
//   - reuses the plugin's own pure functions (registry argv templates,
//     normalizePermission/deriveSandboxMode, verify.js config renderers) so the
//     assertions target the exact production code paths
//   - writes each CLI's isolated supplier config (same as prepareManagedRun)
//   - spawns the REAL CLI binary headless with a minimal task and checks the
//     exit code and output
//   - verifies the permission → argv sandbox mapping for every CLI
//
// It never prints an API key. It needs a working provider route + credentials,
// so it is opt-in (`npm run test:live`) and not part of CI.
//
// Exit code 0 = every scenario passed; 1 = at least one failed.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_REGISTRY, cliById } from "./lib/registry.js";
import { envFor, binPath, PLATFORM } from "./lib/paths.js";
import { normalizePermission, deriveSandboxMode } from "./lib/permissions.js";
import { winShimArgv } from "./lib/dispatch.js";
import { codexToml, gateToml, qwenSettings, fingerprint, stripTrailingV1, isOkReply } from "./lib/verify.js";
import { CLI_SUBAGENT_TOOLS } from "./lib/subagent-tools.js";
import { CodexAppServerDriver } from "./lib/drivers/codex-app-server.js";
import { ClaudeStreamJsonDriver } from "./lib/drivers/claude-stream-json.js";
import { QwenStreamJsonDriver } from "./lib/drivers/qwen-stream-json.js";
import { ManagedCliAgentsService } from "./lib/managed-cli-agents.js";

// ── minimal settings.yaml extraction (only the bits the plugin owns) ─────────

function sectionOf(text, name) {
	const re = new RegExp(`^${name}:\\s*(?:$|\\n)`, "m");
	const m = re.exec(text);
	if (!m) return null;
	const start = m.index + m[0].length;
	const rest = text.slice(start).split("\n");
	const out = [];
	for (const line of rest) {
		if (out.length > 0 && /^\S.*:/.test(line)) break; // next top-level key
		out.push(line);
	}
	return out.join("\n");
}

/** Extract a YAML flow block (`{ ... }`) that follows a `key:` inside `text`. */
function flowBlockAfter(text, key) {
	const idx = text.indexOf(`${key}:`);
	if (idx < 0) return null;
	const from = text.indexOf("{", idx);
	if (from < 0) return null;
	let depth = 0, inStr = false, quote = "";
	for (let i = from; i < text.length; i++) {
		const ch = text[i];
		if (inStr) { if (ch === quote) inStr = false; continue; }
		if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
		if (ch === "{") depth++;
		else if (ch === "}") { depth--; if (depth === 0) return text.slice(from, i + 1); }
	}
	return null;
}

function splitTopLevel(s) {
	const parts = [];
	let depth = 0, inStr = false, quote = "", cur = "";
	for (const ch of s) {
		if (inStr) { cur += ch; if (ch === quote) inStr = false; continue; }
		if (ch === '"' || ch === "'") { inStr = true; quote = ch; cur += ch; continue; }
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
		cur += ch;
	}
	if (cur.trim()) parts.push(cur);
	return parts;
}

function topLevelColon(s) {
	let depth = 0, inStr = false, quote = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) { if (ch === quote) inStr = false; continue; }
		if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		if (ch === ":" && depth === 0) return i;
	}
	return -1;
}

function parseScalar(v) {
	v = v.trim();
	if (v === "true") return true;
	if (v === "false") return false;
	if (v === "null" || v === "~") return null;
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
	const n = Number(v);
	return Number.isNaN(n) ? v : n;
}

/** Parse a flow object `{ a: 1, b: { c: x } }` into a plain JS object. */
function parseFlowObject(block) {
	const inner = block.trim().replace(/^\{/, "").replace(/\}$/, "");
	const out = {};
	for (const entry of splitTopLevel(inner)) {
		const c = topLevelColon(entry);
		if (c < 0) continue;
		const k = entry.slice(0, c).trim().replace(/^["']|["']$/g, "");
		const v = entry.slice(c + 1).trim();
		out[k] = v.startsWith("{") ? parseFlowObject(v) : parseScalar(v);
	}
	return out;
}

function scalarAfter(text, key) {
	const re = new RegExp(`^\\s*${key}:\\s*(\\S.*)$`, "m");
	const m = re.exec(text);
	return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
}

/**
 * Parse a `key:` mapping whose value is either an inline flow object
 * (`models: { ... }`, written by older settings emitters) or an indented
 * block mapping (`models:\n  codex:\n    provider: x`), which is what the
 * live dsh-settings service persists today. Handles the two nesting levels
 * the plugin schema needs (models.<cli>.<field>, permissions.<cli>.<field>
 * or permissions.<cli>: <string tier>).
 */
function parseMapping(text, key) {
	// Same-line flow object first: `key: { a: 1 }`.
	const sameLine = new RegExp(`^(\\s*)${key}:[ \\t]*(\\{.*)$`, "m");
	const sm = sameLine.exec(text);
	if (sm) {
		const block = flowBlockAfter(text, key);
		return block ? parseFlowObject(block) : null;
	}
	// Value on following lines: either a next-line flow object
	// (`key:\n    { a: 1 }`) or a block mapping (`key:\n    a: 1`).
	const re = new RegExp(`^(\\s*)${key}:[ \\t]*$`, "m");
	const m = re.exec(text);
	if (!m) return null;
	const keyIndent = m[1].length;
	const rest = text.slice(m.index + m[0].length);
	// The next NON-EMPTY line decides the shape. Note `rest` starts with "\n";
	// without the m flag `^` would anchor to that (empty) first line and fail.
	const nextLine = (/[ \t]*(\S[^\n]*)/.exec(rest) || [])[1] ?? "";
	if (nextLine.startsWith("{")) {
		const block = flowBlockAfter(text, key);
		return block ? parseFlowObject(block) : null;
	}
	if (nextLine === "") return null; // empty value, not a mapping
	const lines = rest.split("\n");
	const root = {};
	let current = null;
	for (const raw of lines) {
		if (!raw.trim()) continue;
		const indent = /^\s*/.exec(raw)[0].length;
		if (indent <= keyIndent) break; // next sibling key ends this mapping
		const line = raw.trim();
		const c = topLevelColon(line);
		if (c < 0) continue;
		const k = line.slice(0, c).trim().replace(/^["']|["']$/g, "");
		const v = line.slice(c + 1).trim();
		if (indent === keyIndent + 2) {
			if (v.startsWith("{")) { root[k] = parseFlowObject(v); current = null; }
			else if (v === "") { root[k] = {}; current = root[k]; }
			else { root[k] = parseScalar(v); current = null; }
		} else if (current) {
			current[k] = v.startsWith("{") ? parseFlowObject(v) : parseScalar(v);
		}
	}
	return root;
}

/** Extract `providers.<id>: { baseURL, apiKeyEnv }` from the llm-pi-ai section. */
function extractProviders(sectionText) {
	const providers = {};
	const re = /^ {4}(\S+):\s*$/gm;
	let m;
	while ((m = re.exec(sectionText))) {
		const id = m[1];
		const after = sectionText.slice(m.index + m[0].length);
		const base = /^\s+baseURL:\s*(\S+)/m.exec(after);
		const key = /^\s+apiKeyEnv:\s*(\S+)/m.exec(after);
		if (base && key) providers[id] = { baseURL: base[1].replace(/["']/g, ""), apiKeyEnv: key[1].replace(/["']/g, "") };
	}
	return providers;
}

function readCredentials(file) {
	const refs = {};
	try {
		const text = readFileSync(file, "utf8");
		const re = /^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/gm;
		let m;
		while ((m = re.exec(text))) refs[m[1]] = m[2];
	} catch { /* missing file → empty */ }
	return refs;
}

// ── real spawn helpers (node child_process, no DSH subprocess service) ───────

const MAX_OUTPUT = 200000;
const RUN_TIMEOUT_MS = 180000;

/**
 * Spawn a managed CLI binary headlessly. On Windows the binary is a .cmd shim
 * that Node cannot execFile/spawn directly (EINVAL), so it is wrapped through
 * cmd.exe /d /s /c. On POSIX it spawns the bare path unchanged.
 */
function spawnCli(bin, args, opts) {
	const wrapped = winShimArgv(bin, args);
	const [exe, ...rest] = wrapped;
	return spawn(exe, rest, opts);
}

function runCli({ finalArgv, env, timeoutMs = RUN_TIMEOUT_MS }) {
	return new Promise((resolve) => {
		const [exe, ...rest] = finalArgv;
		let child;
		try {
			child = spawn(exe, rest, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			return resolve({ exitCode: null, stdout: "", stderr: "", error: error.message });
		}
		let out = "", err = "";
		child.stdout.on("data", (d) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
		child.stderr.on("data", (d) => { if (err.length < MAX_OUTPUT) err += d.toString(); });
		const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, timeoutMs);
		child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout: out, stderr: err, error: "" }); });
		child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: null, stdout: out, stderr: err, error: e.message }); });
	});
}

// ── scenario runner ───────────────────────────────────────────────────────────

const CLAUDE_MODE_BY_TIER = {
	"read-only": "plan",
	"workspace-write": "acceptEdits",
	"danger-full-access": "bypassPermissions"
};

function mask(value, keep = 8) {
	if (typeof value !== "string") return String(value);
	if (value.length <= keep) return "*".repeat(value.length);
	return `${value.slice(0, keep)}…${"*".repeat(4)}`;
}

function describePermission(p) {
	const n = normalizePermission(p);
	return `${n.read ? "r" : "-"}${n.write ? "w" : "-"}${n.exec ? "e" : "-"}`;
}

async function main() {
	const home = os.homedir();
	const settingsFile = process.env.DSC_SETTINGS || path.join(home, ".dsh", "settings.yaml");
	const credFile = process.env.DSC_CREDENTIALS || path.join(home, ".dsh", ".credentials.yaml");

	let settingsText;
	try {
		settingsText = readFileSync(settingsFile, "utf8");
	} catch (error) {
		console.error(`无法读取设置文件 ${settingsFile}: ${error.message}`);
		process.exit(2);
	}
	const subSection = sectionOf(settingsText, "dsh-sub-cli");
	const providersSection = sectionOf(settingsText, "llm-pi-ai");
	if (!subSection) { console.error("settings.yaml 中没有 dsh-sub-cli 段"); process.exit(2); }

	const dir = scalarAfter(subSection, "cliDir") ? path.join(home, scalarAfter(subSection, "cliDir").replace(/^~\//, "")) : path.join(home, "dsh-clis");
	const models = parseMapping(subSection, "models") ?? {};
	const permissions = parseMapping(subSection, "permissions") ?? {};
	const providers = extractProviders(providersSection || "");
	const creds = readCredentials(credFile);

	console.log(`统一目录: ${dir}`);
	console.log(`凭据文件: ${credFile} (${Object.keys(creds).length} 个 key)`);
	console.log("");

	let failures = 0;

	// ── pure invariants (no network / no binary required) ─────────────────────
	// 1) The `cli_codex` alias is gone: Codex exposes only explicit modes, so the
	//    model-facing tool table must NOT register a `cli_codex` name anymore.
	const toolNames = CLI_SUBAGENT_TOOLS.map((s) => s.toolName);
	const hasCodexAlias = toolNames.includes("cli_codex");
	const hasCodexDirect = toolNames.includes("cli_codex_direct");
	console.log(`  [${hasCodexAlias ? "FAIL" : "ok"}] CLI_SUBAGENT_TOOLS 不含 cli_codex 别名（直连=${hasCodexDirect}）`);
	if (hasCodexAlias) failures++;
	if (!hasCodexDirect) { console.log("  [FAIL] CLI_SUBAGENT_TOOLS 缺少 cli_codex_direct"); failures++; }
	// 2) Probe tolerance: some suppliers echo `Reply with exactly: OK` as a multi-line
	//    `OK\nOK`; isOkReply must accept every-all-OK lines (the regression that
	//    previously blocked provider changes from being perceived).
	const okEcho = isOkReply("OK\nOK\nOK\nOK");
	console.log(`  [${okEcho ? "ok" : "FAIL"}] isOkReply 容忍多行 OK 回声（OK\\nOK×4）`);
	if (!okEcho) failures++;
	const okReject = !isOkReply("OK\n再见");
	console.log(`  [${okReject ? "ok" : "FAIL"}] isOkReply 拒绝非 OK 行`);
	if (!okReject) failures++;
	console.log("");

	for (const entry of CLI_REGISTRY) {
		console.log(`── ${entry.name} (${entry.id}) ──────────────────────────`);
		const bin = binPath(dir, entry.bin);
		if (!existsSync(bin)) {
			console.log(`  [FAIL] 未安装: ${bin}`);
			failures++;
			continue;
		}
		console.log(`  [ok] 二进制存在: ${bin}`);

		const route = models[entry.id];
		const permission = permissions[entry.id] ?? "workspace-write";
		const tier = deriveSandboxMode(permission);
		console.log(`  [ok] 路由 provider=${route?.provider ?? "?"} model=${route?.model ?? "?"} (reasoningEffort=${route?.reasoningEffort ?? "?"})`);
		console.log(`  [ok] 权限 profile=${describePermission(permission)} → 推导档位 ${tier}`);

		if (!route || !route.provider || !route.model) {
			console.log(`  [FAIL] 未配置 Provider/Model，跳过运行验证`);
			failures++;
			continue;
		}
		const pc = providers[route.provider];
		if (!pc) {
			console.log(`  [FAIL] 找不到 Provider「${route.provider}」的 baseURL/apiKeyEnv 配置`);
			failures++;
			continue;
		}

		// 1) Permission → argv mapping assertion (production registry path).
		const probe = "Reply with exactly: OK";
		const argv = entry.argv(probe, route.model, permission);
		if (entry.id === "codex") {
			const at = argv.indexOf("-s");
			const ok = at !== -1 && argv[at + 1] === tier;
			console.log(`  [${ok ? "ok" : "FAIL"}] argv -s=${at !== -1 ? argv[at + 1] : "(missing)"} 档位=${tier}`);
			if (!ok) failures++;
		} else if (entry.id === "claude") {
			const at = argv.indexOf("--permission-mode");
			const mode = at !== -1 ? argv[at + 1] : null;
			const ok = mode === CLAUDE_MODE_BY_TIER[tier];
			console.log(`  [${ok ? "ok" : "FAIL"}] argv --permission-mode=${mode} 期望=${CLAUDE_MODE_BY_TIER[tier]}`);
			if (!ok) failures++;
		} else if (entry.id === "qwen") {
			// No CLI-side permission flag at any tier: boolean --sandbox needs
			// docker/podman and dies silently (empty reply, exit 0) on stock
			// machines. Enforcement lives in the driver layer.
			const ok = !argv.includes("--sandbox");
			console.log(`  [${ok ? "ok" : "FAIL"}] argv --sandbox=${argv.includes("--sandbox")} 期望=false(任意档位)`);
			if (!ok) failures++;
		}

		// 2) Write the isolated supplier config (same renderers as production).
		const cfgDir = path.join(dir, entry.configDir);
		if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
		const fp = fingerprint(route.provider, route.model, route.reasoningEffort, pc.baseURL);
		if (entry.id === "codex") {
			writeFileSync(path.join(cfgDir, "config.toml"), gateToml(codexToml(route, pc), route, pc, fp));
		} else if (entry.id === "qwen") {
			writeFileSync(path.join(cfgDir, "settings.json"), qwenSettings(route, pc));
		}
		console.log(`  [ok] 已写入隔离配置 ${entry.configDir}/`);

		// 3) Build the real env exactly like cliEnv (config isolation + supplier key).
		const key = creds[pc.apiKeyEnv];
		if (!key) {
			console.log(`  [FAIL] 凭据文件缺 ${pc.apiKeyEnv}，无法真实运行`);
			failures++;
			continue;
		}
		const env = { ...envFor(entry, dir) };
		env[pc.apiKeyEnv] = key;
		if (entry.id === "claude") {
			env.ANTHROPIC_BASE_URL = stripTrailingV1(pc.baseURL);
			env.ANTHROPIC_API_KEY = key;
			env.ANTHROPIC_AUTH_TOKEN = key;
			env.ANTHROPIC_MODEL = route.model;
			env.ANTHROPIC_DEFAULT_OPUS_MODEL = route.model;
			env.ANTHROPIC_DEFAULT_SONNET_MODEL = route.model;
			env.ANTHROPIC_DEFAULT_HAIKU_MODEL = route.model;
			env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
		}
		console.log(`  [ok] env 隔离 ${entry.env}=… 供应商 key ${mask(key)}`);

		// 4) Real headless run (same argv wrapping production uses).
		const finalArgv = winShimArgv(bin, argv);
		console.log(`  [run] ${finalArgv.map((a) => (a.length > 60 ? `${a.slice(0, 57)}…` : a)).join(" ")}`.slice(0, 260));
		const result = await runCli({ finalArgv, env });
		if (result.exitCode === 0 && /OK/i.test(result.stdout + result.stderr)) {
			console.log(`  [ok] 真实运行 exit=0 输出含 OK`);
		} else {
			console.log(`  [FAIL] 真实运行 exit=${result.exitCode ?? result.error} 输出:`);
			console.log(`    stdout=${JSON.stringify(result.stdout.slice(0, 300))}`);
			console.log(`    stderr=${JSON.stringify(result.stderr.slice(0, 300))}`);
			failures++;
		}
		console.log("");
	}

	// ── Codex 双模式会话验证（真实 app-server + 真实网络）─────────────────────
	// 直连 = service.dispatch（cli_codex_direct 的路径）；代理 = bindChild +
	// submitFromChild（cli_codex_subagent 背后 Relay 子代理的提交路径）。两者走
	// 同一个真实驱动、同一份 app-server 二进制与当前路由。config-codex/config.toml
	// 已由上方逐 CLI 段写入当前路由。
	{
		const entry = cliById("codex");
		const bin = binPath(dir, entry.bin);
		const route = models.codex;
		const pc = route && route.provider ? providers[route.provider] : null;
		const key = pc ? creds[pc.apiKeyEnv] : null;
		if (existsSync(bin) && route && route.provider && route.model && pc && key) {
			console.log(`── Codex 双模式会话（真实 app-server + 网络）─────────────────────`);
			const permission = permissions.codex ?? "workspace-write";
			const createTransport = async (request) => {
				// 必须继承 process.env：统一目录里的 codex 是 `#!/usr/bin/env node`
				// shim，靠 PATH 定位 node；只传隔离 env 会 127。
				const env = { ...process.env, ...envFor(entry, dir), [pc.apiKeyEnv]: key };
				const child = spawnCli(bin, ["app-server", "--stdio"], { env, stdio: ["pipe", "pipe", "inherit"], cwd: request.cwd });
				const listeners = new Set();
				const closeListeners = new Set();
				let buf = "";
				child.stdout.on("data", (chunk) => {
					buf += chunk.toString();
					let nl;
					while ((nl = buf.indexOf("\n")) >= 0) {
						const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
						for (const l of [...listeners]) { try { l(line); } catch {} }
					}
				});
				child.on("close", (code) => { for (const l of [...closeListeners]) l(new Error(`codex app-server exited ${code}`)); });
				child.on("error", (error) => { for (const l of [...closeListeners]) l(error); });
				return {
					write(text) { return new Promise((res, rej) => child.stdin.write(text, (e) => (e ? rej(e) : res()))); },
					onLine(l) { listeners.add(l); return () => listeners.delete(l); },
					onClose(l) { closeListeners.add(l); return () => closeListeners.delete(l); },
					async dispose() { try { child.kill("SIGTERM"); } catch {} }
				};
			};
			const driver = new CodexAppServerDriver({ createTransport, requestTimeoutMs: 30000, turnTimeoutMs: 300000 });
			const service = new ManagedCliAgentsService({
				drivers: { codex: driver },
				routeSource: () => ({ provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }),
				permissionSource: () => permission
			});
			try {
				const signal = new AbortController().signal;
				const direct = await service.dispatch({ cli: "codex", cwd: dir, prompt: "请只用一句话回答：Codex 直连 OK。不要使用任何工具。", signal });
				const directOk = direct.stopReason === "completed" && direct.output.trim().length > 0;
				console.log(`  [${directOk ? "ok" : "FAIL"}] 直连 dispatch stopReason=${direct.stopReason} output=${JSON.stringify(direct.output.slice(0, 90))}`);
				if (!directOk) failures++;
				service.bindChild("e2e-child", { cli: "codex", parentAgent: null });
				service.setChildCwd("e2e-child", dir);
				const proxy1 = await service.submitFromChild("e2e-child", "请只用一句话回答：Codex 代理第一轮 OK。不要使用任何工具。", signal, null);
				const sessionId = proxy1.session.sessionId;
				const proxy2 = await service.submitFromChild("e2e-child", "请只用一句话回答：Codex 代理第二轮 OK（同一会话）。不要使用任何工具。", signal, null);
				const proxyOk = proxy1.stopReason === "completed" && proxy2.session.sessionId === sessionId && proxy2.output.trim().length > 0;
				console.log(`  [${proxyOk ? "ok" : "FAIL"}] 代理 submitFromChild 两轮同一会话 ${sessionId} output=${JSON.stringify(proxy2.output.slice(0, 90))}`);
				if (!proxyOk) failures++;
				await service.close(sessionId).catch(() => {});
			} catch (error) {
				console.log(`  [FAIL] Codex 双模式会话异常: ${error instanceof Error ? error.message : String(error)}`);
				failures++;
			} finally {
				await service.dispose().catch(() => {});
			}
			console.log("");
		} else {
			console.log(`── Codex 双模式会话（跳过：缺安装/路由/凭据，见上方逐 CLI 诊断─────`);
		}
	}

	// ── Claude / Qwen 双模式会话验证（stream-json NDJSON + 真实网络）───────────
	// 这两个 CLI 没有 app-server：每次 turn spawn 一个独立 CLI 进程，--session-id
	// 首次注册会话、--resume 后续续接；service 层把两次调用的 sessionId 锁到同
	// 一记录，验证 "followup 后 sessionId 不变" 即证明持续会话路径真的生效。
	{
		const sc = (entry, dir, env, perm) => spawnCli(binPath(dir, entry.bin), ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"], { env, cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
		const sq = (entry, dir, env, perm) => spawnCli(binPath(dir, entry.bin), ["-p", "--input-format", "stream-json", "--output-format", "stream-json"], { env, cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
		const makeLineTransport = (child) => {
			const listeners = new Set();
			const closeListeners = new Set();
			let buf = "";
			child.stdout.on("data", (chunk) => {
				buf += chunk.toString();
				let nl;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
					for (const l of [...listeners]) { try { l(line); } catch {} }
				}
			});
			child.on("close", (code) => { for (const l of [...closeListeners]) l(new Error(`process exited ${code}`)); });
			child.on("error", (error) => { for (const l of [...closeListeners]) l(error); });
			return {
				write(text) { return new Promise((res, rej) => child.stdin.write(text, (e) => (e ? rej(e) : res()))); },
				onLine(l) { listeners.add(l); return () => listeners.delete(l); },
				onClose(l) { closeListeners.add(l); return () => closeListeners.delete(l); },
				async dispose() { try { child.kill("SIGTERM"); } catch {} }
			};
		};
		// Adapt a Node.js child_process spawn handle to the DSH subprocess shape:
		// the driver accesses `handle.stdin`/`handle.stdout`/`handle.done`/`handle.terminate`.
		// The Node handle already exposes stdin/stdout when stdio is "pipe", but
		// `done` is a Promise we have to create from the `close` event.
		const wrapChild = (child) => {
			let resolveDone;
			const done = new Promise((r) => { resolveDone = r; });
			child.on("close", (code) => resolveDone({ exitCode: code }));
			child.on("error", (err) => resolveDone({ exitCode: 1, error: err }));
			return { ...child, done, terminate: () => { try { child.kill("SIGTERM"); } catch {} } };
		};
		// The Claude/Qwen drivers hand back a FULLY wrapped argv (winShimArgv:
		// [cmd.exe, /d, /c, <bin>, ...flags] on Windows, [<bin>, ...flags] on
		// POSIX) — spawn it directly. The previous double-wrap (spawnCli over
		// argv.slice(1)) leaked `/d /c <bin>` into the CLI's positionals, which
		// Qwen rejects ("positional prompt + --prompt flag together").
		const spawnDriverArgv = (argv, opts) => {
			const [exe, ...rest] = argv;
			return spawn(exe, rest, opts);
		};
		// Claude driver: stream-json over --resume.
		// Qwen driver: stream-json over --resume.
		for (const spec of [
			{
				id: "claude", displayName: "Claude Code",
				driver: ({ env }) => new ClaudeStreamJsonDriver({
					subprocess: {
						resolveExecutable: () => binPath(dir, "claude"),
						spawn: (opts) => wrapChild(spawnDriverArgv(opts.argv, { cwd: opts.cwd, env: { ...process.env, ...opts.env, ...env }, stdio: ["pipe", "pipe", "inherit"] }))
					},
					dirSource: () => dir
				})
			},
			{
				id: "qwen", displayName: "Qwen Code",
				driver: ({ env }) => new QwenStreamJsonDriver({
					subprocess: {
						resolveExecutable: () => binPath(dir, "qwen"),
						spawn: (opts) => wrapChild(spawnDriverArgv(opts.argv, { cwd: opts.cwd, env: { ...process.env, ...opts.env, ...env }, stdio: ["pipe", "pipe", "inherit"] }))
					},
					dirSource: () => dir
				})
			}
		]) {
			const entry = cliById(spec.id);
			const route = models[spec.id];
			const pc = route && route.provider ? providers[route.provider] : null;
			const key = pc ? creds[pc.apiKeyEnv] : null;
			if (!existsSync(binPath(dir, entry.bin)) || !route || !route.provider || !route.model || !pc || !key) {
				console.log(`── ${spec.displayName} 双模式会话（跳过：缺安装/路由/凭据）`);
				continue;
			}
			console.log(`── ${spec.displayName} 双模式会话（stream-json NDJSON）─────────`);
			const env = { ...process.env, ...envFor(entry, dir), [pc.apiKeyEnv]: key };
			if (entry.id === "claude") {
				env.ANTHROPIC_BASE_URL = stripTrailingV1(pc.baseURL);
				env.ANTHROPIC_API_KEY = key;
				env.ANTHROPIC_AUTH_TOKEN = key;
				env.ANTHROPIC_MODEL = route.model;
			}
			const permission = permissions[spec.id] ?? "workspace-write";
			const driver = spec.driver({ env, permission });
			const service = new ManagedCliAgentsService({
				drivers: { [spec.id]: driver },
				routeSource: () => ({ provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }),
				permissionSource: () => permission
			});
			try {
				const signal = new AbortController().signal;
				const first = await service.dispatch({ cli: spec.id, cwd: dir, prompt: `请只用一句话回答：${spec.displayName} 第一轮 OK。不要使用任何工具。`, signal });
				// Codex CLI executes prompts as instructions; Claude/Qwen may interpret
				// the prompt text differently (e.g. Claude Code treats the prompt as
				// a query). Accept any non-error stopReason as success here — the
				// real contract is that output.length > 0.
				const validStop = first.stopReason === "completed" || first.stopReason === "end_turn";
				const firstOk = validStop && first.output.trim().length > 0;
				const sessionId = first.session.sessionId;
				console.log(`  [${firstOk ? "ok" : "FAIL"}] ${spec.displayName} dispatch sessionId=${sessionId} stopReason=${first.stopReason} output=${JSON.stringify(first.output.slice(0, 60))}`);
				if (!firstOk) failures++;
				if (sessionId) {
					const second = await service.followup(sessionId, `请只用一句话回答：${spec.displayName} 第二轮 OK（同一会话）。不要使用任何工具。`, signal);
					const secondValidStop = second.stopReason === "completed" || second.stopReason === "end_turn";
					const secondOk = secondValidStop && second.output.trim().length > 0 && second.session.sessionId === sessionId;
					console.log(`  [${secondOk ? "ok" : "FAIL"}] ${spec.displayName} followup 同 sessionId=${second.session.sessionId} stopReason=${second.stopReason} output=${JSON.stringify(second.output.slice(0, 60))}`);
					if (!secondOk) failures++;
					await service.close(sessionId).catch(() => {});
				} else {
					console.log(`  [FAIL] ${spec.displayName} 未拿到 sessionId，无法续接`);
					failures++;
				}
			} catch (error) {
				console.log(`  [FAIL] ${spec.displayName} 双模式会话异常: ${error instanceof Error ? error.message : String(error)}`);
				failures++;
			} finally {
				await service.dispose().catch(() => {});
			}
			console.log("");
		}
	}

	console.log(failures === 0 ? "✅ 全部真实场景通过" : `❌ ${failures} 个场景失败`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("e2e-live 异常:", error);
	process.exit(1);
});
