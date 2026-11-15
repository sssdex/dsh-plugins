/**
 * dsh-auth-cookie-guard 自测（离线，不依赖 DSH 宿主）。
 *
 * 目标不是「覆盖率」，而是**复现 2026-11-03 那次崩溃的全部机制，并证明插件真的截断了它**：
 *
 *   T1  纯函数层：cookie 名提取、删除指令合成、只删「非本次新种」的那些。
 *   T2  线上复现：起真实 http server，模拟「浏览器每次启动都把所有历史 dsh-auth-*
 *       cookie 一起发过来」，用 dsh-client-connection 的**真实算法**
 *       （base64url(sha256("127.0.0.1:" + port))）命名，逐次累积。
 *         - 不装守卫：约第 73 次启动越过 16384B → 431（这就是那次崩溃）
 *         - 装守卫：200 次启动全程正常，Cookie 头恒为 1 条
 *   T3  守卫不越权：不是种 cookie 的响应一个字节都不改。
 *   T4  守卫不炸：业务响应照常发出；setHeader 写法也能清。
 *   T5  maxHeaderSize 真的被抬高，且 restore 能还原。
 *   T6  病态库兜底：单次删除指令不会把自己撑爆（这段是自测自己炸出来的真实缺陷）。
 *
 * 跑法：node selftest.mjs
 */
import http from 'node:http'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

import {
  COOKIE_PREFIX,
  DEFAULT_MAX_DELETIONS_PER_RESPONSE,
  collectAuthCookieNames,
  deletionCookie,
  headerBytes,
  installGuard,
  setCookieName,
  withDeletionCookies,
} from './lib/guard.js'

let passed = 0
let failed = 0

async function test(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${title}`)
    console.log(`       ${(error && error.message) || error}`)
  }
}

// ---------------------------------------------------------------- 真实算法复刻

/**
 * 复刻 dsh-client-connection/lib/index.js 的两个函数：
 *   requestAudience(headers, secure)  → 非 TLS 时返回 `req.headers.host`（即 "127.0.0.1:<port>"）
 *   cookieName(authority)             → "dsh-auth-" + base64url(sha256(authority))
 * 这两个函数是那次崩溃里「端口随机 → cookie 名随机 → 永不覆盖 → 无限累积」的源头，
 * 所以自测必须用同一份算法，否则测的就不是同一件事。
 */
function cookieNameForAuthority(authority) {
  const digest = crypto.createHash('sha256').update(authority).digest()
  return COOKIE_PREFIX + digest.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** 造一条与真实 cookie 等长的值（真实值形如 `v1.<base64url payload>.<base64url sig>`，约 180B）。 */
function cookieValueFor(seed) {
  const body = {
    version: 1,
    authority: `127.0.0.1:${seed}`,
    issuedAt: 1767225600000 + Number(seed),
    expiresAt: 1798761600000 + Number(seed),
  }
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url')
  const sig = crypto.createHash('sha256').update(String(seed)).digest().toString('base64url')
  return `v1.${payload}.${sig}`
}

/** 一次真实形态的 303 + Set-Cookie —— 与 authorizeIndex() 的 writeHead 形状逐字对齐。 */
function handleIndex(req, res) {
  const authority = String(req.headers.host || '127.0.0.1')
  const expiresAt = Date.now() + 31536e6
  res.writeHead(303, {
    'cache-control': 'no-store',
    location: './',
    'referrer-policy': 'no-referrer',
    'set-cookie': `${cookieNameForAuthority(authority)}=${cookieValueFor(authority)}; Max-Age=31536000; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`,
  })
  res.end()
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

/** 关闭 server 并强制断掉 keep-alive 连接，避免自测挂住。 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    server.close(() => resolve())
  })
}

/** 发一个带 Cookie 的请求，返回 { status, setCookie[] }。用 Connection: close 避免连接复用。 */
function request(port, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close' }
    if (cookie) headers.cookie = cookie
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers }, (res) => {
      res.resume()
      const raw = res.headers['set-cookie']
      resolve({ status: res.statusCode, setCookie: raw === undefined ? [] : [].concat(raw) })
    })
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 模拟 Electron 那个「持久 cookie 罐」：它是一个 **host 级**（不含端口）的键值集合，
 * 每次请求把**全部**条目拼成一条 Cookie 头发出去 —— 这正是崩溃的放大机制。
 */
class CookieJar {
  constructor() {
    this.entries = new Map()
  }
  /** 把响应里的 Set-Cookie 落进罐子：Max-Age=0 是真删，否则新增/覆盖。 */
  applySetCookie(list) {
    for (const raw of list) {
      const name = setCookieName(raw)
      if (!name) continue
      const isDeletion = /;\s*Max-Age\s*=\s*0\b/i.test(raw)
      if (isDeletion) {
        this.entries.delete(name)
        continue
      }
      const semi = raw.indexOf(';')
      this.entries.set(name, raw.slice(raw.indexOf('=') + 1, semi === -1 ? raw.length : semi))
    }
  }
  header() {
    if (this.entries.size === 0) return ''
    return [...this.entries].map(([name, value]) => `${name}=${value}`).join('; ')
  }
  get size() {
    return this.entries.size
  }
}

/** 预先灌入 n 条「历史遗留」cookie，等价于实机 11-03 凌晨那个现场。 */
function seedJar(count) {
  const jar = new CookieJar()
  const pieces = []
  for (let i = 0; i < count; i += 1) {
    const name = cookieNameForAuthority(`127.0.0.1:${20000 + i}`)
    jar.entries.set(name, cookieValueFor(`seed-${i}`))
    pieces.push(`${name}=${cookieValueFor(`seed-${i}`)}`)
  }
  return { jar, header: pieces.join('; ') }
}

// ---------------------------------------------------------------- T1 纯函数

console.log('\nT1 纯函数层')

await test('collectAuthCookieNames 只挑 dsh-auth-* 且去重', () => {
  const names = collectAuthCookieNames('a=1; dsh-auth-X=v1.a.b; b=2; dsh-auth-X=v1.c.d; dsh-auth-Y=z')
  assert.deepEqual([...names].sort(), ['dsh-auth-X', 'dsh-auth-Y'])
})

await test('collectAuthCookieNames 对空/畸形输入安全', () => {
  assert.equal(collectAuthCookieNames(undefined).size, 0)
  assert.equal(collectAuthCookieNames('').size, 0)
  assert.equal(collectAuthCookieNames('nonsense; =v; dsh-auth-Z=1').size, 1)
})

await test('setCookieName 取第一个 = 之前的部分', () => {
  assert.equal(setCookieName('dsh-auth-ABC=v1.x.y; Path=/'), 'dsh-auth-ABC')
  assert.equal(setCookieName('=novalue'), '')
  assert.equal(setCookieName(''), '')
})

await test('deletionCookie 带齐 Max-Age=0 / Path=/（Path 必须与种时一致才算同一条）', () => {
  const value = deletionCookie('dsh-auth-ABC')
  assert.match(value, /^dsh-auth-ABC=;/)
  assert.match(value, /Max-Age=0/)
  assert.match(value, /Path=\//)
  // 删除指令要尽量瘦：不该带 HttpOnly / Expires / SameSite 这些对删除无用的属性
  assert.ok(!/HttpOnly/i.test(value), '删除指令不该带 HttpOnly（白占体积）')
  assert.ok(!/Expires/i.test(value), '删除指令不该带 Expires（白占体积）')
  assert.ok(value.length < 100, `单条删除指令应当很瘦，实际 ${value.length} 字节`)
})

await test('withDeletionCookies 不删本次正在种的那一条', () => {
  const stale = new Set(['dsh-auth-OLD1', 'dsh-auth-NEW'])
  const result = withDeletionCookies('dsh-auth-NEW=fresh; Path=/', stale)
  assert.equal(result.added, 1)
  assert.deepEqual(result.removed, ['dsh-auth-OLD1'])
  assert.equal(result.list.length, 2)
  assert.ok(!result.list.some((v) => v.startsWith('dsh-auth-NEW=') && /Max-Age=0/.test(v)))
})

await test('withDeletionCookies 对不是种 cookie 的响应零改动', () => {
  const stale = new Set(['dsh-auth-OLD1', 'dsh-auth-OLD2'])
  const result = withDeletionCookies(undefined, stale)
  assert.equal(result.added, 0)
  assert.equal(result.list.length, 0)
})

await test('withDeletionCookies 遵守单次上限，多余的量报进 deferred', () => {
  const stale = new Set(Array.from({ length: 300 }, (_, i) => `dsh-auth-A${i}`))
  const result = withDeletionCookies('dsh-auth-NEW=x; Path=/', stale, { maxDeletions: 10 })
  assert.equal(result.added, 10, '单次应当只删 10 条')
  assert.equal(result.deferred, 290, '剩余 290 条应当留给下次')
  assert.equal(result.list.length, 11)
})

await test('headerBytes 按 UTF-8 字节计（不是字符数）', () => {
  assert.equal(headerBytes('abc'), 3)
  assert.equal(headerBytes('中文'), 6)
  assert.equal(headerBytes(undefined), 0)
})

// ---------------------------------------------------------------- T2 崩溃复现

console.log('\nT2 线上复现：200 次启动，随机端口')

await test('不装守卫 → 累积越过 16KB → 431（复现那次崩溃）', async () => {
  const jar = new CookieJar()
  const observed = []

  // 每次「启动」都是一个新 server + 新随机端口，与 --port 0 一致。
  for (let boot = 0; boot < 200; boot += 1) {
    const server = http.createServer(handleIndex)
    const port = await listen(server)
    const outgoing = jar.header()
    const response = await request(port, outgoing)
    observed.push({
      boot,
      status: response.status,
      cookieBytes: headerBytes(outgoing),
      cookies: jar.size,
    })
    jar.applySetCookie(response.setCookie)
    await closeServer(server)
  }

  const first431 = observed.find((entry) => entry.status === 431)
  assert.ok(first431, `应当出现 431，但 200 次启动里一次都没有。最后状态：${JSON.stringify(observed.at(-1))}`)
  assert.equal(observed.at(-1).status, 431, '最后几次应当持续 431（一崩到底）')
  assert.ok(first431.cookies > 60, `崩溃时罐里应当堆了几十条，实际 ${first431.cookies}`)
  assert.ok(first431.cookieBytes > 16384, `崩溃时 Cookie 头应当越过 16384 字节，实际 ${first431.cookieBytes}`)

  // 与实机「71 条 / 约 15.6KB」同量级
  assert.ok(
    first431.boot >= 60 && first431.boot <= 85,
    `首次崩溃应当发生在第 60~85 次启动附近（实机是 71 条），实际第 ${first431.boot} 次`,
  )
  console.log(
    `       实测：第 ${first431.boot} 次启动首次 431；崩溃时 ${first431.cookies} 条 / ${first431.cookieBytes} 字节`,
  )
})

await test('装守卫 → 200 次启动后恒为 1 条，全程不崩（根治）', async () => {
  const jar = new CookieJar()
  const statuses = []
  let peakCookies = 0
  let peakBytes = 0
  let removedTotal = 0

  for (let boot = 0; boot < 200; boot += 1) {
    const server = http.createServer(handleIndex)
    const guard = installGuard(server)
    const port = await listen(server)
    const outgoing = jar.header()
    peakCookies = Math.max(peakCookies, collectAuthCookieNames(outgoing).size)
    peakBytes = Math.max(peakBytes, headerBytes(outgoing))

    const response = await request(port, outgoing)
    statuses.push(response.status)
    jar.applySetCookie(response.setCookie)
    removedTotal += guard.state.removedTotal
    guard.restore()
    await closeServer(server)
  }

  const bad = statuses.filter((status) => status !== 303)
  assert.equal(bad.length, 0, `全程应当都是 303（握手成功），异常 ${bad.length} 次：${bad.slice(0, 5)}`)
  assert.equal(jar.size, 1, `稳态应当恒为 1 条 cookie，实际 ${jar.size}`)
  assert.ok(peakCookies <= 1, `请求里最多只该有 1 条 cookie，实际峰值 ${peakCookies}`)
  assert.ok(peakBytes < 1024, `Cookie 头峰值应当小于 1KB，实际 ${peakBytes}`)
  // 200 次启动、稳态每条删一次 → 约 199 条被清掉
  assert.ok(removedTotal >= 195, `应当累计清掉约 199 条旧 cookie，实际 ${removedTotal}`)
  console.log(
    `       实测：200 次启动全部 303，罐内恒 1 条，Cookie 头峰值 ${peakBytes} 字节，累计清掉 ${removedTotal} 条`,
  )
})

await test('守卫修的是「已堆爆」的现场：一次响应就从几十条收敛到 1 条', async () => {
  const { jar, header } = seedJar(80)
  assert.equal(jar.size, 80)
  assert.ok(headerBytes(header) > 16384, `前置条件：80 条应当已越过 16KB，实际 ${headerBytes(header)}`)

  const server = http.createServer(handleIndex)
  const guard = installGuard(server)
  const port = await listen(server)
  const response = await request(port, header)

  // 这是插件的核心价值：装之前必崩的现场，装之后第一次就能握手成功。
  assert.equal(response.status, 303, `装守卫后应当立刻 303，实际 ${response.status}`)
  jar.applySetCookie(response.setCookie)
  assert.equal(jar.size, 1, `一次响应就该把 80 条收敛成 1 条，实际 ${jar.size}`)
  assert.ok(headerBytes(jar.header()) < 1024, `收敛后 Cookie 头应当很小，实际 ${headerBytes(jar.header())}`)
  guard.restore()
  await closeServer(server)
  console.log(
    `       实测：80 条（${headerBytes(header)} 字节）→ 一次响应后 1 条（${headerBytes(jar.header())} 字节）`,
  )
})

// ---------------------------------------------------------------- T3 边界

console.log('\nT3 守卫不越权')

await test('普通 JSON 响应：Set-Cookie 与状态码一个字节都不改', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'normal=1; Path=/' })
    res.end('{"ok":true}')
  })
  const guard = installGuard(server)
  const port = await listen(server)
  const response = await request(port, 'dsh-auth-OLD=v1.a.b')
  assert.equal(response.status, 200)
  assert.deepEqual(response.setCookie, ['normal=1; Path=/'])
  assert.equal(guard.state.purges, 0, '不该发生任何清理')
  guard.restore()
  await closeServer(server)
})

await test('没有 cookie 的请求：完全跳过守卫逻辑', async () => {
  const server = http.createServer(handleIndex)
  const guard = installGuard(server)
  const port = await listen(server)
  const response = await request(port, '')
  assert.equal(response.status, 303)
  assert.equal(guard.state.requests, 0, '无 cookie 的请求不该计入')
  assert.equal(guard.state.purges, 0)
  guard.restore()
  await closeServer(server)
})

await test('非 dsh-auth-* 的 cookie 一律不碰', async () => {
  const server = http.createServer(handleIndex)
  const guard = installGuard(server)
  const port = await listen(server)
  const response = await request(port, 'other=1; another=2')
  assert.equal(response.status, 303)
  assert.equal(response.setCookie.length, 1, '应当只有新种的那 1 条，没有删除指令')
  assert.equal(guard.state.purges, 0)
  guard.restore()
  await closeServer(server)
})

// ---------------------------------------------------------------- T4 健壮性

console.log('\nT4 守卫不炸')

await test('204 无内容响应也能正常发出', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(204)
    res.end()
  })
  const guard = installGuard(server)
  const port = await listen(server)
  const response = await request(port, 'dsh-auth-OLD=v1.a.b')
  assert.equal(response.status, 204)
  guard.restore()
  await closeServer(server)
})

await test('setHeader 后再 writeHead(code) 的写法也能清理', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('set-cookie', `${cookieNameForAuthority('127.0.0.1:1')}=fresh; Path=/`)
    res.writeHead(303, { location: './' })
    res.end()
  })
  const guard = installGuard(server)
  const port = await listen(server)
  const response = await request(port, 'dsh-auth-OLD=v1.a.b; dsh-auth-OLD2=v1.c.d')
  assert.equal(response.status, 303)
  assert.equal(response.setCookie.length, 3, `应当是新种 1 条 + 删除 2 条，实际 ${response.setCookie.length}`)
  assert.equal(guard.state.removedTotal, 2)
  guard.restore()
  await closeServer(server)
})

await test('writeHead(code, message, headers) 三参数形态也能清理', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(
      303,
      'See Other',
      { 'set-cookie': `${cookieNameForAuthority('127.0.0.1:2')}=fresh; Path=/` },
    )
    res.end()
  })
  const guard = installGuard(server)
  const port = await listen(server)
  const response = await request(port, 'dsh-auth-OLD=v1.a.b')
  assert.equal(response.status, 303)
  assert.equal(response.setCookie.length, 2, `应当是新种 1 条 + 删除 1 条，实际 ${response.setCookie.length}`)
  guard.restore()
  await closeServer(server)
})

// ---------------------------------------------------------------- T5 头上限

console.log('\nT5 请求头上限')

await test('installGuard 抬高 maxHeaderSize，restore 后还原', async () => {
  const server = http.createServer(handleIndex)
  const before = server.maxHeaderSize
  const guard = installGuard(server)
  assert.equal(server.maxHeaderSize, 1024 * 1024, '应当抬到 1MiB')
  guard.restore()
  assert.equal(server.maxHeaderSize, before, 'restore 后应当还原')
})

await test('抬高后巨大 Cookie 头也能收下（不再 431）', async () => {
  const pieces = []
  for (let i = 0; i < 200; i += 1) pieces.push(`${cookieNameForAuthority(`127.0.0.1:${30000 + i}`)}=${'A'.repeat(120)}`)
  const huge = pieces.join('; ')
  assert.ok(headerBytes(huge) > 20000, `前置条件：构造的头应当 > 20KB，实际 ${headerBytes(huge)}`)

  const bare = http.createServer(handleIndex)
  const barePort = await listen(bare)
  assert.equal((await request(barePort, huge)).status, 431, '不抬上限时应当 431')
  await closeServer(bare)

  const server = http.createServer(handleIndex)
  const guard = installGuard(server)
  const port = await listen(server)
  assert.equal((await request(port, huge)).status, 303, '抬上限后应当 303')
  guard.restore()
  await closeServer(server)
})

// ---------------------------------------------------------------- T6 病态库兜底

console.log('\nT6 病态库兜底')

await test('单次删除指令数量受上限约束，响应头不会被自己撑爆', async () => {
  // 这是自测第一版自己炸出来的真实缺陷：若库里堆了 1500 条，一次性回 1500 条删除指令
  // 就是把响应头干到 100KB+，客户端直接 `Parse Error: Header overflow`。
  const { header } = seedJar(1500)
  const server = http.createServer(handleIndex)
  const guard = installGuard(server)
  const port = await listen(server)
  const response = await request(port, header)

  assert.equal(response.status, 303, `病态库也必须能握手成功，实际 ${response.status}`)
  const deletions = response.setCookie.filter((value) => /Max-Age=0/.test(value))
  assert.ok(
    deletions.length <= DEFAULT_MAX_DELETIONS_PER_RESPONSE,
    `单次删除指令不该超过 ${DEFAULT_MAX_DELETIONS_PER_RESPONSE} 条，实际 ${deletions.length}`,
  )
  const responseHeaderBytes = response.setCookie.reduce((sum, value) => sum + headerBytes(value) + 2, 0)
  assert.ok(
    responseHeaderBytes < 16384,
    `响应头不该被删除指令撑过 16KB，实际 ${responseHeaderBytes} 字节`,
  )
  assert.ok(guard.state.deferredTotal > 0, '超出的部分应当计入 deferred，留给后续启动继续收敛')
  guard.restore()
  await closeServer(server)
  console.log(
    `       实测：1500 条病态库 → 单次下发 ${deletions.length} 条删除指令（约 ${responseHeaderBytes} 字节响应头），` +
      `其余 ${guard.state.deferredTotal} 条顺延`,
  )
})

// ---------------------------------------------------------------- 汇总

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
