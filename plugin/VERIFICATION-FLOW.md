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

## 实测记录（第四轮，2026-09-02，host 重启加载 9d0da41 后）

环境：DSH Desktop **重启后**（进程 19:03 起，晚于 lib 改动 17:23–17:28，host 侧确认加载最新 driver 层拦截代码）；codex 0.149.1 / claude 2.1.247 / qwen 0.22.2；权限档保持不变（codex write/exec=true；claude write=true/exec=false；qwen write=false/exec=false）。

本轮验证重点：**driver 层 tool_use/protocol 拦截 + 统一 onPermissionRequest 门控**在真实端到端下的表现（勾选=静默放行、未勾选=弹窗而非旧式静默失败）。

### 阶段一 写入（新暗号，全部 30 字节逐字节匹配、无尾随换行）

| CLI | 通道 | 结果 |
|---|---|---|
| Codex | relay subagent | ✅ 30B 逐字节匹配（write=true 静默放行） |
| Claude | relay subagent | ✅ 30B 逐字节匹配（write=true 静默放行） |
| Qwen | relay subagent | ✅ 30B 逐字节匹配（write=false 下仍写成功 —— driver 弹窗门控起效，未静默失败） |

### 阶段二 读取核对（3×3 互读，全部一字不差）

| CLI \ 文件 | codex-proj | claude-proj | qwen-proj |
|---|---|---|---|
| Codex (direct) | ✅ | ✅ | ✅ |
| Claude (direct) | ✅ | ✅ | ✅ |
| Qwen (direct) | ✅ | ✅ | ✅ |

本轮无复述截断/幻觉（3×3 = 9 次全部一致）。

### 阶段三 删除

| CLI | 通道 | 结果 |
|---|---|---|
| Codex | relay subagent | ✅ 删除 |
| Claude | relay subagent | ✅ 删除（exec=false 下仍删成功，driver 门控起效） |
| Qwen | relay subagent | ✅ 删除（exec=false 下仍删成功，driver 门控起效） |

**最终复核**：三个文件全部消失，无 `.bak`/`.orig`/临时残留；测试脚手架已清理。**流程通过。**

### 本轮结论

- host 重启后 driver 层拦截（9d0da41）在真实端到端下工作正常：勾选的能力静默放行，**未勾选的能力在 claude/qwen 的 stream-json 通道也能经 onPermissionRequest 弹窗授权后执行**（不再是旧版"工具表里没有 / 直接失败"，也不是第三轮的全锁死）。
- 三 CLI 的 Settings permissions 仍是旧的不一致档位；要继续验证"未勾选能力 → 弹窗（而非直接失败）"，本轮已覆盖 write(未勾选) 与 exec(未勾选) 两类场景，均弹窗授权成功。

## 回归提示

- 单元测试：`npm test`（截至第五轮 234/234 通过）。
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

---

## 实测记录（第五轮，2026-09-02，发现并修复 reattach bug）

环境：与第四轮同一 host 进程（19:03 起）；settings 权限三 CLI 一致 `read=true / write=false / exec=false`；暗号长度各异（22B / 26B / 20B）以强化截断检测。

### 结果

| 阶段 | Codex | Claude | Qwen |
|---|---|---|---|
| 写入（relay × 3） | ✅ 22B 逐字节一致 | ✅ 26B 逐字节一致 | ⚠️ 首写自报 OK 但磁盘插空格（`key@`→`key @`，21B）；换全新 subagent 重写后 20B 精确 |
| 读取（direct × 3，3×3 互读） | ✅ | ✅ | ✅（首轮 9/9 一字不差，无截断幻觉） |
| 删除（relay × 3） | ✅ | ✅ | ❓ 数据点无效（见发现 3） |

### 发现 1：relay 子代理第二条消息必挂（代码 bug，本轮已修复）

`send_message` 续用一个已空闲（released）的 relay 子代理时，链路是 `followup → reattach → driver.start({attachOnly:true})`，该请求**不带 prompt**；而 Claude/Qwen stream-json driver 的 `start()` → `#prepareContext()` 无条件校验 `request.prompt` 非空 → 抛 `…request.prompt must not be empty`。Codex 的 app-server `start()` 有 `if (request.attachOnly)` 特判所以从无此问题。前四轮从未对空闲 relay 子代理发过第二条消息，故从未触发。

**修复**（对齐 codex-app-server.js 的形状）：两个 stream-json driver 的 `start()` 增加 attachOnly 分支——attach 时不校验 prompt、不 spawn 进程（一进程一 turn 模型下 attach 无事可做），只准备上下文（解析 bin、写供应商配置）并返回 `result` 已 settle 的 run；`#prepareContext` 在 attach 模式下改为校验 `resumeThreadId`，并把 `ctx.actualSessionId` 指向它，使后续 followup 的 `--resume` 用对线程。补 6 个单测（每 driver 3 个：attach 无 prompt 不抛错且不 spawn、缺 resumeThreadId 拒绝、attach 后 followup 正确 resume），**234/234 全绿**。

### 发现 2：Qwen 首写内容噪声 + 自检虚报（模型层，代码不可修）

Qwen（aixforge deepseek-v4-flash）首写生成的 Write 参数里插了空格，且其自检声称「逐字节一致」——生成与自检两层都不可信。防线就是本流程的磁盘逐字节校验（xxd/cmp），本轮实测有效抓出。

### 发现 3：删除数据点无效——编排竞态（主控责任，非 Qwen 失败）

阶段一 Qwen 重写子代理的 turn 在磁盘写对后**仍未结束**（其 completion 通知最后才到）；主控只看磁盘就推进了阶段三，该写 turn 在删除窗口内 19:41:01 把逐字节正确的暗号又写回磁盘。决定性证据：删除任务提示不含暗号内容，只有写 turn 写得出正确暗号。rm 是否真成功不可考，该数据点作废，需干净重测。

### 流程纪律（本轮新增）

1. **阶段推进必须等全部子代理的 completion 通知**，不能只看磁盘状态——否则上一阶段的迟到写入会污染下一阶段的判定。
2. Qwen 的自报（含其自检输出）不可信，一切以主控磁盘校验为准。

### 待办

- ~~重启 DSH Desktop 加载本修复后，重跑一次干净三阶段（补 Qwen 删除的有效数据点）。~~ → 第六轮已完成
- ~~复测 relay 子代理 `send_message` 续用（reattach 路径）在三个 CLI 上都正常工作。~~ → 第六轮已完成

---

## 实测记录（第七轮，2026-09-02 晚，Windows 全新环境冷装）

环境：Windows（DSH Desktop profile desktop，本机首次冷装）；codex 0.152.1 / claude 2.1.258 / qwen 0.22.3（均由 `dsh plugin add` 后首次安装）；路由三 CLI 统一 zzztoken-ds / deepseek-v4-flash；权限临时升 danger（write/exec 全勾，验证后已还原 `permissions: {}`）。

本轮背景是**全新机器冷装**（非既有环境回归），暴露并修复了一个默认部署必现缺陷：

### 本轮新发现：宿主 fs 沙箱默认 workspace-write 锁死 qwen 全通道

- **现象**：`cli_test` codex/qwen 均报 `cannot write ... config-<cli>...: file access denied under workspace-write mode`（claude 因从不写盘幸免）。
- **根因**（两层叠加）：① 插件的 fs 调用不带 session 上下文 → `sandboxPolicy.resolve()` 回落部署默认 `DSH_PERMISSION_MODE ?? "workspace-write"`（未设）；② `ensureCliProviderConfig` 对 qwen **无条件重写** settings.json——即使盘上内容已正确也写，于是默认沙箱部署下必挂。codex 有指纹门短路（盘上指纹=当前指纹则跳过）所以只影响 qwen。
- **修复**（`f9ca22e`）：qwen 增加「内容一致」短路（盘上文件与 `qwenSettings()` 渲染逐字节相同则跳过重写；qwen 配置整体托管、无用户字段可保留，故门取内容而非指纹）；`readGateFingerprint` 重构到共用 `readTextIfAny`。单测 244/244（+3：内容一致不写 / 内容不同重写 / 文件缺失重建）。
- **验证方式**：本会话内用插件自己的渲染函数预写正确配置（codex 带指纹门、qwen 待修复加载后走内容门）→ codex `cli_test` 立即转绿。qwen 的补验**待 host 重启加载 `f9ca22e` 后**执行。
- **遗留设计缺口**（记录在案）：`cli_install` / 首次 `cli_test` 仍需写统一目录，在默认沙箱部署下会被拒——插件进程侧的写（fs 服务）没有对应的沙箱白名单。当前工作流：由主控在 danger 档会话里用宿主命令预写/预装（本轮实测可行），或用户以 danger 档运行一次 `cli_test`。长期方案需宿主侧为统一目录提供写许可（如 profile 级配置），超出本插件边界。

### 阶段一 写入（暗号 19B / 20B / 18B；qwen 首写 relay，重建用 direct 通道）

| CLI | 通道 | 结果 |
|---|---|---|
| Codex | relay subagent（首写）/ qwen direct（重建） | ✅ 19B 逐字节匹配、无尾随换行 |
| Claude | relay subagent（首写）/ claude direct（重建） | ✅ 20B 逐字节匹配、无尾随换行 |
| Qwen | relay subagent | ✅ 18B 逐字节匹配、无尾随换行 |

### 阶段二 读取核对（direct 会话 × 3，完整 3×3 互读）

| 会话 \ 文件 | codex/test.md | claude/test.md | qwen/test.md |
|---|---|---|---|
| Codex (direct) | ✅ | ✅ | ✅ |
| Claude (direct) | ✅ | ✅ | ✅ |
| Qwen (direct) | ✅ | ✅ | ✅ |

9/9 复述一字不差（本轮无复述截断/幻觉噪声；Claude 回复带一句前置说明，复述行本身精确）。

### 阶段三 删除（relay 子代理 × 3）

| CLI | 通道 | 结果 |
|---|---|---|
| Codex | relay subagent | ✅ 磁盘确认消失 |
| Claude | relay subagent | ✅ 磁盘确认消失 |
| Qwen | relay subagent | ✅ 磁盘确认消失 |

**最终复核**：verification/ 目录全空、无 `.bak`/`.orig` 残留、脚手架已清理、权限已还原。

### qwen 补验阶段又发现并修复两个缺陷（`b010bde`）

host 重启加载 `f9ca22e` 后，qwen 首跑不再报写拒绝，但暴露出**「内容一致」字节门的两个后继缺陷**：

1. **qwen 启动即迁移自身 settings.json**（实证：盘上文件 mtime = 首次 `cli_test` 时刻，内容从 `selectedAuthType` 变为 `security.auth.selectedType` + `$version: 4`）→ 字节门首跑必破，之后每次 dispatch 都撞沙箱写拒绝。修复：字节门升级为**语义门** `qwenSettingsCurrent()`——只比对插件拥有的字段（openai 路由条目 model/envKey/baseUrl、`tools.approvalMode: yolo`、auth 类型兼容新旧两种位形），qwen 自己的 `$version` / `security` 等字段不碰。
2. **read-only 档 argv 追加 `--sandbox` 在无 docker 的机器上静默死亡**：`--sandbox` shell 出去依赖 docker/podman，本机（Windows）无 docker → qwen 退出码 0、空回复，`cli_test` 表现为"未返回预期的 OK（实际：空）"且无从定位。修复：模板移除 `--sandbox` 分支——权限执行本就是 driver 层的职责（yolo 启动 + tool_use 拦截），探测/一次性路径的 launch 形态必须与 driver 通道一致；registry 单测与 e2e 断言同步更新。

单测 246/246（+5）。host 第二次重启（04:02:42，晚于 `b010bde` 提交 04:02:07）后 `cli_test qwen` 三绿：语义门过、OK 回复、chat 工具续接探测通过。

### 结论

- **三 CLI × 三阶段全部干净通过**（冷装新版本 codex 0.152.1 / claude 2.1.258 / qwen 0.22.3；写入通道覆盖 relay subagent 与 direct 两种）。
- 冷装实测共修复三个默认部署必现缺陷（qwen 无条件重写 × 默认 workspace-write 沙箱 / 字节门对自迁移配置失效 / `--sandbox` 依赖 docker 静默死亡），全部有单测锁定。
- 权限纪律再验证：只读档下 claude direct 的 Write 被驱动层正确弹窗拦截（callId 拒绝），升档后静默放行——三档模型在真实端到端下行为符合预期。

---

## 实测记录（第六轮，2026-09-02 深夜，host 22:42 重启加载 1c74d0d 后）

环境：DSH Desktop 重启（进程 22:42:17 起，晚于 lib 改动 22:16–22:17）；权限三 CLI 一致 `read=true / write=false / exec=false`。第五轮两项待办全部闭环。

### 验证 A：reattach 修复（relay 子代理 send_message 续用）

三个 relay 子代理跑完第一轮（纯回声任务，无磁盘副作用）进入空闲、会话 release 后，发第二条消息——修复前必炸的路径：

| CLI | 第二轮结果 |
|---|---|
| Claude | ✅ `ROUND2-REATTACH-OK` |
| Qwen | ✅ `ROUND2-REATTACH-OK`（第五轮连炸 4 次的通道） |
| Codex | ✅ turn 干净完成、零 driver 错误（输出为 kimi-k3 读到工作区源码的措辞噪声，非通道故障） |

### 验证 B：干净三阶段（严格执行"等全部 completion 再推进"）

| 阶段 | Codex | Claude | Qwen |
|---|---|---|---|
| 写入（relay × 3，新暗号 23B/25B/22B） | ✅ 逐字节一致 | ✅ 逐字节一致 | ✅ **首写即逐字节精确** |
| 读取（direct × 3，3×3 互读） | ✅ | ✅ | ✅ 首轮 9/9 一字不差 |
| 删除（relay × 3） | ✅ 磁盘确认消失 | ✅ 磁盘确认消失 | ✅ **磁盘确认消失**（有效数据点补上） |

每阶段等齐全部 completion 通知后才推进；最终复核三文件消失、无残留、脚手架清理干净。

### 结论

- **第五轮三发现全部闭环**：reattach bug 修复并实测验证；Qwen 删除疑点排除（干净重测下真实生效，此前系编排竞态）；Qwen 首写噪声本轮未复现（首写即精确），维持"磁盘校验为准"纪律。
- **read 权限语义核查**（用户提问触发）：读取不产生权限事件（driver 层只读工具直接放行，`toolCapability` 返回 null 的工具不触发 `onPermissionRequest`；Codex 仅 command/fileChange/permissions 三类发请求）；三档 preset read 恒 true；UI 为单一三档下拉，用户无法取消 read——「读取默认权限、无需申请」与实现一致。仅手改 `settings.yaml` 可出现 `read:false`，此时读操作仍放行（无运行时强制点），README/RELEASING 已注明。
- **发布就绪核对**：`npm pack --dry-run` 干净（36 文件 / 123KB，无测试与凭据混入）；README 权限描述、CHANGELOG（补齐三能力收敛 / driver 统一拦截 / reattach 修复三条目）、RELEASING 现状说明已对齐实际行为；单测 234/234。
- 流程提醒（编排层）：Codex（kimi-k3）做回声类任务会被工作区源码带偏，措辞直接说「回复这个词」而非「让外部 CLI」；阶段推进等全部 completion 的纪律持续有效。
