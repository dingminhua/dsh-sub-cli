// LLM adapter that lets a continuable DSH child Agent use an external CLI as
// its model engine. The native Agent/Session remains the durable owner, so the
// built-in subagent UI, followups, history, cancellation, and parent settlement
// notifications work without a second task system.

import { dispatch } from "./dispatch.js";
import { cliById } from "./registry.js";

export const CLI_LLM_ROUTES = [
	{ cli: "codex", provider: "dsh-cli-codex", model: "native" },
	{ cli: "claude", provider: "dsh-cli-claude", model: "native" },
	{ cli: "opencode", provider: "dsh-cli-opencode", model: "native" },
	{ cli: "gemini", provider: "dsh-cli-gemini", model: "native" }
];

function blockText(block) {
	if (!block || typeof block !== "object") return "";
	if (block.type === "text") return block.text || "";
	if (block.type === "tool-result") {
		return (block.content || []).map(blockText).filter(Boolean).join("\n");
	}
	return "";
}

/** Render the durable child conversation as a self-contained CLI prompt. */
export function promptFromMessages(messages) {
	const sections = [];
	for (const message of messages || []) {
		if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
		const text = (message.content || []).map(blockText).filter(Boolean).join("\n").trim();
		if (!text) continue;
		sections.push(`${message.role === "assistant" ? "CLI previous answer" : "Task or follow-up"}:\n${text}`);
	}
	return sections.join("\n\n");
}

function errorText(result) {
	const parts = [];
	if (result.error) parts.push(result.error);
	if (result.stderr && result.stderr.trim()) parts.push(result.stderr.trim());
	if (result.stdout && result.stdout.trim()) parts.push(result.stdout.trim());
	return parts.join("\n") || "external CLI failed without diagnostic output";
}

export class CliLlmAdapter {
	constructor({ cli, provider, dirSource, spawn }) {
		this.cli = cli;
		this.provider = provider;
		this.dirSource = dirSource;
		this.spawn = spawn;
	}

	providerInfo(provider) {
		return { id: provider, name: `External CLI · ${this.cli}` };
	}

	providerRetryPolicy() {
		return undefined;
	}

	listModels() {
		return Promise.resolve([{ id: "native", name: "CLI native model" }]);
	}

	resolveModel(provider, model) {
		return Promise.resolve({ provider, id: model, name: model });
	}

	async *stream(options) {
		const entry = cliById(this.cli);
		if (!entry) {
			yield { type: "finish", reason: { kind: "error", failure: { message: `unknown CLI ${this.cli}`, code: "CLI_UNKNOWN" } } };
			return;
		}
		const prompt = promptFromMessages(options.messages);
		if (!prompt) {
			yield { type: "finish", reason: { kind: "error", failure: { message: "CLI prompt is empty", code: "CLI_EMPTY_PROMPT" } } };
			return;
		}
		const result = await dispatch({
			spawn: this.spawn,
			dir: this.dirSource(),
			entry,
			argv: entry.argv(prompt),
			signal: options.signal
		});
		if (!result.ok) {
			yield { type: "finish", reason: { kind: options.signal && options.signal.aborted ? "aborted" : "error", failure: { message: errorText(result), code: options.signal && options.signal.aborted ? "ABORTED" : "CLI_FAILED" } } };
			return;
		}
		const text = result.stdout && result.stdout.trim() ? result.stdout : result.stderr;
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "finish", reason: { kind: "stop" } };
	}
}

export function registerCliLlmAdapters(ctx, dirSource) {
	for (const route of CLI_LLM_ROUTES) {
		ctx.llm.registerAdapter([route.provider], new CliLlmAdapter({
			cli: route.cli,
			provider: route.provider,
			dirSource,
			spawn: ctx.subprocess
		}));
	}
}
