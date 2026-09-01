// Capability gating: decide up front whether a task can be handed to a managed
// CLI at all, instead of launching a process that is guaranteed to fail.
//
// Web research is the controller's job, not the CLIs'. None of the managed
// CLIs is used for online investigation: DSH itself ships advanced_search /
// web_fetch / platform_search, and the CLI whose built-in WebSearch would even
// work depends on the relay executing server-side tools. So a research task is
// refused before ANY CLI starts — with a message that keeps the division of
// labour explicit: the controller researches, the CLIs execute code/file work.

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
 * Refuse a web-research task on behalf of every managed CLI, naming the
 * division of labour: the controller researches, the CLI executes.
 * @param {string} cliId - managed CLI id (kept for future per-CLI gates).
 * @param {string} prompt - the task text.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkCapability(cliId, prompt) {
	// Unknown CLI is not this gate's business; later stages reject it.
	if (!cliId) return { ok: true };
	if (!needsNetwork(prompt)) return { ok: true };
	return {
		ok: false,
		reason:
			"联网调研由主控直接执行（DSH 自带 advanced_search / web_fetch / platform_search），不派给外部 CLI。" +
			"如需 CLI 处理调研相关材料，请先由主控完成调研，再把材料作为任务内容派给它；" +
			"代码、文件、命令类任务不受影响，照常派发。"
	};
}
