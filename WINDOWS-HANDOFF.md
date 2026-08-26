# dsh-sub-cli Windows 验证转交文档

> **用途**：这是把 `dsh-sub-cli` 插件的 **Windows 侧实机验证与补充** 交给一台 Windows 机器（及该机器上的 AI Agent）的自包含转交文档。
> 机器上的 Agent **只需读取本文件即可开始，无需依赖任何父会话上下文**。当前开发主环境为 macOS，Windows 代码已按最佳实践实现但**未在 Windows 实机验证**。

---

## 0. 一句话说明

在 Windows 上把 `dsh-sub-cli` 插件安装进 DSH 桌面版，逐个运行并验证三个托管 CLI（Codex / Claude Code / Qwen Code）的“安装命令、版本检测、连接测试、删除”是否真正可用，并记录实测结果与差异，反馈给主仓库。

---

## 1. 背景

`dsh-sub-cli` 在 DeepSeek Harness（DSH）中统一管理并调用外部 Agent CLI，与系统原生安装隔离，交给 DSH 主控像子代理一样调用。当前支持：

- **Codex**（`@openai/codex`，配置隔离 `CODEX_HOME`）
- **Claude Code**（`@anthropic-ai/claude-code`，配置隔离 `CLAUDE_CONFIG_DIR`）
- **Qwen Code**（`@qwen-code/qwen-code`，配置隔离 `QWEN_HOME`）

安装采用“**复制命令，用户自己运行**”的方式（插件不后台下载），命令由插件生成，装进统一目录 `vendor/` + `bin/`，不污染系统。

---

## 2. 仓库与运行环境

- 仓库：`/Users/dmh2002/DshProject/dsh-sub-cli`（Windows 机器需先拿到该仓库或等价的 `plugin/` 目录）
- 插件入口：`plugin/`（npm 包根）
- DSH：DeepSeek Harness 桌面版，profile 名为 `desktop`
- 当前本机（macOS）测试状态：`plugin/test` 共 39 项，`node --test test/*.test.mjs` 全部通过

---

## 3. 当前已实现的 Windows 处理（供对照验证）

| 模块 | Windows 处理 | 验证重点 |
|---|---|---|
| `lib/paths.js` | `node:path`（`join`/`sep`）；`binName()` 在 win32 给 npm shim 追加 `.cmd`；`expandTilde` 兼容 `~\`；默认目录 `%USERPROFILE%\dsh-clis` | `binPath(dir, 'codex', 'win32')` 返回 `...\bin\codex.cmd` |
| `lib/status.js` | 用注入的 `exists` 回调（DSH `fs`）替代 `/bin/test`；版本探测走 `winShimArgv` | `detectInstalled` 能在 Windows 判断已装/版本 |
| `lib/dispatch.js` | `winShimArgv(resolved, argv, platform)`：把 `.cmd`/`.bat` 用 `cmd.exe /d /s /c` 包裹 | 无头派发能真正启动 `.cmd` |
| `lib/provider.js` | 复用 `winShimArgv`；`binPath` 自动带 `.cmd` | 子代理 Provider 能在 Windows spawn CLI 并返回输出 |
| `lib/install.js` | `installCommandOf` Windows 渲染 **PowerShell**（`$DIR`、`New-Item`、`Copy-Item` 复制 `.cmd` shim，避免需提权的符号链接） | 复制到 PowerShell 能一次执行成功 |
| `lib/manage.js` | `removeManagedCli` win32 分支：`cmd.exe /d /s /c del /f /q` | 删除只删统一目录托管 `.cmd`，不碰系统 |
| `lib/index.js` | `CliService` 的远程方法经 `@Remote` 标记暴露（`check/test/remove/installCommand`） | `api.cli.*` 在客户端可见 |

---

## 4. Windows 需实机验证的点（按优先级）

### A. 安装命令（最高优先，直接决定能否使用）

每个 CLI 在设置卡点“安装命令/更新命令”会返回一段 PowerShell 命令。请逐个复制到 **PowerShell** 运行，验证：

1. `New-Item -ItemType Directory -Force -Path "$DIR\vendor\<cli>"` 正常建目录；
2. `npm install --prefix "$DIR\vendor\<cli>" --no-save --no-audit --no-fund <pkg>` 成功；
3. `Copy-Item "$DIR\vendor\<cli>\node_modules\.bin\<cli>.cmd" "$DIR\bin\<cli>.cmd"` 成功复制 shim；
4. 运行后 `<unifiedDir>\bin\<cli>.cmd` 存在。

**三个包名**：`@openai/codex`、`@anthropic-ai/claude-code`、`@qwen-code/qwen-code`。

> 若 `npm install` 因网络/代理失败，记录错误并检查 npm 配置（代理、registry）。

### B. 版本检测

设置卡加载时会自动检测。需确认：

- 未安装 → 显示“未安装”；
- 装好后 → 显示灰色版本号（来自 `<bin>.cmd --version`）。
- 若 `status.detectInstalled` 的 `winShimArgv` 包裹正确，`cmd.exe /d /s /c <bin>.cmd --version` 能返回版本号。

### C. 连接测试

已安装的 CLI 点“测试”会跑一个真实最小任务（`Reply with exactly: DSH CLI connection OK`）。验证：

- `dispatch.winShimArgv` 用 `cmd.exe` 启动 `.cmd` 成功；
- CLI 输出正确回传（通过/失败提示）。

### D. 删除

点“删除”：

- 只删 `<unifiedDir>\bin\<cli>.cmd`；
- 不删 `config-<cli>/`，不清除模型配置；
- 不触碰系统安装。

### E. 子代理 Provider

调用 `cli_codex` / `cli_claude_code` / `cli_qwen` 工具，确认：

- 原生 DSH 子会话出现；
- 标题、状态、历史正常；
- 模型选择器**干净**（不应出现 “External CLI · codex/claude/qwen”）。

---

## 5. 运行测试（确认 Windows 分支）

在 `plugin/` 下：

```bash
node --test test/*.test.mjs
```

期望全部通过。Windows 分支（`winShimArgv`、`binName`、`installCommandOf("win32")`）通过注入 `platform` 参数在单元测试覆盖。

---

## 6. 预期结果与回报方式

请把实测结果记录为：

1. **每项（A–E）通过/失败/未测**；
2. 失败时的完整错误信息（PowerShell 报错、npm 报错、CLI stderr）；
3. 与文档预期不符的差异；
4. 若发现代码问题，给出**最小复现**与建议修复（不要直接改父仓库代码，除非在 Windows 机器上有独立分支）。

建议把结论追加到父仓库的 `WINDOWS-HANDOFF.md`（本文件）的“实测记录”章节，或作为新的 Markdown 反馈。

---

## 7. 明确不做的事

- 不往系统 PATH 安装；
- 不修改用户系统里的 CLI 配置（`~/.codex`、`~/.claude`、`~/.qwen`）；
- 不改变已确认的产品范围（只保留 Codex + Claude Code + Qwen Code）；
- 不把任何 CLI 注册成 LLM Provider（避免污染模型选择器）。

---

## 8. 关联文件

- 插件代码：`plugin/lib/{paths,status,dispatch,provider,install,manage,index,registry}.js`
- 设置界面：`plugin/lib/client.js`
- 产品/设计：`CLI-MANAGER-DESIGN.md`、`CLI-MANAGER-HANDOFF.md`
- 测试：`plugin/test/*.test.mjs`
