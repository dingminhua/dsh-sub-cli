# dsh-sub-cli Windows 验证转交文档

> **用途**：把 `dsh-sub-cli` 插件的 **Windows 侧实机验证与补充** 交给一台 Windows 机器（及该机器上的 AI Agent）的自包含转交文档。
> 机器上的 Agent **只需读取本文件即可开始，无需依赖任何父会话上下文**。当前开发主环境为 macOS，Windows 代码已按最佳实践实现但**未在 Windows 实机验证**。

---

## 0. 一句话说明

在 Windows 上把 `dsh-sub-cli` 插件装进 DSH 桌面版，用主控对话里的 AI 工具逐个验证三个托管 CLI（Codex / Claude Code / Qwen Code）的「安装、检测、连接测试、删除、目录迁移、调用干活」是否真正可用，并记录实测结果与差异，反馈给主仓库。

---

## 1. 产品定位（已确认）

`dsh-sub-cli` 在 DeepSeek Harness（DSH）里统一管理并调用外部 Agent CLI，与系统原生安装隔离，交给 DSH 主控像子代理一样调用。

**设置卡只做两件事**：
1. 选择**统一安装目录**（切换目录会同时移动该目录下所有插件托管内容）；
2. 为**每个 CLI 选择它要用的模型**（Provider / Model / Effort）。

**其余一切操作都通过对话引导主控 AI 完成**（主控在后台运行的工具）：

| 主控工具 | 用途 | 用户触发语（对人说） |
|---|---|---|
| `cli_install` | 安装官方 npm 包到统一目录，链接 bin | 帮我装 Codex |
| `cli_check` | 检测是否已装 + 版本 | 看看 Codex 装了没 |
| `cli_test` | 用该 CLI 配置的模型发请求，验证连通 | 测一下 Codex 的模型能回话吗 |
| `cli_remove` | 删除统一目录里的托管 CLI | 把 Qwen Code 卸载掉 |
| `cli_codex` / `cli_claude_code` / `cli_qwen` | 把任务交给该 CLI（子代理） | 用 Codex 看看项目 |
| `cli_dispatch` | 一次性无头执行自包含任务 | 让 Codex 无头跑这个任务 |

**验证记录**：`cli_install` / `cli_test` 成功后，会在设置里写入该 CLI 的「已通过验证」记录（`ok / version / at / provider / model`），设置卡据此显示绿色「已通过验证，版本 xxx · 日期」；无记录则「未安装」。

---

## 2. 仓库与运行环境

- 仓库：`/Users/dmh2002/DshProject/dsh-sub-cli`（Windows 机器需先拿到该仓库或等价的 `plugin/` 目录）
- 插件入口：`plugin/`（npm 包根）
- DSH：DeepSeek Harness 桌面版，profile 名为 `desktop`
- 当前本机（macOS）测试状态：`plugin/test` 共 **40** 项，`node --test test/*.test.mjs` 全部通过

---

## 3. 当前已实现的 Windows 处理（供对照验证）

| 模块 | Windows 处理 | 验证重点 |
|---|---|---|
| `lib/paths.js` | `node:path`（`join`/`sep`）；`binName(bin,'win32')` 追加 `.cmd`；`expandTilde` 兼容 `~\`；默认目录 `%USERPROFILE%\dsh-clis` | `binPath(dir,'codex','win32')` 返回 `...\bin\codex.cmd` |
| `lib/status.js` | 用注入的 `exists` 回调（DSH `fs`）替代 `/bin/test`；版本探测走 `winShimArgv` | `detectInstalled` 在 Windows 判断已装/版本 |
| `lib/dispatch.js` | `winShimArgv(resolved, argv, platform)`：`.cmd`/`.bat` 用 `cmd.exe /d /s /c` 包裹 | 无头派发能真正启动 `.cmd` |
| `lib/provider.js` | 复用 `winShimArgv`；`binPath` 自动带 `.cmd` | 子代理 Provider 在 Windows spawn CLI 并返回输出 |
| `lib/install.js` | `installCommandOf`(win32) 渲染 **PowerShell**；`installManagedCli`(win32) 用 `cmd.exe copy` 复制 `.cmd` shim 到 bin | Windows 下装官方 npm 包并让 bin 可执行 |
| `lib/manage.js` | `removeManagedCli` win32 分支：`cmd.exe /d /s /c del /f /q` | 删除只删统一目录 `.cmd`，不碰系统 |
| `lib/index.js` | `CliService` 远程方法 `@Remote` 标记；`cliDir` 变更自动迁移（`migrateDir`）：win32 用 `cmd.exe if not exist ... mkdir` + `cmd.exe move`；`cli_test`/`cli_install` 写 `verified` | 改目录后内容自动移到新目录；验证记录写入设置 |

---

## 4. Windows 需实机验证的点（按优先级）

### A. `cli_install`（装官方 npm 包到统一目录）
对主控说「帮我把 Codex 装上」。验证：
1. 是否在 `<统一目录>\bin` 生成可执行的 `.cmd`；
2. `npm install --prefix <统一目录>\vendor\<cli>` 用 Win 路径成功；
3. 安装后 `verified` 记录写入设置（`plugin` 设置卡显示「已通过验证」）；
4. 失败时返回的 npm 错误是否清晰。

> 也可手动在 PowerShell 跑 `installCommandOf` 生成的命令（`New-Item` + `npm install --prefix` + `Copy-Item .cmd`）。

### B. `cli_check`（检测是否已装 + 版本）
对主控说「看看 Codex 装了没」。验证：
- 未装 → `installed:false`；
- 已装 → 返回版本（`<bin>.cmd --version` 经 `cmd.exe /d /s /c`）；
- `status.detectInstalled` 的 `exists`（用 DSH `fs.lstat`）在 Windows 正确识别 `.cmd`。

### C. `cli_test`（模型连通）
对主控说「测一下 Codex 的模型能回话吗」。验证：
- 用该 CLI 配置的 `provider/model` 发请求；
- 回复含 `OK` 才判通过；写 `verified {ok,version,at,provider,model}`；
- 若未配置模型，返回明确错误。

### D. `cli_remove`（删除托管 CLI）
对主控说「把 Codex 卸载掉」。验证：
- 只删 `<统一目录>\bin\<cli>.cmd`；
- 不删 `config-<cli>/`、不清模型配置、不碰系统安装；
- 幂等（未装也返回已删除）。

### E. 目录迁移（改目录自动移动内容）
在设置卡把统一目录从 A 改成 B，点保存。验证：
- A 下的 `bin/`、`config-<cli>/`、`vendor/` 自动移动到 B；
- B 已有同名则不覆盖；
- 系统里用户自装的 CLI 配置不被动。

### F. 子代理 Provider
对主控说「用 Codex 看看这个项目」。验证：
- 原生 DSH 子会话出现、标题/状态/历史正常；
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

1. **每项（A–F）通过 / 失败 / 未测**；
2. 失败时的完整错误（PowerShell 报错、npm 报错、CLI stderr、DSH 日志）；
3. 与文档预期不符的差异；
4. 若发现代码问题，给出**最小复现**与建议修复（勿直接改父仓库代码，除非在 Windows 机器上有独立分支）。

建议把结论追加到父仓库 `WINDOWS-HANDOFF.md`（本文件）的“实测记录”章节，或作为新的 Markdown 反馈。

---

## 7. 明确不做的事

- 不往系统 PATH 安装；
- 不修改用户系统里的 CLI 配置（`%USERPROFILE%\.codex`、`%USERPROFILE%\.claude`、`%USERPROFILE%\.qwen`）；
- 不改变已确认的产品范围（只保留 Codex + Claude Code + Qwen Code）；
- 不把任何 CLI 注册成 LLM Provider（避免污染模型选择器）。

---

## 8. 关联文件

- 插件代码：`plugin/lib/{paths,status,dispatch,provider,install,manage,index,registry}.js`
- 设置界面：`plugin/lib/client.js`
- 产品/设计：`CLI-MANAGER-DESIGN.md`、`CLI-MANAGER-HANDOFF.md`
- 测试：`plugin/test/*.test.mjs`
