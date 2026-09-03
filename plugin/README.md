# dsh-sub-cli

在 DeepSeek Harness（DSH）中统一管理外部 Agent CLI 的插件。

- 把 Codex、Claude Code、Qwen Code 放到一个**统一目录**（默认 `~/dsh-clis`），不混入系统 PATH；
- 每个 CLI 用**相互隔离的配置目录**（`config-<cli>/`），通过该 CLI 自身的环境变量指向，**完全不碰**你系统里已装的 CLI 配置；
- Web 插件配置卡片可配置统一目录 + 每个 CLI 的**三层模型路由**（Provider → 模型 → 推理强度）；
- 注册 **15 个模型工具**，按"CLI × 模式"覆盖（**只保留带后缀的入口**）：
  - 持续会话（每个 CLI）：`cli_codex_direct` / `cli_claude_direct` / `cli_qwen_direct`（首轮；返回 `sessionId`）+ `cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions`（qwen 无 `sessions`）；
  - Relay 子代理（每个 CLI）：`cli_codex_subagent` / `cli_claude_subagent` / `cli_qwen_subagent`（创建 DSH continuable 子代理，通过 `managed_cli_submit` 转发到真实 thread）；
  - 中断（codex/claude）：`cli_codex_interrupt` / `cli_claude_interrupt`（Qwen 不支持）；
  - **15 = 3 direct + 3 subagent + 8 session 工具（followup/status/sessions 各 3 → qwen 无 sessions 故 8）+ 1 dispatch + 1 `managed_cli_submit` Relay 内部工具**；
  - `cli_codex` 别名已移除；无后缀的一次性工具 `cli_claude_code` / `cli_qwen` 及其 `managed-<cli>` provider **已删除**——它们只覆盖三个 CLI 中的两个、没有会话能力，且与 `cli_dispatch` 重复；
    > **并发调度多个 CLI 请用 `cli_<cli>_subagent`**：它返回子代理 id 后立刻继续，多个 CLI 天然并行跑，**不需要后台任务（jobs）插件**。
- 每个 CLI 都有持续会话驱动（Codex: app-server，Claude/Qwen: stream-json NDJSON），并提供 **`cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions` / `cli_<cli>_interrupt`** 持续会话工具（qwen 无 interrupt）；
- 注册 **`cli_dispatch`** 模型工具，让 DSH 模型无头调用外部 CLI 并回传输出。

## 功能

- **统一目录**：所有 CLI 二进制集中到 `~/dsh-clis/bin/`，配置集中在 `~/dsh-clis/config-<cli>/`；
- **配置隔离**：启动时设置 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `QWEN_HOME` 指向统一目录内配置，不触碰系统默认路径；
- **三层模型路由**：每个 CLI 可独立选 Provider → 模型 → 推理强度；
- **无头派发**：`cli_dispatch` 工具用 argv 数组执行 CLI，不用 shell 字符串拼接，处理超时、输出上限、退出码和 stderr；
- **三个 CLI 持续会话**：首轮 `cli_<cli>_direct` 返回稳定 `sessionId`；后续工具直接进入同一 thread——Codex 走 app-server 长连接，Claude/Qwen 走 `stream-json` 单次进程 + `--session-id`/`--resume` 文件级持久化——不经过 relay 模型；
- **配置持久化**：统一目录与模型路由通过 `installSettingsSection` 写入 `~/.dsh/settings.yaml`，重启后仍生效。
- **会话持久化**：会话注册表（含远程 thread id）写入统一目录的 `sessions.json`，Host 重启后 `cli_<cli>_followup` 直接按 `sessionId` 恢复并 reattach 同一 thread，无需重新创建。
- **自动补全（auto-continue）**：回答看起来提前收尾（只描述计划、未交付结果）时，自动在同一会话内续接追问直到拿到完整结果，单次 `cli_<cli>_direct` 即返回完整报告。每个 CLI 在设置卡里配置续接次数（`max`，默认 3；**设为 0 即关闭**，没有独立开关）。**泛化评估结论**：该机制依赖"同一 thread 的 followup"，对所有持续会话式调用生效（Codex/Claude/Qwen），`INTENT_TAIL` 正则同时识别中英文意图句。

## 各 CLI 内置工具能力

本插件不动 CLI 的工具——CLI 自己有什么工具就用什么。三个 CLI 在 `cli_<cli>_direct` / `cli_<cli>_subagent` 持续会话路径下实际能调用的工具：

| 能力 | Codex (app-server) | Claude Code (stream-json) | Qwen Code (stream-json) |
|------|:------------------:|:--------------------------:|:-----------------------:|
| 文件读写（Read / Write / Edit / Glob / Grep） | ✅ | ✅ | ✅ |
| Shell 命令（exec / Bash） | ✅ | ✅ | ✅ |
| 内部子代理（Agent / Task / spawn） | ✅ | ✅ | ✅ |

**分工原则：主控联网调研，CLI 离线执行。**

- **联网搜索 / 调研 / 抓 URL**：由主控用 DSH 自带的 `advanced_search` / `web_fetch` / `platform_search` 直接完成，**三个 CLI 均明确不提供联网搜索功能**（2026-09 产品决策，不再折腾）。技术依据：Codex 的 web_search 与 Claude 的 WebSearch 都是模型供应商的 server-side 工具，中转商路线下基本不被执行；Qwen 的 webSearch 需要单独付费的 DashScope 搜索模型。主控的搜索工具链完整且不受这些限制，联网任务直接用它。
- **代码工作（读 / 写 / 改 / 跑命令）**：三个 CLI 完全对称，按习惯选。
- **多步复杂任务**：用 Relay 子代理（`cli_<cli>_subagent`），让子代理持续推进。
- **如需 CLI 处理调研相关材料**：主控先搜好，把材料作为任务内容派给 CLI。

> 设置卡的权限是单一三档下拉：**只读 ⊆ 可写 ⊆ 可调用工具**。读取在三档中恒为允许；档位勾选的能力运行时静默放行，未勾选的能力被触发时确定拒绝并记录，任务做不了就清晰报错引导到设置卡调整（审批模式已移除：档位启动时定死，无弹窗、无运行中提权）。「可调用工具」（exec）已承载联网意图：npm install / git clone 等命令属普通执行，没有独立的网络开关。

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
cli_<cli>_direct(description, prompt)  # codex / claude / qwen
→ { sessionId, status, output }
```

后续（`cli` = codex / claude / qwen）：

```text
cli_<cli>_followup(sessionId, prompt)  # 同一真实 thread
cli_<cli>_status(sessionId)            # 状态、cwd、模型与权限
cli_<cli>_sessions()                   # 当前 Host 的会话列表（qwen 无此 API）
cli_<cli>_interrupt(sessionId)         # 中断当前 turn（qwen 不支持）
```

### Relay 子代理（所有 CLI）

每个 CLI 都有 Relay 子代理——DSH 原生 continuable 子代理，任务通过 `managed_cli_submit` 转发给真实 CLI：

```text
cli_<cli>_subagent(description, prompt)  # codex / claude / qwen
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

`<cli>` 取值：`codex` / `claude` / `qwen`。

## 环境变量隔离

| CLI | 配置目录环境变量 |
|---|---|
| Codex | `CODEX_HOME` |
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Qwen Code | `QWEN_HOME` |

## CLI 联网搜索的最终决策（2026-09）

**三个托管 CLI 均不提供联网搜索功能，此事已关闭。** 联网任务一律由主控自带的搜索工具（`advanced_search` / `web_fetch` / `platform_search`）完成。

决策依据（详见根目录 `CLI-WEB-SEARCH-RESEARCH.md` 的完整调研）：

- **Codex**：web_search 是 Responses server-side 工具，执行权在中转商——多数 chat 型中转商不执行；且旧开关形式（`-c tools.web_search=true`）已是 deprecated 别名，新语义默认 `cached`（查索引缓存，不真联网）；
- **Claude**：WebSearch 同为 Anthropic server-side 工具（`web_search_20250305`），中转商转换时实测损坏；WebFetch 虽是本地执行但它只是抓取器，不解决"搜索发现"；
- **Qwen**：webSearch 需要独立付费的 DashScope 搜索模型 + API key，对话模型顶不上——启用配置形同虚设；
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

## Licence

[MIT](LICENSE)
