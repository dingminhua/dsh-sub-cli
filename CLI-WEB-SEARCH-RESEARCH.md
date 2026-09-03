# 三 CLI 联网搜索与代理配置调研（2026-09）

> 目的：回答问题二「CLI 到底能不能通过参数实现搜索功能」以及「能否使用系统代理」。
> 方法：官方文档 + GitHub issues + 社区实测（来源见文末）。结论将驱动 `registry.js` / `verify.js` 的配置实现与第十一轮真机矩阵。
> 设计意图（已确认）：派 CLI 是**借用 CLI 自带的搜索工具获得更好的搜索效果**，不存在"主控代搜"兜底。

## 一、总览对照表

| | Codex | Claude Code | Qwen Code |
|---|---|---|---|
| **搜索开关** | `web_search`（4 态） | 自带，无需开关 | `tools.webSearch.enabled`（opt-in） |
| **headless 生效方式** | ✅ TOML 键 / `-c` 覆盖 | ✅ 自带 | ✅ settings.json / 环境变量 |
| **执行端** | **服务端工具**（Responses API） | **服务端工具**（Anthropic API） | **本地子进程**（CLI 自己跑搜索代理） |
| **搜索后端** | OpenAI 搜索索引/直播检索 | Anthropic 搜索 | DashScope 搜索模型（需**额外**配置搜索模型+API key） |
| **代理支持** | `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` | `HTTPS_PROXY` 等（大小写均可） | `HTTP(S)_PROXY` 有 bug 历史；settings.json `proxy` 键 + `--proxy` 参数 |

## 二、逐 CLI 详解

### Codex

**开关（重要：值语义已升级为 4 态）**。配置参考（ChatGPT Learn 官方文档）：

```toml
# 顶层键（新形式）
web_search = "disabled" | "cached" | "indexed" | "live"   # 默认 "cached"

# 旧形式（仍兼容，我们目前用的就是这个）
[tools]
web_search = true
```

- **`cached`（默认）**：用 OpenAI 维护的搜索**索引**，**不真正外网访问**——结果可能是陈旧的缓存页；
- **`live`**：真·实时检索，要联网效果必须用这个；
- **`indexed`**：由搜索索引门控的外部访问；
- **`--yolo`/完全访问沙箱下默认 `live`**——即在我们 `danger-full-access` 档下，即使不显式配也可能拿到 live；
- 旧 `features.web_search_request = true` 映射到 `live`，`features.web_search_cached = true` 映射 `cached`；`[tools].web_search = true` 是废弃 legacy 别名。

**我们现有配置的问题**：`registry.js` 里 exec 档加的是 `-c tools.web_search=true`——legacy 别名，且按映射语义更接近 `live`，但**值形态已是 deprecated**。应改为顶层键 `-c web_search=live`（exec 档）——与"联网意图"完全对齐，且是官方推荐形式。`--search` flag 仅 TUI 有效，`codex exec` 拒绝（openai/codex#2760 已确认，我们的既有结论仍正确）。

**执行端：服务端工具**。搜索是 Responses API 的 server-side tool——请求发到 provider（我们是中转商），**由 provider 执行**。中转商若只做协议转发不执行 server-side 工具，搜索会失败/空转。这是我们链路里最大的不确定性，只能真机实测。另有 `model_providers.<id>.supports_standalone_web_search` 键（provider 是否支持独立 web search），提示官方也意识到 provider 兼容性问题。

**代理**：标准 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量（GitHub issue #4242/#6060 讨论了各 HTTP client 的覆盖一致性）。另有配置参考中出现的默认值 `http://127.0.0.1:3128`/`8081`（疑似特定 profile 的示例，非全局默认）。**传法：spawn 时注入环境变量即可**。

### Claude Code

**开关：无需配置**。WebSearch/WebFetch 是 Claude Code 自带工具（WebFetch 做域名安全检查 + 页面抓取，WebSearch 走搜索），`-p` headless 模式同样可用。权限上 WebSearch/WebFetch 可用 permissions 规则（`allow`/`ask`/`deny`）控制，默认可用。

**执行端：服务端工具（关键差异）**。WebSearch 走 **Anthropic API 的 server-side 工具 `web_search_20250305`**——搜索请求由 **Anthropic 服务端**执行，不在 CLI 本地。这意味着：

- 走**官方 Anthropic 端点**（官方登录或官方 API key）→ 搜索可用；
- 走**中转商**（`ANTHROPIC_BASE_URL` 指向第三方）→ 搜索请求也发给中转商，**中转商必须透传或自己实现该 server-side 工具**。社区已有实证：OmniRoute 等转换器把 `web_search_20250305` 转成 openai 格式时直接损坏（diegosouzapw/OmniRoute#1882）——**chat 型中转商大概率不支持**。

**WebFetch 是另一条路**：它是**本地执行**的（CLI 自己 curl 页面 + 域名安全检查走 claude.ai API），不依赖 server-side 工具——中转商场景下 WebFetch 可用而 WebSearch 不可用是常见形态。模型可退而用 WebFetch 抓已知 URL（但"发现新信息"的搜索能力仍缺）。

**代理**：官方网络配置文档明确支持 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（大小写均可，`https_proxy` 优先序最高；支持 basic auth 形式 `http://user:pass@host:port`）。**传法：spawn 时注入环境变量**。

### Qwen Code

**开关：opt-in 且需要独立搜索模型**。官方文档（tools/web-search）：

```json
{
  "tools": {
    "webSearch": {
      "enabled": true,
      "model": "qwen3.6-plus"        // 必填！resolved against modelProviders
    }
  }
}
```

- `tools.webSearch.enabled`（env `ENABLE_WEB_SEARCH`）：总开关，opt-in；
- `tools.webSearch.model`（env `WEB_SEARCH_MODEL`）：**必填、无默认**——搜索跑在一个**独立的搜索模型**上（推荐 `qwen3.6-plus`），需要 `DASHSCOPE_API_KEY`（或 `WEB_SEARCH_API_KEY`）**单独计费**；
- `webExtractor`（默认 true）：搜索代理会打开结果页做 grounding，单独计费。

**执行端：本地子进程 + DashScope 搜索模型**。Qwen 的 WebSearch 是 CLI 内部跑的搜索代理（子进程），但搜索本身调 **DashScope 的搜索模型 API**——不是当前对话模型。**这带来一个我们配置上的实质问题**：我们现在只写 `enabled: true, model: <对话模型>`——把对话模型（deepseek-v4-flash 之类）当搜索模型传，而搜索模型必须是 modelProviders 里配置的、Qwen 认识的 id。**旧实测"Qwen WebSearch 是 server-side chat relay 不执行"的结论与此吻合**：没有 DashScope key + 没有合法搜索模型 → 搜索工具形同虚设。**要用真搜索，用户必须额外配 DashScope key**——这是能力边界，不是 bug，但工具描述应如实说明。

**代理**：
- 环境变量 `HTTP(S)_PROXY` 支持，但 **`NO_PROXY` 有 bug 历史**（QwenLM/qwen-code#756：设了代理变量的主机会绕过 no_proxy 直连，需清空四个变量才能禁代理——已在后续版本讨论修复）；
- **官方正道**：settings.json 顶层 `"proxy": "http://localhost:7890"` 键（官方配置文档示例明确存在）或 CLI 参数 `--proxy <url>`（参数表里有）——注意 issue #3742 提到该键在某个版本曾不被尊重（extension 场景），CLI 场景以实测为准。

## 三、其它 Agent CLI 的搜索支持对比（2026-09 追加调研）

> 问题：有没有搜索支持更完善的 CLI（如 Google 的）值得纳入托管清单？

### Gemini CLI（Google 官方）——目前搜索支持最完善的候选

| 维度 | 情况 |
|---|---|
| 搜索工具 | **`google_web_search`（核心内置工具，默认开启）** + `web_fetch`，基于 Google Search Grounding |
| 免费额度 | **个人 Google 账号 OAuth：60 请求/分钟、1000 请求/天**（API key 免费档仅 250/天）——搜索成本最低 |
| headless | `-p "..." --output-format json`，JSON 输出里带 **tools 统计**（`byName.google_web_search` 的调用次数/成败/时长）——可观测性最好，验收"真搜了"有据可查 |
| 执行端 | Gemini API 的 google_search grounding（服务端，但**走 Google 自己的端点**，不依赖第三方中转商执行） |
| 关闭方式 | settings.json `tools.exclude: ["google_web_search"]`（默认在，不是 opt-in——与我们三 CLI 相反） |
| 代理 | 标准 `HTTPS_PROXY` 环境变量（官方 issue #12392 确认 Windows 下 `set HTTPS_PROXY=...` 后 gemini 正常走代理；`--proxy` 参数曾被移除） |
| 配置隔离 | `GEMINI_CLI_HOME` 环境变量（与 CODEX_HOME/CLAUDE_CONFIG_DIR 同模式，符合我们的隔离架构） |

**评估：接入价值高**。搜索默认开箱即用（非 opt-in）、免费额度大、JSON 输出可验证搜索真实发生、代理走标准变量、隔离模式与现有三 CLI 同构。代价：新增一个 CLI 的 registry 条目 + driver（无 app-server 式常驻协议，类似 Claude 的 `-p` 模式，`--output-format json` 解析）。roadmap 原本就预留了扩展位（dsh-agent-conductor 调研里 Gemini 也在 11 CLI 清单中）。

### 其它候选（对比后不建议优先）

| CLI | 搜索支持 | 结论 |
|---|---|---|
| **OpenCode** | 内置 `websearch`/`webfetch` 工具（config 里 `permission.websearch: "allow"` 控制），社区评价"基础"（Cloudflare 页面会被挡） | 工具齐全但搜索质量一般；且它是多后端聚合器，与我们"统一 CLI"定位重叠，优先级低 |
| **Aider** | 无内置搜索，靠第三方（Bright Data CLI 等）外挂 | 不满足"开箱即用" |
| **Grok CLI（Grok Build）** | `web_search` 是 Responses API server-side 工具（同 Codex 机制，走 xAI 官方端点） | 机制与 Codex 同，且我们走中转商时同样卡 server-side 执行问题；xAI 生态绑定较深 |
| **Cursor CLI** | `cursor-agent --print` 有 `@web` 搜索，但论坛大量"搜索坏了"的 bug 报告（2025-10 至 2026-01 多起） | 稳定性存疑，闭源商业产品 |

### 结论与建议

1. **Gemini CLI 是唯一值得立即纳入评估的**：搜索开箱即用 + 1000 次/天免费 + JSON 可验证 + 代理标准 + 隔离同构——它恰好补上三 CLI 搜索链路的短板（Codex/Claude 卡中转商、Qwen 要额外 DashScope key），给用户一个"Google 官方 grounding"的联网检索选项；
2. Grok/Cursor/OpenCode 暂不纳入：机制同质（Grok）、质量存疑（OpenCode）、稳定性差（Cursor）；
3. 纳入方式建议作为独立小迭代（registry 条目 + gemini stream-json/json driver + `cli_gemini_direct` 工具 + 验证矩阵一格），**不与当前"问题二收尾"（Codex 开关修正 + 代理透传 + 预期管理 + 第十一轮矩阵）混在一起做**——先把存量三 CLI 的联网边界画清楚，再加第四个 CLI。

## 四、对我们实现的具体行动项

1. **Codex**：`registry.js` 的 `-c tools.web_search=true` 改为 **`-c web_search=live`**（exec 档）——语义正确（真实时检索）、形式非废弃。`verify.js` 若渲染 codex config.toml 需同步。
2. **Qwen**：搜索模型问题如实分层——`tools.webSearch.enabled` 照写，但 **`model` 字段必须指向用户配置的真实搜索模型**（若用户没配 DashScope 类搜索模型，标注"Qwen 联网搜索需额外配置 DashScope 搜索模型与 API key"）；设置卡/工具描述注明该前置条件。
3. **Claude**：无需改开关；**预期管理**——中转商路线下 WebSearch（server-side）大概率不可用、WebFetch（本地）可用。工具描述如实写："搜索能力取决于所用端点是否执行 Anthropic server-side 工具；官方登录/官方 API 可用，多数 chat 型中转商不可用（WebFetch 抓取不受影响）"。
4. **系统代理（三 CLI 统一）**：`prepareManagedRun` 的环境变量注入中透传 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `http_proxy` / `https_proxy` / `no_proxy`（若宿主进程有）——Codex/Claude 直接识别；Qwen 识别但有 NO_PROXY bug，settings.json `proxy` 键作为 Qwen 的补充选项（远期可做成设置卡字段）。**已核对：现有 `cliEnv()` 全新构造 env、未透传任何代理变量，需补**。
5. **第十一轮矩阵新增用例**：三 CLI × 联网任务 ×（a）无代理直连（b）注入系统代理——共 6 格，验收标准是"结果含真实、可访问的 URL"。
6. **（远期独立迭代）Gemini CLI 纳入评估**：registry + driver + `cli_gemini_direct`——搜索开箱即用（google_web_search 默认在）、Google 账号 OAuth 免费 1000 次/天、`--output-format json` 自带工具调用统计（验收"真搜了"有据可查）、`GEMINI_CLI_HOME` 隔离同构。不与行动项 1-5 混做。

## 五、来源

- Codex 配置参考（4 态 web_search、代理默认值）：https://learn.chatgpt.com/docs/config-file/config-reference
- Codex 配置模板与 exec/TUI 差异：https://github.com/openai/codex/issues/2760
- Codex 代理环境变量讨论：https://github.com/openai/codex/issues/4242 、#6060
- Claude Code 网络配置（代理官方文档）：https://code.claude.com/docs/en/network-config
- Claude Code 权限（WebSearch/WebFetch 规则）：https://code.claude.com/docs/en/permissions
- Anthropic web_search server-side 工具机制：https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Claude Code WebSearch 走 server-side 的实证（中转商损坏案例）：https://github.com/diegosouzapw/OmniRoute#1882
- Claude Code Web 工具内部机制（WebFetch 本地/WebSearch 服务端）：https://mikhail.io/2025/10/claude-code-web-tools/
- Qwen Web Search 官方文档（enabled/model/env）：https://qwenlm.github.io/qwen-code-docs/en/developers/tools/web-search/
- Qwen 配置文档（settings.json proxy 键、--proxy 参数）：https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/
- Qwen NO_PROXY bug：https://github.com/QwenLM/qwen-code/issues/756 ；proxy 键 issue：#3742
- Gemini CLI headless（JSON 输出含 google_web_search 工具统计）：https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
- Gemini CLI 仓库（免费额度、内置搜索 grounding、认证方式）：https://github.com/google-gemini/gemini-cli
- Gemini CLI 配置（tools.exclude 关闭搜索、tools.core 白名单）：https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html
- Gemini CLI 代理（HTTPS_PROXY 实证）：https://github.com/google-gemini/gemini-cli/issues/12392
- OpenCode 内置 websearch 工具：https://opencode.ai/docs/tools/
- xAI web_search 工具（Grok 同 Codex 的 server-side 机制）：https://docs.x.ai/developers/tools/web-search
- Cursor CLI 搜索稳定性问题：https://forum.cursor.com/t/cursor-agent-cli-no-longer-has-access-to-web-search/139149
