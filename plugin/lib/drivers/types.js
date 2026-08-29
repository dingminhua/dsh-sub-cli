// Internal managed-CLI driver contract. Drivers adapt one external CLI protocol
// to a small, product-independent lifecycle. This module deliberately has no
// DSH imports so protocol drivers can be tested with fake processes offline.

export const MANAGED_CLI_RUN_STATES = Object.freeze([
	"queued",
	"starting",
	"running",
	"awaiting_permission",
	"completed",
	"failed",
	"cancelled"
]);

export const EMPTY_DRIVER_CAPABILITIES = Object.freeze({
	streaming: false,
	continuable: false,
	durableResume: false,
	interactivePermissions: false,
	structuredOutput: false,
	modelOverride: false,
	reasoningEffort: false,
	cwd: false,
	interrupt: false
});

export function defineDriverCapabilities(overrides = {}) {
	const unknown = Object.keys(overrides).filter((key) => !(key in EMPTY_DRIVER_CAPABILITIES));
	if (unknown.length) throw new Error(`unknown managed CLI driver capabilities: ${unknown.join(", ")}`);
	const value = {};
	for (const key of Object.keys(EMPTY_DRIVER_CAPABILITIES)) value[key] = overrides[key] === true;
	return Object.freeze(value);
}

export function assertManagedCliDriver(driver) {
	if (!driver || typeof driver !== "object") throw new TypeError("managed CLI driver must be an object");
	if (typeof driver.id !== "string" || !driver.id.trim()) throw new TypeError("managed CLI driver id must be non-empty");
	if (!driver.capabilities || typeof driver.capabilities !== "object") throw new TypeError(`managed CLI driver ${driver.id} must declare capabilities`);
	for (const key of Object.keys(EMPTY_DRIVER_CAPABILITIES)) {
		if (typeof driver.capabilities[key] !== "boolean") throw new TypeError(`managed CLI driver ${driver.id} capability ${key} must be boolean`);
	}
	if (typeof driver.start !== "function") throw new TypeError(`managed CLI driver ${driver.id} must implement start(request)`);
	return driver;
}

export function createRunState(initial = "queued") {
	if (!MANAGED_CLI_RUN_STATES.includes(initial)) throw new Error(`invalid managed CLI run state ${initial}`);
	let state = initial;
	let detail = null;
	let updatedAt = Date.now();
	return {
		get state() { return state; },
		get detail() { return detail; },
		get updatedAt() { return updatedAt; },
		transition(next, nextDetail = null) {
			if (!MANAGED_CLI_RUN_STATES.includes(next)) throw new Error(`invalid managed CLI run state ${next}`);
			state = next;
			detail = nextDetail;
			updatedAt = Date.now();
			return this.snapshot();
		},
		snapshot() { return { state, detail, updatedAt }; }
	};
}
