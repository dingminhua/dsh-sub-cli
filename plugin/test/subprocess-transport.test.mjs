import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
	SubprocessLineTransport,
	createCodexSubprocessTransportFactory
} from "../lib/drivers/subprocess-transport.js";
import { createManagedCliDrivers } from "../lib/drivers/index.js";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function fakeHandle() {
	const stdout = new EventEmitter();
	const writes = [];
	const done = deferred();
	let terminated = false;
	return {
		stdout,
		stdin: {
			write(text, callback) { writes.push(text); callback?.(); }
		},
		done: done.promise,
		terminate() { terminated = true; done.resolve({ exitCode: null, signal: "SIGTERM" }); },
		get writes() { return writes; },
		get terminated() { return terminated; },
		finish(outcome = { exitCode: 0, signal: null }) { done.resolve(outcome); }
	};
}

test("SubprocessLineTransport frames split and joined lines", async () => {
	const handle = fakeHandle();
	const transport = new SubprocessLineTransport(handle);
	const lines = [];
	transport.onLine((line) => lines.push(line));
	handle.stdout.emit("data", Buffer.from('{"a":1}\n{"b"'));
	handle.stdout.emit("data", Buffer.from(':2}\r\n'));
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
	await transport.write("request\n");
	assert.deepEqual(handle.writes, ["request\n"]);
	handle.finish();
	await handle.done;
});

test("Codex subprocess factory uses managed binary, isolated env, cwd and piped stdio", async () => {
	const handle = fakeHandle();
	let spec;
	let prepared;
	const subprocess = {
		resolveExecutable: async (path) => `${path}-resolved`,
		spawn(value) { spec = value; return handle; }
	};
	const createTransport = createCodexSubprocessTransportFactory({
		subprocess,
		dirSource: () => "/managed",
		prepare: async (cli, dir) => {
			prepared = { cli, dir };
			return { ok: true, env: { CODEX_HOME: "/managed/config-codex" } };
		}
	});
	const transport = await createTransport({ cwd: "/repo" });
	assert.deepEqual(prepared, { cli: "codex", dir: "/managed" });
	assert.deepEqual(spec.argv, ["/managed/bin/codex-resolved", "app-server", "--stdio"]);
	assert.equal(spec.cwd, "/repo");
	assert.deepEqual(spec.env, { CODEX_HOME: "/managed/config-codex" });
	assert.deepEqual(spec.stdio, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	await transport.dispose();
	assert.equal(handle.terminated, true);
});

test("Codex subprocess factory fails before spawn when verification gate blocks", async () => {
	let spawned = false;
	const createTransport = createCodexSubprocessTransportFactory({
		subprocess: {
			resolveExecutable: async (path) => path,
			spawn() { spawned = true; return fakeHandle(); }
		},
		dirSource: () => "/managed",
		prepare: async () => ({ ok: false, reason: "供应商不支持 Responses 工具续接" })
	});
	await assert.rejects(createTransport({ cwd: "/repo" }), /不支持 Responses/);
	assert.equal(spawned, false);
});

test("driver assembly exposes a validated experimental Codex driver", () => {
	const subprocess = {
		resolveExecutable: async (path) => path,
		spawn: () => fakeHandle()
	};
	const drivers = createManagedCliDrivers({ subprocess, dirSource: () => "/managed" });
	assert.equal(drivers.codex.id, "codex-app-server");
	assert.equal(drivers.codex.capabilities.continuable, true);
	assert.equal(drivers.codex.capabilities.interactivePermissions, true);
});
