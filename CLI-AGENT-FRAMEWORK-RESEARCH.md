# 通用子代理委托框架增量调研

> 调研日期：2026-08-29
> 用途：补充 `CLI-AGENT-REFERENCE-RESEARCH.md`，重点研究通用委托框架、角色定义、外部 CLI Engine 与 DAG 编排。
> 本文只记录此前尚未深入研究的项目；`dsh-subagent-claude-code-wrapper`、`dsh-llm-agy`、`dsh-agent-conductor` 的完整结论见前一份调研。

## 1. 本次范围与研究副本

| 项目 | 同级研究目录 | 上游来源 |
|---|---|---|
| dsh-plugin-subagents | `../dsh-plugin-subagents` | https://github.com/Luck9Star/dsh-plugin-subagents |
| dsh-routed-subagent | `../dsh-routed-subagent` | https://github.com/bpc-oss/dsh-routed-subagent |
| dsh-plugin-product-subagents | `../dsh-plugin-product-subagents` | https://github.com/shaokeyibb/dsh-plugin-product-subagents |
| dsh-custom-subagents | `../dsh-custom-subagents` | https://github.com/ktdhhc/dsh-custom-subagents |
| dsh-dag-orchestrator | `../dsh-dag-orchestrator` | https://github.com/Luck9Star/dsh-dag-orchestrator |
| 官方 Claude Provider | `../dsh-subagent-claude-code-official` | npm `@deepseek-ai/dsh-subagent-claude-code` / deepseek-harness monorepo |
| AlataStudio Claude Provider | `../dsh-subagent-claude-code-alatastudio` | npm `@alatastudio/dsh-subagent-claude-code` |

已在上一轮研究、本文不重复源码分析：

- `dsh-subagent-claude-code-wrapper`
- `dsh-llm-agy`
- `dsh-agent-conductor`

## 2. 结论概览

| 项目 | 核心抽象 | 外部 CLI 连续性 | 工作目录 | 权限模型 | 对 dsh-sub-cli 的主要价值 |
|---|---|---|---|---|---|
| dsh-plugin-subagents | 统一 `SubagentDriver`，native + bridge | durable registry + relay child | native 按调用 cwd；bridge 用父 cwd | 角色权限 + 向下天花板 | 最完整的统一委托框架与安全合同 |
| dsh-routed-subagent | 单工具路由到 DSH preset 或外部 Engine | Codex thread、Claude session、CodeBuddy resume | 外部 Engine 按调用 cwd | 多数 unattended / skip permission | 原生协议 Engine、实时进度、app-server 驱动 |
| product-subagents | 角色化 product bridge + relay child | registry + CLI session id | 父 cwd | readonly/default/full + 天花板 | 稳定的 relay 架构和 ACP 通用桥 |
| custom-subagents | 可复用角色定义目录 + 原生 Provider | 复用 DSH continuable | 由原生 spawn/fork 决定 | 父工具子集 + 统一嵌套策略 | 设置页角色产品化、定义/实例分离 |
| dag-orchestrator | SQLite 持久 DAG + 程序化 subagent 调度 | DAG 状态持久，而非同一 CLI 会话 | 每任务 cwd/worktree | 默认禁止任务自驱 DAG/再委派 | 多任务编排、恢复、审批门、审计事件 |
| 官方 Claude Provider | one-shot SDK Provider | 无 | 父 cwd | 无人工交互；失败 | 官方最小严格 Provider 基准 |
| AlataStudio Claude Provider | 官方路线增强版 | 无 | 父 cwd | 固定 permissionMode | 安全诊断与可配置权限模式 |

## 3. dsh-plugin-subagents

### 3.1 定位

这是本次调研中最接近“通用子代理委托框架”的实现。它用一套 `subagent` 工具同时覆盖：

- DSH 原生 in-process spawn/fork；
- Claude Code bridge；
- Codex bridge；
- Grok bridge；
- 任意 ACP agent；
- 角色化委派。

按次参数包括：

- `backend`
- `role`
- `cwd`
- `model` / `provider`
- `persona`
- `toolFilter`
- `permission_mode`
- `reasoning_effort`
- `run_in_background`

### 3.2 SubagentDriver 抽象

它明确把 native 和 bridge 的差异建模成 capability flags，而不是假装所有后端都支持同一组参数。核心能力包括：

```text
cwd / persona / toolFilter / llmRoute / maxDepth
permissionMode / reasoningEffort
continuable / backgroundJob / durableResume
```

任何后端不支持的参数都“明确失败”，不静默忽略。这一点非常适合 `dsh-sub-cli`：Codex、Claude、Qwen 的真实能力必须通过 driver capabilities 声明，而不能用一个过度宽泛的 Tool schema 假装等价。

### 3.3 Native 与 Bridge 的分工

Native Driver：

- 直接走 `ctx.subagents.start` / `startContinuable`；
- 支持 per-call 模型、provider、persona、工具过滤和 cwd；
- cwd 在其目标 DSH 版本仍需要补丁；
- foreground、job、continuable 三种路由。

Bridge Driver：

- `create / submit / reconnect / dispose` 产品桥；
- continuable child 实际是一个 DSH relay 子代理；
- relay 只拥有 `subagent_submit` 等最小工具；
- 真实任务由外部 CLI 完成；
- durable registry 记录 child 与远端 session/thread 的映射。

### 3.4 持久恢复

三层连续性：

1. 内存 binding；
2. `~/.dsh/subagents-registry.json` durable registry；
3. 子会话日志 marker（只用于展示/辅助，不作为授权依据）。

重启后恢复只信任 binding 或 registry，不信任模型写入日志的自述。注册表用原子写、0600 权限并限制最大条目数。

### 3.5 权限天花板

权限等级：

```text
readonly < default < full
```

当 bridge 子代理继续委派后代时，后代权限不得超过父级。未知权限按 readonly 处理。这是一个重要原则：`dsh-sub-cli` 如果允许 CLI Agent 自己再委派，也必须把权限等级作为谱系属性持久化，而不能只在当前内存中判断。

### 3.6 Relay 诚实守卫

relay 子代理可能不调用外部 CLI，而直接用自己的模型回答。该项目增加确定性 guard：

- 当前 epoch 未调用过 `subagent_submit`；
- 却尝试调用 `report`；
- guard 拒绝该 report，让 relay 必须先真实转发。

这是非常有价值的发现：如果采用 relay 模型，必须证明结果来自产品 CLI，而不是 relay 自答。更理想的 `dsh-sub-cli` 应尽量由代码直接驱动 CLI，减少 relay 模型这一层；确实需要 relay 时必须保留类似守卫。

### 3.7 限制与风险

- 接管官方 `subagent` / `subagent_fork` 名称，容易与其他插件冲突；
- Web preset 作用域可能遮蔽全局同名工具，需要 preset 适配；
- 某些 DSH 版本需要修改/补丁 cwd 转发；
- `dsh-tools` 多物理副本会造成 Symbol 不一致，工具全部失效；
- bridge 架构比直接 CLI Provider 多了一层 relay 模型和 token 消耗。

### 3.8 对 dsh-sub-cli 的结论

应借鉴：

- capabilities 驱动的统一 Driver；
- 参数不支持时 loud failure；
- durable CLI session registry；
- 权限天花板；
- 输出脱敏；
- 进程树和 Windows shim；
- relay 真实性守卫。

不建议：

- 接管通用 `subagent` 工具名；
- 把 CLI 调用完全建立在 relay 模型上。

`dsh-sub-cli` 应继续使用产品专属工具名，底层共享 Driver。

## 4. dsh-routed-subagent

### 4.1 两种路由职责

该项目原始目标是让子代理完整挂载任意 Agent Preset，而不是继承父 preset。后来又加入外部引擎：

- `dsh`：完整挂载目标 preset；
- `codex`：Codex app-server stdio；
- `claude`：Claude Agent SDK；
- `codebuddy`：NDJSON CLI。

同一工具 `subagent_routed` 支持 foreground、background job、fork 和 continuable。

### 4.2 Codex app-server Engine

这是本轮最值得研究的实现之一：

```text
codex app-server --stdio
```

通过 newline-delimited JSON-RPC 调用：

- `initialize`
- `thread/start`
- `turn/start`
- `turn/interrupt`

并消费：

- `item/agentMessage/delta`
- `turn/completed`
- `turn/failed`
- `thread/tokenUsage/updated`

优势：

- 实时进度；
- 真正的 turn interrupt；
- 明确 thread id；
- 同 thread 多轮继续；
- 模型在 `thread/start` 指定；
- 比每轮 `codex exec` 更适合做长期 CLI Agent。

实现中每个 run 使用独立 app-server process，因为部分 delta 通知不带 thread/turn id，共享进程会造成多任务输出串线。这说明协议层的“是否可多路复用”必须根据事件是否有路由标识决定，不能只看协议支持多个 thread。

### 4.3 Claude Engine

通过 Claude Agent SDK：

- one-shot 可实时读取 assistant/stream event；
- AbortController + query.close 取消；
- `persistSession: true`；
- sessionId / resume 实现 continuable；
- 人工审批请求统一拒绝。

但项目明确指出：自定义 Anthropic Base URL 时，SDK session persistence 可能不可靠。这对当前托管 Claude 使用第三方 provider 非常重要：不能仅因官方 SDK 支持 resume，就宣称所有中转商环境下都可靠，必须加入真实续接验证。

### 4.4 CodeBuddy Engine

通过：

```text
--print --output-format stream-json --include-partial-messages
--session-id <uuid> / --resume <uuid>
```

解析 NDJSON 的 `text_delta` 与 terminal result，支持模型、实时进度、kill 和继续会话。但默认使用 `--dangerously-skip-permissions`，只适合预授权模式。

### 4.5 Preset 路由能力

它还能完整 mount 指定 Agent Preset，使子代理获得目标 preset 的 persona、技能、工具和 prompt sections，而不只是复制 persona。这对 `dsh-sub-cli` 不是核心需求，但说明“角色”有两种层次：

1. 轻量角色：给 CLI 追加 instructions；
2. 完整 DSH preset：给 DSH 子代理完整组合。

外部 CLI Agent 不应误称自己挂载了 DSH preset，除非真的通过 DSH Agent 层执行；CLI 侧只能映射角色说明、工作目录与权限。

### 4.6 风险

- continuable preset mount 依赖修改官方 `dsh-subagent` 包；
- README 与 `lib/index.js` 顶部注释存在版本演进痕迹，阅读时要以当前实现为准；
- CodeBuddy 和部分 Claude 路径默认无人值守/跳过权限；
- 插件 private、仅 GitHub 分发；
- 多种职责集中在一个大文件/单工具中，边界较重。

### 4.7 对 dsh-sub-cli 的结论

优先借鉴 Codex app-server driver：

- JSON-RPC request/notification 分离；
- per-run wire 隔离；
- thread/turn 生命周期；
- turn interrupt；
- 实时 progress；
- token usage。

同时为 Claude/Qwen driver建立真实“第三方后端下 resume 是否可用”的验证能力。

## 5. dsh-plugin-product-subagents

### 5.1 定位

这是 `dsh-plugin-subagents` bridge 体系的前身/专门版本，聚焦：

- Claude Code；
- Codex；
- 任意 ACP agent；
- 声明式角色；
- continuable relay child；
- 权限天花板。

### 5.2 Relay 架构

```text
root model
  → product_delegate
  → DSH continuable relay child
  → product_submit
  → Claude/Codex/ACP bridge
  → remote session
```

Relay 永远是只读传话筒，产品权限由远端 CLI flags 控制。

### 5.3 Bridge 合同

```text
create(cwd)
submit(remote, task, signal, cwd, settings)
reconnect(sessionId, cwd)
dispose(remote)
```

`settings` 包含 model、reasoningEffort、permissionMode。

Codex 每个 message 运行一次 `codex exec --json`：

- 首轮从 `thread.started` 增量捕获 thread id；
- 后续 `exec resume <thread_id>`；
- readonly 映射 `-s read-only`；
- full 映射危险 bypass 参数。

“增量捕获 session id”十分重要：即使本轮中途被取消，也应尽早保存已出现的 thread id，避免下一轮无法恢复。

### 5.4 ACP 通用性

配置可零代码增加：

- Cursor `agent acp`
- CodeBuddy `cbc --acp`
- Gemini `gemini --acp`
- OpenCode `opencode acp`

这说明 `dsh-sub-cli` 后续若扩展非首批 CLI，应该优先判断它是否支持 ACP；支持则复用 ACP Driver，不再为每个产品编写独立 stdout parser。

### 5.5 对 dsh-sub-cli 的结论

该项目最适合作为：

- bridge interface 参考；
- session registry 参考；
- permission mapping 参考；
- ACP 扩展参考。

但直接 CLI Driver 能避免 relay 模型额外成本，所以本项目应把 relay 作为兼容后备，不作为 Codex/Claude/Qwen 默认路径。

## 6. dsh-custom-subagents

### 6.1 它不是外部 CLI 桥

该项目主要管理可复用的 DSH 专业角色：

- Explorer；
- Code Reviewer；
- 文档撰写；
- 用户自定义 Agent。

它复用原生 spawn/fork Provider，不负责外部 CLI 协议。但它在“如何把角色产品化”方面非常成熟。

### 6.2 定义与实例分离

核心领域模型：

- Definition：持久角色配置；
- Instance：根据定义快照创建的原生 DSH 子代理。

编辑或删除 Definition 只影响未来实例，不改变正在运行或历史实例。定义有稳定隐藏 ID，显示名称可变。

该原则也应适用于 `dsh-sub-cli`：

- CLI 配置/角色模板是定义；
- 每个 CLI Agent Run 是不可变的运行快照；
- 运行中修改模型或权限不能悄悄改变已启动任务。

### 6.3 单一 delegate_agent 工具

不是每个角色一个工具，而是：

```text
delegate_agent(definition_id, description, prompt, mode, run_in_background)
```

Tool description 动态包含可用角色的紧凑目录，并设置条目数和文本字节上限，避免用户创建大量定义后撑爆父模型 prompt。

对于 `dsh-sub-cli`，产品 CLI 工具目前只有 3 个，不必合并成一个；但未来如果支持大量用户自定义 CLI/角色，可以增加一层有限目录，而不是无限注册新工具。

### 6.4 权限与工具解析

- 子代理工具永远是父 Agent 可见工具的子集；
- 角色请求的任一能力无法完整满足时，委派前失败；
- 不做部分静默降级；
- persona 叠加在 DSH 安全 Prompt 上，不替换安全指令。

### 6.5 嵌套委派治理

统一管理三种创建入口：

- `delegate_agent`
- `subagent`
- `subagent_fork`

策略：

- 根 Agent 始终允许创建；
- 可配置禁止所有子 Agent 再委派；
- 无论开关如何，硬深度上限为 3；
- 工具面隐藏 + 全局 guard 执行拒绝双层防护；
- `list_agents` / `send_message` / `interrupt_agent` 不受影响。

这对 CLI Agent 同样适用：控制现有任务和创建新任务必须是两类权限，不应因禁止嵌套而禁止 follow-up 或 interrupt。

### 6.6 UI 价值

设置页将底层概念转成用户语言：

- Name
- Description
- System prompt
- Model
- Context
- Tools

不暴露 provider、raw allow/deny、最大深度、内部 Provider 名称等高级细节。`dsh-sub-cli` 的 CLI 设置卡也应保持这一原则：高级协议与 driver 状态用于诊断，不应成为普通用户必填项。

## 7. dsh-dag-orchestrator

### 7.1 定位

它不是 CLI Provider，而是程序化调用 `ctx.subagents.start()` 的持久 DAG 调度器。每个 agent task 节点对应一次子代理委派。

### 7.2 执行模型

主要工具：

- `dag_plan`
- `dag_tick`
- `dag_status`
- `dag_control`
- `dag_approve`

DAG 支持依赖、并行、重试、失败传播、结构化输出、approval、worktree 和 merge。

### 7.3 持久化与恢复

SQLite 单库保存：

- runs
- tasks
- attempts
- events
- approvals
- outputs

每次投影变化与事件写入同一事务，事件带 SHA-256 哈希链。启动时先校验和崩溃对账，再注册工具。

关键调度原则：

```text
run.result Promise 是终态事实源
subagent/end 事件是加速器
dag_tick 是兜底泵
```

这是比单纯轮询或单纯事件更可靠的三层组合。

### 7.4 安全边界

DAG task 默认 deny：

- 所有 `dag_*` 控制工具；
- `subagent` / `subagent_fork`。

上游输出明确标为 DATA 而非 instructions，降低提示注入风险。只有 spec 显式允许 delegation 时才放开子代理创建。

### 7.5 与通用外部 CLI Bridge 的边界

该项目的设计文档明确指出：stock `SubagentStartRequest` 不携带 bridge 的 model/permission/reasoning settings，因此 DAG MVP 只诚实支持 native backend。它建议通用子代理框架提供一个程序化 dispatch service。

这直接提示 `dsh-sub-cli`：除了模型 Tool，还应该提供 Host Service，例如：

```text
managedCliAgents.dispatch({
  cli,
  task,
  cwd,
  model,
  permissionMode,
  runMode,
  parent,
  signal
})
```

这样 DAG、AgentTeams 或其他插件可以直接调度托管 CLI，而不是模拟模型去调用 `cli_codex` 工具。

### 7.6 对 dsh-sub-cli 的结论

应预留：

- 程序化 dispatch service；
- attempt/run ID 与 CLI child ID 对应；
- 可供编排器读取的纯 JSON 状态；
- approval wait 状态；
- structured result；
- 每任务 cwd/worktree；
- 取消/恢复幂等性。

不建议把完整 DAG 引擎直接塞进 `dsh-sub-cli`。两者应以服务契约组合。

## 8. 官方与 AlataStudio Claude Provider

### 8.1 官方 @deepseek-ai 版本

官方 npm 研究包是较早的 `0.0.1-rc.1`，核心性质：

- 固定注册 `claude-code`；
- one-shot；
- 父 cwd；
- 共享 subprocess 管理进程树；
- strict SDK success；
- `persistSession: false`；
- 无人工交互路径；
- 不支持角色、tool filter、结构化输出、continuable 或 progress；
- 宿主 Claude 设置和账户状态是权威来源。

### 8.2 @alatastudio 版本

AlataStudio 包的 repository metadata 仍指向 deepseek-harness，但它是重新打包/演进的公开 bundle：

- package namespace 换为 `@alatastudio/*`；
- 默认 Provider 名仍是 `claude-code`，可配置 providerName；
- 增加 `permissionMode`；
- 增加启动/运行/进程/清理阶段的安全诊断；
- SDK 自带平台 CLI，不读取宿主 PATH 选择 executable；
- 仍为 one-shot、无 resume、无进度、无人工交互。

它与 `dsh-subagent-claude-code-wrapper` 的关系是：wrapper 基于这一更成熟路线，再暴露 `executablePath`，允许指定任意兼容 CLI。

### 8.3 兼容性提醒

AlataStudio 包依赖 `@alatastudio/dsh-*` peer，而当前项目运行在 `@deepseek-ai/dsh-*` 宿主上，不能仅因为代码相似就直接混装。它适合作为实现参考，不是当前 DSH 的即插即用替代。

## 9. 对 dsh-sub-cli 架构建议的增量修订

结合两轮调研，建议最终拆为五层。

### 9.1 Managed CLI Registry

继续负责：

- 安装、更新、删除；
- executablePath；
- 隔离配置目录；
- provider/model 配置；
- protocol verification；
- readiness。

### 9.2 CLI Driver

每个 Driver 声明 capabilities：

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

实现优先级：

1. Codex app-server Driver；
2. Claude Agent SDK / CLI Driver；
3. Qwen native stream Driver；
4. ACP 通用 Driver。

### 9.3 Managed CLI Subagent Provider

负责：

- DSH child 生命周期；
- immutable run snapshot；
- 父 cwd 或显式 cwd；
- CLI session ID；
- permission state；
- result/stopReason；
- process ownership；
- follow-up 与 interrupt。

### 9.4 Agent Tool 与 Host Dispatch Service

模型工具保留产品身份：

- `cli_codex`
- `cli_claude_code`
- `cli_qwen`

同时提供程序化 Host Service 给 DAG、AgentTeams 和其他插件：

```text
managedCliAgents.listCapabilities()
managedCliAgents.dispatch(request)
managedCliAgents.followup(childId, message)
managedCliAgents.interrupt(childId)
managedCliAgents.status(childId)
```

### 9.5 Optional Role Catalog

角色是可选上层：

- 角色定义与运行实例分离；
- 权限、模型、说明和 CLI 默认值在启动时快照；
- role 权限不能超过调用者/父 Agent；
- 角色目录有数量和文本上限；
- 普通用户 UI 不暴露内部 Provider 名和 raw tool filter。

## 10. 权限模型修订

新增项目进一步证明，现有生态大多采取两种策略：

1. `dontAsk` / permission request 立即拒绝；
2. `--dangerously-skip-permissions` / approval never。

两者都无法满足“运行中暂停，由用户批准后继续同一个 CLI Agent”。因此 `dsh-sub-cli` 的交互式权限桥仍是有价值的独立创新。

统一权限事件建议：

```text
PermissionRequest {
  runId,
  childId,
  cli,
  kind: read | write | execute | network | tool | elicitation,
  resource,
  reason,
  requestedScope,
  protocolToken
}
```

Driver 能暂停协议时：进入 `awaiting_permission`，用户决定后回写原协议。Driver 不能暂停时：

- 默认拒绝并记录 `permission_denied`；
- 或启动前由用户选择一个明确的 unattended profile；
- 不能在失败后由主代理偷偷用更高权限重跑。

权限等级还应具有谱系天花板：

```text
readonly < workspace-write < full
```

子 CLI Agent 再委派时不得提升。

## 11. 推荐实施次序

1. **先抽象 Driver capabilities 和 Host dispatch service**，不改当前 UI；
2. **Codex 改为 app-server 协议实验实现**，验证进度、interrupt、thread resume；
3. **将现有三个 cli_* 工具切到 continuable Provider**；
4. **CLI session registry 持久化**，保存 thread/session id 与启动时权限快照；
5. **加入 readiness 和真实 resume probe**，特别验证第三方 Claude 后端；
6. **实现 permission request 统一事件**及 `awaiting_permission`；
7. **再考虑角色目录和 DAG/AgentTeams 程序化组合**。

## 12. 最终判断

本轮新增项目中：

- `dsh-plugin-subagents` 提供了最完整的统一 Driver、安全天花板和 durable bridge 设计；
- `dsh-routed-subagent` 提供了最值得直接借鉴的 Codex app-server 外部 Engine；
- `dsh-plugin-product-subagents` 是角色化 relay/ACP bridge 的清晰参考；
- `dsh-custom-subagents` 提供了最佳的角色定义产品模型和嵌套治理；
- `dsh-dag-orchestrator` 说明托管 CLI 应暴露程序化 dispatch service，而不只暴露模型工具；
- 官方/AlataStudio Claude Provider 给出了 one-shot Provider 的严格基准，但无法满足可持续与交互权限目标。

因此 `dsh-sub-cli` 的方向应从“统一安装目录 + 三个无头工具”进一步升级为：

> **统一安装与隔离控制面 + 协议感知 CLI Driver + DSH 原生 continuable Provider + 程序化 dispatch service + 可选角色/编排上层。**
