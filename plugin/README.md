# dsh-sub-cli

在 DeepSeek Harness（DSH）中统一管理外部 Agent CLI 的插件。

- 把 Codex、Claude Code、Qwen Code 放到一个**统一目录**（默认 `~/dsh-clis`），不混入系统 PATH；
- 每个 CLI 用**相互隔离的配置目录**（`config-<cli>/`），通过该 CLI 自身的环境变量指向，**完全不碰**你系统里已装的 CLI 配置；
- Web 插件配置卡片可配置统一目录 + 每个 CLI 的**三层模型路由**（Provider → 模型 → 推理强度）；
- 注册 **17 个模型工具**，按"CLI × 模式"全矩阵覆盖：
  - 持续会话（每个 CLI）：`cli_codex_direct` / `cli_claude_direct` / `cli_qwen_direct`（首轮；返回 `sessionId`）+ `cli_<cli>_followup` / `cli_<cli>_status` / `cli_<cli>_sessions`（qwen 无 `sessions`）；
    > **注意**：`cli_<cli>_direct` 属于 session-mode，**不支持后台 job**（返回的 `sessionId` 仅用于同会话内的后续 `followup/status/sessions` 调用）；`cli_claude_code` / `cli_qwen` 的一次性模式才支持后台 job。
  - Relay 子代理（每个 CLI）：`cli_codex_subagent` / `cli_claude_subagent` / `cli_qwen_subagent`（创建 DSH continuable 子代理，通过 `managed_cli_submit` 转发到真实 thread）；
  - 中断（codex/claude）：`cli_codex_interrupt` / `cli_claude_interrupt`（Qwen 不支持）；
  - 一次性（仅 Claude/Qwen）：`cli_claude_code` / `cli_qwen`（一次性无 headless，支持后台 job）；
  - **17 = 3 direct + 3 subagent + 11 session 续接（4 codex + 4 claude + 3 qwen） + 2 one-shot + 1 dispatch + 1 `managed_cli_submit` Relay 内部工具**。
  - `cli_codex` 别名已移除；
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
- **自动补全（auto-continue）**：回答看起来提前收尾（只描述计划、未交付结果）时，自动在同一会话内续接追问直到拿到完整结果，单次 `cli_<cli>_direct` 即返回完整报告。每个 CLI 可在设置卡里开关（`enabled`）并调整续接次数（`max`，默认 3）。**泛化评估结论**：该机制依赖"同一 thread 的 followup"，对所有持续会话式调用生效（Codex/Claude/Qwen），`INTENT_TAIL` 正则同时识别中英文意图句。

## 各 CLI 内置工具能力

本插件不动 CLI 的工具——CLI 自己有什么工具就用什么。三个 CLI 在 `cli_<cli>_direct` / `cli_<cli>_subagent` 持续会话路径下实际能调用的工具：

| 能力 | Codex (app-server) | Claude Code (stream-json) | Qwen Code (stream-json) |
|------|:------------------:|:--------------------------:|:-----------------------:|
| 文件读写（Read / Write / Edit / Glob / Grep） | ✅ | ✅ | ✅ |
| Shell 命令（exec / Bash） | ✅ | ✅ | ✅ |
| **WebSearch（联网搜索）** | ❌ CLI 内部无 | ✅ **CLI 自带，需要 DSH 批准权限** | ❌ CLI 内部无 |
| **WebFetch（抓取 URL）** | ❌ | ✅ **CLI 自带，需要 DSH 批准权限** | ❌ |
| 内部子代理（Agent / Task / spawn） | ✅ | ✅ | ✅ |

**用哪个 CLI 做什么**：

- **联网搜索 / 抓 URL**：用 Claude Code 的 `cli_claude_direct`（它自带 `WebSearch` + `WebFetch`）。Qwen 和 Codex 内部都没有 web 工具——**不要让它们做 web 任务**。
- **代码工作（读 / 写 / 改 / 跑命令）**：三个 CLI 都能做，按你习惯选。
- **多步复杂任务**：用 Relay 子代理（`cli_<cli>_subagent`），让子代理持续推进。

**DSH 自己的工具也可以用**：`advanced_search` / `web_fetch` / `platform_search` / `free_search_test`——这些是 DSH Host 提供的，不依赖 CLI。要搜"过去 24 小时 GitHub 趋势"这种需求，直接用 `advanced_search` 最快。

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
5. 在对话中让 DSH 使用对应 CLI：日常委派使用 `cli_<cli>_direct`（持续会话，直连）或 `cli_<cli>_subagent`（DSH Relay 子代理，任务通过子代理转发）；`cli_claude_code` / `cli_qwen` 用于一次性无头任务（后台 job 支持）；仅在模型提示词中要求时才用 `cli_dispatch`。

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
| `autoContinue.<cli>.enabled` | 自动补全开关（默认 `true`；仅 Codex 会话式生效） |
| `autoContinue.<cli>.max` | 自动补全最多续接次数（1–10，默认 3） |

`<cli>` 取值：`codex` / `claude` / `qwen`。

## 环境变量隔离

| CLI | 配置目录环境变量 |
|---|---|
| Codex | `CODEX_HOME` |
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Qwen Code | `QWEN_HOME` |

## 本地开发

```bash
npm test        # 运行单元测试
npm pack --dry-run
```

参考 `DEVELOPMENT.md` 与 `PLUGIN_REQUIREMENTS.md`。

## Licence

[MIT](LICENSE)
