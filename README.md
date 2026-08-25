# dsh-sub-cli

DSH（DeepSeek Harness）的外部 Agent CLI 管理器项目。

本项目计划让用户在 DSH 中统一管理和调用首批四种外部 Agent CLI：Codex、Claude Code、OpenCode 和 Gemini CLI。

- 将 CLI 二进制集中到用户选择的统一目录（Windows 默认 `%USERPROFILE%\dsh-clis`，macOS 默认 `~/dsh-clis/`）；
- 用户修改统一目录后，经确认将插件托管的二进制、配置和元数据安全迁移到新目录；
- 为不同 CLI 使用相互隔离的配置目录，不影响用户现有系统配置；
- 在 DSH Web 插件配置页展示安装、配置和可用状态；
- 提供清晰的安装引导；
- 注册派发工具或 Skill，以无头方式运行目标 CLI 并回传结果；
- 后续支持每个 CLI 的独立模型配置和可选调度策略。

## 当前状态

项目处于**资料迁移与实现起步阶段**。

`reference/dsh-subagent-default-model/plugin/` 保存的是原项目 `dsh-subagent-default-model` 的可运行参考实现，用于继承 DSH 插件设置、Web 卡片、Cordis 生命周期、测试和发布模式。它尚未改造成 `dsh-sub-cli`，请勿以新包名发布。

## 文档入口

1. `CLI-MANAGER-HANDOFF.md`：完整需求、调研结论、参考实现和建议开发路径；
2. `CLI-MANAGER-DESIGN.md`：精简设计说明；
3. `MIGRATION-INVENTORY.md`：从旧项目迁入的资料、保留原因、待改造项和清理前核对清单；
4. `DEVELOPMENT.md`：新项目开发原则和建议布局；
5. `RELEASING.md`：新项目发布条件与流程；
6. `reference/dsh-subagent-default-model/`：旧插件完整参考资料。

## 默认目录与迁移

| 系统 | 默认目录 |
|---|---|
| Windows | `%USERPROFILE%\dsh-clis` |
| macOS | `~/dsh-clis` |

两者都表示当前用户主目录下的 `dsh-clis`；实现时通过系统用户主目录 API 获取，不写死盘符或用户名。

用户可以在 Web 面板选择其他目录。修改目录时，插件先展示迁移内容并请求确认，然后将旧目录中的 `bin/`、各 CLI 配置目录和托管元数据移动过去。只有迁移及校验全部成功后才切换当前目录；发生权限、空间或文件冲突时继续保留旧目录，不静默覆盖目标文件。

## 目标目录结构

以下以 macOS 默认值为例：

```text
~/dsh-clis/
├── bin/
│   ├── codex
│   ├── claude
│   ├── opencode
│   └── gemini
├── config-codex/
├── config-claude/
├── config-opencode/
└── config-gemini/
```

运行目标 CLI 时，由插件显式设置其配置目录环境变量或参数，例如：

```bash
CODEX_HOME=~/dsh-clis/config-codex ~/dsh-clis/bin/codex exec "任务"
CLAUDE_CONFIG_DIR=~/dsh-clis/config-claude ~/dsh-clis/bin/claude -p "任务"
```

第一阶段不做协议代理或跨供应商模型转换，优先使用各 CLI 的原生认证和原生模型。

## 建议实施顺序

1. 定义 CLI 注册表及统一目录设置；
2. 实现 CLI 状态检测和安装提示；
3. 实现安全的无头派发服务与工具；
4. 将参考 Web 卡片改造成 CLI 管理面板；
5. 增加配置隔离、超时、退出码、stdout/stderr 和取消处理测试；
6. 再增加每个 CLI 的模型配置及可选调度策略。

## 迁移说明

本仓库已复制旧项目 Git `HEAD` 中的全部跟踪文件，以便旧项目后续清理。没有复制依赖目录、Git 元数据、临时协作状态或本机认证配置。详见 `MIGRATION-INVENTORY.md`。

## License

新项目最终许可证待正式实现和发布前确认。迁入的 `reference/dsh-subagent-default-model/plugin/LICENSE` 及其 `vendor/` 内许可证继续约束对应旧代码和参考快照。
