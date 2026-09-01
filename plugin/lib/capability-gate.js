// Capability gating: decide up front whether a task can be handed to a managed
// CLI at all, instead of launching a process that is guaranteed to fail.
//
// The only capability enforced today is network access. Codex and Qwen Code ship
// no web tool of their own (see `webTools` in registry.js), so a task that needs
// one is refused before the CLI starts — with a message that names the CLI that
// can do it and the DSH tools that also can.

import { cliById } from "./registry.js";

/**
 * Markers that a task needs live internet access. Match the task's INTENT,
 * not bare words: "fetch"/"url"/"http"/"news" appear in local work (inventorying
 * a tool named web_fetch, reading a link in a file, git log messages) and must
 * not trip the gate. A missed marker only costs one failed run; a false
 * positive blocks a perfectly local task, so precision beats recall here.
 */
const NETWORK_MARKERS = [
	// Chinese — verbs/objects that clearly ask for online access.
	"联网", "上网", "联网搜索", "搜索一下", "搜一下", "搜索最新", "查询最新", "查最新",
	"最新消息", "最新新闻", "搜索新闻", "查新闻", "新闻调查", "抓取网页", "爬取网页",
	"访问这个网页", "打开这个网页", "浏览网页", "浏览这个网页", "访问网站", "打开网站",
	"去网上", "从网上", "在网上查",
	// English — full intent phrases, not bare tokens.
	"search the web", "web search", "search online", "search the internet",
	"google it", "look it up online", "search for the latest", "latest news",
	"news about", "browse the web", "browse this url", "open this url",
	"visit this url", "fetch this url", "fetch this page", "fetch this website",
	"scrape this", "scrape the", "crawl this", "crawl the", "download from"
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
