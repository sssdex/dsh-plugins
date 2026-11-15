// dsh-pdfium-preview — browser half.
//
// Registers a second `documentPreviews` implementation for `.pdf`. The registry ranks
// a non-"builtin" priority above the shipped pdf.js body, so PDFs open here by default
// while the stock PDF.js body stays available from the reader dropdown as a fallback.
//
// The heavy parts live in two lazy `client.*` chunks so nothing pays for them unless a
// PDF is actually opened:
//   client.viewer.js  — the React reader (page scheduler, text layer, zoom)
//   client.pdfium.js  — PDFium WASM + its emscripten glue (wasm inlined as base64,
//                       because the /plugins route only serves `client.*.js`)
(() => {
  window.__ModuleLoader__.load({
    id: "dsh-pdfium-preview",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      var react = require("react");
      var h = react.createElement;

      var PLUGIN_ID = "dsh-pdfium-preview";
      var BODY_ID = "dsh-pdfium-preview/pdf";
      var NS = "dshPdfiumPreview";
      var inject = ["slots"];

      // ── engine: one PDFium instance per renderer process, ever ──────────────
      var enginePromise = null;
      function loadEngine() {
        if (enginePromise === null) {
          var started = require
            .async("./client.pdfium.js")
            .then(function (mod) {
              var bytes = mod.__wasmBytes();
              return mod.PDFiumLibrary.init({ wasmBinary: bytes.buffer }).then(function (library) {
                return { library: library, module: mod };
              });
            });
          enginePromise = started;
          started.catch(function () {
            // a failed init must not poison later attempts (e.g. a transient OOM)
            if (enginePromise === started) enginePromise = null;
          });
        }
        return enginePromise;
      }
      // Warm the engine while the app is idle so the first PDF opens without the
      // ~300ms wasm cold start. Nothing is fetched until the browser is idle.
      var warmed = false;
      function prewarm() {
        if (warmed) return;
        warmed = true;
        loadEngine().catch(function (error) {
          console.warn("[dsh-pdfium-preview] prewarm failed", error);
        });
      }
      function schedulePrewarm() {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(function () { prewarm(); }, { timeout: 4000 });
        } else {
          setTimeout(prewarm, 2000);
        }
      }

      // ── viewer chunk ────────────────────────────────────────────────────────
      var viewerPromise = null;
      function loadViewer() {
        if (viewerPromise === null) viewerPromise = require.async("./client.viewer.js");
        return viewerPromise;
      }
      var LazyViewer = react.lazy(function () {
        return loadViewer().then(function (chunk) { return { default: chunk.PdfiumBody }; });
      });

      function Status(props) {
        return h(
          "div",
          { className: "dsh-pdfium-status", role: props.role || "status" },
          h("span", null, props.text)
        );
      }

      // Resolves the engine, then hands off to the viewer chunk. Until both are up
      // the pane keeps showing its own loading surface.
      function PdfiumBody(props) {
        var state = react.useState({ kind: "loading" });
        var load = state[0];
        var setLoad = state[1];
        react.useEffect(function () {
          var alive = true;
          loadEngine().then(
            function (engine) {
              if (alive) setLoad({ kind: "ready", engine: engine });
            },
            function (error) {
              if (alive) setLoad({ kind: "failed", error: error });
            }
          );
          return function () { alive = false; };
        }, []);
        var t = typeof props.t === "function" ? props.t : function (key) { return key; };
        if (load.kind === "loading") return props.loading !== undefined ? props.loading : h(Status, { text: t("engineLoading") });
        if (load.kind === "failed")
          return h(Status, {
            role: "alert",
            text: t("engineFailed", { message: load.error instanceof Error ? load.error.message : String(load.error) })
          });
        return h(
          react.Suspense,
          { fallback: props.loading !== undefined ? props.loading : h(Status, { text: t("viewerLoading") }) },
          h(LazyViewer, Object.assign({}, props, { engine: load.engine }))
        );
      }

      // ── registration ────────────────────────────────────────────────────────
      var DICTIONARIES = {
        zh: {
          title: "PDF（快速）",
          engineLoading: "正在启动 PDF 引擎…",
          engineFailed: "PDF 引擎加载失败：{message}",
          viewerLoading: "正在打开…",
          page: "第 {page} / {count} 页",
          pageFailed: "第 {page} 页渲染失败",
          zoomIn: "放大",
          zoomOut: "缩小",
          zoomFit: "适应宽度",
          retry: "重试",
          password: "该 PDF 需要密码。",
          failed: "无法打开 PDF：{message}"
        },
        en: {
          title: "PDF (fast)",
          engineLoading: "Starting the PDF engine…",
          engineFailed: "Could not load the PDF engine: {message}",
          viewerLoading: "Opening…",
          page: "Page {page} of {count}",
          pageFailed: "Page {page} failed to render",
          zoomIn: "Zoom in",
          zoomOut: "Zoom out",
          zoomFit: "Fit width",
          retry: "Retry",
          password: "This PDF is password protected.",
          failed: "Could not open the PDF: {message}"
        }
      };

      function definition(title) {
        return {
          id: BODY_ID,
          extensions: ["pdf"],
          binaryExtensions: ["pdf"],
          priority: "extension",
          title: title,
          // the pane reads the whole file before mounting the body; PDFium needs the
          // complete buffer anyway, and this keeps the error path in the host reader.
          loading: "bytes-complete",
          wrap: false
        };
      }

      function apply(ctx) {
        if (ctx.locale !== undefined && typeof ctx.locale.register === "function") {
          ctx.effect(function () { return ctx.locale.register(NS, DICTIONARIES); }, PLUGIN_ID + ": dictionaries");
        }
        var t = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : function (key) { return key; };

        // `documentPreviews` is provided through the reflect scope, so resolve it
        // through every supported door and retry briefly while plugins boot.
        var settled = false;
        var attempts = 0;
        function registry() {
          try {
            var direct = ctx.get?.("documentPreviews");
            if (direct) return direct;
          } catch (error) { /* reflect scoped: fall through */ }
          try {
            var reflected = ctx.reflect?.get?.("documentPreviews");
            if (reflected) return reflected;
          } catch (error) { /* not ready yet */ }
          return undefined;
        }
        function settle() {
          if (settled) return;
          var previews = registry();
          if (previews === undefined || typeof previews.register !== "function") {
            attempts += 1;
            if (attempts < 40) setTimeout(settle, 250);
            return;
          }
          settled = true;
          ctx.effect(function () {
            return previews.register(definition(function () { return t("title"); }));
          }, PLUGIN_ID + ": pdf metadata");
          if (ctx.slots !== undefined && typeof ctx.slots.inject === "function") {
            ctx.effect(
              function () {
                return ctx.slots.inject("sidebar.right.tab.document", function () {
                  return ctx.slots.register(
                    { name: "sidebar.right.tab.document", key: BODY_ID, locale: NS },
                    PdfiumBody
                  );
                });
              },
              PLUGIN_ID + ": pdf body"
            );
          } else {
            console.warn("[dsh-pdfium-preview] slots service unavailable");
          }
          schedulePrewarm();
        }
        settle();
      }

      exports.name = PLUGIN_ID;
      exports.inject = inject;
      exports.apply = apply;
      exports.__test = { definition: definition, BODY_ID: BODY_ID };
      return module.exports;
    }
  });
})();
