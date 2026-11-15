// dsh-pdfium-preview — lazy viewer chunk (`client.viewer.js`).
//
// Why this is fast where the stock pdf.js body is slow:
//  * pages are rasterised by PDFium itself (C++, ~15-30ms/page) instead of being
//    parsed + painted by pdf.js in JS on the main thread;
//  * only pages near the viewport are ever rasterised (IntersectionObserver with a
//    generous rootMargin), and PDFium work is serialised behind one queue so the
//    main thread is never asked to run two rasterisations at once;
//  * the bitmap goes straight into the visible canvas — no offscreen canvas +
//    drawImage hop;
//  * the device-pixel budget is capped, so a 4x zoom on a big page cannot allocate
//    a 150-megapixel backing store;
//  * the text layer is built once at page scale and zoomed with a CSS transform, so
//    changing zoom never re-extracts text.
(() => {
  window.__ModuleLoader__.load({
    id: "dsh-pdfium-preview/client.viewer.js",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      var react = require("react");
      var h = react.createElement;
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var useMemo = react.useMemo;
      var useCallback = react.useCallback;

      var PADDING = 16;
      var PAGE_GAP = 12;
      // 16.7 M device pixels ≈ 4096². Above this a page is rasterised at a lower
      // scale and upscaled by CSS — far cheaper than allocating hundreds of MB.
      var MAX_PIXELS = 16 * 1024 * 1024;
      var MIN_ZOOM = 0.1;
      var MAX_ZOOM = 8;
      var IDLE_EVICT_MS = 4000;

      var CSS = [
        ".dsh-pdfium-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#33383d;color:#e9edf2;font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}",
        ".dsh-pdfium-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:12px 0 20px}",
        ".dsh-pdfium-stack{display:flex;flex-direction:column;align-items:center;gap:12px}",
        ".dsh-pdfium-page{position:relative;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.45);overflow:hidden}",
        ".dsh-pdfium-page>canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}",
        ".dsh-pdfium-text{position:absolute;left:0;top:0;transform-origin:0 0;user-select:text;-webkit-user-select:text;cursor:text}",
        ".dsh-pdfium-text>span{position:absolute;color:transparent;white-space:pre;transform-origin:0 0;pointer-events:auto}",
        ".dsh-pdfium-text ::selection{background:rgba(56,132,255,.35)}",
        ".dsh-pdfium-skel{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#8b949e;background:#f6f7f9}",
        ".dsh-pdfium-spin{width:18px;height:18px;border-radius:50%;border:2px solid rgba(120,132,148,.35);border-top-color:#4a90e2;animation:dsh-pdfium-rot .8s linear infinite}",
        "@keyframes dsh-pdfium-rot{to{transform:rotate(360deg)}}",
        ".dsh-pdfium-bar{position:absolute;right:14px;bottom:12px;display:flex;align-items:center;gap:2px;padding:3px;border-radius:8px;background:rgba(24,28,33,.86);box-shadow:0 2px 10px rgba(0,0,0,.4);backdrop-filter:blur(6px);z-index:4}",
        ".dsh-pdfium-bar button{all:unset;cursor:pointer;padding:4px 8px;border-radius:6px;color:#dfe6ee;font:12px/1 system-ui,sans-serif;min-width:22px;text-align:center}",
        ".dsh-pdfium-bar button:hover{background:rgba(255,255,255,.14)}",
        ".dsh-pdfium-bar button:disabled{opacity:.4;cursor:default}",
        ".dsh-pdfium-bar .dsh-pdfium-pct{min-width:44px;color:#b9c4d0;font-variant-numeric:tabular-nums}",
        ".dsh-pdfium-pages{padding:0 8px;color:#b9c4d0;font-variant-numeric:tabular-nums;min-width:76px;text-align:center}",
        ".dsh-pdfium-status{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:100%;min-height:120px;padding:24px;color:#8b949e;text-align:center}",
        ".dsh-pdfium-error{color:#f0b4b4;max-width:46ch}",
        ".dsh-pdfium-retry{all:unset;cursor:pointer;padding:5px 12px;border-radius:6px;background:rgba(255,255,255,.12);color:#e9edf2;font-size:12px}",
        ".dsh-pdfium-retry:hover{background:rgba(255,255,255,.2)}"
      ].join("");

      function ensureCss() {
        var id = "dsh-pdfium-preview-css";
        if (document.getElementById(id) !== null) return;
        var style = document.createElement("style");
        style.id = id;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
      }

      // ── helpers ──────────────────────────────────────────────────────────────
      function fmt(template, values) {
        if (typeof template !== "string") return "";
        return template.replace(/\{(\w+)\}/g, function (match, key) {
          return values !== undefined && values[key] !== undefined ? String(values[key]) : match;
        });
      }
      function messageOf(error) {
        if (error instanceof Error) return error.message;
        if (typeof error === "string") return error;
        return String(error);
      }
      var clamp = function (value, low, high) { return value < low ? low : value > high ? high : value; };

      // One arithmetic queue for the whole renderer process: PDFium is a single
      // WASM instance and its API is not re-entrant.
      var queue = Promise.resolve();
      function serial(task) {
        var run = queue.then(task, task);
        queue = run.then(function () {}, function () {});
        return run;
      }

      ensureCss();

      // ── text layer extraction (raw PDFium text API) ─────────────────────────
      // Runs inside the serial queue while the page is still open. It returns plain
      // JS run descriptors, so nothing references WASM memory afterwards.
      function readTextRuns(page) {
        var mod = page.module;
        if (mod === undefined || typeof page.loadTextPage !== "function") return [];
        var textPage;
        try {
          textPage = page.loadTextPage();
        } catch (error) {
          return [];
        }
        if (textPage === undefined || textPage === null) return [];
        var count = mod._FPDFText_CountChars(textPage);
        if (!(count > 0)) return [];
        var mem = mod.wasmExports;
        if (mem === undefined || mod.HEAPF64 === undefined) return [];
        var ptr = mem.malloc(32);
        var runs = [];
        var current = null;
        try {
          for (var index = 0; index < count; index += 1) {
            // re-derive the view: any WASM allocation may have grown the heap
            var boxes = new Float64Array(mod.HEAPF64.buffer, ptr, 4);
            var code = mod._FPDFText_GetUnicode(textPage, index);
            // control characters carry no ink and only pollute the layer
            if (!(code > 0) || code < 32) {
              current = null;
              continue;
            }
            if (!mod._FPDFText_GetCharBox(textPage, index, ptr, ptr + 8, ptr + 16, ptr + 24)) {
              current = null;
              continue;
            }
            var left = boxes[0];
            var right = boxes[1];
            var bottom = boxes[2];
            var top = boxes[3];
            var size = mod._FPDFText_GetFontSize(textPage, index);
            if (!(size > 0)) size = top - bottom;
            if (!(size > 0)) size = 12;
            var glyph = String.fromCodePoint(code);
            var x = left;
            var y = top; // PDF space: y grows upwards, flipped once when painting
            var width = right - left;
            if (width < 0) width = 0;
            if (current !== null) {
              var gap = x - (current.x + current.width);
              var sameLine = Math.abs(y - current.y) <= Math.max(1, size * 0.25);
              var sameSize = Math.abs(size - current.size) <= Math.max(0.5, size * 0.08);
              if (!sameLine || !sameSize || gap > size * 0.6 || gap < -size * 0.8) {
                // Keep a real space where the visual gap is wide, so copying words
                // keeps them apart. Only at a run break, so it cannot shift glyphs.
                if (gap > size * 0.3 && !/\s$/.test(current.text)) current.text += " ";
                current = null;
              }
            }
            if (current === null) {
              current = { x: x, y: y, size: size, width: width, text: glyph };
              runs.push(current);
            } else {
              current.text += glyph;
              current.width = x + width - current.x;
            }
          }
        } finally {
          try { mem.free(ptr); } catch (error) { /* ignore */ }
        }
        return runs;
      }

      // Paints the transparent, selectable text over the bitmap. `layerScale` is the
      // CSS scale already applied to the layer, so the horizontal fit can be measured
      // in page units regardless of the current zoom.
      function paintText(layer, runs, pageWidth, pageHeight, layerScale) {
        if (layer === null) return;
        layer.textContent = "";
        if (runs.length === 0) return;
        var fragment = document.createDocumentFragment();
        for (var i = 0; i < runs.length; i += 1) {
          var run = runs[i];
          // PDF text matrices use a bottom-left origin, the DOM a top-left one.
          var span = document.createElement("span");
          span.textContent = run.text;
          span.style.left = run.x.toFixed(2) + "px";
          span.style.top = (pageHeight - run.y).toFixed(2) + "px";
          span.style.fontSize = run.size.toFixed(2) + "px";
          span.style.lineHeight = "1";
          fragment.appendChild(span);
        }
        layer.appendChild(fragment);
        // Squeeze or stretch each run onto its PDF box: the DOM font is not the
        // embedded font, so the advance widths rarely match exactly.
        var scale = layerScale > 0 ? layerScale : 1;
        var spans = layer.children;
        for (var index = 0; index < spans.length; index += 1) {
          var element = spans[index];
          var target = runs[index].width;
          if (!(target > 0)) continue;
          var actual = element.getBoundingClientRect().width / scale;
          if (!(actual > 0)) continue;
          var ratio = target / actual;
          if (Math.abs(ratio - 1) > 0.02) element.style.transform = "scaleX(" + ratio.toFixed(3) + ")";
        }
      }

      function paintBitmap(canvas, out) {
        if (canvas === null) return;
        if (canvas.width !== out.width) canvas.width = out.width;
        if (canvas.height !== out.height) canvas.height = out.height;
        var pixels = out.data;
        // out.data is already a JS-side copy; wrap it instead of copying again.
        var view = pixels instanceof Uint8ClampedArray
          ? pixels
          : new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        var context = canvas.getContext("2d", { alpha: false });
        if (context === null) return;
        context.putImageData(new ImageData(view, out.width, out.height), 0, 0);
      }

      function deviceScale(zoom, pageWidth, pageHeight) {
        if (!(pageWidth > 0) || !(pageHeight > 0)) return 1;
        var dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
        var scale = zoom * dpr;
        var area = pageWidth * scale * pageHeight * scale;
        if (area > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (pageWidth * pageHeight));
        return Math.round(clamp(scale, 0.05, 16) * 100) / 100;
      }

      // ── one page ─────────────────────────────────────────────────────────────
      function PageView(props) {
        var index = props.index;
        var doc = props.doc;
        var size = props.size;
        var zoom = props.zoom;
        var width = size !== undefined ? size.originalWidth : 600;
        var height = size !== undefined ? size.originalHeight : 800;
        var scale = deviceScale(zoom, width, height);

        var rootRef = useRef(null);
        var canvasRef = useRef(null);
        var textRef = useRef(null);
        var state = useState({ phase: "idle" });
        var render = state[0];
        var setRender = state[1];
        var visibleState = useState(false);
        var visible = visibleState[0];
        var setVisible = visibleState[1];
        var builtRef = useRef({ scale: 0, text: false });
        var tokenRef = useRef(0);

        // Visibility: a 1.5-viewport margin on both sides means the next page is
        // usually already painted before it scrolls in, without rasterising the whole
        // document.
        useEffect(function () {
          var node = rootRef.current;
          if (node === null) return undefined;
          if (typeof IntersectionObserver !== "function") { setVisible(true); return undefined; }
          var observer = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i += 1) setVisible(entries[i].isIntersecting);
          }, { rootMargin: "150% 0px", threshold: 0 });
          observer.observe(node);
          return function () { observer.disconnect(); };
        }, []);

        // Rasterise when visible, and drop the bitmap again once the page has been
        // out of sight long enough — canvases are the bulk of the memory cost.
        useEffect(function () {
          if (!visible || doc === undefined || doc === null) return undefined;
          if (builtRef.current.scale === scale && builtRef.current.text) return undefined;
          var cancelled = false;
          var token = tokenRef.current + 1;
          tokenRef.current = token;
          setRender({ phase: "rendering" });
          serial(function () {
            if (cancelled || tokenRef.current !== token) return null;
            return doc.getPage(index).then(function (page) {
              if (cancelled || tokenRef.current !== token) { page.close(); return null; }
              var needsText = !builtRef.current.text;
              var runs = needsText ? readTextRuns(page) : null;
              return Promise.resolve(page.render({ scale: scale })).then(function (out) {
                page.close();
                if (cancelled || tokenRef.current !== token) return null;
                paintBitmap(canvasRef.current, out);
                if (needsText) {
                  paintText(textRef.current, runs, width, height, zoom);
                  builtRef.current.text = true;
                }
                builtRef.current.scale = scale;
                setRender({ phase: "ready" });
                return null;
              });
            });
          }).catch(function (error) {
            if (cancelled) return;
            console.error("[dsh-pdfium-preview] page " + (index + 1) + " failed", error);
            setRender({ phase: "failed", error: error });
          });
          return function () {
            cancelled = true;
            tokenRef.current = token + 1;
          };
        }, [visible, scale, doc, index, width, height]);

        useEffect(function () {
          if (visible) return undefined;
          var timer = setTimeout(function () {
            var canvas = canvasRef.current;
            if (canvas !== null && builtRef.current.scale > 0) {
              canvas.width = 1;
              canvas.height = 1;
              builtRef.current.scale = 0;
              setRender({ phase: "idle" });
            }
          }, IDLE_EVICT_MS);
          return function () { clearTimeout(timer); };
        }, [visible]);

        var pageStyle = {
          width: Math.round(width * zoom) + "px",
          height: Math.round(height * zoom) + "px"
        };
        var textStyle = {
          width: Math.round(width) + "px",
          height: Math.round(height) + "px",
          transform: "scale(" + zoom + ")"
        };
        var children = [
          h("canvas", { key: "canvas", ref: canvasRef }),
          h("div", { key: "text", className: "dsh-pdfium-text", ref: textRef, style: textStyle })
        ];
        if (render.phase !== "ready") {
          children.push(
            h(
              "div",
              { key: "skeleton", className: "dsh-pdfium-skel" },
              render.phase === "failed"
                ? h("span", { className: "dsh-pdfium-error" }, props.message("pageFailed", { page: index + 1 }))
                : h("div", { className: "dsh-pdfium-spin" })
            )
          );
        }
        return h("div", { className: "dsh-pdfium-page", ref: rootRef, style: pageStyle }, children);
      }

      // ── document body ────────────────────────────────────────────────────────
      function PdfiumBody(props) {
        var engine = props.engine;
        var content = props.content;
        var t = typeof props.t === "function" ? props.t : function (key) { return key; };
        var translate = useCallback(function (key, values) { return fmt(t(key), values); }, [t]);

        var data = content !== undefined && content !== null && content.kind === "bytes" ? content.data : undefined;

        var scrollRef = useRef(null);
        var viewportState = useState(0);
        var viewportWidth = viewportState[0];
        var setViewportWidth = viewportState[1];
        var documentState = useState({ kind: "loading" });
        var document_ = documentState[0];
        var setDocument = documentState[1];
        var sizesState = useState([]);
        var sizes = sizesState[0];
        var setSizes = sizesState[1];
        var zoomState = useState({ kind: "fit" });
        var zoomPreference = zoomState[0];
        var setZoomPreference = zoomState[1];
        var reloadState = useState(0);
        var reload = reloadState[0];
        var setReload = reloadState[1];

        // Attach our scroller as the pane scrollport so the shell can restore scroll
        // position and drive its own affordances.
        var attachScroll = useCallback(function (node) {
          scrollRef.current = node;
          var target = props.scrollportRef;
          if (typeof target === "function") target(node);
          else if (target !== undefined && target !== null && typeof target === "object") target.current = node;
        }, [props.scrollportRef]);

        useEffect(function () {
          var node = scrollRef.current;
          if (node === null) return undefined;
          var measure = function () { setViewportWidth(node.clientWidth); };
          measure();
          if (typeof ResizeObserver !== "function") {
            window.addEventListener("resize", measure);
            return function () { window.removeEventListener("resize", measure); };
          }
          var observer = new ResizeObserver(measure);
          observer.observe(node);
          return function () { observer.disconnect(); };
        }, []);

        // Load the document, then probe the first page immediately and the rest of the
        // page geometry in small idle batches. Opening never waits for the whole map.
        useEffect(function () {
          if (data === undefined || engine === undefined) return undefined;
          var cancelled = false;
          var loaded = null;
          setDocument({ kind: "loading" });
          setSizes([]);
          serial(function () {
            if (cancelled) return null;
            return engine.library.loadDocument(data instanceof Uint8Array ? data : new Uint8Array(data)).then(function (doc) {
              loaded = doc;
              if (cancelled) { doc.destroy(); return null; }
              var count = doc.getPageCount();
              if (!(count > 0)) {
                doc.destroy();
                loaded = null;
                setDocument({ kind: "failed", error: new Error("empty document") });
                return null;
              }
              return doc.getPage(0).then(function (page) {
                var first = page.getOriginalSize();
                page.close();
                if (cancelled) return null;
                var initial = new Array(count);
                initial[0] = first;
                setSizes(initial);
                setDocument({ kind: "ready", doc: doc, count: count, first: first });
                return { doc: doc, count: count };
              });
            });
          }).then(function (info) {
            if (cancelled || info === null || info === undefined) return;
            var index = 1;
            var probe = function () {
              if (cancelled || index >= info.count) return;
              var batch = [];
              for (var step = 0; step < 4 && index < info.count; step += 1, index += 1) batch.push(index);
              serial(function () {
                if (cancelled) return null;
                var doc = info.doc;
                var collected = [];
                var run = Promise.resolve();
                for (var i = 0; i < batch.length; i += 1) {
                  (function (pageIndex) {
                    run = run.then(function () {
                      if (cancelled) return null;
                      return doc.getPage(pageIndex).then(function (page) {
                        collected.push({ index: pageIndex, size: page.getOriginalSize() });
                        page.close();
                        return null;
                      });
                    });
                  })(batch[i]);
                }
                return run.then(function () {
                  if (cancelled || collected.length === 0) return null;
                  setSizes(function (previous) {
                    var next = previous.slice();
                    for (var i = 0; i < collected.length; i += 1) next[collected[i].index] = collected[i].size;
                    return next;
                  });
                  return null;
                });
              }).catch(function () { /* geometry is best effort */ });
              setTimeout(probe, 12);
            };
            setTimeout(probe, 8);
          }).catch(function (error) {
            if (cancelled) return;
            console.error("[dsh-pdfium-preview] open failed", error);
            setDocument({ kind: "failed", error: error });
          });
          return function () {
            cancelled = true;
            var doc = loaded;
            loaded = null;
            if (doc !== null) {
              serial(function () { try { doc.destroy(); } catch (error) { /* ignore */ } return null; });
            }
          };
        }, [data, engine, reload]);

        var first = document_.kind === "ready" ? document_.first : undefined;
        var count = document_.kind === "ready" ? document_.count : 0;
        var fitZoom = first !== undefined && viewportWidth > 0
          ? clamp((viewportWidth - PADDING * 2) / first.originalWidth, MIN_ZOOM, MAX_ZOOM)
          : 1;
        var zoom = zoomPreference.kind === "fit" ? fitZoom : zoomPreference.scale;

        var zoomBy = useCallback(function (factor) {
          setZoomPreference(function (previous) {
            var base = previous.kind === "fit" ? fitZoom : previous.scale;
            return { kind: "manual", scale: Math.round(clamp(base * factor, MIN_ZOOM, MAX_ZOOM) * 1000) / 1000 };
          });
        }, [fitZoom]);

        var onWheel = useCallback(function (event) {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
        }, [zoomBy]);

        useEffect(function () {
          var node = scrollRef.current;
          if (node === null) return undefined;
          node.addEventListener("wheel", onWheel, { passive: false });
          return function () { node.removeEventListener("wheel", onWheel); };
        }, [onWheel]);

        if (document_.kind === "failed") {
          var reason = messageOf(document_.error);
          var password = /password|encrypted/i.test(reason);
          return h(
            "div",
            { className: "dsh-pdfium-status" },
            h(
              "div",
              { className: "dsh-pdfium-error" },
              h("div", null, password ? t("password") : translate("failed", { message: reason })),
              h(
                "button",
                {
                  className: "dsh-pdfium-retry",
                  type: "button",
                  onClick: function () { setReload(function (value) { return value + 1; }); },
                  style: { marginTop: "10px" }
                },
                t("retry")
              )
            )
          );
        }

        var pages = [];
        if (count > 0) {
          for (var index = 0; index < count; index += 1) {
            pages.push(
              h(PageView, {
                key: index,
                index: index,
                doc: document_.doc,
                size: sizes[index],
                zoom: zoom,
                message: translate
              })
            );
          }
        }

        var percent = Math.round(zoom * 100);
        var toolbar = count > 0
          ? h(
              "div",
              { className: "dsh-pdfium-bar" },
              h("button", {
                type: "button",
                title: t("zoomOut"),
                "aria-label": t("zoomOut"),
                onClick: function () { zoomBy(1 / 1.25); }
              }, "\u2212"),
              h("span", { className: "dsh-pdfium-pct" }, percent + "%"),
              h("button", {
                type: "button",
                title: t("zoomIn"),
                "aria-label": t("zoomIn"),
                onClick: function () { zoomBy(1.25); }
              }, "+"),
              h("button", {
                type: "button",
                title: t("zoomFit"),
                "aria-label": t("zoomFit"),
                onClick: function () { setZoomPreference({ kind: "fit" }); }
              }, "\u21f2"),
              h("span", { className: "dsh-pdfium-pages" }, count + "p")
            )
          : null;

        var opening = count === 0
          ? h(
              "div",
              { className: "dsh-pdfium-status" },
              h("div", { className: "dsh-pdfium-spin" }),
              h("span", null, t("viewerLoading"))
            )
          : h("div", { className: "dsh-pdfium-stack" }, pages);

        return h(
          "div",
          { className: "dsh-pdfium-root" },
          h("div", { className: "dsh-pdfium-scroll", ref: attachScroll, style: { position: "relative" } }, opening),
          toolbar
        );
      }

      exports.PdfiumBody = PdfiumBody;
      exports.PageView = PageView;
      return module.exports;
    }
  });
})();
