import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, winShimArgv } from "../lib/dispatch.js";
import { CLI_REGISTRY } from "../lib/registry.js";

function fakeSpawn(handle) {
	return {
		resolveExecutable: async (bin) => (bin.startsWith("/") ? bin : null),
		spawn: () => handle
	};
}

test("dispatch resolves and runs the binary with config env", async () => {
	let seenSpawn = null;
	const handle = {
		done: Promise.resolve({ exitCode: 0, signal: null }),
		collected: {
			stdout: { readFrom: () => ({ text: "hello world", nextOffset: 0, lossy: false }) },
			stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) }
		}
	};
	const spawn = {
		resolveExecutable: async (bin) => bin,
		spawn: (spec) => { seenSpawn = spec; return handle; }
	};
	const r = await dispatch({ spawn, dir: "/d", entry: CLI_REGISTRY[0], argv: ["exec", "task"], model: "" });
	assert.equal(r.ok, true);
	assert.equal(r.stdout, "hello world");
	assert.ok(seenSpawn.argv[0].startsWith("/d/bin/codex"));
	assert.equal(seenSpawn.env.CODEX_HOME, "/d/config-codex");
});

test("dispatch returns { ok:false } when binary missing", async () => {
	const r = await dispatch({ spawn: { resolveExecutable: async () => null }, dir: "/d", entry: CLI_REGISTRY[1], argv: ["-p"], model: "" });
	assert.equal(r.ok, false);
	assert.match(r.error, /找不到/);
});

test("winShimArgv wraps a .cmd shim through cmd.exe on Windows", () => {
	const wrapped = winShimArgv("C:\\d\\bin\\codex.cmd", ["exec", "task"], "win32");
	assert.deepEqual(wrapped, ["cmd.exe", "/d", "/s", "/c", "C:\\d\\bin\\codex.cmd", "exec", "task"]);
});

test("winShimArgv passes through a POSIX executable unchanged", () => {
	const passed = winShimArgv("/d/bin/codex", ["exec", "task"]);
	assert.deepEqual(passed, ["/d/bin/codex", "exec", "task"]);
});
