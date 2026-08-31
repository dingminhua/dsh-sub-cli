# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Codex 会话持久化**：`ManagedCliAgentsService` 注入可选的持久化 seam（`persist.load/save`，缺省保持内存态），`dispatch/followup/release/close` 状态变更后自动保存纯数据记录（含远程 thread id，序列化不含 run/权限等活体状态），`restore()` 在插件启动时恢复非终态会话。Host 侧用 DSH fs 服务把会话写进统一目录的 `sessions.json`，Host 重启后 `cli_codex_followup` 按 `sessionId` 直接 reattach 同一 Codex thread。
- **auto-continue 配置化**：设置项 `autoContinue.<cli>.enabled/max`（SCHEMA + 设置卡每 CLI 开关与续接次数，默认 `true`/`3`），服务经 `autoContinueSource` 读取；`enabled:false` 时原样返回不续接，`max` 覆盖默认上限。**泛化评估**：续接依赖同一 thread 的 followup，仅对 Codex 会话式调用生效；Claude/Qwen 走一次性 provider（每次全新进程、无 thread 可续接），暂不适用，后续接入会话式驱动可复用同一逻辑。
- **双模式端到端自动化**：`e2e-live.mjs` 新增 Codex 双模式会话段——用真实 `CodexAppServerDriver` + `ManagedCliAgentsService` + 真实 codex app-server 与当前路由跑 `dispatch`（直连）与 `bindChild/submitFromChild`（代理提交路径），断言两轮同一 session 且输出完整，`npm run test:live` 一键复跑。
- **e2e 纯断言**：`e2e-live.mjs` 顶部新增纯逻辑断言——`CLI_SUBAGENT_TOOLS` 不含 `cli_codex` 别名、`isOkReply` 容忍 `OK\nOK` 回声并拒绝非 OK 行。CI 的 `pnpm test`（`node --test test/*.test.mjs`）已覆盖新增单测（isOkReply、别名移除、持久化、autoContinue），无需改动 workflow。
- 单元测试新增 8 个：`persistable` 不序列化活体状态、restore 恢复后 reattach 同一 thread、restore 跳过 closed/无 thread 记录、dispatch 经 seam 落库、restore 后 followup 直接 reattach（attachOnly + resumeThreadId）、autoContinue `enabled:false` 不 nudge、`max` 限制续接次数等。

### Changed

- **Codex 命令面明确化**：移除 `cli_codex` 兼容别名，只保留两条入口——`cli_codex_direct`（直连：主控直接调用外部 CLI，不建 Relay 子代理）与 `cli_codex_subagent`（代理：DSH Relay 子代理转发给真实 Codex thread）。同步更新设置卡 guide（直连/代理两行）、`cli_codex_followup/status/sessions/interrupt` 描述、`cli_dispatch` 提示与 README（中/英）。

### Fixed

- **探测 OK 回声误拦**：部分供应商/模型（如 zzztoken 上的 deepseek-v4-pro）把 `Reply with exactly: OK` 回声成 `OK\nOK`，此前会被严格相等校验误判为"连通失败"，导致 `cli_codex` 被预检拦截、用户改配置后不易感知。新增纯函数 `isOkReply`（所有非空行均为 OK 即通过），且报错带 `provider / model` 名，路由一目了然。
- **长任务提前 end_turn 无完整结果**：部分模型在长多步工具任务中输出计划句后即提前结束 turn。服务层加入有界自动补全（同 thread nudge，最多 3 次），一次 `cli_codex_direct` 调用即可返回完整报告；驱动统计 `commandExecution` 轮次供判定，拿到完整块后清理进度噪音（长度 ≥100 字符才替换）。
- **e2e 会话段 PATH 缺失**：双模式段最初只传隔离 env，`codex` 二进制是 `#!/usr/bin/env node` shim，缺 `process.env.PATH` 导致 app-server 以 127 退出；改为 `{ ...process.env, ...隔离 env }` 后真实验证通过。

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
