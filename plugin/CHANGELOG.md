# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Codex 命令面明确化**：移除 `cli_codex` 兼容别名，只保留两条入口——`cli_codex_direct`（直连：主控直接调用外部 CLI，不建 Relay 子代理）与 `cli_codex_subagent`（代理：DSH Relay 子代理转发给真实 Codex thread）。同步更新设置卡 guide（直连/代理两行）、`cli_codex_followup/status/sessions/interrupt` 描述、`cli_dispatch` 提示与 README（中/英）。

### Fixed

- **探测 OK 回声误拦**：部分供应商/模型（如 zzztoken 上的 deepseek-v4-pro）把 `Reply with exactly: OK` 回声成 `OK\nOK`，此前会被严格相等校验误判为"连通失败"，导致 `cli_codex` 被预检拦截、用户改配置后不易感知。新增纯函数 `isOkReply`（所有非空行均为 OK 即通过），且报错带 `provider / model` 名，路由一目了然。
- **长任务提前 end_turn 无完整结果**：部分模型在长多步工具任务中输出计划句后即提前结束 turn。服务层加入有界自动补全（同 thread nudge，最多 3 次），一次 `cli_codex_direct` 调用即可返回完整报告；驱动统计 `commandExecution` 轮次供判定，拿到完整块后清理进度噪音（长度 ≥100 字符才替换）。

### Verified（真实环境，2026-08-31）

- 在真实 Host（codex-cli 0.149.1 / zzztoken-glm / deepseek-v4-pro / max / danger-full-access）下，直连与代理两种方式各跑一次端到端（抓取 The Verge AI RSS 前 5 条）：
  - `cli_codex_direct`：前台一次调用返回完整 5 条报告（含来源地址 404 自动改用现行 RSS 的说明）；
  - `cli_codex_subagent`：创建 Relay 子代理，任务转发真实 Codex thread，完成自动 report 回报父会话；
  - 两种方式结果一致、内容完整。`cli_test` 实测 `reply: "OK\nOK\nOK\nOK"` 仍 `ok: true`（OK 回声容忍生效）。

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
