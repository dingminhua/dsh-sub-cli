// dsh-sub-cli Host — unified install dir, per-CLI isolated config, install
// detection, three-layer model routing, headless dispatch.
//
// The plugin owns everything under one unified dir (default $HOME/dsh-clis):
//   bin/            the CLI binaries
//   config-<cli>/   each CLI's isolated config (via that CLI's own env var)
// The user's system CLI config is never touched. The unified dir and each
// CLI's { provider, model, reasoningEffort } route are persisted in the
// `dsh-sub-cli` settings section (~/.dsh/settings.yaml).

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { CLI_REGISTRY, cliById } from "./registry.js";
import { resolveDir } from "./paths.js";
import { dispatch } from "./dispatch.js";

export const name = "dsh-sub-cli";
export const inject = ["tools", "subprocess"];

const SETTINGS_NS = settingsNamespace("dsh-sub-cli");

const MODEL_ENTRY = z.object({
	provider: z.string(),
	model: z.string(),
	reasoningEffort: z.string()
}).partial();

const SCHEMA = z.object({
	cliDir: z.string(),
	models: z.record(MODEL_ENTRY).default({})
}).default({});

/** Current settings value read from the live settings scope. */
const state = {
	settingsSource: null
};

function currentSection() {
	return state.settingsSource ? state.settingsSource() : null;
}

function currentDir() {
	return resolveDir(currentSection());
}

export function apply(ctx) {
	// Persist cliDir + per-CLI model route in the `dsh-sub-cli` settings section.
	installSettingsSection(ctx, SETTINGS_NS, SCHEMA, {}, {
		setSource: (current) => {
			state.settingsSource = current;
		},
		onChange: () => {}
	});

	// `cli_dispatch`: headless-run one external CLI and return its output.
	ctx.tools.register(defineTool({
		name: "cli_dispatch",
		description: "用指定的外部 Agent CLI 无头执行一个自包含任务并返回输出。任务必须自包含：对方看不到当前对话上下文。",
		parameters: {
			cli: { type: "string", description: "要用的 CLI 标识：codex / claude / opencode / gemini" },
			task: { type: "string", description: "自包含的任务描述" },
			model: { type: "string", description: "可选：覆盖模型 id" }
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		async execute(args) {
			const cliId = args && typeof args.cli === "string" ? args.cli : "";
			const task = args && typeof args.task === "string" ? args.task : "";
			const model = args && typeof args.model === "string" ? args.model : "";
			const entry = cliById(cliId);
			if (!entry) return { ok: false, error: "未知或不存在的 CLI。" };
			const dir = currentDir();
			return dispatch({ spawn: ctx.subprocess, dir, entry, argv: entry.argv(task, model || undefined), model });
		}
	}));
}
