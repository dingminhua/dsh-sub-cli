import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

test("registers a session-scoped monitor tab for every managed CLI job kind", () => {
	assert.match(source, /conversation\.view/);
	assert.match(source, /id: "dsh-sub-cli-jobs"/);
	assert.match(source, /\^cli-\(codex\|claude\|qwen\)\$/);
	assert.match(source, /jobsBySession/);
	assert.match(source, /run_in_background:true/);
});

test("install/connectivity state is derived purely from settings, no filesystem probe", () => {
	// No cli/check RPC probe remains in the settings card.
	assert.doesNotMatch(source, /callCliCheck/);
	assert.doesNotMatch(source, /installedState/);
	assert.doesNotMatch(source, /installProbe/);
	assert.doesNotMatch(source, /ctx\.connection\.rpc\.call\("\/api", "cli\/check"/);
	assert.doesNotMatch(source, /"row\.detectFailed"/);
	// State comes from the persisted `verified` record + live route fingerprint.
	assert.match(source, /verifiedState\[0\]\[cli\.id\]/);
	assert.match(source, /fpOk/);
});

test("right-side title status shows the four states", () => {
	// 未安装 (no record), 已安装·未测试 (stale record), 测试失败, 测试通过+版本号.
	assert.match(source, /"row\.notInstalled":\s*"未安装"/);
	assert.match(source, /"row\.connNotTested":\s*"已安装·未测试"/);
	assert.match(source, /"row\.connPassed":\s*"测试通过"/);
	assert.match(source, /"row\.connFailed":\s*"测试失败"/);
	// 测试通过时右上角只显示版本号（"测试通过"由底部引导句表达）。
	assert.match(source, /stateText = v\.version \? cleanVersion\(v\.version\) : t\("row\.connPassed"\)/);
	// Only the bare version number is shown — strip trailing "(Claude Code)"
	// and any WARNING: prefix, never echo the CLI name back.
	assert.match(source, /function cleanVersion\(raw\)/);
	assert.match(source, /WARNING/);
	// Trailing parenthetical "(Claude Code)" is stripped so only the version shows.
	assert.match(source, /replace\(.*\\\(/);
	assert.match(source, /cleanVersion\(v\.version\)/);
	assert.doesNotMatch(source, /cleanVersion.*cli\.name/);
	assert.match(source, /hasRec = !!\s*\(verifiedState\[0\]\[cli\.id\]\)/);
	// 未安装 decided by absence of a verified record, never by a probe.
	assert.match(source, /stateText = t\("row\.notInstalled"\)/);
	assert.doesNotMatch(source, /row\.installed/);
	assert.doesNotMatch(source, /t\("row\.installed"\)/);
});

test("verified record only counts while its fingerprint matches the live route", () => {
	assert.match(source, /var v = fpOk\(stored\) \? stored : null;/);
	assert.match(source, /var f = fpOk\(failed\) \? failed : null;/);
});

test("failed state shows the guidance line, not a raw technical error", () => {
	// The test-hint line renders the guidance text in every state; a failed CLI
	// shows the guideFailed prompt (change the provider, then retest) instead of
	// the raw host error string.
	assert.match(source, /className: "dsc-cli-test-hint" \+ \(f \? " dsc-cli-test-hint-error" : ""\)/);
	// The hint line renders the guidance text (guideText) in every state.
	assert.match(source, /dsc-cli-test-hint" \+ \(f \? " dsc-cli-test-hint-error" : ""\) \},\s*guideText\s*\)/);
	assert.match(source, /stateCls \+= " dsc-conn-fail"/);
	// No technical localizeError is injected into the failed-state line anymore.
	assert.doesNotMatch(source, /localizeError\(cli\.name, f\.error\)/);
});

test("guidance line sits under the route selects and is per-state", () => {
	assert.match(source, /"row\.guideInstall":/);
	assert.match(source, /"row\.guideNotTested":/);
	assert.match(source, /"row\.guideFailed":/);
	assert.match(source, /"row\.guidePassed":/);
	assert.match(source, /guideText = fillCli\(t\("row\.guideInstall"\)\)/);
	assert.match(source, /guideText = fillCli\(t\("row\.guideNotTested"\)\)/);
	assert.match(source, /guideText = fillCli\(t\("row\.guideFailed"\)\)/);
	assert.match(source, /guideText = fillCli\(t\("row\.guidePassed"\)\)/);
	assert.match(source, /React\.createElement\("div", \{ className: "dsc-cli-test-hint"/);
});

test("old probe-era labels and second connectivity line are gone", () => {
	assert.doesNotMatch(source, /"row\.detecting"/);
	assert.doesNotMatch(source, /"row\.connNotTested":\s*"未测试"/);
	assert.doesNotMatch(source, /row\.connectionLabel/);
	assert.doesNotMatch(source, /installedVersion/);
	assert.doesNotMatch(source, /installCls/);
	assert.doesNotMatch(source, /installText/);
});
