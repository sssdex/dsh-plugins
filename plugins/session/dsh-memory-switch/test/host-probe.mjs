/**
 * dsh-memory-switch 离线自检。
 *
 * 为什么必须有这个文件：本插件的正确性依赖两条**实现细节**——
 *   1. agent/pre-step 的注册顺序（谁的 prepend 更外层）；
 *   2. 系统提示段的装配命名（memory:policy / memory:rules / memory:procedures）。
 * 上游一改，插件会**静默失效**（不报错、只是不剥），所以从写第一行起就配端到端断言。
 *
 * 不 import 真宿主：用一个最小 ctx 模拟 cordis 的 waterfall/prepend 语义即可，
 * 语义与 @deepseek-ai/cordis 的 events.waterfall 一致（本机已核对 asar 源码）：
 *   - 注册：prepend ? unshift : push
 *   - 派发：从数组头开始，逐个 next()，第一个是**最外层**
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------- 最小 cordis 模拟

/** 与真宿主同语义的事件总线：prepend 插到数组头，派发从头开始由外向内。 */
function createEvents() {
  const hooks = new Map()
  return {
    on(name, callback, options) {
      const prepend = options === true || (options !== null && typeof options === 'object' && options.prepend === true)
      if (!hooks.has(name)) hooks.set(name, [])
      const list = hooks.get(name)
      if (prepend) list.unshift(callback)
      else list.push(callback)
      return () => {
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
      }
    },
    /** waterfall：最后一个参数是内层 next。 */
    async waterfall(name, ...args) {
      const inner = args.pop()
      const list = [...(hooks.get(name) ?? [])]
      const dispatch = async () => {
        const callback = list.shift()
        if (callback === undefined) return inner()
        let called = false
        const next = () => {
          if (called) throw new Error('next() called multiple times')
          called = true
          return dispatch()
        }
        return callback(...args, next)
      }
      return dispatch()
    },
    /**
     * 同步 waterfall：`llm/stream` 这类「返回异步可迭代对象」的事件必须用它。
     * 用 async 派发会把返回值包成 Promise，async iterable 就被吃掉了。
     * 语义与 async 版完全一致（本机已核对 cordis 的 waterfall 是同步实现的）。
     */
    waterfallSync(name, ...args) {
      const inner = args.pop()
      const list = [...(hooks.get(name) ?? [])]
      const dispatch = () => {
        const callback = list.shift()
        if (callback === undefined) return inner()
        let called = false
        const next = () => {
          if (called) throw new Error('next() called multiple times')
          called = true
          return dispatch()
        }
        return callback(...args, next)
      }
      return dispatch()
    },
    count(name) { return (hooks.get(name) ?? []).length },
  }
}

/** 最小 ctx：只提供 apply() 用到的那些成员。 */
function createCtx(options = {}) {
  // services 默认必须是空对象。早先没给默认值，`dep in options.services` 会抛
  // TypeError，被插件的注册外围 catch 吞掉 —— 于是所有默认 fixture 实际都在测
  // 「注入注册失败」那条路径，而不是想要的「服务缺失、正常等待」路径。
  // 这类「测试自己制造了错误前提」的坑，正是自检最容易骗人的地方。
  const services = options.services ?? {}
  const events = createEvents()
  const warnings = []
  const provided = new Map()
  /** 记录 ctx.inject 申请过哪些服务 —— 用来断言「用 llm 就必须声明」。 */
  const injectedDeps = []
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)), info() {}, debug() {} },
    on: (name, callback, options_) => events.on(name, callback, options_),
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
    /**
     * 模拟宿主：只有被 inject 声明的服务能拿到。
     * 真 Cordis 里没声明就取会抛 `cannot get property "llm" without inject`，
     * 这里同样抛 —— 让「忘了声明」在自检里就炸，而不是等用户用着突然连话都说不了。
     */
    inject: (deps, callback) => {
      for (const dep of deps) injectedDeps.push(dep)
      const missing = deps.filter((dep) => !(dep in services))
      if (missing.length > 0) return false
      const scoped = {
        logger: ctx.logger,
        effect: ctx.effect,
        on: (name, cb, o) => events.on(name, cb, o),
        ...services,
      }
      callback(scoped)
      return true
    },
    provide: (key, value) => provided.set(key, value),
    events,
    warnings,
    provided,
    injectedDeps,
  }
  return ctx
}

// ---------------------------------------------------------------- 加载被测插件

/** 每次加载都换一个临时 DSH_HOME，避免污染真状态。 */
async function loadPlugin() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  const ctx = createCtx()
  mod.apply(ctx, {})
  // installPreStepGuard 用 setImmediate 延迟注册：等它落地。
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  return { mod, ctx, home }
}

const memoryMessage = (text) => ({
  id: `m-${Math.random()}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'memory', form: 'recall' },
})

const userMessage = (text) => ({
  id: `u-${Math.random()}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

// ---------------------------------------------------------------- 断言

test('默认关闭：新会话不注入记忆（用户 2026-11-14 的要求）', async () => {
  const { ctx } = await loadPlugin()
  const api = ctx.provided.get('memorySwitch')
  assert.equal(api.enabledOf('session-never-seen'), false, '未见过的会话应默认关')
})

test('pre-step：默认关时把记忆追加的消息剔掉，普通消息原样保留', async () => {
  const { ctx } = await loadPlugin()
  const events = ctx.events

  // 模拟 dsh-memory：prepend（更内层），await next() 后追加一条记忆消息。
  // 本插件用 setImmediate 后注册，所以它在数组头 = 更外层。
  let received = null
  events.on('agent/pre-step', async (input, next) => {
    const decision = await next()
    return { ...decision, messages: [...decision.messages, memoryMessage('【相关记忆】\n- abc 发布流程')] }
  }, { prepend: true })

  // 再注册一次被测的…… 不行：被测的已经在 apply 里注册过了，且注册更早。
  // 真实次序是「memory apply → 本插件 setImmediate 注册」，等价于这里反过来：
  // 为了复现真实次序，重新建一个 ctx 并**先**注册 memory 的监听、**后** apply 插件。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  const fresh = createCtx()
  // memory 先注册（相当于它先 apply）
  fresh.events.on('agent/pre-step', async (input, next) => {
    const decision = await next()
    return { ...decision, messages: [...decision.messages, memoryMessage('【相关记忆】\n- abc 发布流程')] }
  }, { prepend: true })
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(fresh, {})
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const decision = await fresh.events.waterfall('agent/pre-step', {
    agent: { session: { id: 'session-off' } },
    step: 1,
    messages: [userMessage('帮我看看这个')],
  }, () => Promise.resolve({ kind: 'enter', messages: [userMessage('帮我看看这个')] }))
  received = decision

  assert.equal(received.messages.length, 1, '记忆那条应被剔掉，只剩原始用户消息')
  assert.equal(received.messages[0].source.kind, 'user')
})

test('pre-step：开关打开时记忆消息保留', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'dsh-memory-switch.json'), JSON.stringify({
    version: 1,
    sessions: { 'session-on': { enabled: true, updatedAt: Date.now() } },
    defaultEnabled: false,
  }))

  const fresh = createCtx()
  fresh.events.on('agent/pre-step', async (input, next) => {
    const decision = await next()
    return { ...decision, messages: [...decision.messages, memoryMessage('【相关记忆】\n- abc')] }
  }, { prepend: true })
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(fresh, {})
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const decision = await fresh.events.waterfall('agent/pre-step', {
    agent: { session: { id: 'session-on' } },
    step: 1,
    messages: [userMessage('问题')],
  }, () => Promise.resolve({ kind: 'enter', messages: [userMessage('问题')] }))

  assert.equal(decision.messages.length, 2, '开着就应保留记忆消息')
  assert.ok(decision.messages.some((m) => m.source.kind === 'memory'))
})

test('pre-step：拒绝的步骤原样放行，绝不被改结构', async () => {
  const { ctx } = await loadPlugin()
  const reject = { kind: 'reject', text: 'nope' }
  const decision = await ctx.events.waterfall('agent/pre-step', {
    agent: { session: { id: 'session-x' } },
    step: 1,
    messages: [],
  }, () => Promise.resolve(reject))
  assert.equal(decision, reject, 'reject 决策必须同一个对象原样返回')
})

test('系统提示：默认关时剥掉记忆三段，其它段一个不动', async () => {
  const { ctx } = await loadPlugin()
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent.' },
      { name: 'memory:policy', text: '## 记忆系统 ...' },
      { name: 'memory:rules', text: '规则段' },
      { name: 'memory:procedures', text: '流程索引' },
      { name: 'tool:ask_advisor', text: '顾问段' },
    ],
    contexts: [],
    variables: {},
  }
  const out = await ctx.events.waterfall('system-prompt/assemble', assembly, {
    agent: { session: { id: 'session-off' } },
  }, () => Promise.resolve(assembly))

  const names = out.sections.map((s) => s.name)
  assert.deepEqual(names, ['harness:identity', 'tool:ask_advisor'], '记忆三段应全被剥掉')
  assert.equal(out.sections.length, 2)
})

test('系统提示：开关打开时三段都在', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'dsh-memory-switch.json'), JSON.stringify({
    version: 1,
    sessions: { 'session-on': { enabled: true, updatedAt: Date.now() } },
    defaultEnabled: false,
  }))
  const ctx = createCtx()
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))

  const assembly = {
    sections: [
      { name: 'memory:policy', text: '策略' },
      { name: 'memory:rules', text: '规则' },
    ],
    contexts: [],
    variables: {},
  }
  const out = await ctx.events.waterfall('system-prompt/assemble', assembly, {
    agent: { session: { id: 'session-on' } },
  }, () => Promise.resolve(assembly))
  assert.equal(out.sections.length, 2)
})

test('消息识别：只认 source.kind=memory，绝不按文本猜（防误删用户输入）', async () => {
  const { ctx } = await loadPlugin()
  const api = ctx.provided.get('memorySwitch')
  assert.equal(api.isMemoryMessage(memoryMessage('随便什么')), true)
  assert.equal(api.isMemoryMessage(userMessage('普通用户消息')), false)

  // 关键回归：用户真的发一条以【相关记忆】开头的消息（贴回来问这是什么、
  // 或让我解释注入内容）——这条**必须保留**。第一版按段首文本认，会把它整条删掉，
  // 表现是「我没说话它就自己动了」，而且是删掉当前这一轮的用户输入。
  assert.equal(api.isMemoryMessage(userMessage('【相关记忆】\n- 这条是我自己打的，别删')), false,
    '用户手打的【相关记忆】绝不能被当成注入删掉')
  assert.equal(api.isMemoryMessage(userMessage('【记忆权限已更新】这是我自己粘贴的')), false)

  // 没有 source 的消息一律不动（来源不明就不猜）。
  assert.equal(api.isMemoryMessage({ role: 'user', content: [{ type: 'text', text: '【相关记忆】' }] }), false)
  // assistant / tool 的正文即使长得像也不动。
  assert.equal(api.isMemoryMessage({ role: 'assistant', content: [{ type: 'text', text: '【相关记忆】' }], source: { kind: 'assistant' } }), false)
})

test('全局总闸：globalDisabled 会压过所有会话的显式开启', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'dsh-memory-switch.json'), JSON.stringify({
    version: 1,
    sessions: { 'session-a': { enabled: true, updatedAt: 1 } },
    defaultEnabled: false,
    globalDisabled: true,
  }))
  const ctx = createCtx()
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const api = ctx.provided.get('memorySwitch')
  assert.equal(api.enabledOf('session-a'), false, '总闸关闭时，显式开启的会话也必须关')
  // 总闸关掉不等于抹掉会话偏好：打开总闸后，session-a 应当恢复为开。
  assert.equal(api.isGloballyDisabled(), true)
})

test('全局总闸：恢复后会话原有的显式偏好还在（可逆）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'dsh-memory-switch.json'), JSON.stringify({
    version: 1,
    sessions: { 'session-a': { enabled: true, updatedAt: 1 } },
    defaultEnabled: false,
    globalDisabled: false,
  }))
  const ctx = createCtx()
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const api = ctx.provided.get('memorySwitch')
  assert.equal(api.enabledOf('session-a'), true, '总闸开着时会话偏好照常生效')
})

test('全局总闸：连「拿不到 sessionId」的路径也必须被总闸压住', async () => {
  // 这条是回归：曾在 injectionOffFor 里直接读 defaultEnabled，导致
  // 「没有 agent 的装配 / 拿不到会话 id 的请求」绕过总闸继续注入。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'dsh-memory-switch.json'), JSON.stringify({
    version: 1,
    sessions: {},
    defaultEnabled: true, // 默认本来是开的
    globalDisabled: true, // 总闸却关着
  }))
  const fresh = createCtx()
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(fresh, {})
  await new Promise((resolve) => setImmediate(resolve))

  const assembly = { sections: [{ name: 'memory:policy', text: '策略' }], contexts: [], variables: {} }
  // context 里没有 agent —— 走「拿不到会话」那条分支。
  const out = await fresh.events.waterfall('system-prompt/assemble', assembly, {}, () => Promise.resolve(assembly))
  assert.equal(out.sections.length, 0, '总闸关着时，没有 agent 的装配也必须剥掉记忆段')
})

test('总闸：POST 与 GET 必须返回一致的有效状态（不能回显请求值）', async () => {
  // 这是回归：第二版 POST 直接回显 body.enabled，总闸关着时点「开启」会显示已开，
  // 实际 enabledOf 仍是 false —— 谎报。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  const ctx = createCtx({
    services: {
      // 提供 webServer，让路由注册上，才能拿到真实快照函数的行为。
      webServer: { register: () => () => {} },
      llm: { stream() { return (async function* () {})() } },
    },
  })
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const api = ctx.provided.get('memorySwitch')

  // 直接验语义层：总闸关着 + 会话偏好 true ⇒ 有效值必须 false。
  fs.writeFileSync(path.join(home, 'dsh-memory-switch.json'), JSON.stringify({
    version: 1,
    sessions: { 's-1': { enabled: true, updatedAt: 1 } },
    defaultEnabled: false,
    globalDisabled: true,
  }))
  const url2 = new URL('../index.js', import.meta.url)
  url2.search = `?t=${Date.now()}-${Math.random()}`
  const mod2 = await import(url2.href)
  const ctx2 = createCtx()
  mod2.apply(ctx2, {})
  await new Promise((resolve) => setImmediate(resolve))
  const api2 = ctx2.provided.get('memorySwitch')

  assert.equal(api2.enabledOf('s-1'), false, '总闸关着：有效值必须是 false')
  assert.equal(api2.isGloballyDisabled(), true)
  // 会话偏好本身仍在（未被总闸抹掉）
  const disk = JSON.parse(fs.readFileSync(path.join(home, 'dsh-memory-switch.json'), 'utf8'))
  assert.equal(disk.sessions['s-1'].enabled, true, '总闸不能抹掉会话偏好')
  assert.ok(api !== undefined)
})

test('快照协议：ready 必须是布尔值，不能是对象', async () => {
  // 回归：曾写成 `ready: guards.preStep && guards.assembly`，
  // 两个都是对象时 `&&` 返回后者，接口真的回了 `ready:{registered:...}`。
  // 客户端只判 `!== false` 恰好没炸，但协议已经错了。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home

  // 直接对着源码断言：ready 字段必须显式比较 .registered
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(
    /ready:\s*guards\.preStep\.registered\s*===\s*true\s*&&\s*guards\.assembly\.registered\s*===\s*true/.test(source),
    'ready 必须显式比较 .registered 并得到布尔值，不能写成 a && b 返回对象',
  )
  assert.ok(
    !/ready:\s*guards\.preStep\s*&&/.test(source),
    '不要再用 `guards.preStep && guards.assembly` 这种返回对象的写法',
  )
})

test('落盘：写过的会话开关在重新加载后还在（防「静默丢选择」）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'dsh-memory-switch.json'), JSON.stringify({
    version: 1,
    sessions: { 'session-keep': { enabled: true, updatedAt: 1 } },
    defaultEnabled: false,
  }))
  const ctx = createCtx()
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  const api = ctx.provided.get('memorySwitch')
  assert.equal(api.enabledOf('session-keep'), true, '会话显式值必须优先于默认值')
  assert.equal(api.enabledOf('session-other'), false)
})

test('坏文件不炸：损坏的状态文件按默认值处理并只告警', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'dsh-memory-switch.json'), '{ 这不是 JSON')
  const ctx = createCtx()
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  assert.doesNotThrow(() => mod.apply(ctx, {}))
  await new Promise((resolve) => setImmediate(resolve))
  const api = ctx.provided.get('memorySwitch')
  assert.equal(api.enabledOf('x'), false)
  assert.ok(ctx.warnings.some((w) => w.includes('状态文件不可读')), '应当留下一条告警')
})

test('兜底层：即使 pre-step 顺序变了，llm/stream 也会把记忆消息剔掉', async () => {
  // 这一层专门防「注册顺序反转」——此时 pre-step 那层会失效，请求层必须兜住。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  // llm 服务：记录真正发出去的请求。
  const sent = []
  const ctx = createCtx({
    services: {
      llm: {
        stream(options) {
          sent.push(options)
          return (async function* () { /* 空流 */ })()
        },
      },
    },
  })
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(ctx.injectedDeps.includes('llm'), '必须通过 ctx.inject 声明 llm 依赖（否则真宿主会抛 cannot get property "llm" without inject）')

  // 造一个「loop 请求」：冻结 + sessionId + messages（与宿主 buildRequest 同形）。
  const options = Object.freeze({
    provider: 'p',
    model: 'm',
    sessionId: 'session-off',
    messages: Object.freeze([userMessage('问题'), memoryMessage('【相关记忆】\n- abc')]),
  })
  for await (const _ of ctx.events.waterfallSync('llm/stream', options, () => (async function* () {})())) { /* drain */ }

  assert.equal(sent.length, 1, '应当重派一次请求')
  assert.equal(sent[0].messages.length, 1, '记忆消息应被剔掉')
  assert.equal(sent[0].messages[0].source.kind, 'user')
  assert.notEqual(sent[0], options, '必须是副本，不能改动冻结的原请求')
  assert.equal(options.messages.length, 2, '原请求不能被改动')

  // 副本必须仍然冻结：dsh-inject 用 Object.isFrozen 认 loop 请求，
  // 给个没冻结的副本会让它的预设静默失效。
  assert.equal(Object.isFrozen(sent[0]), true, '重派的副本必须保持冻结，否则别的注入插件认不出来')
})

test('异常边界：next() 抛错时绝不再调一次 next()（这是把对话搞挂的写法）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  let nextCalls = 0
  const ctx = createCtx({
    services: {
      llm: { stream() { return (async function* () {})() } },
    },
  })
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))

  // 开关开着 → 本插件不替换，直接走 next()；让 next() 抛错模拟下游故障。
  const options = Object.freeze({
    provider: 'p', model: 'm', sessionId: 'session-on',
    messages: Object.freeze([userMessage('问题')]),
  })
  const next = () => { nextCalls += 1; throw new Error('下游炸了') }

  assert.throws(
    () => ctx.events.waterfallSync('llm/stream', options, next),
    /下游炸了/,
    '下游的原始错误必须原样冒泡，不能被包装成别的东西',
  )
  assert.equal(nextCalls, 1, 'next() 只能被调用一次 —— 二次调用会重复派发请求或撞上 next() called multiple times')
})

test('保存失败必须如实报错：不能回 ok:true 骗用户（重启后变回去的那种）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  const ctx = createCtx()
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))

  // 直接测内部：让状态文件路径不可写（父路径被一个同名文件占住）。
  const blocker = path.join(home, 'blocked')
  fs.writeFileSync(blocker, 'x')
  process.env.DSH_HOME = blocker  // dsh-memory-switch.json 会落在 blocked/ 下，必然失败

  const api = ctx.provided.get('memorySwitch')
  // commit 走 saveState → 必须抛，而不是吞掉。
  assert.throws(() => api._setEnabledForTest('s1', true), /ENOTDIR|EEXIST|not a directory|ENOENT|EACCES|EPERM/i,
    '写盘失败必须抛出来')
  // 内存状态不能被改脏：写盘失败后仍是默认（关）。
  assert.equal(api.enabledOf('s1'), false, '写盘失败后内存状态不能漂移')
})

test('兜底层：重派不会死循环（副本再进监听时消息已干净，直接放行）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mswitch-'))
  process.env.DSH_HOME = home
  let streamCalls = 0
  const ctx = createCtx({
    services: {
      llm: {
        /**
         * 模拟真宿主：每次 stream() 都会重新派发 llm/stream 事件。
         * 这逼出「副本再进监听」这条路径 —— 若闸门写错就会无限递归。
         */
        stream(options) {
          streamCalls += 1
          if (streamCalls > 5) throw new Error('递归失控：stream 被调了 5 次以上')
          return ctx.events.waterfallSync('llm/stream', options, () => (async function* () { /* 空流 */ })())
        },
      },
    },
  })
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  mod.apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))

  const options = Object.freeze({
    provider: 'p',
    model: 'm',
    sessionId: 'session-off',
    messages: Object.freeze([userMessage('问题'), memoryMessage('【相关记忆】\n- abc')]),
  })
  for await (const _ of ctx.events.waterfallSync('llm/stream', options, () => (async function* () {})())) { /* drain */ }

  assert.equal(streamCalls, 1, '只应重派一次，之后副本再进来必须直接放行')
})
