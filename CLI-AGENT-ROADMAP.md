# dsh-sub-cli：CLI Agent 目标与实施路线图

> 更新日期：2026-08-29
> 状态：当前实施依据。详细外部项目证据见 `CLI-AGENT-REFERENCE-RESEARCH.md` 与 `CLI-AGENT-FRAMEWORK-RESEARCH.md`。

## 1. 最终目标

本项目不只提供“执行外部命令并返回 stdout”的工具，而要把 Codex、Claude Code、Qwen Code 变成 DSH 原生可管理的 CLI 子代理。

### 1.1 管理控制面

- CLI 安装到统一托管目录；
- 与用户系统已有 CLI、配置和认证相互隔离；
- 每个 CLI 有独立配置根；
- 设置页负责安装、配置、状态、模型路由、协议验证和诊断；
- 配置变化只影响未来任务，运行实例持有不可变快照。

### 1.2 Agent 运行面

一次“用 Claude 分析项目”的任务应成为：

```text
Claude Code · 分析当前项目
```

并具备：

- DSH 原生子会话与稳定 child ID；
- 明确 CLI 产品身份和任务标题；
- 实时进度、历史与最终输出；
- 正确工作目录；
- interrupt、follow-up 和同一 CLI 会话续接；
- 重启后的持久恢复；
- 权限不足时进入 `awaiting_permission`，批准后继续同一任务；
- 完成后自动通知主代理；
- 可被 DAG、AgentTeams 和其他插件程序化调度。

## 2. 调研收获

1. 普通 Tool 的 `spawn → stdout` 不等于 CLI Agent；正确承载层是 DSH `SubagentProvider`。
2. Codex、Claude、Qwen 协议不同，需要 capability-driven Driver，不能只用统一 argv 模板。
3. Codex 的 `app-server --stdio` 提供 thread/turn、流式事件、interrupt、token usage 和续话能力，适合首个纵向切片。
4. CLI session/thread ID 必须持久映射到 DSH child ID，不能只存在内存或信任模型日志。
5. 配置 Definition 与运行 Instance 必须分离；运行中修改配置不能改变已启动任务。
6. 现有生态通常选择 `dontAsk` 或 bypass，尚未完整解决 `awaiting_permission → approve → resume same run`。
7. 权限必须有谱系天花板，子代理再委派不能提升权限。
8. 除模型工具外，应提供程序化 Host Service，供 DAG/AgentTeams 直接调度。
9. 角色和 DAG 属于上层能力；核心先完成 CLI Driver、Provider、会话与权限合同。

## 3. 目标架构

```text
Managed CLI Registry
  ├─ 安装 / 更新 / 删除
  ├─ executablePath
  ├─ 隔离配置目录
  ├─ readiness / protocol verification
  └─ provider / model 配置
          ↓
Managed CLI Driver
  ├─ CodexDriver
  ├─ ClaudeDriver
  ├─ QwenDriver
  └─ AcpDriver（后续）
          ↓
Managed CLI Subagent Provider
  ├─ DSH child 生命周期
  ├─ immutable run snapshot
  ├─ session/thread registry
  ├─ interrupt / follow-up
  └─ permission state
          ↓
Tool + Host Service
  ├─ cli_codex / cli_claude_code / cli_qwen
  └─ managedCliAgents.dispatch/followup/interrupt/status
          ↓
角色目录 / DAG / AgentTeams / 自动路由
```

## 4. Driver 能力合同

每个 Driver 必须明确声明：

```text
streaming
continuable
durableResume
interactivePermissions
structuredOutput
modelOverride
reasoningEffort
cwd
interrupt
```

出现不支持的参数时必须明确失败，禁止静默忽略。

建议运行状态：

```text
queued
starting
running
awaiting_permission
completed
failed
cancelled
```

## 5. 程序化 Host Service

模型工具之外，后续提供：

```text
managedCliAgents.listCapabilities()
managedCliAgents.dispatch(request)
managedCliAgents.followup(childId, message)
managedCliAgents.interrupt(childId)
managedCliAgents.status(childId)
```

Tool 只是该 Service 的一种调用界面。DAG、AgentTeams 和其他插件通过 Service 调度，不模拟模型调用 Tool。

## 6. 分阶段实施

### 阶段 A：内部合同

- 新建 `ManagedCliDriver`、`ManagedCliRun`、capabilities 和标准事件合同；
- 不改变现有用户工具行为；
- 为 Driver 写纯单元测试。

### 阶段 B：Codex app-server 实验 Driver

- 启动 `codex app-server --stdio`；
- `initialize`、`thread/start`、`turn/start`；
- 解析 message delta、turn completed/failed、token usage；
- `turn/interrupt`；
- 同 thread follow-up；
- 每个活跃 Run 使用独立 wire，避免无路由标识的 delta 串线；
- 先作为内部实验模块，不替换现有 `cli_codex`。

### 阶段 C：接入 continuable Provider

- `cli_codex → managedCliAgents.dispatch → Codex Provider`；
- 创建原生 DSH continuable child；
- 子会话显示 Codex 产品身份、标题、状态和输出；
- 保留旧 one-shot `cli_dispatch` 作为兼容入口。

### 阶段 D：持久 Session Registry

保存：

```text
childId / cli / remoteSessionId / cwd
provider / model / permissionMode
createdAt / schemaVersion
```

要求原子写、0600、条目上限、重启恢复，并禁止从日志文本推断权限。

### 阶段 E：权限能力验证与桥接

按 CLI 实测：

- 是否产生结构化权限事件；
- 是否能暂停；
- 是否能回送批准/拒绝；
- 是否能继续同一 turn。

能力分级：

```text
interactive
preauthorized
deny-on-request
unsupported
```

只对真实支持暂停/恢复的 Driver 实现 `awaiting_permission`。不支持时必须启动前选定无人值守策略或明确拒绝，禁止暗中提权重跑。

### 阶段 F：Claude 和 Qwen

Claude 重点验证：托管 executable、隔离配置、第三方后端 resume、权限 callback、辅助模型请求兼容性。

Qwen 重点验证：stream 协议、resume ID、工具续接、interrupt 和权限事件。

### 阶段 G：上层组合

- Host dispatch service 稳定后再接 DAG、AgentTeams；
- 可选增加角色 Definition Catalog；
- 不把 DAG 调度器或角色 UI 混入 Driver 核心。

## 7. 当前开发计划：Codex 持续会话

> 本计划是当前实施主线。只使用 DSH 公开插件机制；不得修改 DSH 本体、打补丁或改 shipped preset。参考实现证据：`dsh-codex` 的 `codex_resume` 路线，以及 `dsh-assembly.resume` 的持久绑定、workspace、lease 与恢复模型。

### 7.1 交付目标

```text
cli_codex(first task)
  → 返回真实 Codex thread 对应的 sessionId 和输出

cli_codex_followup(sessionId, next task)
  → 进入同一个 Codex thread

cli_codex_status(sessionId)
cli_codex_sessions()
cli_codex_interrupt(sessionId)
```

不得将专用 follow-up 描述成原生 DSH `send_message`；不得引入 relay 模型。

### 7.2 Host Service

提供 `managedCliAgents`：

```text
dispatch(request)
followup(sessionId, prompt)
interrupt(sessionId)
status(sessionId)
list(query?)
```

Service 与 Registry 位于 Host plane，供 Provider、模型工具及未来 DAG/AgentTeams 共同消费。

### 7.3 Session Registry

首期内存记录字段：

```text
sessionId / cli / remoteSessionId / cwd
provider / model / reasoningEffort / permissionMode
status / activeTurn / createdAt / updatedAt / lastError
```

状态：`starting | running | ready | failed | interrupted | stale | closed`。每个 session 同时最多一个 active turn；并发 follow-up 明确返回 `SESSION_BUSY`。

首期跑通后接入持久存储：版本化 schema、原子写或 DSH storage、0600、lease、启动恢复；不得存 API Key。

### 7.4 工具合同

- `cli_codex`：首轮 dispatch，返回 `{sessionId, output, status}`；
- `cli_codex_followup`：同 thread 新 turn；
- `cli_codex_status`：状态、cwd、模型、权限和最近错误；
- `cli_codex_sessions`：列出可恢复记录；
- `cli_codex_interrupt`：中断 active turn，不关闭 thread。

### 7.5 验收标准

1. 首轮返回真实 thread 对应的 sessionId；
2. follow-up 使用相同 remote thread；
3. status/list 不暴露密钥；
4. interrupt 调用 `turn/interrupt`，之后 thread 仍可继续；
5. 并发 follow-up fail loud；
6. cwd、模型、provider 和权限取启动快照；
7. 失败状态与诊断不冒充成功；
8. 进程与 listener 无泄漏；
9. 全部单元测试、`npm pack --dry-run` 通过；
10. 真实 DSH 中完成两轮同-thread 验证。

## 8. 当前实现进度

### 已完成：内部 Driver 与离线协议切片

- `plugin/lib/drivers/types.js`：能力声明、Driver 校验和标准运行状态；
- `plugin/lib/drivers/codex-app-server.js`：JSON-RPC wire、thread/turn、delta、usage、interrupt、follow-up；
- `plugin/lib/drivers/subprocess-transport.js`：把 DSH managed subprocess 的 stdin/stdout 适配为行协议 transport；
- `plugin/lib/drivers/index.js`：使用托管 `bin/codex`、隔离 `CODEX_HOME` 和现有 verification gate 组装实验 Driver；
- 全部模块已有 fake transport/subprocess 离线测试。

### 真实协议探测已完成

当前托管 Codex 0.149.1 已真实验证：

- 新供应商通过 Responses 工具续接测试；
- `initialize` 后无需 `initialized` 通知；
- `thread/start` 返回 thread/session、隔离 `codexHome`、模型、provider、cwd、permission 和 sandbox；
- `turn/start` 返回 turn id；
- 真实通知包括 `thread/started`、`turn/started`、`item/started`、`item/completed`、`turn/completed`、`error` 等；
- 当前 Driver 已按真实字段修正 `thread/start` / `turn/start` 参数及失败诊断。

### Codex app-server Provider 已通过真实 DSH 验证并切换正式工具

`plugin/lib/drivers/codex-provider.js` 将 Driver 映射为 `managed-codex-app-server` Provider，并复用当前模型路由、权限档和 DSH `SubagentResult`。

真实实验工具已确认：

- 当前 Desktop Profile 加载的是工作区链接版本；
- DSH 能调用新 Provider；
- thread/turn 请求成功；
- 当前项目 cwd、隔离 `CODEX_HOME`、供应商凭据和模型路由生效；
- 最终结果正常回传；
- dispose 后无 Codex app-server 残留进程；
- `thread/start.sandbox` 使用 kebab-case，而 `turn/start.sandboxPolicy.type` 使用 camelCase，两层映射已分别处理。

正式 `cli_codex` 已改为调用 `managed-codex-app-server`，原有 `run_in_background:true` 继续复用 jobs 服务，因此仍支持 `job_output` / `job_kill`。临时实验工具已移除；旧 `managed-codex` Provider 暂时保留作为内部兼容路径，不再由正式工具选择。
