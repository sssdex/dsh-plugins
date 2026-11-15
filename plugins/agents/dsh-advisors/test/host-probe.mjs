/**
 * Host 半边回归测试：把 index.js 的 apply() 装到假 Context 上，直接驱动 HTTP handler。
 *
 * 被测的是真实代码路径：路由解析、读写盘、领域路由优先级、工具 run 时用的 model、守卫。
 * 不连接真宿主，也不启动第二个服务。
 *
 * 用法：node test/host-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')

// ---------------------------------------------------------------- 隔离的 DSH_HOME
// 必须在 import 被测模块之前设置：loadState() 在 apply() 时读这个路径。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'advisors-probe-'))
process.env.DSH_HOME = home

const assert = (ok, message) => {
  if (!ok) { console.error('FAIL ' + message); process.exitCode = 1 } else console.log('ok   ' + message)
}

// ---------------------------------------------------------------- 假 Context
const routes = []
const effects = []
const toolRegistrations = []
const promptSections = []
const agentHandlers = []
const disposedHandlers = []
const adapterHandlers = []
const startedActivations = []
const warnings = []

const ctx = {
  logger: { warn: (m) => warnings.push(m) },
  effect: (fn, label) => { effects.push({ label, dispose: fn() }) },
  on: (event, handler) => {
    if (event === 'agent/created') agentHandlers.push(handler)
    if (event === 'agent/disposed') disposedHandlers.push(handler)
    if (event === 'llm/adapters-updated') adapterHandlers.push(handler)
  },
  // llm 不在 inject 里，插件用 ctx.get('llm') 在调用时刻取（缺席也要能活）。
  get: (name) => (name === 'llm' ? ctx.llm : undefined),
  webServer: {
    register: (spec) => {
      routes.push(spec)
      return () => { const i = routes.indexOf(spec); if (i >= 0) routes.splice(i, 1) }
    },
  },
  systemPrompt: {
    section: (spec) => { promptSections.push(spec) },
    getSectionOrder: () => 500,
  },
  tools: { register: (def, opts) => { toolRegistrations.push({ def, opts }); return () => {} } },
  subagents: {
    rootOf: (agent) => agent,
    startActivation: async (spec) => { startedActivations.push(spec); return { name: spec.name ?? 'advisor-1' } },
  },
  // 宿主 LLM 注册表的替身。目录现在是**现查**的，所以这里必须能列出通道和模型。
  // 故意做成「profile 里还有插件不知道的通道」的形状：这正是被修的那个 bug。
  llm: {
    listProviders: () => [
      { id: 'apikey', name: 'chatgpt' },
      { id: 'apikey1', name: 'claude' },
      { id: 'zzz1', name: '中转站deepseek' },
      { id: 'kele-claude', name: 'kele claude' },
    ],
    listModels: async (provider) => {
      const table = {
        apikey: [{ provider: 'apikey', id: 'gpt-6-astra', name: 'GPT-6 Astra' }],
        apikey1: [{ provider: 'apikey1', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
        zzz1: [{ provider: 'zzz1', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
        'kele-claude': [{ provider: 'kele-claude', id: 'claude-fable-5-2', name: 'claude-fable-5-2' }],
      }
      return table[provider] ?? []
    },
  },
}

/** 清空所有收集器（模拟一次干净的 Host reload）。 */
const resetCollectors = () => {
  routes.length = 0
  effects.length = 0
  toolRegistrations.length = 0
  promptSections.length = 0
  agentHandlers.length = 0
  adapterHandlers.length = 0
}

const entry = new URL('../index.js', import.meta.url).href
const mod = await import(entry)
mod.apply(ctx, {})

assert(mod.name === 'dsh-advisors', '导出 name 等于包名')
assert(Array.isArray(mod.inject) && mod.inject.length === 4, 'inject 保持四个服务（llm 不是硬依赖）')
assert(!mod.inject.includes('llm'), 'llm 不进 inject —— 目录缺席不该让整个插件不挂载')
assert(routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/dsh-advisors-api', '注册了 prefix 路由')
assert(toolRegistrations.length === 1 && toolRegistrations[0].def.name === 'ask_advisor', '注册了 ask_advisor')
assert(promptSections.length === 1, '注册了提示词段落')
assert(agentHandlers.length === 1, '挂了一个 agent/created 监听')
assert(adapterHandlers.length === 1, '订阅了 llm/adapters-updated 用来作废目录缓存')

// ---------------------------------------------------------------- 直接调 handler
/** GET 现在要 await 宿主目录，handler 走异步 IIFE，所以这里也返回 Promise。 */
function get(url, hostHeader = '127.0.0.1:10751') {
  let status = 0
  let payload = ''
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const req = { method: 'GET', url, headers: { host: hostHeader } }
  const res = {
    writeHead: (s) => { status = s },
    end: (chunk) => { if (chunk !== undefined) payload += String(chunk); settle() },
  }
  routes[0].handler(req, res)
  return done.then(() => ({ status, json: payload === '' ? undefined : JSON.parse(payload) }))
}

/** POST 分支是异步的，返回一个在 end() 时 resolve 的 Promise。 */
function post(body, hostHeader = '127.0.0.1:10751') {
  let status = 0
  let payload = ''
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const req = {
    method: 'POST',
    url: '/dsh-advisors-api',
    headers: { host: hostHeader },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  }
  const res = {
    writeHead: (s) => { status = s },
    end: (chunk) => { if (chunk !== undefined) payload += String(chunk); settle() },
  }
  routes[0].handler(req, res)
  return done.then(() => ({ status, json: payload === '' ? undefined : JSON.parse(payload) }))
}

// 1) GET 默认视图
const got = await get('/dsh-advisors-api?sessionId=probe')
assert(got.status === 200, 'GET 返回 200')
assert(got.json.ok === true && got.json.enabled === false, 'GET 回执：未开启')
assert(got.json.defaultEnabled === false, 'GET 回执带 defaultEnabled')
assert(Array.isArray(got.json.catalog) && got.json.catalog.length === 4,
  `目录来自宿主现查（4 个模型，实际 ${got.json.catalog?.length}）`)
const catalogIds = got.json.catalog.map((m) => m.id)
assert(catalogIds.includes('apikey/gpt-6-astra') && catalogIds.includes('apikey1/claude-opus-5-5'),
  '目录包含宿主声明的模型')
// 关键回归点：profile 里存在、但旧版写死目录里没有的通道，现在必须出现。
assert(catalogIds.includes('kele-claude/claude-fable-5-2'),
  'profile 里新加的通道自动进下拉（这是本轮修的问题）')
assert(got.json.catalog.find((m) => m.id === 'apikey/gpt-6-astra').providerName === 'chatgpt',
  '目录项带 provider displayName，供下拉分组')
assert(Array.isArray(got.json.domains) && got.json.domains.length === 4, 'GET 回执带四个领域')
const frontend = got.json.domains.find((d) => d.domain === 'frontend')
assert(frontend.selected === null && frontend.effective === 'apikey/gpt-6-astra', '缺省时 selected 为 null、effective 回落 GPT-6 Astra')

// 2) 非回环 Host 被拒（DNS rebinding 防线）
const forbidden = await get('/dsh-advisors-api', 'evil.example.com')
assert(forbidden.status === 403, '非回环 Host 返回 403')

// 3) POST 领域模型
let r = await post({ domain: 'aesthetic', modelId: 'apikey1/claude-opus-5-5' })
assert(r.status === 200 && r.json.ok === true, 'POST domain 成功')
assert(r.json.effective === 'apikey1/claude-opus-5-5', '回执里生效路由已更新')
const savedRaw = JSON.parse(fs.readFileSync(path.join(home, 'dsh-advisors.json'), 'utf8'))
assert(savedRaw.routes.aesthetic === 'apikey1/claude-opus-5-5', '选择落盘到 routes')
assert(!fs.existsSync(path.join(home, 'dsh-advisors.json.tmp')), '不留 .tmp 残渣')

// 4) ask_advisor 实际用的模型 = 用户选择（这是「接线」的关键回归点）
const tool = toolRegistrations[0]
const parent = { session: { id: 'session-parent', header: { delegationDepth: 0 } }, options: {} }
const exec = { agent: parent, signal: undefined }
const act = await tool.def.execute({ domain: 'aesthetic', question: '分组语义该怎么切？' }, exec)
assert(act.provider === 'apikey1' && act.model === 'claude-opus-5-5', `顾问实跑 Claude（回执 ${act.provider}/${act.model}）`)
const spec = startedActivations.at(-1)
assert(spec.agentOptions.provider === 'apikey1' && spec.agentOptions.model === 'claude-opus-5-5', 'startActivation 带上选择的模型')
assert(spec.agentPreset === 'advisor' && spec.delivery === 'parent', '预设与投递方式正确')
assert(spec.maxDepth === 1, `主智能体开顾问 maxDepth = 1（实际 ${spec.maxDepth}）`)

// 子智能体（深度 1）能开顾问；顾问自己（深度 2）再往下派就超限。
const child = { session: { id: 'session-child', header: { delegationDepth: 1 } }, options: {} }
await tool.def.execute({ domain: 'backend', question: '并发上限怎么保？' }, { agent: child, signal: undefined })
assert(startedActivations.at(-1).maxDepth === 2, '子智能体开顾问 maxDepth = 2')
assert(startedActivations.at(-1).agentOptions.model === 'gpt-6-astra', 'backend 未被改动，仍走 GPT-6 Astra')

// 5) 校验：未知领域 / 非法 id / 空 body
r = await post({ domain: 'nope', modelId: 'apikey/gpt-6-astra' })
assert(r.status === 400 && /未知领域/.test(r.json.error), '未知领域被拒')
r = await post({ domain: 'backend', modelId: 'garbage' })
assert(r.status === 400 && /provider\/model/.test(r.json.error), '非法 modelId 被拒')
r = await post({})
assert(r.status === 400 && /需要/.test(r.json.error), '空 body 被拒')
// JSON null / 数组 / 标量都能被 JSON.parse 解析出来，必须挡成 400 而不是 500。
for (const bad of [null, [], 'text', 42]) {
  r = await post(bad)
  assert(r.status === 400, `${JSON.stringify(bad)} 被挡成 400（实际 ${r.status}）`)
}

// 6) 清除选择回退默认
r = await post({ domain: 'aesthetic', modelId: null })
assert(r.json.effective === 'apikey/gpt-6-astra', '清除选择后回退默认模型')
assert(JSON.parse(fs.readFileSync(path.join(home, 'dsh-advisors.json'), 'utf8')).routes.aesthetic === undefined, '清除后 routes 里不残留')

// 7) 目录外 id 也接受（来自 profile 新增、目录尚未收录的模型）
r = await post({ domain: 'modeling', modelId: 'apikey1/claude-opus-6' })
assert(r.json.effective === 'apikey1/claude-opus-6', '目录外 id 被接受')
const external = await tool.def.execute({ domain: 'modeling', question: 'x' }, exec)
assert(external.model === 'claude-opus-6', '目录外 id 能真的跑到')

// 8) 全局默认 + 会话覆盖
r = await post({ defaultEnabled: true })
assert(r.json.defaultEnabled === true, '默认开启写入成功')
assert((await get('/dsh-advisors-api?sessionId=fresh-session')).json.enabled === true, '新会话跟随全局默认 = 开启')
r = await post({ sessionId: 'fresh-session', enabled: false })
assert(r.json.enabled === false, '会话显式关闭')
assert((await get('/dsh-advisors-api?sessionId=fresh-session')).json.enabled === false, '显式值压过全局默认')

// 9) 重启后设置仍在（模拟 Host reload：重新 apply）
const stateBefore = JSON.parse(fs.readFileSync(path.join(home, 'dsh-advisors.json'), 'utf8'))
assert(stateBefore.routes.modeling === 'apikey1/claude-opus-6', '落盘的 routes 还在')
assert(stateBefore.defaultEnabled === true, '落盘的 defaultEnabled 还在')

const mod2 = await import(entry + '?reload=1')
resetCollectors()
mod2.apply(ctx, {})
const afterReload = await get('/dsh-advisors-api')
assert(afterReload.json.domains.find((d) => d.domain === 'modeling').effective === 'apikey1/claude-opus-6',
  '重载后用户选择没丢（曾经会被 loadState 吞掉）')
assert(afterReload.json.defaultEnabled === true, '重载后全局默认没丢')
assert(afterReload.json.catalog.some((m) => m.id === 'kele-claude/claude-fable-5-2'),
  '重载后目录仍是现查的（不依赖落盘）')

// 10) 提示词里写明当前分工，且只在开启时出现
//     `fresh-session` 上一步被显式关了；这里用一个没被显式设置过的会话（跟随全局默认 = 开）。
const guidance = promptSections[0].text({ agent: { session: { id: 'brand-new-session', header: {} } } })
assert(guidance.includes('modeling') && guidance.includes('apikey1/claude-opus-6'), '提示词列出真实分工')
assert(guidance.includes('apikey/gpt-6-astra'), '提示词里默认领域仍标 Astra')
assert(promptSections[0].text({ agent: { session: { id: 'fresh-session', header: {} } } }) === '',
  '未开启时提示词为空（模型看不到这个能力）')

// 11) 守卫：顾问会话装 restrict + guard，拒绝非只读工具
const guardCalls = []
const restrictCalls = []
let restrictDisposed = 0
let guardDisposed = 0
const advisorAgent = {
  session: { id: 'session-advisor', header: { agentPreset: 'advisor' } },
  cancelCalls: [],
  cancel(reason) { this.cancelCalls.push(reason) },
  ctx: {
    tools: {
      restrict: (filter) => {
        restrictCalls.push(filter)
        return () => { restrictDisposed++ }
      },
      guard: (fn) => { guardCalls.push(fn); return () => { guardDisposed++ } },
    },
  },
}
agentHandlers.forEach((fn) => fn({ agent: advisorAgent }))

// restrict 是精确白名单：只放行四个只读工具名。
// 真机教训（会话 8e83baa6）：曾经写成 allow:[]，结果工具清单变成 0 个——
// 预设的 read/glob/grep 注册在全局层，own 为空，全被 allow:[] 掐掉。
assert(restrictCalls.length === 1, `顾问会话装了 restrict（实际 ${restrictCalls.length}）`)
assert(Array.isArray(restrictCalls[0].allow), 'restrict 使用 allow 白名单')
assert(
  JSON.stringify([...restrictCalls[0].allow].sort()) === JSON.stringify(['glob', 'grep', 'read', 'read_image']),
  `白名单恰好是四个只读工具（实际 ${JSON.stringify(restrictCalls[0].allow)}）`,
)
assert(restrictCalls[0].deny === undefined, 'restrict 不混用 deny')

assert(guardCalls.length === 1, `顾问会话装了守卫（实际 ${guardCalls.length}）`)
assert(typeof guardCalls[0] === 'function', '守卫回调可用')
assert(guardCalls[0]({ name: 'read' }) === undefined, 'read 放行')
assert(guardCalls[0]({ name: 'glob' }) === undefined, 'glob 放行')
assert(guardCalls[0]({ name: 'grep' }) === undefined, 'grep 放行')
assert(guardCalls[0]({ name: 'read_image' }) === undefined, 'read_image 放行')
const denyMeme = guardCalls[0]({ name: 'send_meme' })
assert(typeof denyMeme === 'string' && denyMeme.includes('send_meme'), 'send_meme 被拒并给出理由')
const denySub = guardCalls[0]({ name: 'subagent' })
assert(typeof denySub === 'string' && denySub.includes('subagent'), 'subagent 被拒')
assert(advisorAgent.cancelCalls.length === 0, '安装成功时不中止顾问')

// 11b) fail-closed：精确白名单装不上 → 不再静默降级。
//      running 时 cancel 有效，因此不必抛错；idle 时 cancel 拦不住，必须抛错
//      让 agent 注册失败（见 11c）。
const fallbackAgent = {
  id: 'advisor-fallback',
  session: { id: 'session-advisor-fallback', header: { agentPreset: 'advisor' } },
  status: 'running',
  cancelCalls: [],
  cancel(reason) { this.cancelCalls.push(reason) },
  ctx: {
    tools: {
      restrict: () => { throw new Error('unknown global tool "read"') },
      guard: () => () => {},
    },
  },
}
let restrictFailThrew = false
try {
  agentHandlers.forEach((fn) => fn({ agent: fallbackAgent }))
} catch {
  restrictFailThrew = true
}
assert(!restrictFailThrew, 'running 时靠 cancel 中止即可，不必抛错')
assert(fallbackAgent.cancelCalls.length === 1, 'restrict 失败时中止 running 顾问')

// 11c) idle 状态下 cancel 阻止不了顾问 → 必须抛错拒绝注册，且不谎报「已中止」
const idleAgent = {
  id: 'advisor-idle',
  session: { id: 'session-advisor-idle', header: { agentPreset: 'advisor' } },
  status: 'idle',
  cancelCalls: [],
  cancel(reason) { this.cancelCalls.push(reason) },
  ctx: {
    tools: {
      restrict: () => { throw new Error('boom-restrict') },
      guard: () => () => {},
    },
  },
}
let idleThrew = false
try {
  agentHandlers.forEach((fn) => fn({ agent: idleAgent }))
} catch (error) {
  idleThrew = true
  assert(/只读工具边界/.test(error.message), '抛出的错误可读：' + error.message)
}
assert(idleThrew, 'idle 顾问靠抛错拒绝注册（真 fail-closed）')
assert(idleAgent.cancelCalls.length === 0, 'idle 时不调用 cancel（拦不住，不该假中止）')

// 11c2) 白名单成功但 guard 装不上 → running 时中止；idle 时抛错。这里测 running。
const guardFailAgent = {
  id: 'advisor-guardfail',
  session: { id: 'session-advisor-guardfail', header: { agentPreset: 'advisor' } },
  status: 'running',
  releaseCalls: 0,
  cancelCalls: [],
  cancel(reason) { this.cancelCalls.push(reason) },
  ctx: {
    tools: {
      restrict: () => () => { guardFailAgent.releaseCalls++ },
      guard: () => { throw new Error('boom-guard') },
    },
  },
}
let guardThrew = false
try {
  agentHandlers.forEach((fn) => fn({ agent: guardFailAgent }))
} catch {
  guardThrew = true
}
assert(!guardThrew, 'running 时 guard 失败靠 cancel 中止即可')
assert(guardFailAgent.cancelCalls.length === 1, 'guard 失败时中止 running 顾问')
assert(guardFailAgent.releaseCalls === 1, `失败时已装的 restrict 被回滚（实际 ${guardFailAgent.releaseCalls}）`)

const otherAgent = {
  session: { id: 'session-normal', header: { agentPreset: 'standard' } },
  ctx: {
    tools: {
      restrict: () => { guardCalls.push('should-not-happen'); return () => {} },
      guard: () => { guardCalls.push('should-not-happen'); return () => {} },
    },
  },
}
agentHandlers.forEach((fn) => fn({ agent: otherAgent }))
assert(!guardCalls.includes('should-not-happen'), '普通会话不装顾问守卫')

// 11d) 拆卸顺序：插件卸载时必须先确保顾问停止，再摘守卫（不能留裸奔窗口）
const teardownOrder = []
const liveAdvisor = {
  id: 'advisor-live',
  session: { id: 'session-advisor-live', header: { agentPreset: 'advisor' } },
  status: 'running',
  cancel() { teardownOrder.push('cancel') },
  ctx: {
    tools: {
      restrict: () => () => { teardownOrder.push('restrict-release') },
      guard: () => () => { teardownOrder.push('guard-dispose') },
    },
  },
}
agentHandlers.forEach((fn) => fn({ agent: liveAdvisor }))
assert(teardownOrder.length === 0, '安装阶段不触发拆卸')

// 触发 ctx.effect 注册的拆卸回调（host-probe 收集了 effects）
const teardownEffects = effects.filter(e => e.label === 'dsh-advisors: advisor guards teardown')
assert(teardownEffects.length === 1, `注册了一个守卫拆卸 effect（实际 ${teardownEffects.length}）`)
teardownEffects[0].dispose()
assert(teardownOrder.includes('cancel'), '卸载时中止存活顾问')
assert(teardownOrder.indexOf('cancel') < teardownOrder.indexOf('guard-dispose'),
  '先中止顾问再摘守卫（顺序不可反）')
assert(teardownOrder.indexOf('cancel') < teardownOrder.indexOf('restrict-release'),
  '先中止顾问再撤 restrict（顺序不可反）')

// 11d2) 顾问 idle 时中止不了 → 不能乐观撤保护，要留着守卫等到 disposed
const idleTeardown = []
const idleLive = {
  id: 'advisor-idle-live',
  session: { id: 'session-advisor-idle-live', header: { agentPreset: 'advisor' } },
  status: 'idle',
  cancel() { idleTeardown.push('cancel') },
  ctx: {
    tools: {
      restrict: () => () => { idleTeardown.push('restrict-release') },
      guard: () => () => { idleTeardown.push('guard-dispose') },
    },
  },
}
agentHandlers.forEach((fn) => fn({ agent: idleLive }))
teardownEffects[0].dispose()
assert(!idleTeardown.includes('guard-dispose'), 'idle 顾问中止失败时保留守卫（不撤保护）')
assert(!idleTeardown.includes('restrict-release'), 'idle 顾问中止失败时保留 restrict')

// 11e) agent/disposed 之后记录被清掉，避免泄漏与重复拆卸
const disposedCalls = []
const disposable = {
  id: 'advisor-disposable',
  session: { id: 'session-advisor-disposable', header: { agentPreset: 'advisor' } },
  status: 'running',
  cancel() { disposedCalls.push('cancel') },
  ctx: {
    tools: {
      restrict: () => () => { disposedCalls.push('restrict-release') },
      guard: () => () => { disposedCalls.push('guard-dispose') },
    },
  },
}
agentHandlers.forEach((fn) => fn({ agent: disposable }))
disposedHandlers.forEach((fn) => fn({ agent: disposable }))
teardownEffects[0].dispose()
assert(!disposedCalls.includes('cancel'), '已 disposed 的顾问不再被中止（记录已清理）')

// 12) 坏状态文件不炸
fs.writeFileSync(path.join(home, 'dsh-advisors.json'), '{ not json', 'utf8')
const mod3 = await import(entry + '?reload=2')
resetCollectors()
mod3.apply(ctx, {})
const fallback = await get('/dsh-advisors-api')
assert(fallback.status === 200 && fallback.json.ok === true, '状态文件损坏时插件仍能起，按默认处理')
assert(fallback.json.domains.find((d) => d.domain === 'modeling').effective === 'apikey/gpt-6-astra',
  '坏文件时回落默认模型，不抛错')
assert(warnings.length > 0, '损坏文件有 warn 日志：' + warnings[0])

// 13) 宿主 LLM 服务缺席时回落兜底目录（设置页不能整页空）
const mod4 = await import(entry + '?reload=3')
resetCollectors()
// 覆盖 get()，模拟「llm 服务不存在」——inject 里没有它，插件仍必须挂载。
mod4.apply({ ...ctx, llm: undefined, get: () => undefined }, {})
const noLlm = await get('/dsh-advisors-api')
assert(noLlm.status === 200 && noLlm.json.catalog.length === 2, `无 llm 服务时用兜底目录（实际 ${noLlm.json.catalog.length}）`)
assert(noLlm.json.catalogMeta.status === 'unavailable', '无 llm 时目录状态标成 unavailable，不冒充真实目录')
assert(noLlm.json.domains.every((d) => d.availability === 'unknown'), '目录不可用时选择状态是 unknown 而非 missing')
assert(toolRegistrations.length === 1, 'llm 缺席时 ask_advisor 仍然注册（退化范围没扩大）')
// 关键回归：兜底必须**进缓存**。曾经把空目录写进快照、只把本次返回值换成兜底，
// 结果第一次 GET 显示建议目录、第二次直接变空。
const noLlmAgain = await get('/dsh-advisors-api')
assert(noLlmAgain.json.catalog.length === 2, `第二次 GET 兜底目录仍在（实际 ${noLlmAgain.json.catalog.length}）`)
assert(noLlmAgain.json.catalogMeta.status === 'unavailable', '第二次 GET 状态仍是 unavailable')
assert(typeof noLlm.json.catalogMeta.fetchedAt === 'number', 'fetchedAt 随结果走，不从过期时间反推')

// 14) 某条通道抛错只丢它自己，其余通道照常
const mod5 = await import(entry + '?reload=4')
resetCollectors()
const throwingLlm = {
  listProviders: () => [{ id: 'apikey', name: 'chatgpt' }, { id: 'broken', name: 'broken' }],
  listModels: async (provider) => {
    if (provider === 'broken') throw new Error('通道挂了')
    return [{ provider: 'apikey', id: 'gpt-6-astra', name: 'GPT-6 Astra' }]
  },
}
mod5.apply({ ...ctx, llm: throwingLlm, get: () => throwingLlm }, {})
const partial = await get('/dsh-advisors-api')
assert(partial.status === 200 && partial.json.catalog.length === 1 && partial.json.catalog[0].id === 'apikey/gpt-6-astra',
  '坏通道被跳过，好通道照常出现')
assert(partial.json.catalogMeta.status === 'partial', '部分通道失败时状态是 partial')
assert(partial.json.catalogMeta.failedProviders.includes('broken'), '回执里点名了失败的通道')
assert(warnings.some((w) => w.includes('broken')), '坏通道记了 warn 日志')

// 15) 永不完成的通道不许卡死请求（超时降级）
const mod6 = await import(entry + '?reload=5')
resetCollectors()
const hangingLlm = {
  listProviders: () => [{ id: 'slow', name: 'slow' }, { id: 'fast', name: 'fast' }],
  listModels: (provider) => (provider === 'slow'
    ? new Promise(() => {}) // 永远不 settle
    : Promise.resolve([{ provider: 'fast', id: 'ok-model', name: 'OK' }])),
}
mod6.apply({ ...ctx, llm: hangingLlm, get: () => hangingLlm }, {})
const startedAt = Date.now()
const hung = await get('/dsh-advisors-api')
const elapsed = Date.now() - startedAt
assert(hung.status === 200 && hung.json.catalog.length === 1 && hung.json.catalog[0].id === 'fast/ok-model',
  '挂死的通道被超时跳过，好通道照常返回')
assert(elapsed < 9000, `请求没有被永不完成的调用卡死（实际 ${elapsed}ms）`)

// 15b) 冷却：坏通道下一轮直接跳过，不再重复付 5 秒。
//      **不能用 adapters-updated 触发第二轮** —— 那会清空冷却（配置变了，旧判断作废），
//      语义就错了。这里推进系统时钟越过 30s TTL，模拟「普通缓存过期」。
const realNow = Date.now
let clockSkew = 0
Date.now = () => realNow() + clockSkew
try {
  clockSkew = 31_000
  const secondStart = Date.now()
  const secondHung = await get('/dsh-advisors-api')
  const secondElapsed = realNow() - (secondStart - clockSkew)
  assert(secondElapsed < 1500, `冷却期内不再等 5 秒超时（实际 ${secondElapsed}ms）`)
  assert(secondHung.json.catalogMeta.status === 'partial', '冷却中的通道仍记为 partial')
  assert(secondHung.json.catalogMeta.failedProviders.includes('slow'), '冷却中的通道仍点名在 failedProviders 里')

  // 15c) 配置变化（adapters-updated）必须清空冷却，让修好的通道立刻重试
  adapterHandlers.forEach((fn) => fn())
  const afterFix = await get('/dsh-advisors-api')
  assert(afterFix.json.catalogMeta.status !== 'unavailable', 'adapters-updated 后冷却被清、重新尝试通道')
} finally {
  Date.now = realNow
}

// 16) 轻量分支：?view=state 不碰目录
const mod7 = await import(entry + '?reload=6')
resetCollectors()
let listModelsCalls = 0
const countingLlm = {
  listProviders: () => [{ id: 'apikey', name: 'chatgpt' }],
  listModels: async () => { listModelsCalls += 1; return [{ provider: 'apikey', id: 'gpt-6-astra', name: 'A' }] },
}
mod7.apply({ ...ctx, llm: countingLlm, get: () => countingLlm }, {})
const light = await get('/dsh-advisors-api?view=state&sessionId=s1')
assert(light.status === 200 && typeof light.json.enabled === 'boolean', '?view=state 返回开关')
assert(listModelsCalls === 0, `?view=state 完全不枚举目录（实际调用 ${listModelsCalls} 次）`)
assert(Array.isArray(light.json.domains) && light.json.domains.length === 4, '轻量分支仍带领域生效值')

// 17) 目录缓存：连续 GET 只枚举一轮
const first = await get('/dsh-advisors-api')
const callsAfterFirst = listModelsCalls
await get('/dsh-advisors-api')
await get('/dsh-advisors-api')
assert(listModelsCalls === callsAfterFirst, `缓存命中，连续 GET 不重复枚举（${callsAfterFirst} → ${listModelsCalls}）`)
assert(first.json.catalogMeta.status === 'fresh', '正常时状态是 fresh')

// 18) 适配器拓扑变化后缓存作废
adapterHandlers.forEach((fn) => fn())
await get('/dsh-advisors-api')
assert(listModelsCalls > callsAfterFirst, 'llm/adapters-updated 后缓存作废、重新枚举')

// 18b) 竞态：失效事件落在请求「在途」时，旧结果不得被当作最新，且不能复用旧 Promise
const mod7b = await import(entry + '?reload=6b')
resetCollectors()
let raceCalls = 0
let releaseSlow
const slowFirst = new Promise((resolve) => { releaseSlow = resolve })
const raceLlm = {
  listProviders: () => [{ id: 'apikey', name: 'chatgpt' }],
  listModels: async () => {
    raceCalls += 1
    if (raceCalls === 1) {
      await slowFirst
      return [{ provider: 'apikey', id: 'old-model', name: 'OLD' }]
    }
    return [{ provider: 'apikey', id: 'new-model', name: 'NEW' }]
  },
}
mod7b.apply({ ...ctx, llm: raceLlm, get: () => raceLlm }, {})
// 第一轮发起但卡住
const racing = get('/dsh-advisors-api')
await new Promise((r) => setImmediate(r))
// 在途期间拓扑变化
adapterHandlers.forEach((fn) => fn())
// 第二轮必须重新发起，而不是复用旧 Promise
const second = await get('/dsh-advisors-api')
assert(second.json.catalog.some((m) => m.id === 'apikey/new-model'),
  '在途时失效：下一个请求重新枚举，拿到新目录（实际 ' + second.json.catalog.map((m) => m.id).join(',') + '）')
// 放行旧的，它不能覆盖新快照
releaseSlow()
const firstResult = await racing
assert(raceCalls >= 2, `失效后确实重新发起了枚举（实际 ${raceCalls} 次）`)
const afterRace = await get('/dsh-advisors-api')
assert(afterRace.json.catalog.some((m) => m.id === 'apikey/new-model'),
  '旧 generation 的迟到结果没有覆盖新快照')
assert(!afterRace.json.catalog.some((m) => m.id === 'apikey/old-model'),
  '迟到的旧结果没有混进目录')

// 19) 模型 id 里带斜杠（provider/org/model）能存能跑
const mod8 = await import(entry + '?reload=7')
resetCollectors()
mod8.apply(ctx, {})
const slashPost = await post({ domain: 'backend', modelId: 'kele-gpt/org/model-x' })
assert(slashPost.status === 200 && slashPost.json.effective === 'kele-gpt/org/model-x',
  'provider/org/model 这种 id 能保存（旧正则要求恰好一个斜杠，会拒掉）')
const slashTool = toolRegistrations[0]
const slashAct = await slashTool.def.execute({ domain: 'backend', question: 'x' }, exec)
assert(slashAct.provider === 'kele-gpt' && slashAct.model === 'org/model-x', '带斜杠的 model 正确拆给 startActivation')

// 20) 可用性判定：目录里有 = listed，目录里没有 = missing
const mod9 = await import(entry + '?reload=8')
resetCollectors()
mod9.apply(ctx, {})
await post({ domain: 'frontend', modelId: 'apikey/gpt-6-astra' })
const avail = await get('/dsh-advisors-api')
assert(avail.json.domains.find((d) => d.domain === 'frontend').availability === 'listed', '目录里有的选择标成 listed')
await post({ domain: 'modeling', modelId: 'gone/vanished-model' })
const avail2 = await get('/dsh-advisors-api')
assert(avail2.json.domains.find((d) => d.domain === 'modeling').availability === 'missing',
  '目录里没有的选择标成 missing（UI 可据此警告，但不自动改配置）')

// 21) 落盘失败必须报错，不能谎报成功（顾问验收指出的确定问题）
//     做法：把状态文件所在目录换成一个「存在但是个文件」的路径，让 mkdir/rename 必然失败。
const mod10 = await import(entry + '?reload=9')
resetCollectors()
const blockedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'advisors-blocked-'))
// stateFile() = <home>/dsh-advisors.json；把 <home> 变成一个文件，写入必定失败。
const blockedHomeFile = path.join(blockedHome, 'not-a-dir')
fs.writeFileSync(blockedHomeFile, 'x', 'utf8')
process.env.DSH_HOME = blockedHomeFile
mod10.apply(ctx, {})
const failPost = await post({ domain: 'aesthetic', modelId: 'apikey/gpt-6-astra' })
assert(failPost.status === 500 && failPost.json.ok === false,
  `落盘失败时 POST 必须回 500 + ok:false（实际 ${failPost.status} ok=${failPost.json?.ok}）`)
// 内存状态不能被提前提交：后续 GET 应仍显示未选择。
const afterFail = await get('/dsh-advisors-api')
assert(afterFail.json.domains.find((d) => d.domain === 'aesthetic').selected === null,
  '落盘失败后内存状态没被提前改掉')
// 三种写接口同一语义，逐个精确断言。
const failDefault = await post({ defaultEnabled: true })
assert(failDefault.status === 500 && failDefault.json.ok === false,
  `落盘失败时 defaultEnabled 也回 500（实际 ${failDefault.status}）`)
const failSession = await post({ sessionId: 'zzz', enabled: true })
assert(failSession.status === 500 && failSession.json.ok === false,
  `落盘失败时会话开关也回 500（实际 ${failSession.status}）`)
// 失败后状态必须与失败前一致（defaultEnabled 没被改成 true）。
assert((await get('/dsh-advisors-api')).json.defaultEnabled === false,
  'defaultEnabled 写失败后仍是 false，没被提前改掉')
process.env.DSH_HOME = home
fs.rmSync(blockedHome, { recursive: true, force: true })

// 22) 跨代污染：旧代的失败不得把「已经修好的」通道重新打进冷却
//     （顾问审出的阻塞项，冷却表必须受 generation 约束）
const mod11 = await import(entry + '?reload=10')
resetCollectors()
let pCalls = 0
let releaseOldFail
const oldFailGate = new Promise((resolve) => { releaseOldFail = resolve })
const raceProviderLlm = {
  listProviders: () => [{ id: 'P', name: 'P' }],
  listModels: async () => {
    pCalls += 1
    if (pCalls === 1) {
      // 第一代：卡住，稍后失败
      await oldFailGate
      throw new Error('旧代失败')
    }
    return [{ provider: 'P', id: 'fixed-model', name: 'FIXED' }]
  },
}
mod11.apply({ ...ctx, llm: raceProviderLlm, get: () => raceProviderLlm }, {})
const oldGen = get('/dsh-advisors-api')
await new Promise((r) => setImmediate(r))
// 配置更新：新一代
adapterHandlers.forEach((fn) => fn())
const newGen = await get('/dsh-advisors-api')
assert(newGen.json.catalog.some((m) => m.id === 'P/fixed-model'), '新代拿到修好的目录')
// 放行旧代，让它失败 —— 它不许给 P 加冷却
releaseOldFail()
await oldGen
// 越过 TTL 再查：P 不该被旧代的失败冷却掉
const realNow2 = Date.now
Date.now = () => realNow2() + 31_000
try {
  const afterOldFail = await get('/dsh-advisors-api')
  assert(afterOldFail.json.catalog.some((m) => m.id === 'P/fixed-model'),
    '旧代失败没有把已修好的通道打进冷却')
  assert(afterOldFail.json.catalogMeta.status === 'fresh',
    '状态仍是 fresh，不是被旧代污染成 partial')
} finally {
  Date.now = realNow2
}

// 23) 反方向：旧代的迟到成功不许清掉新代设下的冷却
const mod12 = await import(entry + '?reload=11')
resetCollectors()
let qCalls = 0
let releaseOldSuccess
const oldSuccessGate = new Promise((resolve) => { releaseOldSuccess = resolve })
const reverseLlm = {
  listProviders: () => [{ id: 'Q', name: 'Q' }],
  listModels: async () => {
    qCalls += 1
    if (qCalls === 1) {
      // 第一代：卡住，稍后成功
      await oldSuccessGate
      return [{ provider: 'Q', id: 'stale-model', name: 'STALE' }]
    }
    throw new Error('新代失败')
  },
}
mod12.apply({ ...ctx, llm: reverseLlm, get: () => reverseLlm }, {})
const oldGen2 = get('/dsh-advisors-api')
await new Promise((r) => setImmediate(r))
adapterHandlers.forEach((fn) => fn())
const newGen2 = await get('/dsh-advisors-api')
assert(newGen2.json.catalogMeta.status === 'unavailable', '新代失败、目录不可用')
// 放行旧代成功 —— 它不许清掉新代设下的冷却
releaseOldSuccess()
await oldGen2
const callsBefore = qCalls
const realNow3 = Date.now
Date.now = () => realNow3() + 31_000
try {
  await get('/dsh-advisors-api')
  assert(qCalls === callsBefore,
    `旧代的迟到成功没有清掉新代冷却（Q 应仍被跳过，实际调用 ${qCalls - callsBefore} 次）`)
} finally {
  Date.now = realNow3
}

fs.rmSync(home, { recursive: true, force: true })

console.log('---')
console.log(process.exitCode === 1 ? '有断言失败' : '全部通过')
