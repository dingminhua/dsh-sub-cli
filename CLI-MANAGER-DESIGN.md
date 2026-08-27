# CLI 管理器功能设计草稿（临时，待定稿实现）

> 基于 `dsh-subagent-default-model` 插件扩展，新增「外部 CLI 管理器」功能。
> 设计于 2026-08-24，未实现，待后续推进。
> 本文件是设计意图的**唯一权威记录**：所有设计讨论、调研结论、澄清点均已收敛于此，供新对话直接接续。

## 目标

在 DSH 插件中新增一个「外部 CLI 管理器」，让用户：
1. 把 Agent CLI 下载/安装到统一的指定目录（不与系统 PATH 混用）
2. 每个 CLI 独立配置模型（通过该 CLI 的配置文件或运行时参数）
3. Web 面板呈现已装 CLI 的状态（已装/未装/配置状态）
4. 注册派发工具，让模型调用

## 用户核心意图（对话中确认，实现必须满足）

用户明确强调的四个关键点：

1. **首批范围已确认**——核心支持 Codex、Claude Code，并纳入兼容性较好的 OpenCode、Gemini CLI，共四种。Kimi、Qwen 暂缓；Trae 与 WorkBuddy/CodeBuddy 需进一步验证无头调用、模型控制、认证和配置目录隔离，不属于首批。
2. **调用模型策略与 subagent 一致**——CLI 管理器**复用** `subagent-default-model` 已有的模型策略（single/multi-model + round-robin/random），**不需要为 CLI 再单独设置一套策略**。
3. **下载做好提示**——用**简单语言**引导用户把 CLI 下载到一个**统一目录**（不装到系统目录，避免混用）。
4. **统一目录在插件 Web 里选择**——用户在 Web 面板里选择这个统一目录；Web 同时呈现**已准备好的 CLI**（状态可见），这样 **Skill 就可以调用**它们。

## 统一目录模型

### 跨平台默认值（已确认）

| 系统 | 默认根目录 |
|---|---|
| Windows | `%USERPROFILE%\dsh-clis` |
| macOS | `~/dsh-clis` |

两个平台统一使用当前用户主目录下的 `dsh-clis`。实现时使用系统用户主目录 API（例如 Node.js `os.homedir()`），不写死 Windows 盘符、用户名或 macOS `/Users/...` 路径。

- 用户可在 Web 面板自由选择其他目录；
- 默认值只用于尚未保存自定义目录的情况；
- 用户保存自定义目录后，不再被平台默认值覆盖；
- 插件只使用当前统一目录，不隐式回退系统 `PATH`。

### 目录修改与内容迁移（已确认）

用户修改统一目录后，插件需要把旧目录中由插件管理的 `bin/`、`config-<cli>/` 和托管元数据移动到新目录。要求：

1. 移动前展示源路径、目标路径和内容清单，并要求用户确认；
2. 预检目标目录合法性、写权限、空间和同名冲突；
3. 迁移时暂停 CLI 派发；
4. 同文件系统优先原子重命名，跨文件系统使用复制、校验、切换、删除源流程；
5. 不静默覆盖目标文件，冲突时停止并提示；
6. 全部校验成功后才保存新目录为当前目录；
7. 失败时继续使用旧目录，并清理临时产物、报告错误；
8. 只移动插件管理范围内的内容，不触碰用户系统 CLI 配置；
9. 完成后重新检测 CLI 和配置状态；旧目录不存在或为空时允许直接创建并启用新目录。

目录选择与实际迁移是两个阶段，选择路径本身不能立即破坏当前可用状态。

### 内部结构

以下以 macOS 默认目录为例，Windows 使用同样结构且根目录为 `%USERPROFILE%\dsh-clis`。

```
~/dsh-clis/                      ← Web 面板可选的根目录
├── bin/                          ← 各 CLI 二进制/软链
│   ├── codex → ~/.codex/plugins/.plugin-appserver/codex
│   ├── claude
│   └── qwen
├── config-codex/                 ← 各 CLI 的独立配置（通过环境变量或参数隔离）
│   └── config.toml
├── config-claude/
│   └── settings.json
└── config-qwen/
```

**两层隔离**（对话中确认的关键设计）：
- `~/dsh-clis/bin/` —— 各 CLI 二进制本体（存放进程）
- `~/dsh-clis/config-<cli>/` —— 各 CLI 配置（隔离模型配置，通过环境变量指向）

`bin/` 隔离进程、`config-<cli>/` 隔离配置，二者互相独立。

## 「和用户自己装的没关系」——重要澄清

对话中确认：**放在统一目录里的 CLI，其配置文件完全独立，和用户系统里自己装的那份没关系**。原理是启动时通过环境变量把配置目录指向统一目录内的 `config-<cli>/`，完全不碰系统默认路径（如 `~/.codex/config.toml`、`~/.claude/settings.json`）。**代码示例**：

```bash
# 派 Codex：配置目录指向统一目录内的 config-codex，不影响用户系统安装
CODEX_HOME=~/dsh-clis/config-codex ~/dsh-clis/bin/codex exec "任务"

# 派 Claude Code
CLAUDE_CONFIG_DIR=~/dsh-clis/config-claude ~/dsh-clis/bin/claude -p "任务"
```

用户系统里已有的 `~/.codex/config.toml`、`~/.claude/settings.json` **完全不碰、互不干扰**。

## 不需要写代理（除非跨供应商调动模型）

对话中确认的重要结论：**第一步不需要写代理**。每个 CLI 用它的**原生认证和原生模型**即可，只是配置目录被隔离到了统一位置。跟用户在终端里直接用一模一样，零协议转换、零代理。

**只有**当你想要"让 Codex 用 DeepSeek 模型 / 让 Claude Code 用 Kimi"这类**跨供应商调动模型**时才需要代理（协议翻译层）。

## 参考实现：Cindy（本机已装）

用户机器上的 **Cindy（DSH Desktop 类应用）** 已实现同样的"指定 CLI 模型"能力，是最佳参考：

- 把 Codex 配置目录整体搬到自己的管理路径：`~/Library/Application Support/Cindy/codex-home/`
- 配置 `codex-home/config.toml`：`model_provider = "custom"` + `model_catalog_json` + `[model_providers.custom] base_url = 'http://127.0.0.1:9099/v1'`
- 用本地代理（`anthropic-compat-proxy/proxy.mjs`）接管模型请求，由 Cindy 决定 Codex 能调哪些模型

**关键证**：Cindy 用 `codex-home/` + 代理的方式隔离 Codex 并指定模型，证明 Codex 支持通过环境变量/参数覆盖配置目录。但 Cindy 是**重场景**（跨供应商调动模型，所以需要代理）；你的场景是**轻场景**（每个 CLI 用原生模型），**不需要代理**。

## 各 CLI 配置隔离方式（最终完整调研结论）

| CLI | 配置目录隔离方式 | 运行时指定模型 | 是否支持隔离 | 纳入 |
|---|---|---|---|---|
| **Codex** | `CODEX_HOME` 环境变量（Cindy 已证实，二进制确认） | `-m, --model`；还支持 `-c key=value` 运行时覆盖任何 config、`--profile` | ✅ | 首批 |
| **Claude Code** | `CLAUDE_CONFIG_DIR` 环境变量 | `ANTHROPIC_MODEL` 或 `--model` | ✅ | 首批 |
| **Qwen Code** | `QWEN_HOME` 环境变量（重定向 `~/.qwen` 配置根） | `--model` 运行时模型 | ✅ | 首批 |
| **OpenCode** | `OPENCODE_CONFIG` 环境变量（指定文件路径） | 配置文件 `"model"` 或 `--model` | ✅/文件级 | 已排除 |
| **Gemini CLI** | 隔离路径未实测确认 | 运行时模型选择 | ⚠️ 待实测 | 已排除 |
| **Pi（pi-coding-agent）** | `PI_CODING_AGENT_DIR` 重定向 | `--model`/`--provider` | ⚠️ Windows 需 bash + 项目级 `.pi` 部分隔离 | 已排除 |
| **Kimi CLI** | 已有候选隔离方案 | 有模型参数或环境变量 | ✅/待复核 | 暂缓 |
| **Trae CLI** | 官方 CLI 存在，但独立配置根隔离需验证 | 模型控制能力需实测 | ⚠️ | 暂缓调研 |
| **WorkBuddy / CodeBuddy** | 名称和产品边界需澄清；CodeBuddy 有无头模式文档 | 需按确切产品验证 | ⚠️ | 暂缓调研 |
| Cursor / Copilot / Grok | 通常无满足要求的独立配置目录 | 内置模型为主 | ❌/待确认 | 暂不纳入 |

**范围确认（2026-08-26）**：保留 **Codex + Claude Code + Qwen Code** 三个；OpenCode、Gemini、Pi 已排除（分别因文件级隔离、隔离未验证、Windows 需 bash + 部分隔离）。`Codex` 已安装（二进制在 `~/.codex/plugins/.plugin-appserver/codex`，v0.148.0，但**不在 PATH**）。插件本身不依赖系统 PATH。

### 统一目录内的 `config-<cli>` 实际结构（2026-08-27 实测）

统一目录（默认 `~/dsh-clis`）下每个受管 CLI 有自己的配置隔离子目录：

```
~/dsh-clis/
├── bin/                 # 各 CLI 可执行链接
├── vendor/              # 装到统一目录的官方 npm 包
├── config-codex/        # Codex：CODEX_HOME 指向这里（含 config.toml + 运行时数据）
├── config-claude/       # Claude Code：CLAUDE_CONFIG_DIR 指向这里
└── config-qwen/         # Qwen Code：QWEN_HOME 指向这里
```

注意（实测）：`config-codex/` 里除了用户级 `config.toml`，还混有 Codex 自己生成的**运行时数据**（`*.sqlite`、`sessions/`、`logs_*.sqlite`、`shell_snapshots/`、`.tmp/`、`thread-writer-locks/` 等）。对 Codex 而言 `config.toml` 只是该目录下的配置文件之一，`CODEX_HOME` 把整个目录都当作它的状态根。插件写入模型配置时**只覆盖 `config.toml`**，不要动其它运行时文件。

### Codex `config.toml` 的 TOML 段落顺序陷阱（实测踩坑）

Codex 读 `config.toml` 用的仍是标准 TOML 规则：**不带表头的裸键属于当前最近的 `[table]`**。因此**顶层模型段必须放在所有 `[xxx]` 段（如 `[projects."..."]`）之前**，否则会被静默归入前面的表、模型配置失效、Codex 回退到默认 OpenAI endpoint 并报 401。

❌ 错误顺序（`model = ...` 落在 `[projects]` 之后 → 归入 projects 表 → 失效）：

```toml
[projects."/private/tmp"]
trust_level = "trusted"

model = "kimi-k3"          # ← 归入 projects 表，Codex 读不到，回退 OpenAI → 401
model_provider = "k3-baoyue"
```

✅ 正确顺序（模型段在前，`[projects]` 段后置）：

```toml
model = "kimi-k3"
model_provider = "k3-baoyue"
[model_providers.k3-baoyue]
name = "k3-baoyue"
base_url = "https://api.supxh.xin/v1"
env_key = "K3_BAOYUE_API_KEY"
wire_api = "responses"

[projects."/private/tmp"]
trust_level = "trusted"
```

插件 `verify.js` 的 `codexToml()` 生成的就是这种"模型段在前"的安全顺序；新增/维护该函数时**不得把任何 `[xxx]` 表头插到 `model = ...` 之前**。已运行的 Codex 实例还会生成 `.tmp/`、`*.sqlite` 等运行时文件，写 `config.toml` 前目录结构会自行产生，无需插件预创建（但用 `fs` 写前仍需确保目录存在）。

## 模型方案讨论

### 方案 A（初期推荐）：运行时传参，不动配置文件

派发时直接用 CLI 的参数指定模型，不需要写配置文件：

```bash
# Codex 示例
CODEX_HOME=~/dsh-clis/config-codex codex exec -m gpt-4.1 "任务"

# Claude Code 示例
CLAUDE_CONFIG_DIR=~/dsh-clis/config-claude claude -p "任务"
```

### 方案 B（用户提出的简化思路）：统一走中转商

Web 面板里只提供两个选项（GPT / Claude），插件自动处理 base URL 的 v1 后缀：

- 选 GPT → 自动加 `/v1`（OpenAI 兼容协议）
- 选 Claude → 不加 `/v1`（Anthropic 协议，默认拼 `/v1/messages`）
- 大部分 CLI 都兼容 OpenAI 协议（除 Claude Code 外）

### 模型策略复用（对话中确认的实现方式）

- **复用** `dsh-subagent-default-model` 已有的模型策略机制（single/multi-model + round-robin/random），**不为 CLI 单独设置一套策略**。
- 但需注意一个坑（对话中确认）：subagent 的模型策略能生效，是因为 DSH subagent 的 `agentOptions` 原生支持 `provider`+`model`；**外部 CLI 不支持命令行传 provider/model**（多数走配置文件）。所以"复用策略"有两种落地：
  - **方向 1（写入 CLI 配置）**：round-robin 选出模型 → 写入目标 CLI 的 config 文件 → 调用。但同类模型必须在所有目标的 config 里都有效，否则写入会失败/回退。
  - **方向 2（只调度 CLI，模型留给各 CLI 自己配，推荐起步）**：策略轮换的是"派给哪个 CLI"，每个 CLI 内部用哪个模型由用户在该 CLI 的 config 里单独配好。天然独立。
- **建议：先做方向 2**，让"下载到统一目录 + 状态面板 + 派发工具"全部落地；**方向 1 作为后续增强**（等真需要跨 CLI 轮换同一批模型时再加）。

## 测试功能讨论

### 测试能做什么

1. **连通性测试**：发请求验证 base_url + API key 是否有效
2. **模型列表探测**：`GET {base}/v1/models` 获取中转商支持的模型列表（部分可靠）
3. **CLI 可用性验证**：`codex doctor` 或 CLI 自带诊断命令

### 测试不能做什么

- 不能保证模型的实际质量/限额
- 不能保证 CLI 对某个特定模型的兼容性（Codex 的 wire_api=responses vs Claude 的 messages 协议差异）

### 建议的测试定位

测试只保**连通性**（base_url + key 有效），**不依赖返回的模型列表做决策**。模型怎么选 → 用户手动填模型 ID（自由文本），或插件提供默认值（gpt-4.1 / claude-sonnet-4）。测试通 → 用户知道这个端点能用了，再自己填想用的模型。这样简单、可靠、不骗人。

## 放置位置：插件配置区域（对话中确认）

- CLI 管理器功能应放在 **插件配置区域**（`settings.plugin.item` 或 `settings.section`），**不是** 通用设置（`settings.general.item`）。
- 原因：CLI 管理器信息量大（统一目录选择 + 多个 CLI 列表，每行有状态/模型/测试），挤在一行不合适；它属于插件的配置，放插件配置页更合理。
- 本插件当前先完成了 `subagent-default-model` 设置从 `settings.general.item` → `settings.plugin.item` 的迁移（已做，卡片式）。CLI 管理器可复用同样的 `settings.plugin.item` 卡片模式，或用 `settings.section` 独立页面（信息更密集时）。

## 首期范围建议

### 第一步：最小可用

- Web 面板：统一目录选择 + CLI 列表（已装/未装状态）
- 引导安装：每个 CLI 的安装命令提示（简单语言）
- 派发工具：`cli_dispatch` 工具，按配置路径调用 CLI
- 模型：先不选，用 CLI 默认模型

### 第二步：模型配置

- 每个 CLI 加自由文本模型输入框（填什么写进什么 CLI 的 config）
- 可选：复选 DSH 已有 provider 的 base_url 作为中转商

### 第三步：测试功能

- 连通性测试（验证 base_url + key）
- 模型列表探测（可选）

## 主界面交互与运行模型（2026-08-26 已确认）

### 产品边界

插件分为两个明确入口：

1. **插件设置页负责准备 CLI**：安装引导、统一目录、独立配置、认证提示、版本检测与连通性测试；
2. **主界面负责观察 CLI 工作**：主控 AI 自主决定是否委派以及委派给哪个 CLI，用户不手工创建 CLI 任务。

主界面不得另造「新建 CLI 任务」表单或独立任务管理系统。正常流程是：

```text
用户向主控提出目标
  → 主控 AI 调用一个 CLI 委派工具
  → 工具参数包含简短标题和自包含任务
  → 当前主控会话下出现一个 CLI 子会话
  → 用户查看其状态和完整工作过程
  → 用户或主控向可继续的实例补充消息
  → 用户可停止当前轮次
  → CLI 完成后把结果通知主控
```

### 主界面最小信息

CLI 子会话列表只需要展示：

- 简短任务标题；
- CLI 产品名；
- `运行中 / 可继续 / 已停止 / 失败 / 不可用` 状态；
- 打开详情入口。

点击后使用 DSH 原生 subagent 子会话体验：父子会话导航、历史记录、运行状态、输入框、停止操作和后续消息。首期不新增专用工作台、不要求用户选择模型或手工填写任务。

### 技术决策

- **Host plane** 注册 CLI subagent provider；它属于跨会话共享的 `subagents` registry，不能放进 Agent Preset 私有 realm。
- **Agent Preset** 只贡献面向主控模型的委派工具；工具根据 CLI 选择 provider，并传入 `description`（标题）与 `prompt`（自包含任务）。
- 优先复用 DSH 原生 `SubagentRuntime`、子会话目录、history、prompt、interrupt 和父子导航，不新增第二套 Client 任务状态源。
- 当前 DSH 官方 Codex / Claude Code product provider 为 **one-shot**，不支持产品进程/线程续接。插件不把它们冒充为持续产品会话。
- 本插件为托管 CLI 注册真正的 `SubagentProvider`（one-shot），工具经 `ctx.subagents.start(managed-<cli>, ...)` 派发，把 CLI 输出作为子会话结果返回，不注册任何 LLM provider，因此模型选择器不被污染。CLI 以子会话形式进入 DSH 历史，但每轮都是新的托管 CLI 进程。
- 早期尝试用 LLM adapter 伪装 `dsh-cli-*` route 以实现“持续 DSH 子会话”的做法，因会把私有 route 暴露进全局模型选择器并触发 metadata 校验错误，已废弃。当前以 one-shot provider 为准；如未来需要真正的持续原生 CLI 会话，仍需各产品协议提供可持久化 session id 和 resume 能力。

## “已验证”与模型路由注入（2026-08-27 已确认并落地）

**本意澄清**：`cli_test` 测的不是 DSH 的模型路由，而是**该 CLI 本身能否用所选中转商/模型真正跑通**。为此插件把所选供应商**写进该 CLI 自己的配置**（供应商注入），再真实无头运行一次验证。

### 供应商注入（跨供应商用工，实测可行）

- k3-baoyue 是 OpenAI 兼容供应商，实测支持 **`responses` 协议**（`/v1/responses` 返回 200，`/v1/models` 报 `supported_endpoint_types: ["...","openai-response"]`）。
- **Codex 0.149 只认 `wire_api = "responses"`，不再支持 `chat`**（曾为此踩坑）。给 Codex 配 `config-codex/config.toml`：

  ```toml
  model = "kimi-k3"
  model_provider = "k3-baoyue"
  [model_providers.k3-baoyue]
  name = "k3-baoyue"
  base_url = "https://api.supxh.xin/v1"
  env_key = "K3_BAOYUE_API_KEY"
  wire_api = "responses"
  ```

- `base_url`/`apiKeyEnv` 从 DSH provider 配置读（`settings.describe` 的 `llm-pi-ai.providers.<name>`）；key 每次从 DSH credentials 实时取（`credentials.resolve(apiKeyEnv).value`，不缓存不写死）。
- spawn 时把最新 key 注入该 CLI 的进程环境，Codex 即用所选供应商而非 OpenAI 原生。

### “已验证”指纹 + 调用前预检

1. **指纹**：`fingerprint = hash(provider | model | reasoningEffort | baseURL)`；
2. **测试成功才写**：`cli_test` 实测成功才写 `verified.<cli>`（含指纹）；失败即清除；
3. **调用前预检**：`cli_codex`/`cli_claude_code`/`cli_qwen` 执行前比对当前配置指纹与已验证指纹——一致则**跳过预检直接执行**（省一次探测）；不一致/从未验证则先实测一次（成功→写指纹并执行，失败→拦截返回原因）；
4. **指纹失效**：换 provider / model / reasoningEffort / 供应商（baseURL 变）→ 指纹不匹配 → 设置卡「已通过验证」消失，显示未验证；
5. **失败作废**：指纹有效但执行时失败 → 撤销该指纹，下次调用重新检测；
6. **key 实时**：换 key 不改指纹，但每次调用/预检都用最新 key。

### 供应商工具续接能力（实测：aixforge 对 Codex 的硬限制，2026-08-27）

**发现**：`aixforge`（`https://api.aixforge.com/v1`，`deepseek-v4-flash`）对 Codex 是**半兼容**——
- 单轮纯文本通过：`POST /v1/responses` 返回 200 + `output_text` = `OK`；
- 但 Codex 的联网/工具类任务失败，`turn.failed` 报错：
  ```
  function_call_output requires call_id on HTTP requests;
  continuation via previous_response_id is only supported on Responses WebSocket v2
  ```
- 根因：Codex 需要"多轮工具调用续接"（发起 `function_call`，再把 `function_call_output` 续接回去），而这只有 `Responses WebSocket v2` 支持；aixforge 的 HTTP `/v1/responses` 端点不提供该能力。Codex 联网搜索/跑 shell 工具都依赖此续接，故这类供应商**无法跑真实工具类任务**。

**对验证逻辑的设计影响（必须落地）**：
- `cli_test` **不能只测一次纯文本 `Reply OK` 就判"已验证"**——那会"假通过"工具续接不支持的供应商；
- 验证应包含一次**工具续接探测**：发起带 tool 的两步 responses 请求（第一步让模型返回 `function_call`、拿 `call_id`；第二步带 `function_call_output` 续接），能续接成功才算真正可用于 Codex 工具类任务；
- 探测结果以能力位记录进 `verified.<cli>.capabilities.toolContinuation`（+ `websocketV2`），设置卡可据此展示"仅纯文本 / 可跑工具任务"，预检/派发前据此预警，避免用户以为能联网却实际跑死。

（对比：k3-baoyue 实测支持工具续接，能跑通 Codex 联网任务。）

### 本机实测结论

- `POST https://api.supxh.xin/v1/responses`（带 key）回报 200 + response 对象；
- Codex（0.149）用上述 k3-baoyue 配置 `exec -m kimi-k3 "Reply with exactly: OK"` 实测返回 `OK`、exit 0。

> **核对签名纪律（2026-08-27 教训）**：派发/测试前必须从 DSH 实时读当前 `models.<cli>` → provider 的 `baseURL`/`apiKeyEnv` → credentials 的**最新** key，并核对 `verified.<cli>.fingerprint` 是否仍匹配当前路由；不得用历史会话里缓存过的供应商/key。文中的 k3-baoyue 示例仅为"工具续接可用"的对照，不代表任何用户当前选中的供应商。

### 决策：Codex 测试 = 必须支持 responses 工具续接（2026-08-27 已落地）

Codex 0.149 已移除 `wire_api="chat"`（官方讨论 7782：2026-02 完全移除 chat/completions）。Codex 要跑工具/联网任务必须走 **responses 工具续接**。因此：
- **Codex 的 `cli_test` 不再"纯文本 OK 就算过"**：纯文本通过但工具续接不支持的供应商（如 aixforge `function_call_output requires call_id … WebSocket v2`、k3-baoyue step2 `upstream_error`）会**判失败**，明确告知「当前供应商不支持 Codex 所需的新接口（responses 工具续接），请更换如 modelflare」；
- **Claude / Qwen 保持纯文本检测**（各自协议不同，不以 responses 续接为准）；
- **免代理首选**：`cli_test` 用续接探测选供应商——原生支持 responses 续接的（实测 **modelflare** `openai-responses`，step1+step2 全通）直连、零转换、零端口；chat 型供应商要跑工具任务才需代理，非默认路径。

### CLI 会话续接能力调研（2026-08-27 实测，Codex 原生支持"真续接"）

**结论：Codex 不是"每轮新进程"——它原生支持会话级续接，进程内部上下文完整保留。** 这推翻了早期"one-shot、不支持产品进程续接"的假设，方案 A（continuable 子代理）因此可以做到**真正的进程级续接**，不只是对话记录兜底。

**Codex 三种模式（实测 `codex --help` / `exec --help` / `queue --help`）**：

| 模式 | 命令 | 说明 |
|---|---|---|
| 一次性（headless） | `codex exec --json <task>` | 每次新会话，`--no-persist` 可不落盘 |
| 交互式 TUI | `codex`（无参数，需 TTY） | 全屏界面，会话持续保持；`agents` 浏览本地 app-server 上的会话 |
| **接续已有会话** | `codex exec resume <SESSION_ID> [PROMPT]` / `--last`；`codex queue --thread <id> --message <text>`；`codex exec fork <id>` | **headless 下也能续接**，上下文完整恢复 |

**实测验证（k3-baoyue / kimi-k3）**：
1. 第 1 轮 `codex exec --json -m kimi-k3 "记住秘密数字 42，只回复 DONE"` → 拿 `thread_id=01a040d1-…`；
2. 第 2 轮 `codex exec resume <thread_id> "秘密数字是多少?只回答数字"` → 返回 **`42`** ✅；
3. 上下文确证：第 1 轮 `input_tokens=2505`，第 2 轮 `input_tokens=9096`（历史消息被完整回放入新请求）。

**会话存储位置（与隔离目录兼容）**：`CODEX_HOME/sessions/YYYY/MM/DD/rollout-<thread_id>.jsonl` + `thread_history_*.sqlite`（含 goals/logs/memories/queue/state 多个 sqlite）。`CODEX_HOME` 正是我们隔离到 `config-codex/` 的目录——**会话与配置一起隔离，resume 天然可用**，无需额外路径。

**Claude / Qwen（本机未装，据文档）**：
- Claude Code：`--resume` / `--continue` / `--session-id`，headless `-p` 支持会话接续（官方 agent-sdk sessions 文档）；
- Qwen Code：headless 模式 + session resume（`--resume`，QwenLM/qwen-code PR #1714）。

**对方案 A 的设计影响**：
- continuable 子代理保存 CLI 的 `thread_id`，用户续按时 `codex exec resume <thread_id> <新消息>`（或 `queue` 后台排队续跑），不再是每次新起空会话；
- `queue` 依赖本地 app-server 常驻守护（TUI 模式），无 TTY 环境需验证；`exec resume` 已验证在 headless 下可用；
- 会话隔离在 `config-<cli>/sessions/` 下，卸载/迁移目录时随目录一起迁移，不会串到用户系统默认会话。

### 参考实现：codex-bridge（2026-08-27 记录，备选）

- 仓库：`https://github.com/wujfeng712-ui/codex-bridge`（MIT，Node 单文件零依赖，约 2000 行）。
- 定位：本地协议代理，把 Codex 的 Responses API ↔ 任意 Chat Completions 供应商双向转换（含流式 SSE、思考强度翻译、工具调用回合、`previous_response_id` 会话续接、web_fetch、入站鉴权、多供应商路由）。
- 对比：`completion-to-response`（Go）无状态、`previous_response_id` 续接未实现（step2 报 `messages cannot be empty`）；codex-bridge 带 LRU 响应存储 + `resolveResponseChain`，续接实测成功。
- 集成方式：作为**可选**本地代理，按当前所选 provider 动态生成 env（`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY`/`DEEPSEEK_MODELS` 指向该 provider 的 base_url + 最新 key + model），Codex `base_url` 指向 `127.0.0.1:PORT/v1`，`auth.json` 写入站 key。**需开端口、起常驻服务**，故仅当用户执意用 chat 型供应商且要工具任务时才启用，不进默认链路。

## 已确认事项与剩余决策

- [x] 首批产品方向为 Codex、Claude Code、Qwen Code；Codex 与 Claude Code 为核心。
- [x] 用户只向主控 AI 提需求，不手工创建 CLI 任务。
- [x] CLI 工作以简短标题显示，点击后表现与 subagent 子会话一致。
- [x] 设置页负责安装、测试、配置；主界面负责观察和沟通。
- [x] 派发必须是 DSH Tool，Skill 仅可提供使用指导，不能替代实际 Tool/Provider。
- [x] 模型先留给各 CLI 原生配置，不把 DSH provider/model 目录直接当作 CLI 模型目录。
- [x] 以 DSH 持续子会话承载 follow-up，每轮独立调用外部 CLI。
- [ ] Codex / Claude Code 原生持续产品会话协议与更细粒度进度事件属于后续增强。
- [ ] Codex / Claude Code / Qwen Code 的具体 CLI 版本兼容性仍需真实安装验证。