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

test("negated network markers are boundary promises, not intent", () => {
	// Regression: a discussion prompt promised "…不读写个人文件、不联网" and the
	// bare substring "联网" refused the whole (fully offline) task. Negated
	// forms must not count as network intent.
	assert.equal(needsNetwork("只跑测试，不改系统设置、不读写个人文件、不联网"), false);
	assert.equal(needsNetwork("本任务全程离线，无需联网即可完成"), false);
	assert.equal(needsNetwork("无法上网的环境下也要能运行"), false);
	// Positive forms right next to the negation tests must still hit.
	assert.equal(needsNetwork("请联网查一下这个库的文档"), true);
	assert.equal(needsNetwork("任务需要联网搜索最新文档"), true);
});

test("web research is no longer refused at the capability gate (flows to the permission A-gate)", () => {
	// The user wants each CLI to attempt web research directly — their built-in
	// tools differ, so real behaviour is the only way to know what works. The
	// capability gate therefore passes research tasks through; the permission
	// tier (exec ungranted → A-gate "cannot complete") is the only remaining gate.
	for (const cli of ["codex", "claude", "qwen"]) {
		const result = checkCapability(cli, "联网搜索最近 24 小时 AI 新闻");
		assert.equal(result.ok, true, `${cli} must no longer refuse a research task at this gate`);
	}
});

test("code/file/command tasks pass for every CLI", () => {
	for (const cli of ["codex", "claude", "qwen"]) {
		assert.equal(checkCapability(cli, "读一下这段代码并解释").ok, true);
		assert.equal(checkCapability(cli, "run the unit tests").ok, true);
	}
});

test("an unknown CLI id still passes (later stages reject it)", () => {
	assert.equal(checkCapability("nope", "联网搜索").ok, true);
	assert.equal(checkCapability("", "读代码").ok, true);
});
