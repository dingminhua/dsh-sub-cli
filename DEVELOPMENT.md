# dsh-sub-cli 开发指南

## 当前阶段

插件已实现 `plugin/` 目录下的完整开源包结构（Host + Client + 测试 + 文档），正在进行将插件安装到 DSH Desktop 的集成验证。

## 跨平台支持目标

本插件应同时支持 macOS 和 Windows（DSH 运行的两种主要平台）。当前实现以 macOS 为主，对 Windows 的适配点包括：

- **路径分隔符**：统一目录中 `bin/`、`config-<cli>/` 等路径的拼接，在 Windows 上须使用 `path.join` 或 `path.sep`，不能硬编码 `/`；
- **系统命令**：`/bin/test`、`/bin/cp`、`/bin/mkdir`、`/bin/rm` 等仅存在于 macOS/Linux。Windows 上须改用 `fs` 模块或 `cmd.exe` 命令；
- **默认目录**：macOS 默认 `~/dsh-clis`，Windows 默认 `%USERPROFILE%\dsh-clis`；
- **环境变量隔离**：各 CLI 的配置目录环境变量（`CODEX_HOME`、`CLAUDE_CONFIG_DIR` 等）在 Windows 上行为相同；
- **子进程**：`ctx.subprocess.spawn` 应当跨平台工作，但 argv 中不得包含 shell 语法（已遵守）；
- **测试**：`/bin/sh`、`/bin/test` 等 POSIX 命令在测试中不应出现；Windows 测试应使用 `cmd.exe` 或 `node:child_process` 原生能力。

Windows 适配是**渐进式**的，不在首版中全部完成，但上述差异点应在代码和文档中标注。

## 建议项目布局

```
plugin/
├── lib/
│   ├── index.js              # Host 入口
│   ├── registry.js           # CLI 注册表 + argv 模板
│   ├── paths.js              # 统一目录 + 配置隔离（跨平台路径）
│   ├── status.js             # 安装/版本检测
│   ├── dispatch.js           # 无头派发
│   └── client.js             # Web 设置卡片
├── test/                     # node --test 单元测试
├── package.json
├── cordis.patch.yml
├── README.md / README.en.md
├── CHANGELOG.md
└── LICENSE
```

## 可复用模式

旧参考实现中最值得移植的部分：

- Host：`installSettingsSection`、`settingsNamespace` 和 `ctx.effect` 清理；
- Client：`settings.plugin.item`、折叠插件卡片、中英文 locale、settingsScope 快照和写后确认；
- Test：`MemorySettings`、Cordis Context 测试夹具和 fiber 卸载检查；
- Package：DSH `exports`、client entry、bundle patch 和 `npm pack --dry-run` 验证。

## 本地开发原则

- 外部 CLI 必须只从用户配置的统一目录解析，不隐式回退系统 PATH；
- 配置必须通过每个 CLI 的原生环境变量或参数隔离；
- 任务参数使用 argv 数组传递，避免 shell 拼接；
- 对 stdout、stderr、退出码、超时、取消和输出上限建立明确合同；
- 测试使用临时目录和假 CLI，不读取或覆盖真实用户配置；
- 不把 API Key、认证文件、CLI 配置或本机绝对路径提交到仓库；
- **跨平台兼容**：路径拼接使用 `path.join`，系统命令依赖应标注平台差异，Windows 适配为渐进式。

## DSH GUI 验证

将插件安装到 DSH Desktop profile 后，在 `http://127.0.0.1:43120` 上验证：

1. 检查 `settings.plugin.item` 卡片可正常打开和填写；
2. 检查统一目录保存后是否在 `settings.yaml` 中持久化；
3. 检查 `cli_dispatch` 工具是否在模型可用工具列表中；
4. 检查会话头 `n SubCLI` 目录显示。