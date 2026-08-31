# dsh-sub-cli

在 DeepSeek Harness（DSH）中统一管理外部 Agent CLI 的插件。

- 把 Codex、Claude Code、Qwen Code 放到一个**统一目录**（默认 `~/dsh-clis`），不混入系统 PATH；
- 每个 CLI 用**相互隔离的配置目录**（`config-<cli>/`），通过该 CLI 自身的环境变量指向，**完全不碰**你系统里已装的 CLI 配置；
- Web 插件配置卡片可配置统一目录 + 每个 CLI 的**三层模型路由**（Provider → 模型 → 推理强度）；
- 注册 **`cli_codex_direct` / `cli_codex_subagent` / `cli_claude_code` / `cli_qwen`** 工具，让 DSH 模型把自包含任务交给对应 CLI；Codex 只有**直连**（`cli_codex_direct`）与**代理**（`cli_codex_subagent`）两种明确模式，`cli_codex` 别名已移除；
- Codex 使用 app-server thread，并提供 **`cli_codex_followup` / `cli_codex_status` / `cli_codex_sessions` / `cli_codex_interrupt`** 持续会话工具；
- 注册 **`cli_dispatch`** 模型工具，让 DSH 模型无头调用外部 CLI 并回传输出。

## 功能

- **统一目录**：所有 CLI 二进制集中到 `~/dsh-clis/bin/`，配置集中在 `~/dsh-clis/config-<cli>/`；
- **配置隔离**：启动时设置 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `QWEN_HOME` 指向统一目录内配置，不触碰系统默认路径；
- **三层模型路由**：每个 CLI 可独立选 Provider → 模型 → 推理强度；
- **无头派发**：`cli_dispatch` 工具用 argv 数组执行 CLI，不用 shell 字符串拼接，处理超时、输出上限、退出码和 stderr；
- **Codex 持续会话**：首轮 `cli_codex_direct` 返回稳定 `sessionId`；后续工具直接进入同一个 Codex thread，不经过 relay 模型；
- **配置持久化**：统一目录与模型路由通过 `installSettingsSection` 写入 `~/.dsh/settings.yaml`，重启后仍生效。当前 Codex 会话 Registry 为 Host 内存态，Host 重启后需重新创建会话；持久恢复将在后续版本接入 DSH storage。

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
5. 在对话中让 DSH 使用对应 CLI：日常委派使用 `cli_codex_direct` / `cli_codex_subagent` / `cli_claude_code` / `cli_qwen`；仅明确要求一次性无头执行时使用 `cli_dispatch`。

### Codex 持续会话

首轮：

```text
cli_codex_direct(description, prompt)
→ { sessionId, status, output }
```

后续：

```text
cli_codex_followup(sessionId, prompt)  # 同一个真实 Codex thread
cli_codex_status(sessionId)            # 状态、cwd、模型与权限
cli_codex_sessions()                    # 当前 Host 的会话列表
cli_codex_interrupt(sessionId)          # 中断当前 turn，保留 thread
```

这些是本插件的专用续接工具，不是 DSH 原生 `send_message`。每个会话同时只允许一个 active turn；重叠 follow-up 会明确返回 `SESSION_BUSY`。

## 配置

| 字段 | 说明 |
|---|---|
| `cliDir` | 统一目录，默认 `~/dsh-clis` |
| `models.<cli>.provider` | 该 CLI 的推理 Provider |
| `models.<cli>.model` | 该 CLI 的模型 |
| `models.<cli>.reasoningEffort` | 该 CLI 的推理强度 |

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
