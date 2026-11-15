
import fs from 'node:fs';
globalThis.window = globalThis;
globalThis.self = globalThis;
let mod;
globalThis.window.__ModuleLoader__ = { load: (entry) => { mod = entry.factory(null); } };
const code = fs.readFileSync('D:/DeepSeek-Workspace/dsh-pdfium-preview/client.pdfium.js', 'utf8');
const tLoad = performance.now();
new Function(code)();
console.log('chunk parse+exec ms', (performance.now() - tLoad).toFixed(1), 'exports:', Object.keys(mod).join(','));

const { PDFiumLibrary, __wasmBytes } = mod;
const t0 = performance.now();
const bytes = __wasmBytes();
const t1 = performance.now();
const lib = await PDFiumLibrary.init({ wasmBinary: bytes.buffer });
const t2 = performance.now();
const file = fs.readFileSync(process.argv[2]);
const t3 = performance.now();
const doc = await lib.loadDocument(new Uint8Array(file));
const t4 = performance.now();
const n = doc.getPageCount();
const t5 = performance.now();
const sizes = [];
for (let i = 0; i < Math.min(n, 4); i += 1) { const p = await doc.getPage(i); sizes.push(p.getOriginalSize()); p.close(); }
const t6 = performance.now();
const page = await doc.getPage(0);
const size = page.getOriginalSize();
const scale = Math.min(2, 1200 / size.originalWidth);
const r = await page.render({ scale, transparent: false });
const t7 = performance.now();
const text = page.getText();
const t8 = performance.now();
console.log(JSON.stringify({
  wasmDecodeMs: +(t1-t0).toFixed(1), wasmInitMs: +(t2-t1).toFixed(1), loadDocMs: +(t4-t3).toFixed(1),
  pageCount: n, getPageCountMs: +(t5-t4).toFixed(1), fourSizesMs: +(t6-t5).toFixed(1),
  renderMs: +(t7-t6).toFixed(1), renderPx: r.width + 'x' + r.height, bytes: r.data.length,
  getTextMs: +(t8-t7).toFixed(1), textChars: text.length, sizes,
}, null, 1));
doc.destroy();
process.exit(0);
