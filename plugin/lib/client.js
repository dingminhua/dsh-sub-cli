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

    // The reference plugin embeds its logo as a data URI. Keep the same
    // approach so the icon survives DSH's client bundle loader and does not
    // depend on a relative asset URL.
    var DSC_ICON = "data:image/png;base64,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";

    // ── CSS ──────────────────────────────────────────────────────────────
    var SETTINGS_CSS = ".dsc-card{display:grid;gap:12px;margin:18px 0;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,#1c1d21);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:12px}.dsc-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}.dsc-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsc-grand{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.dsc-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsc-input{width:100%;height:32px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;box-sizing:border-box}.dsc-select{width:100%;height:32px;padding:0 28px 0 9px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit}.dsc-select:focus{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:1px}.dsc-route{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:end;padding:8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}.dsc-cli{margin-top:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px}.dsc-cli-title-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}.dsc-cli-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:wrap}.dsc-cli-actions button{min-height:24px!important;height:24px!important;padding:0 7px!important;font-size:11px!important;line-height:22px!important}.dsc-cli-notice{margin:-2px 0 6px;font-size:11px;color:#2ed084;text-align:right}.dsc-cli-notice-error{color:#ef4444}@media(max-width:760px){.dsc-cli-title-row{align-items:flex-start}.dsc-cli-actions{max-width:58%}}.dsc-cli-head{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);margin-bottom:6px}.dsc-cli-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;padding:0 6px;border-radius:10px}.dsc-cli-badge-ok{background:rgba(46,208,130,0.15);color:#2ed084}.dsc-cli-badge-bad{background:rgba(242,90,90,0.15);color:#ef4444}.dsc-cli-ver{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}.dsc-footer{border-top:1px solid var(--dsw-alias-border-l2,#36373b);display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px}.dsc-footer-status{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#b8b8b8);font-size:12px;line-height:1.5}.dsc-footer-error{flex:1;min-width:0;color:var(--dsw-alias-label-error,#ef4444);font-size:12px;line-height:1.5}.dsc-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}.dsm-btn:disabled{opacity:.4;cursor:default}.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}.dsm-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}.dsm-btn-primary:hover:not(:disabled){opacity:.9}.dsm-plugin-card-body .dsc-card{margin:0;padding:12px 0 0;background:transparent;border:0;border-radius:0}.dsm-plugin-card-body .dsc-card .dsc-title{display:none}.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;transition:transform .16s}.dsm-plugin-card-chevron-open{transform:rotate(180deg)}.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}";

    if (typeof document !== "undefined") {
      var cssId = "dsh-sub-cli/client.css";
      if (!document.querySelector("style[data-plugin-css='" + cssId + "']")) {
        var styleTag = document.createElement("style");
        styleTag.dataset.plugin = "dsh-sub-cli";
        styleTag.dataset.pluginCss = cssId;
        styleTag.textContent = SETTINGS_CSS;
        document.head.appendChild(styleTag);
      }
    }

    // ── locale ───────────────────────────────────────────────────────────
    var NS = "settings.dshSubCli";
    var ZH = {
      "row.title": "外部 Agent CLI 管理器（dsh-sub-cli）",
      "row.desc": "统一管理并调用外部 Agent CLI，与原生安装隔离，可预设各种模型并像子代理一样被主控调用。",
      "row.dir": "CLI 统一目录",
      "row.dirPlaceholder": "~/dsh-clis",
      "row.provider": "推理 Provider",
      "row.model": "模型",
      "row.effort": "推理强度",
      "row.inherit": "（继承）",
      "row.save": "保存",
      "row.discard": "放弃修改",
      "row.saved": "已保存",
      "row.browse": "浏览",
      "row.hint": "bin/ 存放 CLI 二进制，config-<cli>/ 存放各 CLI 隔离配置。切换目录只更改查找与安装位置，不会迁移已有内容。",
      "row.toastSaved": "dsh-sub-cli 设置已保存。",
      "row.notInstalled": "未安装",
      "row.connectionTest": "测试",
      "row.testingConnection": "测试中…",
      "row.install": "安装",
      "row.installing": "安装中…",
      "row.installPassed": "安装成功",
      "row.update": "更新",
      "row.updating": "更新中…",
      "row.noUpdate": "当前已是最新版本",
      "row.updatePassed": "已更新",
      "row.remove": "删除",
      "row.removing": "删除中…",
      "row.testPassed": "连接测试通过",
      "row.removePassed": "已删除"
    };
    var EN = {
      "row.title": "External Agent CLI manager (dsh-sub-cli)",
      "row.desc": "Unified management and invocation of external Agent CLIs, isolated from native installs, with configurable models, callable by the controller like subagents.",
      "row.dir": "Unified CLI directory",
      "row.dirPlaceholder": "~/dsh-clis",
      "row.provider": "Provider",
      "row.model": "Model",
      "row.effort": "Reasoning effort",
      "row.inherit": "(inherit)",
      "row.save": "Save",
      "row.discard": "Discard",
      "row.saved": "Saved",
      "row.browse": "Browse",
      "row.hint": "bin/ holds CLI binaries, config-<cli>/ holds each CLI's isolated config. Switching the directory changes where the plugin looks and installs; it does not migrate existing content.",
      "row.toastSaved": "dsh-sub-cli settings saved.",
      "row.notInstalled": "Not installed",
      "row.connectionTest": "Test",
      "row.testingConnection": "Testing…",
      "row.install": "Install",
      "row.installing": "Installing…",
      "row.installPassed": "Install succeeded",
      "row.update": "Update",
      "row.updating": "Updating…",
      "row.noUpdate": "Already on the latest version",
      "row.updatePassed": "Updated",
      "row.remove": "Remove",
      "row.removing": "Removing…",
      "row.testPassed": "Connection test passed",
      "row.removePassed": "Removed"
    };

    var CLIS = [
      { id: "codex", name: "Codex" },
      { id: "claude", name: "Claude Code" },
      { id: "qwen", name: "Qwen Code" }
    ];
    var SETTINGS_NS = "dsh-sub-cli";

    function normalize(value) {
      return {
        cliDir: (value && value.cliDir) || "",
        models: (value && value.models) || {}
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
      });
    }

    function RouteSelects(props) {
      var t = props.t;
      var groups = props.groups;
      var route = props.route || {};
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
        )
      );
    }

    function SetupRow(props) {
      var t = props.t;
      var api = props.api;
      var snap = useSettingsScopeSnapshot(props.settingsScope);
      var value = (snap && snap.status === "ready" && snap.value) || {};
      var dirState = React.useState(normalize(value).cliDir);
      var modelsState = React.useState(normalize(value).models);
      var groupsState = React.useState([]);
      var cliState = React.useState([]);
      var dirtyState = React.useState(false);
      var busyState = React.useState(false);
      var cliBusyState = React.useState({});
      var cliNoticeState = React.useState({});
      var savedState = React.useState(false);
      React.useEffect(function () {
        var alive = true;
        props.api.llm.models({}).then(function (r) { if (alive && r.result && r.result.ok) groupsState[1](r.result.value.groups || []); }).catch(function () {});
        var checkCli = props.api && props.api.cli && typeof props.api.cli.check === "function" ? props.api.cli.check.bind(props.api.cli) : null;
        if (checkCli) checkCli({}).then(function (r) { if (alive && r.result && r.result.ok) cliState[1](r.result.value.results || []); }).catch(function () {});
        return function () { alive = false; };
      }, []);
      React.useEffect(function () {
        if (dirtyState[0] || busyState[0]) return;
        dirState[1](normalize(value).cliDir);
        modelsState[1](normalize(value).models);
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
      function save() {
        if (!snap || snap.status !== "ready" || snap.writable === false || busyState[0]) return;
        var payload = { cliDir: dirState[0], models: modelsState[0] };
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
        dirtyState[1](false);
        savedState[1](false);
      }
      var browse = function () {
        if (typeof props.pickDirectory === "function") {
          Promise.resolve(props.pickDirectory()).then(function (p) { if (p) { dirState[1](p); dirtyState[1](true); savedState[1](false); } }).catch(function () {});
        }
      };
      function setCliNotice(id, text, error) {
        cliNoticeState[1](function (prev) { var next = Object.assign({}, prev); next[id] = { text: text, error: !!error }; return next; });
      }
      function replaceCliStatus(id, found) {
        cliState[1](function (prev) {
          var next = prev.slice();
          var idx = next.findIndex(function (x) { return x.id === id; });
          if (idx >= 0) next[idx] = found; else next.push(found);
          return next;
        });
      }
      var testConnection = function (id) {
        if (cliBusyState[0][id]) return;
        var call = props.api && props.api.cli && typeof props.api.cli.test === "function" ? props.api.cli.test.bind(props.api.cli) : null;
        if (!call) return;
        cliBusyState[1](function (prev) { var next = Object.assign({}, prev); next[id] = "test"; return next; });
        call({ cli: id }).then(function (r) {
          if (r.result && r.result.ok && r.result.value && r.result.value.ok) setCliNotice(id, t("row.testPassed"), false);
          else setCliNotice(id, (r.result && r.result.value && r.result.value.message) || "Test failed", true);
        }).catch(function (e) { setCliNotice(id, String(e), true); }).finally(function () {
          cliBusyState[1](function (prev) { var next = Object.assign({}, prev); delete next[id]; return next; });
        });
      };
      var removeCli = function (id) {
        if (cliBusyState[0][id]) return;
        var call = props.api && props.api.cli && typeof props.api.cli.remove === "function" ? props.api.cli.remove.bind(props.api.cli) : null;
        if (!call) return;
        cliBusyState[1](function (prev) { var next = Object.assign({}, prev); next[id] = "remove"; return next; });
        call({ cli: id }).then(function (r) {
          if (!r.result || !r.result.ok) throw new Error("Remove failed");
          replaceCliStatus(id, { id: id, installed: false, version: null, message: "", install: "" });
          setCliNotice(id, t("row.removePassed"), false);
        }).catch(function (e) { setCliNotice(id, String(e), true); }).finally(function () {
          cliBusyState[1](function (prev) { var next = Object.assign({}, prev); delete next[id]; return next; });
        });
      };
      var installCli = function (id) {
        if (cliBusyState[0][id]) return;
        var call = props.api && props.api.cli && typeof props.api.cli.install === "function" ? props.api.cli.install.bind(props.api.cli) : null;
        if (!call) return;
        cliBusyState[1](function (prev) { var next = Object.assign({}, prev); next[id] = "install"; return next; });
        call({ cli: id }).then(function (r) {
          if (!r.result || !r.result.ok) throw new Error((r.result && (r.result.error || r.result.message)) || "Install failed");
          var found = (r.result.value && r.result.value.version) || "0";
          replaceCliStatus(id, { id: id, installed: true, version: found, message: "", install: "" });
          setCliNotice(id, t("row.installPassed"), false);
        }).catch(function (e) { setCliNotice(id, String(e), true); }).finally(function () {
          cliBusyState[1](function (prev) { var next = Object.assign({}, prev); delete next[id]; return next; });
        });
      };
      var updateCli = function (id) {
        if (cliBusyState[0][id]) return;
        var call = props.api && props.api.cli && typeof props.api.cli.update === "function" ? props.api.cli.update.bind(props.api.cli) : null;
        if (!call) return;
        cliBusyState[1](function (prev) { var next = Object.assign({}, prev); next[id] = "update"; return next; });
        call({ cli: id }).then(function (r) {
          if (!r.result || !r.result.ok) throw new Error((r.result && (r.result.error || r.result.message)) || "Update failed");
          var v = r.result.value || {};
          if (!v.updated) { setCliNotice(id, t("row.noUpdate"), false); return; }
          var found = (v.currentVersion) || "0";
          replaceCliStatus(id, { id: id, installed: true, version: found, message: "", install: "" });
          setCliNotice(id, t("row.updatePassed"), false);
        }).catch(function (e) { setCliNotice(id, String(e), true); }).finally(function () {
          cliBusyState[1](function (prev) { var next = Object.assign({}, prev); delete next[id]; return next; });
        });
      };
      return React.createElement("section", { className: "dsc-card" },
        React.createElement("div", { className: "dsc-grand" },
          React.createElement("label", { className: "dsc-field" }, t("row.dir"),
            React.createElement("input", { className: "dsc-input", value: dirState[0], placeholder: t("row.dirPlaceholder"), onChange: function (e) { dirState[1](e.target.value); dirtyState[1](true); savedState[1](false); } })
          ),
          React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: browse }, t("row.browse"))
        ),
        React.createElement("div", { className: "dsc-hint" }, t("row.hint")),
        CLIS.map(function (cli) {
          var route = modelsState[0][cli.id] || {};
          var status = (cliState[0] || []).find(function (x) { return x.id === cli.id; });
          var installed = !!(status && status.installed);
          var badge = !installed ? React.createElement("span", { className: "dsc-cli-ver" }, t("row.notInstalled")) : null;
          var ver = installed && status.version ? React.createElement("span", { className: "dsc-cli-ver" }, status.version) : null;
          var cliBusy = cliBusyState[0][cli.id];
          var installBtn = !installed ? React.createElement(Button, { type: "button", variant: "outline", size: "xs", disabled: !!cliBusy, title: status && status.install ? status.install : "", onClick: function () { installCli(cli.id); } }, cliBusy === "install" ? t("row.installing") : t("row.install")) : null;
          var connectionBtn = installed ? React.createElement(Button, { type: "button", variant: "outline", size: "xs", disabled: !!cliBusy, onClick: function () { testConnection(cli.id); } }, cliBusy === "test" ? t("row.testingConnection") : t("row.connectionTest")) : null;
          var updateBtn = installed ? React.createElement(Button, { type: "button", variant: "outline", size: "xs", disabled: !!cliBusy, onClick: function () { updateCli(cli.id); } }, cliBusy === "update" ? t("row.updating") : t("row.update")) : null;
          var removeBtn = installed ? React.createElement(Button, { type: "button", variant: "outline", size: "xs", disabled: !!cliBusy, onClick: function () { removeCli(cli.id); } }, cliBusy === "remove" ? t("row.removing") : t("row.remove")) : null;
          return React.createElement("div", { className: "dsc-cli", key: cli.id },
            React.createElement("div", { className: "dsc-cli-title-row" },
              React.createElement("div", { className: "dsc-cli-head" }, cli.name, badge, ver),
              React.createElement("div", { className: "dsc-cli-actions" }, installBtn, connectionBtn, updateBtn, removeBtn)
            ),
            cliNoticeState[0][cli.id] ? React.createElement("div", { className: "dsc-cli-notice" + (cliNoticeState[0][cli.id].error ? " dsc-cli-notice-error" : "") }, cliNoticeState[0][cli.id].text) : null,
            React.createElement(RouteSelects, { t: t, groups: groupsState[0], route: route, onChange: function (r) { updateRoute(cli.id, r); } })
          );
        }),
        React.createElement("div", { className: "dsc-footer" },
          savedState[0] ? React.createElement("span", { className: "dsc-footer-status" }, t("row.saved")) : null,
          React.createElement("button", { type: "button", className: "dsm-btn dsm-btn-outline", disabled: !dirtyState[0] || busyState[0], onClick: discard }, t("row.discard")),
          React.createElement("button", { type: "button", className: "dsm-btn dsm-btn-primary", disabled: !snap || snap.status !== "ready" || snap.writable === false || busyState[0], onClick: save }, busyState[0] ? t("row.save") + "…" : t("row.save"))
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
          React.createElement("span", { className: "dsm-plugin-card-chevron" + (open ? " dsm-plugin-card-chevron-open" : "") }, "\u25be")
        ),
        React.createElement("div", { className: "dsm-plugin-card-body", hidden: !open },
          React.createElement(SetupRow, props)
        )
      );
    }

    var inject = ["sessions", "connection", "slots", "locale", "settingsScope", "remote"];

    function apply(ctx) {
      var api = ctx.connection.api;
      ctx.locale.register(NS, "zh", ZH);
      ctx.locale.register(NS, "en", EN);
      var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
      var injected = function () {
        return {
          settingsScope: scope,
          api: api,
          pickDirectory: function () {
            var ws = ctx.get("workspaces");
            return ws && typeof ws.pickDirectory === "function" ? ws.pickDirectory() : Promise.resolve(null);
          }
        };
      };
      ctx.slots.inject("settings.plugin.item", function () {
        return ctx.slots.register({ name: "settings.plugin.item", key: "dsh-sub-cli", locale: NS, inject: injected }, PluginCard);
      });
    }

    return { apply: apply, inject: inject };
  }
});
