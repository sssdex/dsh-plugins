window.__ModuleLoader__.load({
  id: "dsh-workspace-agent-preset",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const h = react.createElement;

    const inject = ["slots", "locale"];

    const STATE_ROUTE = "/api/workspace-agent-preset.state";
    const ASSIGN_ROUTE = "/api/workspace-agent-preset.assign";
    const SECTION_ID = "workspace-agent-preset";
    const NS = "workspace-agent-preset";

    const css = [
      ".wap_section{width:100%;max-width:860px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}",
      ".wap_head{display:flex;align-items:baseline;gap:8px;padding:0 2px}",
      ".wap_title{margin:0;font-size:18px;font-weight:600;line-height:26px}",
      ".wap_count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}",
      ".wap_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px;padding:0 2px}",
      ".wap_bar{display:flex;align-items:center;gap:8px;padding:0 2px}",
      ".wap_btn{cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}",
      ".wap_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".wap_btn:disabled{opacity:.5;cursor:default}",
      ".wap_rows{display:flex;flex-direction:column;gap:10px}",
      ".wap_row{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px}",
      ".wap_rowHead{display:flex;align-items:baseline;gap:8px;min-width:0}",
      ".wap_name{font-weight:600;font-size:13px;line-height:20px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".wap_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:none;font-variant-numeric:tabular-nums}",
      ".wap_path{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
      ".wap_pick{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".wap_select{font:inherit;font-size:13px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);max-width:100%;min-width:220px}",
      ".wap_select option{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
      ".wap_menu{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}",
      ".wap_menuRow{display:flex;align-items:center;gap:10px;padding:7px 10px;min-width:0}",
      ".wap_menuRow+.wap_menuRow{border-top:1px solid var(--dsw-alias-border-l2)}",
      ".wap_menuLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:none}",
      ".wap_menuValue{flex:1;min-width:0;display:flex;justify-content:flex-end}",
      ".wap_ghost{font:inherit;font-size:13px;line-height:20px;padding:2px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;max-width:100%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".wap_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".wap_ghost:disabled{opacity:.55;cursor:default}",
      ".wap_ghost.muted{color:var(--dsw-alias-label-tertiary)}",
      ".wap_ghost .wap_chev{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:6px}",
      ".wap_effective{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".wap_effective b{color:var(--dsw-alias-label-secondary);font-weight:600}",
      ".wap_badge{min-height:20px;color:var(--dsw-alias-label-secondary);border-radius:5px;align-items:center;padding:1px 8px;font-size:11px;line-height:16px;display:inline-flex;background:var(--dsw-alias-bg-layer-1)}",
      ".wap_badge.default{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);color:var(--dsw-alias-state-business-primary)}",
      ".wap_badge.warn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#e8a33d) 12%, transparent);color:var(--dsw-alias-state-warn-primary,#e8a33d)}",
      ".wap_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
      ".wap_meta2{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-all}",
      ".wap_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px}",
      ".wap_saving{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px}",
      ".wap_verify{font-size:11px;line-height:16px;padding:0 2px;word-break:break-word}",
      ".wap_verify.ok{color:var(--dsw-alias-label-tertiary)}",
      ".wap_verify.ignored{color:var(--dsw-alias-state-error-primary)}",
      ".wap_verify.untested{color:var(--dsw-alias-label-tertiary)}"
    ].join("");
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="dsh-workspace-agent-preset/section"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-workspace-agent-preset";
      tag.dataset.pluginCss = "dsh-workspace-agent-preset/section";
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const zh = {
      sectionLabel: "工作区预设",
      title: "每个工作区的默认 Agent 预设与模型",
      intro: "为每个工作区单独指定新建会话时使用的 Agent 预设、模型与推理等级。只影响新建会话：已经开始的会话保留它自己的选择；在新会话界面手动挑选时，以你选的为准。",
      followGlobal: "跟随全局默认（不单独指定）",
      inherited: "当前生效",
      presetMissing: "预设已不存在",
      modelMissing: "模型不可用",
      refresh: "刷新",
      loading: "读取中…",
      loadFailed: "读取失败（HTTP {status}）",
      saveFailed: "保存失败（HTTP {status}）",
      empty: "还没有任何工作区。在侧边栏新建或打开一个项目目录后会出现在这里。",
      noRoster: "当前部署没有可用的 Agent 预设目录，因此无法为工作区指定预设。",
      saving: "保存中…",
      sessions: "{count} 个会话",
      store: "配置文件：",
      broken: "该预设当前无法激活",
      presetLabel: "Agent 预设",
      modelLabel: "模型",
      effortLabel: "推理等级",
      effortDefault: "跟随模型默认",
      followGlobalModel: "跟随全局默认",
      verifyOk: "注入自检通过：{preset} 已被实际采用",
      verifyIgnored: "注入自检失败：请求 {asked}，实际运行 {got}。插件通过覆盖 sessionController.create 生效，平台若改为从原型解析该方法，覆盖会被绕过。",
      verifyUntested: "尚未验证：在该工作区新建一次会话后，这里会显示注入自检结果",
      verifyTitle: "注入自检",
      modelVerifyOk: "模型自检通过：{selection} 已被实际采用",
      modelVerifyKept: "模型自检：该会话已自选 {selection}，工作区默认未覆盖它",
      modelVerifyIgnored: "模型自检失败：请求 {asked}，实际运行 {got}",
      modelVerifyUntested: "尚未验证：在该工作区新建一次会话后，这里会显示模型自检结果",
      modelVerifyTitle: "模型自检"
    };
    const en = {
      sectionLabel: "Workspace presets",
      title: "Default agent preset and model per workspace",
      intro: "Choose the agent preset, model and reasoning level that new sessions in each workspace start with. Only new sessions are affected: sessions already started keep theirs, and picking a model or preset in the new-session chip always wins.",
      followGlobal: "Follow the global default (no override)",
      inherited: "In effect",
      presetMissing: "preset no longer exists",
      modelMissing: "model unavailable",
      refresh: "Refresh",
      loading: "Loading…",
      loadFailed: "Load failed (HTTP {status})",
      saveFailed: "Save failed (HTTP {status})",
      empty: "No workspaces yet. Open or create a project directory from the sidebar and it appears here.",
      noRoster: "This deployment composes no agent preset roster, so no workspace preset can be assigned.",
      saving: "Saving…",
      sessions: "{count} sessions",
      store: "Store: ",
      broken: "This preset cannot activate right now",
      presetLabel: "Agent preset",
      modelLabel: "Model",
      effortLabel: "Reasoning",
      effortDefault: "Model default",
      followGlobalModel: "Follow the global default",
      verifyOk: "Injection self-check passed: {preset} was actually used",
      verifyIgnored: "Injection self-check FAILED: asked for {asked}, the session ran {got}. This plugin works by overriding sessionController.create; if the platform resolves that method from the prototype, the override is bypassed.",
      verifyUntested: "Not verified yet: start one session in this workspace and the injection self-check result appears here",
      verifyTitle: "Injection self-check",
      modelVerifyOk: "Model self-check passed: {selection} was actually used",
      modelVerifyKept: "Model self-check: that session already chose {selection}; the workspace default did not override it",
      modelVerifyIgnored: "Model self-check FAILED: asked for {asked}, the Agent reports {got}",
      modelVerifyUntested: "Not verified yet: start one session in this workspace and the model self-check result appears here",
      modelVerifyTitle: "Model self-check"
    };

    function request(url, init) {
      return fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        ...init
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, body };
      });
    }

    function errorText(result, t, key) {
      const message = result.body?.error?.message;
      if (typeof message === "string" && message !== "") return message;
      return t(key, { status: result.status });
    }

    /** Look one model up in the catalog, by provider and model id. */
    function findModel(models, selection) {
      if (selection === null || selection === undefined) return null;
      const group = (models?.groups ?? []).find((entry) => entry.id === selection.provider);
      if (group === undefined) return null;
      const model = group.models.find((entry) => entry.id === selection.model);
      return model === undefined ? null : { group, model };
    }

    /** Human-readable route, `name · effort` when an effort is pinned. */
    function selectionLabel(models, selection) {
      if (selection === null || selection === undefined) return "";
      const found = findModel(models, selection);
      const modelName = found === null ? selection.model : found.model.name;
      const effort = selection.reasoningEffort;
      if (effort === undefined || effort === null || effort === "") return modelName;
      const level = (found?.model.reasoning?.efforts ?? []).find((entry) => entry.id === effort);
      return `${modelName} · ${level === undefined ? effort : level.name}`;
    }

    /** A compact two-row menu: model on top, its reasoning level underneath. */
    function ModelPicks({ t, row, models, busy, onSelect }) {
      const groups = models?.groups ?? [];
      const current = row.selection ?? null;
      const effective = row.effectiveSelection ?? null;
      const found = findModel(models, current ?? effective);
      const reasoning = found?.model.reasoning ?? null;
      const efforts = reasoning?.efforts ?? [];
      const showEffort = current !== null && efforts.length > 0;
      const effortValue = current?.reasoningEffort ?? "";
      const modelValue = current === null ? "" : `${current.provider}\u0000${current.model}`;

      const pickModel = (value) => {
        if (value === "") {
          onSelect(row, null);
          return;
        }
        const [provider, model] = value.split("\u0000");
        const target = groups.find((group) => group.id === provider)?.models.find((entry) => entry.id === model);
        const defaultEffort = target?.reasoning?.defaultEffort;
        onSelect(row, defaultEffort === undefined || defaultEffort === null ? { provider, model } : { provider, model, reasoningEffort: defaultEffort });
      };

      const pickEffort = (value) => {
        if (current === null) return;
        const base = { provider: current.provider, model: current.model };
        onSelect(row, value === "" ? base : { ...base, reasoningEffort: value });
      };

      return h(
        "div",
        { className: "wap_menu" },
        h(
          "div",
          { className: "wap_menuRow" },
          h("span", { className: "wap_menuLabel" }, t("modelLabel")),
          h(
            "span",
            { className: "wap_menuValue" },
            h(
              "select",
              {
                className: "wap_select",
                value: modelValue,
                disabled: busy,
                "aria-label": t("modelLabel"),
                onChange: (event) => pickModel(event.target.value)
              },
              h("option", { value: "" }, t("followGlobalModel")),
              ...groups.map((group) =>
                h(
                  "optgroup",
                  { key: group.id, label: group.name },
                  ...group.models.map((model) =>
                    h("option", { key: `${group.id}/${model.id}`, value: `${group.id}\u0000${model.id}` }, model.name)
                  )
                )
              )
            )
          )
        ),
        showEffort
          ? h(
              "div",
              { className: "wap_menuRow" },
              h("span", { className: "wap_menuLabel" }, t("effortLabel")),
              h(
                "span",
                { className: "wap_menuValue" },
                h(
                  "select",
                  {
                    className: "wap_select",
                    value: effortValue,
                    disabled: busy,
                    "aria-label": t("effortLabel"),
                    onChange: (event) => pickEffort(event.target.value)
                  },
                  h("option", { value: "" }, t("effortDefault")),
                  ...efforts.map((effort) => h("option", { key: effort.id, value: effort.id }, effort.name))
                )
              )
            )
          : null,
        h(
          "div",
          { className: "wap_menuRow" },
          h("span", { className: "wap_menuLabel" }, t("inherited")),
          h(
            "span",
            { className: "wap_menuValue" },
            h(
              "span",
              { className: "wap_effective", style: { textAlign: "right", padding: "2px 6px" } },
              h("b", null, selectionLabel(models, effective) || "—"),
              current === null ? h("span", { className: "wap_badge default", style: { marginLeft: 6 } }, "default") : null,
              row.staleSelection === null
                ? null
                : h(
                    "span",
                    { className: "wap_badge warn", style: { marginLeft: 6 } },
                    `${t("modelMissing")}: ${row.staleSelection.provider}/${row.staleSelection.model}`
                  )
            )
          )
        )
      );
    }

    function WorkspaceRow({ t, row, presets, models, defaultPresetId, busy, onAssign, onSelect }) {
      const known = new Map(presets.map((preset) => [preset.id, preset]));
      const selected = row.presetId ?? "";
      const stale = row.stalePresetId ?? null;
      const effectiveId = row.presetId ?? defaultPresetId ?? null;
      const effective = effectiveId === null ? null : known.get(effectiveId) ?? null;
      return h(
        "div",
        { className: "wap_row" },
        h(
          "div",
          { className: "wap_rowHead" },
          h("span", { className: "wap_name", title: row.title }, row.title),
          h("span", { className: "wap_meta" }, t("sessions", { count: row.sessionCount }))
        ),
        h("div", { className: "wap_path" }, row.path),
        h(
          "div",
          { className: "wap_pick" },
          h(
            "select",
            {
              className: "wap_select",
              value: selected,
              disabled: busy,
              "aria-label": t("presetLabel"),
              onChange: (event) => onAssign(row, event.target.value === "" ? null : event.target.value)
            },
            h("option", { value: "" }, t("followGlobal")),
            ...presets.map((preset) =>
              h("option", { value: preset.id, key: preset.id }, preset.broken === null ? preset.name : `${preset.name} — ${t("broken")}`)
            )
          ),
          effective === null
            ? null
            : h(
                "span",
                { className: "wap_effective" },
                `${t("presetLabel")}: `,
                h("b", null, effective.name),
                effective.isDefault ? h("span", { className: "wap_badge default", style: { marginLeft: 6 } }, "default") : null
              ),
          stale === null
            ? null
            : h("span", { className: "wap_badge warn" }, `${t("presetMissing")}: ${stale}`)
        ),
        h(ModelPicks, { t, row, models, busy, onSelect })
      );
    }

    function Section({ t }) {
      const [state, setState] = react.useState({ status: "loading", error: "", data: null });
      const [busy, setBusy] = react.useState(null);
      const [saveError, setSaveError] = react.useState("");
      const alive = react.useRef(true);
      react.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const applyState = (data) => {
        if (!alive.current) return;
        setState({ status: "ready", error: "", data });
      };

      const load = react.useCallback(() => {
        setState((prev) => ({ ...prev, status: prev.data === null ? "loading" : prev.status }));
        request(STATE_ROUTE).then(
          (result) => {
            if (!alive.current) return;
            if (!result.ok) {
              setState({ status: "error", error: errorText(result, t, "loadFailed"), data: null });
              return;
            }
            applyState(result.body);
          },
          (error) => {
            if (!alive.current) return;
            setState({ status: "error", error: String(error), data: null });
          }
        );
      }, [t]);

      react.useEffect(() => {
        load();
      }, [load]);

      const assign = (row, presetId) => {
        setSaveError("");
        setBusy(row.path);
        request(ASSIGN_ROUTE, { method: "POST", body: JSON.stringify({ path: row.path, presetId }) }).then(
          (result) => {
            if (!alive.current) return;
            setBusy(null);
            if (!result.ok) {
              setSaveError(errorText(result, t, "saveFailed"));
              return;
            }
            applyState(result.body);
          },
          (error) => {
            if (!alive.current) return;
            setBusy(null);
            setSaveError(String(error));
          }
        );
      };

      const select = (row, selection) => {
        setSaveError("");
        setBusy(row.path);
        request(ASSIGN_ROUTE, { method: "POST", body: JSON.stringify({ path: row.path, selection }) }).then(
          (result) => {
            if (!alive.current) return;
            setBusy(null);
            if (!result.ok) {
              setSaveError(errorText(result, t, "saveFailed"));
              return;
            }
            applyState(result.body);
          },
          (error) => {
            if (!alive.current) return;
            setBusy(null);
            setSaveError(String(error));
          }
        );
      };

      const data = state.data;
      const presets = data?.presets ?? [];
      const models = data?.models ?? { default: null, groups: [] };
      const workspaces = data?.workspaces ?? [];

      return h(
        "div",
        { className: "wap_section" },
        h("div", { className: "wap_head" }, h("h3", { className: "wap_title" }, t("title")), data === null ? null : h("span", { className: "wap_count" }, `${workspaces.length}`)),
        h("p", { className: "wap_intro" }, t("intro")),
        state.status === "loading" ? h("div", { className: "wap_meta2" }, t("loading")) : null,
        state.error !== "" ? h("div", { className: "wap_err" }, state.error) : null,
        saveError !== "" ? h("div", { className: "wap_err" }, saveError) : null,
        data !== null && data.active === false ? h("div", { className: "wap_err" }, t("noRoster")) : null,
        h(
          "div",
          { className: "wap_bar" },
          h("button", { type: "button", className: "wap_btn", onClick: load, disabled: state.status === "loading" }, t("refresh")),
          busy === null ? null : h("span", { className: "wap_saving" }, t("saving"))
        ),
        data === null
          ? null
          : workspaces.length === 0
            ? h("div", { className: "wap_empty" }, t("empty"))
            : h(
                "div",
                { className: "wap_rows" },
                ...workspaces.map((row) =>
                  h(WorkspaceRow, {
                    key: row.workspaceId === "" ? row.path : row.workspaceId,
                    t,
                    row,
                    presets,
                    models,
                    defaultPresetId: data.defaultPresetId,
                    busy: busy === row.path,
                    onAssign: assign,
                    onSelect: select
                  })
                )
              ),
        data?.storeFile === undefined ? null : h("div", { className: "wap_meta2" }, `${t("store")}${data.storeFile}`),
        (() => {
          const check = data?.injection ?? null;
          if (check === null) return null;
          if (check.state === "ok") {
            return h("div", { className: "wap_verify ok" }, t("verifyOk", { preset: check.got ?? check.asked ?? "" }));
          }
          if (check.state === "ignored") {
            return h("div", { className: "wap_verify ignored" }, t("verifyIgnored", { asked: check.asked ?? "?", got: check.got ?? "—" }));
          }
          return h("div", { className: "wap_verify untested" }, t("verifyUntested"));
        })(),
        (() => {
          const check = data?.modelInjection ?? null;
          if (check === null) return null;
          const asked = selectionLabel(models, check.asked) || "—";
          const got = check.got === null || check.got === undefined ? "—" : selectionLabel(models, check.got) || "—";
          if (check.state === "ok") return h("div", { className: "wap_verify ok" }, t("modelVerifyOk", { selection: got }));
          if (check.state === "kept") return h("div", { className: "wap_verify ok" }, t("modelVerifyKept", { selection: got }));
          if (check.state === "ignored") {
            return h("div", { className: "wap_verify ignored" }, t("modelVerifyIgnored", { asked, got }));
          }
          return h("div", { className: "wap_verify untested" }, t("modelVerifyUntested"));
        })()
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "workspace-agent-preset: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: SECTION_ID,
            order: 60,
            label: () => t("sectionLabel"),
            locale: NS
          },
          (props) => h(Section, { t: props.t ?? t })
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
