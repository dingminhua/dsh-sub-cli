# dsh-subagent-default-model 迁移清单

本仓库已在 2026-08-25 从 `dsh-subagent-default-model` 接收其可复用资料，目的是允许旧项目后续清理，同时保留开发 `dsh-sub-cli` 所需的代码样例、文档、测试方法和发布经验。

## 迁移方式

源仓库当时 Git `HEAD` 的全部跟踪文件均已复制。为了避免把旧插件误认为新实现，旧项目资料统一归档到：

```text
reference/dsh-subagent-default-model/
```

以下内容没有复制：

- `.git/` 和旧仓库提交身份；
- `plugin/node_modules/` 等依赖安装产物；
- `.DS_Store`；
- 未跟踪的 `.agent-teams/`；
- 本机用户配置、认证信息、API Key 或实际 CLI 配置。

## 新项目主资料

- `CLI-MANAGER-HANDOFF.md`：CLI 管理器完整转交文档，是需求与技术调研的主入口；
- `CLI-MANAGER-DESIGN.md`：精简设计说明；
- `README.md`：新项目入口和当前状态；
- `DEVELOPMENT.md`：新项目开发原则与建议布局；
- `RELEASING.md`：新项目发布前条件和流程。

## 归档资料内容

`reference/dsh-subagent-default-model/` 保留：

- `plugin/`：旧插件的 Host、Client、package、测试、README、CHANGELOG 和许可证；
- `vendor/dsh-subagent-max/`：旧插件使用的上游参考快照及许可证；
- `DEVELOPMENT.md`、`PLUGIN_REQUIREMENTS.md`、`RELEASING.md`：旧插件开发、约束和发布经验；
- `integration.mjs`、`prove.mjs`：旧插件验证脚本；
- `assets/`：旧插件截图；
- `awesome-dsh-plugin-submission/`：旧市场提交样例。

这些内容只用于追溯和吸收经验，不是 `dsh-sub-cli` 的发布入口。

## 可吸收的工程经验

1. `installSettingsSection` 与 `settingsNamespace` 的 Host 设置接入模式；
2. `settings.plugin.item` 的 Client 插件配置卡片模式；
3. `settingsScope.bind()`、订阅快照、逐字段持久化与写后确认；
4. 中英文 locale 注册、样式注入和折叠卡片外壳；
5. Cordis `ctx.effect` 生命周期清理以及必要时访问 raw service 的方法；
6. `MemorySettings`、Cordis Context 和 fiber 卸载测试夹具；
7. DSH package exports、client entry、bundle patch 和 `npm pack --dry-run` 发布检查；
8. 双语 README、CHANGELOG、市场提交和 npm 2FA 发布经验。

## 不能直接沿用的旧行为

- 包名、仓库地址和 `subagent-default-model` 设置命名空间；
- 对 `ctx.subagents` 的 `start` / `startContinuable` 包装；
- Provider、Model 和 reasoning effort 的旧配置表单；
- 旧截图、旧市场条目和旧产品说明；
- `@deepseek-ai/dsh-subagent` peer dependency；
- 旧测试中的默认模型注入断言；
- 任何指向旧仓库的绝对路径。

开发新功能时应移植模式而不是复制产品语义。

## 开始实现时的处理建议

- 新建真正的 npm 插件根和 package identity；
- 从参考 `plugin/lib/index.js` 提取设置注册与生命周期骨架；
- 从参考 `plugin/lib/client.js` 提取卡片、locale、settingsScope 和保存确认模式；
- 重写业务层为 CLI 注册表、统一目录、配置隔离、状态检测和派发；
- 使用临时目录与假 CLI 编写全新的状态、argv、环境变量、超时、取消、输出和错误测试；
- 默认不把 `reference/` 打进 npm 包。

## 清理旧项目之前的核对

旧仓库可删除前建议确认：

1. 本仓库迁移资料已经 Git 提交并推送到远程；
2. `git ls-files` 能列出 `reference/dsh-subagent-default-model/` 的必要资料；
3. `git diff --no-index` 或清单核对证明源仓库 `HEAD` 的跟踪文件均有对应归档；
4. 重要二进制素材可正常打开；
5. 需要保留的旧提交历史已通过远程、tag 或 bundle 留档；
6. npm 发布凭据、用户配置和依赖安装不依赖旧仓库路径；
7. 新实现不通过绝对路径读取旧仓库。

> 本次迁移不会删除或修改旧仓库。旧项目的实际清理由用户在验证并提交本仓库后单独执行。
