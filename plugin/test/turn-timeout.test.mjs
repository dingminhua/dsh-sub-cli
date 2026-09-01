import { test } from "node:test";
import assert from "node:assert/strict";
import { probeStalledTurn } from "../lib/drivers/turn-timeout.js";

/** Minimal transport stand-in exposing only what the probe observes. */
function transport({ done = null, lastActivityAt = undefined } = {}) {
	return { handle: done ? { done } : null, lastActivityAt };
}

test("a turn still emitting output is extended, not failed", async () => {
	// Alive with recent output: the driver grants more time.
	const probe = await probeStalledTurn({
		transport: transport({ lastActivityAt: Date.now() - 1_000 }),
		elapsedMs: 1_200_000,
		graceMs: 60_000
	});
	assert.equal(probe.stalled, false);
	assert.equal(probe.extendMs, 60_000);
	assert.match(probe.reason, /still emitting output/);
});

test("a process that already exited is left to the close handler", async () => {
	// Exited: waiting briefly lets the transport deliver the real result (or the
	// real exit error) instead of a synthetic timeout.
	const probe = await probeStalledTurn({
		transport: transport({ done: Promise.resolve({ exitCode: 0 }) }),
		elapsedMs: 1_200_000
	});
	assert.equal(probe.stalled, false);
	assert.match(probe.reason, /exited at the deadline/);
});

test("a live process that has gone quiet long enough is stalled", async () => {
	const probe = await probeStalledTurn({
		transport: transport({ lastActivityAt: Date.now() - 300_000 }),
		elapsedMs: 1_200_000,
		graceMs: 60_000
	});
	assert.equal(probe.stalled, true);
	assert.match(probe.reason, /no output for/);
});

test("no observable activity at all counts as stuck", async () => {
	const probe = await probeStalledTurn({
		transport: transport({}),
		elapsedMs: 1_200_000
	});
	assert.equal(probe.stalled, true);
	assert.match(probe.reason, /no output observed/);
});

test("a pending done with no observable activity is stalled (not 'awaiting exit')", async () => {
	// Regression guard for the original bug: `handle?.done` (a promise object)
	// is ALWAYS truthy, so a live child's pending `done` used to read as
	// "exited at the deadline; awaiting close" and misjudge healthy long turns.
	// The new contract: a pending `done` means "still running"; only a SETTLED
	// promise counts as exited, and a silent pending child is judged by its
	// lack of output.
	const probe = await probeStalledTurn({
		transport: transport({ done: new Promise(() => {}) }),
		elapsedMs: 1_200_000
	});
	assert.equal(probe.stalled, true);
	assert.match(probe.reason, /no output observed/);
});

test("a rejected process exit is not treated as success", async () => {
	// A crash still settles `done`, so the close handler carries the real error.
	const probe = await probeStalledTurn({
		transport: transport({ done: Promise.reject(new Error("subprocess exited 1")) }),
		elapsedMs: 1_200_000
	});
	assert.equal(probe.stalled, false, "an exited process is handed to the close path, which surfaces the error");
});
