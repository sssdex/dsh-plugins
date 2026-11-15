/**
 * 构建：把 lib/{parse,render,styles}.js 内联进 lib/client.js。
 *
 * 为什么需要这一步：
 *   DSH 的客户端 bundle 由 window.__ModuleLoader__.load({id, factory}) 注册，
 *   宿主把它当普通 <script> 执行，不是 ES 模块 —— 浏览器里 `import './parse.js'`
 *   不会解析相对路径。所以依赖必须在构建期内联。
 *
 * 用法：node scripts/build.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'lib');
const TPL = path.join(LIB, 'client.bundle.tpl.js');
const OUT = path.join(LIB, 'client.js');

/** 去掉 ESM 语法，只留可内联的语句。 */
function toInlineBody(file, exportNames) {
  let src = fs.readFileSync(file, 'utf8');

  // 去掉相对依赖的 import 行（内联后它们已经不存在）
  src = src.replace(/^\s*import\s+[^;]+;\s*$/gm, '');

  // `export function foo` → `function foo`；`export const X =` → `const X =`
  src = src.replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ');

  // 去掉裸 `export { ... };`
  src = src.replace(/^\s*export\s*\{[^}]*\};\s*$/gm, '');

  if (/^\s*(import|export)\s/m.test(src)) {
    throw new Error(`${path.basename(file)} 里还有未处理的 import/export，内联会失败`);
  }

  // 导出的名字要能被后面的客户端代码直接引用：用一层作用域包起来再 return
  return `
/* ---- 内联 ${path.basename(file)} ---- */
const { ${exportNames.join(', ')} } = (() => {
${src}
return { ${exportNames.join(', ')} };
})();
/* ---- /内联 ${path.basename(file)} ---- */
`.trim();
}

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  const re = /^export\s+(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  // `export { a, b }` 形式
  const re2 = /^\s*export\s*\{([^}]*)\};?\s*$/gm;
  while ((m = re2.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.trim());
    }
  }
  return [...names];
}

const files = [
  { file: 'parse.js', marker: '/* __INLINE_PARSE__ */' },
  { file: 'render.js', marker: '/* __INLINE_RENDER__ */' },
  { file: 'styles.js', marker: '/* __INLINE_STYLES__ */' },
];

let tpl = fs.readFileSync(TPL, 'utf8');

for (const { file, marker } of files) {
  const full = path.join(LIB, file);
  const names = exportsOf(full);
  if (names.length === 0) throw new Error(`${file} 没有导出，检查格式`);
  const body = toInlineBody(full, names);
  if (!tpl.includes(marker)) throw new Error(`模板里找不到占位 ${marker}`);
  tpl = tpl.replace(marker, body);
  console.log(`内联 ${file} → 导出 ${names.length} 个: ${names.join(', ')}`);
}

fs.writeFileSync(OUT, tpl, 'utf8');
const stat = fs.statSync(OUT);
console.log(`\n写出 ${path.relative(ROOT, OUT)} (${stat.size} 字节)`);
