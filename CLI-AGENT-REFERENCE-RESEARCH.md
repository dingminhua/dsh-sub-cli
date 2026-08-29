# 外部 CLI Agent 参考项目调研

> 调研日期：2026-08-29
> 用途：为 `dsh-sub-cli` 后续把外部 CLI 从“一次性工具”升级为“原生 CLI 子代理”提供可复用的架构依据。
> 研究副本已克隆到当前项目同级目录；仅用于阅读比较，不作为本项目发布依赖。
> 后续对通用委托框架、角色定义、原生 CLI Engine、官方 Claude Provider 与 DAG 编排的增量研究见 `CLI-AGENT-FRAMEWORK-RESEARCH.md`。

## 1. 调研对象

虽然最初描述为“三个项目”，实际列出了四个，本次全部纳入：

| 项目 | 同级研究目录 | 上游仓库 | 核心路线 |
|---|---|---|---|
| dsh-subagent-claude-code-wrapper | `../dsh-subagent-claude-code-wrapper` | https://github.com/yaways/dsh-subagent-claude-code-wrapper | Claude Agent SDK + DSH Subagent Provider |
| dsh-agent-conductor | `../dsh-agent-conductor` | https://github.com/MJorgin/dsh-agent-conductor | 普通 Tool + 外部 CLI 子进程 |
| dsh-cursor-acp | `../dsh-cursor-acp` | https://github.com/loeanxi/dsh-cursor-acp | ACP Provider + Subagent Tool + 设置 UI |
| dsh-llm-agy | `../dsh-llm-agy` | https://github.com/flg1217/dsh-llm-agy | LLM Adapter + continuable Subagent + CLI 流协议 |

## 2. 总体对比

| 项目 | 集成层级 | 任务形态 | 用户可见状态 | 权限策略 | 最适合借鉴的部分 |
|---|---|---|---|---|---|
| Claude Wrapper | 原生 Subagent Provider | one-shot | DSH 原生子会话生命周期 | 配置时固定 `permissionMode`；无人值守请求默认拒绝 | Provider 骨架、工作区继承、进程树托管、错误分层 |
| Agent Conductor | 普通 Tool | 一次性命令 | 工具卡片 + 最终 stdout | 依赖外层沙箱；失败即返回 | 多 CLI 注册表、清晰卡片标题、安装提示 |
| Cursor ACP | ACP Provider + Tool | one-shot 子代理 | 原生子代理 + 设置状态页 | ACP/CLI 自身处理 | readiness/status、Provider 与 Tool 分层、热重挂载 |
| LLM AGY | LLM Adapter + spawn Subagent | continuable | 流式输出、工具事件、后台通知 | 启动时跳过 CLI 权限检查 | durable 子代理、会话恢复、流事件翻译、重试与执行轨迹 |

## 3. dsh-subagent-claude-code-wrapper

### 3.1 定位

该项目从 DSH 官方 `dsh-subagent-claude-code` Provider 分叉，只增加一个主要配置项：

```text
executablePath → Claude Agent SDK 的 pathToClaudeCodeExecutable
```

因此它可以启动任意兼容 Claude Code 命令行协议的二进制，而不是只能使用 SDK 内置 CLI。

### 3.2 架构与生命周期

- Host 层向 `ctx.subagents` 注册 `claude-code-wrapper` Provider；
- Agent 层通过 `dsh-tool-subagent` 暴露模型可见委派工具；
- 子任务工作目录来自父 Session 的 `header.cwd`；
- SDK 实际启动的 CLI 进程交给 DSH `subprocess` 服务管理；
- 取消和释放作用于整棵进程树，而不是只杀直接子进程；
- 只有严格的 SDK `success` 结果才视为完成；
- 失败按 `query-start`、`query-run`、`process`、`teardown` 等阶段归类。

### 3.3 权限机制

支持：

- `dontAsk`（默认）
- `acceptEdits`
- `auto`
- `plan`
- `bypassPermissions`

为了保证 unattended 运行，它会禁用 `AskUserQuestion`。当 SDK 请求人工工具授权、MCP elicitation 或用户对话时，Provider 会按既定模式拒绝或取消，而不会把任务暂停后交给当前用户审批。

### 3.4 对本项目的价值

应借鉴：

1. 将托管 CLI 注册成真正的 `SubagentProvider`；
2. 父会话工作目录继承；
3. DSH `subprocess` 作为唯一进程树所有者；
4. 启动、执行、退出、清理错误分层；
5. Provider 与 Agent Tool 分层装配。

不应直接照搬：

- “人工权限请求永远拒绝”的 unattended 策略；
- one-shot 任务无法在授权后继续同一轮的问题。

## 4. dsh-agent-conductor

### 4.1 定位

该项目维护 11 种外部 CLI 的命令注册表，通过 `subprocess.spawn()` 无头执行自包含任务，将 stdout 直接作为工具结果回传。

注册表示例：

```js
{ id: 'codex', name: 'Codex', argv: ['codex', 'exec', '{task}'] }
{ id: 'claude-code', name: 'Claude Code', argv: ['claude', '-p', '{task}', '--output-format', 'text'] }
```

### 4.2 用户可见呈现

它通过 `presentCall` 显示：

```text
指挥家 → <agent id>
```

这是一个很重要但很轻量的 UX：用户可以立刻识别任务由哪个外部 CLI 执行。

### 4.3 局限

- 只是普通工具调用，没有 Subagent ID；
- 没有持久对话、follow-up 或 resume；
- 没有流式执行阶段和 CLI 内部工具步骤；
- 权限不足时任务直接失败；
- README 路线图中的面板、任务看板和多代理汇总尚未实现；
- 11 种 CLI 并非全部真机验证。

### 4.4 对本项目的价值

仅借鉴：

1. 统一 CLI 注册表 `{ id, name, argv, install }`；
2. 卡片标题必须带 CLI 产品身份；
3. CLI 未安装时给出准确安装提示；
4. 任务必须自包含的 Tool 描述。

不采用其一次性工具模型作为最终运行时。

## 5. dsh-cursor-acp

### 5.1 定位

该项目专门把本机已登录的 Cursor CLI 通过 ACP 接入 DSH。它将产品准备状态、ACP Provider 和模型可见委派工具明确分层。

```text
CLI 定位 / 登录与代理诊断
            ↓
       ACP Provider
            ↓
   dsh-tool-subagent
            ↓
       cursor_agent
```

### 5.2 产品化控制面

设置页提供：

- CLI 是否找到；
- 官方 `agent status` 登录检测；
- 代理环境是否完整；
- Clash 是否可能让 Node 直连；
- 模型、effort、Fast 设置；
- 一次只读的真实连接测试；
- 安装和登录提示。

状态输出刻意不读取或展示邮箱、Token 和凭据内容。

### 5.3 Provider 和 Tool 的挂载方式

当 CLI 存在且依赖可用时：

1. 动态挂载 `@deepseek-ai/dsh-subagent-acp`；
2. 动态挂载 `@deepseek-ai/dsh-tool-subagent`；
3. 注册 `cursor_agent`；
4. 设置变化时销毁旧 Fiber 并重新挂载 Provider 与 Tool。

CLI 不存在时不注册工具，避免出现“工具可见但必然失败”的状态。

### 5.4 对本项目的价值

应重点借鉴：

1. 安装、登录、代理、协议与模型探测形成 readiness；
2. 只有 Ready 的 CLI 才注册或启用委派工具；
3. Provider 与 Tool 生命周期独立但由同一 Fiber 管理；
4. secret-free 状态合同；
5. 设置变化后热重挂载；
6. 设置页只负责准备和诊断，主会话负责派发任务。

## 6. dsh-llm-agy

### 6.1 定位

该项目将 Antigravity CLI 实现为 `agy` LLM Adapter，再通过通用 `spawn` Subagent Provider 创建 AGY/Gemini 子代理。它不只是执行 CLI，而是把 CLI 的流式协议翻译为 DSH Agent 事件。

### 6.2 continuable 子代理能力

自定义工具 `subagent_agy_ui` 默认调用：

```text
ctx.subagents.startContinuable(...)
```

从而具备：

- 后台启动后立即返回 durable child ID；
- runtime 在任务结束后主动通知主代理；
- 可以通过 `send_message` 继续同一个子代理；
- 前台模式仍可等待结果；
- 子代理可选模型。

### 6.3 CLI 流协议与会话恢复

Adapter 使用 AGY `stream-json`：

- 将文本增量翻译为 DSH `StreamChunk`；
- 将 CLI 内部工具步骤写成 Session `tool/call` / `tool/result` 事件；
- 记录 conversation ID；
- 网络或认证类错误时用 `--conversation` 恢复同一会话；
- 重试提示明确要求继续未完成工作，避免重复副作用；
- 无输出超时会杀死进程，保证子代理最终进入终态；
- 最终错误携带最近执行步骤。

### 6.4 权限策略

AGY 启动参数包含：

```text
--dangerously-skip-permissions
--add-dir <cwd>
```

这实现了无人值守运行，但不适合作为多 CLI 通用默认策略。

### 6.5 对本项目的价值

应重点借鉴：

1. continuable 后台子代理；
2. durable child ID 和 follow-up；
3. CLI session/thread ID 的持久化和恢复；
4. CLI 流事件映射为 DSH 事件；
5. 超时、取消、静默退出与重试；
6. 最近执行轨迹作为错误诊断；
7. 后台任务完成后由 runtime 通知，禁止主代理轮询。

## 7. 对 dsh-sub-cli 的目标架构建议

不建议继续把 `cli_codex` / `cli_claude_code` / `cli_qwen` 只理解为“包装一条无头命令的普通工具”。建议演进为：

```text
CLI Registry
  ├─ codex
  ├─ claude
  └─ qwen
        ↓
Protocol Driver
  ├─ Codex Responses / stream events
  ├─ Claude Messages / SDK events
  └─ Qwen Chat Completions / native stream events
        ↓
Managed CLI Subagent Provider
        ↓
Continuable CLI Agent Tool
        ↓
原生子会话、任务身份、状态、历史、继续、取消、权限、完成通知
```

### 7.1 CLI Registry

统一维护每个产品的：

- CLI id 与用户显示名；
- 托管 executable path；
- 配置目录环境变量；
- 安装与版本检测；
- 启动、resume、status、test 参数；
- 协议类型；
- 是否支持 continuable / session resume / permissions / streaming。

### 7.2 Protocol Driver

不同 CLI 协议不同，不应只维护一个 `{task}` argv 模板。Driver 至少应负责：

- 生成首轮和后续轮次 argv；
- 提取 CLI thread/session/conversation ID；
- 解析文本流与终局结果；
- 解析工具调用、权限请求和错误；
- 提供取消、恢复和进程退出语义；
- 将事件转换成统一内部事件。

### 7.3 Subagent Provider

Provider 应负责：

- 继承父 Session 的工作目录；
- 使用本插件托管的 executable 和隔离配置目录；
- 通过 DSH `subprocess` 启动并管理进程树；
- 保存 CLI 会话 ID；
- 按统一合同产出完成、取消、拒绝、权限等待和错误状态；
- 与 DSH 原生子会话生命周期对接。

### 7.4 Tool 层

用户可见工具名可以继续保留：

- `cli_codex`
- `cli_claude_code`
- `cli_qwen`

但工具应创建 continuable CLI 子代理，而不是只返回一次 stdout。工具调用卡片必须明确展示：

```text
Claude Code · 读取当前项目现状
Codex · 审查协议兼容性
Qwen Code · 实现测试用例
```

## 8. 权限交互设计

四个参考项目都没有完整解决“运行中的 CLI 请求权限时，暂停并由当前 DSH 用户审批后继续同一任务”。这是本项目可以形成差异化的核心能力。

### 8.1 建议状态机

```text
queued
  → starting
  → running
  → awaiting_permission
      ├─ approved → running
      ├─ denied → running 或 refused（由 CLI 协议决定）
      └─ cancelled
  → completed / failed / cancelled
```

### 8.2 权限卡片最小信息

权限提示不要先给长说明和多个选择。先准确显示：

- **代理**：哪个 CLI；
- **请求**：读、写、执行、联网，及具体路径/命令/域名；
- **原因**：该操作与当前任务的关系；
- **范围**：仅本次、当前项目、该 CLI 持久允许（仅支持时展示）。

然后只给批准或拒绝动作。高级范围选择可以二级展开。

### 8.3 关键约束

- 权限等待必须属于同一个 CLI Agent Run；
- 批准后不能由主代理重新创建任务；
- 不把所有 CLI 默认设置为 `bypassPermissions`；
- 无法交互的 CLI 才按配置选择 `dontAsk` / `acceptEdits`；
- 权限请求、决定和恢复应作为子会话事件保存；
- 主代理只负责协调与解释，不伪装成 CLI 已完成任务。

## 9. 分阶段落地建议

### 阶段 A：统一原生 Provider 合同

- 保留当前统一目录、配置隔离和验证逻辑；
- 抽象 `ManagedCliDriver`；
- 先让 Codex、Claude、Qwen 都经过统一 Provider；
- 对齐工作目录、进程树、错误阶段和任务卡片；
- 确保失败明确归属于具体 CLI Agent。

### 阶段 B：continuable 与真实 resume

- Codex 使用 `exec resume <thread_id>`；
- Claude 使用 `--resume` / `--session-id`；
- Qwen 根据实测接入 `--resume`；
- 保存 CLI session ID 到子代理持久状态；
- 后续消息继续同一 CLI 会话。

### 阶段 C：流式状态与工具事件

- 按各 CLI 能力解析 JSON/流输出；
- 映射文本增量、工具步骤和终局状态；
- 子会话中可查看真实工作过程；
- 加入 stall timeout、异常退出和最近执行轨迹。

### 阶段 D：交互式权限桥

- 定义统一 `PermissionRequest`；
- 接入 DSH approval 服务；
- 引入 `awaiting_permission`；
- 用户批准后恢复同一个 run；
- 对无法暂停的 CLI 提供明确降级策略。

## 10. 结论

四个项目分别代表四个成熟度层次：

1. **Agent Conductor**：外部 CLI 工具；
2. **Claude Wrapper**：原生一次性 CLI 子代理；
3. **Cursor ACP**：有诊断控制面的专用 CLI 子代理产品；
4. **LLM AGY**：可持续、可恢复、可观察的 CLI Agent。

`dsh-sub-cli` 的合理目标不是复制其中某一个，而是组合：

- Claude Wrapper 的 Provider/进程生命周期；
- Cursor ACP 的 readiness 和设置控制面；
- AGY 的 continuable、事件翻译和会话恢复；
- Conductor 的统一注册表和清晰任务身份。

最终产品应把外部 CLI 呈现为 DSH 原生子代理：有产品身份、任务标题、运行状态、历史、权限暂停点、继续会话、取消和完成回报，而不只是一个返回 stdout 的工具。
