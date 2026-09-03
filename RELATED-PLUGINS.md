# 相关插件清单：DSH × Claude Code / Codex

> 本清单整理了将 Claude Code / Codex 与 DeepSeek Harness (DSH) 集成的社区插件，
> 作为 `dsh-sub-cli`（DSH 统一管理外部 Agent CLI）项目的竞品/生态调研素材。
> 整理时间：2026-09；地址均经搜索核实，后续可能失效。

## 一、Claude Code 相关（12 个）

### 🚀 主引擎（Claude Code 接管整个会话）

| 插件 | 一句话简介 | 仓库 |
|---|---|---|
| dsh-claude | 将 Claude Code 作为 DSH 的一等公民运行 | <https://github.com/Norman-else/dsh-claude> |
| claude-in-dsh | 在 DSH Web 里用本机 Claude Code CLI 驱动会话 | <https://github.com/GeekRicardo/claude-in-dsh> |
| dsh-claude-driver | 让 DSH 会话把本地 Claude Code 订阅当作主模型使用 | <https://github.com/zhangjunjesse/dsh-claude-driver> |
| dsh-claude-code (Yuki-takuya-kun) | 在 DSH 里用 Claude Code 驱动会话，轨迹实时可见 | <https://github.com/Yuki-takuya-kun/dsh-claude-code> |

### 🧩 子代理（Claude Code 作为可调用的子代理）

| 插件 | 一句话简介 | 仓库 |
|---|---|---|
| dsh-claude-code (zhangjunjesse) | 将自包含的编码子任务委派给本地 Claude Code 订阅执行 | <https://github.com/zhangjunjesse/dsh-claude-code> |
| @deepseek-ai/dsh-subagent-claude-code | **官方**子代理，在委托会话的工作区中调用 Claude Agent SDK | <https://github.com/deepseek-ai/dsh-subagent-claude-code> |
| dsh-subagent-claude-code-wrapper | 官方子代理的复刻，允许调用任何 Claude 兼容的 CLI | <https://github.com/yaways/dsh-subagent-claude-code-wrapper> |

### 🌉 桥接与兼容层

| 插件 | 一句话简介 | 仓库 |
|---|---|---|
| dsh-bridges | 桥接已为 Claude Code 等工具配置好的项目，让现有技能/配置直接生效 | <https://github.com/yhlooo/dsh-bridges> |
| dsh-plan-bridge | 桥接现有的 Claude Code (Pro/Max) 等订阅套餐 | <https://github.com/TaylorSwitiger/dsh-plan-bridge> |

### ✨ 其他

| 插件 | 一句话简介 | 仓库 |
|---|---|---|
| dsh-plugin-cc | 桥接 DSH 和 Claude Code，用于代码审查、批评和任务委派 | <https://github.com/cpj-dev/dsh-plugin-cc> |
| dsh-plugin-session-import | 导入 Claude Code / Codex 等外部会话 | <https://github.com/huguangyu666/dsh-plugin-session-import> |
| dsh-plugin-claude-bridge | 桥接 Claude Code 的记忆、技能和配置，零迁移 | <https://github.com/YYTbit/dsh-plugin-claude-bridge> |

---

## 二、Codex 相关（21 个）

### 🚀 主模型 / 引擎（OAuth / 订阅接入）

| 插件 | 一句话简介 | 仓库 / 安装 |
|---|---|---|
| dsh-plugin-codex | 将官方 Codex App Server 暴露为 DSH 的 LLM Provider（用本地 Codex 登录） | <https://github.com/wss534857356/dsh-plugin-codex>，`dsh plugin --profile web add dsh-plugin-codex` |
| dsh-codex (ddll8023) | 通过 ChatGPT Plus/Pro OAuth 接入 Codex 模型 | <https://github.com/ddll8023/dsh-codex>，`dsh plugin --profile web add github:ddll8023/dsh-codex` |
| dsh-codex (Yan-Zero) | 通过 OpenAI Codex 登录流程在 DSH 中使用 ChatGPT 订阅 | <https://github.com/Yan-Zero/dsh-codex> |
| dsh-codex-oauth | 补齐官方适配器缺失的 `openai-codex` 路由：Provider + `/codex login` 命令 + 凭据存储 | <https://github.com/birat-chapagain/dsh-codex-oauth>，`dsh plugin --profile web add github:birat-chapagain/dsh-codex-oauth` 后执行 `/codex login`（[官方讨论帖](https://github.com/deepseek-ai/deepseek-harness/discussions/3427)） |
| dsh-codex-subscription | 在 DSH 设置页直接登录 ChatGPT，使用 Codex 订阅（无需 API Key、不依赖 Codex CLI） | <https://github.com/WSL043/dsh-codex-subscription>（[官方讨论帖](https://github.com/deepseek-ai/deepseek-harness/discussions/1211)） |
| @piercat/dsh-codex-bridge | 通过官方 ChatGPT 浏览器授权流，将 Codex Responses 接入 DSH（⚠️ 仅 macOS/Windows） | <https://github.com/piercat/dsh-codex-bridge> |
| @kelvinwww/dsh-oauth | 通过浏览器 OAuth 接入 ChatGPT Codex 订阅 | <https://github.com/kelvinwww/dsh-oauth> |
| dsh-openai-codex-auth | 非官方 OpenAI Codex Provider，通过 ChatGPT 订阅登录 | 维护者 @taot，见 [dsh.so 词条](https://www.dsh.so/artifact/dsh-openai-codex-auth-3/) |

### 🔧 工具集移植（把 Codex 的工具搬进 DSH）

| 插件 | 一句话简介 | 仓库 / 安装 |
|---|---|---|
| dsh-kernel-codex | 将 OpenAI Codex 的整套工具表面（约 30 个工具）重新注册为 DSH 原生工具 | <https://github.com/oppnc/dsh-kernel-codex>，`dsh plugin --profile web add github:oppnc/dsh-kernel-codex` |
| @shuind/dsh-codex-harness | 在 DSH 中提供 Codex preset，引入 Codex 风格的系统提示词与工具契约 | <https://github.com/shuind/dsh-codex-harness>，`dsh plugin --profile web add @shuind/dsh-codex-harness` |
| dsh-codex (songyang0603) | 将 Codex 拆解为独立的 DSH 插件组合，无需调用 Codex 二进制文件 | <https://github.com/songyang0603/dsh-codex> |

### 🌐 搜索能力

| 插件 | 一句话简介 | 仓库 / 安装 |
|---|---|---|
| dsh-codex-web-search-mcp | 将 Codex 的独立搜索 MCP Server 接进 DSH，提供 3 个原生 MCP 工具 | <https://github.com/dhicoc/dsh-codex-web-search-mcp>，`dsh plugin --profile web add @dhicoc/dsh-codex-web-search-mcp` |
| dsh-web-search-free | 免费搜索插件，同时可作为 MCP 服务器供 Codex 等客户端使用 | npm 包 `dsh-web-search-free`，见 <https://www.npmjs.com/package/dsh-web-search-free> |

### 🌉 桥接与兼容层

| 插件 | 一句话简介 | 仓库 / 安装 |
|---|---|---|
| dsh-codex-bridge (pandashere) | 将 Codex CLI 桥接到 DSH，提供 call_codex 等工具调用和独立的 Codex 会话标签页（⚠️ 需 clone 自行打包安装） | <https://github.com/pandashere/dsh-codex-bridge> |
| dsh-codex-bridge (Lavender3533) | DSH 插件 / MCP 服务器 — 让 Codex、Claude Code、Cursor 把 DSH 当作外部**可恢复**子代理使用 | <https://github.com/Lavender3533/dsh-codex-bridge> |
| dsh-plugin-codex-bridge | 桥接 Codex 的记忆、技能和配置到 DSH — 零迁移 | <https://github.com/YYTbit/dsh-plugin-codex-bridge>，`dsh plugin --profile <profile> add dsh-plugin-codex-bridge` |
| dsh-bridges | 桥接已为 Codex 等工具配置好的项目（与 Claude Code 清单重复，两边通用） | <https://github.com/yhlooo/dsh-bridges> |
| dsh-codex-workflow | 给 Codex 分配只读的规划/审查角色，DSH 作为唯一执行者 | <https://github.com/kui123456789/dsh-codex-workflow> |
| dsh-codex-sync | 双向 Codex↔DSH 桥接：同步 skills、会话导入、MCP 镜像等，自带 dry-run 技能 | <https://github.com/Walvez/dsh-codex-sync> |
| dsh-codex-migrate | 把 Codex CLI 的历史对话迁移进 DSH（转换为原生会话/工具卡片格式） | <https://github.com/polarskicpl/dsh-codex-migrate> |

### 🧩 子代理相关

| 插件 | 一句话简介 | 仓库 |
|---|---|---|
| dsh-plugin-product-subagents | 基于角色的 Codex / Claude Code / ACP 子代理提供方 | <https://github.com/shaokeyibb/dsh-plugin-product-subagents> |

---

## 三、核实地址时额外发现的相关项目

| 插件 | 一句话简介 | 仓库 |
|---|---|---|
| dsh-codex-connect | ChatGPT OAuth + OpenAI Codex 模型接入 DSH（派生自 Yan-Zero/dsh-codex，含 trust-origin 管理和 capabilities 探测） | <https://github.com/franksong2702/dsh-codex-connect> |
| dsh-openai-codex | ChatGPT OAuth 模型接入（openai-codex provider 路由） | <https://github.com/bufeibufei/dsh-openai-codex> |
| dsh-plugin-subscriptions | 用 ChatGPT (Codex)、Claude、Grok、Copilot 订阅作为 LLM Provider，免 API Key | <https://github.com/V1ki/dsh-plugin-subscriptions> |
| deepseek-harness-codex-bridge | Codex 主导、DSH 辅助的本地双向 MCP 协作桥 | <https://github.com/Aloneswork/deepseek-harness-codex-bridge> |

更多可检索的插件目录站：

- <https://awesome-dsh-plugin.com/>
- <https://github.com/0xsline/awesome-deepseek-harness>
- <https://github.com/whyihaveyou/dsh-suite>

---

## 四、使用须知

1. **安装通用格式**：GitHub 仓库 `dsh plugin --profile web add github:<owner>/<repo>`；npm 包直接 `dsh plugin --profile web add <包名>`。
2. **前提条件**：子代理/桥接类插件（如 dsh-claude-\*、dsh-codex-bridge、官方 subagent）大多要求本地已安装并**认证好**对应的 Claude Code / Codex CLI；OAuth/订阅类（dsh-codex-oauth、dsh-codex-subscription 等）则不依赖本地 CLI，在 DSH 内完成登录即可。
3. **权限**：部分插件安装时需要在 profile 里加 `allowBuilds` 或手动 clone 构建安装。
4. **平台限制**：@piercat/dsh-codex-bridge 仅支持 macOS/Windows。

---

## 五、对本项目（dsh-sub-cli）的定位参考

从这份清单可以看出社区方案的几条路线，与本项目「在 DSH 中统一管理并调用外部 Agent CLI、与用户原生安装完全隔离」的目标对照：

| 路线 | 代表插件 | 与本项目的差异 |
|---|---|---|
| 让外部 CLI 接管会话（主引擎） | dsh-claude、dsh-claude-driver、各类 OAuth Provider | 方向相反：它们让 CLI/订阅成为 DSH 的模型，本项目让 DSH 调度 CLI 作为子代理 |
| 委派子任务给本地 CLI | dsh-claude-code (zhangjunjesse)、官方 dsh-subagent-claude-code | 最接近本项目方向，但通常单一 CLI、直接使用用户原生安装，不做统一目录隔离与预设管理 |
| 桥接配置/记忆/技能 | dsh-bridges、dsh-plugin-claude-bridge、dsh-plugin-codex-bridge | 只读复用现有配置，不管理 CLI 本身的安装与运行 |
| 会话迁移/同步 | dsh-codex-migrate、dsh-codex-sync、dsh-plugin-session-import | 解决历史数据，不解决 CLI 运行时管理 |

本项目差异化的核心点：统一目录安装隔离、每个 CLI 可预设 Provider/模型/推理强度/权限、原生子代理式调用（direct / subagent / dispatch 三种模式）。
