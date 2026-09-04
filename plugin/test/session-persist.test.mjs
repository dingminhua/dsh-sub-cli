import assert from "node:assert/strict";
import test from "node:test";

import { __createSessionPersistForTests as createSessionPersist } from "../lib/index.js";

// Regression (2026-09-05, Windows): createSessionPersist used to capture
// ctx.get("fs") once at apply time. `fs` is deliberately NOT in inject (the
// plugin must boot on fs-less deployments), so the capture raced service
// startup — when it lost, every load() and save() for the rest of the process
// lifetime was a silent no-op: dispatches ran, sessions.json never appeared,
// and no session survived a host restart. The service must be resolved per
// call instead.
test("createSessionPersist resolves the fs service per call, not at wiring time", async () => {
	let fsService = null;
	const ctx = { get: (id) => (id === "fs" ? fsService : undefined) };
	const persist = createSessionPersist(ctx, () => "/unified/dir");

	// 1. fs absent at wiring time: load falls back to [] without throwing.
	assert.deepEqual(await persist.load(), []);

	// 2. the service appears later: save writes through it.
	const writes = [];
	fsService = {
		async resolve(p) { return p; },
		async readText() { throw new Error("no file yet"); },
		async writeText(target, content) { writes.push({ target, content }); }
	};
	await persist.save([{ sessionId: "cli-codex-x", cli: "codex" }]);
	assert.equal(writes.length, 1);
	assert.match(writes[0].target, /sessions\.json$/);
	assert.match(writes[0].content, /cli-codex-x/);

	// 3. load now reads through the live service.
	fsService = {
		async resolve(p) { return p; },
		async readText() { return JSON.stringify({ version: 1, sessions: [{ sessionId: "cli-codex-x", cli: "codex", remoteSessionId: "thread-x" }] }); }
	};
	const restored = await persist.load();
	assert.equal(restored.length, 1);
	assert.equal(restored[0].remoteSessionId, "thread-x");

	// 4. the service disappears again: both seams degrade silently.
	fsService = null;
	await persist.save([{ sessionId: "cli-codex-y" }]);
	assert.deepEqual(await persist.load(), []);
});
