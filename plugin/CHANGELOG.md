# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Claude Code / Qwen Code 持续会话驱动**：`lib/drivers/claude-stream-json.js` 实现完整 NDJSON stream-json 驱动，`-p --input-format stream-json --output-format stream-json`；`lib/drivers/qwen-stream-json.js` 实现 Qwen 单行 JSON 输出驱动（`--output-format stream-json`，Qwen 无 `--input-format`，prompt 通过 `--prompt <text>` 命令行传入）。两者均支持 `--session-id <uuid>` 首次注册、`--resume <session-id>` 续接；Claude 支持 `--permission-mode` 沙箱层级、`--effort` 推理强度。Qwen 不支持 interrupt（`capabilities.interrupt: false`）。
- **Session 工具全 CLI 覆盖**：`lib/session-tools.js` 为 codex/claude 生成 4 个会话工具（followup/status/sessions/interrupt），为 qwen 生成 3 个（无 interrupt，无 sessions）。总计 11 个会话续接工具。
- **Claude / Qwen 会话模式工具**：`cli_claude_direct` 和 `cli_qwen_direct` 注册为 session-mode 工具，走 `ManagedCliAgentsService.dispatch` 持续会话路径，返回 `sessionId` 后可用 `cli_<cli>_followup` 续接。
- **能力分级（联网任务执行前拒绝）**：新增 `lib/capability-gate.js`，派发前依据 `registry.js` 的 `webTools` 标记判断任务是否需要联网；Codex / Qwen Code 自身不带 web 工具，遇到联网任务**在启动任何进程之前**即被拒绝，并提示改用 Claude Code 或 DSH 自带的 `advanced_search` / `web_fetch` / `platform_search`。该门禁同时接入 `cli_<cli>_direct`、`cli_<cli>_subagent` 与 `cli_dispatch` 三条路径，任一通道都无法绕过。`client.js` 因浏览器侧无法 import registry 而保留 `webTools` 副本，由 `client-source.test.mjs` 的一致性测试强制两者同步。
- **删除无后缀的一次性入口**：`cli_claude_code` / `cli_qwen` 及其 `managed-<cli>` one-shot provider（`lib/provider.js`，139 行）整体移除。它们只覆盖三个 CLI 中的两个、不带会话能力，且与覆盖全部三个 CLI 的 `cli_dispatch` 功能重复；其 `agentOptions` 能力缺失缺陷随载体一并消失。入口自此统一为带后缀的 `cli_<cli>_direct` / `cli_<cli>_subagent`，外加通用无头 `cli_dispatch` 与 Relay 内部 `managed_cli_submit`。**并发调度多个 CLI 请用 `cli_<cli>_subagent`**：返回子代理 id 后主控立即继续，多个 CLI 并行执行，无需加载后台任务（jobs）插件。
- **轮次超时可配置 + 超时先探测再判定**：设置新增 `turnTimeoutMinutes.<cli>`（每 CLI 独立，10/20/30 分钟三档，默认 20，此前固定 30 分钟）。行为同步改变：**到点不再直接判失败**——驱动先探测子进程（`lib/drivers/turn-timeout.js` 的 `probeStalledTurn`）：进程已退出则交由 close 通道交付真实结果/真实退出错误；仍在输出则宽限 60 秒继续等；确认静默卡死才报 `stalled`。Codex 走 app-server 协议，该值作为其 wire 请求超时（无子进程可探）。`subprocess-transport` 新增 `lastActivityAt` 观测点。**测试基建**：Claude/Qwen 驱动单测一律注入 250ms 短超时，杜绝单个挂起用例拖垮整套 `npm test`（此前一个竞态会让套件挂 30 分钟）；同时修复 Qwen followup 测试的注入竞态（先等子进程出现再 seed），并把该测试的过期断言更正为实机验证过的契约：`--prompt` 无值标志 + prompt 经 stdin 写入并关闭（`--resume` 续接同样如此，无 `--prompt` 时 Qwen 报 "No input provided via stdin"）。
- **自动补全去掉开关，"0 = 关闭"**：设置卡的"自动补全"复选框删除——自动补全成为固定行为，"最多续接次数"下拉移到左侧并新增 0 档；不想续接就选 0。存量配置完全兼容：旧 `enabled:false` 显示为 0；服务端 `max:0` 直接跳过续接（此前 0 会回退到默认 3，已修）；schema 放宽为 `min(0)`。
- **权限模型收敛为"勾选即允许"**：删除"审批模式"三选项中的"自动允许"——勾选框成为唯一授权方式（勾选=运行时静默放行）；下拉缩为 **询问 / 自动拒绝** 两项，且**只作用于未勾选的权限**被触发时：弹窗询问（默认）或自动拒绝。`resolvePermission` 决策链重写为"勾选→放行；未勾选+never→拒；未勾选+ask→弹窗"，消除旧模型的死组合（勾选+自动拒绝、不勾+自动允许永远走不到对应分支）。**默认档改为只读**（仅勾"读取"，写入/执行/联网未勾→运行时询问），`DEFAULT_PERMISSION` 同步改为 `read-only`；三个预设的 approval 统一为 `ask`。存量迁移：旧 `approval:"allow"` 的意图转写为勾选状态（缺失的布尔项按旧 allow 档补全为 true），不会静默收紧；旧 `never` 仍生效（作用于未勾选项）。沙箱档位推导规则不变（network→danger、write/exec→workspace、否则 read-only），Relay 子代理"不得自批"的内部钉死不受影响。
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

### Fixed

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
