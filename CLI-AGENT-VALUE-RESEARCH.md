# dsh-sub-cli：更高价值方向调研（2026-09-01）

> **背景**：功能已跑通（统一管理 Codex / Claude Code / Qwen Code，作为原生子代理被主控调用）。
> 本文档用于回答「在实际应用中，我们的功能能有什么更高的价值」，基于联网调研的同类赛道与生态趋势整理。
> 状态：**调研记录，待研究**。具体落地方向见文末「待研究清单」。
>
> 更新日期：2026-09-01
> 同类/参考：`CLI-AGENT-ROADMAP.md`、`CLI-AGENT-REFERENCE-RESEARCH.md`、`CLI-AGENT-FRAMEWORK-RESEARCH.md`

---

## 0. 一句话结论

外部 Agent CLI 生态正在从「**单工具使用**」走向「**多工具并行编排**」与「**互相充当子代理**」，并且**直接的进程内集成（direct integration）已成为主流**——这恰好是 dsh-sub-cli 的核心定位。我们最大的差异化优势是**与 DSH 原生机制深度绑定**（原生子代理、父子会话、权限、统一配置），而不是造一个全新的终端管理器。

---

## 1. 赛道全景：同类项目都在做什么

### 1.1 并行多 Agent 编排（ADE，Agentic Development Environment）

| 项目 | 定位 | 与我们的关系 |
|---|---|---|
| **Emdash**（[github](https://github.com/generalaction/emdash)、[emdash.ai](https://emdash.ai/)）| 开源 Agentic Development Environment（YC W26）。并行运行多个 CLI 编码 agent、调度、每个变体一个 PR（[PR #247 已合并](https://github.com/generalaction/emdash/pull/247)）| 偏「多 agent 并行开发工作台」，与我们的「主控统一编排」互补 |
| **Pane / RunPane**（[github](https://github.com/dcouple/Pane)、[runpane.com](https://runpane.com/)）| 终端优先、agent-agnostic 的 AI agent 管理器，mac/win/linux 全支持。**不替换任何 agent**，「能在终端里跑的就都能在 Pane 里跑」| 我们「隔离安装 + 配置路由」是它没有的；它「并行终端」是我们可以借鉴的 |
| **simple-agent-manager**（[github](https://github.com/raphaeltm/simple-agent-manager)）| 在自己的云 VM 上并行跑多个编码 agent | 云端并行，非本地 |
| **ai-parallel-dev**（[github](https://github.com/osaka2077/ai-parallel-dev)）| 并行跑多个 Claude Code agent 且无合并冲突 | 解决并行合并问题 |

### 1.2 互相充当子代理（Claude↔Codex 互调）

这是与我们**最直接相关**的赛道：

| 项目 | 定位 |
|---|---|
| **yejianfei/subagent-cli**（[github](https://github.com/yejianfei/subagent-cli)）| 通过 headless PTY 驱动 Claude Code、Codex 等 AI 编码终端，实现跨模型 AI-to-AI 协作 |
| **dwgx/claude-codex-subagent**（[github](https://github.com/dwgx/claude-codex-subagent)）| Claude Code skill，把范围化工作委派给本地 Codex CLI，**节省 Claude 的 token**（把 grunt work 交给便宜的 Codex）|
| **subcodex-mcp**（[github](https://github.com/G0d2i11a/subcodex-mcp)）| MCP server，让 Claude Code 用 Codex 当子代理，带 stall 检测 + 自动恢复 |
| **xuio/claude-code-codex-subagents**（[github](https://github.com/xuio/claude-code-codex-subagents)）| Claude Code 插件：Codex 子代理、并行 code review、长会话 daemon |
| **subagent-cli / otakumesi**（[github](https://github.com/otakumesi/subagent-cli)）| agent-client-protocol 方向，agent 编排 |

> **关键洞察**：上面这些几乎都是**单向**的（Claude 调 Codex，且通常是「让便宜/专用的模型干粗活」）。我们 dsh-sub-cli 是**任意 CLI 互相调用 + 由 DSH 主控统一编排**，方向更泛化。

### 1.3 已归档的「统一多 CLI」MCP

**Dokkabei97/all-agents-mcp**（[github](https://github.com/Dokkabei97/all-agents-mcp)、[glama](https://glama.ai/mcp/servers/Dokkabei97/all-agents-mcp)）——MCP server，统一 stdio 编排 Claude Code / Codex / Gemini CLI / Copilot CLI。**已归档**，作者在 README 明说：

> "As the AI agent CLI ecosystem has evolved, **direct integration has become the standard**."

**这直接印证了我们的定位**：与其包一层 MCP 或终端管理器，不如把外部 CLI **作为原生子代理深度集成进主控**——这正是 dsh-sub-cli 在做的事，也说明这个方向没有过时，反而随着生态成熟更被认可。

---

## 2. 更高价值的四大方向（按潜力排序）

### 方向 A：跨供应商模型/能力路由（风险对冲 + 成本优化）

- 用户现实：同时订阅/接入多个供应商（DeepSeek / Anthropic / OpenAI / 中转商），不同模型在不同任务上各有所长。
- 外部证据：
  - 模型路由已成为独立方向：[NVIDIA NeMo Switchyard](https://developer.nvidia.com/blog/route-ai-agent-workloads-across-models-with-nvidia-nemo-switchyard/)（按任务把 agent 路由到不同模型）、[Unblocked 模型路由分析](https://getunblocked.com/blog/model-routing-coding-agents/)（按复杂度派到最便宜可用模型）、[arxiv agent-as-a-router](https://arxiv.org/html/2606.22902v2)（Agentic model routing）。
  - 「分任务用不同 tier 模型」是明确的最佳实践：[Opus/Sonnet/Haiku per task](https://developertoolkit.ai/en/developer-scorecard-guide/model-routing/)。
- **我们已具备的基础**：每个 CLI 已支持「Provider → 模型 → 推理强度」三层路由 + 供应商验证指纹。可以进一步做：
  - **任务难度感知路由**：简单任务走便宜 CLI，复杂任务走贵 CLI；
  - **供应商故障转移**：一个供应商挂了自动切到另一个（已有 `failoverEnabled` 的雏形？）；
  - **同任务多模型仲裁/交叉验证**（A 做、B review）。

### 方向 B：并行多 CLI 编排 + Git worktree 隔离

- 现实瓶颈：单 agent 一次只做一件事，受墙钟时间限制。
- 外部证据：
  - Git worktree 已成并行 agent 开发的主流隔离原语：[Zylos Research 调研](https://zylos.ai/research/2026-02-22-git-worktree-parallel-ai-development/)、[DEV 并行 workflow 模式](https://dev.to/dublecc/parallel-ai-agent-workflows-with-git-worktrees-the-concrete-pattern-59lp)；
  - 真正的难点是**合并**，不是生成：[多 agent worktree 与串行 merge train](https://news.creeta.com/en/multi-agent-worktree-merge-train-2026/)、[sigbound](https://github.com/nandanadileep/sigbound)（并行跑 + 只合并能构建/通过测试的改动）、[Integration Guard](https://dev.to/evertonkozloski/integration-guard-safely-merging-parallel-concurrent-ai-agents-from-git-worktrees-into-main-4l7m)。
- **机会**：把「把任务拆给多个 CLI（Codex 写 A、Claude 写 B、Qwen 写 C）」从人肉编排升级为 **DSH 主控一键并行派发**，并用 worktree 隔离避免冲突。这会把我们的「单 CLI 子代理」提升为「多 CLI 并行舰队」。

### 方向 C：节省主控 token / 隔离上下文

- 核心卖点：把「会刷屏主控上下文」的粗活（搜索、抓取、跑测试、批量重构）委派给外部 CLI，主控只收结果摘要。
- 外部证据：`claude-codex-subagent` 的卖点就是「**Save Claude's tokens by delegating grunt work to cheaper Codex**」。
- **我们已天然具备**：外部 CLI 子代理在自己的上下文里干活，只回报摘要给主控。可以作为对外沟通的「用户价值主张」重点讲，也是可量化收益（token 成本对比）。

### 方向 D：统一配置 + 权限 + 审计 的企业级控制面

- 我们「与原生安装隔离、每 CLI 独立配置、统一权限审批、协议验证指纹」的组合，是 Emdash / Pane 这类纯终端管理器**没有**的。
- 外部证据：subcodex-mcp 专门做了「stall 检测 + 自动恢复」，说明**稳定性和可观测**是真实痛点。
- **机会**：把我们的控制面做成「团队/企业里统一管理多个 AI CLI 接入」的底座：谁用什么模型、什么权限、审计日志、供应商指纹验证。

---

## 3. 与我们现有实现的对齐检查

| 已有能力 | 对应更高价值方向 |
|---|---|
| 每 CLI Provider→模型→推理强度 三层路由 | 方向 A（模型路由） |
| 供应商验证指纹 + 失败记录 | 方向 A（故障转移 / 审计） |
| 统一目录隔离安装 + 配置隔离 | 方向 D（企业控制面） |
| 每 CLI 权限能力开关（读/写/命令/联网/审批） | 方向 D |
| 外部 CLI 子代理只回摘要、隔离上下文 | 方向 C（省 token） |
| Codex 会话式调用（持久 thread） | 方向 B（长任务并行候选） |

---

## 4. 待研究清单（后续深入）

1. **任务难度感知路由**：能不能让主控根据任务描述自动选「哪个 CLI + 哪个模型」？参考 arxiv agent-as-a-router 与 Unblocked 的做法，设计一个最小可用的 heuristic。
2. **供应商故障转移**：`failoverEnabled` 当前是否真的跨 CLI 生效？能否做成「主 CLI 挂了自动降级到备选 CLI」并保留会话连续性。
3. **并行派发 + worktree**：评估把「拆任务 → 并行派多个 CLI → worktree 隔离 → 合并」做成一个 DSH 工具/命令的可行性，以及如何与 DSH 原生子代理并行机制衔接。
4. **token 成本对比数据**：做一次「主控直接做 vs 委派外部 CLI」的 token/耗时实测，作为对外价值主张的量化证据。
5. **企业控制面**：梳理统一配置/权限/审计的现状，评估是否值得做成可复用的「团队接入底座」而非仅限本地单机。
6. **多模型仲裁**：同一任务 A 实现、B 用另一 CLI review，交叉验证结果——是否值得做一个工具。

---

## 5. 结论

- 赛道共识：**direct integration（进程内深度集成）已取代「包一层统一外壳」**——all-agents-mcp 归档即是明证。dsh-sub-cli 的「外部 CLI 作为原生子代理被主控调用」正好踩在主流上。
- 我们的护城河是 **DSH 原生绑定**（原生子代理、父子会话、权限审批、统一配置），这是纯终端管理器（Emdash / Pane）无法直接复制的。
- 最高价值的下一步，集中在**方向 A（模型/供应商路由）**与**方向 B（并行编排）**，两者都与「省 token、多供应商、多模型」这些真实用户痛点挂钩。
