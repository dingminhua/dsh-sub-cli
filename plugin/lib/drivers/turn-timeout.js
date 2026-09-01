// Turn-timeout policy. Reaching the timeout used to reject the turn outright,
// discarding whatever the CLI emitted afterwards. That is wrong for long tasks:
// a turn can still be healthy when the deadline passes (slow model, cold start,
// a long tool loop). So on timeout the driver probes the child first and only
// rejects when the probe says the turn is genuinely stuck.
//
// The probe answers three questions with whatever the transport can observe:
//   1. Has the process already exited?          → the turn is over, wait for close.
//   2. Did it emit output recently?             → still working, extend the wait.
//   3. Nothing observed at all?                 → stuck, reject.
//
// Waiting on `done` is bounded: a child that exits settles it immediately, so
// the "already exited" path never costs the full grace period.

/** Default grace window granted to a turn that still looks alive, in ms. */
export const DEFAULT_PROBE_GRACE_MS = 60_000;

/**
 * Decide what to do when a turn hits its deadline.
 *
 * @param {object} options
 * @param {object} options.transport - the live subprocess line transport.
 * @param {number} options.elapsedMs - how long the turn has been running.
 * @param {number} [options.graceMs] - extra time granted to a live turn.
 * @returns {Promise<{stalled: boolean, reason: string, extendMs?: number}>}
 *   `stalled: true` means the caller should reject the turn; `stalled: false`
 *   means the turn looked alive and `extendMs` more time was granted.
 */
export async function probeStalledTurn({ transport, elapsedMs, graceMs = DEFAULT_PROBE_GRACE_MS }) {
	const handle = transport?.handle ?? null;

	// 1. The process already exited: the turn is over. Wait briefly for the
	//    transport to flush and close — that path delivers the real result (or
	//    the real exit error), which beats a synthetic timeout.
	if (handle?.done) {
		const outcome = await Promise.race([
			handle.done.then(() => "exited").catch(() => "exited"),
			wait(2_000).then(() => "pending")
		]);
		if (outcome === "exited") {
			return { stalled: false, reason: "process exited at the deadline; awaiting close", extendMs: 2_000 };
		}
		return { stalled: true, reason: `process did not settle after ${elapsedMs}ms` };
	}

	// 2. Still running: did it emit anything recently? A live CLI that keeps
	//    producing output is working, not stuck — grant it more time.
	const lastActivityAt = transport?.lastActivityAt ?? null;
	if (typeof lastActivityAt === "number") {
		const idleMs = Date.now() - lastActivityAt;
		if (idleMs < graceMs) {
			return { stalled: false, reason: `still emitting output (idle ${idleMs}ms)`, extendMs: graceMs };
		}
		return { stalled: true, reason: `no output for ${idleMs}ms (limit ${graceMs}ms)` };
	}

	// 3. No observable activity: treat it as stuck rather than waiting forever.
	return { stalled: true, reason: `no output observed within ${elapsedMs}ms` };
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
