// Capability gating: decide up front whether a task can be handed to a managed
// CLI at all, instead of launching a process that is guaranteed to fail.
//
// The only capability enforced today is network access. Codex and Qwen Code ship
// no web tool of their own (see `webTools` in registry.js), so a task that needs
// one is refused before the CLI starts — with a message that names the CLI that
// can do it and the DSH tools that also can.

import { cliById } from "./registry.js";

/**
 * Markers that a task needs live internet access. Deliberately bilingual and
 * coarse: a false positive only costs one clarifying turn, while a false
 * negative launches a doomed run.
 */
const NETWORK_MARKERS = [
	// Chinese
	"联网", "上网", "搜索", "搜一下", "查一下", "查询最新", "查最新", "最新消息", "最新新闻",
	"新闻", "抓取", "爬取", "访问网页", "打开网页", "浏览网页", "网页", "官网", "下载",
	// English
	"search the web", "web search", "browse", "fetch", "scrape", "crawl",
	"latest news", "news about", "look up online", "online", "website", "url", "http"
];

/**
 * @param {string} prompt - the self-contained task text.
 * @returns {boolean} whether the task reads as needing internet access.
 */
export function needsNetwork(prompt) {
	if (typeof prompt !== "string" || !prompt.trim()) return false;
	const haystack = prompt.toLowerCase();
	return NETWORK_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()));
}

/**
 * Refuse a task the CLI cannot perform, naming the alternatives.
 * @param {string} cliId - managed CLI id.
 * @param {string} prompt - the task text.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkCapability(cliId, prompt) {
	const entry = cliById(cliId);
	// An unknown CLI is not this gate's business; later stages reject it.
	if (!entry) return { ok: true };
	if (entry.webTools !== false) return { ok: true };
	if (!needsNetwork(prompt)) return { ok: true };
	return {
		ok: false,
		reason:
			`${entry.name} 没有内置联网工具，无法执行需要访问网络的任务，已拒绝执行（未启动进程）。` +
			`需要联网的任务请改用 Claude Code（自带 WebSearch / WebFetch），或直接使用 DSH 自带的 ` +
			`advanced_search / web_fetch / platform_search 工具。`
	};
}
