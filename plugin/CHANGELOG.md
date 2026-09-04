# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **standalone e2e 脚本整体删除（2026-09-04，端到端测试方式定案）**：`plugin/e2e-live.mjs`（连同 `package.json` 的 `test:live` 入口）与根目录 `verify-matrix/`（battle-e2e.mjs / run-e2e.mjs / set-permission.mjs）全部移除。原因：直启 CLI 进程的 standalone 脚本在真实会话里会让进程卡死（实测观察），且绕过 harness 工具层——权限门控、审计留痕、会话管理均不在其覆盖内。端到端验证唯一入口改为 `plugin/VERIFICATION-FLOW.md` 三阶段流程，由主控在 DSH 会话里用插件注册的工具真实驱动（`cli_<cli>_subagent` 写入/删除、`cli_<cli>_direct` 读取核对，主控磁盘逐字节校验）。单测不受影响（`node --test test/*.test.mjs` 从未包含 e2e-live），npm pack 产物原本就不含这些文件，发布面零变化。

### Changed

- **权限档位收敛为两档：只读 / 可执行（2026-09 简化，breaking）**：中间的「工作区可写」档移除——第十二轮三档复测证明它是语义最含糊的档（Codex 在该档实际写不了文件（写路径是 exec_command，写依赖执行）；Claude 的 acceptEdits 边界比"仅写文件"宽（发现 6：删除命令被静默自动接受执行））。两档新语义：**只读 = 只能看**；**可执行 = 能跑命令、写/删文件、装依赖**（CLI 沙箱：Codex `-s danger-full-access`、Claude `bypassPermissions`）。实现：`PERMISSION_PRESETS` 收敛为两项；`deriveSandboxMode` 简化为"任一变更能力 → 可执行档"；Claude argv 映射删 acceptEdits（plan/bypassPermissions 两态）；设置卡下拉两档。**存量兼容**：`workspace-write`/`danger-full-access` 字符串与任何含 write/exec/network 的 profile 归一化到可执行档（放宽不收紧）；纯 read profile 与未知字符串保持只读。README 档位语义同步重写。

### Removed

- **Qwen Code 支持整体移除（2026-09 产品决策，breaking）**：托管 CLI 收敛为 Codex 与 Claude Code 两家。依据：① 实测可靠性不足——stream-json 无头模式不发 tool_use 事件（驱动层拦截是死代码），权限模型整体依赖 settings.json 单一 `tools.approvalMode` 键且被 CLI 启动时自行迁移重写（语义门反复判 stale），真机运行多次瞬态失败（`subprocess exited 1` 无诊断、`Error: tool call aborted` 等，复跑时好时坏）；② 其联网搜索需独立付费 DashScope 搜索模型（已在联网调研中确认放弃）；③ 维护面与其价值不成比例。移除范围：`registry.js` qwen 条目、`drivers/qwen-stream-json.js` 及其测试、`QWEN_APPROVAL_METHODS`、`qwenSettings/qwenSettingsCurrent/qwenApprovalMode`、`probeOpenaiChatContinuation` 与 `findChatToolCallId`（openai-chat 协议探测）、`cli_qwen_direct`/`cli_qwen_subagent`/`cli_qwen_followup` 等全部工具、relay provider `managed-qwen-relay`、设置卡 Qwen 项、e2e-live 的 Qwen 段；测试从 254 收敛至 **228/228 全绿**。存量用户影响：settings 里的 `models.qwen`/`permissions.qwen` 键静默闲置（无副作用），统一目录的 `config-qwen/` 残留可手动删除。

### Added

- **cli_test 失败分类六态化（2026-09）**：探测失败不再是"二选一"，而是 `completed / http-rejected / transient / incomplete / timeout / network-error` 六态（`classifyProbeFailure`）——**transient（429/5xx/超时/网络不通）绝不引导"更换供应商"**，改为"稍后重试、路由本身没问题"；只有确定性拒绝（认证/协议不支持）才建议更换（`probeOutcomeAdvice`）。`testCli` 的两个失败出口（CLI 运行失败、协议探测失败）按分类分流文案并携带 `outcome` 字段；`probeProtocolContinuation` 统一归一化 `toolContinuation` 为严格布尔并附 `outcome`。+5 测试（HTTP 状态映射/文本分类/文案分流铁律：瞬态不得建议换供应商），**254/254 全绿**。

### Fixed

- **relay 子代理转包越权封堵（第十五轮发现 8，高危，2026-09-04）**：`toolFilter: {allow:[managed_cli_submit]}` 只是模型可见 schema 的掩蔽——preset 贡献的原生 `subagent` 工具仍对 relay 子代理可见，实测（只读档写入验证）Codex relay 把写入任务转包给孙代理，孙代理继承主控 `danger-full-access` 沙箱直接写盘（文件比 CLI spawn 早 21 秒），CLI 沦为橡皮图章、权限档被整体旁路（Claude relay 同场景未转包、被正确拒绝——模型行为差异而非防护差异）。修复：`relay-subagent.js` 的 `registerContinuableSetup` guard 升级为**执行层硬 allowlist**——`managed_cli_submit` 与 `report` 之外的一切工具调用（含 `subagent`/`write`/`bash`/`run_code`/无名 exec）一律拒绝并给出可行动指引；guard 在每次工具执行时运行且不可被其他 guard 强制放行，转包链在第一跳即被切断。persona 同步明示「re-delegation 在执行层被拒绝」。+3 单测（allowlist 全量拒绝 / 白名单放行 / 无名 exec fail-closed），**229/229 全绿**。生效需重启 DSH Desktop（host 侧 lib 改动）。另注：`verify-matrix/run-e2e.mjs` 的既有条目见上方 Removed——该 runner 已随 standalone e2e 一并退役。

- **测试摩擦修复（2026-09 三档矩阵轮次暴露）**：① `ensureCliProviderConfig` 的写失败现在识别**会话沙箱拒绝**（统一目录在调用方会话工作区外时）并给出可行动指引（"请在设置卡重新验证，host 层写入不受会话沙箱限制"），替代裸的 `cannot write ... under workspace-write mode`；② `cli_<cli>_direct` 工具描述补充两条实测语义——供应商瞬态失败"稍后重试即可、无需换供应商"、以及 Codex 写文件需「可调用工具」档（其写路径是 exec_command）+ 文件读写限当前工作区；③ plugin README 配置表补记三档矩阵实测语义（Codex 写依赖 exec、Claude/Qwen 可写档精确、删除依赖命令、cwd 边界）；④ 新增 `verify-matrix/run-e2e.mjs` 干净 e2e runner（分离 stderr，规避 PowerShell NativeCommandError 把 CLI stderr 噪音误报成 exit 1 的假阳性；该 runner 后已随 standalone e2e 整体退役删除，见上方 Removed 条目）。

### Removed

- **三 CLI 明确不提供联网搜索功能（2026-09 产品决策，问题二关闭）**：联网任务一律由主控自带的搜索工具（`advanced_search` / `web_fetch` / `platform_search`）完成，CLI 只处理离线任务。依据（完整调研见根目录 `CLI-WEB-SEARCH-RESEARCH.md`）：① Codex 的 web_search 是 Responses server-side 工具，执行权在中转商——多数 chat 型中转不执行，且 `-c tools.web_search=true` 是 deprecated 别名（新语义默认 `cached` 只查索引缓存不真联网）；② Claude 的 WebSearch 同为 server-side 工具，中转转换实测损坏；③ Qwen 的 webSearch 需独立付费的 DashScope 搜索模型 + API key，用对话模型顶替的启用配置形同虚设。具体变更：`registry.js` 删除 codex exec 档的 `-c tools.web_search=true`；`verify.js` 的 `qwenSettings()` 不再渲染 webSearch 块、`qwenSettingsCurrent()` 把盘上残留块判为 stale 触发重写清除；permissions 的工具映射表**保留** WebSearch/WebFetcher → exec 分类（权限分类非功能授予——万一 CLI 侧触发仍由 exec 开关裁决，删映射会让未知工具静默放行）；README 中英文的分工原则更新为"主控联网调研，CLI 离线执行"。未来若要提供 CLI 联网检索能力，路线是纳入搜索开箱即用的 CLI（如 Gemini CLI，调研文档第三节），而非修补这三家。**249/249 全绿**。

### Changed

- **轮次超时档位与默认值调整：10/20/30（默认 20）→ 3/5/10 分钟（默认 5）**：卡死检测语义已从"任务时长上限"变为"静默检测点"（见上一条 probe 循环改造）——值越小的含义是"越早开始怀疑卡死"，而健康任务不受总时长约束（每个活跃窗口都续期）。旧档位对"静默检测"过于迟钝（真卡死要 10-30 分钟才发现），新档位让卡死 3 分钟即可被发现，同时 3 分钟下限仍覆盖正常的慢启动/长思考（首输出延迟通常 <2 分钟）。设置卡下拉与 hint 文案同步更新；**存量兼容**：已存 10/20/30 的设置仍然合法生效（只是不在下拉里），未设置的 CLI 落到新默认 5。

### Added

- **CLI 卡死检测补齐到 Codex + 持续输出任务不再被误杀（2026-09）**：① **Codex app-server driver 此前到点直接 interrupt**（无探测），健康的慢任务会在 20 分钟被硬中断——现在与 Claude/Qwen 同一策略：超时先 probe，session 记录 `lastNotificationAt`（每条 inbound 通知刷新），持续有事件 → 延长；静默超过宽限窗（60s）才判死 interrupt；**awaiting_permission 状态（权限请求挂起）不判死**——等待用户决定不是 CLI 的错；② 三个 driver 的"延长一次"改为 **probe 循环**（`watchTurnDeadline`）：持续输出的任务每个窗口都续期，只有完整静默一个窗口才判"卡死"——旧逻辑第二个 deadline 无条件失败，超过两倍超时的健康长任务仍会被杀。新增 `watchTurnDeadline` 共享助手（`drivers/turn-timeout.js`）+ 8 个测试（循环续期/静默判死/cancel 清理/abort 短路/probe 错误/Codex 无事件判死/Codex 持续事件不中断），**249/249 全绿**。

### Removed

- **审批模式整体移除（2026-09，产品决策）**：权限模型收敛为「勾选即授权，档位启动时定死」——无弹窗、无 A/B 门、无运行中提权。依据：① A/B 门的核心是正则猜自然语言（prompt 能力预测 + 失败文本缺口提取），误判必然存在且 B 门重开一轮意味着工作重做；② round 9 实证单向 wire 的事后拦截撤不回已执行副作用，档位前置执法才是可靠边界；③ 生态印证——dsh-plugin-cc 明确 "No mid-run approvals"、dsh-codex-workflow 用 `approval_policy=never` 回避、dsh-plugin-codex 对 server-request 一律安全拒绝，唯一走通交互审批的 dsh-claude-code 走的是 Agent SDK 的 canUseTool 而非 CLI 直连。具体变更：删除 `permissions.js` 的 `APPROVAL_MODES` / `approval` 字段 / `requiredCapabilities()` / `missingCapabilities()` / `profileWith()` / `isPermissionBlocked()` / `permissionReason()`；删除 `managed-cli-agents.js` 的 `gateMissing()` / `blockedCapabilitiesOf()` / `approvalRequest` seam / `pendingPermission` / `awaiting_permission` 会话状态——`resolvePermission()` 改为纯确定性应答（勾选 → allowed-once，未勾选 → rejected，均留痕 `lastPermissionDecision`）；删除 `capability-gate.js`（no-op 门）及其全部调用点；`inject` 移除 `approval`；设置卡 profile 不再携带 approval 键（存量 ask/never 读取时静默丢弃，legacy allow 仍迁移为全勾选）；Codex 的 requestApproval 仍走 `on-request` + 确定性应答（保留审计留痕），`approvalPolicy` 恒 `on-request`。`DESIGN-approval-copy.md` 删除；roadmap 第 9 节降级为历史设计（远期复活路径：Claude 侧 Agent SDK canUseTool）。测试重写后 **241/241 全绿**。

### Fixed

- **`managed_cli_submit` 工具描述改为明确「仅 CLI Relay 子代理可调用」（2026-09-03）**：原描述 "Relay-only: ... must call this once per turn ... must not answer the task yourself" 对所有代理可见，普通子代理读到「必须调用且不许自行作答」可能误调甚至卡死。新描述写死调用方范围（由 `cli_<cli>_subagent` 创建、绑定 `managed-<cli>-relay` 的子代理）、点名其他代理（主控 / 普通 subagent / AgentTeams 成员）一律不可调用、并说明未绑定调用按自身会话 id 查找必然报错。工具名本身带 `managed_cli` 前缀与 DSH 原生 `send_message` / `subagent` 不冲突，此改动消除的是描述歧义。

### Added

- **CLI 联网开关补全（2026-09-03）**：去掉「联网调研不派 CLI」纪律后，联网查证发现 DSH 从未给 CLI 配联网入口——按各官方机制补齐：① **Codex** 在 exec 档（danger-full-access）的 headless argv 追加 `-c tools.web_search=true`。**注意不能用 `--search`**：该 flag 仅 TUI 生效，`codex exec` 会拒绝（openai/codex#2760："CLI flag is --search (TUI only); TOML key works for both TUI and codex-exec"）；`-c` 覆盖对 exec 有效，等价于 config.toml 的 `[tools].web_search`；② **Qwen** 的 `qwenSettings()` 在 exec 档写入 `tools.webSearch = { enabled: true, model }`（官方文档确认的 opt-in 键，默认不注册）；③ **Claude** 自带 WebSearch，无需开关——能否真连取决于中转商是否执行服务端工具，以实测为准，不预判。`qwenSettingsCurrent()` 同步比对 webSearch 开关，避免盘上过时配置被误判为最新。新增测试覆盖三处（262/262 全绿）。

- **A / B 权限门（档位前置执法，2026-09-03 设计返工）**：第九轮实测证伪「yolo 启动 + 驱动层拦截」——Qwen 的 stream-json 不发 tool_use 事件（拦截是死代码）、Claude 单向协议下拒绝撤不回已执行副作用。取代方案：**能力边界在进程启动前一次性划定**——① spawn 前按设置档位写入 CLI 自身执法（codex `-s` / claude `--permission-mode` / qwen `tools.approvalMode`，配置每次运行前重写）；② **A 门（事前）**：从任务提示判断是否需要未勾选的 write/exec，默认策略=自动拒绝 → 不申请、直接报「无法完成」、进程不启动（无弹窗；ask 分支仍保留给显式传 ask 的存储档，但 UI 不再产生）；③ **B 门（事后）**：运行中因权限受阻失败时，从失败现场提取受阻能力（拦截记录 ∪ 拒绝文本 ∪ 提示词兜底），同一规则申请后重开一轮（仅一次、不循环），算不出缺口就不盲目重跑；④ Codex 双向协议的真拦截保留为加严。新增纯函数 `requiredCapabilities(prompt)` / `missingCapabilities()` / `profileWith()` / `isPermissionBlocked()`；服务层 `gateMissing()` / `blockedCapabilitiesOf()`；**本轮授权档经 driver.start options 的 `permissionProfile` 穿透到 prepare → 配置渲染**（qwen 的执法点是其 settings.json 的 approvalMode，授权档必须随 spawn 原子写入，否则语义门会按持久化档把它改写回去）；followup 在档位变化时自动重启驱动进程（档位不能热改，同时封住授权档跨轮泄漏）。新增 `test/permission-gate.test.mjs` 9 条（A 三态 / B 三态 / 缺口提取 / 防循环），**259/259 全绿**。
- **Qwen 按档位执法（撤销固定 yolo）**：`qwenApprovalMode(tier)` 恢复映射——read-only → **plan（写工具根本不注册，物理写不了）**、workspace-write → auto-edit、danger-full-access → yolo；`qwenSettingsCurrent()` 语义门同步按当前档位比对（盘上过时档位会在下次运行前被重写）。默认（未配置权限）按最保守的 plan 处理。
- **权限收敛为三能力（read / write / exec）**：删除「联网」开关——exec 已承载联网意图（npm install / git pull 属普通命令执行），存量 `network:true` 由 normalizer 映射到 exec。设置卡权限区改为单一三档下拉（只读 ⊆ 可写 ⊆ 可调用工具，三档 read 恒 true——读取默认放行、无运行时弹窗）。`capabilityKey` 映射 `command→exec`、`file-change→write`、`permissions(escalation)→exec`。
- **审批策略固定为「自动拒绝」，UI 移除弹窗开关（2026-09-03 终版原则：启动前定死、干不了就停就报、无弹框）**：`PERMISSION_PRESETS` / `DEFAULT_PROFILE` 的 `approval` 由 `ask` 改为 `never`；设置卡删除「询问 / 自动拒绝」下拉框（`APPROVAL_OPTIONS` 与 `dsc-perm-approval` 样式/文案一并移除），档位切换时 `approval` 固定写 `"never"`。代码侧 `gateMissing()` 的 `approval === "never"` 分支直接抛 `CLI_PERMISSION_BLOCKED`、进程不启动、回报「无法完成」——**不弹窗、不改设置、不绕行**。会话级 `dsh-user-approval` 的 ask/never 不再参与（插件默认 never，弹窗通道无关紧要）。`VERIFICATION-FLOW.md` 授权纪律改为终版五条。
- **driver 层统一权限拦截（三 CLI 体验一致）**【2026-09-03 部分废止：第九轮实测证伪「一律最高档启动 + 驱动拦截」——Qwen 不发 tool_use（拦截死代码）、Claude 单向撤不回副作用；三 CLI 均改按档位启动、拦截仅 Codex 双向协议保留，见顶部 A / B 权限门条目。normalizer 与工具名→capability 映射仍然有效】：三个 CLI 一律最高档启动（Claude `--permission-mode bypassPermissions`、Qwen `tools.approvalMode: yolo`、Codex app-server），由 driver 解析 stream-json `tool_use` / app-server protocol 事件，按 profile 检查 capability，统一走 `onPermissionRequest → resolvePermission() → ctx.approval.request()` GUI 弹窗。勾选=静默放行；未勾选=弹窗（ask）或自动拒绝（never）。`permissions.js` 新增 `CLAUDE_APPROVAL_METHODS` / `QWEN_APPROVAL_METHODS` 与 `normalizePermissionRequest(cli, method, params, context)` 统一 normalizer（Bash/NpmcliLifecyclePlugin→command、Write/MultiWrite/Edit/Delete→file-change、WebSearch/WebFetcher→exec、只读工具→null 静默放行）。Claude/Qwen 的 stream-json 单向无 ack，拒绝以 `finish(false)` 终止 turn；异步权限决策经 `Promise.resolve().then()` 挂起。
- **修复 relay 子代理续用（reattach）必现失败**：`send_message` 续用已空闲的 relay 子代理走 `followup → reattach → driver.start({attachOnly:true})`（不带 prompt），而 Claude/Qwen stream-json driver 的 `start()` 无条件校验 prompt，必现 `request.prompt must not be empty`。修复：两 driver 增加 attachOnly 分支（对齐 codex-app-server：不校验 prompt、不 spawn、只备上下文、返回已 settle 的 attached run）；attach 模式校验 `resumeThreadId` 并以其为 `ctx.actualSessionId`，后续 followup `--resume` 用对线程。每 driver 补 3 个单测（无 prompt 不抛错且不 spawn、缺 resumeThreadId 拒绝、attach 后 followup 正确 resume）。
- **端到端验证（六轮）**：三阶段（写入→读取核对→删除）× 三 CLI × 双通道（direct / relay）实测。最新一轮在 host 重启加载全部修复后干净跑完：写入逐字节精确、3×3 互读一字不差、删除磁盘确认无残留；reattach 修复经三 CLI relay 子代理第二轮 `send_message` 实测正常续接。流程纪律固化：阶段推进必须等全部子代理 completion（防迟到写入污染下一阶段）；CLI 自报不可信，以磁盘字节校验为准。单测 **234/234**。
- **Claude Code / Qwen Code 持续会话驱动**：`lib/drivers/claude-stream-json.js` 实现完整 NDJSON stream-json 驱动，`-p --input-format stream-json --output-format stream-json`；`lib/drivers/qwen-stream-json.js` 实现 Qwen 单行 JSON 输出驱动（`--output-format stream-json`，Qwen 无 `--input-format`，prompt 通过 `--prompt <text>` 命令行传入）。两者均支持 `--session-id <uuid>` 首次注册、`--resume <session-id>` 续接；Claude 支持 `--permission-mode` 沙箱层级、`--effort` 推理强度。Qwen 不支持 interrupt（`capabilities.interrupt: false`）。
- **Session 工具全 CLI 覆盖**：`lib/session-tools.js` 为 codex/claude 生成 4 个会话工具（followup/status/sessions/interrupt），为 qwen 生成 3 个（无 interrupt，无 sessions）。总计 11 个会话续接工具。
- **Claude / Qwen 会话模式工具**：`cli_claude_direct` 和 `cli_qwen_direct` 注册为 session-mode 工具，走 `ManagedCliAgentsService.dispatch` 持续会话路径，返回 `sessionId` 后可用 `cli_<cli>_followup` 续接。
- **分工定型：主控调研，CLI 执行（2026-09-03 废止）**：`lib/capability-gate.js` 曾对**三个 CLI 对称**拒绝联网调研任务（含 Claude Code），话术为"联网调研由主控直接执行"。理由：Claude 的 WebSearch 是 Anthropic 的 server-side 工具，chat 型中转实测不执行（13 次调用 0 真实结果）。该纪律已于 2026-09-03 移除——用户决定让每个 CLI 直接尝试联网调研（各自内置工具不同，实测见真章），`checkCapability()` 不再因联网意图拒绝，任务流转到权限 A 门（exec 未勾选则报无法完成）。`needsNetwork()` 保留供 B 门缺口提取。设置卡的「联网」开关此前已改为纯进程沙箱旋钮（exec 承载联网意图）。
- **删除无后缀的一次性入口**：`cli_claude_code` / `cli_qwen` 及其 `managed-<cli>` one-shot provider（`lib/provider.js`，125 行）整体移除。它们只覆盖三个 CLI 中的两个、不带会话能力，且与覆盖全部三个 CLI 的 `cli_dispatch` 功能重复；其 `agentOptions` 能力缺失缺陷随载体一并消失。入口自此统一为带后缀的 `cli_<cli>_direct` / `cli_<cli>_subagent`，外加通用无头 `cli_dispatch` 与 Relay 内部 `managed_cli_submit`。**并发调度多个 CLI 请用 `cli_<cli>_subagent`**：返回子代理 id 后主控立即继续，多个 CLI 并行执行，无需加载后台任务（jobs）插件。
- **轮次超时可配置 + 超时先探测再判定**：设置新增 `turnTimeoutMinutes.<cli>`（每 CLI 独立，10/20/30 分钟三档，默认 20，此前固定 30 分钟）。行为同步改变：**到点不再直接判失败**——驱动先探测子进程（`lib/drivers/turn-timeout.js` 的 `probeStalledTurn`）：进程已退出则交由 close 通道交付真实结果/真实退出错误；仍在输出则宽限 60 秒继续等；确认静默卡死才报 `stalled`。Codex 走 app-server 协议，该值作为其 wire 请求超时（无子进程可探）。`subprocess-transport` 新增 `lastActivityAt` 观测点。**测试基建**：Claude/Qwen 驱动单测一律注入 250ms 短超时，杜绝单个挂起用例拖垮整套 `npm test`（此前一个竞态会让套件挂 30 分钟）；同时修复 Qwen followup 测试的注入竞态（先等子进程出现再 seed），并把该测试的过期断言更正为实机验证过的契约：`--prompt` 无值标志 + prompt 经 stdin 写入并关闭（`--resume` 续接同样如此，无 `--prompt` 时 Qwen 报 "No input provided via stdin"）。
- **自动补全去掉开关，"0 = 关闭"**：设置卡的"自动补全"复选框删除——自动补全成为固定行为，"最多续接次数"下拉移到左侧并新增 0 档；不想续接就选 0。存量配置完全兼容：旧 `enabled:false` 显示为 0；服务端 `max:0` 直接跳过续接（此前 0 会回退到默认 3，已修）；schema 放宽为 `min(0)`。
- **权限模型收敛为"勾选即允许"**：删除"审批模式"三选项中的"自动允许"——勾选框成为唯一授权方式（勾选=运行时静默放行）；下拉缩为 **询问 / 自动拒绝** 两项，且**只作用于未勾选的权限**被触发时：弹窗询问（默认）或自动拒绝。`resolvePermission` 决策链重写为"勾选→放行；未勾选+never→拒；未勾选+ask→弹窗"，消除旧模型的死组合（勾选+自动拒绝、不勾+自动允许永远走不到对应分支）。**默认档改为只读**（仅勾"读取"，写入/执行/联网未勾→运行时询问），`DEFAULT_PERMISSION` 同步改为 `read-only`；三个预设的 approval 统一为 `ask`。存量迁移：旧 `approval:"allow"` 的意图转写为勾选状态（缺失的布尔项按旧 allow 档补全为 true），勾选维度不收紧，但运行时行为更严：旧 allow 是全静默放行，迁移后未勾选项触发时按策略询问——这是有意的设计收紧而非回归；旧 `never` 仍生效（作用于未勾选项）。沙箱档位推导规则不变（network→danger、write/exec→workspace、否则 read-only），Relay 子代理"不得自批"的内部钉死不受影响。
- **Claude / Qwen e2e 双模式验证**：`e2e-live.mjs` 新增 Claude Code 和 Qwen Code 各一条双模式会话段——用真实 `ClaudeStreamJsonDriver`/`QwenStreamJsonDriver` + `ManagedCliAgentsService` + 真实 CLI 与当前路由，跑 `dispatch`（创建会话）→ `followup`（续接同一 sessionId），验证两轮同一会话且输出完整。`npm run test:live` 一键复跑。
- **Claude / Qwen Relay 子代理桥**：`cli_claude_subagent` 和 `cli_qwen_subagent` 注册为 DSH Relay 工具，与 `cli_codex_subagent` 形态一致。`managed-claude-relay` / `managed-qwen-relay` provider 通过参数化的 `ManagedCliRelayProvider(cli)` 实现（保留 `ManagedCodexRelayProvider` 向后兼容）。`managed_cli_submit` 通过 `exec.agent.provider` 识别当前 CLI（`managed-codex-relay` → codex，`managed-claude-relay` → claude），自动分发到对应 `ManagedCliAgentsService` 的 `submitFromChild`。Relay lifecycle 三个 CLI 共用：Relay 子代理启动时 `bindChild` 注册会话；`managed_cli_submit` 作为 guard-protected 工具强制子代理必须先提交任务才能 `report`；`releaseChild` 在子代理结束时清理。

参数化 `relayPersonaFor(cli)` 根据 CLI 类型注入不同 system prompt：codex 用 Codex 工具列表 + 明确禁止本地测试命令；claude 用 Claude tool spec + 工作目录规范；qwen 用 Qwen tool spec + 工作目录规范。统一 persona 促进子代理忠实转发任务。
- **会话持久化（全 CLI 通用）**：`ManagedCliAgentsService` 注入可选的持久化 seam（`persist.load/save`，缺省保持内存态），`dispatch/followup/release/close` 状态变更后自动保存纯数据记录（含远程 thread id，序列化不含 run/权限等活体状态），`restore()` 在插件启动时恢复非终态会话。Host 侧用 DSH fs 服务把会话写进统一目录的 `sessions.json`。`restore()` 同时按 `cli` 字段过滤——删除某个 CLI 的 driver 后，其历史会话记录会被自动跳过，不会复活到错误 CLI。Host 重启后 `cli_<cli>_followup` 按 `sessionId` 直接 reattach 同一 thread。
- **auto-continue 配置化**：设置项 `autoContinue.<cli>.enabled/max`（SCHEMA + 设置卡每 CLI 开关与续接次数，默认 `true`/`3`），服务经 `autoContinueSource` 读取；`enabled:false` 时原样返回不续接，`max` 覆盖默认上限。**泛化评估**：续接依赖同一 thread 的 followup，`INTENT_TAIL` 正则跨语言（中文句号+英文句点），对 Codex 会话式调用生效；Claude/Qwen 驱动接入后同样适用同一评估逻辑。
- **双模式端到端自动化**：`e2e-live.mjs` 新增 Codex 双模式会话段——用真实 `CodexAppServerDriver` + `ManagedCliAgentsService` + 真实 codex app-server 与当前路由跑 `dispatch`（直连）与 `bindChild/submitFromChild`（代理提交路径），断言两轮同一 session 且输出完整，`npm run test:live` 一键复跑。
- **e2e 纯断言**：`e2e-live.mjs` 顶部新增纯逻辑断言——`CLI_SUBAGENT_TOOLS` 不含 `cli_codex` 别名、`isOkReply` 容忍 `OK\nOK` 回声并拒绝非 OK 行。CI 的 `pnpm test`（`node --test test/*.test.mjs`）已覆盖新增单测（isOkReply、别名移除、持久化、autoContinue），无需改动 workflow。
- **能力矩阵文档**：README.md 新增"各 CLI 内置工具能力"一节，含 Markdown 表格，说明三个 CLI 各有哪些内置工具（Codex/Qwen 无 web 工具，Claude Code 自带 WebSearch + WebFetch），并指引用户何时用 CLI 搜网、何时用 DSH 自带的 `advanced_search`。Qwen/Codex 内部工具列表为纯文档说明，不修改 driver 代码。
- 单元测试新增：Claude/Qwen driver 13 个（argv 组合、沙箱映射、session-id 提取、followup --resume、error 转换、多段文本拼接）；session-tools 3 个（全部 12 工具注册、followup/status/sessions/interrupt 调用路由）；subagent-tools 3 个（Claude/Qwen session-mode dispatch、session-mode 拒绝后台模式）。

### Changed

- **Codex 命令面明确化**：移除 `cli_codex` 兼容别名，只保留两条入口——`cli_codex_direct`（直连：主控直接调用外部 CLI，不建 Relay 子代理）与 `cli_codex_subagent`（代理：DSH Relay 子代理转发给真实 Codex thread）。同步更新设置卡 guide（直连/代理两行）、`cli_codex_followup/status/sessions/interrupt` 描述、`cli_dispatch` 提示与 README（中/英）。
- **权限指引重写（授权纪律）**：权限不足时的提示不再指引任何绕行方式（此前版本曾指引调到「完全」档、后又指引「本会话临时允许」），改为唯一出口——如实报告用户，由用户在设置卡决定是否调档；并明令「严禁修改 ~/.dsh/settings.yaml 或凭据文件——审核依据文件对 AI 只读」。`AUTHORIZATION_DISCIPLINE` 常量注入所有模型可见的工具描述（direct / subagent / dispatch），`permissionReason()` 对门申请明示拒绝后果。
- **权限决策留痕**：`resolvePermission()` 的三类决策路径（勾选静默放行 / never 自动拒绝 / 弹窗结果）全部记入环形日志（上限 50，`recentPermissionDecisions(20)` 供读取），拒绝时同步记录受阻能力键，供 B 门提取与用户核对。

### Removed

- **会话临时授权开关（2026-09-03 否决并全量移除）**：「本会话临时允许 写入文件 / 执行命令」复选框把「怎么绕过审核」的选择推给用户、给绕行开合法通道，方向错误。设置卡 UI、locale 文案、`sessionGrants` / `setSessionGrant` remote 方法、host 内存状态、`applySessionGrant()` 合成函数及 5 条测试全部删除，无残留引用。临时授权的唯一形态回归一次性弹窗（A / B 门）。

### Verified（真实环境，2026-09-03）

- 第九轮实测（`permissions: {}` + 审批策略 never）：Codex 真拦截（文件未创建、回报无法完成）；Claude 拒绝但文件已落盘（单向协议事后止损，如实记录）；Qwen 未勾选仍写入成功（拦截死代码 + 固定 yolo）——三 CLI 分歧行为构成设计返工的实证，全部记入 `VERIFICATION-FLOW.md`（含第四轮 Qwen 数据点勘误）。第十轮验证矩阵（A 门放行 / 弹窗拒绝 / never 直报 / 删除双缺口弹窗 / Qwen plan 档硬保证探针）待 host 重启加载本变更后执行。

### Removed

- **「联网调研不派给 CLI」纪律（2026-09-03 废止）**：`capability-gate.js` 的 `checkCapability()` 不再因任务含联网意图而拒绝；`cli_<cli>_direct` / `_subagent` / `cli_dispatch` 三条路径的联网任务现流转到权限 A 门（exec 未勾选 → 报无法完成、不启动）。理由：用户要实测各 CLI 真实联网能力，而非被一条预设纪律提前挡掉。原纪律源于早期「chat 中转商不执行 WebSearch」的实测，现交回运行时验证。

### Fixed

- **Claude 驱动档位映射被第三轮方案焊死（第九轮「已拒绝但文件落盘」的根源）**：`claudePermissionMode(_tier)` 恒返回 `bypassPermissions`，CLI 始终以最高档启动，唯一的门只剩单向协议上「事后止损」的驱动拦截——拒绝发出时 Write 已执行。修复：恢复按档位映射（read-only → `plan`、workspace-write → `acceptEdits`、danger → `bypassPermissions`，未知值按最保守的 plan），驱动层拦截降级为尽力而为的加严；「恒 bypassPermissions」断言更正为按档位断言（含缺省档 → plan）。
- **Qwen 的 A/B 门授权被配置语义门静默回滚**：授权后若先落盘加宽档（auto-edit），随后 `driver.start → prepare → ensureCliProviderConfig` 按**持久化档**（read-only → plan）比对 → 判为过时 → 改写回 plan——用户批准的写入物理上不可能发生且无提示。修复：本轮档位经 driver.start options 的 `permissionProfile` 穿透（codex/claude/qwen 三驱动统一转发给 prepare）到 `prepareManagedRun → ensureCliProviderConfig`，语义门按本轮档渲染与比对；删掉先落盘的 `writeQwenTier` 路径（由 prepare 原子完成）。补测：授权档与盘上一致不重写 / 未授权轮按持久化档重写回 plan（授权不跨轮泄漏）/ prepare 收到 permissionProfile 透传。
- **Qwen 配置写与默认沙箱部署的三连缺陷（Windows 冷装实测发现）**：
  1. `ensureCliProviderConfig` 对 qwen **无条件重写** `settings.json`——宿主 fs 沙箱默认 `workspace-write`（`DSH_PERMISSION_MODE` 未设）时统一目录的写被拒（`FS_SANDBOX_DENIED`），qwen 的 `cli_test` / direct / subagent 全通道在默认部署下必挂。修复：增加「内容一致」短路（对齐 codex 的指纹门模式）。
  2. 字节级内容门对 qwen **天然失效**：qwen 0.22.3 每次启动都会迁移自身 settings.json（顶层 `selectedAuthType` → `security.auth.selectedType` + 盖 `$version`），首跑后字节比对必破、之后每次 dispatch 都撞沙箱写拒绝。修复：改为**语义门** `qwenSettingsCurrent()`——只比对插件拥有的字段（openai 路由条目 model/envKey/baseUrl、`tools.approvalMode`【2026-09-03 起按当前档位比对，不再固定 yolo】、auth 类型兼容新旧两种位形），qwen 自己的字段一概不碰。
  3. qwen argv 模板在 read-only 档追加 `--sandbox`：该旗标 shell 出去依赖 docker/podman，无 docker 的机器（典型为 Windows）上 qwen **静默死亡**（退出码 0、空回复），`cli_test` 表现为"未返回预期的 OK（实际：空）"且无从定位。修复：模板移除 `--sandbox` 分支【2026-09-03 补注：档位执法现由 settings.json 的 approvalMode 承担，见 Qwen 按档位执法条目】；单测与 e2e 断言同步更新。
  单测 246/246（+5：内容一致不写 / qwen 迁移后格式不写 / 迁移格式下陈旧路由拒绝 / 内容不同重写 / 文件缺失重建）。
- **探测 OK 回声误拦**：部分供应商/模型（如 zzztoken 上的 deepseek-v4-pro）把 `Reply with exactly: OK` 回声成 `OK\nOK`，此前会被严格相等校验误判为"连通失败"，导致 `cli_codex` 被预检拦截、用户改配置后不易感知。新增纯函数 `isOkReply`（所有非空行均为 OK 即通过），且报错带 `provider / model` 名，路由一目了然。
- **长任务提前 end_turn 无完整结果**：部分模型在长多步工具任务中输出计划句后即提前结束 turn。服务层加入有界自动补全（同 thread nudge，最多 3 次），一次 `cli_codex_direct` 调用即可返回完整报告；驱动统计 `commandExecution` 轮次供判定，拿到完整块后清理进度噪音（长度 ≥100 字符才替换）。
- **e2e 会话段 PATH 缺失**：双模式段最初只传隔离 env，`codex` 二进制是 `#!/usr/bin/env node` shim，缺 `process.env.PATH` 导致 app-server 以 127 退出；改为 `{ ...process.env, ...隔离 env }` 后真实验证通过。
- **插件设置卡不显示（两层叠加故障）**：Settings → Plugins 完全看不到卡片，而 Host 侧 CLI 工具全部正常。
  - 第一层（注册失败）：未提交改动从 `inject` 删除了 `connection`，代码却仍访问 `ctx.connection`，触发动态 Client 守卫拒绝，异常被 `try/catch` 吞掉，`ctx.slots.inject(...)` 从未执行。
  - 第二层（渲染崩溃，主因）：`connection` 并不提供 `api`（实际键仅 `isLoopback`/`generation`/`rpc`/`registerGenerationSource`/`start`），`props.api.llm.models({})` 抛 `TypeError`；且 `SetupRow` 在卡片**折叠时也挂载**（`hidden` 不阻止挂载），异常掀掉整个 Plugins 标签页——表现为整块 UI 消失而非卡片空白。
  - 修复：`inject` 改为 `["slots", "locale", "settingsScope", "remote", "remote.session"]`；模型目录改用 `ctx.get("remote.session").modelCatalog()`（对齐官方 `dsh-client-ui-settings-plugins` 用法），并对 seat 缺失 / 方法缺失 / 请求失败全链路降级返回 `[]`；`SetupRow` 改用 `props.loadCatalog` 并加 `typeof` 守卫。
  - 经验：注册成功 ≠ 能显示，须分别验证；折叠容器仍执行副作用，崩溃会向上冒泡；优先 `ctx.get` 防御式读取，使 API 再次漂移时只降级不崩页。
- **移除失效的 `dsh.client.inject` 声明**：`plugin/package.json` 中 `@deepseek-ai/dsh-client-runtime`（该版本部署不存在、symlink 悬空）、`dsh-client-ui-slots`、`dsh-client-ui-primitives` 均解析不到。后两者是浏览器 seed 词（`react` 同样），`require` 直接命中无需声明；`inject` 中解析不到的包在 `arriveGraphRow` 静默跳过，无害但属冗余。同步清理对应的 `peerDependencies` / `peerDependenciesMeta`。

### Verified（真实环境，2026-08-31）

- 在真实 Host（codex-cli 0.149.1 / zzztoken-glm / deepseek-v4-pro / max / danger-full-access）下，`npm run test:live` 全绿：三 CLI 真实运行 + 纯断言（别名移除、OK 回声容忍）+ Codex 双模式会话（直连 `dispatch` 与代理 `submitFromChild` 两轮同一 session 均输出完整）。
- 此前手工验证：直连与代理各跑一次端到端（抓取 The Verge AI RSS 前 5 条），两种方式结果一致、内容完整；`cli_test` 实测 `reply: "OK\nOK\nOK\nOK"` 仍 `ok: true`（OK 回声容忍生效）。

## [0.1.0] - 2026-08-25

### Added

- Host package `dsh-sub-cli` with a `cli_dispatch` model tool that runs an
  installed external Agent CLI headless (argv array, config isolation env,
  bounded output, exit code).
- `installSettingsSection` persistence for the unified CLI dir and a per-CLI
  three-layer model route (`provider` → `model` → `reasoningEffort`).
- Client settings card (`settings.plugin.item`) that reads the live model
  catalog via `api.llm.models`, configures the unified dir with a browse action,
  and saves the per-CLI route to the `dsh-sub-cli` settings section.
- Pure-logic modules: `registry.js` (CLI table + argv templates), `paths.js`
  (unified dir + config isolation), `status.js` (install/version detection),
  `dispatch.js` (headless subprocess dispatch).
- Unit tests for registry, paths, status, and dispatch (14 tests).

### Notes / planned

- Check-install, unified-dir migration, and live per-CLI status UI are planned
  and require `@Remote` host methods (typert) to reach the Client; they are not
  part of this first release.
