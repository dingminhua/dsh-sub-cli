# dsh-sub-cli 必须通过的端到端验证流程

三阶段全链路验证：**写入 → 读取核对 → 删除**，覆盖 relay 子代理、direct 会话两条主通道和三个外部 CLI（Codex / Claude Code / Qwen Code）。

任何一次插件改动（host 通道、驱动、权限映射、设置卡）合入前都必须重跑并全部通过。

---

## 前置条件（缺一即失败）

| # | 条件 | 为什么 | 检查方式 |
|---|---|---|---|
| 1 | 插件已挂载到 profile（`dsh.profile.bundles` 含 `dsh-sub-cli`） | 未挂载则工具不存在 | `cli_check` |
| 2 | 三个 CLI 已安装且在统一目录 | — | `cli_check` |
| 3 | 三个 CLI 的 `exec` 已勾选（`settings.yaml` → `dsh-sub-cli.permissions.*.exec`） | **删除是命令执行**；未勾选时 danger 档下不去，codex 的 rm 走审批缝被自动拒绝、claude 在 cwd 外写入/删除会挂起等审批 | 设置卡 / `settings.yaml` |
| 4 | 三个 CLI 的供应商有额度、且支持该 CLI 所需协议 | Codex 需 responses、Claude 需 anthropic、Qwen 需 openai-chat | `cli_test <cli>` |
| 5 | 宿主代码改动后已重启 DSH Desktop | host 侧 ESM 模块由宿主进程缓存，改磁盘不会热加载（只有 client bundle 刷新即可） | 改动的 `mtime` 早于进程启动时间 |

### 关于条件 4 的两个实测结论

- **Codex 的 `base_url` 必须带 `/v1`**：Codex 客户端把 `responses` 直接拼在 `base_url` 后面。供应商 baseURL 若写成 `https://host/`（不带 `/v1`），请求会打到 `https://host/responses` → nginx 返回 **405**，`cli_test` 表现为 `CLI 执行失败：Reading additional input from stdin...`（真正原因在 stdout 的 `unexpected status 405 ... url: https://host/responses`）。
- **Qwen 的写能力来自 settings.json 的 `tools.approvalMode`**：无头 `-p` 模式在默认 `auto` 档下**根本不注册 write_file / edit / run_shell_command**。映射由 `qwenSettings()` 写入：`read-only → plan`、`workspace-write → auto-edit`、`danger-full-access → yolo`。

---

## 阶段一：写入（relay 子代理 × 3，并行）

主控自行拟定三段**只有主控知道的暗号**（各 CLI 一段、互不相同），并行发起：

- `cli_codex_subagent`  → `<项目A>/test.md` ← 暗号-A
- `cli_claude_subagent` → `<项目B>/test.md` ← 暗号-B
- `cli_qwen_subagent`   → `<项目C>/test.md` ← 暗号-C

任务提示必须是自包含的：给出**绝对路径**、要求「UTF-8、无尾随换行、无其他内容」、允许覆盖、以 `OK` 收尾。

**通过标准**：三个子代理均回报 `OK`；磁盘上三个文件**逐字节**等于各自暗号（含长度与无尾随换行）。

## 阶段二：读取核对（direct 会话 × 3）

用 `cli_<cli>_direct` 各起一个持续会话，让**每个 CLI 读取全部三个文件**并逐字复述（3×3 = 9 次复述），主控交叉核对。

互读而非只读自己那个，是为了证明文件真实落在磁盘、且三个 CLI 都能读到同一份内容。

**通过标准**：9 次复述全部与暗号一致。

> 已知环境变量：aixforge 的 `deepseek-v4-flash` 会间歇把回答全部放进 `reasoning_content`、`content` 返回空，表现为模型复述被截断（实测出现过末字丢失）。这类**复述截断不是文件内容错误**——以磁盘字节校验为准；若要求复述也严格完整，给该 CLI 配 `autoContinue.max > 0` 让续接补完。

## 阶段三：删除（relay 子代理 × 3，并行）

三个子代理各自删除阶段一写入的文件（允许使用 shell 命令），并要求确认文件已不存在。

**通过标准**：三个文件全部消失，且未留下 `.bak` / `.orig` 等残留；主控独立复核。

---

## 实测记录（2026-09-02）

环境：DSH Desktop（profile desktop，插件以 `link:` 挂载本仓库）、codex 0.149.1 / claude 2.1.247 / qwen 0.22.2。

### 阶段一 写入

| CLI | 通道 | 结果 | 文件 |
|---|---|---|---|
| Codex | relay subagent | ✅ 28 字节，逐字节匹配（首次因供应商额度不足 403 失败，换路由后成功） | `dsh-brain-compaction/test.md` |
| Claude | relay subagent | ✅ 28 字节，逐字节匹配 | `dsh-session-surgeon/test.md` |
| Qwen | relay subagent | ✅ 28 字节，逐字节匹配 | `trae-solo-unlock/test.md` |

### 阶段二 读取核对

| CLI \ 文件 | brain-compaction | session-surgeon | trae-solo-unlock |
|---|---|---|---|
| Codex (direct) | ✅ | ✅ | ✅ |
| Claude (direct) | ✅ | ✅ | ✅ |
| Qwen (direct) | ✅ | ✅ | ⚠️ 复述截断（末字丢失；磁盘文件本身精确） |

### 阶段三 删除

| CLI | 通道 | 结果 |
|---|---|---|
| Codex | relay subagent | ✅ 删除 |
| Claude | relay subagent | ✅ 删除 |
| Qwen | relay subagent | ✅ 删除 |

**最终复核**：三个文件全部消失，无 `.bak` / `.orig` 残留。**流程通过。**

---

## 实测记录（第二轮，2026-09-02）

环境同首轮；codex 已切到 k3-baoyue/kimi-k3（zzztoken-glm 额度耗尽）。

### 阶段一 写入（新暗号，全部 25 字节逐字节匹配、无尾随换行）

| CLI | 通道 | 结果 |
|---|---|---|
| Codex | relay subagent | ✅ |
| Claude | relay subagent | ✅ |
| Qwen | relay subagent | ✅ |

### 阶段二 读取核对（3×3 互读）

| CLI \ 文件 | brain-compaction | session-surgeon | trae-solo-unlock |
|---|---|---|---|
| Codex (direct) | ✅（首轮会话复读返回幻觉内容，换新 direct 会话后精确） | ✅ | ✅ |
| Claude (direct) | ✅ | ✅ | ⚠️ 首轮复述截断末字（磁盘校验覆盖，Qwen 读出完整） |
| Qwen (direct) | ✅ | ✅ | ✅ |

复述偶发截断/幻觉是供应商模型输出的已知噪声（aixforge 空 content / 截断、kimi 复读幻觉），**以磁盘字节校验为准**。

### 阶段三 删除

| CLI | 通道 | 结果 |
|---|---|---|
| Codex | relay subagent | ✅ |
| Claude | relay subagent | ✅ |
| Qwen | relay subagent | ✅（经一次性授权临时开启 exec 后完成，随即还原） |

**最终复核**：三个文件全部消失，无残留。**流程通过。**

### 本轮关于「一次性授权」的设计结论

- 用户明确：CLI 需要授权时由主控**转发授权请求**，授权**一次性**，**不写入设置**。
- 技术现状：qwen/claude 的 stream-json 驱动**没有中途权限请求通道**（权限档启动前定死）；只有 codex 的 app-server 有。因此 qwen 在 exec 未勾选（workspace-write → auto-edit 档）时工具表**没有 `run_shell_command`**，删除物理上不可行，也不会发出可转发的请求。
- 本次执行方式（用户一次性授权后）：临时把 qwen `exec` 置 true（→ danger → yolo 工具表）→ 跑删除 → **随即还原 false**。settings.json 确认按权限档写入 `approvalMode: yolo`（qwen 修复的又一实证）。
- 待办（设计缺口）：为 qwen/claude 补「中途一次性授权」通道，或明确 qwen 命令类操作必须在 exec 勾选下进行。

## 本轮流程暴露并修复的问题

1. **Qwen 无头模式没有写工具**（`qwenSettings()` 未写 `tools.approvalMode`）→ 修复：按权限档写入 plan / auto-edit / yolo，并补单测（`plugin/test/verify.test.mjs`）。
2. **`testCli` 探测命令不带 model**（qwen 退回内置默认模型 → 假「认证失败」）→ 修复：传 `route.model` + 配置权限，探测真实路由。
3. **空回复锁死通道**（aixforge 间歇把回答放进 `reasoning_content`、`content` 为空）→ 修复：`testCli` 对「退出码 0 + 空回复」做有界重试（4 次），确定性失败仍快速失败。
4. **Codex `base_url` 缺 `/v1` 导致 405**（本轮新发现，已修）：`codexToml()` 直接写入供应商 baseURL，Codex 把 `responses` 拼在 bare host 后 → `https://host/responses` → nginx 405，且错误信息不直观（表面是 `CLI 执行失败：Reading additional input from stdin...`，真因在 stdout 的 405）。已改为经 `codexBaseUrl()` 归一化（复用 `stripTrailingV1` + `joinApiPath`，已有 `/v1` 的 base 不会被重复拼接），并补单测。

## 回归提示

- 单元测试：`npm test`（截至本轮 228/228 通过）。
- 每次改动 host 侧（`lib/**` 除 client 外）后**必须重启 DSH Desktop** 再跑本流程。
- 换供应商/模型后先跑 `cli_test <cli>` 三个都绿，再跑本流程。

---

## 设计变更：三个 CLI 权限管理统一（2026-09-02 第三轮修复）

### 变更动机

第二轮测试暴露的核心问题：**Codex 走 app-server 协议有中途授权通道，Claude Code / Qwen Code 走 stream-json 协议没有，权限在进程启动时就锁死**。这意味着三个 CLI 的"中途申请权限"体验不一致 — Codex 可以弹窗让用户临时授权，Claude/Qwen 必须提前把档位设到完全。

### 变更方案

**所有三个 CLI 启动时都用最高档**（CLI 内部不再拦截），**driver 层在解析 stream-json 的 `tool_use` / `app-server 的 protocol event` 时拦截，按 profile 检查 capability，调用统一的 `onPermissionRequest` 钩子**。钩子最终走 `managed-cli-agents.js#resolvePermission()` → `ctx.approval.request()` → GUI 弹窗。

### 代码变更

| 文件 | 变更 |
|---|---|
| `lib/permissions.js` | 新增 `CLAUDE_APPROVAL_METHODS` / `QWEN_APPROVAL_METHODS`（tool 名 → capability 映射）；新增 `normalizePermissionRequest(cli, method, params, context)` 统一三个 CLI 的 permission request normalizer；`permissionReason` 支持三个 CLI |
| `lib/drivers/claude-stream-json.js` | `interactivePermissions: true`；`claudePermissionMode` 始终 `bypassPermissions`；`runTurn` 解析 `assistant` 事件中的 `tool_use` 块，按 `claudeToolCapability` 判断是否需要权限，调 `onPermissionRequest` 钩子；rejected/cancelled 直接 `finish(false, error)` 终止 turn |
| `lib/drivers/qwen-stream-json.js` | 同上（Qwen 走 `tools.approvalMode: yolo`，driver 层统一拦截） |
| `lib/verify.js` | `qwenApprovalMode` 始终 `yolo`（不再按 tier 映射）；provider 配置里的 `tools.approvalMode` 固定 `yolo` |
| `lib/managed-cli-agents.js` | 无变更 — `resolvePermission` 链路已存在，dispatch/followup/reattach 三个入口都传 `onPermissionRequest` 钩子 |

### 用户视角的变化

| 场景 | 变更前 | 变更后 |
|---|---|---|
| Claude Code 用户在 `workspace-write` 档试图 Write 到工作目录外 | CLI 静默拒绝，driver 无法拦截 | driver 拦截，弹窗询问；通过则执行，拒绝则 turn 失败带明确原因 |
| Qwen Code 用户在 `read-only` 档试图 Write | 工具表里没有 `write_file`，无事件可拦截 | 工具存在但 driver 拦截，弹窗询问；通过则执行（即使档位是 read-only，profile 不允许则弹窗） |
| Codex 用户在 `read-only` 档试图 Bash | Codex app-server 发 protocol event，driver 拦截弹窗 | 不变 |

**关键不变量**：profile 的 checkbox 仍然是唯一静默放行的依据。三个 CLI 走同一条 `resolvePermission` 路径，问的也是同一个 GUI 弹窗。

### 待验证

- 重启 DSH Desktop 让 host 侧 ESM 加载新代码
- 跑端到端三阶段测试，三个 subagent 都能通过 `onPermissionRequest` 弹窗被授权后写文件
- 在 permission 档设为 `read-only` 时，Codex/Claude/Qwen 都应该弹窗（而不是直接失败）
