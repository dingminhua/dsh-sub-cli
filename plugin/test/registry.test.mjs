import { test } from "node:test";
import assert from "node:assert/strict";
import { CLI_REGISTRY, cliById } from "../lib/registry.js";

test("registry exposes the four managed CLIs", () => {
	assert.equal(CLI_REGISTRY.length, 4);
	const ids = CLI_REGISTRY.map((e) => e.id).sort();
	assert.deepEqual(ids, ["claude", "codex", "gemini", "opencode"]);
});

test("cliById resolves known ids and returns null for unknown", () => {
	assert.equal(cliById("codex").bin, "codex");
	assert.equal(cliById("claude").env, "CLAUDE_CONFIG_DIR");
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
	assert.deepEqual(claude.argv("hi", ""), ["-p", "--output-format", "text", "hi"]);
});
