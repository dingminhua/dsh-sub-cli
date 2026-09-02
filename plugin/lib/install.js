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
	// Render a PowerShell script that installs the package, then writes a
	// self-contained wrapper .cmd pointing at the real JS entry by absolute
	// path. Copying npm's shim is wrong: it resolves the JS relatively from
	// %~dp0 and breaks once moved out of node_modules/.bin. The wrapper reads
	// the package.json bin field so the path is authoritative.
	const pkgRoot = `$DIR\\vendor\\${entry.id}\\node_modules\\${entry.npm.split("/").join("\\")}`;
	return [
		`$DIR = '${dir}'`,
		`New-Item -ItemType Directory -Force -Path "$DIR\\bin", "$DIR\\vendor\\${entry.id}" | Out-Null`,
		// Use npm.cmd, not npm: on systems with a restrictive execution policy the
		// npm.ps1 shim is blocked ("running scripts is disabled"), while npm.cmd runs.
		`npm.cmd install --prefix "$DIR\\vendor\\${entry.id}" --no-save --no-audit --no-fund ${entry.npm}`,
		`$pkg = Get-Content "${pkgRoot}\\package.json" -Raw | ConvertFrom-Json`,
		`$rel = if ($pkg.bin -is [string]) { $pkg.bin } else { $pkg.bin.${entry.bin} }`,
		`$js = Join-Path "${pkgRoot}" $rel`,
		// Build the .cmd body in PowerShell with [char]13/[char]10 so no JS
		// template-literal backtick escaping collides with PowerShell's `r`n.
		// A native .exe entry runs directly; a .js entry runs through node.
		'$crlf = [char]13 + [char]10',
		'$line = if ($js -match "\\.exe$") { "`"$js`" %*" } else { "node `"$js`" %*" }',
		'$body = "@ECHO off" + $crlf + $line + $crlf',
		`Set-Content -Path "$DIR\\bin\\${entry.bin}.cmd" -Value $body -NoNewline -Encoding ASCII`
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
	// On Windows prefer npm.cmd: the npm.ps1 shim is blocked by a restrictive
	// execution policy, and resolving "npm" yields npm.ps1 / npm shell script
	// which cannot run under cmd.exe /c. npm.cmd is a real batch file.
	const candidates = PLATFORM === "win32" ? ["npm.cmd", "npm"] : ["npm"];
	let npm = PLATFORM === "win32" ? "npm.cmd" : "npm";
	for (const name of candidates) {
		const resolved = await spawn.resolveExecutable(name, undefined, signal).catch(() => null);
		if (resolved) { npm = resolved; break; }
	}
	return run(spawn, winShimArgv(npm, args, PLATFORM), signal);
}

/**
 * Install (or update) one managed CLI into the unified dir and link its bin.
 * @returns {{ ok: boolean, version: string | null, message: string }}
 */
export async function installManagedCli({ spawn, fs, dir, entry, signal }) {
	const vendor = vendorDir(dir, entry);
	// Windows links the bin by writing a wrapper .cmd via the fs service; it must
	// be present (mirrors removeManagedCli's explicit fs guard in index.js).
	if (PLATFORM === "win32" && (!fs || typeof fs.resolve !== "function" || typeof fs.writeText !== "function")) {
		return { ok: false, version: null, message: "当前 DSH 文件服务不支持写 CLI 包装脚本，无法在 Windows 完成安装。" };
	}
	const install = await runNpm(spawn, ["install", "--prefix", vendor, "--no-save", "--no-audit", "--no-fund", entry.npm], signal);
	if (install.exitCode !== 0) return { ok: false, version: null, message: `npm 安装 ${entry.npm} 失败：${install.stderr.trim() || `exit ${install.exitCode}`}` };
	await linkBin({ spawn, fs, dir, entry, vendor, signal });
	const bin = binPath(dir, entry.bin, PLATFORM);
	const resolved = await spawn.resolveExecutable(bin, undefined, signal).catch(() => null);
	let version = null;
	if (resolved) {
		const v = await run(spawn, winShimArgv(resolved, ["--version"], PLATFORM), signal);
		version = (v.stdout || "").trim().split("\n")[0] || null;
	}
	return { ok: true, version, message: "" };
}

/**
 * Resolve the real JS entry for one CLI's bin from the installed package.json.
 * npm's bin field may be a string or an object { name: path }; resolve it to an
 * absolute path so the wrapper shim does not depend on %~dp0-relative
 * resolution (which breaks when a .cmd is copied out of node_modules/.bin).
 */
async function resolvePackageBinEntry({ fs, vendor, entry }) {
	const pkgRoot = path.join(vendor, "node_modules", ...entry.npm.split("/"));
	const target = await fs.resolve(path.join(pkgRoot, "package.json"), {}, undefined);
	const pkg = JSON.parse(await fs.readText(target, undefined));
	const binField = pkg.bin;
	let rel;
	if (typeof binField === "string") rel = binField;
	else if (binField && typeof binField === "object") rel = binField[entry.bin];
	if (!rel) throw new Error(`无法从 ${entry.npm} 的 package.json 解析 ${entry.bin} 的 bin 入口`);
	return path.join(pkgRoot, rel);
}

/**
 * Render a self-contained Windows .cmd wrapper that invokes the real binary
 * entry by absolute path. Unlike copying npm's shim (which resolves the entry
 * relatively from %~dp0 and breaks once moved out of node_modules/.bin), this
 * wrapper carries the absolute path inline, so it works from <dir>/bin.
 *
 * A `.js` entry is invoked via `node "<abs>" %*`; a native `.exe` entry (e.g.
 * Claude Code's bin/claude.exe) is invoked directly `"<abs>" %*` — running a
 * PE through node would fail with a SyntaxError.
 */
export function windowsWrapperCmd(entryAbsolute) {
	const isExe = /\.exe$/i.test(entryAbsolute);
	const line = isExe ? `"${entryAbsolute}" %*` : `node "${entryAbsolute}" %*`;
	return `@ECHO off\r\n${line}\r\n`;
}

async function linkBin({ spawn, fs, dir, entry, vendor, signal }) {
	if (PLATFORM === "win32") {
		const target = binPath(dir, entry.bin, "win32");
		const jsEntry = await resolvePackageBinEntry({ fs, vendor, entry });
		const targetResolved = await fs.resolve(target, {}, undefined);
		await fs.writeText(targetResolved, windowsWrapperCmd(jsEntry), undefined, undefined);
	} else {
		const source = path.join(vendor, "node_modules", ".bin", entry.bin);
		const target = binPath(dir, entry.bin, "darwin");
		await run(spawn, ["/bin/ln", "-sf", source, target], signal);
	}
}
