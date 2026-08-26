import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { DEFAULT_DIR_LABEL, expandTilde, resolveDir, binPath, configDirPath, envFor, managedNames } from "../lib/paths.js";
import { CLI_REGISTRY } from "../lib/registry.js";

test("expandTilde resolves ~ and ~/ to the real home dir", () => {
	assert.equal(expandTilde("~"), os.homedir());
	assert.equal(expandTilde("~/x"), os.homedir() + "/x");
	assert.equal(expandTilde("/abs/path"), "/abs/path");
});

test("resolveDir uses cliDir when set, else expands the default to $HOME", () => {
	assert.equal(resolveDir({ cliDir: "/custom/dir" }), "/custom/dir");
	// When no cliDir is set, the default "~/dsh-clis" is expanded to the real home dir.
	assert.equal(resolveDir({}), os.homedir() + "/dsh-clis");
	const home = os.homedir();
	assert.equal(resolveDir({ cliDir: "~/x" }), home + "/x");
});

test("binPath and configDirPath build the unified layout", () => {
	assert.equal(binPath("/d", "codex"), "/d/bin/codex");
	assert.equal(configDirPath("/d", "config-codex"), "/d/config-codex");
});

test("managedNames = bin + every config dir", () => {
	assert.deepEqual(managedNames(CLI_REGISTRY), ["bin", "config-codex", "config-claude", "config-qwen"]);
});

test("envFor points the CLI config-env at its isolated dir", () => {
	const codex = CLI_REGISTRY.find((e) => e.id === "codex");
	const env = envFor(codex, "/d");
	assert.equal(env.CODEX_HOME, "/d/config-codex");
	assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});
