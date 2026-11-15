// dsh-power-off — Client half.
// 经典外链脚本（不是 ESM）：加载后向浏览器模块表注册一个 factory，无需构建。
// 约定（来自 dsh-client-modules 实测，与 dsh-auto-shutdown 同款）：id 必须等于包名；
// factory 无副作用；可见 DOM 只能通过 slot 注册挂进会话标题栏；
// 样式在 apply 里用 ctx.effect 注册并返回清理。
if (typeof window !== "undefined") {
  window.__ModuleLoader__.load({
    id: "dsh-power-off",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var React = require("react");
      var h = React.createElement;

      var API = "/api/dsh-power-off";
      var PLUGIN = "dsh-power-off";

      /* ------------------------------------------------------------------ i18n */
      var LANG = (function () {
        try {
          var l = (navigator.language || navigator.userLanguage || "en").toLowerCase();
          return l.indexOf("zh") === 0 ? "zh" : "en";
        } catch {
          return "en";
        }
      })();

      var TEXT = {
        zh: {
          idle: "关机",
          pending: "{s} 秒后关机",
          offHint: "点一下：倒计时结束后关闭这台电脑（可取消）",
          pendingHint: "电脑将在 {s} 秒后关机，点此取消（shutdown /a）",
          confirm: "确定要关闭电脑吗？\n将在 {s} 秒后关机，期间可以取消。",
          offline: "电源服务不可用",
          unsupported: "仅支持 Windows",
          error: "接口不可用",
          failed: "关机失败",
          failedHint: "上一次下发关机失败，原因：",
          cancelFailed: "取消失败",
        },
        en: {
          idle: "Power off",
          pending: "Off in {s}s",
          offHint: "Click: shut this computer down after a countdown (cancellable)",
          pendingHint: "The machine powers off in {s}s; click to cancel (shutdown /a)",
          confirm: "Shut down this computer?\nIt powers off in {s}s; you can still cancel.",
          offline: "Power service unavailable",
          unsupported: "Windows only",
          error: "API unavailable",
          failed: "Shutdown failed",
          failedHint: "The last shutdown attempt failed: ",
          cancelFailed: "Cancel failed",
        },
      }[LANG];

      function tpl(text, vars) {
        return String(text).replace(/\{(\w+)\}/g, function (_, key) {
          return vars && vars[key] !== undefined ? String(vars[key]) : "";
        });
      }

      /* ----------------------------------------------------------------- css */
      var CSS = [
        ".dshpo-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;",
        "border-radius:13px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));background:transparent;",
        "color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer;",
        "white-space:nowrap;transition:background .12s ease,color .12s ease,border-color .12s ease}",
        ".dshpo-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,inherit)}",
        ".dshpo-btn:disabled{opacity:.55;cursor:default}",
        ".dshpo-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d7cfe);outline-offset:1px}",
        ".dshpo-btn[data-phase='pending']{border-color:#b91c1c;color:#fff;background:#b91c1c}",
        ".dshpo-btn[data-error='1']{border-color:#b91c1c;color:#dc2626}",
        ".dshpo-icon{flex:none;display:block;width:12px;height:12px}",
      ].join("");

      function installStyles() {
        if (typeof document === "undefined") return function () {};
        var existing = document.querySelector('style[data-plugin-css="' + PLUGIN + '"]');
        if (existing && existing.parentNode) {
          existing.dataset.plugin = PLUGIN;
          existing.textContent = CSS;
          return function () {};
        }
        var node = document.createElement("style");
        node.dataset.plugin = PLUGIN;
        node.dataset.pluginCss = PLUGIN;
        node.textContent = CSS;
        document.head.appendChild(node);
        return function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        };
      }

      /* ----------------------------------------------------------------- api */
      function api(path, options) {
        return fetch(API + path, options).then(function (res) {
          return res.json().then(
            function (body) {
              if (!body || body.ok !== true) throw new Error((body && body.error) || "HTTP " + res.status);
              return body.data !== undefined ? body.data : body;
            },
            function () {
              throw new Error("HTTP " + res.status);
            }
          );
        });
      }

      function post(path, payload) {
        return api(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
      }

      /* ----------------------------------------------------------- component */
      function PowerIcon() {
        return h(
          "svg",
          { className: "dshpo-icon", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
          h("path", { d: "M8 1.6v5.2", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" }),
          h("path", { d: "M4.3 4.2a5.3 5.3 0 1 0 7.4 0", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" })
        );
      }

      function PowerOffButton() {
        var state = React.useState({ loading: true, data: null, error: null });
        var snap = state[0];
        var setSnap = state[1];
        var busyState = React.useState(false);
        var inFlight = busyState[0];
        var setInFlight = busyState[1];

        function refresh() {
          api("/state").then(
            function (data) {
              setSnap({ loading: false, data: data, error: null });
            },
            function (err) {
              setSnap({ loading: false, data: null, error: String((err && err.message) || err) });
            }
          );
        }

        React.useEffect(function () {
          refresh();
          var timer = setInterval(refresh, 1000);
          return function () {
            clearInterval(timer);
          };
        }, []);

        function toggle() {
          if (inFlight) return;
          var data = snap.data;
          var pending = !!(data && data.pending);
          var delay = (data && data.config && data.config.defaultDelaySeconds) || 60;
          if (!pending) {
            try {
              if (!window.confirm(tpl(TEXT.confirm, { s: delay }))) return;
            } catch {
              /* confirm 不可用就直接执行 */
            }
          }
          setInFlight(true);
          var request = pending ? post("/cancel", {}) : post("/shutdown", { delaySeconds: delay });
          request.then(
            function (result) {
              setInFlight(false);
              if (result && result.state) setSnap({ loading: false, data: result.state, error: null });
              else refresh();
            },
            function (err) {
              setInFlight(false);
              setSnap({ loading: false, data: snap.data, error: String((err && err.message) || err) });
            }
          );
        }

        var data = snap.data;
        if (data && data.supported === false) {
          return h("button", { className: "dshpo-btn", type: "button", disabled: true, title: TEXT.unsupported }, TEXT.unsupported);
        }

        var pending = !!(data && data.pending);
        var seconds = pending ? Math.ceil((data.pending.remainingMs || 0) / 1000) : 0;
        var lastError = data && data.lastError && data.lastError.message ? String(data.lastError.message) : null;
        var label = pending ? tpl(TEXT.pending, { s: seconds }) : lastError ? TEXT.failed : TEXT.idle;
        var title;
        if (snap.error) title = TEXT.error + "：" + snap.error;
        else if (lastError) title = TEXT.failedHint + lastError;
        else if (pending) title = tpl(TEXT.pendingHint, { s: seconds });
        else title = TEXT.offHint;

        return h(
          "button",
          {
            className: "dshpo-btn",
            type: "button",
            "aria-label": pending ? tpl(TEXT.pending, { s: seconds }) : TEXT.idle,
            "data-phase": pending ? "pending" : "idle",
            "data-error": lastError ? "1" : "0",
            disabled: inFlight || (snap.loading && !data),
            title: title,
            onClick: toggle,
          },
          h(PowerIcon),
          h("span", null, label)
        );
      }

      /* ---------------------------------------------------------------- apply */
      function apply(ctx) {
        ctx.effect(installStyles, PLUGIN + ": styles");
        ctx.slots.inject("conversation.session.header.utilities", function () {
          return ctx.slots.register(
            { name: "conversation.session.header.utilities", id: PLUGIN, order: 31, label: TEXT.idle },
            PowerOffButton
          );
        });
        return function () {};
      }

      var inject = ["slots"];
      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
}
