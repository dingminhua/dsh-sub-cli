import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { dispatch, winShimArgv } from "../lib/dispatch.js";
import { binPath } from "../lib/paths.js";
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
	// On Windows the managed binary is a .cmd shim wrapped through cmd.exe, so
	// argv[0] is cmd.exe and the (quoted) shim path is argv[4]; on POSIX argv[0]
	// is the binary itself. Assert the binary appears somewhere in the argv.
	assert.ok(seenSpawn.argv.some((a) => String(a).includes(binPath("/d", "codex"))));
	assert.equal(seenSpawn.env.CODEX_HOME, path.join("/d", "config-codex"));
});

test("dispatch returns { ok:false } when binary missing", async () => {
	const r = await dispatch({ spawn: { resolveExecutable: async () => null }, dir: "/d", entry: CLI_REGISTRY[1], argv: ["-p"], model: "" });
	assert.equal(r.ok, false);
	assert.match(r.error, /找不到/);
});

test("winShimArgv wraps a .cmd shim through cmd.exe on Windows", () => {
	const wrapped = winShimArgv("C:\\d\\bin\\codex.cmd", ["exec", "task"], "win32");
	// cmd /d /c with the RAW path: no /s, no pre-quoting. Node's child_process
	// spawn applies the CreateProcess quoting that keeps a spaced path intact.
	assert.deepEqual(wrapped, ["cmd.exe", "/d", "/c", "C:\\d\\bin\\codex.cmd", "exec", "task"]);
});

test("winShimArgv passes the raw path even when it contains spaces (Node quotes it)", () => {
	const wrapped = winShimArgv("C:\\Program Files\\d\\bin\\codex.cmd", ["exec", "task"], "win32");
	// The argv element stays the raw path; child_process.spawn quotes it.
	assert.deepEqual(wrapped, ["cmd.exe", "/d", "/c", "C:\\Program Files\\d\\bin\\codex.cmd", "exec", "task"]);
});

test("winShimArgv passes through a POSIX executable unchanged", () => {
	const passed = winShimArgv("/d/bin/codex", ["exec", "task"]);
	assert.deepEqual(passed, ["/d/bin/codex", "exec", "task"]);
});

test("dispatch fails fast with an actionable message when a spaced dir meets spaced args on Windows", async () => {
	if (process.platform !== "win32") return;
	const handle = {
		done: Promise.resolve({ exitCode: 0, signal: null }),
		collected: { stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) } }
	};
	const spawn = { resolveExecutable: async (bin) => bin, spawn: () => handle };
	const r = await dispatch({ spawn, dir: "C:\\dir with spaces", entry: CLI_REGISTRY[0], argv: ["exec", "Reply with exactly: OK"] });
	assert.equal(r.ok, false);
	// Must tell the user to switch to a no-space dir rather than the cryptic cmd error.
	assert.match(r.error, /不含空格/);
});

test("dispatch allows a spaced dir on Windows when no argument has spaces", async () => {
	if (process.platform !== "win32") return;
	const handle = {
		done: Promise.resolve({ exitCode: 0, signal: null }),
		collected: { stdout: { readFrom: () => ({ text: "ok", nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) } }
	};
	const spawn = { resolveExecutable: async (bin) => bin, spawn: () => handle };
	// --version has no spaces/metachars, so the spaced dir is fine here.
	const r = await dispatch({ spawn, dir: "C:\\dir with spaces", entry: CLI_REGISTRY[0], argv: ["--version"] });
	assert.equal(r.ok, true);
});
