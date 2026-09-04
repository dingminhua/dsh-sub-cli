# Windows 端到端测试清单 — dsh-sub-cli 双 CLI 验证

> 适用于 Windows 10/11，由 Windows AI 执行。macOS 的等效验证参考 `plugin/VERIFICATION-FLOW.md` 三阶段（主控用 cli_* 工具直调；2026-09-04 起 standalone e2e 脚本已删除）。
>
> **Qwen Code 支持已于 2026-09 移除（实测可靠性不足）；托管 CLI 为 Codex 与 Claude Code 两家，本清单已按双 CLI 收敛。**
>
> **测试前先 `git pull`，确保测的是最新 main（≥ a46d576，含发现 9 的 guard 重锚定）。**

---

## 前置条件

1. **Node.js ≥ 20**（含 `node --test`）
2. **已安装两个 CLI**：
   ```
   codex   → %USERPROFILE%\dsh-clis\bin\codex.cmd
   claude  → %USERPROFILE%\dsh-clis\bin\claude.cmd
   ```
3. **已配置 DSH 凭据** `%USERPROFILE%\.dsh\.credentials.yaml`
4. **插件已启用**（`dsh-sub-cli` 目录在插件扫描路径内）

---

## 阶段 0：单元测试（必做，最先跑）

```powershell
cd dsh-sub-cli\plugin
npm install
npm test
```

**预期：231/231 全绿**（含 `winShimArgv` 的 .cmd shim 包装测试——Windows 特有逻辑的单测覆盖）。
任何红项直接停，不用往下测。

---

## 测试步骤

### 阶段 1：CLI 安装验证（必做）

每个 CLI 跑 `Reply with exactly: OK` 单次命令，验证：
- 二进制存在
- API key 注入正确
- 能连通上游

> 凭据以 `~/.dsh/settings.yaml` 里 `dsh-sub-cli.models.<cli>` 配的 provider/model 为准（macOS 侧当前：codex=k3-baoyue/kimi-k3、claude=aixforge/deepseek-v4-flash），不要照抄本文示例的旧模型名。

#### 1.1 Codex
```powershell
# 设置临时环境变量（不做持久化写入）
$env:CODEX_HOME = "$env:USERPROFILE\dsh-clis\config-codex"
# API key / base URL 按 settings.yaml 里所选 provider 填

# 验证
& "$env:USERPROFILE\dsh-clis\bin\codex.cmd" exec --json --skip-git-repo-check -m <provider的模型> "Reply with exactly: OK"

# 预期：stdout 包含 {"type":"result",..., "text":"OK"}，exit code 0
```

#### 1.2 Claude Code
```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\dsh-clis\config-claude"
# API key / base URL 按 settings.yaml 里所选 provider 填

& "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format text --model <provider的模型> "Reply with exactly: OK"

# 预期：stdout 包含 "OK"，exit code 0
```

**阶段 1 通过标准**：两个 CLI 都 exit 0 且输出含 "OK"。

---

### 阶段 2：交互式会话（两轮验证）

验证 CLI 能维持会话状态、followup 复用同一 session（Claude 的持续会话走 stream-json + `--resume` 文件级持久化；Codex 的持续会话由 app-server 长连接承载，在阶段 3 的插件集成里验证）。

#### 2.1 Claude Code 两轮会话

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\dsh-clis\config-claude"
# API key / base URL 按 settings.yaml 里所选 provider 填

# 第一轮
$out1 = & "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format stream-json --model <provider的模型> "Reply with exactly: OK"
Write-Host "Round 1: $out1"

# 提取 session id（从 stdout 找）
$sid = ($out1 | Select-String '"session_id":"([^"]+)"' | ForEach-Object { $_.Matches.Groups[1].Value } | Select-Object -First 1)
Write-Host "Session: $sid"

# 第二轮（用 --resume 挂回同一 session——driver 的 followup 契约）
$out2 = & "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format stream-json --resume $sid "Reply with exactly: OK"
Write-Host "Round 2: $out2"

# 预期：两轮都有成功 result，session id 相同
```

**阶段 2 通过标准**：Claude Code 的两轮都 exit 0，输出非空且 session id 一致。

---

### 阶段 3：插件集成（有 DSH 环境时，强烈建议）

#### 3a. 端到端三阶段（真实 driver + 真实 CLI；2026-09-04 起无 standalone 脚本）

按 `plugin/VERIFICATION-FLOW.md` 三阶段执行（写入 → 读取核对 → 删除），由主控用
`cli_codex_subagent` / `cli_claude_subagent`（写入/删除）与 `cli_<cli>_direct`（互读）
真实驱动。这是 Windows 上验证 `winShimArgv`（.cmd shim 的 argv 包装）与 driver spawn
行为最直接的一步（原 `npm run test:live` / `e2e-live.mjs` 已删除——直启 CLI 进程的
脚本会卡死进程；`winShimArgv` 的单测在 `plugin/test/dispatch.test.mjs` 持续覆盖）。

#### 3b. GUI 级验证（DSH Desktop for Windows）

按 `plugin/VERIFICATION-FLOW.md` 跑三阶段（写入→读取核对→删除 × 2 CLI），外加一项：

- **relay 子代理续用（reattach）**：`cli_<cli>_subagent` 起一个子代理跑完第一轮，等它
  空闲后再 `send_message` 发第二轮——两轮都应正常完成（这条链路在 1c74d0d 修复过，
  Windows 需要复验）。
- 纪律：每阶段等全部子代理 completion 再推进；一切以磁盘字节校验为准，CLI 自报不作数。

---

## 已知限制

1. **Codex**：需要 settings.yaml 里配置的有效 provider（当前 macOS 侧为 k3-baoyue/kimi-k3；Codex 客户端要求 base_url 带 `/v1`，且供应商须支持 responses 协议含工具续接）。若 provider 不支持会报 "Upstream rejected the request"。
2. **Windows 路径**：所有路径用 `%USERPROFILE%` 或 `$env:USERPROFILE`，避免空格问题。
3. **供应商噪声**：偶发空回复 / 复述截断取决于所配中转商，插件层有探测与有界重试兜底；e2e 判定以结构断言为准，不苛求每个字。

---

## 快速检查脚本

保存为 `test-clis.ps1` 一键运行：

```powershell
# === 参数配置（以 ~/.dsh/settings.yaml 的 dsh-sub-cli.models 为准） ===
$CODEX_MODEL = "kimi-k3"            # codex 当前 provider 模型
$CLAUDE_MODEL = "deepseek-v4-flash" # claude 当前 provider 模型

$env:AIXFORGE_API_KEY = "你实际的 API key"

$codex_ok = $false
$claude_ok = $false

# === Claude Code ===
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\dsh-clis\config-claude"
Write-Host "[1/2] Testing Claude Code..."
try {
    $r = & "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format text --model $CLAUDE_MODEL "Reply with exactly: OK" 2>&1
    if ($LASTEXITCODE -eq 0 -and ($r -match "OK")) { $claude_ok = $true; Write-Host "  PASS" }
    else { Write-Host "  FAIL: exit=$LASTEXITCODE output=$r" }
} catch { Write-Host "  FAIL: $_" }

# === Codex ===
$env:CODEX_HOME = "$env:USERPROFILE\dsh-clis\config-codex"
Write-Host "[2/2] Testing Codex..."
try {
    $r = & "$env:USERPROFILE\dsh-clis\bin\codex.cmd" exec --json --skip-git-repo-check -m $CODEX_MODEL "Reply with exactly: OK" 2>&1
    if ($LASTEXITCODE -eq 0 -and ($r -match "OK")) { $codex_ok = $true; Write-Host "  PASS" }
    else { Write-Host "  FAIL: exit=$LASTEXITCODE" }
} catch { Write-Host "  FAIL: $_" }

# === 汇总 ===
Write-Host ""
Write-Host "=== 结果汇总 ==="
Write-Host "Claude Code : $(if($claude_ok){'✅ PASS'}else{'❌ FAIL'})"
Write-Host "Codex      : $(if($codex_ok){'✅ PASS'}else{'❌ FAIL'})"
```

---

## 调试

若某 CLI 失败，检查：

| 症状 | 可能原因 |
|------|---------|
| exit 1，stderr "Missing API key" | 环境变量未正确注入（检查 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 指向与 config 内凭据） |
| exit 1，stderr "Upstream rejected the request" | Provider 不支持该模型名或所需协议（Codex 须支持 responses 含工具续接） |
| 挂起不返回 | 子进程的 stdin 未关闭；driver 层由 turn-timeout 探测兜底（静默 60 秒判卡死） |
