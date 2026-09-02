import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInstalled } from "../lib/status.js";
import { binPath } from "../lib/paths.js";
import { CLI_REGISTRY } from "../lib/registry.js";

function makeExists(files) {
	return async (p) => files.has(p);
}

function makeSpawn(versionOutput) {
	return {
		resolveExecutable: async (bin) => bin,
		spawn: () => ({
			done: Promise.resolve({ exitCode: 0, signal: null }),
			collected: {
				stdout: { readFrom: () => ({ text: versionOutput, nextOffset: 0, lossy: false }) },
				stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) }
			}
		})
	};
}

test("detectInstalled reports not installed when bin missing", async () => {
	const files = new Set();
	const r = await detectInstalled({ exists: makeExists(files), spawn: makeSpawn(""), dir: "/d", entry: CLI_REGISTRY[0] });
	assert.equal(r.installed, false);
	assert.match(r.message, /未找到/);
});

test("detectInstalled reports installed + version when present", async () => {
	// Use the platform-native managed binary path as the exists key.
	const files = new Set([binPath("/d", "codex")]);
	const r = await detectInstalled({ exists: makeExists(files), spawn: makeSpawn("codex-cli 0.148.0\nmore"), dir: "/d", entry: CLI_REGISTRY[0] });
	assert.equal(r.installed, true);
	assert.equal(r.version, "codex-cli 0.148.0");
});

test("detectInstalled keeps first line only", async () => {
	const files = new Set([binPath("/d", "claude")]);
	const r = await detectInstalled({ exists: makeExists(files), spawn: makeSpawn("1.2.3\nline2"), dir: "/d", entry: CLI_REGISTRY[1] });
	assert.equal(r.version, "1.2.3");
});
