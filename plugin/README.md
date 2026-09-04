# dsh-sub-cli

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-sub-cli"><img src="https://img.shields.io/npm/v/dsh-sub-cli?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-sub-cli"><img src="https://img.shields.io/npm/d18m/dsh-sub-cli?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/dingminhua/dsh-sub-cli/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dingminhua/dsh-sub-cli/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dingminhua/dsh-sub-cli?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dingminhua/dsh-sub-cli/stargazers"><img src="https://img.shields.io/github/stars/dingminhua/dsh-sub-cli?style=flat-square" alt="GitHub stars"></a>
  <a href="https://dshfind.com/plugins/dingminhua/dsh-sub-cli"><img src="https://dshfind.com/api/badge/dingminhua/dsh-sub-cli" alt="dshfind plugin"></a>
</p>

在 DeepSeek Harness（DSH）中统一管理外部 Agent CLI 的插件。

- 把 Codex 与 Claude Code 两个 CLI 放到一个**统一目录**（默认 `~/dsh-clis`），不混入系统 PATH（Qwen Code 支持已于 2026-09 移除）；
- 每个 CLI 用**相互隔离的配置目录**（`config-<cli>/`），通过该 CLI 自身的环境变量指向，**完全不碰**你系统里已装的 CLI 配置；
- Web 插件配置卡片可配置统一目录 + 每个 CLI 的**三层模型路由**（Provider → 模型 → 推理强度）；
- 注册 **18 个模型工具**，按"CLI × 模式"覆盖（**只保留带后缀的入口**）：
  - 持续会话（每个 CLI）：`cli_codex_direct` / `cli_claude_direct`（首轮；返回 `sessionId`）+ `cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions` / `cli_<cli>_interrupt`；
  - Relay 子代理（每个 CLI）：`cli_codex_subagent` / `cli_claude_subagent`（创建 DSH continuable 子代理，通过 `managed_cli_submit` 转发到真实 thread）；
  - 无头派发：`cli_dispatch`；
  - 生命周期：`cli_check` / `cli_install` / `cli_test` / `cli_remove`（安装/检测/协议验证/移除）；
  - **18 = 2 direct + 2 subagent + 8 session 工具（followup/status/sessions/interrupt 各 2）+ 1 dispatch + 4 生命周期 + 1 `managed_cli_submit` Relay 内部工具**；
  - `cli_codex` 别名已移除；无后缀的一次性工具 `cli_claude_code` / `cli_qwen` 及其 `managed-<cli>` provider **已删除**——它们没有会话能力，且与 `cli_dispatch` 重复；
    > **并发调度多个 CLI 请用 `cli_<cli>_subagent`**：它返回子代理 id 后立刻继续，多个 CLI 天然并行跑，**不需要后台任务（jobs）插件**。
- 每个 CLI 都有持续会话驱动（Codex: app-server，Claude: stream-json NDJSON），并提供 **`cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions` / `cli_<cli>_interrupt`** 持续会话工具；
- 注册 **`cli_dispatch`** 模型工具，让 DSH 模型无头调用外部 CLI 并回传输出。

## 功能

- **统一目录**：所有 CLI 二进制集中到 `~/dsh-clis/bin/`，配置集中在 `~/dsh-clis/config-<cli>/`；
- **配置隔离**：启动时设置 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 指向统一目录内配置，不触碰系统默认路径；
- **三层模型路由**：每个 CLI 可独立选 Provider → 模型 → 推理强度；
- **无头派发**：`cli_dispatch` 工具用 argv 数组执行 CLI，不用 shell 字符串拼接，处理超时、输出上限、退出码和 stderr；
- **两个 CLI 持续会话**：首轮 `cli_<cli>_direct` 返回稳定 `sessionId`；后续工具直接进入同一 thread——Codex 走 app-server 长连接，Claude 走 `stream-json` 单次进程 + `--session-id`/`--resume` 文件级持久化——不经过 relay 模型；
- **配置持久化**：统一目录与模型路由通过 `installSettingsSection` 写入 `~/.dsh/settings.yaml`，重启后仍生效。
- **会话持久化**：会话注册表（含远程 thread id）写入统一目录的 `sessions.json`，Host 重启后 `cli_<cli>_followup` 直接按 `sessionId` 恢复并 reattach 同一 thread，无需重新创建。
- **自动补全（auto-continue）**：回答看起来提前收尾（只描述计划、未交付结果）时，自动在同一会话内续接追问直到拿到完整结果，单次 `cli_<cli>_direct` 即返回完整报告。每个 CLI 在设置卡里配置续接次数（`max`，默认 3；**设为 0 即关闭**，没有独立开关）。该机制依赖"同一 thread 的 followup"，对所有持续会话式调用生效（Codex/Claude），`INTENT_TAIL` 正则同时识别中英文意图句。

## 各 CLI 内置工具能力

本插件不动 CLI 的工具——CLI 自己有什么工具就用什么。两个 CLI 在 `cli_<cli>_direct` / `cli_<cli>_subagent` 持续会话路径下实际能调用的工具：

| 能力 | Codex (app-server) | Claude Code (stream-json) |
|------|:------------------:|:--------------------------:|
| 文件读写（Read / Write / Edit / Glob / Grep） | ✅ | ✅ |
| Shell 命令（exec / Bash） | ✅ | ✅ |
| 内部子代理（Agent / Task / spawn） | ✅ | ✅ |

> Qwen Code 支持已于 2026-09 移除：其实测可靠性不足（stream-json 不发 tool_use 事件、权限模型依赖单一配置键且被 CLI 启动时重写、多次真机运行出现瞬态失败）。托管 CLI 为 Codex 与 Claude Code 两家。

**分工原则：主控联网调研，CLI 离线执行。**

- **联网搜索 / 调研 / 抓 URL**：由主控用 DSH 自带的 `advanced_search` / `web_fetch` / `platform_search` 直接完成，**两个 CLI 均明确不提供联网搜索功能**（2026-09 产品决策，不再折腾）。技术依据：Codex 的 web_search 与 Claude 的 WebSearch 都是模型供应商的 server-side 工具，中转商路线下基本不被执行。主控的搜索工具链完整且不受这些限制，联网任务直接用它。
- **代码工作（读 / 写 / 改 / 跑命令）**：两个 CLI 完全对称，按习惯选。
- **多步复杂任务**：用 Relay 子代理（`cli_<cli>_subagent`），让子代理持续推进。
- **如需 CLI 处理调研相关材料**：主控先搜好，把材料作为任务内容派给 CLI。

> 设置卡的权限是单一两档下拉：**只读 / 可执行**（2026-09 简化，中间的"可写"档已移除——它是三档里最含糊的：Codex 在该档实际写不了文件（写路径是 exec_command），Claude 的 acceptEdits 边界又比"仅写文件"宽（实测删除命令被静默执行，见 VERIFICATION-FLOW 第十二轮发现 6））。两档语义干净：**只读 = 只能看**；**可执行 = 能跑命令、写/删文件、装依赖**。读取在两档恒为允许；档位启动时定死，无弹窗、无运行中提权，未授权的能力被触发时确定拒绝并清晰报错。文件读写仅限当前工作区内（CLI 自身沙箱把工作区外视为需提权）。

## 安装

在 DSH 中通过插件目录添加：

```bash
dsh plugin --profile desktop add <path>/plugin
```

或作为 npm 包安装：

```bash
npm install dsh-sub-cli
```

## 使用

1. 打开 **设置 → 插件 → 外部 Agent CLI 管理器（dsh-sub-cli）**；
2. 填写或浏览选择 **CLI 统一目录**（默认 `~/dsh-clis`）；
3. 把需要的 CLI 二进制放入 `<目录>/bin/`；
4. 为每个 CLI 选择 Provider、模型、推理强度并保存；
5. 在对话中让 DSH 使用对应 CLI：日常委派用 `cli_<cli>_direct`（持续会话，直连）或 `cli_<cli>_subagent`（DSH Relay 子代理，任务通过子代理转发）；**需要同时调度多个 CLI 时用 `cli_<cli>_subagent`**（返回子代理 id 后立即继续，多个 CLI 并行跑完再回报）；仅在你明确要求"无头跑一次"时才用 `cli_dispatch`。

### 持续会话（所有 CLI）

首轮：

```text
cli_<cli>_direct(description, prompt)  # codex / claude
→ { sessionId, status, output }
```

后续（`cli` = codex / claude）：

```text
cli_<cli>_followup(sessionId, prompt)  # 同一真实 thread
cli_<cli>_status(sessionId)            # 状态、cwd、模型与权限
cli_<cli>_sessions()                   # 当前 Host 的会话列表
cli_<cli>_interrupt(sessionId)         # 中断当前 turn
```

### Relay 子代理（所有 CLI）

每个 CLI 都有 Relay 子代理——DSH 原生 continuable 子代理，任务通过 `managed_cli_submit` 转发给真实 CLI：

```text
cli_<cli>_subagent(description, prompt)  # codex / claude
→ { kind: "continuable", subagentId }
```

之后用 `send_message` 继续、`interrupt_agent` 中断。这些是本插件的专用续接工具，不是 DSH 原生 `send_message`。每个会话同时只允许一个 active turn；重叠 follow-up 会明确返回 `SESSION_BUSY`。

## 配置

| 字段 | 说明 |
|---|---|
| `cliDir` | 统一目录，默认 `~/dsh-clis` |
| `models.<cli>.provider` | 该 CLI 的推理 Provider |
| `models.<cli>.model` | 该 CLI 的模型 |
| `models.<cli>.reasoningEffort` | 该 CLI 的推理强度 |
| `autoContinue.<cli>.max` | 自动补全续接次数（0–10，默认 3；**0 = 关闭**。旧配置的 `enabled:false` 会归一化为 0，字段本身已废弃） |
| `turnTimeoutMinutes.<cli>` | 静默检测点（分钟，3/5/10 三档，默认 5）。到点先探测：进程已退出交由真实结果、仍在输出则继续等并每个活跃窗口自动续期、连续静默 60 秒才判卡死 |

`<cli>` 取值：`codex` / `claude`。

## 环境变量隔离

| CLI | 配置目录环境变量 |
|---|---|
| Codex | `CODEX_HOME` |
| Claude Code | `CLAUDE_CONFIG_DIR` |

## CLI 联网搜索的最终决策（2026-09）

**两个托管 CLI 均不提供联网搜索功能，此事已关闭。** 联网任务一律由主控自带的搜索工具（`advanced_search` / `web_fetch` / `platform_search`）完成。

决策依据（详见根目录 `CLI-WEB-SEARCH-RESEARCH.md` 的完整调研）：

- **Codex**：web_search 是 Responses server-side 工具，执行权在中转商——多数 chat 型中转商不执行；且旧开关形式（`-c tools.web_search=true`）已是 deprecated 别名，新语义默认 `cached`（查索引缓存，不真联网）；
- **Claude**：WebSearch 同为 Anthropic server-side 工具（`web_search_20250305`），中转商转换时实测损坏；WebFetch 虽是本地执行但它只是抓取器，不解决"搜索发现"；
- 结论：三家的搜索在我们的中转商路线上**要么不可用、要么需要额外付费前提**，投入产出不成立，明确降级为"不提供"。

实现层面的对应处理：

- `registry.js` 不再向 codex 传任何 web_search 参数；`verify.js` 的 `qwenSettings()` 不再渲染 webSearch 块（盘上残留块会触发重写以清除）；
- permissions 的工具映射表**保留** WebSearch/WebFetcher → exec 分类——那是权限分类不是功能授予：万一 CLI 侧触发这类工具，仍由 exec 能力开关裁决（未勾选 → 确定拒绝），删映射反而会让未知工具静默放行；
- 未来若要提供"CLI 联网检索"能力，路线是纳入搜索开箱即用的 CLI（如 Gemini CLI，见调研文档第三节），而非修补这三家。

## 本地开发

```bash
npm test        # 运行单元测试
npm pack --dry-run
```

参考 `DEVELOPMENT.md` 与 `PLUGIN_REQUIREMENTS.md`。

## 致谢

本项目的实现建立在他人已公开的工作之上。以下内容如实标注来源与许可证，我们对此保持充分尊重：

### CLI 管理 / Relay 子代理的主参照

- [dingminhua/dsh-subagent-default-model](https://github.com/dingminhua/dsh-subagent-default-model)（MIT，Copyright (c) 2026 LaoDing）— **本项目的主要参照**。多 CLI 注册表、argv 模板、三层模型路由、隔离配置目录、`managed_cli_submit` Relay 子代理形态、DSH Web 卡片样式与发布工程，均从该项目的能力形态中提炼并独立重写。本仓库的 `reference/dsh-subagent-default-model/` 即为该项目的归档实现，仅在本地开发期作为对照，不随包发布。

### 外部 CLI 派发的可行性参考

- [MJorgin/dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor)（MIT，Copyright (c) 2026 MJorgin）— 在 DSH 会话里把任务派给 11 种外部 Agent CLI 的 `subprocess.spawn` 无头执行范式；本插件从中提炼出 argv 数组派发、超时与错误回传、退出码处理的实现细节。

### 协议续接调研（不进入默认链路）

- [wujfeng712-ui/codex-bridge](https://github.com/wujfeng712-ui/codex-bridge)（MIT）— Responses API ↔ Chat Completions 双向转换与 `previous_response_id` 续接的备选协议路径；本项目仅在调研期记录其设计，**未在主链路中引用**，亦未引入其源码或二进制依赖。

### 说明

以上项目的版权归各自作者所有。本项目采用**借鉴设计思路 + 独立实现**的方式，未整体复制任何参考项目的源码；关键模块均为独立编写，并在源文件头部注释中标注了所参考的具体项目与模式。若你发现本项目的标注有遗漏或不当之处，请提交 issue，我们会立即更正。

## 第三方开源依赖

本项目参考的开源项目、其许可证与合规说明，完整记录见根目录的 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。引入新的外部依赖或复用其他项目代码时，请同步更新该文件并遵守对应许可证要求。

## Licence

本项目采用 MIT 许可证，版权归属：Copyright (c) 2026 LaoDing。详见 [LICENSE](LICENSE)。
