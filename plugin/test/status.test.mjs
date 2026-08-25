import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInstalled } from "../lib/status.js";
import { CLI_REGISTRY } from "../lib/registry.js";

function makeRunCmd(files) {
	return async (argv) => {
		const p = argv[argv.length - 1];
		if (argv[0] === "/bin/test" && files.has(p)) return { exitCode: 0, stdout: "", stderr: "" };
		if (argv[0] === "/bin/test") return { exitCode: 1, stdout: "", stderr: "" };
		return { exitCode: 0, stdout: "", stderr: "" };
	};
}

function makeSpawn(versionOutput) {
	return {
		resolveExecutable: async (bin) => (bin.startsWith("/") ? bin : null),
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
	const r = await detectInstalled({ runCmd: makeRunCmd(files), spawn: makeSpawn(""), dir: "/d", entry: CLI_REGISTRY[0] });
	assert.equal(r.installed, false);
	assert.match(r.message, /未找到/);
});

test("detectInstalled reports installed + version when present", async () => {
	const files = new Set(["/d/bin/codex"]);
	const r = await detectInstalled({ runCmd: makeRunCmd(files), spawn: makeSpawn("codex-cli 0.148.0\nmore"), dir: "/d", entry: CLI_REGISTRY[0] });
	assert.equal(r.installed, true);
	assert.equal(r.version, "codex-cli 0.148.0");
});

test("detectInstalled keeps first line only", async () => {
	const files = new Set(["/d/bin/claude"]);
	const r = await detectInstalled({ runCmd: makeRunCmd(files), spawn: makeSpawn("1.2.3\nline2"), dir: "/d", entry: CLI_REGISTRY[1] });
	assert.equal(r.version, "1.2.3");
});
