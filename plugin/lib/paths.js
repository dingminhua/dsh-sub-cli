// dsh-sub-cli path / config-isolation helpers.
// The unified dir is where the plugin owns everything: bin/ holds the CLI
// binaries, config-<cli>/ holds each CLI's isolated config. The default is
// $HOME/dsh-clis (macOS/Linux) or %USERPROFILE%\dsh-clis (Windows), but the
// user may pick any dir via the Web panel; the choice is persisted in the
// dsh-sub-cli settings section.

import os from "node:os";
import path from "node:path";

export const DEFAULT_DIR_LABEL = "~/dsh-clis";
export const PLATFORM = process.platform;

/** Append the npm shim extension for Windows; other platforms use the bare name. */
export function binName(bin, platform = PLATFORM) {
	return platform === "win32" ? `${bin}.cmd` : bin;
}

/** Expand a path that may use a leading "~" to the real home dir. */
export function expandTilde(p) {
	if (typeof p !== "string") return p;
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Resolve the unified dir: the persisted `<section>.cliDir`, or $HOME/dsh-clis. */
export function resolveDir(setting) {
	const raw = setting && typeof setting.cliDir === "string" && setting.cliDir.length > 0 ? setting.cliDir : null;
	return expandTilde(raw ?? DEFAULT_DIR_LABEL);
}

/** The bin path for one CLI binary (uses the npm shim name on Windows). */
export function binPath(dir, bin, platform = PLATFORM) {
	return path.join(dir, "bin", binName(bin, platform));
}

/** The config dir for one CLI, isolated from the user's system defaults. */
export function configDirPath(dir, configDir) {
	return path.join(dir, configDir);
}

/** Whole subdirectory names the plugin owns under the unified dir. */
export function managedNames(registry) {
	return ["bin", ...registry.map((entry) => entry.configDir)];
}

/**
 * Build the env object for one headless dispatch: point the CLI's config-env
 * var at its isolated config dir. The system-default config is never touched.
 */
export function envFor(entry, dir) {
	const env = {};
	env[entry.env] = configDirPath(dir, entry.configDir);
	return env;
}
