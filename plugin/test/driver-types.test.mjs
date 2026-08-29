import assert from "node:assert/strict";
import test from "node:test";

import {
	EMPTY_DRIVER_CAPABILITIES,
	assertManagedCliDriver,
	createRunState,
	defineDriverCapabilities
} from "../lib/drivers/types.js";

test("defineDriverCapabilities fills explicit false defaults", () => {
	const value = defineDriverCapabilities({ streaming: true, interrupt: true });
	assert.equal(value.streaming, true);
	assert.equal(value.interrupt, true);
	assert.equal(value.continuable, false);
	assert.deepEqual(Object.keys(value), Object.keys(EMPTY_DRIVER_CAPABILITIES));
	assert.throws(() => defineDriverCapabilities({ imaginary: true }), /unknown managed CLI driver capabilities/);
});

test("assertManagedCliDriver rejects incomplete drivers", () => {
	assert.throws(() => assertManagedCliDriver({ id: "x", capabilities: {}, start() {} }), /capability streaming/);
	const driver = { id: "x", capabilities: defineDriverCapabilities(), start() {} };
	assert.equal(assertManagedCliDriver(driver), driver);
});

test("createRunState exposes lossless state snapshots", () => {
	const state = createRunState("queued");
	const first = state.snapshot();
	assert.equal(first.state, "queued");
	assert.equal(first.detail, null);
	assert.equal(typeof first.updatedAt, "number");
	const next = state.transition("running", "started");
	assert.equal(next.state, "running");
	assert.equal(next.detail, "started");
	assert.throws(() => state.transition("mystery"), /invalid managed CLI run state/);
});
