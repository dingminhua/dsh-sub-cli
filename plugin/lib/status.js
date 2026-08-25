// dsh-sub-cli install-status detection.
// "Installed" means a real binary exists at <unifiedDir>/bin/<bin>; the optional
// version probe runs `<bin> --version` and captures the first line. Detection
// never falls back to the system PATH — the plugin only uses the unified dir.

import { binPath } from "./paths.js";

/** True when the path exists (uses a subprocess `test -e` under the hood). */
export async function pathExists(runCmd, p) {
	const r = await runCmd(["/bin/test", "-e", p]);
	return r.exitCode === 0;
}

/**
 * Detect whether a CLI is installed and, when possible, its version.
 * @returns {{ installed: boolean, version: string | null, message: string }}
 */
export async function detectInstalled({ runCmd, spawn, dir, entry }) {
	const bin = binPath(dir, entry.bin);
	if (!(await pathExists(runCmd, bin))) {
		return { installed: false, version: null, message: `未找到 ${bin}。请先安装到该位置。` };
	}
	// Try to resolve the executable (verifies it is actually runnable).
	const resolved = await spawn.resolveExecutable(bin).catch(() => null);
	if (!resolved) {
		return { installed: true, version: null, message: "二进制存在，但不是可执行文件。" };
	}
	let handle;
	try {
		handle = spawn.spawn({
			argv: [resolved, "--version"],
			cwd: ".",
			stdio: { stdin: "ignore", stdout: { maxBytes: 200000 }, stderr: { maxBytes: 200000 } },
			graceMs: 20000
		});
	} catch (err) {
		return { installed: true, version: null, message: `运行 --version 失败：${String(err)}` };
	}
	const outcome = await handle.done;
	const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
	const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
	const version = (out || err || "").trim();
	return { installed: true, version: version.length ? version.split("\n")[0] : null, message: "" };
}
