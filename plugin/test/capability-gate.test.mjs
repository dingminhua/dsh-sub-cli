import { test } from "node:test";
import assert from "node:assert/strict";
import { needsNetwork, checkCapability } from "../lib/capability-gate.js";

test("network intent is detected in both languages", () => {
	assert.equal(needsNetwork("联网搜索最近 24 小时的 AI 新闻"), true);
	assert.equal(needsNetwork("请联网查一下这个库的文档"), true);
	assert.equal(needsNetwork("搜一下最近的新闻"), true);
	assert.equal(needsNetwork("浏览这个网页并总结"), true);
	assert.equal(needsNetwork("search the web for latest news"), true);
	assert.equal(needsNetwork("web search for the release notes"), true);
	assert.equal(needsNetwork("fetch this url: https://example.com"), true);
});

test("ordinary code tasks are not treated as network tasks", () => {
	assert.equal(needsNetwork("读一下 lib/provider.js 并解释 start()"), false);
	assert.equal(needsNetwork("refactor this function"), false);
	assert.equal(needsNetwork("跑一下单元测试"), false);
	assert.equal(needsNetwork(""), false);
});

test("bare web vocabulary in a local task does not trip the gate", () => {
	// Regression: inventorying a tool list mentioned "web_fetch" and the bare
	// "fetch" marker refused the whole (local) task. Markers must match intent
	// phrases, not single web-ish words.
	assert.equal(needsNetwork("盘点你当前会话可用的全部工具，是否有 web_fetch 这一项？"), false);
	assert.equal(needsNetwork("解释这段代码里的 url 常量是干什么的"), false);
	assert.equal(needsNetwork("git log 里的 news 一次提交改了什么"), false);
	assert.equal(needsNetwork("read the http header parsing code"), false);
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
