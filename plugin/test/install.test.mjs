import { test } from "node:test";
import assert from "node:assert/strict";
import { installCommandOf, vendorDir } from "../lib/install.js";
import { CLI_REGISTRY } from "../lib/registry.js";

const codex = CLI_REGISTRY[0];

test("vendorDir nests per-CLI install root under the unified dir", () => {
	assert.equal(vendorDir("/managed", codex), "/managed/vendor/codex");
});

test("installCommandOf renders a copyable npm command scoped to the unified dir", () => {
	const command = installCommandOf(codex, "/managed");
	assert.match(command, /npm install/);
	assert.match(command, /@openai\/codex/);
	assert.match(command, /--prefix "\$DIR\/vendor\/codex"/);
	assert.match(command, /ln -sf .*"\$DIR\/bin\/codex"/);
	assert.match(command, /DIR="\/managed"/);
});

test("installCommandOf never installs globally or touches system config", () => {
	const claude = CLI_REGISTRY[1];
	const command = installCommandOf(claude, "/d");
	assert.ok(!/npm install -g/.test(command));
	assert.match(command, /--prefix "\$DIR\/vendor\/claude"/);
	assert.match(command, /@anthropic-ai\/claude-code/);
});
