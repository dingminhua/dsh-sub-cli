// Capability gating: decide up front whether a task can be handed to a managed
// CLI at all, instead of launching a process that is guaranteed to fail.
//
// Historical note (removed 2026-09-03): web research used to be refused for
// every CLI with a "controller researches, CLI executes" message. That rule was
// added because early probes showed managed CLIs often could not complete online
// investigation (notably Qwen's WebSearch is a server-side tool the chat relay
// does not execute). The user has since decided to let each CLI attempt web
// research directly — its built-in tools differ per CLI, so measuring real
// behaviour is the only way to know what works. The permission tier (read /
// write / exec) still gates whether a CLI may reach the network: an ungranted
// exec capability stops the task at the A-gate with a "cannot complete" report,
// no process launched.

/**
 * Markers that a task needs live internet access. Kept for B-gate (post-block)
 * capability extraction and future per-CLI intent routing. Match the task's
 * INTENT, not bare words: "fetch"/"url"/"http"/"news" appear in local work
 * (inventorying a tool named web_fetch, reading a link in a file, git log
 * messages) and must not trip a real gate. A missed marker only costs one
 * failed run; a false positive blocks a perfectly local task, so precision
 * beats recall here.
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
 * Negation prefixes that flip a marker's meaning when they directly precede
 * it: 不联网 / 无需联网 / 无法上网 … are PROMISES that the task does not
 * touch the network, yet a bare substring match counts them as network
 * intent and refuses a perfectly local task (the "不联网" boundary line in
 * an approval-justification discussion tripped exactly this). An occurrence
 * preceded by one of these prefixes is therefore not a hit.
 */
const NEGATION_PREFIXES = ["不", "不能", "无需", "无须", "无法", "非", "没", "没有"];

function isNegated(haystack, index) {
	for (const prefix of NEGATION_PREFIXES) {
		const start = index - prefix.length;
		if (start >= 0 && haystack.slice(start, index) === prefix) return true;
	}
	return false;
}

/**
 * @param {string} prompt - the self-contained task text.
 * @returns {boolean} whether the task reads as needing internet access.
 */
export function needsNetwork(prompt) {
	if (typeof prompt !== "string" || !prompt.trim()) return false;
	const haystack = prompt.toLowerCase();
	return NETWORK_MARKERS.some((marker) => {
		const needle = marker.toLowerCase();
		let from = 0;
		for (;;) {
			const at = haystack.indexOf(needle, from);
			if (at < 0) return false;
			if (!isNegated(haystack, at)) return true;
			from = at + needle.length;
		}
	});
}

/**
 * Front-line capability check before a managed CLI starts. Web research is no
 * longer refused here (the user wants each CLI to attempt it); the permission
 * tier is the only gate — an ungranted exec capability stops the task at the
 * A-gate with a "cannot complete" report, no process launched.
 * @param {string} cliId - managed CLI id (kept for future per-CLI gates).
 * @param {string} prompt - the task text.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkCapability(cliId, prompt) {
	// Unknown CLI is not this gate's business; later stages reject it.
	if (!cliId) return { ok: true };
	// NOTE: network-research refusal removed 2026-09-03 — the controller no
	// longer intercepts web-research tasks; they flow to the permission A-gate
	// like any other exec-capability task.
	return { ok: true };
}
