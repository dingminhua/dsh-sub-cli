// Managed CLI install / update.
//
// Each supported CLI is an npm-distributed package with a bin. We install that
// package into a vendor subdirectory inside the unified dir (never globally),
// then link the exposed bin into <dir>/bin/<bin>. Version queries go through
// `npm view <pkg> version`; current version via `<bin> --version`.
//
// POSIX-first: directories via `/bin/mkdir -p`, symlinks via `/bin/ln -sf`.
// Windows shim (.cmd/.exe) handling is a documented follow-up.

import { binPath } from "./paths.js";

function output(handle, which = "stdout") {
	return handle.collected && handle.collected[which] ? handle.collected[which].readFrom(0).text : "";
}

async function run(spawn, argv, signal) {
	const handle = spawn.spawn({
		argv,
		cwd: ".",
		signal,
		stdio: { stdin: "ignore", stdout: { maxBytes: 100000 }, stderr: { maxBytes: 100000 } },
		graceMs: 60000
	});
	const outcome = await handle.done;
	return { exitCode: outcome.exitCode, stdout: output(handle, "stdout"), stderr: output(handle, "stderr") };
}

export function vendorDir(dir, entry) {
	return `${dir}/vendor/${entry.id}`;
}

function linkedBin(dir, entry) {
	return `${vendorDir(dir, entry)}/node_modules/.bin/${entry.bin}`;
}

/** Query the latest published version of the npm package. */
export async function latestVersion({ spawn, entry }) {
	const r = await run(spawn, ["npm", "view", entry.npm, "version"]);
	const version = (r.stdout || "").trim();
	if (r.exitCode !== 0 || !version) throw new Error(`查询 ${entry.npm} 最新版本失败：${r.stderr.trim() || `exit ${r.exitCode}`}`);
	return version;
}

/** Read the current installed version by running `<bin> --version`. */
export async function currentVersion({ spawn, dir, entry, signal }) {
	const bin = binPath(dir, entry.bin);
	const resolved = await spawn.resolveExecutable(bin, undefined, signal).catch(() => null);
	if (!resolved) return null;
	const r = await run(spawn, [resolved, "--version"], signal);
	const first = (r.stdout || "").trim().split("\n")[0];
	return first || null;
}

/** Install (or reinstall) the CLI into the unified dir, returning the installed version. */
export async function installManagedCli({ spawn, dir, entry, version, signal }) {
	const versionSpec = version && version.length > 0 ? `${entry.npm}@${version}` : entry.npm;
	const vendor = vendorDir(dir, entry);
	await run(spawn, ["/bin/mkdir", "-p", `${dir}/bin`, vendor], signal).then((r) => {
		if (r.exitCode !== 0) throw new Error(`创建目录失败：${r.stderr.trim()}`);
	});
	const install = await run(spawn, ["npm", "install", "--prefix", vendor, "--no-save", "--no-audit", "--no-fund", versionSpec], signal);
	if (install.exitCode !== 0) throw new Error(`npm 安装 ${entry.npm} 失败：${install.stderr.trim() || `exit ${install.exitCode}`}`);
	const linked = linkedBin(dir, entry);
	const link = await run(spawn, ["/bin/ln", "-sf", linked, binPath(dir, entry.bin)], signal);
	if (link.exitCode !== 0) throw new Error(`链接 ${entry.bin} 失败：${link.stderr.trim()}`);
	const installed = await currentVersion({ spawn, dir, entry, signal });
	return { ok: true, version: installed };
}

/** Update to the latest published version; reports whether an update happened. */
export async function updateManagedCli({ spawn, dir, entry, signal }) {
	const latest = await latestVersion({ spawn, entry });
	const current = await currentVersion({ spawn, dir, entry, signal });
	if (current === latest) return { ok: true, updated: false, currentVersion: current, latestVersion: latest, message: "当前已是最新版本" };
	await installManagedCli({ spawn, dir, entry, version: latest, signal });
	const installed = await currentVersion({ spawn, dir, entry, signal });
	return { ok: true, updated: true, currentVersion: installed, latestVersion: latest, message: "已更新" };
}
