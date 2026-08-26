// Mark plain-JS class prototype methods as Typert Remote endpoints.
//
// The gateway only exposes methods carrying a `@Remote` marker (read via
// `remoteMethods`). The plugin host is plain JavaScript and cannot use
// decorator syntax, so we apply the marker by invoking the `Remote` decorator
// with a minimal decorator context that runs the initializer at apply time.
//
// @module dsh-sub-cli/remote

import { Remote } from "@deepseek-ai/dsh-typert-protocol";

/**
 * Mark each listed method name on `proto` as a Remote endpoint.
 * Idempotent: repeated marking of the same method name is a no-op.
 * @param proto - the class prototype to mark.
 * @param methods - method names to expose.
 */
export function markRemoteMethods(proto, methods) {
	for (const method of methods) {
		const context = {
			name: method,
			private: false,
			static: false,
			addInitializer: (initializer) => initializer.call(Object.create(proto))
		};
		Remote(method)(proto[method], context);
	}
}
