import { test } from "node:test";
import assert from "node:assert/strict";

// Regression: DSH Desktop previously failed during ESM import, which brought
// down the whole profile before the settings page could load.
test("host entry imports without evaluating unavailable schema methods or CommonJS globals", async () => {
	const plugin = await import(`../lib/index.js?host-import=${Date.now()}`);
	assert.equal(plugin.name, "dsh-sub-cli");
	assert.equal(typeof plugin.apply, "function");
	assert.deepEqual(plugin.inject, ["tools", "subprocess", "subagents", "approval"]);
});
