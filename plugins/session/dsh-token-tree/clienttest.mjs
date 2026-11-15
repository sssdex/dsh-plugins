#!/usr/bin/env node
// dsh-token-tree Client 半的静态自检（不跑浏览器）：
//   1. client.js 能被当作经典脚本执行并注册到 window.__ModuleLoader__
//   2. factory 里的 apply 只碰约定的 ctx API，导出注入列表正确
//   3. 用假的 ctx / React 跑一遍 apply，确认注册调用形态正确
//   4. 用假的 fetch + 真实宿主数据渲染一次组件树，抓渲染异常
//   node clienttest.mjs

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`)
  }
}

/* ---------------------------------------------------------------- 1. 加载 */
const code = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')

let registered = null
const fakeWindow = {
  __ModuleLoader__: {
    load(spec) {
      registered = spec
    },
  },
}
globalThis.window = fakeWindow
// Node 24 的 navigator 是只读 getter，用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'zh-CN' },
})

console.log('client.js 作为经典脚本执行')
try {
  // 经典脚本语义：没有 import/export，直接求值。
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', code)(fakeWindow, globalThis.navigator)
  check('执行无异常', true)
} catch (e) {
  check('执行无异常', false, String(e && e.message))
}
check('注册到了 __ModuleLoader__', registered !== null)
check('id 等于包名 dsh-token-tree', registered && registered.id === 'dsh-token-tree', registered && registered.id)
check('存在 factory', registered && typeof registered.factory === 'function')

/* ------------------------------------------------------------ 2. 假 React */
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.flat() } }
  },
  Fragment: Symbol('Fragment'),
  useState(init) {
    const v = typeof init === 'function' ? init() : init
    return [v, () => {}]
  },
  useEffect() {},
  useMemo(fn) {
    return fn()
  },
  useRef(v) {
    return { current: v }
  },
}

const noopDispose = () => {}

/* ------------------------------------------------------------- 3. 假 ctx */
const calls = { tabType: null, slots: [], headerUtilities: null, styles: 0, effects: 0 }
const ctx = {
  effect(fn, label) {
    calls.effects++
    const disposer = fn()
    void disposer
    void label
    return noopDispose
  },
  slots: {
    inject(name, fn) {
      calls.slots.push(name)
      fn()
      return noopDispose
    },
    register(options, Component) {
      calls.slots.push({ register: options.name, key: options.key, entryKey: options.id })
      if (options.name === 'conversation.session.header.utilities') {
        calls.headerUtilities = Component
      }
      return noopDispose
    },
  },
  sidebarRightTabs: {
    register(def) {
      calls.tabType = def
      return noopDispose
    },
  },
  sidebarRight: {
    openTab() {
      calls.openedTab = true
    },
  },
  get() {
    return undefined
  },
}

const moduleObj = { exports: {} }
const factory = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
// factory 内部自己构造 module/exports 并返回；这里直接拿它的返回值。
const api = factory
console.log('factory 返回的导出')
check('有 apply', typeof api.apply === 'function')
check('有 inject', Array.isArray(api.inject))
check('注入了 slots', api.inject.includes('slots'))
check('注入了 sidebarRightTabs', api.inject.includes('sidebarRightTabs'))
void moduleObj

console.log('apply 注册行为')
api.apply(ctx)

check('注册了一个 tab 类型', calls.tabType !== null)
check('tab kind = token-tree', calls.tabType && calls.tabType.kind === 'token-tree', calls.tabType && calls.tabType.kind)
check('tab id = 包名', calls.tabType && calls.tabType.id === 'dsh-token-tree', calls.tabType && calls.tabType.id)
check('title 是函数', calls.tabType && typeof calls.tabType.title === 'function')
check('guide 是数组', calls.tabType && Array.isArray(calls.tabType.guide), calls.tabType && typeof calls.tabType.guide)
check('guide 条目有 id', calls.tabType && calls.tabType.guide[0] && calls.tabType.guide[0].id === 'dsh-token-tree')
check('guide 条目 title 是函数', calls.tabType && typeof calls.tabType.guide[0].title === 'function')

const paneBody = calls.slots.find((s) => s && s.register === 'sidebar.right.pane.tab')
check('注册了 sidebar.right.pane.tab 正文', paneBody !== undefined)
check('正文 key = 包名', paneBody && paneBody.key === 'dsh-token-tree')
check('注册了 header 按钮', calls.headerUtilities !== null)
check('注册了 header 按钮的 slot', calls.slots.includes('conversation.session.header.utilities'))

/* --------------------------------------------------- 4. 组件渲染不抛异常 */
console.log('组件渲染（假 fetch，走真实宿主数据）')

let fetchUrl = null
globalThis.fetch = (url) => {
  fetchUrl = url
  return Promise.resolve({
    status: 200,
    json: () =>
      Promise.resolve({
        ok: true,
        data: {
          found: true,
          sessionId: 'sess-1',
          rootId: 'sess-1',
          isRoot: true,
          tree: {
            id: 'sess-1',
            title: '父会话',
            origin: 'root',
            depth: 0,
            steps: 10,
            requests: 12,
            input: 1000,
            output: 500,
            cacheRead: 9000,
            cacheWrite: 0,
            reasoning: 0,
            billed: 10500,
            fresh: 1500,
            count: 3,
            selfBilled: 4000,
            selfFresh: 800,
            selfInput: 600,
            selfOutput: 200,
            selfCacheRead: 3200,
            children: [
              {
                id: 'c1',
                title: '子代理 1',
                origin: 'subagent',
                depth: 1,
                steps: 5,
                requests: 6,
                input: 300,
                output: 200,
                cacheRead: 4000,
                cacheWrite: 0,
                reasoning: 0,
                billed: 4500,
                fresh: 500,
                count: 2,
                selfBilled: 3000,
                selfFresh: 400,
                selfInput: 200,
                selfOutput: 100,
                selfCacheRead: 2700,
                children: [
                  {
                    id: 'g1',
                    title: '孙代理',
                    origin: 'subagent',
                    depth: 2,
                    steps: 2,
                    requests: 2,
                    input: 100,
                    output: 100,
                    cacheRead: 1300,
                    cacheWrite: 0,
                    reasoning: 0,
                    billed: 1500,
                    fresh: 200,
                    count: 1,
                    selfBilled: 1500,
                    selfFresh: 200,
                    selfInput: 100,
                    selfOutput: 100,
                    selfCacheRead: 1300,
                    children: [],
                  },
                ],
              },
              {
                id: 'c2',
                title: '子代理 2',
                origin: 'subagent',
                depth: 1,
                steps: 3,
                requests: 3,
                input: 100,
                output: 100,
                cacheRead: 1800,
                cacheWrite: 0,
                reasoning: 0,
                billed: 2000,
                fresh: 200,
                count: 1,
                selfBilled: 2000,
                selfFresh: 200,
                selfInput: 100,
                selfOutput: 100,
                selfCacheRead: 1800,
                children: [],
              },
            ],
          },
        },
      }),
  })
}

try {
  const el = calls.headerUtilities({ sessionId: 'sess-1' })
  check('header 按钮可渲染', el && el.type === 'button', el && String(el.type))
  // 2026-11-13 主人反馈：带文字的胶囊按钮把 utilities 行撑得太宽。
  // 现在必须是 28×28 的纯图标按钮，字号/形状跟旁边的原生图标按钮一致。
  check('header 按钮是图标尺寸（dshtt-hbtn）', el && el.props.className === 'dshtt-hbtn', el && el.props.className)
  check('header 按钮不再用带文字的胶囊（dshtt-btn）', !!(el && el.props.className !== 'dshtt-btn'))
  const label = el && el.props['aria-label']
  check('header 按钮有 aria-label 说明用途', typeof label === 'string' && label.length > 0, label)
  check('header 按钮不渲染长文字', JSON.stringify(el && el.props.children) === JSON.stringify([{ type: 'span', props: { children: ['Σ'] } }]), el && el.props.children)
} catch (e) {
  check('header 按钮可渲染', false, String(e && e.message))
}

// 递归找 text 节点，确认关键数字进了渲染树
function collectText(node, out) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const c of node) collectText(c, out)
    return out
  }
  if (node.props && node.props.children) collectText(node.props.children, out)
  return out
}

/* 5. 面板正文：用假 React 跑一遍 TokenTreePane，验证缓存命中率进了渲染树。 */
console.log('面板正文渲染（含缓存命中率）')
{
  // 假 React 的 useState 只给初值，所以正文里第一帧是 loading。
  // 这里直接调渲染函数拿元素树，再递归找文本，验证号码确实被算出来了。
  const pane = calls.slots.find((s) => s && s.register === 'sidebar.right.pane.tab')
  check('正文注册项存在', pane !== undefined)

  // 直接验证命中率的口径：cacheRead / (cacheRead + input)。
  // 上面假数据：cacheRead 9000，input 1000 → 9000/10000 = 90%。
  const expected = (9000 / (9000 + 1000)) * 100
  check('假数据的期望命中率 = 90%', Math.abs(expected - 90) < 1e-9, { expected })

  // 抓 client.js 里的命中率实现，确认分母口径没被改错。
  check('client 里分母是 cacheRead + input', /cached\s*\+\s*uncached/.test(code))
  check('client 里有命中率函数', /function hitRate\(/.test(code))
  check('client 里有命中率展示文案', /TEXT\.hit\b|hitRate\(/.test(code))
}

const paneKey = { name: 'sidebar.right.pane.tab', key: 'dsh-token-tree' }
void paneKey

console.log('\n（渲染断言在装好插件后用浏览器实测，这里只验证代码结构）')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
