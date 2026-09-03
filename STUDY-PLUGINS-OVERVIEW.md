# 第一/二梯队插件研读总览（2026-09）

> 本文是 `D:\DshProject\study\reports\` 下九份研读报告的汇总索引，将各项目发现按 dsh-sub-cli 的 `CLI-AGENT-ROADMAP.md` 待解问题归类。
> 调研来源：`RELATED-PLUGINS.md` 第一/第二梯队共 9 个项目，已克隆到 `D:\DshProject\study\`，报告位于 `D:\DshProject\study\reports\`。
> 前置调研（本轮之前）：`CLI-AGENT-REFERENCE-RESEARCH.md`（wrapper/conductor/llm-agy/cursor-acp）、`CLI-AGENT-FRAMEWORK-RESEARCH.md`（plugin-subagents/routed-subagent 等 7 项）。

## 一、九项目速览

| # | 项目 | 报告 | 定位 | 对我们最核心的价值 |
|---|---|---|---|---|
| 1 | dsh-plugin-codex | `reports/dsh-plugin-codex.md` | 本地 Codex 注册为 DSH 主模型 LLM Provider | app-server 的 **provider 视角消费**；`CODEX_HOME`/config.toml 机制实证（我们隔离设计的直接证据）；`thread/inject_items`/`turn/steer`/`currentTime/read` 等新方法；错误分类与进程卫生 |
| 2 | dsh-codex-workflow | `reports/dsh-codex-workflow.md` | Codex 只读规划/审查角色 + DSH 唯一执行者 | **app-server 协议地图**（14 方法）；三层只读约束（argv+协议+prompt）；可证明的超时预算公式；SQLite 围栏；fake-app-server 测试夹具蓝图 |
| 3 | dsh-codex-bridge-lavender | `reports/dsh-codex-bridge-lavender.md` | 让外部工具把 DSH 当可恢复子代理（方向相反） | Windows spawn 编码规避（bin.js 直连）；心跳判活+孤儿检测；events.jsonl+cursor 消费协议；fake-CLI 行为开关测试 |
| 4 | dsh-codex-bridge-pandashere | `reports/dsh-codex-bridge-pandashere.md` | call_codex 工具 + 自绘 Codex 标签页 | `codex exec --json` stdout JSONL 解析；**自绘 UI 成本核算**——验证"复用原生 subagent UI"决策 |
| 5 | dsh-codex-connect | `reports/dsh-codex-connect.md` | ChatGPT OAuth + Codex 模型接入 | **cli_test 六态结果分类**；官方 atomic-write/home-paths 包路线；SSE 帧级解析；证据最小化纪律；trusted-origins 安全模式 |
| 6 | dsh-kernel-codex | `reports/dsh-kernel-codex.md` | 28 个 Codex 工具重实现为 DSH 原生工具 | 工具下沉路线的完整剖析——结论：与我们子代理路线本质不同，不采纳为产品主体 |
| 7 | dsh-codex-oauth | `reports/dsh-codex-oauth.md` | pi-ai CredentialStore + OAuth 登录流 | **薄编排层哲学**：硬工程全委托官方包；锁内 read-modify-write；五层测试矩阵；"锁只保自己人"警示 |
| 8 | dsh-claude-code-yuki | `reports/dsh-claude-code-yuki.md` | Claude Code 作 DSH 主循环 + 轨迹实时可见 | **trace.mjs 流事件翻译完整实现**；**canUseTool 权限桥（awaiting_permission 的 Claude 侧完整样本）**；session id 旁路持久化；子代理投影 lineage 树 |
| 9 | dsh-plugin-cc | `reports/dsh-plugin-cc.md` | Claude Code 插件调 DSH（方向相反） | **unattended overlay 生成 + permission-presets 拒绝启动的坑**；DSH SDK wire 协议（3 请求 4 通知 + run-to-idle）；generation 会话失效；角色 prompt 双模板 |

## 二、按 roadmap 待解问题归类

### 1. Codex app-server 协议接线（roadmap 第 2 步）

三个项目从三个视角拼出完整地图：

- **方法表面**（workflow 报告 §3.1）：initialize/initialized、model/list、thread/start、thread/name/set、thread/read、thread/resume、thread/settings/update、thread/fork、thread/unsubscribe、turn/start、turn/interrupt、collaborationMode/list、review/start + turn/completed 通知；
- **provider 视角新增**（plugin-codex 报告）：`thread/inject_items`（冷重建历史注入）、`turn/steer`（排队后续消息）、`currentTime/read`（**必须应答否则挂死**的 server-request）、`experimentalRawEvents`；模型在 thread/start 固定、effort 走 turn/start 每轮可变；server-request 应答表（thread.ts:99）；
- **沙箱参数**（workflow 报告）：`thread/start {sandbox:"read-only"}` 与 `thread/settings/update {sandboxPolicy:{type:"readOnly",networkAccess:false}}`——比 CLI argv 更细（禁网络）。

**落地**：CodexDriver 以 workflow 的 `app-server.ts` 客户端骨架为起点（crossSpawn+readline 分帧+PendingRequest+stderr 尾部保留+空闲管理），吸收 plugin-codex 的版本校验、server-request 应答、进程卫生（私有 0700 cwd、2×grace waitForExit）。

### 2. 流事件翻译（roadmap 第 2-3 步）

- **Claude 侧完整实现**（yuki 报告 §3.1）：trace.mjs 446 行纯映射——system/init→request/header+session_id 捕获、stream_event→chunk（text/reasoning/tool-call delta）、assistant→step 开闭+message+tool/call、user(tool_result)→tool/result、result→request/context+usage 兜底；TOOL_NAME_MAP 工具名映射表（对不上全落通用卡片）；usage 权威在 message_delta（message_start 是陷阱）；AskUserQuestion 的 deny 是答案不是错误；
- **中间表示**（lavender 报告 §5.3）：events.jsonl + 单调 seq + cursor 增量消费 + 64KiB 上限 + 长轮询——Driver 流事件到子会话历史的缓冲层设计；
- **Codex exec JSONL**（pandashere 报告）：`codex exec --json` stdout 逐行解析 + settle 单终态守卫。

### 3. 会话持久化与 durableResume（roadmap 第 4 步）

- **多进程失效判定**：三方互证——workflow 的单调 epoch（永不重置，失租者停写）、plugin-cc 的 generation（runtime 重生即全失效）、plugin-codex 的 epoch 深比较（配置漂移冷重建）；**我们 session registry 必须带"进程代"概念**；
- **最小起步**：yuki 的 session id 旁路持久化（fire-and-forget 落盘）+ lavender 的 per-task 目录四件套（meta/events/result/heartbeat）+ 心跳判活（查心跳不查 PID）；
- **高级形态**：workflow 的 SQLite 单库（BEGIN IMMEDIATE + 围栏条件 UPDATE + workspace 指纹绑 verdict——"旧结论不能通过变化了的代码"）；
- **warm/cold 语义**（plugin-codex）：tryResume 仅接受"精确前缀追加"的延续，否则冷重建（thread/inject_items 重放）。

### 4. awaiting_permission → approve → resume（roadmap 第 6 步）

- **Claude 侧完整样本**（yuki 报告 §3.3）：canUseTool 决策链——每次工具调用重读会话权限（回合中切 preset 立即生效）、工作区内外分流、bypass 时直接 permissionMode:bypassPermissions 不挂回调、AskUserQuestion→DSH 选择题桥（deny-as-answer workaround）、全程 fail-closed、reason 字段信息拼装；
- **Codex 侧回避方案**（workflow）：`approval_policy=never` + 只读沙箱全程 unattended——恰恰说明 Codex 侧难做，是待突破空间；
- **DSH headless 侧的坑**（plugin-cc 报告 §3.1）：dsh-base permission-presets 服务对不命中的 sandbox+approval 组合**拒绝启动**，且默认审批 `ask` 在 headless fail-closed——必须生成 unattended overlay（approval.policy: never + 匹配 preset），让真实边界落在 DSH_PERMISSION_MODE。

### 5. 权限谱系天花板（roadmap 权限目标）

- **三层约束证据**（workflow 报告 §3.2）：CLI argv（`--sandbox read-only -c approval_policy=never`）+ 协议（sandboxPolicy readOnly + networkAccess:false）+ prompt（辅助，明说"沙箱保证了只读"）——机制为主、prompt 为辅；
- **我们的映射已对齐**：权限能力开关（读/写/执行）→ 沙箱档位，与上述机制级约束同一层次。

### 6. 探测/readiness 与程序化调度（roadmap 第 5、8 步）

- **六态结果分类**（connect 报告 §5.1）：completed / http-rejected / transient / incomplete / timeout / network-error——**429/5xx/302 一律 transient，不得报"供应商不支持协议"**；TTL 缓存（key 含配置指纹）；探测前版本门禁；证据最小化（无文本保留、泄漏断言测试）；
- **工具下沉路线结论**（kernel-codex 报告）：28 工具重实现 vs 我们调度真实 CLI——本质不同；"CLI 能力下沉"若做，应是主控经子会话转发真实 CLI 工具，而非重实现工具面；
- **程序化调度参考**：pandashere 的 4 工具族（call/status/abort/steer）+ lavender 的 5 MCP 工具异步任务模型（start/poll/cancel/list/status + 幂等 taskId）。

### 7. UI 决策验证（复用原生 subagent UI）

- **pandashere 报告的关键证据**：自绘标签页 ~505 行 UI+构建代码，独有价值仅剩"Codex 内部 Agent Loop 瀑布"，列表/状态/历史/composer 避让全是重复实现，且无 UI 中断/续接（交互靠工具曲线救国）；
- **yuki 反向印证**：DSH 会话事件体系（turn/step/assistant/tool + wire 工具名分类渲染）足以承载外部 CLI 完整轨迹，不需要自绘 UI；
- **结论**：复用原生 subagent UI 的决策成立；深度视图（CLI 内部步骤瀑布）可作为原生详情内补充区块，远期可选。

### 8. 基础设施发现（不属于 roadmap 但直接影响实现）

- **官方包是生态标准**（connect + oauth 双报告坐实）：`@deepseek-ai/dsh-atomic-write`（withFileLock+writeFileAtomic）+ `@deepseek-ai/dsh-home-paths`（resolveDshHome）——**需做版本兼容性调查后引入**；
- **oauth 的"锁只保自己人"警示**：我们的场景里外部 CLI 自行重写 auth.json，文件锁只保护我们自己的写者，与 CLI 的竞争靠原子写+读容错；
- **Windows 专项**：bin.js 直连规避 cmd.exe GBK（lavender）；Windows 最小环境变量白名单 + 进程组 kill 不可用的替代（plugin-codex）；POSIX-only 的 broker 形态要换 named pipe（plugin-cc）；
- **SQLite 情报**（workflow）：Node 24.14.0 内置 SQLite ≤3.51.2 有 WAL bug——若用 SQLite 管多进程状态，用 rollback journal + synchronous=FULL。

## 三、三 CLI 能力谱系（本轮补齐）

| 能力 | Codex | Claude Code | Qwen Code |
|---|---|---|---|
| 协议通道 | app-server --stdio（JSON-RPC NDJSON）+ exec --json resume | Agent SDK query()（含 stream-json） | （此前调研：chat 型 CLI） |
| 中断 | turn/interrupt | SDK abortController | — |
| 续接 | thread/resume / exec resume <id> | resume: sessionId（session_id 旁路持久化） | — |
| 权限交互 | approval_policy=never 回避（难点） | canUseTool 回调桥（完整样本） | — |
| 流式 | turn/completed 通知 + item 事件 | stream_event 增量（完整映射） | — |
| 隔离 | CODEX_HOME + config.toml model_providers（实证） | pathToClaudeCodeExecutable + env 整体替换注意 | — |

## 四、行动清单（按优先级）

1. **立即（cli_test 改进）**：六态结果分类替换二分法；transient 与 http-rejected 分离；泄漏断言进测试（connect 报告 §5.1/§7.1）；
2. **立即（避坑）**：核对权限档位推导与 permission-presets 拒绝启动的交互（plugin-cc 报告 §7.1）；核对 Windows spawn 编码路径（lavender 报告 §5.1）；
3. **短期（CodexDriver）**：以 workflow app-server.ts 骨架 + plugin-codex 的版本校验/server-request 应答/进程卫生实现实验 Driver；测试夹具按 workflow 的 fake-codex-app-server.mjs 蓝图（八方法起步）；
4. **短期（ClaudeDriver）**：trace.mjs 映射 + approval.mjs canUseTool 决策链移植（方向反转：写子会话而非主会话）；
5. **中期（session registry）**：文件级起步（per-task 四件套 + 心跳判活 + 进程代失效），SQLite 围栏作多进程升级预案；workspace 指纹校验进结果回放路径；
6. **中期（超时预算）**：采用"串行轮数×turn超时 + RPC数×RPC超时 + 回读窗 + 清理余量"公式（workflow 报告 §3.6）；
7. **依赖调查**：dsh-atomic-write / dsh-home-paths 在我们 peerDeps 范围的可用性；
8. **文档沉淀**：建 `CLI-DRIVER-COMPAT.md` 集中记录"DSH/CLI 行为事实"（headless 无 --model、SDK 无 cancel、app-server 方法表、Claude SDK 契约、permission-presets 坑、SQLite WAL bug……），仿 plugin-cc 的 dsh-compat.md 文档法。

## 五、调研方法复盘（供后续参考）

- 9 个项目：4 份主控直读（子代理反复失败后接手）、5 份子代理完成；直读与子代理产出质量相当，但直读可控性显著更高（子代理中断率约 40%）；
- 子代理指令的关键要素：仓库结构前置告知、研究重点逐条列明、"不必重复劳动"声明（如协议清单）、统一 7 节报告结构、200 字收尾摘要；
- 报告验收标准：H2 节数（7 节齐全）+ 代码级结论必须有文件路径证据。
