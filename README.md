# dsh-sub-cli

在 DeepSeek Harness（DSH）中统一管理外部 Agent CLI 的开源插件。

- 把 Codex、Claude Code、OpenCode、Gemini CLI 放到**统一目录**（默认 `~/dsh-clis`），不混入系统 PATH；
- 每个 CLI 用**相互隔离的配置目录**，通过该 CLI 自身环境变量指向，完全不碰系统里已装的 CLI 配置；
- Web 插件配置卡片配置统一目录 + 每个 CLI 的**三层模型路由**（Provider → 模型 → 推理强度）；
- 注册 **`cli_dispatch`** 模型工具让 DSH 模型无头调用外部 CLI 并回传输出。

## 产品目标

本产品解决的核心问题是：**DSH 本身用 DeepSeek 模型，但很多用户已经装了 Codex、Claude Code 等其它 Agent CLI，想让 DSH 也能用它们来处理任务**（例如“用 Claude Code 看这个项目”）。

问题在于这些 CLI 各有各的安装位置、配置目录和模型设置，很乱，而且容易与用户系统里自己装的那份混在一起。

因此本插件要实现五点：

1. **统一管理**：把这些 CLI 集中放到一个目录（默认 `~/dsh-clis` 或 `%USERPROFILE%\dsh-clis`），不与系统里原有的混用；
2. **配置隔离**：每个 CLI 用独立配置目录，**不破坏**用户系统里已经配好的那份；
3. **能在 DSH 里用**：DSH 模型通过 `cli_dispatch` 工具无头调用这些 CLI 干活，把结果回传进对话；
4. **像点子代理**：在会话头能看到这些 CLI 的状态，点进去进入它自己的对话；
5. **跨平台**：同时支持 macOS 和 Windows，在路径、系统命令、默认目录上分别适配。

## 已确认的主界面交互

主界面不提供手工“新建 CLI 任务”工作台。用户只向主控 AI 提需求，由主控决定是否委派给某个 CLI，并生成一个简短工作标题。

CLI 工作应复用 DSH 的 subagent 子会话体验：当前主控会话下展示标题、CLI 产品与运行状态；点击进入后查看历史和输出；支持的 provider 可继续接收用户或主控消息，也可停止当前轮次；完成结果自动回报主控。插件设置页只负责安装、配置、认证提示、检测和测试。

当前实现提供 `agent.cordis.yml` Preset 片段：它用 DSH 原生 continuable 子 Agent 承载四种 CLI 工作。主控调用对应 Tool 后，标题、状态、历史、后续消息、停止和完成通知都由原生 subagent UI/runtime 提供。外部 CLI 在每个子会话轮次中独立无头执行，因此这是持续的 DSH 子会话，不宣称复用同一个 Codex thread 或 Claude SDK session。详细约束见 `CLI-MANAGER-DESIGN.md` 与 `CLI-MANAGER-HANDOFF.md`。

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
6. `MIGRATION-INVENTORY.md`：旧项目资料迁移清单；
7. `reference/dsh-subagent-default-model/`：旧项目参考实现，不作为发布入口。

## 开发与验证

```bash
node integration.mjs   # 运行 registry/paths 测试
node prove.mjs         # 运行 dispatch/status 测试
cd plugin && npm test  # 运行全部单元测试
cd plugin && npm pack --dry-run
```

## License

[MIT](plugin/LICENSE)
