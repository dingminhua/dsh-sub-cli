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

test("argv without model omits the model flag (default permission workspace-write)", () => {
	const claude = cliById("claude");
	assert.deepEqual(claude.argv("hi", ""), ["-p", "--output-format", "text", "--permission-mode", "acceptEdits", "hi"]);
});

test("permission tier maps into each CLI's argv", () => {
	const codex = cliById("codex");
	assert.deepEqual(codex.argv("t", "", "read-only"), ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "t"]);
	assert.deepEqual(codex.argv("t", "", "workspace-write"), ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "t"]);
	assert.deepEqual(codex.argv("t", "", "danger-full-access"), ["exec", "--json", "--skip-git-repo-check", "-s", "danger-full-access", "t"]);
	const claude = cliById("claude");
	assert.deepEqual(claude.argv("t", "", "read-only").includes("--permission-mode", "plan"), true);
	assert.ok(claude.argv("t", "", "read-only").includes("plan"));
	assert.ok(claude.argv("t", "", "workspace-write").includes("acceptEdits"));
	assert.ok(claude.argv("t", "", "danger-full-access").includes("bypassPermissions"));
	const qwen = cliById("qwen");
	assert.deepEqual(qwen.argv("t", "", "read-only"), ["--sandbox", "--prompt", "t"]);
	assert.deepEqual(qwen.argv("t", "", "workspace-write"), ["--prompt", "t"]);
	assert.deepEqual(qwen.argv("t", "", "danger-full-access"), ["--prompt", "t"]);
	// Unknown tier falls back to the default (workspace-write).
	assert.deepEqual(qwen.argv("t", "", "bogus"), ["--prompt", "t"]);
});

test("headless argv includes unattended flags so codex never prompts for a TTY", () => {
	const codex = cliById("codex");
	const args = codex.argv("task", "");
	assert.ok(args.includes("--skip-git-repo-check"));
	assert.ok(args.includes("-s"));
	assert.ok(args.includes("workspace-write"));
	const claude = cliById("claude");
	assert.ok(claude.argv("task", "").includes("--permission-mode"));
});

test("qwen uses --prompt for headless task and --model for model", () => {
	const qwen = cliById("qwen");
	assert.deepEqual(qwen.argv("check", "qwen-max", "workspace-write"), ["--model", "qwen-max", "--prompt", "check"]);
	assert.deepEqual(qwen.argv("check", "", "workspace-write"), ["--prompt", "check"]);
});
