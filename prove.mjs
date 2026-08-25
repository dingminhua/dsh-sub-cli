import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "plugin/test/dispatch.test.mjs", "plugin/test/status.test.mjs"], {
	cwd: import.meta.dirname,
	stdio: "inherit"
});

process.exitCode = result.status ?? 1;
