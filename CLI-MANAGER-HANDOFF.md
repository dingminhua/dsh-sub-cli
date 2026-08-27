# CLI 管理器项目转交文档（Handoff）

> **用途**：这是把「外部 Agent CLI 管理器」从 `dsh-subagent-default-model` 插件中**拆分出来、独立成新项目**的完整转交文档。
> 新项目里的 AI **只需读取本文件即可完整理解设计意图并开始开发**，无需依赖任何旧对话上下文。
> 编写时间：2026-08-25。本文件自包含，含设计、调研结论、技术验证、参考实现、本机现状、建议开发路径。

---

## 0. 一句话概述

在 DSH（DeepSeek Harness）中做一个**独立的「外部 Agent CLI 管理器」插件**，首批支持 Codex、Claude Code、OpenCode 和 Gemini CLI，把它们下载/安装到**统一的指定目录**（不与系统 PATH 混用），在 Web 面板里**呈现已装/未装状态**、**选择统一目录**、**为每个 CLI 独立配置模型**，并注册**派发工具/技能**让模型调用，复用 `subagent-default-model` 的模型轮换策略。

---

## 1. 设计目标

1. **统一目录**：把各 Agent CLI 的二进制集中放到一个用户可选的目录（Windows 默认 `%USERPROFILE%\dsh-clis`，macOS 默认 `~/dsh-clis/`），避免散落系统 PATH；用户修改目录后迁移插件托管内容。
2. **每个 CLI 独立配置模型**：各 CLI 用各自的配置目录（隔离），模型独立。
3. **Web 面板**：
   - Web 里选择统一目录；
   - 呈现已准备好的 CLI（已装 ✅ / 未装 ❌ / 配置状态）；
   - 引导/提示安装命令（简单语言）。
4. **派发**：注册工具/技能，按配置路径调用目标 CLI，结果回传会话；**Skill 可以调用**这些准备好的 CLI。

---

## 2. 用户核心意图（必须满足）

1. **首批范围已确认**：Codex、Claude Code 是核心支持；另外纳入 OpenCode 和 Gemini CLI，共四种。选择标准是无头调用、模型选择和配置隔离能力及其公开文档较成熟。Trae 与 WorkBuddy/CodeBuddy 暂不纳入首批：Trae 虽有官方 CLI 文档，但仍需验证独立配置目录和模型控制是否满足本项目隔离要求；“WorkBuddy”产品命名与可调用 CLI 边界不够清晰，而公开无头模式资料主要指向 CodeBuddy CLI，后续应单独调研，不以名称相似直接视为兼容。
2. **模型策略复用 subagent 的**：不单独设一套策略，复用 `dsh-subagent-default-model` 已有的 single/multi-model + round-robin/random。
3. **下载做好提示**：用**简单语言**引导用户下载到统一目录，不装到系统目录。
4. **统一目录在 Web 面板选择** + **呈现已装 CLI**，这样 **Skill 可调用**。

---

## 3. 统一目录模型（两层隔离）

### 3.1 跨平台默认目录与用户自选目录（已确认需求）

- Windows 默认根目录：`%USERPROFILE%\dsh-clis`；
- macOS 默认根目录：`~/dsh-clis`；
- 两个平台都采用“当前用户主目录下的 `dsh-clis`”这一相同语义；实现时应使用系统用户主目录 API（例如 Node.js `os.homedir()`），不得根据用户名或盘符手工拼接路径；
- 默认值仅在用户尚未保存自定义目录时生效；
- 用户可以在 Web 面板中选择并保存其他目录；保存后始终使用用户选择，不再用平台默认值覆盖；
- 插件只从当前生效的统一目录查找和调用 CLI，不隐式回退系统 `PATH`。

### 3.2 修改目录时迁移已有内容（已确认需求）

当用户把统一目录从旧目录修改为新目录时，插件必须提供迁移流程，将旧目录中由本插件管理的内容移动到新目录，包括 `bin/`、所有 `config-<cli>/` 以及后续新增的插件托管元数据。迁移行为必须满足：

1. Web 明确展示源目录、目标目录和将迁移的内容，并由用户确认后执行；
2. 迁移前校验目标路径、写权限、可用空间以及目标目录冲突；
3. 迁移期间暂停新的 CLI 派发，避免配置或文件在移动过程中被使用；
4. 优先使用同文件系统的原子重命名；跨文件系统时采用“复制到临时目录 → 校验 → 原子切换 → 删除源”的流程；
5. 不覆盖目标目录中的既有文件；发现冲突时停止并列出冲突，由用户处理或另选目录；
6. 只有全部内容迁移并校验成功后，才把保存的当前目录切换为新目录；
7. 失败时保持旧目录配置继续有效，清理未完成的临时文件，并向用户报告可恢复的错误；
8. 不移动用户系统默认配置或插件管理范围以外的文件；
9. 迁移完成后重新检测每个 CLI 的安装、版本和配置状态；
10. 如果旧目录不存在或为空，可以直接创建并启用新目录，但仍需清楚反馈结果。

目录选择与迁移应是两个阶段：选择路径不会立即破坏现状；用户确认迁移后才执行移动和配置切换。

### 3.3 目录结构

以下以 macOS 默认目录为例；Windows 使用同样的内部结构，只把根目录换为 `%USERPROFILE%\dsh-clis`。

```
~/dsh-clis/                      ← Web 面板可选的根目录
├── bin/                          ← 各 CLI 二进制/软链（进程本体）
│   ├── codex → ~/.codex/plugins/.plugin-appserver/codex
│   ├── claude
│   └── qwen
├── config-codex/                 ← 各 CLI 独立配置（通过环境变量或启动参数隔离）
│   └── config.toml
├── config-claude/
│   └── settings.json
└── config-qwen/
```

**两层各自独立**：
- `bin/` 隔离**进程**（二进制本体）；
- `config-<cli>/` 隔离**配置**（模型配置，通过环境变量指向）。

**「和用户自己装的没关系」**：启动时用环境变量把配置目录指向统一目录内的 `config-<cli>/`，**完全不碰**用户系统默认路径（`~/.codex/config.toml`、`~/.claude/settings.json` 等）。用户系统里已经装的那份完全不受影响。

代码范式：
```bash
# 派 Codex：配置目录指向统一目录内 config-codex，不影响系统安装
CODEX_HOME=~/dsh-clis/config-codex ~/dsh-clis/bin/codex exec "任务"

# 派 Claude Code
CLAUDE_CONFIG_DIR=~/dsh-clis/config-claude ~/dsh-clis/bin/claude -p "任务"
```

---

## 4. 重要技术结论：不需要写代理

**第一步不需要代理。** 每个 CLI 用它的**原生认证 + 原生模型**，只是配置目录被隔离到统一位置。与用户直接在终端里用一模一样，零协议转换、零代理。

**只有**当你想做「让 Codex 用 DeepSeek / 让 Claude Code 用 Kimi」这类**跨供应商调动模型**时，才需要写代理（协议翻译层，因为 Codex 只认 OpenAI `responses` 协议，要转到别的供应商 API 需要转换）。

---

## 5. 各 CLI 配置隔离方式（最终调研结论）

| CLI | 配置目录隔离方式 | 运行时指定模型 | 是否支持隔离 | 纳入 |
|---|---|---|---|---|
| **Codex** | `CODEX_HOME` 环境变量（二进制确认；Cindy 实证） | `-m, --model`；`-c key=value` 运行时覆盖任意 config；`--profile` | ✅ | 首批 |
| **Claude Code** | `CLAUDE_CONFIG_DIR` 环境变量 | `ANTHROPIC_MODEL` 或 `--model` | ✅ | 首批 |
| **Qwen Code** | `QWEN_HOME` 环境变量（重定向 `~/.qwen` 配置根） | `--model` 运行时模型 | ✅ | 首批 |
| **OpenCode** | `OPENCODE_CONFIG` 环境变量（指定文件路径） | 配置文件 `"model"` 或 `--model` | ✅/文件级 | 已排除 |
| **Gemini CLI** | 隔离路径未实测确认 | 支持运行时模型选择 | ⚠️ 待实测 | 已排除 |
| **Pi（pi-coding-agent）** | `PI_CODING_AGENT_DIR` 重定向 | `--model`/`--provider` | ⚠️ Windows 需 bash + 项目级 `.pi` 部分隔离 | 已排除 |
| **Kimi CLI** | 已有候选隔离方式 | 支持模型参数/环境变量 | ✅/待复核 | 暂缓 |
| **Trae CLI** | 官方 CLI 文档存在，但独立配置根隔离仍需实测 | 有模型相关设置，是否满足完整外部控制待验证 | ⚠️ | 暂缓调研 |
| **WorkBuddy / CodeBuddy** | 产品命名和 CLI 边界需先澄清；CodeBuddy 有无头模式文档 | 能力需按确切产品重新验证 | ⚠️ | 暂缓调研 |
| Cursor / Copilot / Grok | 通常无满足本项目要求的独立配置目录 | 内置模型为主 | ❌/待确认 | 暂不纳入 |

---

## 6. 参考实现

### 6.1 dsh-agent-conductor（Cross-agent dispatch，已调研）

仓库：`https://github.com/MJorgin/dsh-agent-conductor`

提供在 DSH 会话中把自包含任务派给 **11 种外部 Agent CLI**（Codex、Claude Code、Trae、OpenCode、Gemini、Cursor、Kimi、Qwen、Copilot、WorkBuddy、Grok）在**无头模式**下执行并把 stdout 回传的工具 `conductor_dispatch`：

```js
// index.js 里的 Agent 注册表
const AGENTS = [
  { id: 'codex', name: 'Codex', argv: ['codex', 'exec', '{task}'], ... },
  { id: 'claude-code', name: 'Claude Code', argv: ['claude', '-p', '{task}', '--output-format', 'text'], ... },
  // ... 11 种
]
```

- **用 `subprocess.spawn` 调用外部 CLI**（`skills/conductor/scripts/dispatch.py` 是零依赖版，`index.js` 是 bundle 版）；
- **任务必须自包含**（对方看不到本会话上下文）；
- **host-only**，无 client UI，纯命令行式，卡片是 `presentCall: { card: 'generic', title: '指挥家 → codex' }`（默认文本卡片，无交互面板）；
- **Roadmap 里有 Panel UI 但未实现**。

**对你有价值的部分**：
- Agent 注册表设计（`{id, name, argv, install}`）；
- `argv` 里用 `{task}` 占位替换；
- `dispatch.py` 零依赖工程哲学；
- 未安装时的报错 + 安装提示（`${name} 未安装（或不在 PATH）。安装：${install}`）。

**不足/你的差异化**：Conductor **不管理目录**（直接用系统 PATH）、**不隔离配置**（不设 `CODEX_HOME` 等）、**不能独立配模型**、**无 Web 面板**、**模型策略不轮换**。你做的正是补上这些：统一目录 + 配置隔离 + 独立配模型 + Web 面板 + 复用 subagent 策略。

### 6.2 Cindy（本机已装，最佳配置隔离参考）

Cindy 是一个 DSH 类桌面应用，**已经实现了「给 Codex 指定模型」**：
- 把 Codex 配置目录整体搬到 `~/Library/Application Support/Cindy/codex-home/`；
- 配置 `codex-home/config.toml`：
  ```toml
  model_provider = "custom"
  model_catalog_json = '.../codex-home/model-catalogs/codexhub-model-catalog.json'
  [model_providers.custom]
  name = "Codex Proxy"
  base_url = 'http://127.0.0.1:9099/v1'
  wire_api = "responses"
  ```
- 用本地代理（`anthropic-compat-proxy/proxy.mjs`）接管 Codex 的模型请求。

**关键证**：Cindy 用 `codex-home/` 隔离 Codex 配置并指定模型，**证明 Codex 支持通过配置目录覆盖（CODEX_HOME）来隔离 + 指定模型**。但 Cindy 是**重场景**（跨供应商调模型，需要代理）；你的**轻场景不需要代理**。

---

## 7. 本机现状（开发环境实测）

- **已装**：Codex（二进制 `~/.codex/plugins/.plugin-appserver/codex`，v0.148.0），但**不在 PATH**，需 `ln -s ~/.codex/plugins/.plugin-appserver/codex ~/.local/bin/codex`。
- **待准备并实测**：Claude Code、OpenCode、Gemini CLI；实现时按各自官方安装方式放入统一目录，不依赖系统 PATH。
- **Cindy 已装**，其 `codex-home/` 配置可作为隔离参考（见 6.2）。
- npm 登录账号：`dmh2002`（发布用，账号开启 2FA，交互式发布需浏览器确认）。
- 代理：本机有 `http://127.0.0.1:7897`（Clash），已配置 npm/git 走代理（访问 GitHub/npm 更稳）。
- LDVH 项目（`/Users/dmh2002/poker_hud_projects/ld-vibe-harness-v4`）中有大量 DSH 插件调研积累（dshfind 源码等），需要时可参考。

---

## 8. 建议技术实现路径

### 8.1 参考现有插件模式（`dsh-subagent-default-model`）

现有插件已把设置面板迁移到**插件配置卡片**（`settings.plugin.item`），这是可复用的卡片模式：

- Host 端 `plugin/lib/index.js`：
  ```js
  export const name = "dsh-subagent-default-model";
  export const inject = ["subagents", "settingsScope"];  // 注入 settingsScope
  installSettingsSection(ctx, ns, schema, entry, { setSource, onChange }); // 注册 settings namespace
  // 包装服务 / 注册工具
  ```
- Client 端 `plugin/lib/client.js`：
  ```js
  // 卡片外壳（默认收起，样式与其它可配置插件一致）
  function SubagentModelCard(props) {
    const [open, setOpen] = React.useState(false);
    return React.createElement("li", { className: "dsm-plugin-card" + (open ? " dsm-plugin-card-open" : "") },
      React.createElement("button", { type: "button", className: "dsm-plugin-card-header", ... },
        title + description + chevron),
      React.createElement("div", { className: "dsm-plugin-card-body", hidden: !open },
        React.createElement(SubagentModelRow, props)));
  }
  // 注册到 settings.plugin.item
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item", key: "subagent-default-model", locale: "...", inject: subagentCardInjected,
  }, SubagentModelCard));
  ```
- 卡片外壳 CSS（`dsm-plugin-card*`，与系统 `PluginCard` 同款圆角/边框/折叠/hover/间距）已在该插件 `SETTINGS_CSS` 里实现，可移植。

### 8.2 建议的三步落地

**第一步（最小可用）**：
- Web 面板：统一目录选择 + CLI 列表（已装/未装）；
- 引导安装：每 CLI 的安装命令提示（简单语言）；
- 派发工具：`cli_dispatch`，按配置路径调用目标 CLI；
- 模型：先不选，用 CLI 默认模型。

**第二步（模型配置）**：
- 每 CLI 加自由文本模型输入框（填什么写进该 CLI 的 `config-<cli>/`）；
- 可选：复用 DSH 已有 provider 的 base_url 作为中转商。

**第三步（测试功能）**：
- 连通性测试（验证 base_url + key）；
- 模型列表探测（可选）。

### 8.3 模型策略落地的两个方向（需在开发时定稿）

复用 subagent 策略时注意一个坑：subagent 的模型策略能生效，是因为 DSH subagent 的 `agentOptions` 原生支持 `provider`+`model`；**外部 CLI 不支持命令行传 provider/model**（多数走配置文件）。所以有两条路：

- **方向 1（写入 CLI 配置）**：round-robin 选出模型 → 写入目标 CLI 的 `config-<cli>/` → 调用。要求所列模型在所有目标 CLI 的 config 里都有效，否则写入失败/回退。
- **方向 2（只调度 CLI，模型留给各 CLI 自己配，推荐起步）**：策略轮换的是「派给哪个 CLI」，每个 CLI 内部用哪个模型由用户在该 CLI 的 config 里单独配好。天然独立，最稳。

**建议先做方向 2**，让「统一目录 + 状态面板 + 派发工具」全部落地；方向 1 作为后续增强（等真需要跨 CLI 轮换同一批模型时再加）。

---

## 9. 测试功能定位（设计确认）

- **测试能**：①连通性（验证 base_url+key）；②`GET {base}/v1/models` 列模型（部分可靠）；③`codex doctor` 等 CLI 自带诊断。
- **测试不能**：保证模型质量/限额；保证 CLI 对某具体模型的兼容性（Codex `wire_api=responses` vs Claude `messages` 协议差异）。
- **建议定位**：测试只保**连通性**，**不依赖模型列表做决策**。模型用自由文本填，插件给默认值（gpt-4.1 / claude-sonnet-4）。

测试的实际验证（对话中实测过）：
- Codex `--version` → `codex-cli 0.148.0-alpha.9` ✅；
- Codex `--model`、`-c key=value`、`--profile`、`CODEX_HOME` 均可用（源码/二进制确认）；
- `codex doctor` 可诊断 auth / websocket / terminal 状态。

---

## 10. 放置位置（设计确认）

CLI 管理器放**插件配置区域**（`settings.plugin.item` 或独立 `settings.section`），**不是**通用设置（`settings.general.item`）。原因：信息量大（目录选择 + 多 CLI 列表），一行放不下；属插件配置，放插件配置页更合理。信息更密集时可用 `settings.section` 独立页面。

---

## 11. 待确认事项（开发决策点）

- [x] 首批纳入 Codex、Claude Code、OpenCode、Gemini CLI；Codex 与 Claude Code 为核心支持，OpenCode 与 Gemini CLI 为兼容性扩展。
- [ ] 模型策略：确认走「方向 2（只调度 CLI）」还是「方向 1（写入 CLI 配置，跨 CLI 轮换同一批模型）」
- [ ] 测试功能做到什么程度？（建议先只做连通性）
- [ ] 派发注册为 DSH Tool 还是 Skill？（用户提到「Skill 可调用」，倾向 Skill）
- [ ] 新插件独立成仓库，还是引用 `dsh-subagent-default-model` 的模型策略/卡片模式？
- [ ] npm 包名、命名空间、是否发布到 dshfind 市场

---

## 12. 主界面产品决策（2026-08-26 补充）

### 12.1 不做手工任务工作台

用户只向当前主控 AI 提出目标。主控 AI 自主选择是否调用外部 CLI、选择哪个 CLI，并生成简短标题与自包含任务。主界面不提供“新建 CLI 任务”、工作目录表单或人工调度面板。

### 12.2 CLI 工作必须表现为子会话

主控安排后，当前会话的子代理目录中出现 CLI 工作实例。列表仅展示标题、CLI 产品、状态和打开入口。打开实例后复用 DSH 原生 subagent 会话界面，包括：

- 父子会话导航；
- 完整历史与执行输出；
- 运行中/可继续/停止/失败状态；
- 对 continuable provider 的后续消息；
- 当前轮次停止；
- 完成后自动通知父级主控。

不要为这些能力维护第二套 Client 状态、历史或任务数据库。

### 12.3 Composition 边界

- CLI provider 注册到 Host 的共享 `subagents` registry；
- 面向模型的委派 Tool 属于 Agent Preset；
- 设置卡仍由当前插件 Client 入口提供；
- Skill 可以说明何时使用 CLI，但真正派发必须通过 Tool/Provider。

### 12.4 当前平台能力与分阶段实施

DSH 原生 subagent API 已提供父子目录、history、prompt、interrupt、运行状态和父级通知。官方 `@deepseek-ai/dsh-subagent-codex` 与 `@deepseek-ai/dsh-subagent-claude-code` 当前版本只实现 one-shot provider：它们能进入原生 subagent 生命周期并返回最终文本，但明确不支持续接、进度流或产品会话持久化。

当前实现为托管 CLI 注册真正的 `SubagentProvider`（one-shot），工具经 `ctx.subagents.start(managed-<cli>, ...)` 派发，把 CLI 输出作为子会话结果返回。由于不注册任何 LLM provider，模型选择器不会被 `dsh-cli-*` route 污染。

实现约定：

1. 每个托管 CLI 一个 one-shot `SubagentProvider`（`managed-codex` / `managed-claude` / `managed-qwen`）；
2. `cli_codex` 等三个工具调用对应 provider，把 CLI 输出作为子 Agent 结果；
3. CLI 以子会话形式进入 DSH 历史，但每轮启动新的托管 CLI 进程，不得声称复用了同一个 Codex thread 或 Claude SDK session；
4. 曾试验用 LLM adapter 伪装 `dsh-cli-*` route 以实现持续子会话，因会把私有 route 暴露进全局模型选择器并触发 metadata 校验错误，已废弃。

范围（2026-08-26 确认）：保留 **Codex + Claude Code + Qwen Code**；OpenCode、Gemini、Pi 已排除。发布前仍需对三个 CLI 的真实安装版本验证参数、认证隔离、取消与输出格式。

---

## 13. 当前实施进度（2026-08-27，供后续接续）

### 产品定位（已确认）

插件**设置卡只做两件事**：① 选**统一安装目录**（切换目录会同时移动该目录下插件托管内容）；② 为**每个 CLI 选它要用的模型**（Provider/Model/Effort）。**其余全部操作交给主控 A**，由用户在对话里用自然语言触发（见第 12 节工具清单与底部指南）。

### 已完成

- **平台启动崩溃修复**：移除 Schemastery `z.object(...).partial()`、未定义 `require`、残缺 LLM adapter 调用；
- **废弃 LLM adapter 伪 Provider**：不再用 `ctx.llm.registerAdapter()` 把 `dsh-cli-*` 注册成 LLM route（会污染模型选择器并触发 `invalid metadata`）；
- **托管 CLI SubagentProvider**（`plugin/lib/provider.js`）：`managed-codex` / `managed-claude` / `managed-qwen`，one-shot；
- **全局 CLI 工具**（`plugin/lib/subagent-tools.js`）：`cli_codex` / `cli_claude_code` / `cli_qwen`，任意工作模式可用；
- **管理工具**（`plugin/lib/index.js`）：`cli_install`（装官方 npm 包到统一目录）、`cli_check`（检测/版本）、`cli_test`（实测该 CLI 用所选中转商/模型能否跑通，非 DSH 路由）、`cli_remove`（只删统一目录托管文件）、`cli_dispatch`（一次性无头）；
- **验证记录（2026-08-27 重构）**：`verified.<cli> = { ok, version, at, provider, model, reasoningEffort, fingerprint, error? }`，`fingerprint = hash(provider|model|effort|baseURL)`；`cli_install` 不再写验证（安装≠可行），只有 `cli_test`/预检实测才写；**失败也记录**（`ok:false` + `error` 原因 + fingerprint），配置变更则旧结论（通过或失败）都随指纹不匹配而消失；
- **测试本意（已澄清）**：把所选供应商（baseURL + 最新 key + `wire_api=responses`）写进该 CLI 自己的配置（Codex `config-codex/config.toml`），再 `codex exec -m <model> "Reply exactly: OK"` 真实跑一次，能回含 OK 才算通过；该中转商不支持相应协议（如 Codex 需 `responses`）就明确反馈「该代理不支持 Codex」；
- **供应商注入（实测可行）**：写 `model_provider`/`base_url`/`env_key`/`wire_api=responses`/`model` 进 CLI 配置，并在 spawn 时从 DSH credentials 实时注入最新 key（`credentials.resolve(apiKeyEnv).value`，不缓存不写死）。Codex 0.149 只认 `responses`，不再支持 `chat`；k3-baoyue 实测支持 `responses`（`/v1/responses` 200）；
- **调用前预检 + 指纹失效**：`cli_codex`/`cli_claude_code`/`cli_qwen` 执行前比对当前配置指纹与已验证指纹——一致则跳过预检直接执行；不一致/从未验证则先实测一次（成功→写指纹并执行，失败→拦截返回原因）；执行时失败会作废该指纹（下次重新检测）；
- **key 实时最新**：预检/实测/注入都每次从 DSH credentials 取最新 key，永不缓存；换 key 不改变指纹，但每次执行都用最新 key；
- **统一目录真实结构（实测）**：`~/dsh-clis/{bin,vendor,config-codex,config-claude,config-qwen}`；`config-codex/` 里混有 Codex 运行时数据（`*.sqlite`、`sessions/`、`logs_*.sqlite`、`shell_snapshots/`、`.tmp/` 等），插件写模型配置**只覆盖 `config.toml`**；
- **TOML 顺序陷阱（实测踩坑）**：Codex `config.toml` 的顶层模型键必须在所有 `[xxx]` 段（如 `[projects."..."]`）**之前**，否则被归入错误表、失效、回退默认 OpenAI → 401；`codexToml()` 生成"模型段在前"的安全顺序；
- **Codex 0.149 只认 `wire_api="responses"`**（不再支持 `chat`）；k3-baoyue 实测支持 responses；<code>`cli_codex` 在 supplier 配置未写入本机 `config-codex/config.toml` 时会回退 OpenAI 401</code>（这正是供应商注入要解决的）；
- **Codex 0.149 只认 `wire_api="responses"`**（不再支持 `chat`，官方讨论 7782 已于 2026-02 移除）；k3-baoyue 单轮 OK 但续接 500；aixforge chat 型续接 400；**modelflare 原生 responses 续接实测通过**；
- **Codex 测试改为"必须支持续接" + 失败原因随配置消失**：`cli_test` 对 Codex 额外做工具续接探测，纯文本通过但续接不支持 → **判失败**并写失败记录（`ok:false` + error 原因 + fingerprint）；设置卡按指纹匹配分三态显示——通过（绿）/失败原因（红）/未验证（换配置后旧结论消失）；Claude/Qwen 保持纯文本检测；
- **免代理首选**：续接探测通过的供应商（modelflare）直连，零转换零端口；chat 型供应商跑工具任务才需代理，非默认路径；
- **Token 顺序陷阱 + 会话接续（实测）**：Codex 顶层 model 键必须在所有 `[xxx]` 段之前；**Codex 原生支持会话级续接**——`codex exec resume <thread_id> [prompt]`（headless 可用）、`codex queue --thread <id> --message`（依赖 app-server 常驻）、`codex exec fork`；会话存 `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<thread_id>.jsonl`（`CODEX_HOME` 即隔离的 `config-codex/`，天然随目录迁移）。实测 kimi-k3：第 1 轮记秘密数字 42，resume 验证返回 42、input_tokens 从 2505→9096（历史完整回放）。**方案 A 用 resume 实现真续接**，不再"每轮新空会话"；Claude 有 `--resume/--session-id`，Qwen 有 `--resume`（本机未装，据文档）；
- **参考实现 codex-bridge（记录备选）**：`https://github.com/wujfeng712-ui/codex-bridge`（MIT、Node 单文件零依赖）——本地协议代理，Responses↔Chat 双向转换 + `previous_response_id` 会话续接；对比 `completion-to-response`（Go，无状态，续接 bug）。**需开端口起服务**，仅当用户执意用 chat 型供应商且要工具任务时才启用；
- **核对签名纪律（教训）**：派发/测试前实时读当前 `models.<cli>`→provider `baseURL`/`apiKeyEnv`→credentials 最新 key，并核对 `verified.<cli>.fingerprint`；不得沿用历史会话缓存的供应商/key；
- **目录自动迁移**：Host 监听 `cliDir` 变化，把旧目录的 `bin/`、`config-<cli>/`、`vendor/` 移到新目录，目标存在则不覆盖；macOS `mv` / Windows `cmd move`；
- **`subagents` 硬依赖**：`inject = ["tools","subprocess","subagents"]`；
- **`@Remote` 标记**：`lib/remote.js` 让 `CliService` 方法暴露（说明：bundle 插件客户端 `api` 只含 curated 命名空间，`api.cli` 无法到达设置卡，故设置卡不依赖它）；
- **设置卡精简**：去掉操作按钮，只留目录 + 每 CLI 模型配置 + 底部「主控可调用工具」指南（含人话触发语）；
- **安装命令修复**：去掉 `#` 注释行（zsh 报错）、`~/` 转 `$HOME`、补建 `bin` 目录；
- **Windows 适配**：`paths`（`node:path` + `binName` .cmd）、`status`（`exists` 回调替代 `/bin/test` + `winShimArgv`）、`dispatch`/`provider`（`winShimArgv` 用 `cmd.exe` 包 `.cmd`）、`install`（PowerShell + `Copy-Item`）、`manage`（win32 `del`）、`index`（迁移 `cmd move`）；
- **当前测试**：`plugin/test` 共 **49** 项全部通过（`node --test test/*.test.mjs`，含新增 `verify.test.mjs` 的指纹/供应商注入/失效逻辑）。

### 尚未实现 / 待做

1. **Windows 实机验证**：见 `WINDOWS-HANDOFF.md`（A–F 项：安装、检测、连接测试、删除、目录迁移、子代理 Provider）。Windows 分支按最佳实践实现，未经 Windows 实机验证；
2. **Windows 验证记录/迁移的实机确认**：`verified` 写入设置、`migrateDir` 的 `cmd.exe if not exist ... mkdir`/`move` 是否真正工作需在 Windows 跑；
3. **真实“更新”对比新版本**：`cli_install` 复用 npm latest 即更新；如需“是否有新版本”的显式判断可后续加；
4. **设置卡「打开即读验证状态」路径核验**：当前通过 settings `verified` 读到并显示；刷新/重开设置卡即可看到，无 host RPC。

### 当前交还状态（2026-08-27，未解决）

- Human 已重启 DSH 并要求真实测试。当前路由由 Human 故意设置为 `aixforge / deepseek-v4-flash / high`，不是缺省配置。
- `cli_test(codex)` 先暴露 Provider 读取问题；已修正为 `ctx.get("settings")` / `ctx.get("llm")` / `ctx.get("credentials")`，并按 configurable provider 的 `settingsNs + settingsPath` 读取 `llm-pi-ai.providers.aixforge`。
- 修复后曾出现 `value is not lossless JSON`：原因是 probe 返回 `toolContinuation`，代码误读 `gate.ok` 造成 `undefined` capability；源码已修复为 `gate.toolContinuation`，但 DSH 运行时需重新加载后复测。
- UI 仍将实际存在的 `~/dsh-clis/bin/codex` 显示为「未安装」。Client 已从直接拼接路径改为调用 Host 的 `remote.cli.check()`，Host 的 `CliService.check` 使用 `resolveDir()` + `fs.lstat()`；该修复尚未在 GUI 中确认生效。注意 `cliDir: ""` 必须解析为默认 `~/dsh-clis`，不能由浏览器直接把空字符串拼成 `/bin`。
- 用户选择暂时切换其他 AI 继续排查；后续接手者先核实运行时 bundle、remote 返回 envelope 与实际 `dir/results`，不得把 62/62 单测通过写成 GUI 问题已解决。


- `plugin/lib/index.js`：Host（设置、工具、迁移、验证记录、`CliService`）；
- `plugin/lib/provider.js`：托管 CLI `SubagentProvider`；
- `plugin/lib/subagent-tools.js`：`cli_codex`/`cli_claude_code`/`cli_qwen`；
- `plugin/lib/install.js`：`installManagedCli` + `installCommandOf`；
- `plugin/lib/manage.js`：`removeManagedCli` + `testManagedCli`；
- `plugin/lib/{paths,status,dispatch,remote}.js`；`lib/client.js`：设置卡 UI；
- `plugin/test/*.test.mjs`：单元回归（40 项）。

---

## 14. 关联资源

- 原插件：`dsh-subagent-default-model`（`/Users/dmh2002/DshProject/dsh-subagent-default-model`），其 `plugin/lib/client.js` 的卡片模式、`plugin/lib/index.js` 的 `installSettingsSection` + `settingsScope` 模式可直接复用。
- 设计文档：`CLI-MANAGER-DESIGN.md`（同目录，更精简的设计要点版）。
- 参考项目：
  - dsh-agent-conductor（外部 CLI 派发，仓库 `MJorgin/dsh-agent-conductor`）
  - Cindy（本机 `/Applications/Cindy.app`，配置隔离参考）
- DSH 内置市场插件目录：`/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins`（卡片/插槽实现参考）。
- 兼容性调研入口（访问于 2026-08-25）：
  - TRAE CLI 命令行参数：<https://docs.trae.cn/cli_command-line-parameters>
  - TRAE CLI 全局设置：<https://docs.trae.cn/cli_global-settings>
  - CodeBuddy CLI 无头模式：<https://www.codebuddy.ai/docs/cli/headless>
  - CodeBuddy CLI 参考：<https://www.codebuddy.ai/docs/cli/cli-reference>

> 上述链接只能证明存在相应公开入口；在实现中声明“完整兼容”前，仍须对具体版本实测无头调用、模型参数、认证隔离和配置目录隔离。
