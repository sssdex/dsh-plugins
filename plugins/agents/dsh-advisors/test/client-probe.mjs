/**
 * Client 半边回归测试：把 client.js 的真实组件跑起来。
 *
 * 不依赖宿主、不依赖真 React：用一个最小 hooks 运行时（按渲染路径缓存实例，
 * 模拟 fiber）+ 假 fetch 驱动，消费 Host 半边的真实回执形状。
 *
 * 用法：node test/client-probe.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')

// ------------------------------------------------------------------ 最小 React
/**
 * 每个渲染路径一份实例状态。hooks 按「本次渲染的调用序号」定位 ——
 * 不能按 state.length 定位，否则每轮重渲染都会新增槽位。
 */
const instances = new Map()
let activeInstance = null
let hookCursor = 0
let dirty = false

const instanceAt = (key) => {
  let inst = instances.get(key)
  if (inst === undefined) {
    inst = { state: [], deps: [], effects: [], cleanups: [] }
    instances.set(key, inst)
  }
  return inst
}

const slot = (initial) => {
  const inst = activeInstance
  const index = hookCursor++
  if (index >= inst.state.length) inst.state.push(typeof initial === 'function' ? initial() : initial)
  return { inst, index }
}

function useState(initial) {
  const { inst, index } = slot(initial)
  const set = (next) => {
    const value = typeof next === 'function' ? next(inst.state[index]) : next
    if (Object.is(value, inst.state[index])) return
    inst.state[index] = value
    dirty = true
  }
  return [inst.state[index], set]
}

function useEffect(fn, deps) {
  const inst = activeInstance
  const index = hookCursor++
  const prev = inst.deps[index]
  const changed = deps === undefined
    || prev === undefined
    || deps.length !== prev.length
    || deps.some((d, i) => !Object.is(d, prev[i]))
  if (changed) {
    inst.deps[index] = deps
    inst.effects.push(fn)
  }
}

function useCallback(fn, _deps) {
  const { inst, index } = slot(undefined)
  if (inst.state[index] === undefined) inst.state[index] = fn
  return inst.state[index]
}

/** 稳定引用：同一组件实例跨渲染保持同一个 `{.current}`。 */
function useRef(initial) {
  const { inst, index } = slot(undefined)
  if (inst.state[index] === undefined) inst.state[index] = { current: initial ?? null }
  return inst.state[index]
}

const flatten = (list) => {
  const out = []
  for (const item of list) {
    if (Array.isArray(item)) out.push(...flatten(item))
    else if (item === null || item === undefined || item === false || item === true) continue
    else out.push(item)
  }
  return out
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) }),
  useState,
  useEffect,
  useCallback,
  useRef,
  Fragment: Symbol('Fragment'),
}

// ------------------------------------------------------------------ 假 fetch
let apiPayload = null
let calls = []
/** document 上挂的监听（「点外面关闭」用它）。 */
const docListeners = []
const clone = (v) => JSON.parse(JSON.stringify(v))

globalThis.fetch = async (url, init) => {
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  calls.push({ url, body })
  if (body === undefined) return { json: async () => clone(apiPayload) }
  // 模拟 Host：按 patch 改 payload 后回全量视图。
  if (body.domain !== undefined) {
    const entry = apiPayload.domains.find((d) => d.domain === body.domain)
    entry.selected = body.modelId
    if (body.modelId !== null) entry.effective = body.modelId
  }
  if (body.defaultEnabled !== undefined) apiPayload.defaultEnabled = body.defaultEnabled
  if (body.enabled !== undefined) apiPayload.enabled = body.enabled
  return { json: async () => clone(apiPayload) }
}

// ------------------------------------------------------------------ 载入 bundle
let pluginExports = null
const registered = []
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      pluginExports = factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
      pluginExports.__id = id
    },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, remove() {} }),
  // 「点外面关闭」监听：记录注册与移除，供断言使用。
  addEventListener: (type, fn, capture) => { docListeners.push({ type, fn, capture }) },
  removeEventListener: (type, fn) => {
    const i = docListeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) docListeners.splice(i, 1)
  },
}
globalThis.docListeners = docListeners
globalThis.location = { href: 'http://127.0.0.1:10751/' }

const ZH = {}
new Function(fs.readFileSync(path.join(pluginDir, 'client.js'), 'utf8'))()

const ctx = {
  effect: (fn) => { fn() },
  locale: {
    register: (ns, dicts) => { Object.assign(ZH, dicts.zh); return () => {} },
    bind: () => (key) => {
      if (!(key in ZH)) throw new Error(`missing locale key: ${key}`)
      return ZH[key]
    },
  },
  slots: {
    inject: (_name, fn) => { fn() },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
}

pluginExports.apply(ctx)

const assert = (ok, message) => {
  if (!ok) { console.error('FAIL ' + message); process.exitCode = 1 } else console.log('ok   ' + message)
}

// ------------------------------------------------------------------ bundle 契约
assert(pluginExports.__id === 'dsh-advisors', 'bundle 注册 id 等于包名')
assert(Array.isArray(pluginExports.inject) && pluginExports.inject.includes('slots'), 'inject 声明包含 slots')
assert(registered.length === 2, `注册了两个槽位（实际 ${registered.length}）`)
const slotNames = registered.map((r) => r.options.name).sort()
assert(slotNames[0] === 'conversation.input.model.options' && slotNames[1] === 'settings.section',
  '槽位名正确：' + slotNames.join(', '))
const section = registered.find((r) => r.options.name === 'settings.section')
assert(section.options.id === 'dsh-advisors', 'settings.section id 正确')
assert(typeof section.options.label === 'function' && section.options.label() === '顾问', 'settings.section label 走语言包')
assert(section.options.locale === 'dsh-advisors', 'settings.section 声明 locale 命名空间')

// ------------------------------------------------------------------ 渲染器
/** 渲染一个元素树；函数组件走实例缓存。返回可直接断言的节点树。 */
function renderTree(element, pathPrefix) {
  if (element === null || element === undefined) return null
  if (typeof element === 'string' || typeof element === 'number') return element
  if (Array.isArray(element)) return element.map((child, i) => renderTree(child, [...pathPrefix, i]))
  if (typeof element !== 'object') return null
  const { type, props, children } = element
  if (typeof type === 'function') {
    // 实例身份 = 组件类型 + 该元素自己的 key（对齐 React 的 key 语义）。
    // 只按位置会出错：四个 DomainRow 形状相同，展开第 2 个会复用第 1 个的状态。
    const key = [...pathPrefix, `${type.name || 'anon'}:${props.key ?? ''}`].join('/')
    const saved = { activeInstance, hookCursor }
    activeInstance = instanceAt(key)
    hookCursor = 0
    let out
    try {
      out = type({ ...props, children })
    } finally {
      activeInstance = saved.activeInstance
      hookCursor = saved.hookCursor
    }
    return renderTree(out, [...pathPrefix, '$out'])
  }
  return { type, props: { ...props }, children: renderTree(children, [...pathPrefix, 'children']) }
}

/**
 * 像真 React 那样把 `ref` 指向渲染出来的节点，并给宿主节点一个 `contains`。
 * 不做这一步，「点外面关闭」这类依赖 `ref.current` 的逻辑在探针里永远走不到。
 */
function attachRefs(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) { for (const n of node) attachRefs(n); return node }
  if (typeof node.type === 'function') return node
  node.contains = (target) => {
    if (target === node) return true
    const walk = (n) => {
      if (n === null || typeof n !== 'object') return false
      if (Array.isArray(n)) return n.some(walk)
      if (n === target) return true
      return walk(n.children)
    }
    return walk(node.children)
  }
  const ref = node.props.ref
  if (ref !== null && typeof ref === 'object') ref.current = node
  attachRefs(node.children)
  return node
}

/** 跑一轮待执行的 effect（先跑上一轮遗留 cleanup，再跑新的 setup）。 */
async function flushEffects() {
  for (const inst of instances.values()) {
    const pending = inst.effects
    if (pending.length === 0) continue
    inst.effects = []
    const old = inst.cleanups
    inst.cleanups = []
    for (const cleanup of old) cleanup()
    for (const fn of pending) {
      const cleanup = fn()
      if (typeof cleanup === 'function') inst.cleanups.push(cleanup)
    }
  }
}

/** 等到没有新的 state 变更为止。 */
async function settle(mount, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r))
    await flushEffects()
    if (!dirty) continue
    dirty = false
    mount.node = attachRefs(renderTree(mount.element, [0]))
    await flushEffects()
  }
  return mount
}

const mount = (element) => ({ element, node: null })

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}

function findAll(node, predicate, acc = []) {
  if (node === null || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const n of node) findAll(n, predicate, acc); return acc }
  if (predicate(node)) acc.push(node)
  findAll(node.children, predicate, acc)
  return acc
}

/** 与 Host 半边 GET /dsh-advisors-api 回执同形（从运行中的宿主抓的样本）。 */
function payload() {
  return {
    ok: true,
    enabled: false,
    defaultEnabled: false,
    catalog: [
      { id: 'apikey/gpt-6-astra', provider: 'apikey', providerName: 'chatgpt', model: 'gpt-6-astra', label: 'GPT-6 Astra', note: '工程严谨、抓 bug 准', selected: false },
      { id: 'apikey1/claude-opus-5-5', provider: 'apikey1', providerName: 'claude', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: '审美与语义分组更强', selected: false },
      { id: 'zzz1/deepseek-v4-pro', provider: 'zzz1', providerName: '中转站deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: '国内直连', selected: false },
    ],
    domains: [
      { domain: 'frontend', label: '前端实现 / 组件与状态', selected: null, effective: 'apikey/gpt-6-astra' },
      { domain: 'aesthetic', label: '视觉审美 / 排版与质感', selected: null, effective: 'apikey/gpt-6-astra' },
      { domain: 'modeling', label: '数据与系统建模 / 架构', selected: null, effective: 'apikey/gpt-6-astra' },
      { domain: 'backend', label: '后端 / 数据层 / 性能与并发', selected: null, effective: 'apikey/gpt-6-astra' },
    ],
  }
}

const t = (key, values) => {
  const template = ZH[key]
  if (template === undefined) throw new Error(`missing locale key: ${key}`)
  return String(template).replace(/\{(\w+)\}/g, (w, k) => (values && k in values ? String(values[k]) : w))
}

// ------------------------------------------------------------------ 设置页
apiPayload = payload()
const view = mount(React.createElement(section.component, { t }))
view.node = attachRefs(renderTree(view.element, [0]))
assert(textOf(view.node).includes('读取顾问设置'), '首屏显示加载态')

await settle(view)

const texts = textOf(view.node)
assert(texts.includes('只读顾问'), '页面标题渲染')
assert(texts.includes('新会话默认开启'), '默认开关行渲染')
for (const domain of ['前端实现 / 组件与状态', '视觉审美 / 排版与质感', '数据与系统建模 / 架构', '后端 / 数据层 / 性能与并发']) {
  assert(texts.includes(domain), '领域行渲染：' + domain)
}

/** 每个领域行现在是自绘下拉：trigger 是 button[aria-haspopup=listbox]。 */
const pickers = () => findAll(view.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')
assert(pickers().length === 4, `四个自绘下拉（实际 ${pickers().length}）`)
assert(findAll(view.node, (n) => n.type === 'select').length === 0,
  '不再使用原生 <select>（Windows 深色主题下选项弹层白底白字）')

const triggers = pickers()
assert(textOf(triggers[0]).includes('跟随默认'), '未选择时显示「跟随默认」')
assert(textOf(triggers[0]).includes('apikey/gpt-6-astra'), '跟随默认项回显当前生效路由')
assert(triggers[0].props['aria-expanded'] === 'false', '默认收起')

// 展开：面板里应有「跟随默认」+ 3 个模型，并按 provider 分组。
triggers[0].props.onClick()
await settle(view)
const menu = findAll(view.node, (n) => n.props.role === 'listbox')[0]
assert(menu !== undefined, '点击后出现 listbox 面板')
const options = findAll(view.node, (n) => n.props.role === 'option')
assert(options.length === 4, `面板里 4 个可选项（实际 ${options.length}）`)
assert(findAll(view.node, (n) => n.props.className === 'dsh-advisors-group').length === 3,
  '按 provider 分组（3 组）')
// 分组标题用 provider 的 displayName，不是裸 id —— 后者是 profile 里的键名，读不懂。
const groupHeads = findAll(view.node, (n) => n.props.className === 'dsh-advisors-group').map(textOf)
assert(groupHeads.includes('chatgpt') && groupHeads.includes('中转站deepseek'),
  '分组标题用 provider displayName：' + groupHeads.join(' / '))
assert(options[0].props['aria-selected'] === 'true', '当前值标记 aria-selected')
assert(findAll(view.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')[0]
  .props['aria-expanded'] === 'true', '展开状态反映到 aria-expanded')

// 再点一下收起。
pickers()[0].props.onClick()
await settle(view)
assert(findAll(view.node, (n) => n.props.role === 'listbox').length === 0, '再点一次收起面板')

// 交互：aesthetic 换成 Claude → POST {domain, modelId}，乐观更新。
let before = calls.length
pickers()[1].props.onClick()
await settle(view)
const openOptions = findAll(view.node, (n) => n.props.role === 'option')
const claudeOption = openOptions.find((n) => textOf(n).includes('apikey1/claude-opus-5-5'))
assert(claudeOption !== undefined, '面板里能找到 Claude 选项（显示完整模型 id）')
assert(textOf(openOptions[0]).includes('apikey/gpt-6-astra'), '「跟随默认」项也回显具体路由')
// note 是「为什么该选它」，挑模型的人靠它决策，必须渲染出来。
assert(textOf(claudeOption).includes('审美与语义分组更强'), '选项保留 note（选择理由）')
claudeOption.props.onClick()
await settle(view)
let posted = calls.slice(before).filter((c) => c.body !== undefined)
assert(posted.length === 1 && posted[0].body.domain === 'aesthetic' && posted[0].body.modelId === 'apikey1/claude-opus-5-5',
  '选 Claude 后发出正确 POST：' + JSON.stringify(posted.map((c) => c.body)))
assert(textOf(view.node).includes('当前生效：apikey1/claude-opus-5-5'), '回执后生效值更新')
assert(textOf(view.node).includes('已保存'), '保存成功有提示')
assert(findAll(view.node, (n) => n.props.role === 'listbox').length === 0, '选完自动收起')

// 键盘操作：Enter 展开 → 焦点进搜索框 → ↓ 移到第二项 → Enter 选中。
before = calls.length
const kbdTrigger = pickers()[2]
kbdTrigger.props.onKeyDown({ key: 'Enter', preventDefault() {} })
await settle(view)
assert(findAll(view.node, (n) => n.props.role === 'listbox').length === 1, 'Enter 能展开面板')

// 展开后焦点必须交给搜索框：键盘用户不该先 Tab 过几十个选项。
const search = findAll(view.node, (n) => n.props.role === 'combobox')[0]
assert(search !== undefined, '面板里有搜索框（role=combobox）')
assert(search.props['aria-autocomplete'] === 'list', '搜索框声明 aria-autocomplete=list')
assert(typeof search.props['aria-label'] === 'string' && search.props['aria-label'].includes('搜索模型'),
  '搜索框有明确的 aria-label（不能只靠 placeholder）')
assert(search.props['aria-activedescendant'] !== undefined, '搜索框用 aria-activedescendant 指当前高亮')

// 选项不再是 button：否则 40+ 项全会进 Tab 序列。
assert(findAll(view.node, (n) => n.props.role === 'option' && n.type === 'button').length === 0,
  '选项不是 button（Tab 序列里只有触发器 + 搜索框）')

// aria id 必须四个领域行互不相同。
// 曾经从 label 派生（中文 label 被 \W+ 清成 '-'），四个领域会撞成同一个前缀，
// aria-controls / aria-activedescendant 指向别的领域行的元素。
const allTriggers = findAll(view.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')
const controlsIds = allTriggers.map((n) => n.props['aria-controls'])
assert(controlsIds.every((id) => typeof id === 'string' && id !== ''),
  '每个触发器都有 aria-controls：' + controlsIds.join(','))
assert(new Set(controlsIds).size === controlsIds.length,
  `四个领域行的 aria-controls 互不相同（实际 ${controlsIds.join(' / ')}）`)

search.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
await settle(view)
const afterDown = findAll(view.node, (n) => n.props.role === 'option')
assert(afterDown[1].props['data-active'] === 'true', '↓ 把高亮移到第二项')
// aria-activedescendant 必须跟着高亮走，否则读屏软件不知道现在选到哪。
const searchAfter = findAll(view.node, (n) => n.props.role === 'combobox')[0]
assert(searchAfter.props['aria-activedescendant'] === afterDown[1].props.id,
  'aria-activedescendant 与高亮项一致')

findAll(view.node, (n) => n.props.role === 'combobox')[0]
  .props.onKeyDown({ key: 'Enter', preventDefault() {} })
await settle(view)
const kbdPosted = calls.slice(before).filter((c) => c.body !== undefined)
assert(kbdPosted.length === 1 && kbdPosted[0].body.domain === 'modeling' &&
  kbdPosted[0].body.modelId === 'apikey/gpt-6-astra', '键盘选中发出对应 POST：' + JSON.stringify(kbdPosted.map((c) => c.body)))

// 搜索：输入能过滤到只剩匹配项，且空格不被当成「选中」。
before = calls.length
pickers()[2].props.onClick()
await settle(view)
const searchBox = () => findAll(view.node, (n) => n.props.role === 'combobox')[0]
searchBox().props.onChange({ target: { value: 'claude' } })
await settle(view)
const filtered = findAll(view.node, (n) => n.props.role === 'option')
assert(filtered.length === 2, `搜 claude 只剩默认项 + 1 个模型（实际 ${filtered.length}）`)
assert(textOf(filtered[1]).includes('claude-opus-5-5'), '过滤结果是对应的 Claude 模型')
// 空格在搜索框里必须是空格，不能触发选择。
searchBox().props.onKeyDown({ key: ' ', preventDefault() {} })
await settle(view)
assert(calls.slice(before).filter((c) => c.body !== undefined).length === 0,
  '搜索框里的空格不会误选（旧版 Space 是选中键）')
// 无匹配时给出提示，且默认项仍然可点。
searchBox().props.onChange({ target: { value: 'zzz-no-such-model' } })
await settle(view)
assert(textOf(view.node).includes('没有匹配的模型'), '无匹配时显示提示')
assert(findAll(view.node, (n) => n.props.role === 'option').length === 1, '无匹配时仍保留「跟随默认」')
pickers()[2].props.onClick()
await settle(view)

// Esc 关闭。
pickers()[3].props.onKeyDown({ key: 'Escape', preventDefault() {} })
await settle(view)
assert(findAll(view.node, (n) => n.props.role === 'listbox').length === 0, 'Esc 不报错且面板保持关闭')

// 「点外面关闭」：展开时应注册捕获阶段监听，收起后移除。
const listenersBefore = docListeners.length
pickers()[3].props.onClick()
await settle(view)
assert(docListeners.length === listenersBefore + 1 && docListeners.at(-1).capture === true,
  '展开时注册「点外面关闭」的捕获监听')
docListeners.at(-1).fn({ target: { contains: () => false } })
await settle(view)
assert(findAll(view.node, (n) => n.props.role === 'listbox').length === 0, '点外面能关闭面板')
assert(docListeners.length === listenersBefore, '关闭后移除监听（不泄漏）')

// 交互：默认开关。
const switches = findAll(view.node, (n) => n.type === 'button' && n.props.role === 'switch')
assert(switches.length === 1, `设置页里只有一个开关（实际 ${switches.length}）`)
// 回归：这个开关绝不能带「整行点击区」伪元素。
// 那个 ::after 是 position:absolute;inset:0，而开关自身 position:static——
// 设置页里没有 .dsh-advisors-row 定位祖先，包含块会一路上溯到宿主设置面板，
// 变成一张覆盖整个页面的透明遮罩，所有点击都被吃掉
// （2026-11-14 主人实测：打开顾问设置页后点哪都没反应，只能点外面退出）。
assert(switches[0].props.className === 'dsh-advisors-switch',
  '设置页开关类名是 dsh-advisors-switch')
const cssSource = fs.readFileSync(path.join(pluginDir, 'client.js'), 'utf8')
// 只看真正的 CSS 规则行（以 . 开头），别把注释里提到的旧写法也算进去。
const cssRuleLines = cssSource.split('\n').filter((line) => line.trim().startsWith('.'))
assert(!cssRuleLines.some((line) => /^\.dsh-advisors-switch:after\s*\{/.test(line.trim())),
  '没有裸的 .dsh-advisors-switch:after 规则（会给设置页盖全屏遮罩）')
assert(cssRuleLines.some((line) => /^\.dsh-advisors-row\s+\.dsh-advisors-switch:after\s*\{/.test(line.trim())),
  '整行点击区的 ::after 被限定在 .dsh-advisors-row 内')
before = calls.length
switches[0].props.onClick()
await settle(view)
posted = calls.slice(before).filter((c) => c.body !== undefined)
assert(posted.length === 1 && posted[0].body.defaultEnabled === true, '默认开关发出 { defaultEnabled: true }')
assert(findAll(view.node, (n) => n.props['aria-checked'] === 'true').length >= 1, '开关状态反映到 aria-checked')

// 失败路径：POST 失败 → 回滚 + 报错，页面不崩。
globalThis.fetch = async (url, init) => {
  if (init?.body !== undefined) return { json: async () => ({ ok: false, error: '磁盘只读' }) }
  return { json: async () => clone(apiPayload) }
}
const pickersAfter = () => findAll(view.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')
pickersAfter()[2].props.onClick()
await settle(view)
findAll(view.node, (n) => n.props.role === 'option')
  .find((n) => textOf(n).includes('deepseek-v4-pro')).props.onClick()
await settle(view)
const failTexts = textOf(view.node)
assert(failTexts.includes('磁盘只读'), '保存失败时把错误显示出来')
assert(failTexts.includes('数据与系统建模 / 架构'), '失败后页面仍可用（未整页崩）')
assert(!textOf(pickersAfter()[2]).includes('deepseek-v4-pro'), '失败后回滚到原选择')

// 目录外的已选值：Host 允许保留 profile 里新加、目录尚未收录的模型。
apiPayload = payload()
apiPayload.domains[3].selected = 'apikey1/claude-opus-6'
apiPayload.domains[3].effective = 'apikey1/claude-opus-6'
globalThis.fetch = async () => ({ json: async () => clone(apiPayload) })
instances.clear()
const view2 = mount(React.createElement(section.component, { t }))
view2.node = attachRefs(renderTree(view2.element, [0]))
await settle(view2)
const lastTrigger = findAll(view2.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')[3]
assert(textOf(lastTrigger).includes('apikey1/claude-opus-6'), '目录外选择不被静默吞掉')
// 展开后该选项要带「目录外」标注。
lastTrigger.props.onClick()
await settle(view2)
assert(textOf(findAll(view2.node, (n) => n.props.role === 'listbox')[0]).includes('目录外'),
  '目录外选择有明确标注')

// ------------------------------------------------------------------ 分组身份碰撞
// 顾问复检给的复现输入：a/b 都叫 chatgpt、c 叫 chatgpt（a）。
// 曾经 `ordered.set(title, ...)` 会让消歧后的标题再次碰撞，直接丢一组模型。
apiPayload = payload()
apiPayload.catalog = [
  { id: 'a/m1', provider: 'a', providerName: 'chatgpt', model: 'm1', label: 'A1', note: '' },
  { id: 'b/m2', provider: 'b', providerName: 'chatgpt', model: 'm2', label: 'B2', note: '' },
  { id: 'c/m3', provider: 'c', providerName: 'chatgpt（a）', model: 'm3', label: 'C3', note: '' },
]
apiPayload.domains[0].selected = null
apiPayload.domains[0].effective = 'a/m1'
globalThis.fetch = async () => ({ json: async () => clone(apiPayload) })
instances.clear()
const view3 = mount(React.createElement(section.component, { t }))
view3.node = attachRefs(renderTree(view3.element, [0]))
await settle(view3)
findAll(view3.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')[0].props.onClick()
await settle(view3)
const collideOptions = findAll(view3.node, (n) => n.props.role === 'option')
assert(collideOptions.length === 4, `标题碰撞时 3 个模型一个不少（含默认项共 4，实际 ${collideOptions.length}）`)
const collideText = textOf(view3.node)
for (const id of ['a/m1', 'b/m2', 'c/m3']) {
  assert(collideText.includes(id), '碰撞场景下模型仍在：' + id)
}
assert(findAll(view3.node, (n) => n.props.className === 'dsh-advisors-group').length === 3,
  '标题碰撞时仍是 3 个分组')

// 真实通道恰好叫「目录外」时，特殊分组不能覆盖它的模型。
apiPayload.catalog = [
  { id: 'x/m1', provider: 'x', providerName: '目录外', model: 'm1', label: 'X1', note: '' },
]
apiPayload.domains[0].selected = 'gone/model'
apiPayload.domains[0].effective = 'gone/model'
globalThis.fetch = async () => ({ json: async () => clone(apiPayload) })
instances.clear()
const view4 = mount(React.createElement(section.component, { t }))
view4.node = attachRefs(renderTree(view4.element, [0]))
await settle(view4)
findAll(view4.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')[0].props.onClick()
await settle(view4)
const collideText2 = textOf(view4.node)
assert(collideText2.includes('x/m1'), '通道名叫「目录外」时它的模型没被特殊分组覆盖')
assert(collideText2.includes('gone/model'), '目录外选择同时也在')

// 搜索不能改变已保存的值，也不能让触发器错显成「跟随默认」。
apiPayload = payload()
apiPayload.domains[1].selected = 'apikey1/claude-opus-5-5'
apiPayload.domains[1].effective = 'apikey1/claude-opus-5-5'
globalThis.fetch = async (url, init) => {
  if (init?.body !== undefined) { calls.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, ...clone(apiPayload) }) } }
  return { json: async () => clone(apiPayload) }
}
instances.clear()
const view5 = mount(React.createElement(section.component, { t }))
view5.node = attachRefs(renderTree(view5.element, [0]))
await settle(view5)
const pickers5 = () => findAll(view5.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')
assert(textOf(pickers5()[1]).includes('claude-opus-5-5'), '选中 Claude 后触发器显示它')
const beforeSearch = calls.length
pickers5()[1].props.onClick()
await settle(view5)
const box5 = findAll(view5.node, (n) => n.props.role === 'combobox')[0]
// 搜一个完全不匹配当前选择、但匹配别的模型的关键词。
box5.props.onChange({ target: { value: 'deepseek' } })
await settle(view5)
const visibleAfterSearch = findAll(view5.node, (n) => n.props.role === 'option')
// 默认项（第一项）的副说明会回显生效路由，那是正常的；只检查真正的模型选项。
const modelOptionsAfterSearch = visibleAfterSearch.filter((n) => n.props.id !== undefined && n.props.id.indexOf('dsh-advisors-') === 0)
assert(visibleAfterSearch.length >= 1, '搜索后仍有选项')
assert(visibleAfterSearch.slice(1).every((n) => !textOf(n).includes('claude-opus-5-5')),
  '搜索确实把当前选择从模型选项里过滤掉了')
assert(textOf(pickers5()[1]).includes('claude-opus-5-5'),
  '触发器仍显示已保存的 Claude（没被过滤结果带偏成「跟随默认」）')
assert(calls.slice(beforeSearch).filter((c) => c.body !== undefined).length === 0,
  '搜索不产生任何写入')
// 输入法组合期间按 Enter 不能选中。
box5.props.onCompositionStart()
box5.props.onKeyDown({ key: 'Enter', preventDefault() {} })
await settle(view5)
assert(calls.slice(beforeSearch).filter((c) => c.body !== undefined).length === 0,
  '输入法组合中的 Enter 不提交')
box5.props.onCompositionEnd()
// 搜索后的高亮：应落在首个匹配项，而不是一律跳回默认项。
const afterSearchOptions = findAll(view5.node, (n) => n.props.role === 'option')
assert(afterSearchOptions.some((n) => n.props['data-active'] === 'true'),
  '搜索后仍有一项处于高亮（视觉与 ARIA 一致）')
const box5b = findAll(view5.node, (n) => n.props.role === 'combobox')[0]
const activeId = box5b.props['aria-activedescendant']
assert(afterSearchOptions.some((n) => n.props.id === activeId && n.props['data-active'] === 'true'),
  'aria-activedescendant 命中的正是高亮项')

// 分组 key 必须来自身份字段，不能是标题（标题重名会产生重复 React key）。
// 注意：这段必须在某个面板展开时执行，否则选项/分组节点还没挂载。
apiPayload = payload()
globalThis.fetch = async () => ({ json: async () => clone(apiPayload) })
instances.clear()
const viewKey = mount(React.createElement(section.component, { t }))
viewKey.node = attachRefs(renderTree(viewKey.element, [0]))
await settle(viewKey)
findAll(viewKey.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')[0].props.onClick()
await settle(viewKey)
const groupNodes = findAll(viewKey.node, (n) => n.props.className === 'dsh-advisors-group')
assert(groupNodes.length > 0, '展开后渲染了分组标题')
assert(groupNodes.every((n) => typeof n.props.key !== 'string' || !n.props.key.startsWith('g:chatgpt')),
  '分组 key 不是标题')
// 选项必须在 mousedown 上 preventDefault：否则点一下只关面板、不选中。
const optNodes = findAll(viewKey.node, (n) => n.props.role === 'option')
assert(optNodes.length > 1, '展开后有多个选项')
assert(optNodes.every((n) => typeof n.props.onMouseDown === 'function'),
  '选项有 onMouseDown（阻止焦点转移，保住 click）')
let prevented = false
optNodes[1].props.onMouseDown({ button: 0, preventDefault: () => { prevented = true } })
assert(prevented, '选项 mousedown 调用了 preventDefault')

// 活动项失效时：视觉高亮、aria-activedescendant、Enter 必须指向同一项。
// 构造「选中项不在目录里」的场景，确认仍恰好一个高亮。
apiPayload = payload()
apiPayload.domains[0].selected = 'gone/not-in-catalog'
apiPayload.domains[0].effective = 'gone/not-in-catalog'
globalThis.fetch = async () => ({ json: async () => clone(apiPayload) })
instances.clear()
const view6 = mount(React.createElement(section.component, { t }))
view6.node = attachRefs(renderTree(view6.element, [0]))
await settle(view6)
findAll(view6.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')[0].props.onClick()
await settle(view6)
const activeOpts = findAll(view6.node, (n) => n.props.role === 'option' && n.props['data-active'] === 'true')
assert(activeOpts.length === 1, `活动项不可见时仍恰好一个高亮（实际 ${activeOpts.length}）`)
const combo = findAll(view6.node, (n) => n.props.role === 'combobox')[0]
assert(combo.props['aria-activedescendant'] === activeOpts[0].props.id,
  'aria-activedescendant 指向那个高亮项')

// 按通道名搜索：高亮应落在首个匹配模型，而不是默认项。
apiPayload = payload()
globalThis.fetch = async () => ({ json: async () => clone(apiPayload) })
instances.clear()
const view7 = mount(React.createElement(section.component, { t }))
view7.node = attachRefs(renderTree(view7.element, [0]))
await settle(view7)
findAll(view7.node, (n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox')[0].props.onClick()
await settle(view7)
// 'chatgpt' 只存在于 providerName（分组标题）里，不在任何模型名/id 里。
findAll(view7.node, (n) => n.props.role === 'combobox')[0]
  .props.onChange({ target: { value: 'chatgpt' } })
await settle(view7)
const byChannel = findAll(view7.node, (n) => n.props.role === 'option' && n.props['data-active'] === 'true')
assert(byChannel.length === 1, '按通道名搜索后有一项高亮')
// 不能用 textOf 判断：默认项的副说明会回显 effective 路由，恰好也含
// 'apikey/gpt-6-astra'，会把断言带偏。必须看选项身份（id 里的 key）。
assert(byChannel[0].props.id.endsWith('-model:apikey/gpt-6-astra'),
  '高亮落在该通道的首个匹配模型，而不是默认项（实际 id：' + byChannel[0].props.id + '）')

// ------------------------------------------------------------------ 模型菜单开关行
const toggleEntry = registered.find((r) => r.options.name === 'conversation.input.model.options').component

apiPayload = payload()
instances.clear()
const row = mount(React.createElement(toggleEntry, {
  t,
  sessionId: 'probe',
  useSession: (selector) => selector({ subagent: null }),
  useSessions: (selector) => selector({ byId: {} }),
}))
row.node = attachRefs(renderTree(row.element, [1]))
await settle(row)
assert(textOf(row.node).includes('启用只读顾问'), '模型菜单开关行渲染')

// 0.1.1：开关改成和宿主 Switch 同构 —— 一个 button + 一个真实装饰 span 当滑块，
// 不再用 ::after 伪元素（伪元素没法用 padding:2px + 子元素 translate 那套定位）。
const rowSwitch = findAll(row.node, (n) => n.type === 'button' && n.props.role === 'switch')
assert(rowSwitch.length === 1, '模型菜单里只有一个顾问开关（实际 ' + rowSwitch.length + '）')
const rowThumb = rowSwitch[0].children || []
assert(rowThumb.length === 1, '开关有一个装饰滑块子元素（实际 ' + rowThumb.length + '）')
assert(rowThumb[0] && rowThumb[0].type === 'span', '滑块是 span 而不是伪元素')
assert(rowThumb[0] && rowThumb[0].props.className === 'dsh-advisors-switch-thumb', '滑块类名是 dsh-advisors-switch-thumb')
assert(rowThumb[0] && rowThumb[0].props['aria-hidden'] === 'true', '滑块 aria-hidden，不污染可访问名称')

// 子智能体会话里不渲染。
instances.clear()
const subRow = mount(React.createElement(toggleEntry, {
  t,
  sessionId: 'sub',
  useSession: (selector) => selector({ subagent: { id: 'x' } }),
  useSessions: (selector) => selector({ byId: {} }),
}))
subRow.node = attachRefs(renderTree(subRow.element, [2]))
await settle(subRow)
assert(subRow.node === null, '子智能体会话不显示开关')

console.log('---')
console.log(process.exitCode === 1 ? '有断言失败' : '全部通过')
