// Adapt DSH's managed subprocess handle to the line-oriented transport used by
// the experimental Codex app-server driver. The DSH subprocess service remains
// the sole process-tree owner.

import { binPath } from "../paths.js";
import { winShimArgv } from "../dispatch.js";

function asError(value) {
	return value instanceof Error ? value : new Error(String(value));
}

export class SubprocessLineTransport {
	constructor(handle) {
		if (!handle || !handle.stdin || !handle.stdout || !handle.done) {
			throw new TypeError("subprocess line transport requires piped stdin/stdout and done");
		}
		this.handle = handle;
		this.lineListeners = new Set();
		this.closeListeners = new Set();
		this.buffer = "";
		this.closed = false;
		// Timestamp of the most recent output, used by the turn-timeout probe to
		// tell "still working" from "silently stuck".
		this.lastActivityAt = Date.now();
		this.decoder = new TextDecoder();
		this.onData = (chunk) => this.consume(chunk);
		handle.stdout.on("data", this.onData);
		void handle.done.then(
			(outcome) => this.close(outcome?.exitCode === 0 ? null : new Error(`subprocess exited ${String(outcome?.exitCode)}`)),
			(error) => this.close(asError(error))
		);
	}

	onLine(listener) {
		this.lineListeners.add(listener);
		return () => this.lineListeners.delete(listener);
	}

	onClose(listener) {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	consume(chunk) {
		if (this.closed) return;
		// Any byte at all counts as activity: a CLI that is streaming output is
		// making progress even when it has not produced a complete line yet.
		this.lastActivityAt = Date.now();
		const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		this.buffer += text;
		let newline;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			for (const listener of [...this.lineListeners]) {
				try { listener(line); } catch {}
			}
		}
	}

	write(text) {
		if (this.closed) return Promise.reject(new Error("subprocess transport is closed"));
		return new Promise((resolve, reject) => {
			this.handle.stdin.write(text, (error) => error ? reject(asError(error)) : resolve());
		});
	}

	// Signal EOF on stdin so the child sees a finished prompt. CLIs that
	// read from stdin (Qwen's --prompt mode, etc.) block until they get
	// EOF, so the driver must call this after writing the prompt.
	closeStdin() {
		if (this.closed) return;
		try { this.handle.stdin.end(); } catch {}
	}

	close(error) {
		if (this.closed) return;
		this.closed = true;
		if (this.buffer) {
			const line = this.buffer;
			this.buffer = "";
			for (const listener of [...this.lineListeners]) {
				try { listener(line); } catch {}
			}
		}
		this.handle.stdout.off?.("data", this.onData);
		for (const listener of [...this.closeListeners]) {
			try { listener(error); } catch {}
		}
		this.lineListeners.clear();
		this.closeListeners.clear();
	}

	async dispose() {
		if (!this.closed) {
			try { this.handle.terminate?.(); } catch {}
		}
		await this.handle.done.catch(() => {});
		this.close(null);
	}
}

/**
 * Create a transport factory backed by the managed Codex binary and isolated
 * CODEX_HOME. `prepare` is the same verified run gate used by existing tools.
 */
export function createCodexSubprocessTransportFactory({ subprocess, dirSource, prepare, graceMs = 30000 }) {
	if (!subprocess || typeof subprocess.spawn !== "function" || typeof subprocess.resolveExecutable !== "function") {
		throw new TypeError("Codex subprocess transport requires the DSH subprocess service");
	}
	if (typeof dirSource !== "function") throw new TypeError("Codex subprocess transport requires dirSource()");
	return async function createTransport(request) {
		const dir = dirSource();
		const executable = binPath(dir, "codex");
		const resolved = await subprocess.resolveExecutable(executable, undefined, request.signal).catch(() => null);
		if (!resolved) throw new Error(`找不到 codex，请先安装到统一目录 ${dir}/bin。`);
		let env;
		if (prepare) {
			const ready = await prepare("codex", dir);
			if (!ready?.ok) throw new Error(ready?.reason || "Codex 配置未就绪，拒绝启动 app-server。");
			env = ready.env;
		}
		const handle = subprocess.spawn({
			argv: winShimArgv(resolved, ["app-server", "--stdio"]),
			cwd: request.cwd,
			env,
			signal: request.signal,
			stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
			graceMs
		});
		return new SubprocessLineTransport(handle);
	};
}
