# dsh-pdfium-preview

侧边栏 PDF 快速预览插件：用 **PDFium（C++ 引擎编译成 WebAssembly）** 取代 DSH 内置的
pdf.js 正文，把「打开 PDF 要等好几秒」压到「第一页几十毫秒」。

## 为什么原来的慢

内置 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 的 PDF 正文用的是 pdf.js：

- 解析 + 光栅化全在 **主线程 JS** 里跑，一个 A4 页面就要几十到上百毫秒；
- 每页先画到**离屏 canvas 再 drawImage** 拷到可见 canvas，多一次整页像素搬运；
- `devicePixelRatio * zoom` **没有像素预算**，大页面放大时会尝试分配上百 MB；
- 每页渲染完立刻 `page.cleanup()`，滚动回去要重算；
- 页面占位固定 3/4 比例，尺寸未知时布局和滚动条反复跳动；
- 每个标签页都 `new Worker(内联 1.29MB 源码)` 并复制整份 PDF 字节。

## 现在怎么做

- **引擎**：PDFium 的 WASM 构建（`@hyzyla/pdfium`，MIT 包装层 + BSD-3 引擎），
  C++ 直接光栅化，实测 16 页 PPT PDF 单页 **27–32ms**，wasm 热启动 38ms。
- **懒加载**：引擎和阅读器分成 `client.pdfium.js`(7.3MB，wasm 以 base64 内联) 与
  `client.viewer.js`(25KB) 两个 `client.*` 块，只在真的打开 PDF 时才取；
  空闲时 (`requestIdleCallback`) 预热带宽，首次打开也不用等冷启动。
- **只画看得到的页**：`IntersectionObserver` 用 150% 视口余量预取下一页，
  PDFium 调用串行排队（单 WASM 实例不可重入），滚走的页面 4 秒后释放位图。
- **像素预算**：每页最多 16.7M 设备像素（≈4096²），超出就降采样再用 CSS 放大。
- **位图直写可见 canvas**：省掉离屏 + drawImage 的一次整页拷贝。
- **文本层**：`page.loadTextPage()` + `_FPDFText_GetUnicode/GetCharBox/GetFontSize`
  直接取字符框，按「同一行 + 同字号 + 间距连续」合并成文本 run，用透明文字叠在
  canvas 上方 → 可以**选中、复制**。文本层建在页面坐标系里，缩放时只改 CSS
  `transform`，**不重建**。
- **渐进式尺寸**：先只探第一页尺寸立刻开画，其余页尺寸在空闲批次里补齐。
- **缩放**：工具栏 −/+/适应宽度，`Ctrl/Cmd + 滚轮` 也可以。

## 保留回退

注册是「同 id 的第二套 `documentPreviews` 实现」，`priority` 不是 `builtin` 所以排在
pdf.js 之前；内置实现仍在注册表里，PDF 标签页头部的下拉菜单可以随时切回 pdf.js。

## 安装

本插件是本地 bundle 插件：

1. `D:\DeepSeek-DSH\profiles\desktop\node_modules\<name>` 指向本目录（junction 或
   pnpm `link:`）；
2. profile 的 `package.json`：`dependencies` 加 `"dsh-pdfium-preview": "link:<本目录>"`，
   `dsh.profile.bundles` 数组加 `dsh-pdfium-preview`；
3. 重启应用（加载器条目在启动时读取）。之后只改 `client.*.js` 可由客户端 HMR 热更。

## 构建引擎块

```bash
node scripts/build-engine.mjs      # 重新生成 client.pdfium.js
node scripts/test-engine.mjs       # node 端跑一遍引擎（无需浏览器）
```

`build-engine.mjs` 读取 `.tmp/pdfium-3.0.0/package/dist/` 下的 `index.esm.js` 与
`pdfium.wasm`，做四处改写（`import.meta.url`、node 分支、`export` 块、wasm 内联），
再把结果包进 DSH 的 `window.__ModuleLoader__.load` 外壳。

## 许可

本插件 MIT。内置第三方代码见 `THIRD_PARTY_NOTICES.txt`（PDFium BSD-3、@hyzyla/pdfium MIT）。
