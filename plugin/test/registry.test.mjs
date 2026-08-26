import { test } from "node:test";
import assert from "node:assert/strict";
import { CLI_REGISTRY, cliById } from "../lib/registry.js";

test("registry exposes the three managed CLIs", () => {
	assert.equal(CLI_REGISTRY.length, 3);
	const ids = CLI_REGISTRY.map((e) => e.id).sort();
	assert.deepEqual(ids, ["claude", "codex", "qwen"]);
});

test("cliById resolves known ids and returns null for unknown", () => {
	assert.equal(cliById("codex").bin, "codex");
	assert.equal(cliById("claude").env, "CLAUDE_CONFIG_DIR");
	assert.equal(cliById("qwen").env, "QWEN_HOME");
	assert.equal(cliById("nope"), null);
});

test("argv templates are shell-safe arrays; codex uses -m for model", () => {
	const codex = cliById("codex");
	const args = codex.argv("do the task", "gpt-5");
	assert.ok(Array.isArray(args));
	assert.ok(args.includes("do the task"));
	assert.ok(args.includes("-m"));
	assert.ok(args.includes("gpt-5"));
});

test("argv without model omits the model flag", () => {
	const claude = cliById("claude");
	assert.deepEqual(claude.argv("hi", ""), ["-p", "--output-format", "text", "--dangerously-skip-permissions", "hi"]);
});

test("headless argv includes unattended flags so codex never prompts for a TTY", () => {
	const codex = cliById("codex");
	const args = codex.argv("task", "");
	assert.ok(args.includes("--skip-git-repo-check"));
	assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
	const claude = cliById("claude");
	assert.ok(claude.argv("task", "").includes("--dangerously-skip-permissions"));
});

test("qwen uses --prompt for headless task and --model for model", () => {
	const qwen = cliById("qwen");
	assert.deepEqual(qwen.argv("check", "qwen-max"), ["--model", "qwen-max", "--prompt", "check"]);
	assert.deepEqual(qwen.argv("check", ""), ["--prompt", "check"]);
});
