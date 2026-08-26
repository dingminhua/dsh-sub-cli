// Managed-CLI install: executable helper (for the model-facing `cli_install`
// tool) plus a copyable command (for the settings card reference). Both install
// the official npm package into the unified dir's vendor subdirectory (never
// globally) and link/point the exposed bin into <dir>/bin/<bin>.

import path from "node:path";
import { binPath } from "./paths.js";
import { winShimArgv } from "./dispatch.js";

export const PLATFORM = process.platform;

/** The vendor install root for one CLI, inside the unified dir. */
export function vendorDir(dir, entry) {
	return path.join(dir, "vendor", entry.id);
}

function posixCommand(entry, dir) {
	return [
		`DIR=${JSON.stringify(dir)}`,
		`mkdir -p "$DIR/bin" "$DIR/vendor/${entry.id}"`,
		`npm install --prefix "$DIR/vendor/${entry.id}" --no-save --no-audit --no-fund ${entry.npm}`,
		`ln -sf "$DIR/vendor/${entry.id}/node_modules/.bin/${entry.bin}" "$DIR/bin/${entry.bin}"`
	].join("\n");
}

function windowsCommand(entry, dir) {
	return [
		`$DIR = '${dir}'`,
		`New-Item -ItemType Directory -Force -Path "$DIR\\bin", "$DIR\\vendor\\${entry.id}" | Out-Null`,
		`npm install --prefix "$DIR\\vendor\\${entry.id}" --no-save --no-audit --no-fund ${entry.npm}`,
		`Remove-Item -Force "$DIR\\bin\\${entry.bin}.cmd" -ErrorAction SilentlyContinue`,
		`Copy-Item "$DIR\\vendor\\${entry.id}\\node_modules\\.bin\\${entry.bin}.cmd" "$DIR\\bin\\${entry.bin}.cmd"`
	].join("\n");
}

/** Render the copyable install (or update) command for one CLI. */
export function installCommandOf(entry, dir) {
	return PLATFORM === "win32" ? windowsCommand(entry, dir) : posixCommand(entry, dir);
}

function output(handle, which = "stdout") {
	return handle.collected && handle.collected[which] ? handle.collected[which].readFrom(0).text : "";
}

async function run(spawn, argv, signal) {
	const handle = spawn.spawn({
		argv,
		cwd: ".",
		signal,
		stdio: { stdin: "ignore", stdout: { maxBytes: 100000 }, stderr: { maxBytes: 100000 } },
		graceMs: 120000
	});
	const outcome = await handle.done;
	return { exitCode: outcome.exitCode, stdout: output(handle), stderr: output(handle, "stderr") };
}

async function runNpm(spawn, args, signal) {
	const npm = await spawn.resolveExecutable("npm", undefined, signal).catch(() => "npm");
	return run(spawn, winShimArgv(npm, args, PLATFORM), signal);
}

/**
 * Install (or update) one managed CLI into the unified dir and link its bin.
 * @returns {{ ok: boolean, version: string | null, message: string }}
 */
export async function installManagedCli({ spawn, dir, entry, signal }) {
	const vendor = vendorDir(dir, entry);
	const install = await runNpm(spawn, ["install", "--prefix", vendor, "--no-save", "--no-audit", "--no-fund", entry.npm], signal);
	if (install.exitCode !== 0) return { ok: false, version: null, message: `npm 安装 ${entry.npm} 失败：${install.stderr.trim() || `exit ${install.exitCode}`}` };
	await linkBin({ spawn, dir, entry, vendor, signal });
	const bin = binPath(dir, entry.bin, PLATFORM);
	const resolved = await spawn.resolveExecutable(bin, undefined, signal).catch(() => null);
	let version = null;
	if (resolved) {
		const v = await run(spawn, winShimArgv(resolved, ["--version"], PLATFORM), signal);
		version = (v.stdout || "").trim().split("\n")[0] || null;
	}
	return { ok: true, version, message: "" };
}

async function linkBin({ spawn, dir, entry, vendor, signal }) {
	if (PLATFORM === "win32") {
		const source = path.join(vendor, "node_modules", ".bin", `${entry.bin}.cmd`);
		const target = binPath(dir, entry.bin, "win32");
		const handle = spawn.spawn({
			argv: ["cmd.exe", "/d", "/s", "/c", "copy", "/y", source, target],
			cwd: dir,
			signal,
			stdio: { stdin: "ignore", stdout: { maxBytes: 20000 }, stderr: { maxBytes: 20000 } },
			graceMs: 20000
		});
		await handle.done;
	} else {
		const source = path.join(vendor, "node_modules", ".bin", entry.bin);
		const target = binPath(dir, entry.bin, "darwin");
		await run(spawn, ["/bin/ln", "-sf", source, target], signal);
	}
}
