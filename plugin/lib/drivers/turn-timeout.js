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

/** Default grace window granted to a turn that still looks alive, in ms. */
export const DEFAULT_PROBE_GRACE_MS = 60_000;

/**
 * Whether a promise has ALREADY settled (fulfilled or rejected), without
 * awaiting it. A pending promise object is always truthy — testing the
 * object directly was the original bug: a live child's pending `done` read
 * as "exited", the activity check below became unreachable, and healthy
 * long turns were misjudged as stalled at their deadline. Only the SETTLED
 * state means "exited"; never the object's truthiness.
 *
 * probeStalledTurn is async and always called from a timer callback (one
 * macrotask AFTER any resolution), so an await-yield here flushes the
 * microtask queue first: mark flags set by an already-settled promise's
 * `.then` become visible, while a pending promise leaves them unset.
 */
async function isSettled(promise) {
	if (!promise || typeof promise.then !== "function") return false;
	let settled = false;
	const mark = () => { settled = true; };
	promise.then(mark, mark);
	await null; // flush microtasks: settled promises run mark synchronously here
	return settled;
}

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

	// 1. The process already exited (its done promise has settled): the turn
	//    is over. The close path will deliver the real result (or the real
	//    exit error), which beats a synthetic timeout, so grant it a moment.
	if (await isSettled(handle?.done)) {
		return { stalled: false, reason: "process exited at the deadline; awaiting close", extendMs: 2_000 };
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

/**
 * Repeatedly re-probe a live turn that has already hit its deadline, instead
 * of failing it once the first grace window lapses. A turn that keeps emitting
 * output (slow model, cold start, long tool loop) is healthy and deserves
 * another window every time; only a turn that goes SILENT for a full grace
 * window is judged stuck. The first probe runs immediately (the deadline has
 * already passed when this is called); each "still alive" verdict schedules
 * the next probe after the granted extendMs.
 *
 * @param {object} options
 * @param {() => Promise<{stalled: boolean, reason: string, extendMs?: number}>} options.probe
 *   Runs one staleness check; called once immediately and once per granted
 *   grace window thereafter.
 * @param {(reason: string) => void} options.onStalled
 *   Called exactly once when a probe reports the turn as genuinely stuck; the
 *   caller rejects the turn here.
 * @param {object} [options.signal] - optional AbortSignal that stops the loop
 *   (used when the turn settles by other means, e.g. the result event).
 * @returns {() => void} cancel - stops the watch loop; call when the turn
 *   settles normally.
 */
export function watchTurnDeadline({ probe, onStalled, signal }) {
	let stopped = false;
	let timer = null;
	const stop = () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	};
	const tick = () => {
		if (stopped) return;
		probe()
			.then((result) => {
				if (stopped) return;
				if (result.stalled) {
					stop();
					onStalled(result.reason);
					return;
				}
				// Ref'd on purpose: a pending re-probe is live work whose verdict
				// (stall detection) the caller is awaiting. Unref'ing it made the
				// loop drain whenever the transport held no other handle, so the
				// probe never ran and the awaited turn promise hung forever.
				// stop() clears this timer on every settle path.
				timer = setTimeout(tick, result.extendMs ?? DEFAULT_PROBE_GRACE_MS);
			})
			.catch((error) => {
				if (stopped) return;
				stop();
				onStalled(error instanceof Error ? error.message : String(error ?? "probe error"));
			});
	};
	if (signal) {
		if (signal.aborted) return () => {};
		signal.addEventListener("abort", stop, { once: true });
	}
	// The deadline has already passed when the caller invokes this: probe now.
	// Ref'd for the same reason as the re-probe timer above.
	timer = setTimeout(tick, 0);
	return stop;
}
