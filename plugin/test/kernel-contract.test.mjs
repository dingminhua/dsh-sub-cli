// Kernel-contract guards for the DSH kernel line this plugin ships against.
//
// Why this file exists (2026-09-10, research-6c81daa2): the DSH kernel jumped
// 0.1.2-rc.1 -> 0.1.5-rc.1 (bundled in DSH Desktop 2.0.9). That delta carried
// three public-interface breaks the family had to re-check by hand:
//   F1 session persistence became handle-based (locate/readRaw removed)
//   F2 session format moved to v3 behind a migration chain
//   F3 PERSONA_SECTION split into PERSONA_PREFIX_SECTION / PERSONA_SUFFIX_SECTION
//   F4 twelve packages lost exports; eighteen new packages appeared
//
// This plugin touches none of F1/F2, and F3 reaches it only through a REQUEST
// FIELD (`persona`), never a section constant. Those two facts are exactly what
// silently rot: the next kernel that renames the request field or drops the
// capability flag would leave the Relay guard/persona path broken at runtime
// while every other test still passed. So the contracts we depend on are
// asserted directly here against the INSTALLED kernel, not a fixture.
//
// If this file fails after a kernel bump, do NOT relax the assertion: re-read
// the new kernel's contract and adapt the plugin (see README "内核版本").

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Minimal semver comparison for the versions this guard cares about
// (x.y.z[-prerelease]). Deliberately dependency-free: adding `semver` as a
// devDependency just to validate three ranges would put a real install
// requirement between a contributor and this guard.
function parseVersion(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}
function cmp(a, b) {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	// A release outranks its own prereleases; otherwise compare prerelease
	// identifiers loosely (enough for 0.1.5-rc.1 vs 0.1.5-rc.2).
	if (a.pre === null && b.pre === null) return 0;
	if (a.pre === null) return 1;
	if (b.pre === null) return -1;
	const as = a.pre.split(".");
	const bs = b.pre.split(".");
	for (let i = 0; i < Math.max(as.length, bs.length); i++) {
		const x = as[i];
		const y = bs[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			if (+x !== +y) return +x - +y;
		} else if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}
/** Does `version` satisfy `range`? Supports the || / && / comparator subset we declare. */
function satisfies(version, range) {
	const v = parseVersion(version);
	if (!v) return false;
	return String(range)
		.split("||")
		.some((clause) =>
			clause
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.every((term) => {
					if (term.startsWith(">=")) {
						const t = parseVersion(term.slice(2));
						return t ? cmp(v, t) >= 0 : false;
					}
					if (term.startsWith("<=")) {
						const t = parseVersion(term.slice(2));
						return t ? cmp(v, t) <= 0 : false;
					}
					if (term.startsWith(">")) {
						const t = parseVersion(term.slice(1));
						return t ? cmp(v, t) > 0 : false;
					}
					if (term.startsWith("<")) {
						const t = parseVersion(term.slice(1));
						return t ? cmp(v, t) < 0 : false;
					}
					// Caret: a 0.x caret is confined to the same minor (npm: for
					// 0.x.y, ^0.x.y allows >=0.x.y <0.(x+1).0), which is exactly
					// what keeps our "^0.1.0-rc.6" clauses from admitting 0.2.0.
					if (term.startsWith("^")) {
						const t = parseVersion(term.slice(1));
						if (!t) return false;
						if (cmp(v, t) < 0) return false;
						return t.major === 0 ? v.minor === t.minor && v.major === 0 : v.major === t.major;
					}
					// Plain term: an exact version or a floor we must be at/above.
					const t = parseVersion(term);
					return t ? cmp(v, t) >= 0 : false;
				})
		);
}

// ── the four @deepseek-ai packages this plugin imports symbols from ──────────

test("kernel: the symbols we import still exist (dsh-tools / dsh-settings / dsh-typert-protocol)", async () => {
	const tools = await import("@deepseek-ai/dsh-tools");
	assert.equal(typeof tools.defineTool, "function", "dsh-tools must still export defineTool");

	const settings = await import("@deepseek-ai/dsh-settings");
	assert.equal(typeof settings.installSettingsSection, "function", "dsh-settings must still export installSettingsSection");
	assert.equal(typeof settings.settingsNamespace, "function", "dsh-settings must still export settingsNamespace");

	const typert = await import("@deepseek-ai/dsh-typert-protocol");
	assert.equal(typeof typert.Remote, "function", "dsh-typert-protocol must still export Remote");
	assert.equal(typeof typert.TypertRemoteService, "function", "dsh-typert-protocol must still export TypertRemoteService");
});

// ── F3: persona is a REQUEST FIELD, not a section constant ───────────────────

test("kernel F3: subagent request still carries `persona` as a plain string field", async () => {
	// The plugin passes `persona: relayPersonaFor(cli)` into startContinuable and
	// never imports PERSONA_*. That only works while the kernel keeps translating
	// the request field into its own (renamed) prompt section.
	let descriptor;
	try {
		descriptor = await import("@deepseek-ai/dsh-subagent/lib/types/descriptor.js");
	} catch {
		descriptor = undefined;
	}
	if (!descriptor?.snapshotSubagentDescriptor) {
		// The subpath is not part of the published export map on every kernel
		// line; the plugin-level contract test below still covers the behaviour.
		return;
	}
	const snap = descriptor.snapshotSubagentDescriptor({
		mode: "continuable",
		provider: "managed-claude-relay",
		label: "t",
		persona: "P",
		toolFilter: { allow: ["managed_cli_submit"] }
	});
	assert.equal(snap.persona, "P", "descriptor must round-trip the persona field");
	assert.deepEqual(snap.toolFilter, { allow: ["managed_cli_submit"] });
});

test("kernel F3: child composition maps the persona request field to the current section name", async () => {
	let childAgent;
	try {
		childAgent = await import("@deepseek-ai/dsh-subagent/lib/types/child-agent.js");
	} catch {
		childAgent = undefined;
	}
	if (!childAgent?.applyChildComposition) return;

	const sections = [];
	const restrictions = [];
	const childCtx = {
		get() {
			return undefined;
		},
		systemPrompt: {
			context() {},
			section(c) {
				sections.push(c);
			},
			getContextOrder() {
				return 0;
			},
			getSectionOrder() {
				return 0;
			}
		},
		tools: {
			restrict(f) {
				restrictions.push(f);
			}
		}
	};
	childAgent.applyChildComposition(childCtx, { ctx: undefined }, { persona: "PERSONA-TEXT", toolFilter: { allow: ["managed_cli_submit"] } });

	const personaSection = sections.find((s) => s.text === "PERSONA-TEXT");
	assert.ok(personaSection, "composition must install the persona text as a prompt section");
	// The name moved in F3 (deployment:persona -> deployment:persona-prefix).
	// Assert the SHAPE, so a future rename is reported here rather than at runtime.
	assert.match(personaSection.name, /^deployment:persona/, `unexpected persona section name: ${personaSection.name}`);
	assert.deepEqual(restrictions, [{ allow: ["managed_cli_submit"] }], "toolFilter must reach tools.restrict()");
});

// ── capability flags: the kernel rejects a request the provider cannot serve ──

test("kernel: relay providers still declare the capabilities startContinuable demands", async () => {
	const { ManagedCliRelayProvider } = await import("../lib/relay-provider.js");
	const provider = new ManagedCliRelayProvider({ name: "managed-codex-relay", cli: "codex", service: {} });
	assert.equal(provider.capabilities.persona, true, "relay sends persona, so the provider must advertise it");
	assert.equal(provider.capabilities.toolFilter, true, "relay sends toolFilter, so the provider must advertise it");
	// Codex app-server is a one-shot/no-persona provider; keep that honest too.
	const { capabilitiesOf } = await import("../lib/drivers/codex-provider.js").catch(() => ({}));
	if (capabilitiesOf) assert.equal(capabilitiesOf().persona, false);
});

// ── A4/A5: the declared kernel line must admit the shipped runtime ───────────

test("peer ranges admit the shipped kernel line and refuse the next major", () => {
	const pkg = require("../package.json");
	const shipped = ["0.1.5-rc.1", "0.1.5-rc.2"];

	assert.ok(pkg.peerDependencies, "package.json must declare peerDependencies for the kernel");
	for (const [name, range] of Object.entries(pkg.peerDependencies)) {
		for (const v of shipped) {
			assert.ok(
				satisfies(v, range),
				`peer range for ${name} must admit the shipped kernel ${v} (got ${range})`
			);
		}
		assert.ok(!satisfies("0.2.0", range), `peer range for ${name} must not admit 0.2.0 (got ${range})`);
	}
});

test("dev kernel dependency is a range on the shipped line, never an exact old pin", () => {
	const pkg = require("../package.json");
	const dev = pkg.devDependencies?.["@deepseek-ai/dsh-settings"];
	assert.ok(dev, "dsh-settings must stay a devDependency so tests resolve the real contract");
	// A5: an exact pin rots the moment the runtime moves (0.1.0-rc.6 was three
	// minor lines behind the shipped 0.1.5-rc.1 when this guard was written).
	assert.equal(parseVersion(dev), null, `dev kernel dependency must be a range, not an exact version (got ${dev})`);
	assert.ok(
		satisfies("0.1.5-rc.1", dev),
		`dev kernel dependency must admit the shipped kernel 0.1.5-rc.1 (got ${dev})`
	);
});

// ── F1/F2: this plugin deliberately does NOT read session logs ───────────────

test("F1/F2: the plugin never depends on removed session-persistence surface", async () => {
	const { readFileSync, readdirSync, statSync } = await import("node:fs");
	const path = await import("node:path");
	const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "lib");

	// The kernel removed locate/readRaw/DSH_SESSION_JSONL and versioned the log
	// format. A future contributor re-introducing a direct log read would quietly
	// re-couple this plugin to a version-sensitive surface; fail loudly instead.
	const banned = [/DSH_SESSION_JSONL/, /\.readRaw\s*\(/, /supportsRawArtifacts/, /\blocate\s*\(/, /SESSION_FORMAT_VERSION/];
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const full = path.join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry.endsWith(".js")) files.push(full);
		}
	};
	walk(root);

	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const pattern of banned) {
			assert.ok(!pattern.test(source), `${file} must not use removed session-persistence surface (${pattern})`);
		}
	}
});
