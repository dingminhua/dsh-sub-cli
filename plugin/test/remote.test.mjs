import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteMethods, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { markRemoteMethods } from "../lib/remote.js";

function mockContext() {
	return { reflect: { provide: () => {} } };
}

class CliSvc extends TypertRemoteService {
	constructor(ctx, key) {
		super(ctx, key);
		markRemoteMethods(CliSvc.prototype, ["check", "install", "update"]);
	}
	check() { return "c"; }
	install() { return "i"; }
	update() { return "u"; }
	other() { return "o"; }
}

test("markRemoteMethods exposes only marked methods via remoteMethods", () => {
	const svc = new CliSvc(mockContext(), "cli");
	const exposed = remoteMethods(svc).map((entry) => entry.method);
	assert.deepEqual(exposed, ["check", "install", "update"]);
	assert.ok(!exposed.includes("other"));
});

test("markRemoteMethods is idempotent", () => {
	const proto = CliSvc.prototype;
	markRemoteMethods(proto, ["check"]);
	const svc = new CliSvc(mockContext(), "cli");
	// Re-mark does not throw or duplicate; only unique markers survive.
	assert.deepEqual(remoteMethods(svc).map((entry) => entry.method), ["check", "install", "update"]);
});
