/**
 * dsh-net-guard —— 进程内出站网络自愈（Host 插件，无 client bundle）。
 *
 * ## 为什么需要它
 *
 * DSH 启动时，`@deepseek-ai/dsh-http-proxy` 会从**启动环境**解析一次代理策略，装成 undici 的
 * 全局 dispatcher。之后所有 LLM 请求、web 搜索、HTTP MCP 都经由它。
 *
 * 问题在于：进程环境是启动那一刻从父进程**拷贝**的，之后外部怎么改都没用；dispatcher 也是
 * 启动时构造的，端口后来恢复也不会自愈。于是这条故障链必然复发：
 *
 *     父进程带着 HTTP_PROXY=127.0.0.1:X 启动 DSH
 *              ↓  进程内永久留着这个值
 *     X 上没人监听了（代理软件换端口 / 临时桥接被回收 / 上游进程退出）
 *              ↓
 *     所有 fetch → ECONNREFUSED（http 0）→「所有模型都不可用」
 *
 * 2026-11-13 / 11-14 / 11-15 三次故障都是这一条链，且三次的报错文案都在误导人去「换模型」。
 *
 * ## 它做什么
 *
 * 激活时读一次本进程环境，只看 **loopback 代理**（127.0.0.0/8 / localhost / ::1）。
 * 声明了 loopback 代理而那个端口没人监听 → 删掉代理环境变量、装直连 dispatcher，
 * 写一行明确结论到日志，并让 `net_guard_status` 工具随时可查。
 *
 * ## 它刻意不做什么
 *
 * - **不动非 loopback 代理。** 远端代理不可达可能是企业网络/审计要求，静默切直连会绕过策略。
 *   那种情况只记录，不修改。
 * - **不改任何配置文件。** 只改本进程的运行时状态。
 * - **卸载时不恢复旧 dispatcher。** 恢复只会把已经修好的进程重新弄坏。
 *   补充事实（读源码确认）：launcher 自己的 `disposeProxy` 确实会
 *   `setGlobalDispatcher(previous)` 把代理装回去，但 `dispose()` 只在**进程关闭**或
 *   **启动失败**时调用，profile 运行期重载不会触发。所以运行期不存在「被装回去」的窗口；
 *   进程关闭时它把 dispatcher 还原也无所谓，进程都没了。
 * - **不启动/重启任何进程。**
 *
 * ## 已知边界（诚实记录，交付时一并说明）
 *
 * - 依赖 undici 的 legacy 全局槽位 `Symbol.for('undici.globalDispatcher.1')`。这是 DSH 官方
 *   文档自己承认的「跨版本隐式耦合，不是约定」，Node 大版本升级后需要复验。
 * - `proxyEnvironmentForChild()` 在 launcher 安装时就快照了用户原始环境；本插件删掉
 *   `process.env` 之后，**那份快照**仍会把旧值传给子进程。子进程侧需另行处理。
 * - 救不了「插件没被加载」的情况（profile 损坏、插件被禁用）。
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'

export const name = 'dsh-net-guard'

const PROXY_NAMES = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
]

const VERSION = '0.1.0'
const DEFAULT_LOG = 'D:/DeepSeek-DSH/logs/net-guard.log'
const MAX_LOG_BYTES = 512 * 1024

/** 进程级幂等状态：不是布尔门闩，而是一个带指纹与可重试性的记录。 */
const STATE_KEY = Symbol.for('dsh-net-guard.state.v1')

/** 这些 verdict 属于「有定论、同批次不必重复处理」。 */
const SETTLED_VERDICTS = new Set([
  'CLEAN_START', 'CLEAN_START_UNVERIFIED', 'PROXIED_REACHABLE', 'PROXIED_REMOTE',
  'DIRTY_START_RESCUED', 'DISABLED', 'CONFIG_ANOMALY',
])

/**
 * 环境指纹：用来判断「这次 apply 和上次是不是同一个启动批次」。
 *
 * 不用进程 pid 之外的东西做唯一键 —— 同一进程里 profile 切换、环境被别的模块改动，
 * 都必须让旧记录失效，否则会永久跳过本该发生的自愈。
 */
function fingerprintOf(envSource, reader) {
  const parts = [envSource]
  for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const v = reader.get(n)
    parts.push(`${n}=${v === undefined ? '' : v}`)
  }
  parts.push(`home=${process.env.DSH_HOME || ''}`)
  parts.push(`profile=${process.env.DSH_PROFILE || ''}`)
  return parts.join('|')
}

function readGuardState() {
  return globalThis[STATE_KEY] || null
}

function writeGuardState(next) {
  globalThis[STATE_KEY] = next
}

// ---------------------------------------------------------------- 日志

export function makeLogger(logFile) {
  return function log(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`
    try {
      const dir = path.dirname(logFile)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0
      if (size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`)
    } catch { /* 日志失败不能影响主流程 */ }
    try { fs.appendFileSync(logFile, line) } catch { /* 同上 */ }
    console.log(`[dsh-net-guard] ${message}`)
  }
}

// ---------------------------------------------------------------- 环境读取

/**
 * 从 DSH 的启动环境快照里取代理变量。
 *
 * 关键：**不能只读 `process.env`。** launcher 用 `options.environment`（三层快照：
 * process / project-env / user-env）去装 dispatcher。代理可能来自 `$DSH_HOME/.env`，
 * 只在 `process.env` 里看不到 —— 那样会得出一个假 `CLEAN_START`，正是历史上最误导人的结论。
 *
 * ## 为什么必须「一次性批量读取」
 *
 * 快照是外部对象，不可信：可能 `undefined`、可能 truthy 但没有 `get`、
 * 也可能 `get()` 在**第 N 次**调用时才抛异常。如果按需逐个读，会出现这种漏洞：
 *
 *     HTTP_PROXY 读成功 → 判定为「快照可用」
 *     HTTPS_PROXY 读时抛异常 → 内部降级了，但外面已经拿 `verified=true` 做了判定
 *     → 报告一个「已验证的 CLEAN_START」，实际是假 CLEAN
 *
 * 所以这里**一次性把 6 个变量全读出来缓存**：
 *   - 全部成功 → 用这批快照值，`verified=true`；
 *   - 任一抛异常 → **丢弃整批**，全部改从 `fallbackEnv` 取，`verified=false`。
 *
 * 之后 `get()` 只读缓存，**不再触碰外部快照** —— 来源在构造时就固定，后续不可能变脸。
 *
 * 注意（别把话说满）：fallback 分支是**直接读 `fallbackEnv[name]`**，不是缓存。
 * 所以能保证的是「来源一致」（要么全用快照、要么全用 fallback），
 * 不能声称「fallback 的值也被冻结了」。环境在判定期间变化时，fallback 值可能变。
 *
 * @param snapshot DSH 的 `launchEnvironment` 服务；不可用时退回 process.env。
 * @param fallbackEnv 快照不可用时的兜底来源（默认 process.env）。
 */
export function makeEnvReader(snapshot, fallbackEnv = process.env) {
  const names = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
  ]

  let usable = Boolean(snapshot) && typeof snapshot.get === 'function'
  let failure = ''
  const cache = new Map()

  if (usable) {
    for (const name of names) {
      try {
        const hit = snapshot.get(name)
        // 约定形状是 { value }，但防御性处理：也接受裸字符串。
        if (hit && typeof hit === 'object' && typeof hit.value === 'string') cache.set(name, hit.value)
        else if (typeof hit === 'string') cache.set(name, hit)
        else cache.set(name, undefined)
      } catch (error) {
        // 任何一次读取失败 → 整批作废，改用 fallback，绝不半信半疑。
        usable = false
        failure = (error && error.message) || String(error)
        cache.clear()
        break
      }
    }
  }

  return {
    /** 快照是否**整批**读取成功。构造时就固定，之后不会再变。 */
    get verified() { return usable },
    /** 读取失败原因，供日志使用。 */
    get error() { return failure },
    /** 只读缓存；快照不可用时一律走 fallback。 */
    get(name) {
      if (usable) return cache.get(name)
      return fallbackEnv[name]
    },
  }
}

/** 读一个代理变量的生效值：小写优先、大写兜底，空值视为未设置。 */
export function readEnv(reader, lower, upper) {
  const a = reader.get(lower)
  if (typeof a === 'string' && a.trim()) return a.trim()
  const b = reader.get(upper)
  if (typeof b === 'string' && b.trim()) return b.trim()
  return undefined
}

/** 当前声明的代理端点。返回值里绝不包含凭据。 */
export function declaredProxy(reader) {
  const https = readEnv(reader, 'https_proxy', 'HTTPS_PROXY')
  const http = readEnv(reader, 'http_proxy', 'HTTP_PROXY')
  const all = readEnv(reader, 'all_proxy', 'ALL_PROXY')
  const raw = https || http || all
  if (!raw) return { declared: false }

  let url
  try { url = new URL(raw) } catch { return { declared: true, invalid: true } }

  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  return {
    declared: true,
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    // 日志里只写 host:port，绝不带 username/password
    endpoint: `${url.hostname}:${port}`,
  }
}

/**
 * 判断一个主机名是不是「可以安全自动自愈」的 loopback 代理地址。
 *
 * 注意 `0.0.0.0` **不算**：它是通配监听地址，不是合法的连接目标。把它当 loopback
 * 会让我们对一个语义不明的配置自动改网络 —— 这种配置应归入 `CONFIG_ANOMALY` 而不是自愈。
 * 判定顺序见 `evaluate()`。
 */
export function isLoopbackHost(hostname) {
  if (!hostname) return false
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  return /^127\./.test(h)
}

/** 通配地址：不是可连接目标，不能自动自愈，归为配置异常。 */
export function isWildcardHost(hostname) {
  if (!hostname) return false
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === '0.0.0.0' || h === '::' || h === '*'
}

// ---------------------------------------------------------------- 可达性

/**
 * 探测一次，**保留失败原因**。
 *
 * 不能只返回 true/false：`ECONNREFUSED`（端口上确实没人听）和 `timeout`（可能是慢、
 * 可能刚开始监听）是两件完全不同的事。把超时当死代理会误伤慢代理和刚启动的代理。
 *
 * @returns {Promise<{state:'connected'|'refused'|'timeout'|'error', code?:string}>}
 */
export function probeOne(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* 已关闭 */ }
      resolve(result)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done({ state: 'connected' }))
    socket.once('timeout', () => done({ state: 'timeout' }))
    socket.once('error', (error) => {
      const code = (error && error.code) || 'UNKNOWN'
      done({ state: code === 'ECONNREFUSED' ? 'refused' : 'error', code })
    })
  })
}

/** 兼容旧签名：只要通就算 true。 */
export function canConnect(host, port, timeout) {
  return probeOne(host, port, timeout).then((r) => r.state === 'connected')
}

/**
 * 按配置 URL 的**实际地址族**探测，不是「两个栈任一通就算活」。
 *
 * 上一版用「任一 connected 即 connected」是错的：配置是 `127.0.0.1:7890`，
 * 而 `::1:7890` 上恰好有另一个无关服务时，会误判成「代理活着」从而**漏救**。
 * 反之亦然。显式 IP 只探它自己；只有 `localhost` 这种「客户端自己会解析」的写法
 * 才两个栈都试。
 *
 * 结论取最保守：任一目标地址 connected → connected；否则若有 timeout/非地址族错误
 * → indeterminate（不改配置）；只有全部是明确 refused（且地址族可用）→ refused。
 *
 * @returns {Promise<{state:'connected'|'refused'|'indeterminate', detail:string}>}
 */
export async function probeLoopback(hostname, port, timeout) {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase()

  let hosts
  if (h === 'localhost') {
    // 只有这种写法，客户端才真的会在两个栈之间自己选。
    hosts = ['127.0.0.1', '::1']
  } else {
    // 显式 IP（含 127.x / ::1 / 其它 loopback）：只探它自己，绝不串到另一个栈。
    hosts = [h]
  }

  const started = Date.now()
  const results = []
  for (const host of hosts) {
    const r = await probeOne(host, port, timeout)
    results.push({ host, ...r })
  }
  const elapsed = Date.now() - started

  const detail = results
    .map((r) => `${r.host}=${r.state}${r.code ? '(' + r.code + ')' : ''}`)
    .join(' ') + ` ${elapsed}ms`

  if (results.some((r) => r.state === 'connected')) {
    // 注意：这只证明「TCP 端口有人听」，不证明它是可用代理。
    return { state: 'connected', detail }
  }
  if (results.some((r) => r.state === 'timeout')) {
    return { state: 'indeterminate', detail }
  }

  // 地址族不可用（EADDRNOTAVAIL / ENETUNREACH / EAFNOSUPPORT）不算「代理已死」的证据，
  // 但也不算不确定 —— 它只说明这个栈没得探。只有当**所有**目标地址都明确 refused
  // 或地址族不可用时，才认定代理确实不在。
  const allRefusedOrUnavailable = results.every((r) =>
    r.state === 'refused'
    || r.code === 'EADDRNOTAVAIL'
    || r.code === 'ENETUNREACH'
    || r.code === 'EAFNOSUPPORT')

  if (!allRefusedOrUnavailable) {
    return { state: 'indeterminate', detail }
  }

  // 显式 IPv4 配置但本机只有 IPv6 栈（或反之）时，refused 才是唯一信号。
  return { state: 'refused', detail }
}

// ---------------------------------------------------------------- undici

/**
 * 找 undici。
 *
 * 三个坑（都是实测踩出来的，别改回去）：
 *   1. `import.meta.url` 是 **realpath** —— 插件被 pnpm link 时 junction 被解析掉，
 *      这里指向工作区目录，而工作区没有 undici。
 *   2. `DSH_PROFILE_DIR` 只在 DSH 派生的**工具子进程**里有，**宿主进程里没有**
 *      （实测宿主只有 DSH_HOME / DSH_USER_AGENT_SUFFIX 等），所以不能只靠它。
 *   3. 宿主进程里 `DSH_USER_AGENT_SUFFIX=dsh-profile/<name>` 是可靠的 profile 名来源。
 *
 * 依次尝试：DSH_PROFILE_DIR → DSH_HOME/profiles/<name> → DSH_HOME/profiles/desktop → 本文件位置。
 */
export function loadUndici() {
  const tried = []
  const anchors = []

  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) anchors.push(path.join(profileDir, 'package.json'))

  const home = process.env.DSH_HOME
  if (home) {
    const names = new Set()
    const explicit = process.env.DSH_PROFILE
    if (explicit) names.add(explicit)
    const suffix = process.env.DSH_USER_AGENT_SUFFIX || ''
    const m = /dsh-profile\/([^\s/]+)/.exec(suffix)
    if (m) names.add(m[1])
    names.add('desktop')

    for (const name of names) {
      anchors.push(path.join(home, 'profiles', name, 'package.json'))
    }
  }

  anchors.push(import.meta.url)

  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      const resolved = req.resolve('undici')
      return { module: req('undici'), resolved, tried }
    } catch (error) {
      tried.push(`${anchor}: ${(error && error.code) || (error && error.message)}`)
    }
  }
  return { module: null, resolved: null, tried }
}

/**
 * 装直连 dispatcher，成功后才清理代理环境变量。
 *
 * 这是一个**事务**：任何一步失败都回滚到原状，绝不留下
 * 「环境看起来直连、全局 dispatcher 还是代理」的自相矛盾状态。
 *
 * 步骤：保存现场 → 装 direct → 验证生效 → 清变量 → 复核 → 任一步失败则回滚。
 *
 * @returns {{ok:boolean, detail:string}}
 */
export function installDirect(env, log) {
  const loaded = loadUndici()
  const undici = loaded.module
  if (!undici || typeof undici.setGlobalDispatcher !== 'function' || typeof undici.Agent !== 'function') {
    return {
      ok: false,
      detail: `undici 解析失败（${loaded.tried.join(' | ') || 'no anchor'}）`,
    }
  }

  // ---- 1. 保存现场（原 dispatcher + 原环境变量） ----
  // 关键：**读不到原 dispatcher 就绝不能动手**。否则一旦 setter 生效却无法回滚，
  // 就会留下「dispatcher 被换掉、环境变量还在」的不可逆中间态。
  if (typeof undici.getGlobalDispatcher !== 'function') {
    return { ok: false, detail: 'undici 没有 getGlobalDispatcher，无法保存现场，拒绝修改' }
  }

  let originalDispatcher
  try {
    originalDispatcher = undici.getGlobalDispatcher()
  } catch (error) {
    return {
      ok: false,
      detail: `读不到原 dispatcher（${error && error.message}），无法回滚，拒绝修改`,
    }
  }
  if (!originalDispatcher) {
    return { ok: false, detail: '原 dispatcher 为空，无法保存现场，拒绝修改' }
  }

  const savedEnv = new Map()
  for (const n of PROXY_NAMES) {
    if (env[n] !== undefined) savedEnv.set(n, env[n])
  }
  if (env.NODE_USE_ENV_PROXY !== undefined) savedEnv.set('NODE_USE_ENV_PROXY', env.NODE_USE_ENV_PROXY)

  const rollback = (why) => {
    // 先还原 dispatcher，再还原环境变量 —— 顺序与前进时相反。
    let dispatcherRestored = false
    try {
      undici.setGlobalDispatcher(originalDispatcher)
      dispatcherRestored = undici.getGlobalDispatcher() === originalDispatcher
    } catch { /* 下面按未恢复处理 */ }

    let envRestored = true
    for (const [n, v] of savedEnv) {
      try { env[n] = v } catch { envRestored = false }
    }
    for (const n of savedEnv.keys()) {
      if (env[n] !== savedEnv.get(n)) envRestored = false
    }

    if (!dispatcherRestored || !envRestored) {
      return {
        ok: false,
        detail: `${why}；**回滚不完整**（dispatcher 恢复=${dispatcherRestored}, 环境恢复=${envRestored}），需要人工检查`,
      }
    }
    return { ok: false, detail: `${why}；已回滚到原 dispatcher 与环境变量` }
  }

  // ---- 2. 装 direct ----
  try {
    undici.setGlobalDispatcher(new undici.Agent())
  } catch (error) {
    return rollback(`setGlobalDispatcher 失败：${error && error.message}`)
  }

  // ---- 3. 验证生效（用对象身份，不只看构造器名） ----
  let installed = null
  try {
    installed = undici.getGlobalDispatcher()
  } catch { /* 下面判失败 */ }

  if (!installed) {
    return rollback('装完读不到 dispatcher，无法确认生效')
  }
  if (installed === originalDispatcher) {
    // setter 没抛错但 dispatcher 没换 —— 说明被别的东西覆盖了。
    return rollback('dispatcher 未发生变化，可能被其它模块覆盖')
  }

  const name = (installed.constructor && installed.constructor.name) || typeof installed
  if (name === 'unknown') {
    return rollback('dispatcher 构造器无法识别，拒绝在未确认的情况下清理环境')
  }

  // ---- 4. 清环境变量 ----
  const removed = []
  for (const n of [...savedEnv.keys()]) {
    try {
      delete env[n]
      removed.push(n)
    } catch (error) {
      return rollback(`清理环境变量 ${n} 失败：${error && error.message}`)
    }
  }

  // ---- 5. 复核：确认真的清干净了 ----
  const leftover = [...savedEnv.keys()].filter((n) => env[n] !== undefined)
  if (leftover.length) {
    return rollback(`环境变量未能清除：${leftover.join(',')}`)
  }

  log(`已装直连 dispatcher（${name} @ ${loaded.resolved}）；清除的变量：${removed.length ? removed.join(',') : '(无)'}`)
  return { ok: true, detail: `direct dispatcher installed (${name}); cleared ${removed.length} var(s)` }
}

export function dispatcherName() {
  try {
    const undici = loadUndici().module
    if (undici && typeof undici.getGlobalDispatcher === 'function') {
      const d = undici.getGlobalDispatcher()
      return (d && d.constructor && d.constructor.name) || typeof d
    }
  } catch { /* 落到 unknown */ }
  return 'unknown'
}

// ---------------------------------------------------------------- 判定（纯逻辑，可单测）

/**
 * 判定本进程的网络出口状态，必要时就地自愈。
 *
 * 与 Cordis 无关，不碰 ctx —— 这样 selftest 能直接覆盖每条分支。
 *
 * @param reader 环境读取器（`{ get(name) }`），由 `makeEnvReader` 产生。
 * @returns {Promise<{verdict: string, rescued: boolean, reason: string}>}
 */
export async function evaluate(reader, options = {}) {
  const probeTimeout = Number.isInteger(options.probeTimeoutMs) && options.probeTimeoutMs > 0
    ? options.probeTimeoutMs
    : 1500
  const autoHeal = options.autoHealLoopback !== false
  const log = options.log || (() => {})
  const connect = options.connect || probeLoopback
  const heal = options.heal || installDirect

  const decl = declaredProxy(reader)

  if (options.enabled === false) {
    return { verdict: 'DISABLED', rescued: false, reason: '插件配置 enabled=false，跳过检查' }
  }
  if (!decl.declared) {
    return {
      verdict: 'CLEAN_START',
      rescued: false,
      reason: '启动环境没有任何代理变量，直连（注意：这不代表所有请求都一定直连）',
    }
  }
  if (decl.invalid) {
    return { verdict: 'CONFIG_ANOMALY', rescued: false, reason: '代理变量无法解析成 URL，不修改配置' }
  }
  if (isWildcardHost(decl.hostname)) {
    // 0.0.0.0 / :: / * 是通配监听地址，不是可连接目标。语义不明，归配置异常，绝不自愈。
    return {
      verdict: 'CONFIG_ANOMALY',
      rescued: false,
      reason: `代理地址是通配地址 ${decl.endpoint}，不是可连接目标；语义不明，不修改配置`,
    }
  }
  if (!isLoopbackHost(decl.hostname)) {
    // 远端代理：不可达也不动，交给用户判断（可能是企业网络/审计要求）。
    return {
      verdict: 'PROXIED_REMOTE',
      rescued: false,
      reason: `声明了远端代理 ${decl.endpoint}，本插件只处理 loopback 代理，不修改`,
    }
  }

  const probe = await connect(decl.hostname, decl.port, probeTimeout)

  if (probe.state === 'connected') {
    return {
      verdict: 'PROXIED_REACHABLE',
      rescued: false,
      reason: `loopback 代理 ${decl.endpoint} 可达（${probe.detail}），保持用户配置`,
    }
  }

  // 超时 / 其它错误：证据不足以断定代理已死。宁可不动，也不能把慢代理改坏。
  if (probe.state !== 'refused') {
    return {
      verdict: 'PROXY_INDETERMINATE',
      rescued: false,
      reason: `loopback 代理 ${decl.endpoint} 探测结果不确定（${probe.detail}）；`
        + '可能是慢启动或负载高，保持用户配置不动。若确认它已死，请修启动环境或设 autoHealLoopback 后重试',
    }
  }

  // 到这里：两个地址族都是明确的 ECONNREFUSED，端口上确实没人监听。
  if (!autoHeal) {
    return {
      verdict: 'DIRTY_UNRESCUED',
      rescued: false,
      reason: `loopback 代理 ${decl.endpoint} 明确拒绝连接（${probe.detail}），但 autoHealLoopback=false`,
    }
  }

  log(`确认死代理 ${decl.endpoint}（${probe.detail}），开始进程内自愈`)
  const result = heal(process.env, log)
  if (result.ok) {
    return {
      verdict: 'DIRTY_START_RESCUED',
      rescued: true,
      reason: `启动环境声明了死代理 ${decl.endpoint}（${probe.detail}）；已切换为直连 dispatcher`,
    }
  }
  return {
    verdict: 'DIRTY_UNRESCUED',
    rescued: false,
    reason: `死代理 ${decl.endpoint}，自愈失败：${result.detail}`,
  }
}

// ---------------------------------------------------------------- 生命周期

export async function apply(ctx, config) {
  const cfg = config || {}
  const logFile = (typeof cfg.logFile === 'string' && cfg.logFile) ? cfg.logFile : DEFAULT_LOG
  const log = makeLogger(logFile)

  // 优先用 DSH 官方快照（含 $DSH_HOME/.env 层），拿不到才退回 process.env。
  // 退回时必须**显式降级告警**：代理可能来自 $DSH_HOME/.env，只在 process.env 里看不到，
  // 那样报出来的 CLEAN_START 就是假 CLEAN —— 这是历史上最误导人的结论，不能静默发生。
  // 读快照本身也可能抛异常：必须整体包住，任何异常都退回 process.env 并标记未核实。
  let snapshot = null
  let snapshotError = ''
  try {
    if (typeof ctx.get === 'function') snapshot = ctx.get('launchEnvironment') ?? null
  } catch (error) {
    snapshotError = (error && error.message) || String(error)
    snapshot = null
  }

  // makeEnvReader 在构造时就把 6 个变量整批读完并缓存：
  // 全部成功才算 verified；任一失败则整批丢弃、全部走 process.env。
  // 所以这里的 verified 是终态，之后 get() 只读缓存，不会再变脸。
  const reader = makeEnvReader(snapshot)
  const envVerified = reader.verified

  const envSource = envVerified ? 'launchEnvironment snapshot' : 'process.env (fallback)'
  const fingerprint = fingerprintOf(envSource, reader)

  const state = {
    verdict: 'unknown',
    action: 'none',
    rescued: false,
    reason: '',
    checkedAt: new Date().toISOString(),
    logFile,
    envSource,
    envSourceVerified: envVerified,
    fingerprint,
  }

  if (!envVerified) {
    const why = snapshotError || reader.error
    log('警告：取不到可用的 launchEnvironment 快照'
      + (why ? `（${why}）` : '')
      + '，退回 process.env。若代理配在 $DSH_HOME/.env 里，本次判定可能不完整（结果是假 CLEAN 的风险）。')
  }

  // 幂等判断：必须**同时**满足「同一指纹 + settled 为 true + verdict 确实属于已定论集合」。
  // 只信 settled 布尔位是不够的：旧版本或别处写入的记录可能 settled=true 但 verdict 可重试。
  const previous = readGuardState()
  const sameBatch = Boolean(previous) && previous.fingerprint === fingerprint
  const canSkip = Boolean(
    sameBatch
    && previous.settled === true
    && SETTLED_VERDICTS.has(previous.verdict),
  )

  if (canSkip) {
    Object.assign(state, {
      verdict: previous.verdict,
      action: 'skipped_already_handled',
      rescued: previous.verdict === 'DIRTY_START_RESCUED',
      reason: `本进程同一启动批次已处理过（${previous.verdict}），不重复探测与安装`,
    })
    log(`动作 skipped_already_handled：${state.reason}`)
  } else {
    if (sameBatch && previous) {
      log(`上一轮结论 ${previous.verdict} 属于可重试状态，本次重新探测`)
    }
    Object.assign(state, await evaluate(reader, {
      enabled: cfg.enabled,
      autoHealLoopback: cfg.autoHealLoopback,
      probeTimeoutMs: cfg.probeTimeoutMs,
      log,
    }))

    // 降级读环境时，即便判定是 CLEAN 也要显式标注「未完全核实」，
    // 避免以后有人把它当成「网络一定干净」的证据。
    if (!envVerified && state.verdict === 'CLEAN_START') {
      state.verdict = 'CLEAN_START_UNVERIFIED'
      state.reason = 'process.env 里没有代理变量，但取不到官方启动快照，'
        + '无法排除 $DSH_HOME/.env 里的配置 —— 这不是「网络一定干净」的结论'
    }

    state.action = state.rescued ? 'rescued'
      : (SETTLED_VERDICTS.has(state.verdict) ? 'none' : 'retryable')

    writeGuardState({
      fingerprint,
      verdict: state.verdict,
      settled: SETTLED_VERDICTS.has(state.verdict),
      at: Date.now(),
    })
  }

  state.checkedAt = new Date().toISOString()
  const undiciProbe = loadUndici()
  state.dispatcher = dispatcherName()
  if (!undiciProbe.module) {
    log(`undici 解析失败，dispatcher 无法确认：${undiciProbe.tried.join(' | ')}`)
  }
  log(`启动结论 ${state.verdict}：${state.reason}（dispatcher=${state.dispatcher}, env=${envSource}）`)

  // 工具：让 AI 随时能查「现在到底走哪条路」，不用再靠翻历史推断。
  // `tools` 是可选服务：用 ctx.inject 拿，拿不到就跳过（自愈本身不依赖它）。
  try {
    ctx.inject(['tools'], async (tctx) => {
      const tools = tctx.tools
      if (!tools || typeof tools.register !== 'function') return

      let defineTool = null
      try {
        const mod = await import('@deepseek-ai/dsh-tools')
        defineTool = mod.defineTool ?? (mod.default && mod.default.defineTool) ?? null
      } catch (error) {
        log(`@deepseek-ai/dsh-tools 解析失败，跳过工具注册：${error && error.message}`)
        return
      }
      if (typeof defineTool !== 'function') {
        log('@deepseek-ai/dsh-tools 未提供 defineTool，跳过工具注册')
        return
      }

      const tool = defineTool({
        name: 'net_guard_status',
        description:
          '报告 DeepSeek Harness 本进程当前的出站网络状态：dispatcher 是直连还是代理、启动时是否声明了死代理、' +
          '自愈是否已生效。出现「所有模型不可用 / fetch failed / http 0」时先用它判断是不是网络出口坏了。',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        async execute() {
          const current = declaredProxy(reader)
          const view = {
            version: VERSION,
            pid: process.pid,
            verdict: state.verdict,
            dispatcher: dispatcherName(),
            declaredProxyNow: current.declared ? current.endpoint : null,
            declaredProxyLoopback: current.declared ? isLoopbackHost(current.hostname) : null,
            rescued: state.rescued,
            reason: state.reason,
            checkedAt: state.checkedAt,
            envSource: state.envSource,
            envSourceVerified: state.envSourceVerified,
            logFile: state.logFile,
          }
          const lines = [
            `verdict: ${view.verdict}`,
            `dispatcher: ${view.dispatcher}`,
            `启动时的代理: ${view.declaredProxyNow ?? '(无，直连)'}${view.declaredProxyLoopback ? '（loopback）' : ''}`,
            `已自愈: ${view.rescued ? '是' : '否'}`,
            `原因: ${view.reason}`,
            `环境来源: ${view.envSource}${view.envSourceVerified ? '' : ' ⚠️ 未用官方快照，可能不完整'}`,
            `检查时间: ${view.checkedAt}`,
            `日志: ${view.logFile}`,
          ]
          return { ...view, message: lines.join('\n') }
        },
      })
      tools.register(tool)
      log('已注册工具 net_guard_status')
    })
  } catch (error) {
    log(`工具注册失败：${error && error.message}`)
  }

  return () => {
    // 刻意不恢复旧 dispatcher：恢复只会把已修好的进程重新弄坏。
    // 也不清 HANDLED_KEY：本进程已经处理过的事实不会因为插件卸载而改变。
    log('插件已卸载；保留当前 dispatcher（不恢复旧值）')
  }
}
