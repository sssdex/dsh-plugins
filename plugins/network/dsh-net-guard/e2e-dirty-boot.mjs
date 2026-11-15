/**
 * 端到端脏启动演练。
 *
 * 目的：在一个**真正带着死代理启动**的进程里，加载插件，验证它确实把
 * 「fetch failed / ECONNREFUSED」救成「可达」。
 *
 * 与 selftest 的区别：selftest 测分支逻辑；这个测「像 DSH 那样被脏启动」的完整路径。
 *
 * 跑法：
 *   HTTP_PROXY=http://127.0.0.1:59999 HTTPS_PROXY=... NODE_USE_ENV_PROXY=1 node e2e-dirty-boot.mjs
 */

import { createRequire } from 'node:module'

const DEAD_PORT = 59999
const TARGET = 'https://copilot.tencent.com/v2/chat/completions'

// 模拟 DSH 的 launchEnvironment 快照（三层里 process 层带着死代理）
const snapshot = {
  get(name) {
    const v = process.env[name]
    return v === undefined ? undefined : { value: v, source: 'process' }
  },
}

const fakeCtx = {
  tools: { register: () => () => {} },
  effect: (fn) => fn(),
  get: (n) => (n === 'launchEnvironment' ? snapshot : n === 'tools' ? fakeCtx.tools : undefined),
  inject: (names, cb) => cb(fakeCtx),
}

async function probe(label) {
  try {
    const res = await fetch(TARGET, {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(20000),
    })
    console.log(`${label}: HTTP ${res.status}  → 可达 ✅`)
    return res.status
  } catch (error) {
    const cause = error.cause ? (error.cause.code || error.cause.message) : '(no cause)'
    console.log(`${label}: 失败 ❌  ${error.message} | ${cause}`)
    return null
  }
}

const before = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
}

console.log('=== 脏启动现场 ===')
console.log('HTTP_PROXY        =', before.HTTP_PROXY)
console.log('HTTPS_PROXY       =', before.HTTPS_PROXY)
console.log('NODE_USE_ENV_PROXY=', before.NODE_USE_ENV_PROXY)
console.log('死端口上有监听吗  =', await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const s = net.connect({ host: '127.0.0.1', port: DEAD_PORT })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
    s.setTimeout(500)
    s.once('timeout', () => { s.destroy(); resolve(false) })
  })
}))

console.log('\n=== 第 1 步：插件加载前，先请求一次（应失败） ===')
const beforeStatus = await probe('加载前')

console.log('\n=== 第 2 步：加载插件 ===')
const mod = await import('./index.js')
await mod.apply(fakeCtx, { logFile: 'D:/DeepSeek-Workspace/dsh-net-guard/_e2e.log', probeTimeoutMs: 800 })

console.log('\n=== 第 3 步：插件加载后再请求一次（应可达） ===')
const afterStatus = await probe('加载后')

console.log('\n=== 第 4 步：确认环境变量已被清理 ===')
console.log('HTTP_PROXY         =', process.env.HTTP_PROXY ?? '(已删除)')
console.log('NODE_USE_ENV_PROXY =', process.env.NODE_USE_ENV_PROXY ?? '(已删除)')
console.log('dispatcher         =', mod.dispatcherName())

console.log('\n===== 结论 =====')
const ok = beforeStatus === null && afterStatus !== null
console.log(ok
  ? '✅ 端到端通过：脏启动 → 加载前不可达 → 插件自愈 → 加载后可达'
  : `❌ 端到端失败：before=${beforeStatus} after=${afterStatus}`)
process.exitCode = ok ? 0 : 1
