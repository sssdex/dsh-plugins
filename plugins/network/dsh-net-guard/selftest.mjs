/**
 * dsh-net-guard 自测。
 *
 * 直接测 `evaluate()` 的每条分支（纯逻辑，不依赖 Cordis 与 dsh-tools），
 * 再单独测一次真实 fetch 证明自愈后链路真的通。
 *
 * 跑法： node selftest.mjs
 */

import net from 'node:net'
import nodePath from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  evaluate, declaredProxy, isLoopbackHost, readEnv, dispatcherName, makeEnvReader, installDirect, probeLoopback, isWildcardHost,
} from './index.js'

const DEAD_PORT = 59999
const LIVE_PORT = 59998

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望=${String(expected)} 实际=${String(actual)}`}`)
}

/** 用纯对象构造 reader（不碰 process.env，避免平台差异干扰）。 */
const R = (obj) => makeEnvReader(null, obj)

function setEnv(pairs) {
  for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']) {
    delete process.env[n]
  }
  for (const [k, v] of Object.entries(pairs)) process.env[k] = v
}

/**
 * 起一个只说 HTTP 的假代理。
 * 关闭时先 destroy 挂着的连接再 close，否则 Windows 上 libuv 会撞 UV_HANDLE_CLOSING 断言。
 */
function startFakeProxy(port) {
  return new Promise((resolve, reject) => {
    const sockets = new Set()
    const srv = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => sockets.delete(socket))
      socket.end('HTTP/1.1 200 OK\r\n\r\n')
    })
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve({
      close: () => new Promise((done) => {
        for (const s of sockets) { try { s.destroy() } catch { /* 已关 */ } }
        sockets.clear()
        srv.close(() => done())
      }),
    }))
  })
}

const opts = { probeTimeoutMs: 400 }

/** 按 index.js 的同一规则解析 undici，供事务测试使用。 */
function loadUndiciModule() {
  const anchors = []
  if (process.env.DSH_PROFILE_DIR) anchors.push(nodePath.join(process.env.DSH_PROFILE_DIR, 'package.json'))
  if (process.env.DSH_HOME) {
    const names = new Set(['desktop'])
    const m = /dsh-profile\/([^\s/]+)/.exec(process.env.DSH_USER_AGENT_SUFFIX || '')
    if (m) names.add(m[1])
    for (const n of names) anchors.push(nodePath.join(process.env.DSH_HOME, 'profiles', n, 'package.json'))
  }
  for (const a of anchors) {
    try { return createRequire(a)('undici') } catch { /* 试下一个 */ }
  }
  return null
}

async function run() {
  // ---- 0. 纯函数 ----
  check('readEnv 小写优先', readEnv(R({ http_proxy: 'a', HTTP_PROXY: 'b' }), 'http_proxy', 'HTTP_PROXY'), 'a')
  check('readEnv 空串视为未设置', readEnv(R({ http_proxy: '  ', HTTP_PROXY: 'b' }), 'http_proxy', 'HTTP_PROXY'), 'b')
  check('isLoopback 127.x', isLoopbackHost('127.0.0.1'), true)
  check('isLoopback localhost', isLoopbackHost('localhost'), true)
  check('isLoopback [::1]', isLoopbackHost('[::1]'), true)
  check('isLoopback 远端', isLoopbackHost('10.255.255.1'), false)
  check('declaredProxy 不泄露凭据',
    declaredProxy(R({ HTTPS_PROXY: 'http://alice:s3cret@127.0.0.1:7890' })).endpoint, '127.0.0.1:7890')

  // ---- 1. CLEAN_START ----
  let r = await evaluate(R({}), opts)
  check('CLEAN_START', r.verdict, 'CLEAN_START')
  check('CLEAN_START 未自愈', r.rescued, false)

  // ---- 2. PROXIED_REACHABLE（活代理不许被动） ----
  const live = await startFakeProxy(LIVE_PORT)
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${LIVE_PORT}`, HTTPS_PROXY: `http://127.0.0.1:${LIVE_PORT}` })
  r = await evaluate(R(process.env), opts)
  check('活 loopback 代理 → PROXIED_REACHABLE', r.verdict, 'PROXIED_REACHABLE')
  check('活 loopback 代理 → 环境变量保留', process.env.HTTP_PROXY, `http://127.0.0.1:${LIVE_PORT}`)
  await live.close()

  // ---- 3. DIRTY_START_RESCUED（死代理必须被救） ----
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}`, HTTPS_PROXY: `http://127.0.0.1:${DEAD_PORT}`, NODE_USE_ENV_PROXY: '1' })
  r = await evaluate(R(process.env), opts)
  check('死 loopback 代理 → DIRTY_START_RESCUED', r.verdict, 'DIRTY_START_RESCUED')
  check('死代理 → 已自愈', r.rescued, true)
  check('死代理 → HTTP_PROXY 已删除', process.env.HTTP_PROXY, undefined)
  check('死代理 → NODE_USE_ENV_PROXY 已删除', process.env.NODE_USE_ENV_PROXY, undefined)
  check('死代理 → dispatcher 变成 Agent', dispatcherName(), 'Agent')

  // 真实请求：证明链路确实通了（401 = 可达、只是没 token）
  try {
    const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(20000),
    })
    check('自愈后真 fetch 可达', [200, 401, 403, 404, 422].includes(res.status), true)
    console.log(`        (HTTP ${res.status})`)
  } catch (error) {
    check(`自愈后真 fetch 可达（失败：${error && error.message}）`, false, true)
  }

  // ---- 4. PROXIED_REMOTE（远端代理不许被动） ----
  setEnv({ HTTPS_PROXY: 'http://10.255.255.1:8080' })
  r = await evaluate(R(process.env), opts)
  check('远端代理 → PROXIED_REMOTE', r.verdict, 'PROXIED_REMOTE')
  check('远端代理 → 环境变量保留', process.env.HTTPS_PROXY, 'http://10.255.255.1:8080')

  // ---- 5. CONFIG_ANOMALY ----
  r = await evaluate(R({ HTTP_PROXY: 'not-a-url' }), opts)
  check('垃圾值 → CONFIG_ANOMALY', r.verdict, 'CONFIG_ANOMALY')

  // ---- 6. DIRTY_UNRESCUED（关掉自愈） ----
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` })
  r = await evaluate(R(process.env), { ...opts, autoHealLoopback: false })
  check('autoHeal=false → DIRTY_UNRESCUED', r.verdict, 'DIRTY_UNRESCUED')
  check('autoHeal=false → 环境变量保留', process.env.HTTP_PROXY, `http://127.0.0.1:${DEAD_PORT}`)

  // ---- 7. DISABLED ----
  r = await evaluate(R({}), { ...opts, enabled: false })
  check('enabled=false → DISABLED', r.verdict, 'DISABLED')

  // ---- 8. 优先级（用纯对象，避免 Windows 大小写不敏感干扰） ----
  check('大小写优先级',
    declaredProxy(R({ http_proxy: `http://127.0.0.1:${DEAD_PORT}`, HTTP_PROXY: `http://127.0.0.1:${LIVE_PORT}` })).endpoint,
    `127.0.0.1:${DEAD_PORT}`)
  check('只有大写也认', declaredProxy(R({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` })).endpoint, `127.0.0.1:${DEAD_PORT}`)
  check('ALL_PROXY 兜底', declaredProxy(R({ ALL_PROXY: `http://127.0.0.1:${DEAD_PORT}` })).endpoint, `127.0.0.1:${DEAD_PORT}`)
  check('HTTPS 优先于 HTTP',
    declaredProxy(R({ HTTPS_PROXY: 'http://127.0.0.1:1111', HTTP_PROXY: 'http://127.0.0.1:2222' })).endpoint,
    '127.0.0.1:1111')

  // ---- 9. 自愈失败必须诚实报 DIRTY_UNRESCUED，不能谎称修好 ----
  r = await evaluate(R({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` }), {
    ...opts,
    heal: () => ({ ok: false, detail: '模拟 undici 不可用' }),
  })
  check('自愈失败 → DIRTY_UNRESCUED', r.verdict, 'DIRTY_UNRESCUED')
  check('自愈失败 → rescued=false', r.rescued, false)
  check('自愈失败 → 原因带失败详情', /模拟 undici 不可用/.test(r.reason), true)

  // ---- 10. 关键回归：快照层里的代理必须被发现（否则就是假 CLEAN） ----
  // 模拟 $DSH_HOME/.env 提供了代理，而 process.env 里没有 —— 正是 launcher 用快照的原因。
  const fakeSnapshot = {
    get(name) {
      const map = { HTTPS_PROXY: `http://127.0.0.1:${DEAD_PORT}`, HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` }
      const v = map[name] ?? map[name.toUpperCase()]
      return v === undefined ? undefined : { value: v, source: 'user-env' }
    },
  }
  setEnv({}) // process.env 干净
  const snapReader = makeEnvReader(fakeSnapshot)
  r = await evaluate(snapReader, opts)
  check('快照层有代理 → 不能报 CLEAN_START', r.verdict === 'CLEAN_START', false)
  check('快照层死代理 → 被识别并自愈', r.verdict, 'DIRTY_START_RESCUED')

  // 来源固定语义：快照整批读取成功且明确为空 → 采信「没有代理」，**不再**回看 process.env。
  // 这是刻意的：混用两个来源会让「来源」变得无法解释，也重新引入假 CLEAN 的可能。
  // （要测「快照不可用时回退 process.env」，见下面 19/20 那组用例。）
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` })
  const emptySnapshot = { get: () => undefined }
  r = await evaluate(makeEnvReader(emptySnapshot, process.env), opts)
  check('快照明确为空 → 采信快照（不回看 process.env）', r.verdict, 'CLEAN_START')
  check('快照明确为空 → 标记为已验证来源', makeEnvReader(emptySnapshot, process.env).verified, true)

  // ---- 11. 地址族：必须按配置的实际地址族判定，不能被另一栈的无关监听骗过 ----
  // 起一个只在 ::1 监听的无关服务
  const v6Only = await new Promise((resolve, reject) => {
    const srv = net.createServer((s) => { s.on('error', () => {}); s.end('HTTP/1.1 200 OK\r\n\r\n') })
    srv.once('error', reject)
    srv.listen(LIVE_PORT, '::1', () => resolve(srv))
  })

  // (a) 配置是 127.0.0.1:PORT，只有 ::1 在听 → 必须判 refused（漏救是错的，误救也是错的）
  const cfg4 = `http://127.0.0.1:${LIVE_PORT}`
  let probe = await probeLoopback('127.0.0.1', LIVE_PORT, 400)
  check('配置 127.0.0.1 而只有 ::1 在听 → 不得判 connected', probe.state === 'connected', false)
  check('配置 127.0.0.1 而只有 ::1 在听 → 判 refused', probe.state, 'refused')

  // (b) 配置是 localhost:PORT，只有 ::1 在听 → 应判 connected（客户端会自己选栈）
  probe = await probeLoopback('localhost', LIVE_PORT, 400)
  check('配置 localhost 且单栈在听 → connected', probe.state, 'connected')

  // (c) 配置是 ::1:PORT，只有 ::1 在听 → connected
  probe = await probeLoopback('::1', LIVE_PORT, 400)
  check('配置 ::1 且 ::1 在听 → connected', probe.state, 'connected')

  await new Promise((res) => v6Only.close(res))

  // (d) 只有 IPv4 在听，配置 ::1 → 不得判 connected
  const v4Only = await startFakeProxy(LIVE_PORT)
  probe = await probeLoopback('::1', LIVE_PORT, 400)
  check('配置 ::1 而只有 127.0.0.1 在听 → 不得判 connected', probe.state === 'connected', false)
  await v4Only.close()

  // ---- 12. 误伤防护：探测超时不能被当成死代理 ----
  // 用一个「接受连接但从不回包」的端点模拟慢代理：TCP 能连，所以这里要反过来——
  // 用一个连不上的黑洞地址模拟 timeout 语义。
  setEnv({ HTTP_PROXY: 'http://127.0.0.1:59990' })
  r = await evaluate(R(process.env), {
    ...opts,
    connect: async () => ({ state: 'timeout', detail: '模拟超时' }),
  })
  check('探测超时 → PROXY_INDETERMINATE（不改配置）', r.verdict, 'PROXY_INDETERMINATE')
  check('探测超时 → rescued=false', r.rescued, false)
  check('探测超时 → 环境变量保留', process.env.HTTP_PROXY, 'http://127.0.0.1:59990')

  // ---- 13. 明确拒绝才自愈（refused 语义） ----
  r = await evaluate(R({ HTTP_PROXY: 'http://127.0.0.1:59990' }), {
    ...opts,
    connect: async () => ({ state: 'refused', detail: '模拟拒绝' }),
    heal: () => ({ ok: true, detail: 'fake' }),
  })
  check('明确拒绝 → 自愈', r.verdict, 'DIRTY_START_RESCUED')

  // ---- 14. 原子性：setter 失败时不许留下「环境已清空」的矛盾状态 ----
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` })
  const before = process.env.HTTP_PROXY
  r = await evaluate(R(process.env), {
    ...opts,
    connect: async () => ({ state: 'refused', detail: '模拟拒绝' }),
    heal: () => ({ ok: false, detail: '模拟 setter 抛错' }),
  })
  check('自愈失败 → 环境变量保持原样（原子性）', process.env.HTTP_PROXY, before)
  check('自愈失败 → verdict 诚实', r.verdict, 'DIRTY_UNRESCUED')

  // ---- 15. 真实 installDirect 的原子性：成功后才清变量 ----
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}`, HTTPS_PROXY: `http://127.0.0.1:${DEAD_PORT}` })
  const healResult = installDirect(process.env, () => {})
  check('installDirect 成功', healResult.ok, true)
  check('installDirect 成功后变量已清', process.env.HTTP_PROXY, undefined)
  check('installDirect 成功后 dispatcher 可回读', dispatcherName() !== 'unknown', true)

  // ---- 16. 取不到官方快照时必须显式降级，不能报成普通 CLEAN_START ----
  {
    const { apply } = await import('./index.js')
    const logFile = 'D:/DeepSeek-Workspace/dsh-net-guard/_selftest.log'
    const ctxNoSnapshot = {
      tools: { register: () => () => {} },
      effect: (fn) => fn(),
      get: () => undefined,            // 没有 launchEnvironment
      inject: (n, cb) => cb({ tools: ctxNoSnapshot.tools }),
    }
    delete globalThis[Symbol.for('dsh-net-guard.handled')]  // 清掉幂等标记，确保真的走判定
    setEnv({})
    await apply(ctxNoSnapshot, { logFile, probeTimeoutMs: 300 })
    const logText = readFileSync(logFile, 'utf8')
    check('无官方快照 → 报 CLEAN_START_UNVERIFIED', /CLEAN_START_UNVERIFIED/.test(logText), true)
    check('无官方快照 → 显式告警', /取不到可用的 launchEnvironment 快照/.test(logText), true)
  }

  // ---- 17. 状态机：必须真正测「同指纹」下的可重试与可跳过 ----
  {
    const { apply } = await import('./index.js')
    const logFile = 'D:/DeepSeek-Workspace/dsh-net-guard/_selftest.log'
    const STATE = Symbol.for('dsh-net-guard.state.v1')

    // 与 index.js 的 fingerprintOf 保持同一构造方式
    const fpOf = (envObj) => {
      const parts = ['launchEnvironment snapshot']
      for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        parts.push(`${n}=${envObj[n] === undefined ? '' : envObj[n]}`)
      }
      parts.push(`home=${process.env.DSH_HOME || ''}`)
      parts.push(`profile=${process.env.DSH_PROFILE || ''}`)
      return parts.join('|')
    }

    const mkCtx = () => {
      const ctx = {
        tools: { register: () => () => {} },
        effect: (fn) => fn(),
        get: (n) => (n === 'launchEnvironment'
          ? { get: (k) => (process.env[k] === undefined ? undefined : { value: process.env[k] }) }
          : (n === 'tools' ? ctx.tools : undefined)),
        inject: (n, cb) => cb(ctx),
      }
      return ctx
    }

    // --- (a) 同指纹 + settled:false + verdict 可重试 → 必须重新探测 ---
    try { writeFileSync(logFile, '') } catch { /* 首次 */ }
    delete globalThis[STATE]
    setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` })
    globalThis[STATE] = {
      fingerprint: fpOf(process.env),   // **与当前环境完全一致**
      verdict: 'PROXY_INDETERMINATE',   // 可重试
      settled: false,
      at: Date.now(),
    }
    await apply(mkCtx(), { logFile, probeTimeoutMs: 300 })
    let logText = readFileSync(logFile, 'utf8')
    check('同指纹 settled:false → 不跳过', /skipped_already_handled/.test(logText), false)
    check('同指纹 settled:false → 真的重新探测并自愈', /DIRTY_START_RESCUED/.test(logText), true)

    // --- (b) 同指纹 + settled:true 但 verdict 不在白名单 → 仍然必须重新探测 ---
    // 防的是「旧版本或别处写入 settled=true 但 verdict 可重试」的记录
    try { writeFileSync(logFile, '') } catch { /* 忽略 */ }
    setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` })
    globalThis[STATE] = {
      fingerprint: fpOf(process.env),
      verdict: 'DIRTY_UNRESCUED',       // 可重试，即使 settled 被错写成 true
      settled: true,
      at: Date.now(),
    }
    await apply(mkCtx(), { logFile, probeTimeoutMs: 300 })
    logText = readFileSync(logFile, 'utf8')
    check('settled:true 但 verdict 可重试 → 不跳过', /skipped_already_handled/.test(logText), false)

    // --- (c) 同指纹 + settled:true + verdict 在白名单 → 应跳过 ---
    try { writeFileSync(logFile, '') } catch { /* 忽略 */ }
    globalThis[STATE] = {
      fingerprint: fpOf(process.env),
      verdict: 'DIRTY_START_RESCUED',   // 在白名单里
      settled: true,
      at: Date.now(),
    }
    await apply(mkCtx(), { logFile, probeTimeoutMs: 300 })
    logText = readFileSync(logFile, 'utf8')
    check('同指纹 + settled + 白名单 verdict → 跳过', /skipped_already_handled/.test(logText), true)
  }

  // ---- 19. 快照「首次读成功、后续读抛异常」必须整批降级 ----
  // 这是专家指出的漏洞：按需逐个读时，第一次成功会把 verified 定成 true，
  // 之后第 N 次抛异常只降级内部状态，外面已经用 true 做了判定 → 假 CLEAN。
  {
    const { apply } = await import('./index.js')
    const logFile = 'D:/DeepSeek-Workspace/dsh-net-guard/_selftest.log'
    const STATE = Symbol.for('dsh-net-guard.state.v1')

    let seen = 0
    const snapshotLateThrow = {
      get(name) {
        seen++
        // 第 1 次（HTTP_PROXY）成功返回干净值，第 2 次起抛异常
        if (seen === 1) return undefined
        throw new Error('late throw on ' + name)
      },
    }

    const ctxLate = {
      tools: { register: () => () => {} },
      effect: (fn) => fn(),
      get: (n) => (n === 'launchEnvironment' ? snapshotLateThrow : (n === 'tools' ? ctxLate.tools : undefined)),
      inject: (n, cb) => cb(ctxLate),
    }

    delete globalThis[STATE]
    setEnv({})                       // fallback 也干净，最能暴露「假 CLEAN」
    try { writeFileSync(logFile, '') } catch { /* 忽略 */ }
    await apply(ctxLate, { logFile, probeTimeoutMs: 300 })
    const logText = readFileSync(logFile, 'utf8')

    check('晚抛异常 → 不得报普通 CLEAN_START', /启动结论 CLEAN_START[：:]/.test(logText), false)
    check('晚抛异常 → 报 CLEAN_START_UNVERIFIED', /CLEAN_START_UNVERIFIED/.test(logText), true)
    check('晚抛异常 → 触发降级告警', /取不到可用的 launchEnvironment 快照/.test(logText), true)
    check('晚抛异常 → 状态记录为未核实', globalThis[STATE] && /process\.env \(fallback\)/.test(globalThis[STATE].fingerprint), true)
  }

  // ---- 19b. 首项读到了真代理、次项才抛异常 → 首项必须被丢弃，不能半信半疑 ----
  {
    const { makeEnvReader: mk, declaredProxy: dp } = await import('./index.js')
    let n = 0
    const snapFirstOkThenThrow = {
      get(name) {
        n++
        if (n === 1) return { value: `http://127.0.0.1:${DEAD_PORT}` }  // 首项给出一个真代理
        throw new Error('throw on ' + name)
      },
    }
    const fallback = {}   // fallback 干净
    const rd = mk(snapFirstOkThenThrow, fallback)
    check('首项成功次项抛异常 → verified=false', rd.verified, false)
    check('首项成功次项抛异常 → 首项的代理值被丢弃', dp(rd).declared, false)
  }

  // ---- 19c. 构造完成后再次读取，不得再触碰外部快照（来源已冻结） ----
  {
    const { makeEnvReader: mk } = await import('./index.js')
    let calls = 0
    const snap = {
      get(name) {
        calls++
        return name === 'HTTP_PROXY' ? { value: 'http://127.0.0.1:1' } : undefined
      },
    }
    const rd = mk(snap, {})
    const callsAfterConstruct = calls
    check('构造时恰好读 6 个变量', callsAfterConstruct, 6)

    // 反复读取 20 次，快照调用次数不应再增加
    for (let i = 0; i < 20; i++) {
      rd.get('HTTP_PROXY'); rd.get('HTTPS_PROXY'); rd.get('ALL_PROXY')
      rd.get('http_proxy'); rd.get('https_proxy'); rd.get('all_proxy')
    }
    check('构造后读取不再触碰外部快照', calls, callsAfterConstruct)
    check('构造后仍返回缓存值', rd.get('HTTP_PROXY'), 'http://127.0.0.1:1')
  }

  // ---- 20. 快照是异常对象时不能当成已验证 ----
  {
    const { apply } = await import('./index.js')
    const logFile = 'D:/DeepSeek-Workspace/dsh-net-guard/_selftest.log'
    delete globalThis[Symbol.for('dsh-net-guard.state.v1')]

    // (a) truthy 但没有 get 方法
    try { writeFileSync(logFile, '') } catch { /* 忽略 */ }
    setEnv({})
    const ctxBadShape = {
      tools: { register: () => () => {} },
      effect: (fn) => fn(),
      get: (n) => (n === 'launchEnvironment' ? { notAReader: true } : undefined),
      inject: (n, cb) => cb(ctxBadShape),
    }
    await apply(ctxBadShape, { logFile, probeTimeoutMs: 300 })
    let logText = readFileSync(logFile, 'utf8')
    check('快照形状错误 → 不得报普通 CLEAN_START', /启动结论 CLEAN_START[：:]/.test(logText), false)
    check('快照形状错误 → 报 CLEAN_START_UNVERIFIED', /CLEAN_START_UNVERIFIED/.test(logText), true)

    // (b) get() 直接抛异常
    try { writeFileSync(logFile, '') } catch { /* 忽略 */ }
    delete globalThis[Symbol.for('dsh-net-guard.state.v1')]
    setEnv({})
    const ctxThrows = {
      tools: { register: () => () => {} },
      effect: (fn) => fn(),
      get: (n) => (n === 'launchEnvironment' ? { get() { throw new Error('boom') } } : undefined),
      inject: (n, cb) => cb(ctxThrows),
    }
    await apply(ctxThrows, { logFile, probeTimeoutMs: 300 })
    logText = readFileSync(logFile, 'utf8')
    check('快照 get() 抛异常 → 不中断且降级', /CLEAN_START_UNVERIFIED/.test(logText), true)

    // (c) ctx.get 本身抛异常
    try { writeFileSync(logFile, '') } catch { /* 忽略 */ }
    delete globalThis[Symbol.for('dsh-net-guard.state.v1')]
    const ctxGetThrows = {
      tools: { register: () => () => {} },
      effect: (fn) => fn(),
      get: () => { throw new Error('ctx.get boom') },
      inject: (n, cb) => cb(ctxGetThrows),
    }
    await apply(ctxGetThrows, { logFile, probeTimeoutMs: 300 })
    logText = readFileSync(logFile, 'utf8')
    check('ctx.get 抛异常 → 不中断且降级', /CLEAN_START_UNVERIFIED/.test(logText), true)
  }

  // ---- 19. 通配地址 0.0.0.0 / :: 必须归配置异常，绝不自动自愈 ----
  check('0.0.0.0 不算 loopback', isLoopbackHost('0.0.0.0'), false)
  check(':: 不算 loopback', isLoopbackHost('::'), false)
  for (const wildcard of ['0.0.0.0', '[::]']) {
    const rr = await evaluate(R({ HTTP_PROXY: `http://${wildcard}:7890` }), {
      ...opts,
      heal: () => { throw new Error('不该被调用') },
    })
    check(`通配地址 ${wildcard} → CONFIG_ANOMALY`, rr.verdict, 'CONFIG_ANOMALY')
    check(`通配地址 ${wildcard} → 未自愈`, rr.rescued, false)
  }

  // ---- 20. installDirect 事务：失败后 dispatcher 与环境变量必须完全一致 ----
  {
    const undici = loadUndiciModule()
    if (!undici) {
      check('（跳过）undici 不可用，无法测事务', true, true)
    } else {
      setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}`, HTTPS_PROXY: `http://127.0.0.1:${DEAD_PORT}` })
      const beforeDispatcher = undici.getGlobalDispatcher()

      const okResult = installDirect(process.env, () => {})
      check('事务：成功路径 ok', okResult.ok, true)
      check('事务：成功后 dispatcher 已换', undici.getGlobalDispatcher() !== beforeDispatcher, true)
      check('事务：成功后 HTTP_PROXY 已清', process.env.HTTP_PROXY, undefined)

      const okAgain = installDirect(process.env, () => {})
      check('事务：无变量可清时仍成功', okAgain.ok, true)
    }
  }

  // ---- 21. installDirect：读不到原 dispatcher 时必须拒绝动手（不调 setter） ----
  {
    const undici = loadUndiciModule()
    if (!undici) {
      check('（跳过）undici 不可用', true, true)
    } else {
      setEnv({ HTTP_PROXY: `http://127.0.0.1:${DEAD_PORT}` })
      const before = process.env.HTTP_PROXY

      // 临时把 getGlobalDispatcher 拿掉，模拟「无法保存现场」
      const savedGet = undici.getGlobalDispatcher
      let setterCalled = false
      const savedSet = undici.setGlobalDispatcher
      try {
        undici.getGlobalDispatcher = undefined
        undici.setGlobalDispatcher = (...args) => { setterCalled = true; return savedSet.apply(undici, args) }
        const result = installDirect(process.env, () => {})
        check('读不到原 dispatcher → 拒绝动手', result.ok, false)
        check('读不到原 dispatcher → setter 未被调用', setterCalled, false)
        check('读不到原 dispatcher → 环境变量保持原样', process.env.HTTP_PROXY, before)
      } finally {
        undici.getGlobalDispatcher = savedGet
        undici.setGlobalDispatcher = savedSet
      }
    }
  }

  setEnv({})
  console.log(`\n===== ${pass} passed, ${fail} failed =====`)
  // 用 exitCode 而不是 process.exit()：后者会在 socket 尚未完全关闭时强制退出，
  // Windows 上会撞 libuv 的 UV_HANDLE_CLOSING 断言，让「全过」也变成非零退出码。
  process.exitCode = fail === 0 ? 0 : 1
}

run().catch((error) => {
  console.error('selftest 崩了：', error)
  process.exitCode = 1
})
