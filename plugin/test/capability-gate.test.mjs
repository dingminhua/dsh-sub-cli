import { test } from "node:test";
import assert from "node:assert/strict";
import { needsNetwork, checkCapability } from "../lib/capability-gate.js";

test("network intent is detected in both languages", () => {
	assert.equal(needsNetwork("搜索最近 24 小时的 AI 新闻"), true);
	assert.equal(needsNetwork("请联网查一下这个库的文档"), true);
	assert.equal(needsNetwork("抓取 https://example.com 的内容"), true);
	assert.equal(needsNetwork("search the web for latest news"), true);
	assert.equal(needsNetwork("web search for the release notes"), true);
});

test("ordinary code tasks are not treated as network tasks", () => {
	assert.equal(needsNetwork("读一下 lib/provider.js 并解释 start()"), false);
	assert.equal(needsNetwork("refactor this function"), false);
	assert.equal(needsNetwork("跑一下单元测试"), false);
	assert.equal(needsNetwork(""), false);
});

test("Codex and Qwen refuse network tasks before launch", () => {
	for (const cli of ["codex", "qwen"]) {
		const result = checkCapability(cli, "联网搜索最近 24 小时 AI 新闻");
		assert.equal(result.ok, false, `${cli} must refuse a network task`);
		// The message names the CLI that can do it and the DSH fallback tools.
		assert.match(result.reason, /Claude Code/);
		assert.match(result.reason, /advanced_search/);
	}
});

test("Claude Code is allowed to run network tasks", () => {
	assert.equal(checkCapability("claude", "联网搜索最近 24 小时 AI 新闻").ok, true);
});

test("Codex and Qwen still accept non-network tasks", () => {
	assert.equal(checkCapability("codex", "读一下这段代码").ok, true);
	assert.equal(checkCapability("qwen", "run the unit tests").ok, true);
});

test("an unknown CLI is left to the later stages", () => {
	assert.equal(checkCapability("nope", "联网搜索").ok, true);
});
