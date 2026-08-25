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

    // ── CSS ──────────────────────────────────────────────────────────────
    var SETTINGS_CSS = ".dsc-card{display:grid;gap:12px;margin:18px 0;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,#1c1d21);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:12px}.dsc-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}.dsc-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsc-grand{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.dsc-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8)}.dsc-input{width:100%;height:32px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;box-sizing:border-box}.dsc-select{width:100%;height:32px;padding:0 28px 0 9px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit}.dsc-select:focus{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:1px}.dsc-route{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;align-items:end;padding:8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}.dsc-cli{margin-top:8px}.dsc-cli-head{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);margin-bottom:6px}.dsc-actions{display:flex;align-items:center;gap:8px;margin-top:10px}.dsc-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}";

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
      "row.desc": "统一目录 + 每 CLI 独立模型路由（Provider → 模型 → 推理强度）。修改会保存到本地设置。",
      "row.dir": "CLI 统一目录",
      "row.dirPlaceholder": "~/dsh-clis",
      "row.provider": "推理 Provider",
      "row.model": "模型",
      "row.effort": "推理强度",
      "row.inherit": "（继承）",
      "row.empty": "尚未配置。",
      "row.save": "保存",
      "row.saved": "已保存",
      "row.browse": "浏览",
      "row.hint": "bin/ 放 CLI，config-<cli>/ 放各 CLI 隔离配置。切换目录时旧内容会自动迁移，冲突时不覆盖。",
      "row.toastSaved": "dsh-sub-cli 设置已保存。"
    };
    var EN = {
      "row.title": "External Agent CLI manager (dsh-sub-cli)",
      "row.desc": "Unified dir + a per-CLI model route (provider → model → reasoning effort). Changes are saved to local settings.",
      "row.dir": "Unified CLI dir",
      "row.dirPlaceholder": "~/dsh-clis",
      "row.provider": "Provider",
      "row.model": "Model",
      "row.effort": "Reasoning effort",
      "row.inherit": "(inherit)",
      "row.empty": "Not configured yet.",
      "row.save": "Save",
      "row.saved": "Saved",
      "row.browse": "Browse",
      "row.hint": "bin/ holds CLIs, config-<cli>/ holds each CLI's isolated config. Switching dir migrates old content; conflicts are not overwritten.",
      "row.toastSaved": "dsh-sub-cli settings saved."
    };

    var CLIS = [
      { id: "codex", name: "Codex" },
      { id: "claude", name: "Claude Code" },
      { id: "opencode", name: "OpenCode" },
      { id: "gemini", name: "Gemini CLI" }
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
      var dirtyState = React.useState(false);
      var busyState = React.useState(false);
      var savedState = React.useState(false);
      React.useEffect(function () {
        var alive = true;
        api.llm.models({}).then(function (r) { if (alive && r.result && r.result.ok) groupsState[1](r.result.value.groups || []); }).catch(function () {});
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
      var browse = function () {
        if (typeof props.pickDirectory === "function") {
          Promise.resolve(props.pickDirectory()).then(function (p) { if (p) { dirState[1](p); dirtyState[1](true); savedState[1](false); } }).catch(function () {});
        }
      };
      return React.createElement("section", { className: "dsc-card" },
        React.createElement("div", { className: "dsc-title" }, t("row.title")),
        React.createElement("div", { className: "dsc-desc" }, t("row.desc")),
        React.createElement("div", { className: "dsc-grand" },
          React.createElement("label", { className: "dsc-field" }, t("row.dir"),
            React.createElement("input", { className: "dsc-input", value: dirState[0], placeholder: t("row.dirPlaceholder"), onChange: function (e) { dirState[1](e.target.value); dirtyState[1](true); savedState[1](false); } })
          ),
          React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: browse }, t("row.browse"))
        ),
        React.createElement("div", { className: "dsc-hint" }, t("row.hint")),
        CLIS.map(function (cli) {
          var route = modelsState[0][cli.id] || {};
          return React.createElement("div", { className: "dsc-cli", key: cli.id },
            React.createElement("div", { className: "dsc-cli-head" }, cli.name),
            React.createElement(RouteSelects, { t: t, groups: groupsState[0], route: route, onChange: function (r) { updateRoute(cli.id, r); } })
          );
        }),
        React.createElement("div", { className: "dsc-actions" },
          React.createElement(Button, { type: "button", variant: "primary", size: "sm", disabled: !snap || snap.status !== "ready" || snap.writable === false || busyState[0], onClick: save }, busyState[0] ? t("row.save") + "…" : (savedState[0] ? t("row.saved") : t("row.save"))),
          savedState[0] ? React.createElement("span", { className: "dsc-hint" }, t("row.saved")) : null
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
