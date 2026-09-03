import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DIR_LABEL, expandTilde, resolveDir, binPath, configDirPath, envFor, managedNames, binName } from "../lib/paths.js";
import { CLI_REGISTRY } from "../lib/registry.js";

test("expandTilde resolves ~ and ~/ to the real home dir", () => {
	assert.equal(expandTilde("~"), os.homedir());
	assert.equal(expandTilde("~/x"), path.join(os.homedir(), "x"));
	assert.equal(expandTilde("/abs/path"), "/abs/path");
});

test("resolveDir uses cliDir when set, else expands the default to $HOME", () => {
	assert.equal(resolveDir({ cliDir: "/custom/dir" }), "/custom/dir");
	assert.equal(resolveDir({}), path.join(os.homedir(), "dsh-clis"));
	const home = os.homedir();
	assert.equal(resolveDir({ cliDir: "~/x" }), path.join(home, "x"));
});

test("binName appends .cmd on Windows, bare otherwise", () => {
	assert.equal(binName("codex", "darwin"), "codex");
	assert.equal(binName("codex", "win32"), "codex.cmd");
});

test("binPath and configDirPath build the unified layout", () => {
	// Construct expectations with path.join so they hold on both POSIX and
	// Windows (path.join yields "\" on win32). Never hardcode "/" separators.
	assert.equal(binPath("/d", "codex", "darwin"), path.join("/d", "bin", "codex"));
	assert.equal(binPath("/d", "codex", "win32"), path.join("/d", "bin", "codex.cmd"));
	assert.equal(configDirPath("/d", "config-codex"), path.join("/d", "config-codex"));
});

test("managedNames = bin + every config dir", () => {
	assert.deepEqual(managedNames(CLI_REGISTRY), ["bin", "config-codex", "config-claude"]);
});

test("envFor points the CLI config-env at its isolated dir", () => {
	const codex = CLI_REGISTRY.find((e) => e.id === "codex");
	const env = envFor(codex, "/d");
	// configDirPath uses path.join (platform separator); mirror it.
	assert.equal(env.CODEX_HOME, path.join("/d", "config-codex"));
	assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});
