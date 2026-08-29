// dsh-sub-cli Host — unified install dir, per-CLI isolated config, install
// detection, three-layer model routing, headless dispatch.
//
// The plugin owns everything under one unified dir (default $HOME/dsh-clis):
//   bin/            the CLI binaries
//   config-<cli>/   each CLI's isolated config (via that CLI's own env var)
// The user's system CLI config is never touched. The unified dir and each
// CLI's { provider, model, reasoningEffort } route are persisted in the
// `dsh-sub-cli` settings section (~/.dsh/settings.yaml).

import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { CLI_REGISTRY, cliById } from "./registry.js";
import { resolveDir, managedNames, PLATFORM } from "./paths.js";
import { dispatch } from "./dispatch.js";
import { detectInstalled } from "./status.js";
import { registerCliSubagentTools } from "./subagent-tools.js";
import { registerManagedCliProviders } from "./provider.js";
import { createManagedCliDrivers, registerExperimentalCodexProvider } from "./drivers/index.js";
import { ManagedCliAgentsService } from "./managed-cli-agents.js";
import { registerManagedSessionTools } from "./session-tools.js";
import { removeManagedCli, testManagedCli } from "./manage.js";
import { installCommandOf, installManagedCli } from "./install.js";
import { markRemoteMethods } from "./remote.js";
import { testCli, writeVerified, clearVerified, isVerifiedCurrentAsync, cliEnv, permissionOf, prepareManagedRun } from "./verify.js";

export const name = "dsh-sub-cli";
export const inject = ["tools", "subprocess", "subagents"];

const SETTINGS_NS = settingsNamespace("dsh-sub-cli");

const MODEL_ENTRY = z.object({
	provider: z.string().default(""),
	model: z.string().default(""),
	reasoningEffort: z.string().default("")
}).default({});

const VERIFIED_ENTRY = z.object({
	ok: z.boolean().default(true),
	version: z.string().default(""),
	at: z.string().default(""),
	provider: z.string().default(""),
	model: z.string().default("")
}).default({});

const SCHEMA = z.object({
	cliDir: z.string().default(""),
	models: z.dict(MODEL_ENTRY).default({}),
	permissions: z.dict(z.string()).default({}),
	verified: z.dict(VERIFIED_ENTRY).default({})
}).default({});

/** Current settings value read from the live settings scope. */
const state = {
	settingsSource: null,
	lastDir: null
};

function currentSection() {
	return state.settingsSource ? state.settingsSource() : null;
}

function currentDir() {
	return resolveDir(currentSection());
}

/** Run one subprocess argv and return { exitCode, stdout, stderr }. */
async function runCommand(ctx, argv, signal) {
	const handle = ctx.subprocess.spawn({ argv, cwd: ".", signal, stdio: { stdin: "ignore", stdout: { maxBytes: 100000 }, stderr: { maxBytes: 100000 } }, graceMs: 100000 });
	const outcome = await handle.done;
	const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
	const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
	return { exitCode: outcome.exitCode, stdout: out, stderr: err };
}

/**
 * Move the plugin-managed content (bin/, config-<cli>/, vendor/) from the old
 * unified dir to the new one. Never overwrites an existing destination.
 */
async function migrateDir(ctx, oldDir, newDir) {
	if (!oldDir || !newDir || oldDir === newDir) return;
	const names = [...managedNames(CLI_REGISTRY), "vendor"];
	const fs = ctx.get("fs");
	const exists = async (p) => (fs ? (await fs.lstat(p, {}, undefined).catch(() => undefined)) !== undefined : false);
	for (const name of names) {
		const src = path.join(oldDir, name);
		const dst = path.join(newDir, name);
		if (!(await exists(src))) continue;
		if (await exists(dst)) continue; // keep existing destination (no overwrite)
		const mk = PLATFORM === "win32"
			? ["cmd.exe", "/d", "/s", "/c", `if not exist "${newDir}" mkdir "${newDir}"`]
			: ["/bin/mkdir", "-p", newDir];
		await runCommand(ctx, mk).catch(() => {});
		const mv = PLATFORM === "win32"
			? ["cmd.exe", "/d", "/s", "/c", `move "${src}" "${dst}"`]
			: ["/bin/mv", src, dst];
		await runCommand(ctx, mv).catch(() => {});
	}
}

/** Reconcile after a dir change: migrate content, then record the new dir. */
async function onDirChange(ctx, oldDir, newDir) {
	await migrateDir(ctx, oldDir, newDir);
}

/**
 * Preflight before delegating to an external CLI: if the stored verification
 * still matches the live route (fingerprint), skip the probe; otherwise probe
 * the CLI once — on success write a verified fingerprint and allow the run, on
 * failure block and surface the reason so the agent never runs a broken CLI.
 */
async function preflightCli(ctx, cliId) {
	if (await isVerifiedCurrentAsync(ctx, cliId)) return { ok: true, skipped: true };
	const probe = await testCli(ctx, cliId, undefined);
	if (probe.ok) {
		await writeVerified(ctx, cliId, { version: probe.version, capabilities: probe.capabilities });
		return { ok: true, skipped: false, verified: { version: probe.version, capabilities: probe.capabilities } };
	}
	// 失败也记录（带指纹 + 原因），设置卡据此显示失败原因，配置变则消失。
	await writeVerified(ctx, cliId, { ok: false, error: probe.error, capabilities: probe.capabilities });
	return { ok: false, error: probe.error };
}

export function apply(ctx) {
	// Persist cliDir + per-CLI model route in the `dsh-sub-cli` settings section.
	installSettingsSection(ctx, SETTINGS_NS, SCHEMA, {}, {
		setSource: (current) => {
			state.settingsSource = current;
		},
		onChange: () => {
			const dir = resolveDir(currentSection());
			const oldDir = state.lastDir;
			state.lastDir = dir;
			if (oldDir && oldDir !== dir) onDirChange(ctx, oldDir, dir);
		}
	});

	// Create a CLI service that can be accessed remotely through Typert Gateway
	class CliService extends TypertRemoteService {
		constructor() {
			super(ctx, "cli");
			markRemoteMethods(CliService.prototype, ["check", "test", "remove", "installCommand"]);
		}

		async check(args) {
			const dir = currentDir();
			const fs = ctx.get("fs");
			const exists = async (p) => {
				if (!fs) return false;
				const info = await fs.lstat(p, {}, undefined).catch(() => undefined);
				return info !== undefined;
			};
			const runCmd = async (argv) => {
				const handle = ctx.subprocess.spawn({ argv, cwd: ".", stdio: { stdin: "ignore", stdout: { maxBytes: 200000 }, stderr: { maxBytes: 200000 } }, graceMs: 20000 });
				const outcome = await handle.done;
				const o = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
				const e = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
				return { exitCode: outcome.exitCode, stdout: o, stderr: e };
			};
			const only = args && typeof args.cli === "string" && args.cli ? args.cli : null;
			const target = only ? CLI_REGISTRY.filter((e) => e.id === only) : CLI_REGISTRY;
			const results = [];
			for (const entry of target) {
				const r = await detectInstalled({ exists, runCmd, spawn: ctx.subprocess, dir, entry });
				results.push({ id: entry.id, name: entry.name, installed: r.installed, version: r.version, message: r.message, install: entry.install });
			}
			return { dir, results };
		}

		async test(args) {
			const entry = cliById(args && args.cli);
			if (!entry) throw new Error("未知或不存在的 CLI");
			// Test through the CURRENT provider/model route: derive the env from
			// the live config so the CLI points at the configured supplier (not
			// its own credentials). Gate failures report the reason instead of a
			// misleading pass.
			const prep = await prepareManagedRun(ctx, entry.id, currentDir());
			if (!prep.ok) return { ok: false, message: prep.reason };
			return testManagedCli({ spawn: ctx.subprocess, dir: currentDir(), entry, env: prep.env });
		}

		async remove(args) {
			const entry = cliById(args && args.cli);
			if (!entry) throw new Error("未知或不存在的 CLI");
			const fs = ctx.get("fs");
			if (!fs) throw new Error("当前 DSH 未提供文件状态服务");
			return removeManagedCli({ fs, spawn: ctx.subprocess, dir: currentDir(), entry });
		}

		async installCommand(args) {
			const entry = cliById(args && args.cli);
			if (!entry) throw new Error("未知或不存在的 CLI");
			return { ok: true, command: installCommandOf(entry, currentDir()) };
		}
	}

	// Register the CLI service - this makes it available via ctx.remote.cli.check()
	new CliService();

	// Register managed CLI subagent providers and the model-facing tools. These
	// run once `subagents` (a hard dependency, always present in a DSH host) is
	// available, so they are not skipped by boot ordering.
	const envForEntry = async (cliId, dir) => {
		const prep = await prepareManagedRun(ctx, cliId, dir);
		if (!prep.ok) return { ok: false, reason: prep.reason };
		return { ok: true, env: prep.env };
	};
	registerManagedCliProviders({ subagents: ctx.subagents, subprocess: ctx.subprocess }, currentDir, envForEntry);
	const drivers = createManagedCliDrivers({ subprocess: ctx.subprocess, dirSource: currentDir, prepare: envForEntry });
	// Keep the validated one-shot Provider for DSH child presentation and
	// compatibility; the session service below owns persistent Codex threads.
	registerExperimentalCodexProvider({ subagents: ctx.subagents, subprocess: ctx.subprocess }, {
		drivers,
		dirSource: currentDir,
		prepare: envForEntry,
		routeSource: () => currentSection()?.models?.codex ?? {},
		permissionSource: () => permissionOf(ctx, "codex")
	});
	const managedCliAgents = new ManagedCliAgentsService({
		drivers,
		routeSource: (cliId) => currentSection()?.models?.[cliId] ?? {},
		permissionSource: (cliId) => permissionOf(ctx, cliId)
	});
	if (typeof ctx.provide === "function") ctx.provide("managedCliAgents", managedCliAgents);
	ctx.effect(() => () => managedCliAgents.dispose());
	registerCliSubagentTools({ subagents: ctx.subagents, tools: ctx.tools }, {
		preflight: (cliId) => preflightCli(ctx, cliId),
		managedCliAgents
	});
	registerManagedSessionTools({ tools: ctx.tools }, managedCliAgents);

	// `cli_dispatch`: legacy headless-run fallback for CLIs without a native
	// DSH subagent provider. It returns one result and is not a child conversation.
	ctx.tools.register(defineTool({
		name: "cli_dispatch",
		description: "无头执行一个指定的外部 Agent CLI 的自包含任务并返回其输出（一次性，不创建持续子会话）。任务必须是完整的、自包含的说明，因为外部 CLI 看不到当前对话上下文。当用户说「让 <cli> 无头执行 / 跑一下这个任务」时调用。参数 cli 取值：codex / claude / qwen；task 为自包含任务描述；model 可选（覆盖该 CLI 的模型）。注意：仅当用户明确要「无头运行某个 CLI 的一次性任务」时才用本工具；日常更推荐专有工具 cli_codex / cli_claude_code / cli_qwen（子代理）。若返回「认证 / 401 / 未配置模型」类错误，说明该 CLI 未配置好，如实告诉用户并建议其配置，不要改用 shell 直接运行绕过。",
		parameters: {
			cli: { type: "string", required: true, description: "要用的 CLI 标识：codex / claude / qwen" },
			task: { type: "string", required: true, description: "自包含的任务描述" },
			model: { type: "string", description: "可选：覆盖模型 id" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		async execute(args, exec) {
			const cliId = args && typeof args.cli === "string" ? args.cli : "";
			const task = args && typeof args.task === "string" ? args.task : "";
			const model = args && typeof args.model === "string" ? args.model : "";
			const entry = cliById(cliId);
			if (!entry) return { ok: false, error: "未知或不存在的 CLI。" };
			const dir = currentDir();
			const prep = await prepareManagedRun(ctx, cliId, dir);
			if (!prep.ok) return { ok: false, error: prep.reason };
			const argv = entry.argv(task, model || undefined, permissionOf(ctx, cliId));
			return dispatch({ spawn: ctx.subprocess, dir, entry, argv, env: prep.env, signal: exec.signal });
		}
	}));

	// `cli_check`: report whether each / one installed external CLI is ready.
	ctx.tools.register(defineTool({
		name: "cli_check",
		description: "检测外部 Agent CLI 是否已安装到插件管理的统一目录，并报告版本号。判断依据：<统一目录>/bin/<cli> 是否存在且可执行。只读、不修改任何东西、不运行 CLI 的模型。当用户说「看看/检查一下某 CLI 装了没、状态怎么样」时调用。参数 cli 可选：省略时检查全部；传 codex / claude / qwen 时只检查一个。",
		parameters: {
			cli: { type: "string", description: "可选：要检查的 CLI 标识 codex / claude / qwen；省略则检查全部" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		async execute(args) {
			const dir = currentDir();
			const fs = ctx.get("fs");
			const exists = async (p) => {
				if (!fs) return false;
				const info = await fs.lstat(p, {}, undefined).catch(() => undefined);
				return info !== undefined;
			};
			const runCmd = async (argv) => {
				const handle = ctx.subprocess.spawn({ argv, cwd: ".", stdio: { stdin: "ignore", stdout: { maxBytes: 200000 }, stderr: { maxBytes: 200000 } }, graceMs: 20000 });
				const outcome = await handle.done;
				const o = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
				const e = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
				return { exitCode: outcome.exitCode, stdout: o, stderr: e };
			};
			const only = args && typeof args.cli === "string" && args.cli ? args.cli : null;
			const target = only ? CLI_REGISTRY.filter((e) => e.id === only) : CLI_REGISTRY;
			const results = [];
			for (const entry of target) {
				const r = await detectInstalled({ exists, runCmd, spawn: ctx.subprocess, dir, entry });
				results.push({ id: entry.id, name: entry.name, installed: r.installed, version: r.version, message: r.message, install: entry.install });
			}
			return { dir, results };
		}
	}));

	// `cli_install`: install (or update) one managed CLI into the unified dir.
	ctx.tools.register(defineTool({
		name: "cli_install",
		description: "把某个外部 Agent CLI 安装（或更新）到统一目录：安装其官方 npm 包到 <统一目录>/vendor/<cli>，再把它暴露的命令链接到 <统一目录>/bin/<cli>。只装到插件管理的统一目录，绝不安装到系统全局、绝不改动系统里已装的该 CLI。安装成功会在插件里留下「已通过验证」记录（含版本）。当用户说「帮我装/安装/装一下 Codex（或 Claude Code / Qwen Code）」「把某 CLI 更新一下」时调用。参数 cli 取值：codex / claude / qwen。如安装失败会返回具体原因（含 npm 错误）。",
		parameters: {
			cli: { type: "string", required: true, description: "要安装的 CLI 标识：codex / claude / qwen" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		async execute(args, exec) {
			const cliId = args && typeof args.cli === "string" ? args.cli : "";
			const entry = cliById(cliId);
			if (!entry) return { ok: false, error: "未知或不存在的 CLI。" };
			const result = await installManagedCli({ spawn: ctx.subprocess, dir: currentDir(), entry, signal: exec.signal });
			return result;
		}
	}));

	// `cli_test`: verify the CLI itself can run with the configured model/supplier.
	ctx.tools.register(defineTool({
		name: "cli_test",
		description: "真正验证某个外部 Agent CLI 能否用当前配置的模型/供应商跑通。实现：把所选供应商（baseURL + 最新 API key + wire_api）写进该 CLI 自己的配置（如 Codex 的 config-codex/config.toml），用该配置无头运行一次「Reply with exactly: OK」确认可连通，然后按该 CLI 所需协议做一次真实工具续接探测，判定该供应商是否支持。各 CLI 所测协议：Codex=OpenAI Responses（含工具续接）；Claude Code=Anthropic Messages（含 tool_use 续接）；Qwen Code=Chat Completions（含 tool_calls）。若该供应商不支持所需协议，测试判失败并说明原因（如 Codex 可试 modelflare）。前提：需先在该 CLI 的模型配置里选定 Provider 和 Model。当用户说「测一下 / 验证一下某 CLI 能不能正常用、通不通」时调用。参数 cli 取值：codex / claude / qwen。成功则写入「已通过验证」记录（含配置指纹），失败则写入失败原因（配置变更后消失）。",
		parameters: {
			cli: { type: "string", required: true, description: "要测试的 CLI 标识：codex / claude / qwen" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		async execute(args, exec) {
			const cliId = args && typeof args.cli === "string" ? args.cli : "";
			const result = await testCli(ctx, cliId, exec.signal);
			if (result.ok) await writeVerified(ctx, cliId, { version: result.version, capabilities: result.capabilities });
			else await writeVerified(ctx, cliId, { ok: false, error: result.error, capabilities: result.capabilities });
			return { ...result, cli: cliId, verified: !!result.ok };
		}
	}));

	// `cli_remove`: delete one managed CLI from the unified dir only.
	ctx.tools.register(defineTool({
		name: "cli_remove",
		description: "从插件管理的统一目录删除一个托管 CLI：只删 <统一目录>/bin/<cli> 下的文件，绝不改动系统里安装的该 CLI、不改动该 CLI 的配置目录或用户模型设置。当用户说「卸载/删除/移除某 CLI」时调用。参数 cli 取值：codex / claude / qwen。若该 CLI 未安装，会返回已删除（幂等）。",
		parameters: {
			cli: { type: "string", required: true, description: "要删除的 CLI 标识：codex / claude / qwen" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		async execute(args) {
			const cliId = args && typeof args.cli === "string" ? args.cli : "";
			const entry = cliById(cliId);
			if (!entry) return { ok: false, error: "未知或不存在的 CLI。" };
			const fs = ctx.get("fs");
			if (!fs) return { ok: false, error: "当前 DSH 未提供文件状态服务。" };
			return removeManagedCli({ fs, spawn: ctx.subprocess, dir: currentDir(), entry });
		}
	}));
}
