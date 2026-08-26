import { test } from "node:test";
import assert from "node:assert/strict";
import { installManagedCli, updateManagedCli, latestVersion, vendorDir } from "../lib/install.js";
import { CLI_REGISTRY } from "../lib/registry.js";

const codex = CLI_REGISTRY[0];
function output(text) { return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }; }

function fakeSpawn({ version = "0.149.1", resolveTo = null } = {}) {
	const calls = [];
	return {
		calls,
		resolveExecutable: async (bin) => resolveTo === null ? bin : resolveTo,
		spawn(spec) {
			calls.push(spec);
			const argv = spec.argv.join(" ");
			if (argv.includes("npm view")) return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output("0.150.0\n"), stderr: output("") } };
			if (argv.includes("--version")) return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output(version + "\nmore"), stderr: output("") } };
			if (argv.includes("mkdir") || argv.includes("ln ") || argv.startsWith("/bin/ln")) return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output(""), stderr: output("") } };
			if (argv.includes("npm install")) return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output(""), stderr: output("") } };
			return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: output(""), stderr: output("") } };
		}
	};
}

test("vendorDir nests per-CLI install root under the unified dir", () => {
	assert.equal(vendorDir("/managed", codex), "/managed/vendor/codex");
});

test("latestVersion queries npm view and returns the version", async () => {
	const spawn = fakeSpawn();
	const version = await latestVersion({ spawn, entry: codex });
	assert.equal(version, "0.150.0");
	assert.ok(spawn.calls.some((spec) => spec.argv.includes("view") && spec.argv.includes("@openai/codex")));
});

test("installManagedCli runs npm install into vendor and links the bin", async () => {
	const spawn = fakeSpawn();
	const result = await installManagedCli({ spawn, dir: "/managed", entry: codex });
	assert.equal(result.ok, true);
	assert.equal(result.version, "0.149.1");
	const installCall = spawn.calls.find((spec) => spec.argv && spec.argv.includes("install") && spec.argv.includes("--prefix"));
	assert.ok(installCall, "no npm install call; calls=" + JSON.stringify(spawn.calls.map((s) => s.argv.join(" "))));
	assert.ok(installCall.argv.includes("/managed/vendor/codex"));
	assert.ok(installCall.argv.includes("@openai/codex"));
	const linkCall = spawn.calls.find((spec) => spec.argv && spec.argv.includes("/bin/ln"));
	assert.ok(linkCall, "no ln call; calls=" + JSON.stringify(spawn.calls.map((s) => s.argv.join(" "))));
	assert.ok(linkCall.argv.includes("/managed/bin/codex"));
});

test("updateManagedCli reports no-update when already latest", async () => {
	const spawn = fakeSpawn({ version: "0.150.0" });
	const result = await updateManagedCli({ spawn, dir: "/managed", entry: codex });
	assert.equal(result.updated, false);
	assert.equal(result.message, "当前已是最新版本");
});

test("updateManagedCli installs when a newer version exists", async () => {
	const spawn = fakeSpawn({ version: "0.149.1" });
	const result = await updateManagedCli({ spawn, dir: "/managed", entry: codex });
	assert.equal(result.updated, true);
	assert.equal(result.latestVersion, "0.150.0");
});
