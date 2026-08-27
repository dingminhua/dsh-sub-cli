// Safe managed-CLI operations. These helpers never inspect PATH and only act
// on the fixed binary path beneath the configured unified directory.

import { binPath } from "./paths.js";
import { dispatch } from "./dispatch.js";

export function managedBinaryPath(dir, entry) {
	return binPath(dir, entry.bin);
}

export async function removeManagedCli({ fs, spawn, dir, entry, signal, platform = process.platform }) {
	const path = managedBinaryPath(dir, entry);
	const info = await fs.lstat(path, {}, signal);
	if (!info) return { ok: true, removed: false, path };
	if (info.type === "directory") throw new Error(`拒绝删除目录：${path}`);
	const argv = platform === "win32"
		? ["cmd.exe", "/d", "/s", "/c", "del", "/f", "/q", path]
		: ["/bin/rm", "-f", "--", path];
	const handle = spawn.spawn({ argv, cwd: dir, signal, stdio: { stdin: "ignore", stdout: { maxBytes: 20000 }, stderr: { maxBytes: 20000 } }, graceMs: 10000 });
	const outcome = await handle.done;
	if (outcome.exitCode !== 0) {
		const stderr = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
		throw new Error(`删除托管 CLI 失败：${stderr || `exit ${String(outcome.exitCode)}`}`);
	}
	return { ok: true, removed: true, path };
}

export async function testManagedCli({ spawn, dir, entry, signal, env }) {
	const task = "Reply with exactly: DSH CLI connection OK";
	const result = await dispatch({ spawn, dir, entry, argv: entry.argv(task), env, signal });
	if (!result.ok) return { ok: false, message: result.error || result.stderr || result.stdout || "CLI connection test failed" };
	const output = (result.stdout || result.stderr || "").trim();
	return { ok: true, message: output || "CLI connection succeeded" };
}
