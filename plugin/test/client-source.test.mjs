import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

test("settings card keeps live CLI version in install state", () => {
	assert.match(source, /installed:\s*row\.installed === true, version:/);
	assert.match(source, /installedVersion/);
	assert.match(source, /t\("row\.installed"\) \+ \(installedVersion \? " · " \+ installedVersion/);
});

test("install state carries explicit loading / ready / error status", () => {
	assert.match(source, /status:\s*"loading"/);
	assert.match(source, /status:\s*"ready"/);
	assert.match(source, /status:\s*"error"/);
	assert.match(source, /installProbe\.status === "loading"/);
	assert.match(source, /installProbe\.status === "error"/);
});

test("detection failure is rendered as a state label, never a bare detection failure", () => {
	assert.match(source, /"row\.detectFailed":\s*"状态获取失败"/);
	assert.match(source, /if \(installProbe\.status === "error"\) \{/);
	// The install-status branch must not decide anything from a verify record.
	assert.doesNotMatch(source, /installProbe\.status === "error"\s*\|\|\s*!installInfo/);
});

test("installed label is decided independently from verification", () => {
	assert.match(source, /installed = installProbe\.status === "ready" && !!\s*\(installInfo && installInfo\.installed\)/);
	assert.doesNotMatch(source, /if \(v\) \{\s*statusText/);
	assert.match(source, /Decided ONLY by the Host cli\/check/);
});

test("connectivity verification is a separate line with explicit 未测试/已通过/失败 states", () => {
	assert.match(source, /"row\.connNotTested":\s*"未测试"/);
	assert.match(source, /"row\.connPassed":\s*"已通过"/);
	assert.match(source, /"row\.connFailed":\s*"失败"/);
	assert.match(source, /row\.connectionLabel/);
	assert.match(source, /connCls = "dsc-cli-conn"/);
	assert.match(source, /if \(v\) \{[^}]*connText = t\("row\.connPassed"\)/);
	assert.match(source, /else if \(f\) \{[^}]*connText = t\("row\.connFailed"\)/);
});

test("verification never overrides the install status", () => {
	// The top install line is decided by the Host cli.check install state alone —
	// a verified or failed record can only appear on the connectivity line.
	assert.doesNotMatch(source, /if \(v\) \{\s*[^}]*(row\.installed|row\.notInstalled)/);
	assert.doesNotMatch(source, /if \(f\) \{\s*(statusText|installText) =/);
	assert.doesNotMatch(source, /if \(f\) \{\s*statusText = f\.error/);
});

test("client calls the Host cli/check endpoint without an unavailable generated namespace", () => {
	assert.match(source, /ctx\.connection\.rpc\.call\("\/api", "cli\/check", \{ args: \{ args: \{\} \} \}\)/);
	assert.match(source, /Promise\.resolve\(callCliCheck\(\)\)/);
	assert.doesNotMatch(source, /ctx\.get\("remote\.cli"\)/);
	assert.doesNotMatch(source, /var inject = \[[^\]]*"remote\.cli"/);
});

test("RPC failures are inspected, not silently swallowed", () => {
	assert.match(source, /res\.ok !== true/);
	assert.match(source, /throw new Error\("cli\.check returned ok=false/);
	assert.match(source, /console\.warn\("cli\/check RPC failed/);
	assert.match(source, /console\.error\("cli\/check detection failed/);
	assert.match(source, /installedState\[1\]\(\{ status: "error", rows: \{\}, lastError:/);
	// The old silent "invalid result" fallback path is gone.
	assert.doesNotMatch(source, /\.catch\(function \(\) \{ if \(alive\) installedState\[1\]\(\{ status: "error", rows: \{\} \}\);\s*\}\)\)/);
});

test("unknown remote state is never rendered as not installed", () => {
	assert.match(source, /t\("row\.detecting"\)/);
	assert.match(source, /Host 明确返回 false 才写"未安装"/);
	assert.match(source, /installed = installProbe\.status === "ready"/);
});

test("stale English failure records are localized to Simplified Chinese on render", () => {
	assert.match(source, /function localizeError\(cliName, message\)/);
	assert.match(source, /CLI 执行失败：/);
	assert.match(source, /尚未登录。请先在插件隔离配置中完成登录认证/);
	assert.match(source, /认证\/授权失败/);
	assert.match(source, /localizeError\(cli\.name, f\.error\)/);
});