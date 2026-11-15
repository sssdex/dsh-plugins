/**
 * dsh-power-off —— 宿主半：让 DeepSeek Harness **真的把电脑关机 / 取消关机**。
 *
 * 和三件事划清界限（实测过市面上几个"电源"插件，它们只做后两件）：
 *   1. 关电脑（本插件）—— 调 Windows 的 shutdown.exe /s
 *   2. 重启 DSH      —— 不是这个
 *   3. 退出 DSH      —— 不是这个
 *
 * 三个出口：
 *   - 模型工具 `shutdown_computer`：主人说"关机"时 AI 自己调用
 *   - HTTP：POST /api/dsh-power-off/shutdown | /cancel，GET /state
 *   - 浏览器按钮：client.js 挂在会话标题栏（点一下 → 确认 → 倒计时关机）
 *
 * 安全：
 *   - 只认回环（127/8、::1、IPv4-mapped），Host 头也必须是回环权威；
 *   - POST 若有 Origin，必须与 Host 同源（挡别处网页的 CSRF）；
 *   - 真正杀机器前留默认 60 秒系统倒计时，期间任何一端都能 `shutdown /a` 撤销；
 *   - 破坏性动作串行化：已经在倒计时里就不再重复下发（避免 /t 被反复重置）。
 */
import { spawn as spawnChild } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-power-off'
export const inject = ['webServer', 'tools']

const API = '/api/dsh-power-off'
const SHUTDOWN_EXE = 'C:\\Windows\\System32\\shutdown.exe'
const COMMENT = 'DSH 关机：由 dsh-power-off 插件触发'

const DEFAULTS = {
  /** 系统倒计时秒数：留够时间反悔（shutdown /t N），最小 10。 */
  defaultDelaySeconds: 60,
  minDelaySeconds: 10,
  maxDelaySeconds: 3600,
  /** /f 强制结束阻止关机的程序，否则可能卡在确认界面让自动化白做。 */
  force: true,
  /** 注册模型工具 shutdown_computer。 */
  allowModelTool: true,
  /** 只演练不真关机。 */
  dryRun: false,
}

/* ------------------------------------------------------------------ utils */

function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const bool = (v, d) => (typeof v === 'boolean' ? v : d)
  const minDelay = clampInt(c.minDelaySeconds, DEFAULTS.minDelaySeconds, 1, 600)
  const maxDelay = clampInt(c.maxDelaySeconds, DEFAULTS.maxDelaySeconds, minDelay, 86400)
  return {
    defaultDelaySeconds: clampInt(c.defaultDelaySeconds, DEFAULTS.defaultDelaySeconds, minDelay, maxDelay),
    minDelaySeconds: minDelay,
    maxDelaySeconds: maxDelay,
    force: bool(c.force, DEFAULTS.force),
    allowModelTool: bool(c.allowModelTool, DEFAULTS.allowModelTool),
    dryRun: bool(c.dryRun, DEFAULTS.dryRun),
  }
}

function makeLog(debug) {
  const file = join(resolveDshHome(), 'dsh-power-off.log')
  return (event, detail) => {
    if (debug) {
      try {
        console.log(`[dsh-power-off] ${event} ${detail ? JSON.stringify(detail) : ''}`)
      } catch {
        /* ignore */
      }
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), event, detail: detail ?? null }) + '\n'
    appendFile(file, line, 'utf8').catch(() => {})
  }
}

function json(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 1 << 16) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`))
      }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ 围栏 */

function isLoopbackAddress(addr) {
  if (typeof addr !== 'string' || addr === '') return false
  if (addr === '::1') return true
  if (addr.startsWith('127.')) return true
  // IPv4-mapped IPv6：::ffff:127.0.0.1
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr)
  if (m) return m[1].startsWith('127.')
  return false
}

function isLoopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false
  // 去掉端口（IPv6 形如 [::1]:1352）
  let name = host
  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    name = end > 0 ? name.slice(1, end) : name
  } else {
    const colon = name.lastIndexOf(':')
    if (colon > 0) name = name.slice(0, colon)
  }
  name = name.toLowerCase()
  return name === 'localhost' || name === '::1' || name === '127.0.0.1' || name.startsWith('127.')
}

/** 拒绝原因；null = 放行。 */
function guard(req) {
  const addr = req.socket?.remoteAddress
  if (!isLoopbackAddress(addr)) return 'remote address is not loopback'
  if (!isLoopbackAuthority(req.headers?.host)) return 'Host header is not a loopback authority'
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return 'cross-site request'
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      const parsed = new URL(origin)
      if (parsed.host !== String(req.headers?.host || '')) return 'Origin does not match Host'
      if (!isLoopbackAuthority(parsed.host)) return 'Origin is not loopback'
    } catch {
      return 'Origin is not a valid URL'
    }
  }
  return null
}

/* ------------------------------------------------------------------- 状态 */

/**
 * 进程级状态。放在模块外与 auto-shutdown 同一个理由：热重载时旧路由可能还挂在
 * webServer 上（cordis 只跑 ctx.effect 的清理），让 handler 始终按 state 派发，
 * 旧路由就会自动指向新实例，而不是变成闭包住死 core 的僵尸路由。
 */
const state = {
  core: null,
}

function sessionState() {
  return {
    /** 已下发 shutdown /s /t N 的那一次：{at, until, delaySeconds, argv} | null */
    pending: null,
    lastFired: null,
    lastCancelled: null,
    lastError: null,
  }
}

function createCore(ctx, cfg, log) {
  const st = sessionState()
  const log_ = log
  /** 自检用：浏览器按钮每次轮询 /state 都会 +1。不增 = 客户端 bundle 没加载。 */
  const stats = { stateRequests: 0, lastStateAt: 0 }

  function spawnShutdown(args, waitMs = 8000) {
    const spec = {
      argv: [SHUTDOWN_EXE, ...args],
      cwd: homedir(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 5000,
    }
    // 优先用 harness 的 subprocess 服务（受同一套策略管理）；没有就自己 spawn。
    try {
      const sp = ctx.get?.('subprocess') ?? null
      if (sp && typeof sp.spawn === 'function') {
        const handle = sp.spawn(spec)
        handle?.done?.then?.(() => {}).catch?.(() => {})
        return { via: 'subprocess', argv: spec.argv }
      }
    } catch {
      /* 退化到直接 spawn */
    }
    const child = spawnChild(SHUTDOWN_EXE, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: homedir(),
    })
    child.on('error', (e) => log_('spawn-error', { message: String(e?.message ?? e) }))
    child.unref()
    return { via: 'child_process', argv: spec.argv }
  }

  function fire(delaySeconds) {
    const delay = clampInt(delaySeconds, cfg.defaultDelaySeconds, cfg.minDelaySeconds, cfg.maxDelaySeconds)
    const args = ['/s']
    if (cfg.force) args.push('/f')
    args.push('/t', String(delay))
    args.push('/c', COMMENT)

    if (cfg.dryRun) {
      st.lastFired = { at: Date.now(), argv: [SHUTDOWN_EXE, ...args], dryRun: true, delaySeconds: delay }
      st.pending = { at: Date.now(), until: Date.now() + delay * 1000, delaySeconds: delay, argv: [SHUTDOWN_EXE, ...args] }
      log('fire-dry-run', { args, delay })
      return { ok: true, dryRun: true, delaySeconds: delay, argv: [SHUTDOWN_EXE, ...args] }
    }
    try {
      const result = spawnShutdown(args)
      st.pending = {
        at: Date.now(),
        until: Date.now() + delay * 1000,
        delaySeconds: delay,
        argv: result.argv,
        via: result.via,
      }
      st.lastFired = { at: Date.now(), argv: result.argv, delaySeconds: delay }
      st.lastError = null
      log('fire', { args, delay, via: result.via })
      return { ok: true, dryRun: false, delaySeconds: delay, argv: result.argv }
    } catch (e) {
      const message = String(e?.message ?? e)
      st.lastError = { at: Date.now(), message }
      log('fire-throw', { message })
      throw e
    }
  }

  function cancel() {
    const had = st.pending !== null
    st.pending = null
    if (cfg.dryRun) {
      st.lastCancelled = { at: Date.now(), hadPending: had, dryRun: true }
      log('cancel-dry-run', { had })
      return { ok: true, hadPending: had, dryRun: true }
    }
    try {
      spawnShutdown(['/a'])
      st.lastCancelled = { at: Date.now(), hadPending: had }
      log('cancel', { had })
      return { ok: true, hadPending: had }
    } catch (e) {
      const message = String(e?.message ?? e)
      st.lastError = { at: Date.now(), message }
      log('cancel-throw', { message })
      throw e
    }
  }

  function snapshot() {
    const now = Date.now()
    if (st.pending !== null && now >= st.pending.until + 30_000) st.pending = null
    return {
      supported: process.platform === 'win32',
      platform: process.platform,
      config: {
        defaultDelaySeconds: cfg.defaultDelaySeconds,
        minDelaySeconds: cfg.minDelaySeconds,
        maxDelaySeconds: cfg.maxDelaySeconds,
        force: cfg.force,
        dryRun: cfg.dryRun,
      },
      pending: st.pending ? { ...st.pending, remainingMs: Math.max(0, st.pending.until - now) } : null,
      lastFired: st.lastFired,
      lastCancelled: st.lastCancelled,
      lastError: st.lastError,
      stats: {
        ...stats,
        /** 最近 15 秒内浏览器有没有在轮询 => 按钮真的挂上并活着。 */
        clientAlive: stats.lastStateAt > 0 && now - stats.lastStateAt < 15_000,
      },
    }
  }

  function noteStateRequest() {
    stats.stateRequests += 1
    stats.lastStateAt = Date.now()
  }

  return { fire, cancel, snapshot, noteStateRequest }
}

/* ------------------------------------------------------------------- 路由 */

async function dispatch(req, res) {
  if (guard(req) !== null) {
    json(res, 403, { ok: false, error: guard(req) })
    return
  }
  const core = state.core
  if (core === null) {
    json(res, 503, { ok: false, error: 'dsh-power-off plugin is not active' })
    return
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname.replace(/\/+$/, '')
  try {
    if (req.method === 'GET' && path === `${API}/state`) {
      core.noteStateRequest()
      json(res, 200, { ok: true, data: core.snapshot() })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
      return
    }
    const body = await readBody(req)
    if (path === `${API}/shutdown`) {
      const result = await core.fire(body?.delaySeconds)
      json(res, 200, { ok: true, data: { ...result, state: core.snapshot() } })
      return
    }
    if (path === `${API}/cancel`) {
      const result = await core.cancel()
      json(res, 200, { ok: true, data: { ...result, state: core.snapshot() } })
      return
    }
    json(res, 404, { ok: false, error: `unknown action: ${path}` })
  } catch (e) {
    try {
      json(res, 500, { ok: false, error: String(e?.message ?? e) })
    } catch {
      /* response already closed */
    }
  }
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const log = makeLog(false)
  const core = createCore(ctx, cfg, log)
  state.core = core

  let disposer = null
  try {
    disposer = ctx.webServer.register({ kind: 'prefix', path: API, handler: dispatch })
  } catch (e) {
    const message = String(e?.message ?? e)
    if (!message.includes('duplicate prefix route')) {
      log('route-register-error', { message })
      throw e
    }
    // 热重载：旧实例的 handler 也是 dispatch，会指向新 core，直接复用。
    log('route-reuse', { message })
  }

  const cleanups = []
  if (cfg.allowModelTool) {
    cleanups.push(registerModelTool(ctx, core, cfg))
  }

  const dispose = () => {
    if (state.core === core) state.core = null
    for (const fn of cleanups) {
      try {
        fn?.()
      } catch {
        /* ignore */
      }
    }
    try {
      disposer?.()
    } catch {
      /* ignore */
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)

  log('plugin-ready', { platform: process.platform, ...cfg })
  return dispose
}

/**
 * 模型工具。用顶层 await 解析 @deepseek-ai/dsh-tools：这个包靠宿主运行时别名
 * 解析，profile 的 node_modules 里并没有它（dsh-file-launcher 同款做法）。
 * 解析不到就只少一个工具，HTTP 与按钮通道照常。
 */
function registerModelTool(ctx, core, cfg) {
  const register = async () => {
    let defineTool = null
    try {
      const mod = await import('@deepseek-ai/dsh-tools')
      defineTool = mod.defineTool ?? (mod.default && mod.default.defineTool) ?? null
    } catch {
      return null
    }
    if (typeof defineTool !== 'function') return null
    if (!ctx.tools || typeof ctx.tools.register !== 'function') return null
    if (process.platform !== 'win32') return null

    const min = cfg.minDelaySeconds
    const max = cfg.maxDelaySeconds
    const def = cfg.defaultDelaySeconds

    const tool = defineTool({
      name: 'shutdown_computer',
      description:
        '把这台 Windows 电脑**关机**（不是重启 DSH、也不是退出 DSH）。' +
        '仅在用户明确要求关机 / 关电脑 / 定时关机时调用，绝不能自己顺带调用。' +
        `action=shutdown 会下发 shutdown /s /t N，N 默认 ${def} 秒、范围 ${min}-${max}，` +
        '期间用户随时可以取消；action=cancel 执行 shutdown /a 撤销本次关机；action=status 只查询状态。' +
        '调用前先向用户复述「将在 N 秒后关机」，让用户有机会改时间。',
      parameters: {
        action: { type: 'string', description: 'shutdown=关机（默认）| cancel=取消已安排的关机 | status=查询状态' },
        delaySeconds: { type: 'number', description: `关机前的系统倒计时秒数，默认 ${def}，范围 ${min}-${max}` },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const action = String(args?.action || 'shutdown').toLowerCase()
        if (action === 'status') {
          const s = core.snapshot()
          return {
            ok: true,
            state: s,
            message: s.pending
              ? `正在倒计时：约 ${Math.ceil(s.pending.remainingMs / 1000)} 秒后关机（可用 cancel 撤销）`
              : '当前没有已安排的关机。',
          }
        }
        if (action === 'cancel') {
          const r = core.cancel()
          return {
            ok: r.ok,
            state: core.snapshot(),
            message: r.hadPending ? '已撤销本次关机（shutdown /a）。' : '本来就没有已安排的关机，已执行一次 shutdown /a 兜底。',
          }
        }
        const r = core.fire(args?.delaySeconds)
        return {
          ok: r.ok,
          state: core.snapshot(),
          message:
            (r.dryRun ? '【演练模式】将要执行：' : '已下发关机命令：') +
            r.argv.join(' ') +
            `\n电脑将在 ${r.delaySeconds} 秒后关机；这期间随时可以让我取消（shutdown /a）。`,
        }
      },
    })
    return ctx.tools.register(tool)
  }
  // apply 是同步的，工具注册异步进行；失败只记日志，不影响其它通道。
  let disposed = false
  register()
    .then((d) => {
      if (disposed && typeof d === 'function') d()
    })
    .catch(() => {})
  return () => {
    disposed = true
  }
}
