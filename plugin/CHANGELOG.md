# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Claude Code / Qwen Code 持续会话驱动**：`lib/drivers/claude-stream-json.js` 实现完整 NDJSON stream-json 驱动，`-p --input-format stream-json --output-format stream-json`；`lib/drivers/qwen-stream-json.js` 实现 Qwen 单行 JSON 输出驱动（`--output-format stream-json`，Qwen 无 `--input-format`，prompt 通过 `--prompt <text>` 命令行传入）。两者均支持 `--session-id <uuid>` 首次注册、`--resume <session-id>` 续接；Claude 支持 `--permission-mode` 沙箱层级、`--effort` 推理强度。Qwen 不支持 interrupt（`capabilities.interrupt: false`）。
- **Session 工具全 CLI 覆盖**：`lib/session-tools.js` 为 codex/claude 生成 4 个会话工具（followup/status/sessions/interrupt），为 qwen 生成 3 个（无 interrupt，无 sessions）。总计 11 个会话续接工具。
- **Claude / Qwen 会话模式工具**：`cli_claude_direct` 和 `cli_qwen_direct` 注册为 session-mode 工具，走 `ManagedCliAgentsService.dispatch` 持续会话路径，返回 `sessionId` 后可用 `cli_<cli>_followup` 续接。`cli_claude_code` 和 `cli_qwen` 保持 one-shot 一次性路径（后台 job 支持），向后兼容现有测试。
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
