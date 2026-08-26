# dsh-sub-cli 开发指南

## 当前阶段

插件已实现 `plugin/` 目录下的完整开源包结构（Host + Client + 测试 + 文档），正在进行将插件安装到 DSH Desktop 的集成验证。

### Desktop 启动崩溃回归

曾发现三类会让整个 Desktop profile 启动失败或污染 UI 的兼容问题：

1. 旧版入口在模块求值阶段调用当前 Schemastery 不支持的 `z.object(...).partial()`；
2. 某一版 Host 入口执行了未定义的 `require`；
3. 早期用 `ctx.llm.registerAdapter()` 把 `dsh-cli-*` 注册成 LLM Provider，导致模型选择器出现 “External CLI · codex/claude/opencode/gemini” 并报 `adapter returned invalid or duplicate model metadata`。

针对第 3 点：DSH 没有“私有 LLM route（不暴露给模型选择器）”的机制，`registerAdapter` 一旦加入就会被 `listProviders()` 暴露。因此托管 CLI 必须注册为真正的 `SubagentProvider`，而不是 LLM adapter；当前实现已改为 `lib/provider.js` 的 one-shot provider。

Host 入口必须通过 `test/host-import.test.mjs` 的纯 ESM 导入回归。插件启动错误可在：

```text
~/Library/Application Support/DSH Desktop/logs/dsh-YYYY-MM-DD.error.log
```

中查看。禁止只依赖单元测试里的宽松 mock 判断 Host 可加载。

## CLI 工具的工作模式策略（已确认）

### 产品要求

安装并启用 `dsh-sub-cli` 后，CLI 委派能力应默认可供**所有 Agent 工作模式**使用，不要求用户选择专门的「Code + External CLI」模式。

目标行为：

```text
任意工作模式（standard / code / cordis / 用户自定义模式）
  → 主控 AI 可调用 cli_codex / cli_claude_code / cli_opencode / cli_gemini
  → DSH 创建原生子会话
  → 展示标题、状态与历史
  → 支持后续消息和停止当前轮次
```

### 架构边界

- CLI 可执行文件、配置、状态检测和 LLM route 由 `dsh-sub-cli` Host 插件管理；
- 四个模型工具也应由 Host 插件注册到共享 `tools` registry，不依赖一个专用 Agent Preset；
- DSH 原生 subagent runtime 继续负责子会话、父子关系、历史、状态、follow-up、interrupt 和完成通知；
- 某个工作模式如果明确使用工具白名单、deny 规则或安全策略屏蔽 CLI 工具，插件必须尊重该限制，不得绕过；
- 插件卸载或停用时，所有 CLI 工具和 route 必须随 Fiber 一起释放。

### 专用 Preset 的处理

开发期间创建的用户 Preset：

```text
~/.dsh/.agent-presets/dsh-sub-cli/
```

只用于早期验证，不是正式产品依赖。Host 全局工具注册完成后，该用户 Preset 与 `plugin/agent.cordis.yml` 已删除；正常使用不需要创建或选择额外工作模式。

### 验收标准

1. 安装插件后，不创建自定义工作模式也能在普通会话获得 CLI 工具；
2. 至少验证 `standard`、`code`、`cordis` 三种模式的工具可见性；
3. 主控调用 CLI 工具后，创建的工作实例按原生 subagent 子会话呈现；
4. 子会话支持查看历史、后续沟通和停止当前轮次；
5. 明确限制 CLI 工具的模式仍保持限制；
6. 删除开发用 Preset 后，上述能力不受影响。

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