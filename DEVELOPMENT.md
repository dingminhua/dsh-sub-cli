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

本插件应同时支持 macOS 和 Windows（DSH 运行的两种主要平台）。Windows 支持已按最佳实践实现（macOS 为开发主环境，Windows 不在本机实测）：

- **路径**：`paths.js` 统一用 `node:path`（`join`/`sep`）；`binName()` 在 Windows 给 npm shim 追加 `.cmd`；
- **存在检测**：`status.js` 不再用 `/bin/test`，改用注入的跨平台 `exists` 回调（DSH `fs` 服务）；`detectInstalled` 签名改为 `{ exists, spawn, dir, entry }`；
- **默认目录**：macOS `~/dsh-clis`，Windows `%USERPROFILE%\dsh-clis`（`expandTilde` 兼容 `~\`）；
- **子进程 shim**：`dispatch.js` 的 `winShimArgv(resolved, argv, platform)` 把 Windows `.cmd`/`.bat` 用 `cmd.exe /d /s /c` 包裹；`provider.js`、`status.js` 均复用；
- **安装命令**：`install.js` 的 `installCommandOf` 按平台渲染 —— POSIX 给 shell 脚本，Windows 给 PowerShell（`New-Item`/`Copy-Item` 复制 `.cmd` shim，避免需要提权的符号链接）；
- **删除**：`manage.js` `removeManagedCli` 已有 win32 分支（`cmd.exe /d /s /c del`）。
- **测试**：单元测试不依赖 `/bin/sh`、`/bin/test`；跨平台分支通过注入 `platform` 参数（`winShimArgv`、`binName`、`installCommandOf`）覆盖。

> Windows 支持为最佳实践实现，未经 Windows 实机验证；`cmd.exe` shim、PowerShell 安装命令等分支已在单元测试中按注入平台参数覆盖。

## 建议项目布局

```
plugin/
├── lib/
│   ├── index.js              # Host 入口
│   ├── registry.js           # CLI 注册表 + argv 模板
│   ├── paths.js              # 统一目录 + 配置隔离（跨平台路径）
│   ├── status.js             # 安装/版本检测
│   ├── dispatch.js           # 无头派发
│   ├── verify.js             # “已验证”指纹 + 供应商注入 + 实测/预检
│   ├── provider.js           # 托管 CLI 的 subagent provider（spawn 注入供应商 key）
│   ├── subagent-tools.js     # cli_codex/claude/qwen（调用前按指纹预检）
│   └── client.js             # Web 设置卡片
├── test/                     # node --test 单元测试
├── package.json
├── cordis.patch.yml
├── README.md / README.en.md
├── CHANGELOG.md
└── LICENSE
```

## 供应商注入与 config 写入注意（2026-08-27 实测）

- **写 Codex `config.toml` 的 TOML 顺序陷阱**：顶层模型键（`model`/`model_provider`）**必须放在所有 `[xxx]` 表段（如 `[projects."..."]`）之前**；否则标准 TOML 会把它们归入前面的表、模型配置失效、Codex 回退默认 OpenAI → 401。`verify.js` 的 `codexToml()` 已生成"模型段在前"的安全顺序，后续维护不得破坏。
- **`config-<cli>/` 混有运行时数据**：Codex 会在 `config-codex/` 里生成 `*.sqlite`、`sessions/`、`logs_*.sqlite` 等运行时文件；插件写模型配置**只覆盖 `config.toml`**，不触碰其它文件。
- **Codex 0.149 只认 `wire_api = "responses"`**，不再支持 `wire_api = "chat"`（历史上曾因此报错）；k3-baoyue 实测支持 responses。写供应商注入时固定 `wire_api = "responses"`。
- **key 不写进 config**：`env_key = "K3_BAOYUE_API_KEY"` 只声明变量名，真正 key 由插件每次从 DSH credentials 实时注入 spawn 环境（`credentials.resolve(apiKeyEnv).value`）。
- **`cli_test` 必须测工具续接，不只是纯文本**：实测 `aixforge` 对 Codex 是半兼容——单轮 `Reply OK` 通过，但联网/工具类任务 `turn.failed`（`function_call_output requires call_id … only supported on Responses WebSocket v2`）。验证必须加一次**工具续接探测**（两步 responses：先让模型返回 `function_call` 拿 `call_id`，再带 `function_call_output` 续接），结果记入 `verified.<cli>.capabilities.toolContinuation`；纯文本通过≠可用于 Codex 工具任务。**Codex 的 `cli_test` 对续接不通过的供应商直接判失败**，告知「不支持新接口，请换如 modelflare」。Claude/Qwen 保持纯文本检测。
- **按 CLI 协议做单一探测**：每个 CLI 只测它自己那个协议链路的工具续接——`registry.js` 里 `entry.protocol` 标注（codex=`responses`、claude=`anthropic`、qwen=`openai-chat`），`probeProtocolContinuation` 按它路由到 `probeToolContinuation` / `probeAnthropicContinuation` / `probeOpenaiChatContinuation`。**用户填 Provider/Model 时不感知协议**（设置卡不过滤供应商），但每 CLI 卡片下方小字写明"测试将验证该供应商是否支持 <协议>"，`cli_test` 失败按协议说人话（Codex 可试 modelflare）。
- **Codex 会话续接（实测，真续接）**：`codex exec resume <thread_id> [prompt]` 在 headless 下可续接已有会话，完整保留进程内部上下文（实测：第 1 轮记 42，`input_tokens=2505`；resume 问秘密数字得 `42`，`input_tokens=9096`——历史回放）。会话存 `CODEX_HOME/sessions/…/rollout-<thread_id>.jsonl`，`CODEX_HOME` 即隔离的 `config-codex/`，随目录迁移。`codex queue --thread` 需 app-server 常驻（TUI 依赖），无 TTY 时优先用 `exec resume`。Claude：`--resume/--session-id/--continue`；Qwen：`--resume`（本机未装，据文档）。方案 A 续按时保存 CLI `thread_id`，用 resume 续接而非每次新进程。
- **参考实现：dsh-agent-conductor**（`https://github.com/MJorgin/dsh-agent-conductor`，DSH 指挥家）——在会话里把任务派发给 11 种外部 Agent CLI（Codex/Claude Code/Trae/OpenCode/Gemini/Cursor/Kimi/Qwen/Copilot/WorkBuddy/Grok），用 `subprocess.spawn` 无头执行并回传 stdout，工具名 `conductor_dispatch`，host-only 无 client UI。用作「外部 CLI 派发」的可行性参考；但它不管理统一目录、不隔离配置（不设 `CODEX_HOME` 等）、不能独立配模型、无 Web 面板、模型策略不轮换——dsh-sub-cli 正是补齐这些短板。
- **参考实现：codex-bridge**（`https://github.com/wujfeng712-ui/codex-bridge`，MIT，Node 单文件零依赖）——本地协议代理，Responses API ↔ Chat Completions 双向转换，带 `previous_response_id` 会话续接。**需开端口起常驻服务**，仅当用户执意用 chat 型供应商且要工具任务时才启用，不进默认链路。

## 当前未解决问题（2026-08-27）

- **真实运行时验证仍未完成**：用户将 `dsh-sub-cli` 的三个 CLI 路由故意设为 `aixforge / deepseek-v4-flash / high` 后，重启 DSH 并调用 `cli_test(codex)`。此前曾报「找不到 Provider 配置」，修正 `verify.js` 的可选服务访问和 `llm-pi-ai.providers.<id>` 读取后，错误进入下一阶段，但随后出现 `tool "cli_test" returned invalid output: value is not lossless JSON`。
- **该错误已定位到一个已修复的字段错误**：`probeProtocolContinuation()` 返回字段是 `toolContinuation`，旧代码误读为 `gate.ok`，会把 `undefined` 写入 `capabilities`，违反 DSH Tool 的 lossless JSON 约束。源码已改为 `gate.toolContinuation`，本地 **62/62** 单元测试通过；但修复后的运行时结果尚未确认，必须在 DSH 重新加载最新 bundle 后复测。
- **设置卡安装状态仍显示异常**：实际文件存在于 `~/dsh-clis/bin/codex`、`bin/claude`、`bin/qwen`，但 UI 仍显示「未安装」。当前 Client 已改为调用 Host `remote.cli.check()`，由 Host 使用和安装/执行相同的 `resolveDir()` + `fs.lstat(<dir>/bin/<cli>)` 判断；然而运行时仍未确认是否加载了该 Client 版本，或 `remote.cli.check()` 的实际返回 envelope 与 Client 读取路径是否一致。
- **后续排查顺序**：①确认当前 DSH 运行实例实际加载的 plugin/client bundle 版本；②直接读取运行时 `remote.cli.check()` 返回值（包括 `dir` 和每个 `installed`）；③核对 Host `CliService.check`、Typert remote Client binder 和 Client 解析 envelope；④再复测 `cli_test`，确认 aixforge 的真实失败原因能否落入设置记录。
- **本地验证范围**：源码语法检查通过，`plugin/test` 当前 62/62 通过；以上通过不等价于当前 DSH GUI 运行时已加载并验证成功。


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