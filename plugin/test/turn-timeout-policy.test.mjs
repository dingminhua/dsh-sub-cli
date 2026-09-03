import { test } from "node:test";
import assert from "node:assert/strict";
import {
	TURN_TIMEOUT_MINUTE_CHOICES,
	DEFAULT_TURN_TIMEOUT_MINUTES,
	DEFAULT_TURN_TIMEOUT_MS,
	turnTimeoutMs,
	resolveTurnTimeoutMs
} from "../lib/turn-timeout-policy.js";

test("offers 3/5/10 minutes and defaults to 5", () => {
	assert.deepEqual([...TURN_TIMEOUT_MINUTE_CHOICES], [3, 5, 10]);
	assert.equal(DEFAULT_TURN_TIMEOUT_MINUTES, 5);
	assert.equal(DEFAULT_TURN_TIMEOUT_MS, 5 * 60_000);
});

test("minutes convert to milliseconds", () => {
	assert.equal(turnTimeoutMs(3), 180_000);
	assert.equal(turnTimeoutMs(5), 300_000);
	assert.equal(turnTimeoutMs(10), 600_000);
});

test("an unusable configured value falls back to the default", () => {
	for (const bad of [undefined, null, 0, -5, Number.NaN, "20", {}]) {
		assert.equal(turnTimeoutMs(bad), DEFAULT_TURN_TIMEOUT_MS, `value ${String(bad)} must fall back`);
	}
});

test("drivers resolve an unset per-CLI lookup to the default", () => {
	// The factory passes undefined when a CLI has no configured value.
	for (const unset of [undefined, null, 0, -1, Number.NaN]) {
		assert.equal(resolveTurnTimeoutMs(unset), DEFAULT_TURN_TIMEOUT_MS);
	}
	assert.equal(resolveTurnTimeoutMs(60_000), 60_000, "an explicit value passes through");
});
