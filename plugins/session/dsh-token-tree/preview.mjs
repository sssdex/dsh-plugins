#!/usr/bin/env node
// 把 client.js 的**真实组件输出**渲染成一个静态 HTML 预览页，用来肉眼验收 UI。
//
// 做法：用假 React（createElement 只记 {type, props}）+ 固定顺序的 useState 注入，
//       把元素树序列化成 HTML；样式直接取 client.js 里 installStyles 写出去的那份 CSS。
// 这样预览里的每一行 DOM 都出自组件代码本身，不是手抄的。
//
//   node preview.mjs                  → 用手写的示例数据
//   node preview.mjs <sessionId>      → 打本机正在跑的 DSH，用真实会话数据
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const code = fs.readFileSync(path.join(here, 'client.js'), 'utf8')
const liveSessionId = process.argv[2] || null
const DSH_ORIGIN = process.env.DSHTT_ORIGIN || 'http://127.0.0.1:10751'

/* ------------------------------------------------------------ 假 document */
let capturedCSS = ''
const fakeDocument = {
  head: { appendChild(node) { capturedCSS = node.textContent } },
  querySelector() { return null },
  createElement() { return { dataset: {}, textContent: '' } },
  documentElement: { dataset: {} },
}
globalThis.document = fakeDocument
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } })

let captured = null
new Function('window', 'navigator', 'document', code)(globalThis.window, globalThis.navigator, fakeDocument)

/* --------------------------------------------------------------- 假 React */
// hooks 按固定调用顺序取注入值：
//   1 snap  2 mode  3 auto  4 copied  5 collapsed
let hookValues = []
let hookIndex = 0

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.flat() } }
  },
  Fragment: Symbol('Fragment'),
  useState(init) {
    const i = hookIndex++
    const v = i < hookValues.length ? hookValues[i] : typeof init === 'function' ? init() : init
    return [v, () => {}]
  },
  useEffect() {},
  useMemo(fn) { return fn() },
  useRef(v) { return { current: v } },
}

/* ------------------------------------------------------------------ 数据 */
function node(o) {
  const base = Object.assign(
    { origin: 'subagent', reasoning: 0, cacheWrite: 0, compactionRequests: 0, compactionBilled: 0, children: [] },
    o,
  )
  const denom = (base.cacheRead || 0) + (base.input || 0)
  base.cacheHitRate = denom > 0 ? (base.cacheRead || 0) / denom : null
  return base
}

// 数字取自真实会话的量级：父代理 85.55M，11 个代理，缓存占大头。
// 传了 sessionId 就用本机 DSH 的真实数据替换。
let realTree = null
if (liveSessionId) {
  try {
    const res = await fetch(`${DSH_ORIGIN}/api/dsh-token-tree/tree?sessionId=${encodeURIComponent(liveSessionId)}`)
    const body = await res.json()
    if (body.ok !== true) throw new Error(body.error || 'api error')
    if (!body.data.tree) throw new Error('该会话没有 token 记录')
    realTree = body.data.tree
    console.log('用真实会话数据：' + liveSessionId)
    console.log('  billed=' + realTree.billed + ' 命中率=' + realTree.cacheHitRate)
  } catch (e) {
    console.error('取真实数据失败（' + String(e.message || e) + '），退回示例数据')
  }
}

const sampleTree = node({
  id: 'root',
  title: '父·全部子孙合计',
  origin: 'root',
  depth: 0,
  count: 11,
  steps: 533,
  requests: 533,
  input: 4858991,
  cacheRead: 77912752,
  cacheWrite: 0,
  output: 784538,
  billed: 85552285,
  fresh: 5643529,
  selfBilled: 5640000,
  selfFresh: 5640000,
  compactionRequests: 3,
  compactionBilled: 41200,
  children: [
    node({
      id: 'c1',
      title: '会话开关存储设计评估',
      depth: 1,
      count: 1,
      steps: 3,
      requests: 3,
      input: 14000,
      cacheRead: 28000,
      output: 4000,
      billed: 42100,
      fresh: 18000,
      children: [],
    }),
    node({
      id: 'c2',
      title: '前端顾问咨询与工具调用测试',
      depth: 1,
      count: 1,
      steps: 2,
      requests: 2,
      input: 44000,
      cacheRead: 23000,
      output: 3000,
      billed: 67600,
      fresh: 47000,
      children: [],
    }),
    node({
      id: 'c3',
      title: '单文件账户设置页与 README 文档',
      depth: 1,
      count: 1,
      steps: 114,
      requests: 113,
      input: 113000,
      cacheRead: 10200000,
      output: 250000,
      billed: 10940000,
      fresh: 340000,
      children: [
        node({
          id: 'c3a',
          title: '单文件账户设置页与排版说明（子）',
          depth: 2,
          count: 2,
          steps: 110,
          requests: 110,
          input: 110000,
          cacheRead: 7800000,
          output: 140000,
          billed: 9410000,
          fresh: 250000,
          children: [],
        }),
      ],
    }),
    node({
      id: 'c4',
      title: '审美顾问连通性测试',
      depth: 1,
      count: 1,
      steps: 4,
      requests: 4,
      input: 12000,
      cacheRead: 370000,
      output: 1200,
      billed: 383200,
      fresh: 13200,
      children: [],
    }),
    node({
      id: 'c5',
      title: '开发任务队列服务实现',
      depth: 1,
      count: 2,
      steps: 81,
      requests: 81,
      input: 560000,
      cacheRead: 6900000,
      output: 241000,
      billed: 7700000,
      fresh: 800000,
      children: [],
    }),
    node({
      id: 'c6',
      title: '【顾问咨询·backend】后端 /',
      depth: 1,
      count: 1,
      steps: 4,
      requests: 4,
      input: 58000,
      cacheRead: 80000,
      output: 4400,
      billed: 142400,
      fresh: 62000,
      children: [],
    }),
    node({
      id: 'c7',
      title: '实现开发任务队列与测试',
      depth: 1,
      count: 1,
      steps: 20,
      requests: 20,
      input: 160000,
      cacheRead: 1040000,
      output: 22000,
      billed: 1220000,
      fresh: 182000,
      children: [],
    }),
    node({
      id: 'c8',
      title: '模型身份确认与路由验证',
      depth: 1,
      count: 1,
      steps: 1,
      requests: 1,
      input: 18000,
      cacheRead: 0,
      output: 2100,
      billed: 20100,
      fresh: 20100,
      children: [],
    }),
  ],
})

const tree = realTree || sampleTree

/* --------------------------------------------------------------- 序列化 */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'link', 'meta'])

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;')
}

function styleToCss(style) {
  if (!style) return ''
  return Object.keys(style)
    .map((k) => {
      const v = typeof style[k] === 'number' && !/^(zIndex|opacity|flex|order|lineHeight)$/.test(k) ? style[k] + 'px' : style[k]
      return k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + v
    })
    .join(';')
}

function serialize(el, ctx) {
  if (el === null || el === undefined || el === false || el === true) return ''
  if (typeof el === 'string' || typeof el === 'number') return escapeText(el)
  if (Array.isArray(el)) return el.map((c) => serialize(c, ctx)).join('')
  if (typeof el.type === 'function') {
    const savedIndex = hookIndex
    hookIndex = 0
    const out = el.type(el.props || {})
    hookIndex = savedIndex
    return serialize(out, ctx)
  }
  if (typeof el.type === 'symbol') return serialize(el.props.children, ctx)

  const tag = el.type
  const props = el.props || {}
  const attrs = []
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'key') continue
    const v = props[key]
    if (v === null || v === undefined || v === false) continue
    if (key === 'style') {
      const css = styleToCss(v)
      if (css) attrs.push(`style="${escapeAttr(css)}"`)
      continue
    }
    const name = key === 'className' ? 'class' : key
    if (v === true) attrs.push(name)
    else attrs.push(`${name}="${escapeAttr(v)}"`)
  }
  const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID_TAGS.has(tag)) return open
  return open + serialize(props.children, ctx) + `</${tag}>`
}

function render(component, hookSeed) {
  hookValues = hookSeed
  hookIndex = 0
  return serialize(component({ sessionId: 'sess-preview' }), {})
}

/* --------------------------------------------------------------- 取组件 */
const calls = { pane: null }
const ctx = {
  effect(fn) { fn(); return () => {} },
  slots: {
    inject(name, fn) { fn(); return () => {} },
    register(options, Component) {
      if (options.name === 'sidebar.right.pane.tab') calls.pane = Component
      return () => {}
    },
  },
  sidebarRightTabs: { register() { return () => {} } },
  sidebarRight: { openTab() {} },
  get() {},
}
const api = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
api.apply(ctx)
if (!calls.pane) throw new Error('没拿到侧栏正文组件')

/* --------------------------------------------------------------- 组装页 */
const snapBilled = { loading: false, data: { found: true, sessionId: 'sess-preview', rootId: 'root', isRoot: true, tree }, error: null }
const seedBilled = [snapBilled, 'billed', true, false, {}]
const seedFresh = [snapBilled, 'fresh', true, false, {}]

const bodyBilled = render(calls.pane, seedBilled)
const bodyFresh = render(calls.pane, seedFresh)

const themeVars = `
:root{color-scheme:dark;--dsw-alias-label-primary:#e8e8ea;--dsw-alias-label-secondary:#9ea3ab;--dsw-alias-label-tertiary:#7c818a;
--dsw-alias-border-l1:rgba(255,255,255,.10);--dsw-alias-border-l2:rgba(255,255,255,.17);--dsw-alias-border-l4:rgba(255,255,255,.28);
--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);--dsw-alias-interactive-bg-active:rgba(255,255,255,.13);
--dsw-alias-brand-primary:#5b8cff;--dsw-alias-bg-layer-1:#232326;--dsw-alias-bg-layer-2:rgba(255,255,255,.07);
--dsw-alias-bg-base:#161618;--dsw-alias-state-warn-primary:#e0a13a;--dsw-alias-state-error-primary:#f26d6d;
--dsw-alias-state-success-primary:#4ec98a;--dsw-alias-state-business-primary:#7b9bff;}
html[data-theme="light"]{color-scheme:light;--dsw-alias-label-primary:#1d1f23;--dsw-alias-label-secondary:#5c636e;
--dsw-alias-label-tertiary:#868d98;--dsw-alias-border-l1:rgba(0,0,0,.08);--dsw-alias-border-l2:rgba(0,0,0,.14);
--dsw-alias-border-l4:rgba(0,0,0,.24);--dsw-alias-interactive-bg-hover:rgba(0,0,0,.05);
--dsw-alias-interactive-bg-active:rgba(0,0,0,.09);--dsw-alias-brand-primary:#2f6bff;
--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:rgba(0,0,0,.045);--dsw-alias-bg-base:#f6f7f9;
--dsw-alias-state-warn-primary:#a86a00;--dsw-alias-state-error-primary:#c62828;}
html,body{margin:0}
body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
font:13px/1.5 "Inter",system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:22px}
h1{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0 0 10px;letter-spacing:.02em}
.wrap{display:flex;gap:18px;align-items:flex-start}
.pane{width:360px;height:660px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;
background:var(--dsw-alias-bg-base);box-shadow:0 12px 32px rgba(0,0,0,.28)}
`

const html = `<!doctype html><html lang="zh" data-theme="dark"><head><meta charset="utf-8">
<title>dsh-token-tree · UI 预览</title>
<style>${themeVars}</style>
<style data-plugin-css="dsh-token-tree">${capturedCSS}</style>
</head><body>
<div class="wrap">
  <div><h1>billed（计费口径）</h1><div class="pane">${bodyBilled}</div></div>
  <div><h1>fresh（真实新增）</h1><div class="pane">${bodyFresh}</div></div>
</div>
</body></html>`

const out = path.join(here, 'ui-preview.html')
fs.writeFileSync(out, html, 'utf8')
console.log('已写出 ' + out)
console.log('CSS 长度 ' + capturedCSS.length + '，DOM 长度 ' + bodyBilled.length)
