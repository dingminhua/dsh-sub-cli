// dsh-sub-cli Client — a collapsible plugin card in Settings → Plugins, plus a
// session-header SubCLI catalog. Configures the unified dir and a per-CLI
// three-layer model route (provider → model → reasoning effort), persisting to
// the `dsh-sub-cli` settings section via settingsScope.

window.__ModuleLoader__.load({
  id: "dsh-sub-cli",
  factory: function (require) {
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var Button = primitives.Button;

    // GitHub 仓库（插件设置卡底部“鼓励一下”链接目标）。
    var DSC_GITHUB_URL = "https://github.com/dingminhua/dsh-sub-cli";

    // The reference plugin embeds its logo as a data URI. Keep the same
    // approach so the icon survives DSH's client bundle loader and does not
    // depend on a relative asset URL.
    var DSC_ICON = "data:image/png;base64,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";

    // ── CSS ──────────────────────────────────────────────────────────────
    var SETTINGS_CSS = ".dsc-card{display:grid;gap:12px;margin:18px 0;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,#1c1d21);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:12px}.dsc-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}.dsc-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsc-grand{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.dsc-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsc-input{width:100%;height:32px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;box-sizing:border-box}.dsc-select{width:100%;height:32px;padding:0 28px 0 9px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit}.dsc-select:focus{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:1px}.dsc-route{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;align-items:end;padding:8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}.dsc-cli{margin-top:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px}.dsc-cli-title-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}.dsc-cli-test-hint{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsc-cli-test-hint-error{color:#ef4444}.dsc-cli-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:wrap}.dsc-cli-actions button{min-height:24px!important;height:24px!important;padding:0 7px!important;font-size:11px!important;line-height:22px!important}.dsc-cli-notice{margin:-2px 0 6px;font-size:11px;color:#2ed084;text-align:right}.dsc-cli-notice-error{color:#ef4444}.dsc-install-cmd{margin:0 0 8px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529)}.dsc-install-cmd-pre{margin:0 0 6px;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,#1c1d21);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary,#e6e6e6)}.dsc-guide{margin-top:0;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}.dsc-guide-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);margin-bottom:8px}.dsc-guide-row{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary,#b8b8b8);flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,#36373b)}.dsc-guide-row:last-child{border-bottom:0}.dsc-guide-row code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#232529);padding:0 4px;border-radius:4px}.dsc-guide-ex{display:block;width:100%;color:var(--dsw-alias-label-tertiary,#999);margin-top:1px}.dsc-verified{font-size:11px;line-height:20px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}.dsc-verified-ok{color:var(--dsw-alias-label-success,#4ea77a)}.dsc-cli-install{font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary,#b8b8b8);white-space:nowrap}.dsc-cli-status{font:inherit;line-height:inherit;color:inherit}.dsc-conn-ok{color:var(--dsw-alias-label-success,#4ea77a)}.dsc-conn-fail{color:#ef4444}.dsc-dir-head{display:flex;align-items:baseline;gap:8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}.dsc-dir-note{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsc-model-hint{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);margin-top:6px;text-align:center}@media(max-width:760px){.dsc-cli-title-row{align-items:flex-start}.dsc-cli-actions{max-width:58%}}.dsc-cli-head{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);margin-bottom:6px}.dsc-cli-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;padding:0 6px;border-radius:10px}.dsc-cli-badge-ok{background:rgba(46,208,130,0.15);color:#2ed084}.dsc-cli-badge-bad{background:rgba(242,90,90,0.15);color:#ef4444}.dsc-cli-ver{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}.dsc-footer{border-top:1px solid var(--dsw-alias-border-l2,#36373b);display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 0 0}.dsc-footer-left{display:flex;align-items:center;gap:10px;min-width:0;margin-right:auto}.dsc-cheer{display:inline-flex;align-items:center;gap:4px;flex:none;text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5;transition:color .16s}.dsc-cheer-star{font-size:12px;line-height:1;display:inline-flex}.dsc-cheer:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}.dsc-cheer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}.dsc-footer-status{min-width:0;color:var(--dsw-alias-label-secondary,#b8b8b8);font-size:12px;line-height:1.5}.dsc-footer-error{flex:1;min-width:0;color:var(--dsw-alias-label-error,#ef4444);font-size:12px;line-height:1.5}.dsc-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}.dsm-btn:disabled{opacity:.4;cursor:default}.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777);background:rgba(255,255,255,.04)}.dsm-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}.dsm-btn-primary:hover:not(:disabled){opacity:.9}.dsm-plugin-card-body .dsc-card{margin:0;padding:12px 0 0;background:transparent;border:0;border-radius:0}.dsm-plugin-card-body .dsc-card .dsc-title{display:none}.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;display:inline-flex;transition:transform .16s}.dsm-plugin-card-chevron-open{transform:rotate(180deg)}.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}";

    // Fine-grained permission controls styles (appended to the main sheet).
    var PERM_CSS = ".dsc-perm-block{margin-top:6px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,#36373b);display:grid;gap:8px;grid-column:1/-1}.dsc-perm-toggles{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}.dsc-perm-tier{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#b8b8b8);white-space:nowrap;flex:none}.dsc-perm-tier select{width:auto;min-width:110px;height:28px;padding:0 24px 0 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;box-sizing:border-box}.dsc-perm-tier select:focus{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:1px}.dsc-ac-block{position:relative;width:100%;min-width:0;box-sizing:border-box;margin-top:6px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,#36373b);display:grid;gap:8px;grid-column:1/-1}.dsc-ac-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;flex-wrap:wrap}.dsc-ac-max{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#b8b8b8);white-space:nowrap;flex:none}.dsc-ac-max select{width:64px;height:28px;padding:0 24px 0 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;box-sizing:border-box}.dsc-ac-max select:focus{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:1px}.dsc-ac-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.4;min-width:0;overflow-wrap:break-word;word-break:break-word}";

    if (typeof document !== "undefined") {
      var cssId = "dsh-sub-cli/client.css";
      var cssText = SETTINGS_CSS + PERM_CSS;
      var existingStyle = document.querySelector("style[data-plugin-css='" + cssId + "']");
      if (existingStyle) {
        // HMR 重载模块时旧 <style> 仍留在 head；每次都覆写文本，确保 CSS 改动
        // 即时生效，而不是只在一开始注入一次（旧逻辑导致“改了 CSS 但页面不变”）。
        existingStyle.textContent = cssText;
      } else {
        var styleTag = document.createElement("style");
        styleTag.dataset.plugin = "dsh-sub-cli";
        styleTag.dataset.pluginCss = cssId;
        styleTag.textContent = cssText;
        document.head.appendChild(styleTag);
      }
    }

    // ── locale ───────────────────────────────────────────────────────────
    var NS = "settings.dshSubCli";
    var ZH = {
      "row.title": "外部 Agent CLI 管理器（dsh-sub-cli）",
      "row.desc": "统一管理并调用外部 Agent CLI，与用户原生安装完全隔离，可为每个 CLI 预设 Provider、模型、推理强度和权限，并让它们可直接或像原生子代理一样被主控调用。",
      "row.dir": "CLI 统一目录",
      "row.dirPlaceholder": "~/dsh-clis",
      "row.provider": "推理 Provider",
      "row.model": "模型",
      "row.effort": "推理强度",
      "row.permission": "权限",
      "row.permHint": "只读＝只能看；可执行＝能跑命令、写/删文件、装依赖。",
      "row.autoContinueMax": "最多续接次数（0=关闭）",
      "row.autoContinueHint": "回答看起来提前收尾（只描述计划未交付结果）时，自动在同一会话续接追问直到完整；设为 0 则不续接。三个 CLI 的持续会话调用均生效。",
      "row.turnTimeout": "轮次超时",
      "row.turnTimeoutUnit": "分钟",
      "row.turnTimeoutHint": "多久没有任何输出才开始怀疑卡死：到点先探测（进程还在吗、还有事件吗），仍在推进就继续等、每个活跃窗口自动续期，连续静默超过 60 秒才判定卡死。慢而健康的长任务不会被误杀。",
      "row.inherit": "（继承）",
      "row.save": "保存",
      "row.saving": "保存中…",
      "row.discard": "放弃修改",
      "row.cheer": "鼓励一下",
      "row.saved": "已保存",
      "row.browse": "浏览",
      "row.hint": "CLI 统一目录，切换目录将同时移动目录内所有内容。",
      "row.modelHint": "选择不同CLI所需要的模型，其他看说明，交给AI帮你完成即可。",
      "row.toastSaved": "dsh-sub-cli 设置已保存。",
      "row.notInstalled": "未安装",
      "row.connNotTested": "已安装·未测试",
      "row.connPassed": "测试通过",
      "row.connFailed": "测试失败",
      "row.guideInstall": "{cli} 未安装，对话中输入：装好并测一下 {cli}",
      "row.guideNotTested": "{cli} 已安装未测试，对话中输入：测一下 {cli} 的模型能回话吗",
      "row.guideFailed": "{cli} 测试失败，请先在模型下拉中更换 Provider，再对话输入：重新测一下 {cli}",
      "row.guidePassed": "{cli} 测试通过，可直接说：用 {cli} 处理这个任务",
      "row.verified": "已通过验证，版本",
      "row.failed": "未通过验证",
      "row.connectionTest": "测试",
      "row.testingConnection": "测试中…",
      "row.copyInstall": "安装命令",
      "row.copyUpdate": "更新命令",
      "row.copy": "复制",
      "row.copied": "已复制到剪贴板",
      "row.copyFailed": "复制失败，请手动选择复制",
      "row.remove": "删除",
      "row.removing": "删除中…",
      "row.testPassed": "连接测试通过",
      "row.removePassed": "已删除",
      "guide.title": "主控可调用的 CLI 工具",
      "guide.example": "你对主控说：",
      "guide.install": "安装托管 CLI",
      "guide.installEx": "帮我把 Claude Code 装上。",
      "guide.check": "检测是否已装 / 版本",
      "guide.checkEx": "看看 Codex 装了没？",
      "guide.test": "验证模型连通",
      "guide.testEx": "测一下 Claude Code 的模型能回话吗？",
      "guide.remove": "卸载托管 CLI",
      "guide.removeEx": "把 Claude Code 卸载掉。",
      "guide.direct": "直连会话（Codex / Claude 均有）",
      "guide.directEx": "用 Codex 直连看看这个项目。",
      "guide.subagent": "代理子代理；并行调度多个 CLI 用这个",
      "guide.subagentEx": "用 Claude Code 代理重构这段；用 Codex 代理跑这组测试。",
      "guide.dispatch": "通用无头执行",
      "guide.dispatchEx": "让 Codex 无头跑这个任务。"
    };
    var EN = {
      "row.title": "External Agent CLI manager (dsh-sub-cli)",
      "row.desc": "Unified management and invocation of external Agent CLIs, fully isolated from the user's native installs; preset Provider, model, reasoning effort, and permissions per CLI, callable directly or like native subagents.",
      "row.dir": "Unified CLI directory",
      "row.dirPlaceholder": "~/dsh-clis",
      "row.provider": "Provider",
      "row.model": "Model",
      "row.effort": "Reasoning effort",
      "row.permission": "Permission",
      "row.permHint": "Read-only = look only; Executable = run commands, write/delete files, install deps.",
      "row.autoContinueMax": "Max nudges (0 = off)",
      "row.autoContinueHint": "When an answer looks like a premature stop (plans only, no deliverable), nudges the same conversation until it is complete; 0 disables nudging. Applies to session-based calls of all three CLIs.",
      "row.turnTimeout": "Turn timeout",
      "row.turnTimeoutUnit": "min",
      "row.turnTimeoutHint": "How long without any output before a turn is suspected stuck: at the deadline the driver probes (process alive? events flowing?), keeps waiting while it progresses and renews every active window, and only declares it stuck after 60s of continuous silence. Slow-but-healthy long tasks are not killed.",
      "row.inherit": "(inherit)",
      "row.save": "Save",
      "row.saving": "Saving…",
      "row.discard": "Discard",
      "row.cheer": "Star on GitHub",
      "row.saved": "Saved",
      "row.browse": "Browse",
      "row.hint": "Unified CLI directory; changing it moves all content inside.",
      "row.modelHint": "Pick the model each CLI needs; for everything else, follow the notes / let the AI handle it.",
      "row.toastSaved": "dsh-sub-cli settings saved.",
      "row.notInstalled": "Not installed",
      "row.connNotTested": "Installed, not tested",
      "row.connPassed": "Test passed",
      "row.connFailed": "Test failed",
      "row.guideInstall": "{cli} is not installed. In chat say: install and test {cli}",
      "row.guideNotTested": "{cli} is installed but not tested. In chat say: test {cli}'s model",
      "row.guideFailed": "{cli} test failed. Change the Provider in the selects, then in chat say: retest {cli}",
      "row.guidePassed": "{cli} passed. Just say: use {cli} for this task",
      "row.verified": "Verified, version",
      "row.failed": "Not verified",
      "row.connectionTest": "Test",
      "row.testingConnection": "Testing…",
      "row.copyInstall": "Install command",
      "row.copyUpdate": "Update command",
      "row.copy": "Copy",
      "row.copied": "Copied to clipboard",
      "row.copyFailed": "Copy failed; select and copy manually",
      "row.remove": "Remove",
      "row.removing": "Removing…",
      "row.testPassed": "Connection test passed",
      "row.removePassed": "Removed",
      "guide.title": "Controller-callable CLI tools",
      "guide.example": "You say:",
      "guide.install": "Install managed CLI",
      "guide.installEx": "Install Claude Code for me.",
      "guide.check": "Installed / version check",
      "guide.checkEx": "Is Codex installed?",
      "guide.test": "Verify model connectivity",
      "guide.testEx": "Can the model configured for Claude Code reply?",
      "guide.remove": "Uninstall managed CLI",
      "guide.removeEx": "Uninstall Claude Code.",
      "guide.direct": "Direct session (Codex / Claude alike)",
      "guide.directEx": "Use Codex direct to inspect this project.",
      "guide.subagent": "Proxy subagent; use it to run several CLIs in parallel",
      "guide.subagentEx": "Have the Claude Code proxy refactor this; have Codex run the tests.",
      "guide.dispatch": "Generic headless run",
      "guide.dispatchEx": "Have Codex run this task headlessly."
    };

    // Permission tiers shown as ONE mutually-exclusive dropdown (2026-09
    // simplification: the middle "writable" tier is gone — it was the murkiest
    // of the three; see the round-12 finding in VERIFICATION-FLOW). Stored
    // values stay profile-shaped ({read,write,exec}) for the host.
    var PERMISSION_PRESETS = [
      { id: "read-only", label: "只读", profile: { read: true, write: false, exec: false } },
      { id: "danger-full-access", label: "可执行", profile: { read: true, write: true, exec: true } }
    ];
    // Profile → tier id: any mutation capability (write or exec) selects the
    // executable tier; otherwise read-only.
    function presetIdOf(permission) {
      if (permission && (permission.exec || permission.write)) return "danger-full-access";
      return "read-only";
    }
    // Ungranted capabilities simply stop the task and report not-completable.
    // The approval mode was removed (2026-09): there is no ask/deny toggle —
    // the tier is decided at launch and cannot widen mid-turn.
    var DEFAULT_PERMISSION = "read-only";
    var DEFAULT_PROFILE = { read: true, write: false, exec: false };

    // Normalize a stored permission (legacy string tier or profile object) into
    // a complete profile for the UI. Mirrors the host's normalizePermission:
    // the removed workspace-write tier and any mutation capability normalize
    // to the executable tier (widening, never silently tightening).
    function autoContinueMaxOf(raw) {
      var cfg = raw || {};
      var enabled = cfg.enabled !== undefined ? !!cfg.enabled : true;
      if (!enabled) return 0;
      var max = cfg.max;
      return typeof max === "number" && max >= 0 && max <= 10 ? Math.round(max) : 3;
    }

    function normalizePermissionClient(raw) {
      if (typeof raw === "string") {
        if (raw === "read-only") return { read: true, write: false, exec: false };
        if (raw === "workspace-write" || raw === "danger-full-access") return { read: true, write: true, exec: true };
        return { read: true, write: false, exec: false };
      }
      var p = raw || {};
      // Any mutation capability → executable tier; otherwise read-only.
      if (p.write === true || p.exec === true || p.network === true) return { read: true, write: true, exec: true };
      return {
        read: p.read !== undefined ? !!p.read : DEFAULT_PROFILE.read,
        write: false,
        exec: false
      };
    }

    // The permission surface is a single tier dropdown (只读 / 可执行);
    // read is granted in every tier, and exec carries egress intent —
    // there is no separate network toggle. Web research is never delegated to
    // a CLI (capability gate refuses it; the controller researches).
    var CLIS = [
      { id: "codex", name: "Codex", npm: "@openai/codex", bin: "codex", testHint: "测试将验证该供应商是否支持 responses 协议（Codex 所需，含工具续接）" },
      { id: "claude", name: "Claude Code", npm: "@anthropic-ai/claude-code", bin: "claude", testHint: "测试将验证该供应商是否支持 Anthropic Messages 协议（含 tool_use 续接）" },
    ];
    var SETTINGS_NS = "dsh-sub-cli";

    // Version-display standard. A `--version` line may carry noise (e.g.
    // "2.1.247 (Claude Code)" or "codex-cli 0.149.1") and is stored raw by the
    // host. For the settings card we only ever show the bare version number, so
    // strip trailing parenthetical notes and any "WARNING:" prefix. Returns "".
    function cleanVersion(raw) {
      if (typeof raw !== "string") return "";
      var v = raw.trim().split("\n")[0] || "";
      v = v.replace(/^WARNING:[^\n]*/i, "").trim();
      v = v.replace(/\s*\([^)]*\)\s*$/, "").trim();
      return v;
    }

    function normalizePermissions(raw) {
      var out = {};
      var keys = Object.keys(raw || {});
      for (var i = 0; i < keys.length; i++) out[keys[i]] = normalizePermissionClient(raw[keys[i]]);
      return out;
    }

    function normalize(value) {
      return {
        cliDir: (value && value.cliDir) || "",
        models: (value && value.models) || {},
        permissions: normalizePermissions((value && value.permissions) || {}),
        verified: (value && value.verified) || {},
        autoContinue: (value && value.autoContinue) || {},
        turnTimeoutMinutes: (value && value.turnTimeoutMinutes) || {}
      };
    }

    function useSettingsScopeSnapshot(scope) {
      var snap = React.useState(scope.getSnapshot());
      React.useEffect(function () {
        function update() { snap[1](scope.getSnapshot()); }
        return scope.subscribe(update);
      }, [scope]);
      return snap[0];
    }

    function persist(scope, value) {
      return Promise.resolve().then(function () { return scope.set("cliDir", value.cliDir || ""); }).then(function () {
        return scope.set("models", value.models || {});
      }).then(function () {
        return scope.set("permissions", value.permissions || {});
      }).then(function () {
        return scope.set("autoContinue", value.autoContinue || {});
      }).then(function () {
        // Without this write the per-CLI turn timeout resets to the default
        // (20 min) on every reload — the UI payload had it, persistence dropped it.
        return scope.set("turnTimeoutMinutes", value.turnTimeoutMinutes || {});
      });
    }

    // Convert an external CLI / stale-verification failure message into unified
    // Simplified Chinese at display time. Old persisted failure records may
    // still hold English text (written before localization); convert them on
    // render so the card never shows a non-Chinese failure. Already-Chinese
    // messages pass through untouched (no double prefix).
    function localizeError(cliName, message) {
      var raw = typeof message === "string" ? message.trim() : String(message || "").trim();
      if (!raw) return "CLI 执行失败，但未返回具体原因。";
      if (/[\u4e00-\u9fff]/.test(raw)) return raw; // 已是简体中文，原样返回
      if (/not logged in|please run \/login/i.test(raw)) return cliName + " 尚未登录。请先在插件隔离配置中完成登录认证。";
      if (/no auth type is selected|configure an auth type|--auth-type/i.test(raw)) return cliName + " 尚未配置认证方式。请先为该 CLI 选择并配置认证类型。";
      if (/unauthorized|authentication|invalid api key|api key|\b401\b|\b403\b|forbidden/i.test(raw)) return cliName + " 认证/授权失败。请检查当前供应商的 API Key 或登录状态。";
      if (/not supported|unsupported|does not support/i.test(raw)) return cliName + " 当前供应商不支持所需的协议或功能。请更换支持该协议的供应商（Codex 可试 modelflare）。";
      if (/could not connect|connection (failed|refused)|ecoconn|timeout|timed ?out|network error|tunnel|econnrefused|socket hang/i.test(raw)) return cliName + " 无法连接到供应商服务。请检查网络、代理或 baseURL 配置。";
      return "CLI 执行失败：" + raw;
    }

    function RouteSelects(props) {
      var t = props.t;
      var groups = props.groups;
      var route = props.route || {};
      var permission = normalizePermissionClient(props.permission);
      var group = null;
      for (var i = 0; i < groups.length; i++) if (groups[i].id === route.provider) { group = groups[i]; break; }
      var models = group ? (group.models || []) : [];
      var modelObj = null;
      for (var j = 0; j < models.length; j++) if (models[j].id === route.model) { modelObj = models[j]; break; }
      var efforts = modelObj && modelObj.reasoning && modelObj.reasoning.efforts ? modelObj.reasoning.efforts : [];
      return React.createElement("div", { className: "dsc-route" },
        React.createElement("label", { className: "dsc-field" }, t("row.provider"),
          React.createElement("select", { className: "dsc-select", value: route.provider || "", onChange: function (e) { props.onChange({ provider: e.target.value, model: "", reasoningEffort: "" }); } },
            React.createElement("option", { value: "" }, t("row.inherit")),
            groups.map(function (g) { return React.createElement("option", { key: g.id, value: g.id }, g.name + " (" + g.id + ")"); })
          )
        ),
        React.createElement("label", { className: "dsc-field" }, t("row.model"),
          React.createElement("select", { className: "dsc-select", value: route.model || "", disabled: !route.provider, onChange: function (e) { props.onChange({ provider: route.provider, model: e.target.value, reasoningEffort: "" }); } },
            React.createElement("option", { value: "" }, t("row.inherit")),
            models.map(function (m) { return React.createElement("option", { key: m.id, value: m.id }, m.name || m.id); })
          )
        ),
        React.createElement("label", { className: "dsc-field" }, t("row.effort"),
          React.createElement("select", { className: "dsc-select", value: route.reasoningEffort || "", disabled: !route.model, onChange: function (e) { props.onChange({ provider: route.provider, model: route.model, reasoningEffort: e.target.value }); } },
            React.createElement("option", { value: "" }, "（默认）"),
            efforts.map(function (e2) { return React.createElement("option", { key: e2.id, value: e2.id }, e2.name || e2.id); })
          )
        ),
        React.createElement("div", { className: "dsc-perm-block", style: { gridColumn: "1 / -1" } },
          React.createElement("div", { className: "dsc-perm-toggles" },
            // One mutually-exclusive tier dropdown: 只读 ⊆ 可写 ⊆ 可调用工具.
            // The selected preset's full profile is written on change. The
            // tier is fixed at launch: an ungranted capability stops the task.
            React.createElement("label", { className: "dsc-perm-tier" }, t("row.permission"),
              React.createElement("select", { value: presetIdOf(permission), onChange: function (e) {
                var chosen = null;
                for (var pi = 0; pi < PERMISSION_PRESETS.length; pi++) if (PERMISSION_PRESETS[pi].id === e.target.value) { chosen = PERMISSION_PRESETS[pi].profile; break; }
                if (chosen) props.onPermissionChange({ read: chosen.read, write: chosen.write, exec: chosen.exec });
              } },
                PERMISSION_PRESETS.map(function (p) { return React.createElement("option", { key: p.id, value: p.id }, p.label); })
              )
            ),
          ),
        ),
        React.createElement("div", { className: "dsc-ac-block" },
          React.createElement("div", { className: "dsc-ac-row" },
            React.createElement("label", { className: "dsc-ac-max" }, t("row.autoContinueMax"),
              React.createElement("select", { value: autoContinueMaxOf(props.autoContinue), onChange: function (e) { props.onAutoContinueChange({ enabled: Number(e.target.value) !== 0, max: Number(e.target.value) }); } },
                React.createElement("option", { value: 0 }, "0"),
                React.createElement("option", { value: 1 }, "1"),
                React.createElement("option", { value: 2 }, "2"),
                React.createElement("option", { value: 3 }, "3"),
                React.createElement("option", { value: 4 }, "4"),
                React.createElement("option", { value: 5 }, "5"),
                React.createElement("option", { value: 6 }, "6"),
                React.createElement("option", { value: 7 }, "7"),
                React.createElement("option", { value: 8 }, "8"),
                React.createElement("option", { value: 9 }, "9"),
                React.createElement("option", { value: 10 }, "10")
              )
            )
          ),
          React.createElement("div", { className: "dsc-ac-hint" }, t("row.autoContinueHint"))
        ),
        React.createElement("div", { className: "dsc-ac-block" },
          React.createElement("div", { className: "dsc-ac-row" },
            React.createElement("label", { className: "dsc-ac-max" }, t("row.turnTimeout"),
              React.createElement("select", { value: props.turnTimeoutMinutes || 5, onChange: function (e) { props.onTurnTimeoutChange(Number(e.target.value)); } },
                React.createElement("option", { value: 3 }, "3"),
                React.createElement("option", { value: 5 }, "5"),
                React.createElement("option", { value: 10 }, "10")
              ),
              React.createElement("span", { className: "dsc-ac-unit" }, t("row.turnTimeoutUnit"))
            )
          ),
          React.createElement("div", { className: "dsc-ac-hint" }, t("row.turnTimeoutHint"))
        )
      );
    }

    function SetupRow(props) {
      var t = props.t;
      var snap = useSettingsScopeSnapshot(props.settingsScope);
      var value = (snap && snap.status === "ready" && snap.value) || {};
      var dirState = React.useState(normalize(value).cliDir);
      var modelsState = React.useState(normalize(value).models);
      var permissionsState = React.useState(normalize(value).permissions);
      var verifiedState = React.useState(normalize(value).verified);
      var autoContinueState = React.useState(normalize(value).autoContinue);
      var turnTimeoutState = React.useState(normalize(value).turnTimeoutMinutes);
      var groupsState = React.useState([]);
      var dirtyState = React.useState(false);
      var busyState = React.useState(false);
      var savedState = React.useState(false);
      React.useEffect(function () {
        var alive = true;
        // `loadCatalog` is injected by apply(); guard it so a missing seat can
        // never throw inside the effect and take the whole Plugins tab down.
        if (typeof props.loadCatalog !== "function") return;
        props.loadCatalog().then(function (groups) { if (alive) groupsState[1](groups || []); }).catch(function () {});
        return function () { alive = false; };
      }, []);
      React.useEffect(function () {
        if (dirtyState[0] || busyState[0]) return;
        dirState[1](normalize(value).cliDir);
        modelsState[1](normalize(value).models);
        permissionsState[1](normalize(value).permissions);
        verifiedState[1](normalize(value).verified);
        autoContinueState[1](normalize(value).autoContinue);
        turnTimeoutState[1](normalize(value).turnTimeoutMinutes);
        savedState[1](false);
      }, [snap ? snap.revision : -1, dirtyState[0], busyState[0]]);
      function updateRoute(id, route) {
        modelsState[1](function (prev) {
          var next = Object.assign({}, prev || {});
          next[id] = route;
          return next;
        });
        savedState[1](false);
        dirtyState[1](true);
      }
      function updatePermission(id, permission) {
        permissionsState[1](function (prev) {
          var next = Object.assign({}, prev || {});
          next[id] = permission;
          return next;
        });
        savedState[1](false);
        dirtyState[1](true);
      }
      function updateAutoContinue(id, cfg) {
        autoContinueState[1](function (prev) {
          var next = Object.assign({}, prev || {});
          next[id] = cfg;
          return next;
        });
        savedState[1](false);
        dirtyState[1](true);
      }
      function updateTurnTimeout(id, minutes) {
        turnTimeoutState[1](function (prev) {
          var next = Object.assign({}, prev || {});
          next[id] = minutes;
          return next;
        });
        savedState[1](false);
        dirtyState[1](true);
      }
      function save() {
        if (!snap || snap.status !== "ready" || snap.writable === false || busyState[0]) return;
        var payload = { cliDir: dirState[0], models: modelsState[0], permissions: permissionsState[0], autoContinue: autoContinueState[0], turnTimeoutMinutes: turnTimeoutState[0] };
        busyState[1](true);
        persist(props.settingsScope, payload).then(function () {
          busyState[1](false);
          dirtyState[1](false);
          savedState[1](true);
        }).catch(function () { busyState[1](false); });
      }
      function discard() {
        dirState[1](normalize(value).cliDir);
        modelsState[1](normalize(value).models);
        permissionsState[1](normalize(value).permissions);
        autoContinueState[1](normalize(value).autoContinue);
        turnTimeoutState[1](normalize(value).turnTimeoutMinutes);
        dirtyState[1](false);
        savedState[1](false);
      }
      var browse = function () {
        if (typeof props.pickDirectory === "function") {
          Promise.resolve(props.pickDirectory()).then(function (p) { if (p) { dirState[1](p); dirtyState[1](true); savedState[1](false); } }).catch(function () {});
        }
      };
      return React.createElement("section", { className: "dsc-card" },
        React.createElement("div", { className: "dsc-dir-note" }, t("row.hint")),
        React.createElement("div", { className: "dsc-grand" },
          React.createElement("label", { className: "dsc-field" },
            React.createElement("input", { className: "dsc-input", value: dirState[0], placeholder: t("row.dirPlaceholder"), onChange: function (e) { dirState[1](e.target.value); dirtyState[1](true); savedState[1](false); } })
          ),
          React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: browse }, t("row.browse"))
        ),
        React.createElement("div", { className: "dsc-model-hint" }, t("row.modelHint")),
        CLIS.map(function (cli) {
          var route = modelsState[0][cli.id] || {};
          var stored = (verifiedState[0][cli.id] && verifiedState[0][cli.id].ok) ? verifiedState[0][cli.id] : null;
          var failed = (verifiedState[0][cli.id] && verifiedState[0][cli.id].ok === false) ? verifiedState[0][cli.id] : null;
          // A record only counts while its route still matches the live
          // provider/model/effort; changing any of them invalidates it (so a
          // switched-away supplier's success/failure text disappears).
          var fpOk = function (r) { return r && r.provider === (route.provider || "") && r.model === (route.model || "") && (r.reasoningEffort || null) === (route.reasoningEffort || null); };
          var v = fpOk(stored) ? stored : null;
          var f = fpOk(failed) ? failed : null;
          // INSTALL + CONNECTIVITY state, derived purely from the persisted
          // `verified` record + the live route. No filesystem probe: a CLI with
          // no verified record (or one invalidated by a route change) shows as
          // "已安装·未测试"; a matching ok record shows the version; a matching
          // failed record shows 测试失败.
          var stateCls = "dsc-cli-status";
          var stateText;
          var hasRec = !!(verifiedState[0][cli.id]);
          if (v) {
            // 测试通过时右上角只显示版本号；底部引导句已表达"测试通过"。
            stateText = v.version ? cleanVersion(v.version) : t("row.connPassed");
            stateCls += " dsc-conn-ok";
          } else if (f) {
            stateText = t("row.connFailed");
            stateCls += " dsc-conn-fail";
          } else if (hasRec) {
            // A verified record exists but its fingerprint no longer matches the
            // live route (provider/model/effort changed) → installed but not
            // tested under the current route.
            stateText = t("row.connNotTested");
          } else {
            // No verified record at all → never confirmed installed/tested.
            stateText = t("row.notInstalled");
          }
          // Guidance line under the route selects. Tells the user what to say to
          // the controller so the AI handles install/test. `{cli}` is substituted
          // manually (the locale `t` here only takes a key, no param map).
          function fillCli(template) {
            return String(template || "").replace(/\{cli\}/g, cli.name);
          }
          var guideText = "";
          if (f) {
            guideText = f.error || fillCli(t("row.guideFailed"));
          } else if (v) {
            guideText = fillCli(t("row.guidePassed"));
          } else if (hasRec) {
            guideText = fillCli(t("row.guideNotTested"));
          } else {
            guideText = fillCli(t("row.guideInstall"));
          }
          return React.createElement("div", { className: "dsc-cli", key: cli.id },
            React.createElement("div", { className: "dsc-cli-title-row" },
              React.createElement("div", { className: "dsc-cli-head" }, cli.name),
              React.createElement("span", { className: "dsc-cli-install" },
                React.createElement("span", { className: stateCls }, stateText)
              )
            ),
            React.createElement(RouteSelects, { t: t, cli: cli, groups: groupsState[0], route: route, permission: permissionsState[0][cli.id] || DEFAULT_PERMISSION, autoContinue: autoContinueState[0][cli.id] || { enabled: true, max: 3 }, turnTimeoutMinutes: turnTimeoutState[0][cli.id] || 5, onChange: function (r) { updateRoute(cli.id, r); }, onPermissionChange: function (p) { updatePermission(cli.id, p); }, onAutoContinueChange: function (c) { updateAutoContinue(cli.id, c); }, onTurnTimeoutChange: function (m) { updateTurnTimeout(cli.id, m); } }),
            React.createElement("div", { className: "dsc-cli-test-hint" + (f ? " dsc-cli-test-hint-error" : "") },
              guideText
            )
          );
        }),
        React.createElement("div", { className: "dsc-footer" },
          React.createElement("div", { className: "dsc-footer-left" },
            React.createElement("a", { className: "dsc-cheer", href: DSC_GITHUB_URL, target: "_blank", rel: "noopener noreferrer" },
              t("row.cheer"),
              React.createElement("span", { className: "dsc-cheer-star", "aria-hidden": "true" }, "\u2605")
            )
          ),
          React.createElement("button", { type: "button", className: "dsm-btn dsm-btn-outline", disabled: !dirtyState[0] || busyState[0], onClick: discard }, t("row.discard")),
          React.createElement("button", { type: "button", className: "dsm-btn dsm-btn-primary", disabled: !snap || snap.status !== "ready" || snap.writable === false || busyState[0] || !dirtyState[0], onClick: save }, busyState[0] ? t("row.saving") : t("row.save"))
        ),
        React.createElement("div", { className: "dsc-guide" },
          React.createElement("div", { className: "dsc-guide-title" }, t("guide.title")),
          React.createElement("div", { className: "dsc-guide-row" }, React.createElement("code", null, "cli_install"), t("guide.install"), React.createElement("span", { className: "dsc-guide-ex" }, t("guide.example") + t("guide.installEx"))),
          React.createElement("div", { className: "dsc-guide-row" }, React.createElement("code", null, "cli_check"), t("guide.check"), React.createElement("span", { className: "dsc-guide-ex" }, t("guide.example") + t("guide.checkEx"))),
          React.createElement("div", { className: "dsc-guide-row" }, React.createElement("code", null, "cli_test"), t("guide.test"), React.createElement("span", { className: "dsc-guide-ex" }, t("guide.example") + t("guide.testEx"))),
          React.createElement("div", { className: "dsc-guide-row" }, React.createElement("code", null, "cli_remove"), t("guide.remove"), React.createElement("span", { className: "dsc-guide-ex" }, t("guide.example") + t("guide.removeEx"))),
          React.createElement("div", { className: "dsc-guide-row" }, React.createElement("code", null, "cli_<cli>_direct"), t("guide.direct"), React.createElement("span", { className: "dsc-guide-ex" }, t("guide.example") + t("guide.directEx"))),
          React.createElement("div", { className: "dsc-guide-row" }, React.createElement("code", null, "cli_<cli>_subagent"), t("guide.subagent"), React.createElement("span", { className: "dsc-guide-ex" }, t("guide.example") + t("guide.subagentEx"))),
          React.createElement("div", { className: "dsc-guide-row" }, React.createElement("code", null, "cli_dispatch"), t("guide.dispatch"), React.createElement("span", { className: "dsc-guide-ex" }, t("guide.example") + t("guide.dispatchEx")))
        )
      );
    }

    function PluginCard(props) {
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var t = props.t;
      return React.createElement("li", { className: "dsm-plugin-card" + (open ? " dsm-plugin-card-open" : "") },
        React.createElement("button", { type: "button", className: "dsm-plugin-card-header", "aria-expanded": open, onClick: function () { setOpen(!open); } },
          React.createElement("img", { className: "dsm-plugin-card-icon", src: DSC_ICON, alt: "" }),
          React.createElement("span", { className: "dsm-plugin-card-head" },
            React.createElement("span", { className: "dsm-plugin-card-title" }, t("row.title")),
            React.createElement("span", { className: "dsm-plugin-card-description" }, t("row.desc"))
          ),
          React.createElement("span", { className: "dsm-plugin-card-chevron" + (open ? " dsm-plugin-card-chevron-open" : "") }, React.createElement(primitives.IconChevronDownOutline14, { size: 14 }))
        ),
        React.createElement("div", { className: "dsm-plugin-card-body", hidden: !open },
          React.createElement(SetupRow, props)
        )
      );
    }

    var inject = ["slots", "locale", "settingsScope", "remote", "remote.session"];

    function apply(ctx) {
      try {
        ctx.effect(function () {
          var offZh = ctx.locale.register(NS, "zh", ZH);
          var offEn = ctx.locale.register(NS, "en", EN);
          return function () { offEn(); offZh(); };
        }, "dsh-sub-cli: settings copy");
        var t = ctx.locale.bind(NS);
        var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
        // Model catalog: `remote.session.modelCatalog()` is the current remote
        // face (the old `connection.api.llm.models()` seat no longer exists).
        // Resolved through ctx.get so a page without the seat still mounts the
        // card instead of throwing before slots.inject.
        var sessionRemote = typeof ctx.get === "function" ? ctx.get("remote.session") : undefined;
        var loadCatalog = function () {
          if (!sessionRemote || typeof sessionRemote.modelCatalog !== "function") return Promise.resolve([]);
          return sessionRemote.modelCatalog().then(function (response) {
            if (!response || !response.ok) return [];
            return (response.value && response.value.groups) || [];
          }).catch(function () { return []; });
        };
        var injected = function () {
          return {
            t: t,
            settingsScope: scope,
            loadCatalog: loadCatalog,
            pickDirectory: function () {
              var ws = ctx.get("workspaces");
              return ws && typeof ws.pickDirectory === "function" ? ws.pickDirectory() : Promise.resolve(null);
            }
          };
        };
        ctx.slots.inject("settings.plugin.item", function () {
          return ctx.slots.register({ name: "settings.plugin.item", key: "dsh-sub-cli", priority: 30, inject: injected }, PluginCard);
        });
      } catch (error) {
        console.error("[dsh-sub-cli] client card failed to load (Host CLI tools remain available):", error);
      }
    }

    return { apply: apply, inject: inject };
  }
});
