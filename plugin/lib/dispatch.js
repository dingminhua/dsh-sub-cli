// dsh-sub-cli headless dispatch.
// Runs an installed external CLI via ctx.subprocess.spawn with an argv array
// (never a shell string), the CLI's isolated config env, and a bounded output.
// On Windows, an npm shim binary is a `.cmd`/`.bat` and cannot be spawned
// directly, so it is wrapped via `cmd.exe /d /s /c` (see wrapWinShim).

import { binPath, envFor, PLATFORM } from "./paths.js";

export const MAX_OUTPUT_BYTES = 200000;
export const GRACE_MS = 30000;

/**
 * Wrap a Windows `.cmd`/`.bat` executable through cmd.exe; other outputs pass
 * through unchanged.
 *
 * Windows note (verified empirically): DSH's subprocess layer calls Node's
 * child_process.spawn, which applies standard CreateProcess quoting to each
 * argv element (wrapping tokens that contain spaces in quotes and escaping
 * embedded quotes as \"). The correct cmd wrapper is therefore `cmd /d /c`
 * with the RAW shim path — do NOT add /s and do NOT pre-quote the path.
 *   - /s tells cmd to strip the first+last quote of the whole line, which
 *     breaks the quoting Node applied to a spaced path (path gets split).
 *   - Pre-quoting the path makes Node escape those quotes to \", and cmd then
 *     fails with '"..." is not recognized'.
 * Passing the raw path lets Node's quoting survive intact through to the .cmd.
 */
export function winShimArgv(resolved, argv, platform = PLATFORM) {
	const lower = resolved.toLowerCase();
	const isWinShim = platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
	if (!isWinShim) return [resolved, ...argv];
	return ["cmd.exe", "/d", "/c", resolved, ...argv];
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
	// Windows cmd /c limitation: when the shim path contains spaces AND any
	// argument also contains spaces or cmd metacharacters, Node's per-element
	// quoting produces ≥2 quoted groups on the /c line, and cmd then strips the
	// outer pair and re-parses — cutting the spaced path at its first space.
	// There is no clean argv-only fix without subprocess verbatim support, so we
	// fail fast with an actionable message instead of a cryptic cmd error.
	if (PLATFORM === "win32" && /[\s&|<>^%]/.test(resolved)) {
		const risky = argv.some((a) => /[\s&|<>^%]/.test(String(a)));
		if (risky) {
			return {
				ok: false, exitCode: null, stdout: "", stderr: "",
				error: `当前统一目录路径含空格或特殊字符（${resolved}），Windows cmd 无法可靠地向该路径下的 ${entry.bin} 传递含空格的任务参数。请把 CLI 统一目录改为不含空格的路径（如 %USERPROFILE%\\dsh-clis 或 D:\\dsh-clis），再重试。`
			};
		}
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
