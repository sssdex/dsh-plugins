// dsh-token-tree — Client half.
//
// 注册一个 right sidebar 的 tab 类型（kind = 'token-tree'），正文渲染父子 token 树。
// 经典外链脚本（不是 ESM）：加载后向浏览器模块表注册 factory，无需构建。
// id 必须等于包名；factory 无副作用；样式在 apply 里用 ctx.effect 注册并返回清理。
if (typeof window !== "undefined") {
  window.__ModuleLoader__.load({
    id: "dsh-token-tree",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var React = require("react");
      var h = React.createElement;

      var API = "/api/dsh-token-tree";
      var PLUGIN = "dsh-token-tree";
      var TYPE_ID = PLUGIN;
      var KIND = "token-tree";
      var REFRESH_MS = 15000;

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
          title: "父+子 Token",
          tabTitle: "父+子 Token",
          grandTotal: "父 + 全部子孙",
          billed: "计费合计",
          billedLong: "计费（未缓存 + 缓存读 + 缓存写 + 输出）",
          fresh: "真实新增",
          freshLong: "真实新增（未缓存输入 + 输出）",
          composition: "Token 组成",
          cacheRead: "缓存命中",
          cacheWrite: "缓存写",
          input: "未缓存输入",
          output: "输出",
          reasoning: "推理",
          agents: "代理",
          steps: "步",
          requests: "请求",
          hit: "缓存命中率",
          hitShort: "命中",
          hitTip: "缓存读 /（缓存读 + 未缓存输入）：这一整棵树里有多少提示词是从缓存里读到的",
          rootSelf: "根代理自身",
          subTotal: "子代理合计",
          loading: "读取会话日志…",
          empty: "这个会话还没有 token 用量记录。",
          noSession: "没有选中会话。",
          error: "读取失败",
          retry: "重试",
          refresh: "刷新",
          autoRefresh: "自动刷新",
          autoRefreshTip: "自动刷新（15 秒）",
          notRoot: "当前是子代理会话，已上溯到树根",
          copy: "复制树形文本",
          copied: "已复制",
          tree: "代理树",
          expand: "展开",
          collapse: "收起",
          compaction: "其中压缩摘要 $1 次，消耗 billed $2（$3）——这部分不在任何步骤里，但确实计费",
        },
        en: {
          title: "Parent+Child Tokens",
          tabTitle: "Parent+Child Tokens",
          grandTotal: "Parent + all descendants",
          billed: "billed total",
          billedLong: "billed (uncached + cache read + cache write + output)",
          fresh: "fresh",
          freshLong: "fresh (uncached input + output)",
          composition: "Token mix",
          cacheRead: "cache read",
          cacheWrite: "cache write",
          input: "uncached input",
          output: "output",
          reasoning: "reasoning",
          agents: "agents",
          steps: "steps",
          requests: "requests",
          hit: "Cache hit",
          hitShort: "hit",
          hitTip: "cache read / (cache read + uncached input): how much of this tree's prompt came from cache",
          rootSelf: "root agent itself",
          subTotal: "subagents",
          loading: "Reading session logs…",
          empty: "No token usage recorded in this session yet.",
          noSession: "No session selected.",
          error: "Failed to read",
          retry: "Retry",
          refresh: "Refresh",
          autoRefresh: "Auto refresh",
          autoRefreshTip: "Auto refresh (15s)",
          notRoot: "This is a subagent session; showing its tree root",
          copy: "Copy tree as text",
          copied: "Copied",
          tree: "Agent tree",
          expand: "Expand",
          collapse: "Collapse",
          compaction: "$1 compaction summaries used $2 billed ($3) — not part of any step, but it is billed",
        },
      }[LANG];

      /** 极简占位替换：tpl("… $1 … $2", a, b)。 */
      function tpl(s, a, b, c) {
        return String(s)
          .replace("$1", a == null ? "" : String(a))
          .replace("$2", b == null ? "" : String(b))
          .replace("$3", c == null ? "" : String(c));
      }

      /* ----------------------------------------------------------------- css */
      // 视觉取向：紧凑的「账本」而不是表格。
      // 四类 token 各有固定色相（贯穿堆叠条 / 图例 / 树行命中率），
      // 其余一律走 DSH 语义变量，深色浅色主题都成立。
      var CSS = [
        ".dshtt{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;",
        "font:inherit;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary,inherit);",
        "--dshtt-input:#E8A33D;--dshtt-cache:#35B6A4;--dshtt-write:#9A8CF2;--dshtt-output:#E4675C}",
        // 浅色主题下把四个色相压深：同一个青在白色底上只有 2 点几的对比度，
        // 而「缓存命中率」是当正文小字用的，必须过 AA。
        "body:not([data-ds-dark-theme]) .dshtt{--dshtt-input:#B57515;--dshtt-cache:#0B8071;",
        "--dshtt-write:#6B5ACB;--dshtt-output:#C4423A}",

        /* head */
        ".dshtt-head{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px;",
        "border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22))}",
        ".dshtt-title{flex:1;min-width:0;font-size:12.5px;font-weight:600;letter-spacing:.01em;",
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dshtt-push{margin-left:auto}",

        /* segmented control */
        ".dshtt-seg{flex:none;display:inline-flex;gap:2px;padding:2px;border-radius:8px;",
        "background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}",
        ".dshtt-seg button{box-sizing:border-box;height:20px;padding:0 7px;border:0;border-radius:6px;",
        "background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:10.5px;",
        "font-weight:500;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease}",
        ".dshtt-seg button:hover{color:var(--dsw-alias-label-primary,inherit)}",
        ".dshtt-seg button[data-on='1']{background:var(--dsw-alias-bg-layer-1,#2a2a2e);",
        "color:var(--dsw-alias-label-primary,inherit);box-shadow:0 1px 2px rgba(0,0,0,.18)}",

        /* icon button（面板内，24px） */
        ".dshtt-ico{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;",
        "width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;",
        "color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));",
        "font:inherit;font-size:13px;line-height:1;cursor:pointer;transition:background .12s ease,color .12s ease}",
        ".dshtt-ico:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));",
        "color:var(--dsw-alias-label-primary,inherit)}",
        ".dshtt-ico:disabled{opacity:.4;cursor:default}",
        ".dshtt-ico[data-on='1']{color:var(--dsw-alias-brand-primary,#4d7cfe)}",

        /* 带文字的按钮（重试等） */
        ".dshtt-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;",
        "height:24px;padding:0 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));",
        "background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:11px;",
        "cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease}",
        ".dshtt-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));",
        "color:var(--dsw-alias-label-primary,inherit)}",

        /* 会话标题栏的入口按钮：和旁边的原生图标按钮同尺寸（28×28、无边框、幽灵底），
           只放 Σ 字形，完整名字走 title / aria-label。别再用 .dshtt-btn 那种带文字的胶囊，
           那会把 utilities 行撑宽、把右侧的图标按钮挤开（2026-11-13 主人反馈）。 */
        ".dshtt-hbtn{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;",
        "width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;",
        "color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:14px;line-height:1;",
        "cursor:pointer;transition:background .12s ease,color .12s ease}",
        ".dshtt-hbtn>span{display:block;transform:translateY(-.5px)}",
        ".dshtt-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));",
        "color:var(--dsw-alias-label-primary,inherit)}",

        /* focus 环统一 */
        ".dshtt-hbtn:focus-visible,.dshtt-ico:focus-visible,.dshtt-btn:focus-visible,",
        ".dshtt-seg button:focus-visible,.dshtt-row:focus-visible{",
        "outline:2px solid var(--dsw-alias-brand-primary,#4d7cfe);outline-offset:1px}",

        /* body / card */
        ".dshtt-body{flex:1;min-height:0;overflow:auto;padding:8px 10px 12px;scrollbar-gutter:stable}",
        ".dshtt-card{box-sizing:border-box;margin:0 0 8px;padding:9px 10px 10px;border-radius:10px;",
        "border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));",
        "background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05))}",
        ".dshtt-card:last-child{margin-bottom:0}",
        ".dshtt-card-h{display:flex;align-items:center;gap:6px;margin-bottom:7px;",
        "font-size:10.5px;font-weight:500;color:var(--dsw-alias-label-secondary,inherit)}",

        /* 合计 */
        ".dshtt-total{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 8px}",
        ".dshtt-total b{font-size:25px;font-weight:650;line-height:1.15;letter-spacing:-.02em;",
        "font-variant-numeric:tabular-nums}",
        ".dshtt-total em{font-style:normal;font-size:11px;",
        "color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit))}",

        /* 四个小格 */
        ".dshtt-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(62px,1fr));gap:5px;margin-top:9px}",
        ".dshtt-tile{min-width:0;padding:5px 7px;border-radius:7px;",
        "background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}",
        ".dshtt-tile-v{font-size:14.5px;font-weight:650;line-height:1.25;letter-spacing:-.01em;",
        "font-variant-numeric:tabular-nums;white-space:nowrap}",
        ".dshtt-tile-l{font-size:10px;color:var(--dsw-alias-label-secondary,inherit);",
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".dshtt-tile[data-tone='cache'] .dshtt-tile-v{color:var(--dshtt-cache)}",

        /* 组成条 + 图例 */
        ".dshtt-comp{display:flex;gap:1px;height:7px;margin:2px 0 8px;border-radius:4px;overflow:hidden;",
        "background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}",
        ".dshtt-comp i{display:block;height:100%;min-width:1px}",
        ".dshtt-legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(116px,1fr));gap:1px 12px}",
        ".dshtt-chip{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px}",
        ".dshtt-chip i{flex:none;width:8px;height:8px;border-radius:2px}",
        ".dshtt-chip span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        "color:var(--dsw-alias-label-secondary,inherit)}",
        ".dshtt-chip b{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}",
        ".dshtt-chip u{text-decoration:none;font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap;",
        "color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit))}",

        /* 根自身 / 子代理拆分 */
        ".dshtt-split{display:flex;flex-direction:column;gap:6px;margin-top:10px}",
        ".dshtt-split-row{display:grid;grid-template-columns:1fr auto 40px;align-items:baseline;gap:8px;font-size:11px}",
        ".dshtt-split-k{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        "color:var(--dsw-alias-label-secondary,inherit)}",
        ".dshtt-split-v{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}",
        ".dshtt-split-p{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;",
        "color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit))}",
        ".dshtt-split-bar{height:2px;margin-top:-3px;border-radius:1px;overflow:hidden;",
        "background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}",
        ".dshtt-split-bar i{display:block;height:100%;border-radius:1px;",
        "background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit))}",

        /* 树 */
        ".dshtt-tree{display:flex;flex-direction:column;gap:1px}",
        ".dshtt-row{box-sizing:border-box;padding:4px 6px 5px;border-radius:6px;",
        "transition:background .12s ease}",
        ".dshtt-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}",
        ".dshtt-row[data-root='1']{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}",
        ".dshtt-line{display:flex;align-items:baseline;gap:3px;min-width:0}",
        ".dshtt-twisty{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;",
        "width:14px;height:14px;padding:0;border:0;border-radius:4px;background:transparent;",
        "color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));",
        "font:inherit;font-size:9px;line-height:1;cursor:pointer}",
        ".dshtt-twisty:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));",
        "color:var(--dsw-alias-label-primary,inherit)}",
        // 叶子行的占位：和 twisty 同宽，让所有名字左对齐；不放字形，空着更干净。
        ".dshtt-leaf{flex:none;width:14px;height:14px}",
        ".dshtt-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dshtt-row[data-root='1'] .dshtt-name{font-weight:600}",
        ".dshtt-val{margin-left:auto;padding-left:8px;font-size:11.5px;font-weight:600;",
        "font-variant-numeric:tabular-nums;white-space:nowrap}",
        // meta 要和「名字」对齐（跳过 twisty 那 17px），否则会显得比名字更靠左。
        ".dshtt-meta{display:flex;gap:8px;margin-left:17px;margin-top:1px;font-size:10px;",
        "color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));",
        "white-space:nowrap;overflow:hidden}",
        ".dshtt-meta>span{min-width:0;overflow:hidden;text-overflow:ellipsis}",
        ".dshtt-meta .dshtt-hit{color:var(--dshtt-cache)}",

        /* 提示条 */
        ".dshtt-note{display:flex;gap:6px;margin:0 0 8px;padding:6px 8px;border-radius:8px;",
        "background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));",
        "color:var(--dsw-alias-label-secondary,inherit);font-size:10.5px;line-height:1.45}",
        ".dshtt-note>i{font-style:normal;flex:none;color:var(--dsw-alias-state-warn-primary,#d99a2b)}",

        /* 空 / 加载 / 错误 */
        ".dshtt-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 8px;",
        "color:var(--dsw-alias-label-secondary,inherit);font-size:11.5px;text-align:center}",
        ".dshtt-empty>i{font-style:normal;font-size:20px;opacity:.5}",
        ".dshtt-skel{display:flex;flex-direction:column;gap:8px;padding:2px 0 8px}",
        ".dshtt-skel>span{display:block;height:9px;border-radius:5px;",
        "background:linear-gradient(90deg,transparent,rgba(128,128,128,.18),transparent);",
        "background-size:200% 100%;animation:dshtt-sh 1.15s linear infinite}",
        ".dshtt-skel>span:nth-child(2){width:72%}",
        ".dshtt-skel>span:nth-child(3){width:88%}",
        ".dshtt-skel>span:nth-child(4){width:56%}",
        "@keyframes dshtt-sh{0%{background-position:150% 0}100%{background-position:-50% 0}}",
        "@media (prefers-reduced-motion:reduce){.dshtt-skel>span{animation:none}}",
        ".dshtt-err{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:11px;",
        "word-break:break-all;padding:0 2px 8px}",
      ].join("");

      function installStyles() {
        if (typeof document === "undefined") return function () {};
        var existing = document.querySelector('style[data-plugin-css="' + PLUGIN + '"]');
        if (existing && existing.parentNode) {
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

      /* ----------------------------------------------------------------- fmt */
      var nf = new Intl.NumberFormat("en-US");
      function fmt(n) {
        if (typeof n !== "number" || !isFinite(n)) return "—";
        return nf.format(n);
      }
      function short(n) {
        if (typeof n !== "number" || !isFinite(n)) return "—";
        if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
        if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
        if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
        return String(n);
      }
      function pct(part, whole) {
        if (!whole || !isFinite(whole) || whole <= 0) return "—";
        var v = (part / whole) * 100;
        if (v > 0 && v < 0.1) return "<0.1%";
        return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "%";
      }
      function ratio(part, whole) {
        if (!whole || !isFinite(whole) || whole <= 0) return 0;
        var v = part / whole;
        return v < 0 ? 0 : v > 1 ? 1 : v;
      }
      /** 缓存命中率 = 缓存读 /（缓存读 + 未缓存输入）。分母为 0 时返回 null。 */
      function hitRate(node) {
        var cached = (node && node.cacheRead) || 0;
        var uncached = (node && node.input) || 0;
        var denom = cached + uncached;
        if (!denom) return null;
        return cached / denom;
      }
      function hitText(node, digits) {
        var r = hitRate(node);
        if (r === null) return "—";
        var v = r * 100;
        var d = typeof digits === "number" ? digits : 1;
        if (v >= 100 - Math.pow(10, -d - 1)) return "100%";
        return v.toFixed(d) + "%";
      }

      /* ----------------------------------------------------------------- api */
      function api(path) {
        return fetch(API + path, { headers: { accept: "application/json" } }).then(function (res) {
          return res.json().then(
            function (body) {
              if (!body || body.ok !== true) throw new Error((body && body.error) || "HTTP " + res.status);
              return body.data;
            },
            function () {
              throw new Error("HTTP " + res.status);
            }
          );
        });
      }

      /* ------------------------------------------------------------- 树形渲染 */
      function flattenTree(node, depth, out, collapsed) {
        out.push({ node: node, depth: depth });
        var kids = Array.isArray(node.children) ? node.children : [];
        if (collapsed && collapsed[node.id]) return out;
        for (var i = 0; i < kids.length; i++) flattenTree(kids[i], depth + 1, out, collapsed);
        return out;
      }

      function treeToText(node, prefix, isLast, lines) {
        var label = node.title || node.id;
        lines.push(
          prefix + (prefix === "" ? "" : isLast ? "└─ " : "├─ ") + label +
            "  billed " + fmt(node.billed) + "  命中 " + hitText(node) +
            "  (" + node.count + (LANG === "zh" ? " 个代理" : " agent" + (node.count > 1 ? "s" : "")) + ")"
        );
        var kids = Array.isArray(node.children) ? node.children : [];
        var next = prefix + (prefix === "" ? "" : isLast ? "   " : "│  ");
        for (var i = 0; i < kids.length; i++) treeToText(kids[i], next, i === kids.length - 1, lines);
        return lines;
      }

      /* ------------------------------------------------------------- 组件 */
      function CardHeader(props) {
        return h(
          "div",
          { className: "dshtt-card-h" },
          h("span", null, props.label),
          props.aside ? h("span", { className: "dshtt-push" }, props.aside) : null
        );
      }

      function Tile(props) {
        return h(
          "div",
          { className: "dshtt-tile", "data-tone": props.tone || undefined, title: props.tip || undefined },
          h("div", { className: "dshtt-tile-v" }, props.value),
          h("div", { className: "dshtt-tile-l" }, props.label)
        );
      }

      function Composition(props) {
        var parts = props.parts.filter(function (p) {
          return (p.value || 0) > 0;
        });
        if (parts.length === 0) return null;
        return h(
          "div",
          null,
          h(
            "div",
            {
              className: "dshtt-comp",
              role: "img",
              "aria-label": parts
                .map(function (p) {
                  return p.label + " " + pct(p.value, props.total);
                })
                .join("，"),
            },
            parts.map(function (p) {
              return h("i", {
                key: p.key,
                title: p.label + " " + fmt(p.value),
                style: { width: ratio(p.value, props.total) * 100 + "%", background: p.color },
              });
            })
          ),
          h(
            "div",
            { className: "dshtt-legend" },
            parts.map(function (p) {
              return h(
                "div",
                { className: "dshtt-chip", key: p.key, title: p.label + " " + fmt(p.value) },
                h("i", { style: { background: p.color } }),
                h("span", null, p.label),
                h("b", null, short(p.value)),
                h("u", null, pct(p.value, props.total))
              );
            })
          )
        );
      }

      function SplitRow(props) {
        return h(
          "div",
          null,
          h(
            "div",
            { className: "dshtt-split-row" },
            h("span", { className: "dshtt-split-k" }, props.label),
            h("span", { className: "dshtt-split-v", title: fmt(props.value) }, short(props.value)),
            h("span", { className: "dshtt-split-p" }, pct(props.value, props.total))
          ),
          h("div", { className: "dshtt-split-bar" }, h("i", { style: { width: ratio(props.value, props.total) * 100 + "%" } }))
        );
      }

      function TreeRow(props) {
        var node = props.node;
        var depth = props.depth;
        var total = props.total;
        var metric = props.metric === "fresh" ? "fresh" : "billed";
        // 数字与百分比必须同口径：都用当前 metric，否则会推出 1804% 这种值。
        var value = metric === "fresh" ? node.fresh : node.billed;
        var isRoot = depth === 0;
        var kids = Array.isArray(node.children) ? node.children : [];
        var open = !(props.collapsed && props.collapsed[node.id]);
        var label = node.title || String(node.id || "").slice(0, 26);

        return h(
          "div",
          {
            className: "dshtt-row",
            "data-root": isRoot ? "1" : "0",
            "data-depth": String(depth),
            style: { paddingLeft: 6 + depth * 11 + "px" },
            title: (node.title || node.id) + "\n" + TEXT.billedLong + "：" + fmt(node.billed) +
              "\n" + TEXT.cacheRead + "：" + fmt(node.cacheRead) + "\n" +
              TEXT.input + "：" + fmt(node.input) + "\n" + TEXT.output + "：" + fmt(node.output) +
              "\n" + TEXT.hit + "：" + hitText(node),
          },
          h(
            "div",
            { className: "dshtt-line" },
            kids.length > 0
              ? h(
                  "button",
                  {
                    className: "dshtt-twisty",
                    type: "button",
                    "data-on": open ? "1" : "0",
                    title: open ? TEXT.collapse : TEXT.expand,
                    "aria-label": (open ? TEXT.collapse : TEXT.expand) + " " + label,
                    "aria-expanded": open ? "true" : "false",
                    onClick: function (e) {
                      e.stopPropagation();
                      props.onToggle(node.id);
                    },
                  },
                  open ? "▾" : "▸"
                )
              : h("span", { className: "dshtt-leaf", "aria-hidden": "true" }),
            h("span", { className: "dshtt-name" }, label),
            h("span", { className: "dshtt-val", title: fmt(value) }, short(value))
          ),
          h(
            "div",
            { className: "dshtt-meta" },
            h("span", null, node.count + " " + TEXT.agents),
            h("span", null, node.steps + " " + TEXT.steps),
            h("span", null, node.requests + " " + TEXT.requests),
            h("span", { className: "dshtt-hit", title: TEXT.hitTip }, TEXT.hitShort + " " + hitText(node))
          )
        );
      }

      function Loading(props) {
        return h(
          "div",
          { className: "dshtt" },
          props.head,
          h(
            "div",
            { className: "dshtt-body" },
            h(
              "div",
              { className: "dshtt-card" },
              h("div", { className: "dshtt-skel" }, h("span", null), h("span", null), h("span", null), h("span", null))
            ),
            h("p", { className: "dshtt-empty" }, props.label)
          )
        );
      }

      function TokenTreePane(props) {
        var sessionId = props && props.sessionId;
        var state = React.useState({ loading: true, data: null, error: null });
        var snap = state[0];
        var setSnap = state[1];
        var modeState = React.useState("billed");
        var mode = modeState[0];
        var setMode = modeState[1];
        var autoState = React.useState(true);
        var auto = autoState[0];
        var setAuto = autoState[1];
        var copyState = React.useState(false);
        var copied = copyState[0];
        var setCopied = copyState[1];
        var collapsedState = React.useState({});
        var collapsed = collapsedState[0];
        var setCollapsed = collapsedState[1];
        var alive = React.useRef(true);

        React.useEffect(function () {
          alive.current = true;
          return function () {
            alive.current = false;
          };
        }, []);

        function load() {
          if (!sessionId) {
            setSnap({ loading: false, data: null, error: null });
            return;
          }
          setSnap(function (s) {
            return { loading: s.data === null, data: s.data, error: null };
          });
          api("/tree?sessionId=" + encodeURIComponent(sessionId)).then(
            function (data) {
              if (!alive.current) return;
              setSnap({ loading: false, data: data, error: null });
            },
            function (err) {
              if (!alive.current) return;
              setSnap({ loading: false, data: null, error: String((err && err.message) || err) });
            }
          );
        }

        React.useEffect(load, [sessionId]);

        React.useEffect(
          function () {
            if (!auto || !sessionId) return;
            var timer = setInterval(load, REFRESH_MS);
            return function () {
              clearInterval(timer);
            };
          },
          [auto, sessionId]
        );

        function toggleNode(id) {
          var next = {};
          for (var k in collapsed) if (collapsed[k]) next[k] = true;
          if (next[id]) delete next[id];
          else next[id] = true;
          setCollapsed(next);
        }

        var tree = snap.data && snap.data.tree ? snap.data.tree : null;

        function copyTree() {
          if (!tree) return;
          var text = treeToText(tree, "", true, []).join("\n");
          try {
            navigator.clipboard.writeText(text).then(
              function () {
                setCopied(true);
                setTimeout(function () {
                  if (alive.current) setCopied(false);
                }, 1500);
              },
              function () {}
            );
          } catch {
            /* ignore */
          }
        }

        var head = h(
          "div",
          { className: "dshtt-head" },
          h("span", { className: "dshtt-title" }, TEXT.title),
          tree
            ? h(
                "span",
                { className: "dshtt-seg", role: "group", title: TEXT.billedLong },
                h(
                  "button",
                  { type: "button", "data-on": mode === "billed" ? "1" : "0", title: TEXT.billedLong, onClick: function () { setMode("billed"); } },
                  LANG === "zh" ? "计费" : "billed"
                ),
                h(
                  "button",
                  { type: "button", "data-on": mode === "fresh" ? "1" : "0", title: TEXT.freshLong, onClick: function () { setMode("fresh"); } },
                  LANG === "zh" ? "新增" : "fresh"
                )
              )
            : null,
          h(
            "button",
            {
              className: "dshtt-ico",
              type: "button",
              "data-on": auto ? "1" : "0",
              title: TEXT.autoRefreshTip,
              "aria-pressed": auto ? "true" : "false",
              onClick: function () {
                setAuto(!auto);
              },
            },
            "◷"
          ),
          h("button", { className: "dshtt-ico", type: "button", title: TEXT.refresh, onClick: load, disabled: !sessionId }, "↻"),
          h(
            "button",
            { className: "dshtt-ico", type: "button", title: TEXT.copy, onClick: copyTree, disabled: !tree },
            copied ? "✓" : "⧉"
          )
        );

        if (!sessionId) {
          return h(
            "div",
            { className: "dshtt" },
            head,
            h("div", { className: "dshtt-body" }, h("p", { className: "dshtt-empty" }, h("i", null, "◌"), TEXT.noSession))
          );
        }

        if (snap.loading && !tree) return h(Loading, { head: head, label: TEXT.loading });

        if (snap.error) {
          return h(
            "div",
            { className: "dshtt" },
            head,
            h(
              "div",
              { className: "dshtt-body" },
              h("div", { className: "dshtt-err" }, TEXT.error + "：" + snap.error),
              h("button", { className: "dshtt-btn", type: "button", onClick: load }, TEXT.retry)
            )
          );
        }

        if (!tree) {
          return h(
            "div",
            { className: "dshtt" },
            head,
            h("div", { className: "dshtt-body" }, h("p", { className: "dshtt-empty" }, h("i", null, "◌"), TEXT.empty))
          );
        }

        var billed = mode === "billed";
        var total = billed ? tree.billed : tree.fresh;
        var selfVal = billed ? tree.selfBilled : tree.selfFresh;
        var subVal = total - selfVal;

        var parts = billed
          ? [
              { key: "input", label: TEXT.input, color: "var(--dshtt-input)", value: tree.input },
              { key: "cacheRead", label: TEXT.cacheRead, color: "var(--dshtt-cache)", value: tree.cacheRead },
              { key: "cacheWrite", label: TEXT.cacheWrite, color: "var(--dshtt-write)", value: tree.cacheWrite },
              { key: "output", label: TEXT.output, color: "var(--dshtt-output)", value: tree.output },
            ]
          : [
              { key: "input", label: TEXT.input, color: "var(--dshtt-input)", value: tree.input },
              { key: "output", label: TEXT.output, color: "var(--dshtt-output)", value: tree.output },
            ];

        var rows = flattenTree(tree, 0, [], collapsed);

        var body = h(
          "div",
          { className: "dshtt-body" },
          snap.data && snap.data.isRoot === false
            ? h("div", { className: "dshtt-note" }, h("i", null, "⚠"), h("span", null, TEXT.notRoot))
            : null,

          /* 1) 合计 */
          h(
            "div",
            { className: "dshtt-card" },
            h(CardHeader, { label: TEXT.grandTotal, aside: fmt(total) }),
            h(
              "div",
              { className: "dshtt-total" },
              h("b", null, short(total)),
              h("em", null, billed ? TEXT.billed : TEXT.fresh)
            ),
            h(
              "div",
              { className: "dshtt-tiles" },
              h(Tile, {
                label: TEXT.hit,
                value: hitText(tree),
                tone: "cache",
                tip: TEXT.hitTip + "（" + fmt(tree.cacheRead) + " / " + fmt((tree.cacheRead || 0) + (tree.input || 0)) + "）",
              }),
              h(Tile, { label: TEXT.agents, value: String(tree.count) }),
              h(Tile, { label: TEXT.steps, value: String(tree.steps) }),
              h(Tile, { label: TEXT.requests, value: String(tree.requests) })
            ),
            h(
              "div",
              { className: "dshtt-split" },
              h(SplitRow, { label: TEXT.rootSelf, value: selfVal, total: total }),
              h(SplitRow, { label: TEXT.subTotal, value: subVal, total: total })
            )
          ),

          /* 2) 组成 */
          h(
            "div",
            { className: "dshtt-card" },
            h(CardHeader, { label: TEXT.composition }),
            h(Composition, { parts: parts, total: total })
          ),

          tree.compactionRequests
            ? h(
                "div",
                { className: "dshtt-note" },
                h("i", null, "⚠"),
                h(
                  "span",
                  null,
                  tpl(
                    TEXT.compaction,
                    tree.compactionRequests,
                    short(tree.compactionBilled),
                    pct(tree.compactionBilled, tree.billed)
                  )
                )
              )
            : null,

          /* 3) 树 */
          h(
            "div",
            { className: "dshtt-card" },
            h(CardHeader, {
              label: TEXT.tree,
              aside: tree.count + " " + TEXT.agents,
            }),
            h(
              "div",
              { className: "dshtt-tree" },
              rows.map(function (r, i) {
                return h(TreeRow, {
                  key: r.node.id + ":" + i,
                  node: r.node,
                  depth: r.depth,
                  total: total,
                  metric: mode,
                  collapsed: collapsed,
                  onToggle: toggleNode,
                });
              })
            )
          )
        );

        return h("div", { className: "dshtt" }, head, body);
      }

      /* ---------------------------------------------------------------- apply */
      function apply(ctx) {
        ctx.effect(installStyles, PLUGIN + ": styles");

        // 1) 注册 tab 类型（静态声明）。
        ctx.effect(
          function () {
            return ctx.sidebarRightTabs.register({
              id: TYPE_ID,
              kind: KIND,
              title: function () {
                return TEXT.tabTitle;
              },
              guide: [
                {
                  id: TYPE_ID,
                  order: 60,
                  title: function () {
                    return TEXT.tabTitle;
                  },
                  description: function () {
                    return LANG === "zh"
                      ? "父代理与全部子孙代理的 token 汇总，含缓存命中率"
                      : "Token totals for the parent agent and all its subagents, with cache hit rate";
                  },
                },
              ],
            });
          },
          PLUGIN + ": tab type"
        );

        // 2) 注册正文。
        ctx.effect(
          function () {
            return ctx.slots.inject("sidebar.right.pane.tab", function () {
              return ctx.slots.register(
                { name: "sidebar.right.pane.tab", key: TYPE_ID },
                function (props) {
                  // 侧栏正文的 owner props 直接带 sessionId。
                  var sid = (props && props.sessionId) || null;
                  return h(TokenTreePane, { sessionId: sid });
                }
              );
            });
          },
          PLUGIN + ": tab body"
        );

        // 3) 会话标题栏放一个入口按钮：点一下在最右侧栏打开本页。
        ctx.effect(
          function () {
            return ctx.slots.inject("conversation.session.header.utilities", function () {
              return ctx.slots.register(
                { name: "conversation.session.header.utilities", id: PLUGIN, order: 32, label: TEXT.title },
                function (props) {
                  return h(
                    "button",
                    {
                      className: "dshtt-hbtn",
                      type: "button",
                      title: TEXT.title,
                      "aria-label": TEXT.title,
                      onClick: function () {
                        try {
                          ctx.sidebarRight.openTab(KIND, {});
                        } catch {
                          /* 没有右侧栏时无操作 */
                        }
                      },
                    },
                    h("span", null, "Σ")
                  );
                }
              );
            });
          },
          PLUGIN + ": header button"
        );

        return function () {};
      }

      exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
      exports.apply = apply;
      return module.exports;
    },
  });
}
