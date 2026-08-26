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
import { removeManagedCli, testManagedCli } from "./manage.js";
import { installCommandOf, installManagedCli } from "./install.js";
import { markRemoteMethods } from "./remote.js";

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

/** Record that a CLI passed verification (model route works) with full details. */
async function recordVerified(ctx, cliId, { version, provider, model } = {}) {
	const settings = ctx.get("settings");
	if (!settings) return;
	try {
		await settings.mutate(SETTINGS_NS, [{
			op: "set",
			path: ["verified", cliId],
			value: { ok: true, version: version || "", at: new Date().toISOString(), provider: provider || "", model: model || "" }
		}]);
	} catch (_error) {
		// best-effort: a failed record must not fail the install/test result.
	}
}

/** Read one CLI's installed version (or null). */
async function readCliVersion(ctx, cliId, signal) {
	const entry = cliById(cliId);
	if (!entry) return null;
	const dir = currentDir();
	const fs = ctx.get("fs");
	const exists = async (p) => {
		if (!fs) return false;
		return (await fs.lstat(p, {}, signal).catch(() => undefined)) !== undefined;
	};
	const r = await detectInstalled({ exists, spawn: ctx.subprocess, dir, entry, signal });
	return r.version;
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
			return testManagedCli({ spawn: ctx.subprocess, dir: currentDir(), entry });
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
	registerManagedCliProviders({ subagents: ctx.subagents, subprocess: ctx.subprocess }, currentDir);
	registerCliSubagentTools({ subagents: ctx.subagents, tools: ctx.tools });

	// `cli_dispatch`: legacy headless-run fallback for CLIs without a native
	// DSH subagent provider. It returns one result and is not a child conversation.
	ctx.tools.register(defineTool({
		name: "cli_dispatch",
		description: "无头执行一个指定的外部 Agent CLI 的自包含任务并返回其输出（一次性，不创建持续子会话）。任务必须是完整的、自包含的说明，因为外部 CLI 看不到当前对话上下文。当用户说「让 <cli> 无头执行 / 跑一下这个任务」时调用。参数 cli 取值：codex / claude / qwen；task 为自包含任务描述；model 可选（覆盖该 CLI 的模型）。",
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
			return dispatch({ spawn: ctx.subprocess, dir, entry, argv: entry.argv(task, model || undefined), signal: exec.signal });
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
			if (result.ok) await recordVerified(ctx, cliId, { version: result.version });
			return result;
		}
	}));

	// `cli_test`: verify the CLI's configured model route answers a minimal request.
	ctx.tools.register(defineTool({
		name: "cli_test",
		description: "验证某个外部 Agent CLI 配置的模型路由是否真正可用。实现：用该 CLI 在插件里配置的 Provider + Model 向模型发送一个测试请求，要求它只回复 OK；能收到符合预期的答复（含 OK）即判定该模型路由可用（凭证、端点、模型都正常）。前提：需先在该 CLI 的模型配置里选定 Provider 和 Model（见插件设置卡），否则本工具会返回失败。当用户说「测一下 / 验证一下某 CLI 的模型能不能回话、通不通」时调用。参数 cli 取值：codex / claude / qwen。成功后会在插件里写入该 CLI 的「已通过验证」记录（含版本、provider/model、时间）。",
		parameters: {
			cli: { type: "string", required: true, description: "要测试的 CLI 标识：codex / claude / qwen" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		async execute(args) {
			const cliId = args && typeof args.cli === "string" ? args.cli : "";
			const entry = cliById(cliId);
			if (!entry) return { ok: false, error: "未知或不存在的 CLI。参数 cli 取值：codex / claude / qwen。" };
			const section = currentSection();
			const route = section && section.models ? section.models[cliId] : null;
			const provider = route && route.provider ? route.provider : "";
			const model = route && route.model ? route.model : "";
			if (!provider || !model) return { ok: false, error: `尚未为 ${entry.name} 配置 Provider 和 Model。请先在插件设置卡为该 CLI 选定模型。` };
			const llm = ctx.get("llm");
			if (!llm) return { ok: false, error: "模型服务不可用。" };
			let reply = "";
			try {
				for await (const chunk of llm.stream({
					provider,
					model,
					messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] }],
					signal: new AbortController().signal
				})) {
					if (chunk && chunk.type === "text-delta") reply += chunk.text;
				}
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			const trimmed = reply.trim();
			if (!trimmed) return { ok: false, error: "模型未返回答复。" };
			if (!trimmed.toUpperCase().includes("OK")) return { ok: false, error: `模型返回异常（预期含 OK，实际：${trimmed.slice(0, 80) || "（空）"}）。` };
			const version = await readCliVersion(ctx, cliId);
			await recordVerified(ctx, cliId, { version, provider, model });
			return { ok: true, cli: cliId, provider, model, reply: trimmed, version: version || null, verified: true };
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
