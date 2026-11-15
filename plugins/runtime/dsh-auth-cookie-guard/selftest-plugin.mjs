/**
 * 插件整体自测：用**假宿主**（最小 cordis ctx + 真 http server）跑通 apply()。
 *
 * selftest.mjs 测的是 lib/guard.js 的机制；这里测的是**接线**（index.js）：
 *   - inject 声明是否与真实用法一致；
 *   - apply() 能否在 webServer.server 还没就绪时靠重试把守卫挂上（真实时序就是这样）；
 *   - 工具是否注册、execute('status') 是否给得出人话；
 *   - ctx.effect 的 disposer 是否真的把守卫摘干净（热重载不残留）。
 *
 * 跑法：node selftest-plugin.mjs
 */
import http from 'node:http'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

import { apply, inject, name as pluginName, setDefineToolLoader } from './index.js'

let passed = 0
let failed = 0

/**
 * 每个 test 都登记自己要收尾的 server；不管测试过不过，收尾都跑。
 * 第一版没这么做，结果一条断言失败就把进程晾在那儿等 server 永不退出（卡了两分钟）。
 */
const openServers = new Set()

async function test(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${title}`)
    console.log(`       ${(error && error.message) || error}`)
  } finally {
    for (const server of openServers) {
      await new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        server.close(() => resolve())
      })
    }
    openServers.clear()
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 起一个真 server 并登记收尾，返回 { server, port }。 */
async function startServer(handler) {
  const server = http.createServer(handler)
  openServers.add(server)
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return { server, port }
}

/** 真实算法：cookie 名 = dsh-auth- + base64url(sha256("127.0.0.1:<port>")) */
function cookieNameForAuthority(authority) {
  const digest = crypto.createHash('sha256').update(authority).digest()
  return 'dsh-auth-' + digest.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** 与 authorizeIndex() 完全同形的 303 + Set-Cookie。 */
function indexHandler(req, res) {
  const authority = String(req.headers.host || '127.0.0.1')
  res.writeHead(303, {
    'cache-control': 'no-store',
    location: './',
    'set-cookie': `${cookieNameForAuthority(authority)}=v1.payload.sig; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict`,
  })
  res.end()
}

function request(port, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close' }
    if (cookie) headers.cookie = cookie
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
      res.resume()
      const raw = res.headers['set-cookie']
      resolve({ status: res.statusCode, setCookie: raw === undefined ? [] : [].concat(raw) })
    })
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    req.end()
  })
}

/** 造 n 条陈旧 cookie 的 Cookie 头（名字走真实算法）。 */
function staleCookieHeader(count, valueBytes = 6) {
  const pieces = []
  for (let i = 0; i < count; i += 1) {
    pieces.push(`${cookieNameForAuthority(`127.0.0.1:${20000 + i}`)}=v1.${'a'.repeat(valueBytes)}.b`)
  }
  return pieces.join('; ')
}

/**
 * 最小假宿主。刻意复刻两个真实时序细节：
 *   1. `webServer.server` 一开始是 undefined（apply 早于 listen）；
 *   2. `ctx.effect(factory)` 返回 disposer，由宿主在卸载时调用。
 */
function makeFakeHost() {
  const effects = []
  const tools = []
  return {
    effects,
    tools,
    ctx: {
      tools: { register: (tool) => tools.push(tool) },
      effect: (factory) => {
        const disposer = factory()
        effects.push(disposer)
        return () => {}
      },
      webServer: { server: undefined, host: '127.0.0.1', port: 0, protocol: 'http:' },
    },
  }
}

const realLog = console.log
const realError = console.error
function mute() {
  console.log = () => {}
  console.error = () => {}
}
function unmute() {
  console.log = realLog
  console.error = realError
}

/** 跑 apply()，顺手把它的启动日志静音（自测里那些是噪音）。 */
async function applyQuietly(ctx, config) {
  mute()
  try {
    await apply(ctx, config)
  } finally {
    unmute()
  }
}

function runDisposers(fake) {
  for (const dispose of fake.effects) if (typeof dispose === 'function') dispose()
  fake.effects.length = 0
}

console.log('\nP1 声明与接线')

await test('inject 声明包含 webServer（插件硬依赖）', () => {
  assert.ok(Array.isArray(inject), 'inject 应当是数组')
  assert.ok(inject.includes('webServer'), `inject 应当包含 webServer，实际 ${JSON.stringify(inject)}`)
})

await test('apply() 在 webServer.server 迟到时靠重试挂上守卫', async () => {
  const fake = makeFakeHost()
  const { server, port } = await startServer(indexHandler)

  await applyQuietly(fake.ctx, {})
  // 此刻 server 还没接上 → 守卫不该动任何东西
  assert.equal(server.maxHeaderSize, undefined, 'server 未就绪时不该被改')

  // 接上（等价于 listen 完成）
  fake.ctx.webServer.server = server
  await sleep(400) // 插件 100ms 轮询，给足几次机会
  assert.equal(server.maxHeaderSize, 1024 * 1024, '重试应当把 maxHeaderSize 抬到 1MiB')

  // 真跑一次：80 条陈旧 cookie（已超 16KB）应当被收敛
  const response = await request(port, staleCookieHeader(80))
  assert.equal(response.status, 303, `应当握手成功，实际 ${response.status}`)
  const deletions = response.setCookie.filter((value) => /Max-Age=0/.test(value))
  // 请求里有 80 条旧的 + 本响应新种 1 条，所以该删的是这 80 条旧的全部 —— 79 这个数字是错的，
  // 新种的这条名字来自 req.headers.host（真实端口），而造的陈旧名字来自 20000+i，两者必然不同。
  assert.equal(deletions.length, 80, `应当清掉全部 80 条旧 cookie，实际 ${deletions.length}`)

  runDisposers(fake)
})

console.log('\nP2 工具')

await test('注册了 auth_cookie_status 工具，且 execute("status") 输出可读文本', async () => {
  // 离线环境里 @deepseek-ai/dsh-tools 解析不到 → 注入一个假的 defineTool，
  // 否则这条路径根本测不到（插件会静默跳过工具注册）。
  const captured = []
  const previous = setDefineToolLoader(() => (spec) => {
    captured.push(spec)
    return spec
  })

  try {
    const fake = makeFakeHost()
    const { server } = await startServer(indexHandler)
    fake.ctx.webServer.server = server

    await applyQuietly(fake.ctx, {})
    await sleep(250)

    assert.equal(fake.tools.length, 1, `应当注册 1 个工具，实际 ${fake.tools.length}`)
    const tool = fake.tools[0]
    assert.equal(tool.name, 'auth_cookie_status')
    assert.ok(typeof tool.description === 'string' && tool.description.length > 40, '描述应当足够让人/模型看懂')
    assert.ok(tool.parameters && tool.parameters.action, '应当有 action 参数')

    const result = await tool.execute({ action: 'status' })
    assert.equal(result.ok, true)
    assert.ok(typeof result.message === 'string' && result.message.includes('守卫'), '输出应当说清守卫状态')
    assert.ok(result.guard, '应当带上结构化 guard 状态')
    assert.equal(result.guard.maxHeaderSizeAfter, 1024 * 1024)
    // 库被占用是正常态（DSH 正在运行），不应因此判定失败
    assert.ok(result.store, '应当带上 cookie 库巡检结果')

    runDisposers(fake)
  } finally {
    setDefineToolLoader(previous)
  }
})

console.log('\nP3 生命周期')

await test('disposer 摘干净：restore 后 maxHeaderSize 复原、不再注入删除指令', async () => {
  const fake = makeFakeHost()
  const { server, port } = await startServer(indexHandler)
  fake.ctx.webServer.server = server

  await applyQuietly(fake.ctx, {})
  await sleep(250)
  assert.equal(server.maxHeaderSize, 1024 * 1024, '前置条件：守卫应当已挂上')

  runDisposers(fake)
  assert.equal(server.maxHeaderSize, undefined, 'disposer 应当把 maxHeaderSize 还原')

  // 摘掉之后不该再注入删除指令
  const response = await request(port, staleCookieHeader(5))
  assert.equal(response.status, 303)
  assert.equal(response.setCookie.length, 1, `摘掉守卫后应当只剩新种那 1 条，实际 ${response.setCookie.length}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
