// dsh-sub-cli headless dispatch.
// Runs an installed external CLI via ctx.subprocess.spawn with an argv array
// (never a shell string), the CLI's isolated config env, and a bounded output.

import { binPath, envFor } from "./paths.js";

export const MAX_OUTPUT_BYTES = 200000;
export const GRACE_MS = 30000;

/**
 * Run one headless dispatch.
 * @param {object} deps - { spawn: SubprocessService, dir: string, entry, argv: string[], task: string, model?: string }
 * @returns {Promise<{ok:boolean, exitCode:number|null, stdout:string, stderr:string, error?:string}>}
 */
export async function dispatch({ spawn, dir, entry, argv, signal }) {
	const resolved = await spawn.resolveExecutable(binPath(dir, entry.bin), undefined, signal).catch(() => null);
	if (!resolved) {
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: `找不到 ${entry.bin}，请先安装到统一目录 ${dir}/bin。` };
	}
	let handle;
	try {
		handle = spawn.spawn({
			argv: [resolved, ...argv],
			cwd: ".",
			env: envFor(entry, dir),
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
