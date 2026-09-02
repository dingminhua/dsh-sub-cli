import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { installCommandOf, vendorDir, windowsWrapperCmd } from "../lib/install.js";
import { CLI_REGISTRY } from "../lib/registry.js";

const codex = CLI_REGISTRY[0];

test("vendorDir nests per-CLI install root under the unified dir", () => {
	assert.equal(vendorDir("/managed", codex), path.join("/managed", "vendor", "codex"));
});

test("installCommandOf renders a copyable npm command scoped to the unified dir (POSIX)", () => {
	// installCommandOf renders for the CURRENT platform; this test covers POSIX.
	if (process.platform === "win32") return;
	const command = installCommandOf(codex, "/managed");
	assert.match(command, /npm install/);
	assert.match(command, /@openai\/codex/);
	assert.match(command, /--prefix "\$DIR\/vendor\/codex"/);
	assert.match(command, /ln -sf .*"\$DIR\/bin\/codex"/);
	assert.match(command, /DIR="\/managed"/);
	assert.match(command, /mkdir -p "\$DIR\/bin"/);
});

test("installCommandOf has no comment-only line (zsh treats # as a command)", () => {
	if (process.platform === "win32") return;
	for (const entry of CLI_REGISTRY) {
		const first = installCommandOf(entry, "/managed").split("\n")[0];
		assert.ok(!/^\s*#/.test(first), "command must not start with a # comment");
	}
});

test("installCommandOf (win32) renders a PowerShell install that writes an absolute-path wrapper", () => {
	if (process.platform !== "win32") return;
	const command = installCommandOf(codex, "C:\\managed");
	// Must use npm.cmd (the npm.ps1 shim is blocked under restrictive policies).
	assert.match(command, /npm\.cmd install/);
	assert.match(command, /@openai\/codex/);
	// Must NOT copy npm's broken shim; it writes a wrapper pointing at the real JS.
	assert.match(command, /package\.json/);
	assert.match(command, /Set-Content/);
	assert.match(command, /codex\.cmd/);
	assert.ok(!/Copy-Item/.test(command), "must not Copy-Item the broken shim");
});

test("windowsWrapperCmd embeds the absolute JS entry so the shim works from bin/", () => {
	const cmd = windowsWrapperCmd("D:\\x\\vendor\\codex\\node_modules\\@openai\\codex\\bin\\codex.js");
	assert.ok(cmd.startsWith("@ECHO off"));
	assert.match(cmd, /node "D:\\x\\vendor\\codex\\node_modules\\@openai\\codex\\bin\\codex\.js" %\*/);
	// No %~dp0-relative resolution that would break outside node_modules/.bin.
	assert.ok(!/%~dp0/.test(cmd));
});

test("windowsWrapperCmd runs a native .exe entry directly (no node prefix)", () => {
	const cmd = windowsWrapperCmd("D:\\x\\vendor\\claude\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
	// A PE cannot run through node; the wrapper must invoke it directly.
	assert.match(cmd, /"D:\\x\\vendor\\claude\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude\.exe" %\*/);
	assert.ok(!/node ".*claude\.exe"/.test(cmd), "must not wrap a native exe with node");
});

test("installCommandOf (win32) detects .exe vs .js when writing the wrapper", () => {
	if (process.platform !== "win32") return;
	const command = installCommandOf(codex, "C:\\managed");
	// The rendered PowerShell branches on .exe to drop the node prefix.
	assert.match(command, /\\\.exe\$/);
});

test("installCommandOf never installs globally or touches system config (POSIX)", () => {
	if (process.platform === "win32") return;
	const claude = CLI_REGISTRY[1];
	const command = installCommandOf(claude, "/d");
	assert.ok(!/npm install -g/.test(command));
	assert.match(command, /--prefix "\$DIR\/vendor\/claude"/);
	assert.match(command, /@anthropic-ai\/claude-code/);
});
