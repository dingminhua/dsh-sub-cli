# Windows 端到端测试清单 — dsh-sub-cli 三 CLI 验证

> 适用于 Windows 10/11，由 Windows AI 执行。macOS 的等效验证参考 `plugin/e2e-live.mjs`。

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

## 测试步骤

### 阶段 1：CLI 安装验证（必做）

每个 CLI 跑 `Reply with exactly: OK` 单次命令，验证：
- 二进制存在
- API key 注入正确
- 能连通上游

#### 1.1 Codex
```powershell
# 设置临时环境变量（不做持久化写入）
$env:CODEX_HOME = "$env:USERPROFILE\dsh-clis\config-codex"
$env:AIXFORGE_API_KEY = "你实际的 API key"
$env:AIXFORGE_BASE_URL = "你实际的 base URL"

# 验证
& "$env:USERPROFILE\dsh-clis\bin\codex.cmd" exec --json --skip-git-repo-check -m deepseek-v4-pro "Reply with exactly: OK"

# 预期：stdout 包含 {"type":"result",..., "text":"OK"}，exit code 0
```

#### 1.2 Claude Code
```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\dsh-clis\config-claude"
$env:ANTHROPIC_API_KEY = "你实际的 API key"
$env:ANTHROPIC_BASE_URL = "你实际的 base URL"

& "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format text --model deepseek-v4-flash "Reply with exactly: OK"

# 预期：stdout 包含 "OK"，exit code 0
```

#### 1.3 Qwen Code
```powershell
$env:QWEN_HOME = "$env:USERPROFILE\dsh-clis\config-qwen"
$env:AIXFORGE_API_KEY = "你实际的 API key"
$env:AIXFORGE_BASE_URL = "你实际的 base URL"

# 注意：Qwen 用 --prompt（无值）和 --output-format stream-json
& "$env:USERPROFILE\dsh-clis\bin\qwen.cmd" -p --output-format stream-json --model deepseek-v4-flash "Reply with exactly: OK"

# 预期：stdout 包含 NDJSON 行，其中 result 字段含 "OK"，exit code 0
# Qwen 输出是 NDJSON 格式（非单一 JSON）：每行一个 JSON 对象
# 关键事件：{"type":"system","subtype":"init",...}
#           {"type":"assistant",...}
#           {"type":"result","subtype":"success","result":"OK",...}
```

**阶段 1 通过标准**：三个 CLI 都 exit 0 且输出含 "OK"。

---

### 阶段 2：交互式会话（两轮验证）

验证 CLI 能维持会话状态、followup 复用同一 session。

#### 2.1 Claude Code 两轮会话

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\dsh-clis\config-claude"
$env:ANTHROPIC_API_KEY = "你实际的 API key"
$env:ANTHROPIC_BASE_URL = "你实际的 base URL"

# 第一轮
$out1 = & "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format stream-json --model deepseek-v4-flash "Reply with exactly: OK"
Write-Host "Round 1: $out1"

# 提取 session id（从 stdout 找）
$sid = ($out1 | Select-String '"session_id":"([^"]+)"' | ForEach-Object { $_.Matches.Groups[1].Value } | Select-Object -First 1)
Write-Host "Session: $sid"

# 第二轮（用同一 session）
$out2 = & "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format stream-json --session-id $sid "Reply with exactly: OK"
Write-Host "Round 2: $out2"

# 预期：两轮都有成功 result，session id 相同
```

#### 2.2 Qwen Code 两轮会话

```powershell
$env:QWEN_HOME = "$env:USERPROFILE\dsh-clis\config-qwen"
$env:AIXFORGE_API_KEY = "你实际的 API key"
$env:AIXFORGE_BASE_URL = "你实际的 base URL"

# 生成 session id
$sid = [guid]::NewGuid().ToString()

# 第一轮
$out1 = echo "Reply with exactly: OK" | & "$env:USERPROFILE\dsh-clis\bin\qwen.cmd" -p --output-format stream-json --session-id $sid --model deepseek-v4-flash
Write-Host "Round 1: $out1"

# 提取 Qwen 实际的 session id（用于 followup）
$qwen_sid = ($out1 -split "`n" | ForEach-Object { $_ | ConvertFrom-Json -EA SilentlyContinue } | Where-Object { $_.session_id } | Select-Object -First 1).session_id
Write-Host "Qwen session: $qwen_sid"

# 第二轮（用 Qwen 实际的 session id + --resume）
$out2 = echo "Second prompt" | & "$env:USERPROFILE\dsh-clis\bin\qwen.cmd" -p --output-format stream-json --resume $qwen_sid --model deepseek-v4-flash
Write-Host "Round 2: $out2"

# 预期：两轮都有成功 result
```

**阶段 2 通过标准**：两个 CLI 的两轮都 exit 0，输出非空。

---

### 阶段 3：插件集成（可选，有 DSH 环境时）

如果 Windows 上有完整的 DSH 环境，可以跑自动化测试：

```powershell
# 在 dsh-sub-cli/plugin 目录下
cd dsh-sub-cli\plugin
node --test e2e-live.mjs
```

预期结果（与 macOS 一致）：
- Claude Code：dispatch ✅ + followup ✅
- Qwen Code：dispatch ✅ + followup ✅
- Codex：取决于 `zzztoken-glm` provider 配置（`deepseek-v4-pro` 模型需在 provider 中可用）

---

## 已知限制

1. **Codex**：需要有效的 provider（`zzztoken-glm` 或其他 OpenAI-compatible provider）已配置 `deepseek-v4-pro` 模型。若 provider 不支持该模型名会报 "Upstream rejected the request"。
2. **Qwen**：session 文件存在 `%QWEN_HOME%\.qwen\` 目录；多次 followup 时 `--resume` 使用 Qwen 返回的真实 session id，而非 driver 生成的 id。
3. **Windows 路径**：所有路径用 `%USERPROFILE%` 或 `$env:USERPROFILE`，避免空格问题。

---

## 快速检查脚本

保存为 `test-clis.ps1` 一键运行：

```powershell
# === 参数配置 ===
$API_KEY = "你实际的 API key"
$BASE_URL = "你实际的 base URL（OpenAI-compatible）"

$env:AIXFORGE_API_KEY = $API_KEY
$env:AIXFORGE_BASE_URL = $BASE_URL

$codex_ok = $false
$claude_ok = $false
$qwen_ok = $false

# === Claude Code ===
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\dsh-clis\config-claude"
Write-Host "[1/3] Testing Claude Code..."
try {
    $r = & "$env:USERPROFILE\dsh-clis\bin\claude.cmd" -p --output-format text --model deepseek-v4-flash "Reply with exactly: OK" 2>&1
    if ($LASTEXITCODE -eq 0 -and ($r -match "OK")) { $claude_ok = $true; Write-Host "  PASS" }
    else { Write-Host "  FAIL: exit=$LASTEXITCODE output=$r" }
} catch { Write-Host "  FAIL: $_" }

# === Qwen Code ===
$env:QWEN_HOME = "$env:USERPROFILE\dsh-clis\config-qwen"
Write-Host "[2/3] Testing Qwen Code..."
try {
    $r = echo "Reply with exactly: OK" | & "$env:USERPROFILE\dsh-clis\bin\qwen.cmd" -p --output-format stream-json --model deepseek-v4-flash 2>&1
    if ($LASTEXITCODE -eq 0 -and ($r -match "OK")) { $qwen_ok = $true; Write-Host "  PASS" }
    else { Write-Host "  FAIL: exit=$LASTEXITCODE output=$r" }
} catch { Write-Host "  FAIL: $_" }

# === Codex ===
$env:CODEX_HOME = "$env:USERPROFILE\dsh-clis\config-codex"
Write-Host "[3/3] Testing Codex..."
try {
    $r = & "$env:USERPROFILE\dsh-clis\bin\codex.cmd" exec --json --skip-git-repo-check -m deepseek-v4-pro "Reply with exactly: OK" 2>&1
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
