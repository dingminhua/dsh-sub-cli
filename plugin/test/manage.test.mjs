import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { managedBinaryPath, removeManagedCli, testManagedCli } from "../lib/manage.js";
import { binPath } from "../lib/paths.js";
import { CLI_REGISTRY } from "../lib/registry.js";

const codex = CLI_REGISTRY[0];
function output(text) { return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }; }

test("managedBinaryPath is fixed below the unified bin directory", () => {
	// managedBinaryPath → binPath(dir, bin) → platform-native (codex / codex.cmd).
	assert.equal(managedBinaryPath("/managed", codex), binPath("/managed", codex.bin));
});

test("removeManagedCli only removes the fixed managed file (POSIX branch)", async () => {
	let seen;
	const result = await removeManagedCli({
		fs: { lstat: async () => ({ type: "file" }) },
		spawn: { spawn(spec) { seen = spec; return { done: Promise.resolve({ exitCode: 0 }), collected: { stderr: output("") } }; } },
		dir: "/managed", entry: codex, platform: "darwin"
	});
	// managedBinaryPath is platform-native (codex.cmd on win32), even when the
	// removal branch is forced to POSIX. Compare against the same binPath helper.
	assert.deepEqual(seen.argv, ["/bin/rm", "-f", "--", binPath("/managed", codex.bin)]);
	assert.equal(result.removed, true);
});

test("removeManagedCli refuses a directory at the managed binary path", async () => {
	await assert.rejects(() => removeManagedCli({ fs: { lstat: async () => ({ type: "directory" }) }, spawn: {}, dir: "/managed", entry: codex }), /拒绝删除目录/);
});

test("removeManagedCli is idempotent when not installed", async () => {
	const result = await removeManagedCli({ fs: { lstat: async () => undefined }, spawn: {}, dir: "/managed", entry: codex });
	assert.equal(result.removed, false);
});

test("testManagedCli dispatches a fixed minimal connection prompt", async () => {
	let seen;
	const spawn = {
		resolveExecutable: async (path) => path,
		spawn(spec) { seen = spec; return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output("DSH CLI connection OK"), stderr: output("") } }; }
	};
	const result = await testManagedCli({ spawn, dir: "/managed", entry: codex });
	assert.equal(result.ok, true);
	assert.ok(seen.argv.some((arg) => String(arg).includes("DSH CLI connection OK")));
});

test("testManagedCli runs with the current environment when one is provided", async () => {
	let seen;
	const spawn = {
		resolveExecutable: async (path) => path,
		spawn(spec) { seen = spec; return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output("DSH CLI connection OK"), stderr: output("") } }; }
	};
	const env = { CODEX_HOME: "/managed/config-codex", OPENAI_API_KEY: "sk-current" };
	const result = await testManagedCli({ spawn, dir: "/managed", entry: codex, env });
	assert.equal(result.ok, true);
	assert.equal(seen.env, env);
	assert.equal(seen.env.OPENAI_API_KEY, "sk-current");
});
