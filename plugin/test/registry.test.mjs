import { test } from "node:test";
import assert from "node:assert/strict";
import { CLI_REGISTRY, cliById } from "../lib/registry.js";

test("registry exposes the three managed CLIs", () => {
	assert.equal(CLI_REGISTRY.length, 3);
	const ids = CLI_REGISTRY.map((e) => e.id).sort();
	assert.deepEqual(ids, ["claude", "codex", "qwen"]);
});

test("cliById resolves known ids and returns null for unknown", () => {
	assert.equal(cliById("codex").bin, "codex");
	assert.equal(cliById("claude").env, "CLAUDE_CONFIG_DIR");
	assert.equal(cliById("qwen").env, "QWEN_HOME");
	assert.equal(cliById("nope"), null);
});

test("argv templates are shell-safe arrays; codex uses -m for model", () => {
	const codex = cliById("codex");
	const args = codex.argv("do the task", "gpt-5");
	assert.ok(Array.isArray(args));
	assert.ok(args.includes("do the task"));
	assert.ok(args.includes("-m"));
	assert.ok(args.includes("gpt-5"));
});

test("argv without model omits the model flag (default permission is now read-only)", () => {
	const claude = cliById("claude");
	// The default tier changed to read-only (only read checked), so an unset
	// permission now maps to Claude's plan mode.
	assert.deepEqual(claude.argv("hi", ""), ["-p", "--output-format", "text", "--permission-mode", "plan", "hi"]);
});

test("permission tier maps into each CLI's argv", () => {
	const codex = cliById("codex");
	assert.deepEqual(codex.argv("t", "", "read-only"), ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "t"]);
	assert.deepEqual(codex.argv("t", "", "workspace-write"), ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "t"]);
	assert.deepEqual(codex.argv("t", "", "danger-full-access"), ["exec", "--json", "--skip-git-repo-check", "-s", "danger-full-access", "t"]);
	const claude = cliById("claude");
	assert.deepEqual(claude.argv("t", "", "read-only").includes("--permission-mode", "plan"), true);
	assert.ok(claude.argv("t", "", "read-only").includes("plan"));
	assert.ok(claude.argv("t", "", "workspace-write").includes("acceptEdits"));
	assert.ok(claude.argv("t", "", "danger-full-access").includes("bypassPermissions"));
	const qwen = cliById("qwen");
	// Qwen carries no CLI-side permission flag (boolean --sandbox needs
	// docker/podman and dies silently on stock machines); every tier launches
	// the same shape and enforcement stays at the driver layer.
	assert.deepEqual(qwen.argv("t", "", "read-only"), ["--prompt", "t"]);
	assert.deepEqual(qwen.argv("t", "", "workspace-write"), ["--prompt", "t"]);
	assert.deepEqual(qwen.argv("t", "", "danger-full-access"), ["--prompt", "t"]);
	// Unknown tier falls back to the default (read-only) — still no flag.
	assert.deepEqual(qwen.argv("t", "", "bogus"), ["--prompt", "t"]);
});

test("headless argv includes unattended flags so codex never prompts for a TTY", () => {
	const codex = cliById("codex");
	const args = codex.argv("task", "");
	assert.ok(args.includes("--skip-git-repo-check"));
	assert.ok(args.includes("-s"));
	assert.ok(args.includes("read-only"));
	const claude = cliById("claude");
	assert.ok(claude.argv("task", "").includes("--permission-mode"));
});

test("qwen uses --prompt for headless task and --model for model", () => {
	const qwen = cliById("qwen");
	assert.deepEqual(qwen.argv("check", "qwen-max", "workspace-write"), ["--model", "qwen-max", "--prompt", "check"]);
	assert.deepEqual(qwen.argv("check", "", "workspace-write"), ["--prompt", "check"]);
});

// ── Generalized argv matrix across every CLI ─────────────────────────────────
// The same permission value must derive the same coarse tier for codex, claude
// and qwen, and each CLI's argv template must reflect that tier in its own
// flag. One table drives all three so a derivation regression (e.g. network
// no longer escalating to danger-full-access) is caught for every CLI at once.

const CLAUDE_MODE_BY_TIER = {
	"read-only": "plan",
	"workspace-write": "acceptEdits",
	"danger-full-access": "bypassPermissions"
};

const ARGV_PERMISSION_CASES = [
	{ label: "legacy read-only", permission: "read-only", tier: "read-only" },
	{ label: "legacy workspace-write", permission: "workspace-write", tier: "workspace-write" },
	{ label: "legacy danger-full-access", permission: "danger-full-access", tier: "danger-full-access" },
	{ label: "unknown string falls back to default (read-only)", permission: "bogus", tier: "read-only" },
	{ label: "missing permission defaults to read-only", permission: undefined, tier: "read-only" },
	{ label: "exec escalates to full access (egress intent)", permission: { read: true, write: false, exec: true, approval: "ask" }, tier: "danger-full-access" },
	{ label: "legacy network:true migrates to exec and escalates", permission: { read: true, write: false, exec: false, network: true, approval: "ask" }, tier: "danger-full-access" },
	{ label: "exec plus legacy network stays full access", permission: { read: true, write: false, exec: true, network: true, approval: "ask" }, tier: "danger-full-access" },
	{ label: "write without exec stays workspace-write", permission: { read: true, write: true, exec: false, network: false, approval: "ask" }, tier: "workspace-write" },
	{ label: "read-only profile stays read-only", permission: { read: true, write: false, exec: false, network: false, approval: "ask" }, tier: "read-only" }
];

test("every permission value derives the same coarse tier across all three CLIs", () => {
	for (const c of ARGV_PERMISSION_CASES) {
		const codex = cliById("codex").argv("t", "", c.permission);
		const claude = cliById("claude").argv("t", "", c.permission);
		const qwen = cliById("qwen").argv("t", "", c.permission);
		const label = `${c.label} (${JSON.stringify(c.permission)})`;
		// Codex: explicit -s <tier>.
		assert.ok(codex.includes("-s") && codex.includes(c.tier), `codex ${label}`);
		// Claude: --permission-mode mapped from the tier.
		assert.ok(claude.includes("--permission-mode") && claude.includes(CLAUDE_MODE_BY_TIER[c.tier]), `claude ${label}`);
		// Qwen: no --sandbox at any tier (docker-dependent, dies silently on
		// stock machines); enforcement is the driver layer's job.
		assert.equal(qwen.includes("--sandbox"), false, `qwen ${label}`);
	}
});

test("codex -s flag carries exactly the derived tier (position-sensitive)", () => {
	for (const c of ARGV_PERMISSION_CASES) {
		const args = cliById("codex").argv("t", "", c.permission);
		const at = args.indexOf("-s");
		assert.ok(at !== -1 && args[at + 1] === c.tier, `${c.label} → ${JSON.stringify(args)}`);
	}
});

test("claude permission-mode flag carries exactly the derived tier", () => {
	for (const c of ARGV_PERMISSION_CASES) {
		const args = cliById("claude").argv("t", "", c.permission);
		const at = args.indexOf("--permission-mode");
		assert.ok(at !== -1 && args[at + 1] === CLAUDE_MODE_BY_TIER[c.tier], `${c.label} → ${JSON.stringify(args)}`);
	}
});
