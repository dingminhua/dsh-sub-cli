# dsh-sub-cli

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-sub-cli"><img src="https://img.shields.io/npm/v/dsh-sub-cli?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-sub-cli"><img src="https://img.shields.io/npm/d18m/dsh-sub-cli?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/dingminhua/dsh-sub-cli/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dingminhua/dsh-sub-cli/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dingminhua/dsh-sub-cli?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dingminhua/dsh-sub-cli/stargazers"><img src="https://img.shields.io/github/stars/dingminhua/dsh-sub-cli?style=flat-square" alt="GitHub stars"></a>
  <a href="https://dshfind.com/plugins/dingminhua/dsh-sub-cli"><img src="https://dshfind.com/api/badge/dingminhua/dsh-sub-cli" alt="dshfind plugin"></a>
</p>

在 DeepSeek Harness（DSH）中统一管理外部 Agent CLI 的开源插件。

- 把 Codex、Claude Code 放到**统一目录**（默认 `~/dsh-clis`），不混入系统 PATH；
- 每个 CLI 用**相互隔离的配置目录**，通过该 CLI 自身环境变量指向，完全不碰系统里已装的 CLI 配置；
- Web 插件配置卡片配置统一目录 + 每个 CLI 的**三层模型路由**（Provider → 模型 → 推理强度）；
- 注册 **`cli_codex_direct` / `cli_codex_subagent` / `cli_claude_direct` / `cli_claude_subagent`** 工具让 DSH 模型把任务交给对应 CLI 并作为子会话返回（Qwen Code 支持已于 2026-09 移除）；
- 注册 **`cli_dispatch`** 模型工具让 DSH 模型无头调用外部 CLI 并回传输出。

## 产品目标

本产品解决的核心问题是：**DSH 本身用 DeepSeek 模型，但很多用户已经装了 Codex、Claude Code 等其它 Agent CLI，想让 DSH 也能用它们来处理任务**（例如“用 Claude Code 看这个项目”）。

问题在于这些 CLI 各有各的安装位置、配置目录和模型设置，很乱，而且容易与用户系统里自己装的那份混在一起。

因此本插件要实现五点：

1. **统一管理**：把这些 CLI 集中放到一个目录（默认 `~/dsh-clis` 或 `%USERPROFILE%\dsh-clis`），不与系统里原有的混用；
2. **配置隔离**：每个 CLI 用独立配置目录，**不破坏**用户系统里已经配好的那份；
3. **能在 DSH 里用**：DSH 模型通过 `cli_dispatch` / `cli_<cli>_direct` / `cli_<cli>_subagent` 调用这些 CLI 干活，把结果回传进对话；每个 CLI 可独立配置权限能力（读文件 / 写文件 / 执行命令，exec 已承载联网意图），勾选的能力运行时静默放行、未勾选的被触发时确定拒绝并记录，任务做不了就清晰报错引导用户到设置卡调整（审批模式已移除：档位启动时定死，无弹窗、无运行中提权），旧的只读 / 工作区可写 / 完全三档预设会自动映射为对应的能力组合；
4. **像点子代理**：在会话头能看到这些 CLI 的状态，点进去进入它自己的对话；
5. **跨平台**：同时支持 macOS 和 Windows，在路径、系统命令、默认目录上分别适配。

## 已确认的主界面交互

主界面不提供手工“新建 CLI 任务”工作台。用户只向主控 AI 提需求，由主控决定是否委派给某个 CLI，并生成一个简短工作标题。

CLI 工作应复用 DSH 的 subagent 子会话体验：当前主控会话下展示标题、CLI 产品与运行状态；点击进入后查看历史和输出；支持的 provider 可继续接收用户或主控消息，也可停止当前轮次；完成结果自动回报主控。插件设置页只负责安装、配置、认证提示、检测和测试。

当前实现由 Host 插件全局注册其工具面——每个 CLI 六个（`cli_<cli>_direct` / `_followup` / `_status` / `_sessions` / `_interrupt` / `_subagent`）共 2 个托管 CLI 12 个，加 `cli_dispatch`、生命周期工具 `cli_check` / `cli_install` / `cli_test` / `cli_remove`，以及 Relay 内部 `managed_cli_submit`，合计 18 个；并为每个托管 CLI 各注册一个 `SubagentProvider`（`managed-codex-relay` / `managed-claude-relay`），任意工作模式默认可用（明确的工具白名单或 deny 规则仍然优先）。Relay 形态经 `ctx.subagents.start(managed-<cli>-relay, ...)` 派发，把 CLI 输出作为子会话结果返回，不注册任何 LLM provider，因此不会污染模型选择器。标题、状态、历史等由原生 subagent UI/runtime 提供。

**持续会话**：首轮（`cli_<cli>_direct`）返回稳定的 `sessionId`，后续经 `cli_<cli>_followup` 直接进入同一个真实 thread（Codex 走 app-server 长连接，Claude 走 `stream-json` + 文件级 `--resume` 持久化）；会话状态落盘 `sessions.json`，Host 重启后仍可 reattach 同一 thread。详细约束见 `CLI-MANAGER-DESIGN.md` 与 `CLI-MANAGER-HANDOFF.md`。

## 项目结构

```
├── .github/workflows/ci.yml      # CI：测试 + npm pack --dry-run
├── integration.mjs / prove.mjs   # 顶层验证脚本
├── awesome-dsh-plugin-submission/ # 市场提交元数据
├── reference/                    # 旧项目归档（不作为发布入口）
└── plugin/                       # npm 包根
    ├── package.json
    ├── cordis.patch.yml
    ├── lib/
    │   ├── index.js              # Host 入口
    │   ├── registry.js           # CLI 注册表 + argv 模板
    │   ├── paths.js              # 统一目录 + 配置隔离
    │   ├── status.js             # 安装/版本检测
    │   ├── dispatch.js           # 无头派发
    │   └── client.js             # Web 设置卡片
    ├── test/                     # 单元测试（node --test）
    ├── README.md / README.en.md
    ├── CHANGELOG.md
    └── LICENSE                   # MIT
```

## 文档入口

1. `plugin/README.md` / `plugin/README.en.md`：包的用户文档；
2. `plugin/PLUGIN_REQUIREMENTS.md`：开发红线与结构要求；
3. `DEVELOPMENT.md`：本地开发原则与建议布局；
4. `RELEASING.md`：发布流程；
5. `CLI-MANAGER-HANDOFF.md` / `CLI-MANAGER-DESIGN.md`：需求与技术调研（历史）；
6. `CLI-AGENT-REFERENCE-RESEARCH.md`：首轮四个外部 CLI Agent 项目的架构对比、权限交互结论与演进建议；
7. `CLI-AGENT-FRAMEWORK-RESEARCH.md`：通用子代理框架、角色目录、外部 Engine、官方 Claude Provider 与 DAG 编排的增量调研；
8. `CLI-AGENT-ROADMAP.md`：CLI Agent 最终目标、架构、能力合同、实施阶段与当前验收标准；
9. `MIGRATION-INVENTORY.md`：旧项目资料迁移清单；
10. `reference/dsh-subagent-default-model/`：旧项目参考实现，不作为发布入口。

## 致谢

本项目的实现建立在他人已公开的工作之上。以下内容如实标注来源与许可证，我们对此保持充分尊重：

### 多 CLI 管理 / Relay 子代理的主参照

- [dingminhua/dsh-subagent-default-model](https://github.com/dingminhua/dsh-subagent-default-model)（MIT，Copyright (c) 2026 LaoDing）— **本项目的主要参照**。多 CLI 注册表、argv 模板、三层模型路由、隔离配置目录、`managed_cli_submit` Relay 子代理形态、DSH Web 卡片样式与 npm 发布工程，均从该项目的能力形态中提炼并独立重写。本仓库的 `reference/dsh-subagent-default-model/` 即为该项目的归档实现，仅在本地开发期作为对照，不随包发布。

### 外部 CLI 派发的可行性参考

- [MJorgin/dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor)（MIT，Copyright (c) 2026 MJorgin）— 在 DSH 会话里把任务派给 11 种外部 Agent CLI 的 `subprocess.spawn` 无头执行范式；本插件从中提炼出 argv 数组派发、超时与错误回传、退出码处理的实现细节。

### 协议续接调研（不进入默认链路）

- [wujfeng712-ui/codex-bridge](https://github.com/wujfeng712-ui/codex-bridge)（MIT）— Responses API ↔ Chat Completions 双向转换与 `previous_response_id` 续接的备选协议路径；本项目仅在调研期记录其设计，**未在主链路中引用**，亦未引入其源码或二进制依赖。

### 说明

以上项目的版权归各自作者所有。本项目采用**借鉴设计思路 + 独立实现**的方式，未整体复制任何参考项目的源码；关键模块均为独立编写，并在源文件头部注释中标注了所参考的具体项目与模式。若你发现本项目的标注有遗漏或不当之处，请提交 issue，我们会立即更正。

## 第三方开源依赖

本项目参考的开源项目、其许可证与合规说明，完整记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。引入新的外部依赖或复用其他项目代码时，请同步更新该文件并遵守对应许可证要求。

## 开发与验证

```bash
node integration.mjs   # 运行 registry/paths 测试
node prove.mjs         # 运行 dispatch/status 测试
cd plugin && npm test  # 运行全部单元测试（离线 mock）
cd plugin && npm pack --dry-run
```

**端到端实战验证没有 standalone 脚本**（原 `e2e-live.mjs` 与 `verify-matrix/` 系列已于 2026-09-04 删除——直启 CLI 进程的脚本在真实会话里会卡死进程，且绕过 harness 工具层的权限门控、审计留痕与会话管理）。统一按 `plugin/VERIFICATION-FLOW.md` 的三阶段流程，由主控在 DSH 会话里用插件注册的工具真实驱动：

1. **写入**：`cli_codex_subagent` / `cli_claude_subagent`（Relay 子代理）各把一段只有主控知道的暗号写入磁盘（UTF-8、无尾随换行、固定字节数）；
2. **读取核对**：`cli_codex_direct` / `cli_claude_direct`（持续会话）做 2×2 互读复述，证明文件真实落盘且两个 CLI 读到同一份字节；
3. **删除**：Relay 子代理删除阶段一写入的文件，主控独立复核磁盘无残留。

判定以主控的磁盘逐字节校验为准（CLI 自报不可信）；阶段推进必须等全部子代理 completion。写入/删除需要设置卡把对应 CLI 调到「可执行」档；只读档下写入会被确定拒绝并如实回报——这本身是权限门控的有效数据点（2026-09-04 实测：Codex relay 在只读档下五种写入方式全部被沙箱拦截、提权请求被自动拒绝、relay 如实回报「未创建」，磁盘零文件）。

## License

[MIT](LICENSE)
