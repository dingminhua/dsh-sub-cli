// Managed CLI driver assembly. Each entry adapts one external CLI's protocol
// to the small, product-independent lifecycle defined by `./types.js`.
// `createManagedCliDrivers` returns a frozen map keyed by CLI id (codex,
// claude, qwen, …); callers register individual drivers explicitly so a
// missing transport / unused CLI never blocks the rest of the plugin.

import { CodexAppServerDriver } from "./codex-app-server.js";
import { CodexAppServerProvider, registerCodexAppServerProvider } from "./codex-provider.js";
import { createCodexSubprocessTransportFactory } from "./subprocess-transport.js";
import { ClaudeStreamJsonDriver } from "./claude-stream-json.js";
import { QwenStreamJsonDriver } from "./qwen-stream-json.js";
import { assertManagedCliDriver } from "./types.js";

export { CodexAppServerProvider, registerCodexAppServerProvider };
export { ClaudeStreamJsonDriver } from "./claude-stream-json.js";
export { QwenStreamJsonDriver } from "./qwen-stream-json.js";

/**
 * Assemble the managed CLI driver map. Each entry must pass the
 * `assertManagedCliDriver` contract; unknown or failing drivers throw at
 * construction time so the plugin fails fast instead of at first dispatch.
 *
 * @param {{
 *   subprocess: object,
 *   dirSource: () => string,
 *   prepare?: (cli: string, dir: string) => Promise<{ok:boolean, env?:object, reason?:string}>,
 *   drivers?: Record<string, object>
 * }} options
 *   `drivers` lets the caller inject non-default drivers (e.g. test fakes
 *   or future custom implementations) without changing this module.
 *   The default map registers Codex (app-server), Claude (subprocess +
 *   stream-json), and Qwen (subprocess + stream-json) when their binaries
 *   are present in the unified directory.
 */
export function createManagedCliDrivers({ subprocess, dirSource, prepare, drivers = {}, turnTimeoutSource = null }) {
	// Each CLI carries its own configured timeout (minutes). This factory only
	// wires the lookup through; the default lives in turn-timeout-policy.js.
	const timeoutMsFor = (cliId) => (typeof turnTimeoutSource === "function" ? turnTimeoutSource(cliId) : undefined);
	const map = { ...drivers };
	if (!map.codex) {
		map.codex = new CodexAppServerDriver({
			createTransport: createCodexSubprocessTransportFactory({ subprocess, dirSource, prepare }),
			turnTimeoutMs: timeoutMsFor("codex")
		});
	}
	if (!map.claude) {
		map.claude = new ClaudeStreamJsonDriver({ subprocess, dirSource, prepare, turnTimeoutMs: timeoutMsFor("claude") });
	}
	if (!map.qwen) {
		map.qwen = new QwenStreamJsonDriver({ subprocess, dirSource, prepare, turnTimeoutMs: timeoutMsFor("qwen") });
	}
	const ids = Object.keys(map);
	if (!ids.length) throw new TypeError("createManagedCliDrivers requires at least one driver");
	for (const id of ids) {
		try { assertManagedCliDriver(map[id]); } catch (e) {
			throw new TypeError(`driver "${id}" does not satisfy the managed CLI contract: ${e.message}`);
		}
	}
	return Object.freeze(Object.fromEntries(ids.map((id) => [id, map[id]])));
}

export function registerExperimentalCodexProvider(ctx, options) {
	const drivers = options?.drivers ?? createManagedCliDrivers({
		subprocess: ctx.subprocess,
		dirSource: options.dirSource,
		prepare: options.prepare
	});
	return registerCodexAppServerProvider(ctx, {
		name: options?.name ?? "managed-codex-app-server",
		driver: drivers.codex,
		routeSource: options?.routeSource,
		permissionSource: options?.permissionSource
	});
}
