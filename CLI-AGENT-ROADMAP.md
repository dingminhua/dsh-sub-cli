# dsh-sub-cli：CLI Agent 目标与实施路线图

> **产品目标：在 DSH 中统一管理并调用外部 Agent CLI，与用户原生安装完全隔离，可为每个 CLI 预设 Provider、模型、推理强度和权限，并让它们像原生子代理一样被主控调用。**
>
> **当前工作目标：采用 `cli_<产品>_<作用>` 命名体系，先交付 `cli_codex_direct` 与 `cli_codex_subagent`。Direct 模式由主控直接调用 Codex；Subagent 模式创建 DSH 原生 continuable Relay 子代理，由 Relay 调用受限的内部 CLI 工具并向主控报告。全程只使用 DSH 公开机制，不修改 DSH 本体、不打补丁、不改 shipped preset。**
>
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

## 8. 已确认的产品与架构决定

本节记录已由用户明确确认的决定，后续实现、评审和文档不得自行偏离；如需变更，必须先说明原因并重新确认。

### 8.1 产品目标的准确含义

产品目标固定为：

> **在 DSH 中统一管理并调用外部 Agent CLI，与用户原生安装完全隔离，可为每个 CLI 预设 Provider、模型、推理强度和权限，并让它们像原生子代理一样被主控调用。**

其中“像子代理一样”不是仅返回 CLI `sessionId` 或支持外部 thread，而是要求 Subagent 模式具备可观察的 DSH 原生体验：

- 主会话下出现原生子代理卡片与父子关系；
- 有明确的 CLI 产品身份、任务标题和运行状态；
- 可点击查看 Transcript；
- 可被 `list_agents` 发现；
- 支持 `send_message` 与 `interrupt_agent`；
- 完成后向主控发送 settlement 通知并报告结果；
- 实际任务必须由绑定的外部 CLI 完成，Relay 不得自行回答或执行任务。

### 8.2 Direct / Subagent 双模式

项目采用两条清晰分离的公开路径：

1. **Direct 模式**：主控直接调用外部 CLI，适合一次性、低延迟任务；以普通 Tool 结果呈现，不承诺原生子代理体验。
2. **Subagent 模式**：创建 DSH 原生 continuable Relay child，由 Relay 与外部 CLI 的真实 thread/session 通讯，再将结果忠实报告给主控；这是实现“像子代理一样被主控调用”的正式路径。

不得把两种生命周期和返回类型混入同一个含糊的模式参数。

### 8.3 命名与公开入口

采用产品优先的统一命名：

```text
cli_codex_direct
cli_codex_subagent

cli_claude_direct
cli_claude_subagent

cli_qwen_direct
cli_qwen_subagent
```

本阶段只实现 Codex；`cli_codex` 暂时作为 direct 模式的兼容别名，文档标记迁移方向。

### 8.4 Direct 模式

```text
主控 Agent → cli_codex_direct → managedCliAgents → Codex thread → Tool Result
```

特点：低延迟、无 Relay 模型、支持插件 sessionId 与专用 follow-up/status/list/interrupt。普通工具卡片，不承诺原生子代理树体验。

### 8.5 Subagent 模式

```text
主控 Agent
  → cli_codex_subagent
  → DSH 原生 continuable Relay child
  → 内部 managed_cli_submit
  → managedCliAgents / Codex thread
  → Relay report 给主控
```

目标体验：原生子代理卡片、父子关系、Transcript、settlement 通知、`list_agents`、`send_message` 与 `interrupt_agent`。实际工作必须由外部 CLI 完成。

### 8.6 Relay 安全合同

- Relay 子代理只允许受限内部工具与 `report`；不给 read/write/edit/bash/web_search；
- Persona 明确 Relay 不是执行者，每轮必须调用内部 CLI submit；
- 记录每个 Activation epoch 的 submit 次数；
- 本轮 `submitCount === 0` 时确定性拒绝 `report`，防止 Relay 自答冒充 CLI；
- childId 固定绑定一个 CLI、一个 remote thread、cwd、模型和权限快照；
- 初期禁止 Relay 再委派；后续若开放，权限必须满足后代不高于父级；
- 并发 turn 返回 `SESSION_BUSY`，不得静默排队或切换 thread；
- Registry 和输出中不得保存或展示 API Key。

### 8.7 会话绑定与续接语义

Subagent 模式必须稳定维护：

```text
DSH childId
  ↔ 插件 sessionId
  ↔ 外部 CLI thread/session ID
  ↔ cwd / Provider / model / reasoning effort / permission snapshot
```

- 同一个 Relay child 固定绑定一个 CLI 和一个外部 thread/session；
- 首轮由 `managed_cli_submit` 创建外部会话，后续 `send_message` 唤醒同一个 Relay，并续接同一个外部会话；
- Direct 模式的专用 `followup` 工具不是 DSH 原生 `send_message`，UI、工具说明和文档不得混淆；
- 每个 Session 同时最多一个 active turn，并发调用必须明确返回 `SESSION_BUSY`；
- Host 重启恢复需要持久 Registry、lease、stale 状态和 workspace 重绑定，且不得保存 API Key。

### 8.8 权限决定

- 权限在任务或 Relay child 创建时确定并形成不可变快照；
- 后续回合不得静默提升权限，也不得以更高权限重新运行来伪装“继续同一任务”；
- 只有当对应 CLI 提供经过真实验证的结构化暂停、审批回复和同一 turn 恢复协议时，才接入 DSH approval；
- 暂不支持交互式审批的 CLI，应采用固定权限档或明确拒绝；
- 需要权限时，提示顺序固定为：说明被阻止的操作、原因、拟执行的最小动作，以及批准/拒绝的影响，然后再请求用户确认。

### 8.9 技术与产品边界

- 不修改 DSH 本体；
- 不给 DSH 打补丁；
- 不修改 shipped preset；
- 只使用 DSH 已公开的 Plugin、Provider、Service、Tool、Session、Settings 与 Subagent 接缝；
- 不通过普通 Relay 输出冒充外部 CLI 结果；
- 不把 Direct 模式宣传成原生子代理；
- 不把专用 CLI follow-up 宣传成原生 `send_message`；
- 设置页只负责安装、隔离配置、模型路由、验证和诊断，不另建任务管理工作台；
- 主界面与原生子代理 UI 负责运行任务、状态、Transcript、后续消息、中断和结果回传。

### 8.10 推广顺序

1. 先完成并真实验收 Codex Direct/Subagent 双模式；
2. 再按相同合同实现 Claude Direct/Subagent；
3. 再验证并实现 Qwen Direct/Subagent；若原生 CLI 不支持可靠 resume，应明确声明 `continuable: false`，不得伪造持续会话；
4. Host Service 稳定后再接入 AgentTeams、DAG、Workflow 和其他插件。

### 8.11 交付步骤

1. 新增 `cli_codex_direct`，复用当前直接持续会话能力；
2. 保留 `cli_codex` 兼容别名；
3. 新增 Relay Provider/Persona 和内部 `managed_cli_submit`；
4. 新增 `cli_codex_subagent`，通过 `ctx.subagents.startContinuable()` 创建 child；
5. 建立 `childId ↔ pluginSessionId ↔ remoteThreadId` 绑定；
6. 加入 per-epoch submit/report guard；
7. 验证首轮、`send_message`、`interrupt_agent` 与同 thread 续接；
8. 验证 Relay 无 CLI submit 时不能 report；
9. 更新设置页、工具说明、中英文 README 与迁移文档；
10. 测试、打包、真实 UI 验收后提交。

### 8.12 验收标准

- `cli_codex_direct` 返回直接结果和插件 sessionId；
- `cli_codex_subagent` 返回原生 subagentId，并在 DSH 子代理树显示；
- 点击可查看 Relay child Transcript；
- `send_message(subagentId, ...)` 使 Relay 继续同一个 Codex thread；
- `interrupt_agent` 能中断当前回合；
- 每个合法 report 前至少一次内部 CLI submit；
- child/thread/cwd/route/permission 绑定稳定；
- 无 app-server、listener、binding 或 timer 泄漏；
- 不修改 DSH、不打补丁、不改 shipped preset。

### 8.13 当前验收状态（依据会话工作记录）

截至最近一次记录：

- `cli_codex_direct` 已实现；
- `cli_codex` 已保留为 Direct 模式兼容别名；
- `cli_codex_subagent`、`managed-codex-relay` 与内部 `managed_cli_submit` 已实现；
- child binding 与 per-epoch submit-before-report guard 已实现；
- Direct/Subagent、Relay Provider、内部 submit、绑定与安全守卫的离线测试已补充；
- 完整测试结果为 `116 passed / 0 failed`。

真实 DSH 验收进展（2026-08-29）：

1. ✅ `cli_codex_subagent` 返回有效 `subagentId`：`b47ea533-1980-4488-9cb3-dfc4c7b855ce`；
2. ✅ Web 出现原生后台子代理并向父会话发送 settlement/report；
3. ✅ `list_agents` 能发现 Relay child，并正确显示 `ready` / `running` 状态；
4. ✅ Relay 调用真实 Codex 并忠实报告首轮结果：`FIRST_OK:RELAY-20260829`；
5. ✅ `send_message` 续接同一个 Codex thread，返回：`FOLLOWUP_OK:RELAY-20260829`；
6. ✅ `interrupt_agent` 成功中断长任务，随后同一 child 和 Codex thread 可恢复，返回：`AFTER_INTERRUPT_OK:RELAY-20260829`；
7. ⏳ 仍需做一次真实负向测试，确认 report guard 会阻止未 submit 的报告；
8. ⚠️ 资源清理尚未通过：Relay 空闲后仍观察到一组托管 `codex app-server --stdio` 父子进程（PID 83027/83028），需要确认这是预期的可续接驻留还是应在 child 空闲/关闭时释放；
9. ⏳ 仍需核对可点击 Transcript 的完整内容，并完成文档、打包和提交收尾。

当前准确状态为：

> **Codex Subagent 主路径、原生 child、首轮报告、`list_agents`、`send_message` 同-thread 续接以及中断后恢复已经真实通过；剩余阻塞集中在 report guard 负向验收、Transcript 核对和 app-server 生命周期/资源清理。**

## 9. 当前开发目标：统一 CLI 权限审批桥

> 本目标覆盖所有外部 CLI 的运行时权限申请，不限于网络权限。必须将 CLI 的结构化权限请求中转给 DSH 主控和用户，用户作出批准或拒绝后，把决定传回原来的 CLI session/thread/turn 并继续执行；不得重启任务、静默提权或由 Relay 代替用户批准。

### 9.1 目标流程

```text
外部 CLI 发出权限请求
  → CLI Driver 解析原生事件
  → 转换为统一 ManagedCliPermissionRequest
  → 当前 CLI turn 暂停为 awaiting_permission
  → Relay / 主控收到准确的审批说明
  → 用户批准或拒绝
  → DSH approval 决定绑定 requestId 返回 Driver
  → Driver 回复原 CLI 权限回调
  → 原 session/thread 的原 turn 继续
  → Relay 报告最终结果
```

### 9.2 权限范围

统一协议至少覆盖：

- 读取工作区外文件或目录；
- 写入工作区外路径；
- 执行受限或高风险命令；
- 网络访问与代理使用；
- 浏览器或外部应用调用；
- 安装依赖、下载或执行外部程序；
- 访问凭据、系统资源、MCP 或其他外部服务；
- CLI 后续新增的结构化 capability 请求。

文件权限与网络权限必须分开表达；`danger-full-access` 不得自动等同于允许联网或访问所有外部服务。

### 9.3 统一权限事件合同

```text
requestId
childId
cli
pluginSessionId
remoteSessionId
turnId
capability
operation
target
reason
risk
requestedScope
supportedDecisions
createdAt
expiresAt?
```

状态流转：

```text
running → awaiting_permission → running
                            ↘ denied / failed / cancelled
```

审批决定至少支持：

```text
approve_once
approve_turn
approve_session
deny
```

只有 CLI 原生协议真实支持的范围才能暴露；不支持的决定必须明确拒绝，不能静默降级。

### 9.4 权限提示合同

向用户请求审批前必须先用短句准确说明：

1. 哪个 CLI、哪个任务正在申请；
2. 被阻止的具体操作与目标；
3. 为什么需要该权限；
4. 本次准备放行的最小范围；
5. 批准与拒绝各自会发生什么；
6. 是仅一次、本 turn 还是整个 session 生效。

不得先输出长篇解释再堆叠大量选项；不得把代理不可达、DNS 失败等运行现象直接当作最终根因，必须区分权限、配置和基础设施问题。

### 9.5 安全与一致性要求

- Relay 不得自行批准权限；
- 子级权限不得超过父级权限天花板；
- 审批必须绑定 `requestId + childId + sessionId + turnId`，拒绝陈旧或串线决定；
- 等待审批期间不得结束、重启或复制当前 turn；
- 用户拒绝后必须把拒绝结果传回原 CLI，并如实结算任务；
- 不支持暂停/恢复的 CLI 必须在启动前预授权或明确失败；
- 审计记录不得包含 API Key、Token 或凭据正文；
- interrupt、超时、Host teardown 必须结算所有等待中的审批请求；
- Direct 与 Subagent 两种模式共用同一权限事件与审批服务。

### 9.6 实施顺序

1. 盘点 Codex app-server、Claude Code 和 Qwen Code 的原生权限事件、回复协议及暂停能力；
2. 盘点 DSH 当前公开 approval service、tool guard、session event 与 UI 接缝；
3. 定义统一权限类型、状态机、错误码和 capability 声明；
4. 在 `managedCliAgents` 中加入 pending request registry、决策回传和并发保护；
5. 先完成 Codex 的一条真实权限申请纵向切片；
6. 接入 Relay：等待时保留 child，批准后继续同一 Codex turn；
7. 为 Direct 模式接入相同审批桥；
8. 按真实能力接入 Claude 和 Qwen；
9. 补充设置、状态展示、审计记录、中英文文档；
10. 完成自动测试和真实审批验收后提交。

### 9.7 已确认的协议事实（2026-08-29）

- Codex 0.149.1 可通过 `codex app-server generate-json-schema` 导出权威协议；已确认三种新版 server request：
  - `item/commandExecution/requestApproval`：命令、文件系统附加权限和网络附加权限；回复支持 `accept`、`acceptForSession`、`decline`、`cancel` 等；
  - `item/fileChange/requestApproval`：文件变更；回复支持 `accept`、`acceptForSession`、`decline`、`cancel`；
  - `item/permissions/requestApproval`：结构化文件系统与网络权限；回复 `{ permissions, scope: "turn" | "session", strictAutoReview? }`，可原生恢复同一 turn。
- Codex 请求均携带 `threadId`、`turnId`、`itemId`，部分命令请求还有独立 `approvalId`，足以进行严格路由与防串线。
- DSH 公开 seam 为 `ctx.approval.request(req)`，结果是 `allowed-once | rejected | cancelled | unavailable`；请求必须发生在对应 Agent 的开放 turn 内，并写入 `approval/asked` / `approval/decided` 审计事件。
- DSH 当前原生 approval 仅授权一次。Codex 的 session scope 属于 CLI 原生能力，但在没有插件策略与明确 UI 前不得自动映射或暴露。
- Claude Code 已确认有 `manual` permission mode、`stream-json`、session resume，但结构化权限事件与同 turn 审批回复仍需真机抓流验证。2026-08-29 首次真机探测被当前托管配置阻塞：CLI 初始化输出实际 `permissionMode: default`，随后因未登录且 `deepseek-v4-flash` 被 SDK 判为 `unrecognized_model` 而终止，尚未运行到权限事件阶段；在插件设置中修复 Claude Provider/模型/认证前，不得宣称支持交互审批。
- Qwen Code 已确认只有布尔 sandbox 与会话 resume，尚无结构化同 turn 权限协议证据；当前应声明 `interactivePermissions: false`，除非后续抓流获得反证。
- 当前 Codex Driver 已增加 JSON-RPC server request 接收/响应能力，并已把请求接到 `managedCliAgents` 与 DSH `approval.request()`：Direct 使用当前主控 Agent；Relay 使用创建 child 时绑定的父主控 Agent，避免 delegated child 的 `approvalPolicy: never` 阻断审批，也禁止 Relay 自批。
- 已实现 `awaiting_permission`、pending request 快照、重复请求 `PERMISSION_REQUEST_BUSY`、允许/拒绝/取消映射以及同 turn 恢复的 fake transport / Service 测试。
- 当前 Desktop profile 已通过 `link:/Users/dmh2002/DshProject/dsh-sub-cli/plugin` 指向工作区；需要重启 DSH Desktop 加载最新 Host 模块后，才能做真实 Web 批准/拒绝验收。

### 9.8 当前实现与验证状态（2026-08-29）

已完成：

- `plugin/lib/permissions.js`：三类 Codex 请求规范化、路由身份、用户提示和 DSH outcome → Codex response 映射；
- Codex JSON-RPC wire：接收并回复 server request，未知请求 fail loud；
- Codex Driver：`interactivePermissions: true`、`awaiting_permission`、同 turn 允许/拒绝/取消恢复；
- `managedCliAgents`：pending permission 快照、`PERMISSION_REQUEST_BUSY`、Direct/Relay 共用审批、父主控路由、interrupt 清理；
- 插件显式依赖 DSH `approval` service；Relay child 不持有自批能力；
- 自动测试覆盖 structured permissions、command、file change、允许、拒绝、取消、重复请求、父 Agent 路由和等待审批时 interrupt；
- 当前完整测试为 `134 passed / 0 failed`；语法、diff 和 `npm pack --dry-run` 已通过。
- 已按产品决定增加简单降级提示：当权限申请被拒绝、不可用或当前会话禁用审批时，Direct、Relay 以及 Claude/Qwen one-shot 路径不再重复申请，而是返回 `CLI_PERMISSION_CONFIGURATION_REQUIRED`，提示用户前往“设置 → 插件 → 外部 Agent CLI 管理器 → 对应 CLI → 权限”，将权限调整为“完全”，保存后重新执行。

真实 Host 验收进展：

1. ✅ 已重启 DSH Desktop 并加载工作区链接插件的新 Host 模块；
2. ✅ Direct 模式能触发真实 Codex 权限请求并在主控显示审批；拒绝后命令未执行，原任务收到拒绝；
3. ✅ Subagent 模式能通过 Relay 触发真实请求，审批卡片归属父主控；Relay 无法自批，拒绝后忠实报告；
4. ✅ 已多次验证拒绝路径，临时测试文件均未创建，未发现静默提权或重跑绕过；
5. ⏳ 批准路径尚未取得证据：持久审计日志显示所有真实请求均为 `approval/asked` 后约 1ms 立即写入 `approval/decided: rejected`。当前会话运行时策略是 `approval policy: never`，请求在进入人工 UI 前即被确定性拒绝；必须在启用 `ask` 的新会话中验收 `allowed-once`。用户在聊天中表达“同意允许一次”不能替代对具体 `requestId` 的审批决定；
6. ⚠️ 一次真实任务中 Codex 在审批被拒绝、验证命令未执行的情况下错误报告 `DIRECT_APPROVAL_OK`。独立文件检查和同-thread 追问证实这是 CLI 文本误报；插件已新增 `lastPermissionDecision { requestId, turnId, capability, outcome, decidedAt }` 作为权威状态，验收不得只相信 CLI 自述；
7. ⏳ 需在 `approval policy: ask` 的新会话中点击审批卡片“允许一次”，然后核对 `lastPermissionDecision.outcome === "allowed-once"`、实际副作用、原 turn 继续、`approval/asked` / `approval/decided` 审计、Session 状态和进程清理；
8. ⏳ 修复 Claude Provider/模型/认证后再抓取 `manual + stream-json` 权限协议；Qwen 在无反证前保持 `interactivePermissions: false`。

### 9.9 验收标准

1. 真实 CLI 权限请求能转换为统一事件并显示给主控/用户；
2. 提示包含申请者、操作、目标、原因、最小范围和批准/拒绝后果；
3. `approve_once` 后原 CLI 的同一个 session/thread/turn 继续；
4. `deny` 后原 CLI 收到拒绝且任务不被冒充成功；
5. 不通过提高启动权限或重跑任务伪造恢复；
6. 网络、文件、命令至少各有一类自动测试；
7. 陈旧 requestId、跨 child 决定和重复决定全部 fail loud；
8. waiting 状态下 interrupt、超时和 Host teardown 正确结算；
9. Relay 无权替用户审批，后代权限不超过父级；
10. 不支持交互式审批的 CLI 有明确 capability 和降级行为；
11. 权限日志不泄漏密钥；
12. 真实 DSH 中完成至少一次批准继续和一次拒绝结算验证。

## 10. 当前实现进度

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
