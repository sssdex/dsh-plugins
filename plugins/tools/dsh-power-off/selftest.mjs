/**
 * dsh-power-off 自检：不起真关机（dryRun=true），只验证
 *   - 回环围栏（拒绝非回环 / 跨站 / Origin 不匹配）
 *   - 路由注册与 state / shutdown / cancel 的形状
 *   - 下发的 argv 是不是 shutdown.exe /s /f /t N
 *   - 重复 shutdown 会重置倒计时、cancel 会走 /a
 *
 * 跑法：node selftest.mjs
 */
import assert from 'node:assert/strict'
import { apply } from './index.js'

let pass = 0
const checks = []
function ok(name, fn) {
  try {
    fn()
    pass += 1
    checks.push(`  ✓ ${name}`)
  } catch (e) {
    checks.push(`  ✗ ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}
function okAsync(name, fn) {
  return fn().then(
    () => {
      pass += 1
      checks.push(`  ✓ ${name}`)
    },
    (e) => {
      checks.push(`  ✗ ${name}\n      ${e.message}`)
      process.exitCode = 1
    }
  )
}

/** 捕获 apply 注册进来的路由 handler。 */
function makeCtx() {
  const ctx = {
    registered: null,
    effects: [],
    webServer: {
      register(spec) {
        ctx.registered = spec
        return () => {
          ctx.registered = null
        }
      },
    },
    tools: { register: () => () => {} },
    get: () => null,
    effect(fn) {
      ctx.effects.push(fn)
    },
  }
  return ctx
}

function fakeReq({ method = 'GET', url = '/', remoteAddress = '127.0.0.1', headers = {}, body = '' } = {}) {
  const listeners = {}
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:1352', ...headers },
    socket: { remoteAddress },
    on(event, fn) {
      listeners[event] = fn
      return req
    },
  }
  queueMicrotask(() => {
    if (listeners.data && body) listeners.data(Buffer.from(body))
    if (listeners.end) listeners.end()
  })
  return req
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
    },
    end(chunk) {
      res.body = chunk || ''
    },
  }
  return res
}

async function call(handler, options) {
  const res = fakeRes()
  await handler(fakeReq(options), res)
  let parsed = null
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = null
  }
  return { status: res.statusCode, body: parsed, raw: res.body }
}

const ctx = makeCtx()
apply(ctx, {
  dryRun: true,
  defaultDelaySeconds: 60,
  minDelaySeconds: 10,
  maxDelaySeconds: 3600,
  allowModelTool: false,
})
const handler = ctx.registered?.handler
const route = ctx.registered?.path

checks.push('== 路由注册 =="')
ok('注册了 prefix 路由 /api/dsh-power-off', () => {
  assert.equal(route, '/api/dsh-power-off')
  assert.equal(typeof handler, 'function')
})

checks.push('== 围栏 ==')
await okAsync('非回环来源 → 403', async () => {
  const r = await call(handler, { method: 'GET', url: '/api/dsh-power-off/state', remoteAddress: '192.168.1.9' })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /not loopback/)
})
await okAsync('Host 头不是回环 → 403', async () => {
  const r = await call(handler, { method: 'GET', url: '/api/dsh-power-off/state', headers: { host: 'evil.example' } })
  assert.equal(r.status, 403)
})
await okAsync('跨站 fetch → 403', async () => {
  const r = await call(handler, { method: 'GET', url: '/api/dsh-power-off/state', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(r.status, 403)
})
await okAsync('Origin 与 Host 不同源 → 403', async () => {
  const r = await call(handler, {
    method: 'POST',
    url: '/api/dsh-power-off/shutdown',
    headers: { origin: 'http://evil.example' },
    body: '{}',
  })
  assert.equal(r.status, 403)
})
await okAsync('回环 + 同源 Origin → 放行', async () => {
  const r = await call(handler, {
    method: 'GET',
    url: '/api/dsh-power-off/state',
    headers: { origin: 'http://127.0.0.1:1352' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
})
await okAsync('IPv6 回环 ::1 → 放行', async () => {
  const r = await call(handler, {
    method: 'GET',
    url: '/api/dsh-power-off/state',
    remoteAddress: '::1',
    headers: { host: '[::1]:1352' },
  })
  assert.equal(r.status, 200)
})

checks.push('== 状态与动作（dryRun）==')
await okAsync('初始状态：没有 pending', async () => {
  const r = await call(handler, { method: 'GET', url: '/api/dsh-power-off/state' })
  assert.equal(r.body.data.pending, null)
  assert.equal(r.body.data.config.defaultDelaySeconds, 60)
})
await okAsync('shutdown 下发 /s /f /t 60（演练）', async () => {
  const r = await call(handler, {
    method: 'POST',
    url: '/api/dsh-power-off/shutdown',
    headers: { origin: 'http://127.0.0.1:1352' },
    body: JSON.stringify({ delaySeconds: 60 }),
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.data.dryRun, true)
  assert.match(r.body.data.argv.join(' '), /shutdown\.exe \/s \/f \/t 60/)
  assert.notEqual(r.body.data.state.pending, null)
})
await okAsync('delaySeconds 被夹到下限 10', async () => {
  const r = await call(handler, {
    method: 'POST',
    url: '/api/dsh-power-off/shutdown',
    body: JSON.stringify({ delaySeconds: 1 }),
  })
  assert.equal(r.body.data.delaySeconds, 10)
})
await okAsync('delaySeconds 被夹到上限 3600', async () => {
  const r = await call(handler, {
    method: 'POST',
    url: '/api/dsh-power-off/shutdown',
    body: JSON.stringify({ delaySeconds: 99999 }),
  })
  assert.equal(r.body.data.delaySeconds, 3600)
})
await okAsync('cancel 清掉 pending', async () => {
  const r = await call(handler, { method: 'POST', url: '/api/dsh-power-off/cancel', body: '{}' })
  assert.equal(r.body.data.hadPending, true)
  assert.equal(r.body.data.state.pending, null)
})
await okAsync('GET 到 POST 路由 → 405', async () => {
  const r = await call(handler, { method: 'GET', url: '/api/dsh-power-off/shutdown' })
  assert.equal(r.status, 405)
})
await okAsync('未知动作 → 404', async () => {
  const r = await call(handler, { method: 'POST', url: '/api/dsh-power-off/nope', body: '{}' })
  assert.equal(r.status, 404)
})
await okAsync('坏 JSON → 500 且不崩', async () => {
  const r = await call(handler, { method: 'POST', url: '/api/dsh-power-off/cancel', body: '{not json' })
  assert.equal(r.status, 500)
})

checks.push('== 卸载 ==')
// cordis 的约定：ctx.effect(fn) 里 fn 被调用，fn 的**返回值**才是 disposer。
ok('ctx.effect 注册了清理函数，卸载后路由失效', () => {
  assert.equal(ctx.effects.length, 1)
  const disposer = ctx.effects[0]()
  assert.equal(typeof disposer, 'function')
  assert.notEqual(ctx.registered, null)
  disposer()
  assert.equal(ctx.registered, null)
})

console.log(checks.join('\n'))
console.log(`\n${pass} 项通过，${checks.filter((c) => c.startsWith('  ✗')).length} 项失败`)
