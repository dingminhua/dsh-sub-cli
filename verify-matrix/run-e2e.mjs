// Clean e2e runner: spawn node e2e-live.mjs with stdio separated, so the
// plugin's own exit code is the ONLY signal (PowerShell's NativeCommandError
// turns any stderr noise — git-style progress, codex's ReasoningSummaryDelta
// logs — into a fake [exit code: 1] when 2>&1 merges streams).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const child = spawn(process.execPath, ["e2e-live.mjs"], {
	cwd: pluginDir,
	stdio: ["ignore", "inherit", "pipe"]
});
let stderrBytes = 0;
child.stderr.on("data", (chunk) => {
	stderrBytes += chunk.length;
	// Keep stderr out of the console (noise), but surface a tail if the run
	// fails so the real error is not lost.
	if (child.exitCode !== 0) process.stderr.write(chunk);
});
child.on("close", (code) => {
	if (code === 0) {
		console.log(`\ne2e-live PASSED (exit 0, stderr noise ${stderrBytes} bytes suppressed)`);
	} else {
		console.error(`\ne2e-live FAILED (exit ${code}, stderr ${stderrBytes} bytes)`);
	}
	process.exit(code ?? 1);
});
