import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CLI_REGISTRY } from "../lib/registry.js";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

test("the network toggle is a sandbox dial shown for every CLI", () => {
	// The webTools story is gone: research is the controller's job, so the
	// settings card renders the same network toggle for all three CLIs and
	// never persists network:false behind the user's back.
	assert.doesNotMatch(source, /webTools/, "no webTools marker remains in the client");
	assert.doesNotMatch(source, /"row\.noWebTools"/, "the per-CLI note is gone");
	assert.doesNotMatch(source, /network: props\.cli/, "no conditional network persistence");
	// Every CLI row still names the CLI; the toggle persists what the user set.
	for (const entry of CLI_REGISTRY) {
		assert.match(source, new RegExp(`id: "${entry.id}"`), `CLI row for ${entry.id} still exists`);
	}
});

test("settings footer includes the documented encourage link", () => {
	assert.match(source, /DSC_GITHUB_URL = "https:\/\/github\.com\/dingminhua\/dsh-sub-cli"/);
	assert.match(source, /"row\.cheer": "鼓励一下"/);
	assert.match(source, /"row\.cheer": "Star on GitHub"/);
	assert.match(source, /className: "dsc-cheer"/);
	assert.match(source, /target: "_blank"/);
	assert.match(source, /rel: "noopener noreferrer"/);
	assert.match(source, /className: "dsc-cheer-star"/);
	assert.match(source, /"aria-hidden": "true"/);
	assert.match(source, /className: "dsc-footer-left"/);
});

test("does not register a redundant CLI background-task conversation tab", () => {
	assert.doesNotMatch(source, /conversation\.view/);
	assert.doesNotMatch(source, /dsh-sub-cli-jobs/);
	assert.doesNotMatch(source, /CliJobsView/);
	assert.doesNotMatch(source, /jobsBySession/);
	assert.doesNotMatch(source, /dsc-jobs-/);
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

test("failed state shows its persisted reason and fallback guidance", () => {
	// A matching failed record displays its specific persisted reason; older
	// records without an error fall back to the generic provider-change hint.
	assert.match(source, /className: "dsc-cli-test-hint" \+ \(f \? " dsc-cli-test-hint-error" : ""\)/);
	// The hint line renders the guidance text (guideText) in every state.
	assert.match(source, /dsc-cli-test-hint" \+ \(f \? " dsc-cli-test-hint-error" : ""\) \},\s*guideText\s*\)/);
	assert.match(source, /stateCls \+= " dsc-conn-fail"/);
	assert.match(source, /guideText = f\.error \|\| fillCli\(t\("row\.guideFailed"\)\)/);
});

test("guidance line sits under the route selects and is per-state", () => {
	assert.match(source, /"row\.guideInstall":/);
	assert.match(source, /"row\.guideNotTested":/);
	assert.match(source, /"row\.guideFailed":/);
	assert.match(source, /"row\.guidePassed":/);
	assert.match(source, /guideText = fillCli\(t\("row\.guideInstall"\)\)/);
	assert.match(source, /guideText = fillCli\(t\("row\.guideNotTested"\)\)/);
	assert.match(source, /guideText = f\.error \|\| fillCli\(t\("row\.guideFailed"\)\)/);
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

test("permission UI renders one mutually-exclusive tier dropdown plus the unchecked-strategy select", () => {
	// Fine-grained profile model mirrored in the client.
	assert.match(source, /var PERMISSION_PRESETS = /);
	assert.match(source, /function normalizePermissionClient\(raw\)/);
	// The three old capability checkboxes are gone; one tier SELECT replaces
	// them (只读 ⊆ 可写 ⊆ 可调用工具). presetIdOf maps any stored profile
	// back to a tier for the dropdown value — exec wins, then write.
	assert.match(source, /function presetIdOf\(permission\)/, "profile → tier reverse lookup for the dropdown");
	// The toggles CONTAINER (dsc-perm-toggles, the flex row) stays, but the
	// per-capability checkbox style/element (dsc-perm-toggle{...}) is gone.
	assert.doesNotMatch(source, /dsc-perm-toggle\{/, "no per-capability checkbox style remains");
	assert.doesNotMatch(source, /dsc-perm-toggle"\s*,\s*React/, "no checkbox element remains");
	assert.doesNotMatch(source, /"row\.read"/, "the read checkbox label is gone");
	assert.doesNotMatch(source, /"row\.write"/, "the write checkbox label is gone");
	assert.doesNotMatch(source, /"row\.exec"/, "the exec checkbox label is gone");
	assert.match(source, /"row\.permission"/, "the row label is the tier itself");
	// The three tier ids exist and each preset includes the content of the one
	// above it: 只读 → read only; 可写 → read+write; 可调用工具 → read+write+exec.
	assert.match(source, /\{ id: "read-only", label: "只读", profile: \{ read: true, write: false, exec: false/);
	assert.match(source, /\{ id: "workspace-write", label: "可写", profile: \{ read: true, write: true, exec: false/);
	assert.match(source, /\{ id: "danger-full-access", label: "可调用工具", profile: \{ read: true, write: true, exec: true/);
	// The tier select writes the chosen preset's full profile with approval
	// fixed to "never" — no ask/deny toggle in the UI.
	assert.match(source, /props\.onPermissionChange\(\{ read: chosen\.read, write: chosen\.write, exec: chosen\.exec, approval: "never" \}\)/);
	// No network toggle: exec already carries egress intent, and the host-side
	// normalizer maps legacy network:true onto exec.
	assert.doesNotMatch(source, /"row\\.network"/, "the network toggle label is gone");
	// Approval select stays (right-aligned): it decides what happens when a
	// capability NOT granted by the current tier is triggered.
	assert.match(source, /"row\.approval"/);
	assert.doesNotMatch(source, /"row\.approvalAsk"/, "no ask label — the approval toggle is gone");
	assert.doesNotMatch(source, /"row\.approvalNever"/, "no never label — the approval toggle is gone");
	assert.doesNotMatch(source, /"row\.approvalAllow"/, "auto-allow is gone; the tier is the allow");
	assert.doesNotMatch(source, /\{ id: "allow"/, "no allow option in APPROVAL_OPTIONS");
	assert.doesNotMatch(source, /var APPROVAL_OPTIONS = /, "the approval dropdown is removed — no ask/never toggle");
	assert.doesNotMatch(source, /dsc-perm-approval/, "no approval control element in the permission row");
	assert.match(source, /dsc-perm-tier select\{/, "the tier dropdown shares the select styling");
	// Tier semantics: each tier includes the one above (read ⊆ write ⊆ tools).
	assert.match(source, /"row\.permHint"\s*:\s*"[^"]*只读包含读取[^"]*可写包含只读[^"]*可调用工具包含前两者/);
	// Permissions persist as profile objects (normalizePermissions), not tiers.
	assert.match(source, /function normalizePermissions\(raw\)/);
	assert.match(source, /permissions: normalizePermissions\(/);
	// The legacy named-permission select is gone.
	assert.doesNotMatch(source, /var PERMISSIONS = /);
	assert.doesNotMatch(source, /PERMISSIONS\.map/);
});

test("auto-continue has no checkbox; off is max 0", () => {
	// The toggle was removed: auto-continue is always on, and turning it off is
	// expressed by choosing 0 in the max-nudges select (label says so).
	assert.doesNotMatch(source, /"row\.autoContinue"/, "the standalone toggle label is gone");
	assert.doesNotMatch(source, /dsc-ac-toggle/, "no toggle element or style remains");
	assert.match(source, /"row\.autoContinueMax"\s*:\s*"[^"]*0\s*=\s*关闭/, "the Chinese label explains 0 means off");
	assert.match(source, /"row\.autoContinueMax"\s*:\s*"[^"]*0 = off/, "the English label explains 0 means off");
	assert.match(source, /function autoContinueMaxOf\(raw\)/, "stored profiles normalize to a 0–10 display value");
	assert.match(source, /React\.createElement\("option", \{ value: 0 \}, "0"\)/, "the select offers 0");
	// Old enabled:false profiles must display as 0, not silently re-enable.
	assert.match(source, /if \(!enabled\) return 0;/);
});
