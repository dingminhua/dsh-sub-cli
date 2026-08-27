// dsh-sub-cli headless dispatch.
// Runs an installed external CLI via ctx.subprocess.spawn with an argv array
// (never a shell string), the CLI's isolated config env, and a bounded output.
// On Windows, an npm shim binary is a `.cmd`/`.bat` and cannot be spawned
// directly, so it is wrapped via `cmd.exe /d /s /c` (see wrapWinShim).

import { binPath, envFor, PLATFORM } from "./paths.js";

export const MAX_OUTPUT_BYTES = 200000;
export const GRACE_MS = 30000;

/** Wrap a Windows `.cmd`/`.bat` executable through cmd.exe; other outputs pass through. */
export function winShimArgv(resolved, argv, platform = PLATFORM) {
	const lower = resolved.toLowerCase();
	const isWinShim = platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
	if (!isWinShim) return [resolved, ...argv];
	return ["cmd.exe", "/d", "/s", "/c", resolved, ...argv];
}

/**
 * Run one headless dispatch.
 * @param {object} deps - { spawn: SubprocessService, dir: string, entry, argv: string[], env?: object, signal?, platform? }
 */
export async function dispatch({ spawn, dir, entry, argv, env, signal }) {
	const bin = binPath(dir, entry.bin);
	const resolved = await spawn.resolveExecutable(bin, undefined, signal).catch(() => null);
	if (!resolved) {
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: `找不到 ${entry.bin}，请先安装到统一目录 ${dir}/bin。` };
	}
	let handle;
	try {
		handle = spawn.spawn({
			argv: winShimArgv(resolved, argv),
			cwd: ".",
			env: env || envFor(entry, dir),
			signal,
			stdio: { stdin: "ignore", stdout: { maxBytes: MAX_OUTPUT_BYTES }, stderr: { maxBytes: MAX_OUTPUT_BYTES } },
			graceMs: GRACE_MS
		});
	} catch (err) {
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: `无法启动 ${entry.bin}：${String(err)}` };
	}
	const outcome = await handle.done;
	const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
	const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
	return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode, stdout: out, stderr: err, error: "" };
}
