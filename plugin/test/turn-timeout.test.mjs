import { test } from "node:test";
import assert from "node:assert/strict";
import { probeStalledTurn, watchTurnDeadline } from "../lib/drivers/turn-timeout.js";

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

// ── watchTurnDeadline: the repeated re-probe loop ─────────────────────────────

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise((r) => setImmediate(r));

test("watchTurnDeadline keeps granting windows to a chatty turn and never fails it", async () => {
	// A turn that reports "alive" on EVERY probe is healthy no matter how many
	// grace windows pass — the old single-extension logic killed it after the
	// second deadline; the loop must keep extending indefinitely.
	let probes = 0;
	const stopped = deferred();
	const cancel = watchTurnDeadline({
		probe: async () => {
			probes++;
			return { stalled: false, reason: "still emitting", extendMs: 5 };
		},
		onStalled: () => stopped.resolve("should not stall")
	});
	// Let several windows elapse.
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 12));
	cancel();
	assert.ok(probes >= 4, `probe ran repeatedly (${probes} times)`);
	assert.equal(await Promise.race([stopped.promise, Promise.resolve("ok")]), "ok", "never stalled a live turn");
});

test("watchTurnDeadline fails the turn only after a full silent window", async () => {
	// First probe: alive (short window). Second probe: silent → stalled.
	const verdicts = [
		{ stalled: false, reason: "still emitting", extendMs: 5 },
		{ stalled: true, reason: "no output for 60000ms" }
	];
	const stalled = deferred();
	let reasons;
	const cancel = watchTurnDeadline({
		probe: async () => verdicts.shift() ?? { stalled: true, reason: "no output" },
		onStalled: (reason) => { reasons = reason; stalled.resolve(reason); }
	});
	assert.match(await stalled.promise, /no output for/);
	cancel();
	assert.equal(reasons, "no output for 60000ms");
});

test("watchTurnDeadline stops probing once cancelled", async () => {
	let probes = 0;
	const cancel = watchTurnDeadline({
		probe: async () => { probes++; return { stalled: false, reason: "alive", extendMs: 5 }; },
		onStalled: () => {}
	});
	// Cancel synchronously, before the immediate first probe runs: no probe
	// may fire afterwards.
	cancel();
	for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 12));
	assert.equal(probes, 0, "the immediate first probe was cleared by cancel()");
});

test("watchTurnDeadline stops re-probing after cancel once a probe has run", async () => {
	let probes = 0;
	let resolveFirst;
	const firstProbeRan = new Promise((r) => { resolveFirst = r; });
	const cancel = watchTurnDeadline({
		probe: async () => {
			probes++;
			resolveFirst();
			return { stalled: false, reason: "alive", extendMs: 200 };
		},
		onStalled: () => {}
	});
	// Wait for the first probe to actually run (extendMs is generous, so the
	// second probe cannot race in), then cancel: the scheduled re-probe must
	// not fire.
	await firstProbeRan;
	const afterFirst = probes;
	cancel();
	for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 15));
	assert.equal(afterFirst, 1, "the first probe ran");
	assert.equal(probes, 1, "the scheduled re-probe was cleared by cancel()");
});

test("watchTurnDeadline surfaces probe errors as the stall reason", async () => {
	const stalled = deferred();
	const cancel = watchTurnDeadline({
		probe: async () => { throw new Error("transport vanished"); },
		onStalled: (reason) => stalled.resolve(reason)
	});
	assert.match(await stalled.promise, /transport vanished/);
	cancel();
});

test("watchTurnDeadline stops on an already-aborted signal without probing", async () => {
	let probes = 0;
	const controller = new AbortController();
	controller.abort();
	const cancel = watchTurnDeadline({
		probe: async () => { probes++; return { stalled: true, reason: "x" }; },
		onStalled: () => {},
		signal: controller.signal
	});
	cancel();
	await tick();
	assert.equal(probes, 0, "no probe runs when the signal already aborted");
});
