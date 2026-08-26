// Copyable install command for each managed CLI.
//
// Installing is intentionally left to the user: we render a small, copyable
// command that installs the official npm package into the unified dir's vendor
// subdirectory (never globally) and links/points the exposed bin into
// <dir>/bin/<bin>. POSIX renders a shell script; Windows renders PowerShell.

export const PLATFORM = process.platform;

/** The vendor install root for one CLI, inside the unified dir. */
export function vendorDir(dir, entry) {
	return `${dir}/vendor/${entry.id}`;
}

function posixCommand(entry, dir) {
	return [
		`# 安装/更新 ${entry.name} 到 ${dir}`,
		`DIR=${JSON.stringify(dir)}`,
		`mkdir -p "$DIR/vendor/${entry.id}"`,
		`npm install --prefix "$DIR/vendor/${entry.id}" --no-save --no-audit --no-fund ${entry.npm}`,
		`ln -sf "$DIR/vendor/${entry.id}/node_modules/.bin/${entry.bin}" "$DIR/bin/${entry.bin}"`
	].join("\n");
}

function windowsCommand(entry, dir) {
	return [
		`# 安装/更新 ${entry.name} 到 ${dir}`,
		`$DIR = '${dir}'`,
		`New-Item -ItemType Directory -Force -Path "$DIR\\vendor\\${entry.id}" | Out-Null`,
		`npm install --prefix "$DIR\\vendor\\${entry.id}" --no-save --no-audit --no-fund ${entry.npm}`,
		`New-Item -ItemType Directory -Force -Path "$DIR\\bin" | Out-Null`,
		`Remove-Item -Force "$DIR\\bin\\${entry.bin}.cmd" -ErrorAction SilentlyContinue`,
		`Copy-Item "$DIR\\vendor\\${entry.id}\\node_modules\\.bin\\${entry.bin}.cmd" "$DIR\\bin\\${entry.bin}.cmd"`
	].join("\n");
}

/**
 * Render the copyable install (or update) command for one CLI into the unified
 * dir. Platform-aware: shell on POSIX, PowerShell on Windows.
 * @returns a multi-line command the user can paste and run.
 */
export function installCommandOf(entry, dir) {
	return PLATFORM === "win32" ? windowsCommand(entry, dir) : posixCommand(entry, dir);
}
