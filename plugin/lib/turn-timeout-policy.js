// Shared turn-timeout policy. The drivers import the default from here so the
// value lives in exactly one place; `index.js` re-exports the same constants
// for the settings schema and the Web card.

/** Selectable turn timeouts, in minutes. */
export const TURN_TIMEOUT_MINUTE_CHOICES = Object.freeze([10, 20, 30]);

/** Default turn timeout in minutes. */
export const DEFAULT_TURN_TIMEOUT_MINUTES = 20;

/** Default turn timeout in milliseconds, as consumed by the drivers. */
export const DEFAULT_TURN_TIMEOUT_MS = DEFAULT_TURN_TIMEOUT_MINUTES * 60_000;

/**
 * Resolve one CLI's configured timeout to milliseconds.
 *
 * @param {unknown} minutes - the per-CLI setting (minutes).
 * @param {number} [fallbackMinutes] - used when the stored value is unusable.
 * @returns {number} milliseconds.
 */
export function turnTimeoutMs(minutes, fallbackMinutes = DEFAULT_TURN_TIMEOUT_MINUTES) {
	const value = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
		? minutes
		: fallbackMinutes;
	return Math.round(value * 60_000);
}

/**
 * Driver-side resolver: accept milliseconds straight through, but fall back to
 * the default when the caller passed nothing (`undefined` from an unset
 * per-CLI lookup) so `turnTimeoutMs ?? default` never needs repeating.
 *
 * @param {unknown} value - milliseconds, or undefined/null.
 * @returns {number} milliseconds.
 */
export function resolveTurnTimeoutMs(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_TURN_TIMEOUT_MS;
}
