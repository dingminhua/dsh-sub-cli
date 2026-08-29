// Managed CLI driver assembly. This is still an experimental internal face:
// current cli_* tools keep using the one-shot providers until real protocol
// verification proves the app-server path on the managed Codex version.

import { CodexAppServerDriver } from "./codex-app-server.js";
import { CodexAppServerProvider, registerCodexAppServerProvider } from "./codex-provider.js";
import { createCodexSubprocessTransportFactory } from "./subprocess-transport.js";
import { assertManagedCliDriver } from "./types.js";

export { CodexAppServerProvider, registerCodexAppServerProvider };

export function createManagedCliDrivers({ subprocess, dirSource, prepare }) {
	const codex = new CodexAppServerDriver({
		createTransport: createCodexSubprocessTransportFactory({ subprocess, dirSource, prepare })
	});
	assertManagedCliDriver(codex);
	return Object.freeze({ codex });
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
