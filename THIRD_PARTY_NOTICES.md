# 第三方开源声明（Third-Party Notices）

> 本文件记录本项目在设计、实现与配置上参考或借鉴的开源项目，以及各自的许可证与合规要求。
>
> 通用平台与构建依赖（`@deepseek-ai/*`、`react`、`typescript`、`tsdown`、`vitest` 等）的许可证随各自 npm 包自动携带，不属于本文档范围。
>
> 若你对本文件的完整性有疑问或发现遗漏，请提交 issue 或 PR。

## 一、项目缘起

`dsh-sub-cli` 是 **在 DeepSeek Harness（DSH）中统一管理外部 Agent CLI** 的插件，目标是把 Codex 与 Claude Code 两个上游 CLI 集中到一个独立的目录、用相互隔离的配置目录运行，并通过统一的 Web 卡片配置三层模型路由与权限档位，再以 DSH 模型工具的形式让主控调用它们（Qwen Code 支持已于 2026-09 移除：实测可靠性不足）。

它的能力形态由两个来源支撑：

| 角色 | 项目 | 提供了什么 |
| --- | --- | --- |
| 注册表 / argv 模板 / 隔离配置 / Relay 子代理主参照 | [`dsh-subagent-default-model`](https://github.com/dingminhua/dsh-subagent-default-model) | 已有的多 CLI 管理范式：每个 CLI 一个注册表条目、三层模型路由、隔离配置目录、`managed_cli_submit` 形态的 Relay 子代理、DSH Web 卡片与 npm 发布工程 |
| 外部 CLI 派发的可行性参考 | [`dsh-agent-conductor`](https://github.com/MJorgin/dsh-agent-conductor) | 在 DSH 会话里把任务派给 11 种外部 Agent CLI 的 `subprocess.spawn` 无头执行范式；本插件从中提炼出 argv 数组派发、超时与错误回传、退出码处理的实现细节 |
| 协议续接备选方案（不进入默认链路） | [`codex-bridge`](https://github.com/wujfeng712-ui/codex-bridge) | Responses API ↔ Chat Completions 的双向转换与 `previous_response_id` 续接实现；本插件在调研期记录了它的设计，**并未在主链路中引用** |

> `dsh-subagent-default-model` 同时也是本仓库 `reference/dsh-subagent-default-model/` 目录所归档实现的现役上游版本——`reference/` 只在本地开发期作为对照，不随包发布。

## 二、参考项目清单

### 与多 CLI 管理 / Relay 子代理相关

| 项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `dsh-subagent-default-model` | <https://github.com/dingminhua/dsh-subagent-default-model> | 多 CLI 注册表、argv 模板、三层模型路由、隔离配置目录、`managed_cli_submit` Relay 子代理形态、DSH Web 卡片样式与发布工程 | **MIT**（Copyright (c) 2026 LaoDing） |

### 与外部 CLI 派发相关

| 项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `dsh-agent-conductor` | <https://github.com/MJorgin/dsh-agent-conductor> | `subprocess.spawn` 无头派发 11 种外部 CLI、退出码与超时回传、argv 数组执行（避免 shell 字符串拼接） | **MIT**（Copyright (c) 2026 MJorgin） |

### 协议调研类（不进入默认链路）

| 项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `codex-bridge` | <https://github.com/wujfeng712-ui/codex-bridge> | Responses API ↔ Chat Completions 双向转换与 `previous_response_id` 续接，作为 chat 型供应商 + 工具任务场景下的备选协议路径 | **MIT** |

## 三、合规说明

- 三个参考项目均采用 **MIT** 许可证，与本项目自身的 MIT 许可证兼容；MIT 仅要求保留版权声明。
- 本项目**不重新打包、不再分发**上述参考项目的源码；仅参考其架构思路、注册表形态、argv 模板与协议研究。`reference/` 目录仅作为本地开发期对照，不在 `npm pack` 产物内（见 `package.json` 的 `files` 白名单）。
- 各源文件头部注释均已标注所参考的具体项目与模式；关键模块（注册表、隔离配置、持续会话驱动、`cli_dispatch`、driver 层权限拦截）均为本项目独立编写。
- `codex-bridge` 的引用**仅作为协议调研**记录在 `CLI-MANAGER-DESIGN.md` / `DEVELOPMENT.md` 等内部文档中，**不进入主链路**，亦不引入其源码或二进制依赖；若后续主链路决定采纳其方案，会在此处追加 Apache-2.0 之类更严义务的特别说明（参考 `dsh-connect-workbuddy/THIRD_PARTY_NOTICES.md` 的"Apache-2.0 特别说明"小节）。

## 四、本项目的使用方式

- **借鉴设计思路 + 独立实现**：关键模块均为本项目独立编写，并在各源文件头部注释中标注所参考的具体项目与模式。
- **不整体复制源码**：未复制、修改或再分发上述任何参考项目的源文件。
- **版权声明保留**：所有参考项目的版权归各自作者所有；本项目代码不构成对它们的再分发。
- **后续引入依赖时**：引入任何新的外部依赖、或复用其他项目代码时，必须同步更新本文件，并遵守对应许可证的署名与声明要求。

## 五、随包分发

本文件与根 `LICENSE`、根 / `plugin/` 的 `README` 致谢段互为索引；`plugin/` 内的 `package.json` `files` 白名单保证 npm 安装包内即可看到完整的第三方声明。
