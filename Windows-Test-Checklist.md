# Windows 端到端测试清单 — dsh-sub-cli 双 CLI 验证

> 适用于 Windows 10/11，由 Windows AI 执行。macOS 的等效验证参考 `plugin/VERIFICATION-FLOW.md` 三阶段（主控用 cli_* 工具直调；2026-09-04 起 standalone e2e 脚本已删除）。
>
> **测试前先 `git pull`，确保测的是最新 main（≥ b2fe1c4，含权限统一 + reattach 修复）。**

---

## 前置条件

1. **Node.js ≥ 20**（含 `node --test`）
2. **已安装三个 CLI**：
   ```
   codex   → %USERPROFILE%\dsh-clis\bin\codex.cmd
   claude  → %USERPROFILE%\dsh-clis\bin\claude.cmd
   qwen    → %USERPROFILE%\dsh-clis\bin\qwen.cmd
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

**预期：234/234 全绿**（含 `winShimArgv` 的 .cmd shim 包装测试——Windows 特有逻辑的单测覆盖）。
任何红项直接停，不用往下测。

---

## 测试步骤

### 阶段 1：CLI 安装验证（必做）

每个 CLI 跑 `Reply with exactly: OK` 单次命令，验证：
- 二进制存在
- API key 注入正确
- 能连通上游

> 凭据以 `~/.dsh/settings.yaml` 里 `dsh-sub-cli.models.<cli>` 配的 provider/model 为准（macOS 侧当前：codex=k3-baoyue/kimi-k3、claude/qwen=aixforge/deepseek-v4-flash），不要照抄本文示例的旧模型名。

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

#### 1.3 Qwen Code
```powershell
$env:QWEN_HOME = "$env:USERPROFILE\dsh-clis\config-qwen"
# API key / base URL 按 settings.yaml 里所选 provider 填

# ⚠️ Qwen 的 prompt 不能作为位置参数（会报 unknown argument）：
#   --prompt 是无值标志，启用 stdin 输入模式；文本经 stdin 写入
"Reply with exactly: OK" | & "$env:USERPROFILE\dsh-clis\bin\qwen.cmd" -p --output-format stream-json --prompt --model <provider的模型>

# 预期：stdout 为 stream-json，result 字段含 "OK"，exit code 0
# （driver 实测契约：--prompt 无值 + stdin；macOS 六轮 E2E 均按此跑通）
```

**阶段 1 通过标准**：三个 CLI 都 exit 0 且输出含 "OK"。

---

### 阶段 2：交互式会话（两轮验证）

验证 CLI 能维持会话状态、followup 复用同一 session。

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

#### 2.2 Qwen Code 两轮会话

```powershell
$env:QWEN_HOME = "$env:USERPROFILE\dsh-clis\config-qwen"
# API key / base URL 按 settings.yaml 里所选 provider 填

# 生成 session id
$sid = [guid]::NewGuid().ToString()

# 第一轮（--prompt 无值标志 + stdin 传文本）
$out1 = "Reply with exactly: OK" | & "$env:USERPROFILE\dsh-clis\bin\qwen.cmd" -p --output-format stream-json --prompt --session-id $sid --model <provider的模型>
Write-Host "Round 1: $out1"

# 提取 Qwen 实际的 session id（用于 followup）
$qwen_sid = ($out1 -split "`n" | ForEach-Object { $_ | ConvertFrom-Json -EA SilentlyContinue } | Where-Object { $_.session_id } | Select-Object -First 1).session_id
Write-Host "Qwen session: $qwen_sid"

# 第二轮（用 Qwen 实际的 session id + --resume，同样 --prompt + stdin）
$out2 = "Second prompt" | & "$env:USERPROFILE\dsh-clis\bin\qwen.cmd" -p --output-format stream-json --prompt --resume $qwen_sid --model <provider的模型>
Write-Host "Round 2: $out2"

# 预期：两轮都有成功 result
```

**阶段 2 通过标准**：两个 CLI 的两轮都 exit 0，输出非空。

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
2. **Qwen**：session 文件存在 `%QWEN_HOME%\.qwen\` 目录；多次 followup 时 `--resume` 使用 Qwen 返回的真实 session id，而非 driver 生成的 id。
3. **Windows 路径**：所有路径用 `%USERPROFILE%` 或 `$env:USERPROFILE`，避免空格问题。
4. **供应商噪声**：偶发空回复 / 复述截断取决于所配中转商，插件层有探测与有界重试兜底；e2e 判定以结构断言为准，不苛求每个字。

---

## 快速检查脚本

保存为 `test-clis.ps1` 一键运行：

```powershell
# === 参数配置（以 ~/.dsh/settings.yaml 的 dsh-sub-cli.models 为准） ===
$CODEX_MODEL = "kimi-k3"            # codex 当前 provider 模型
$CLAUDE_MODEL = "deepseek-v4-flash" # claude 当前 provider 模型
$QWEN_MODEL = "deepseek-v4-flash"   # qwen 当前 provider 模型

$env:AIXFORGE_API_KEY = "你实际的 API key"

$codex_ok = $false
$claude_ok = $false
$qwen_ok = $false

# === Claude Code ===
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\dsh-clis\config-claude"
Write-Host "[1/3] Testing Claude Code..."
try {
    $r = & "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format text --model $CLAUDE_MODEL "Reply with exactly: OK" 2>&1
    if ($LASTEXITCODE -eq 0 -and ($r -match "OK")) { $claude_ok = $true; Write-Host "  PASS" }
    else { Write-Host "  FAIL: exit=$LASTEXITCODE output=$r" }
} catch { Write-Host "  FAIL: $_" }

# === Qwen Code ===
$env:QWEN_HOME = "$env:USERPROFILE\dsh-clis\config-qwen"
Write-Host "[2/3] Testing Qwen Code..."
try {
    $r = "Reply with exactly: OK" | & "$env:USERPROFILE\dsh-clis\bin\qwen.cmd" -p --output-format stream-json --prompt --model $QWEN_MODEL 2>&1
    if ($LASTEXITCODE -eq 0 -and ($r -match "OK")) { $qwen_ok = $true; Write-Host "  PASS" }
    else { Write-Host "  FAIL: exit=$LASTEXITCODE output=$r" }
} catch { Write-Host "  FAIL: $_" }

# === Codex ===
$env:CODEX_HOME = "$env:USERPROFILE\dsh-clis\config-codex"
Write-Host "[3/3] Testing Codex..."
try {
    $r = & "$env:USERPROFILE\dsh-clis\bin\codex.cmd" exec --json --skip-git-repo-check -m $CODEX_MODEL "Reply with exactly: OK" 2>&1
    if ($LASTEXITCODE -eq 0 -and ($r -match "OK")) { $codex_ok = $true; Write-Host "  PASS" }
    else { Write-Host "  FAIL: exit=$LASTEXITCODE" }
} catch { Write-Host "  FAIL: $_" }

# === 汇总 ===
Write-Host ""
Write-Host "=== 结果汇总 ==="
Write-Host "Claude Code : $(if($claude_ok){'✅ PASS'}else{'❌ FAIL'})"
Write-Host "Qwen Code  : $(if($qwen_ok){'✅ PASS'}else{'❌ FAIL'})"
Write-Host "Codex      : $(if($codex_ok){'✅ PASS'}else{'❌ FAIL'})"
```

---

## 调试

若某 CLI 失败，检查：

| 症状 | 可能原因 |
|------|---------|
| exit 1，stderr "No input provided via stdin" | Qwen 缺 `--prompt` flag |
| exit 1，stderr "Unknown argument: cwd" | Qwen 被传了 `--cwd`，应移除 |
| exit 1，stderr "Missing API key" | 环境变量未正确注入（检查 `QWEN_HOME` 等路径） |
| exit 1，stderr "Upstream rejected the request" | Provider 不支持该模型名 |
| 挂起不返回 | stdin 未关闭（Qwen 需要 `stdin.end()` 才能知道 prompt 写完） |
