/**
 * dsh-auth-cookie-guard —— 纯逻辑层（无插件依赖，可离线单测）。
 *
 * ## 要解决的问题（2026-11-03 那次「启动即崩」）
 *
 * 现象：桌面端启动时报 `desktop welcome: Web authentication failed`，进程刚起来就死。
 *
 * 真因不在认证代码，而在**请求头体积**：
 *
 *   1. 宿主每次启动都由 Electron 以 `--port 0` 拉起，操作系统给一个随机端口，例如
 *      `127.0.0.1:5046`（见 app.asar 里 dsh-desktop-host 的 args）。
 *   2. `dsh-client-connection` 的 `BrowserAuth.authorizeIndex()` 在拿到 `?token=` 后种一个
 *      cookie，名字是 **`dsh-auth-` + base64url(sha256(authority))**，而 authority 就是
 *      `127.0.0.1:<端口>`（lib/types/browser-auth.js 的 `cookieName()` / `requestAudience()`）。
 *   3. 端口每次随机 → **cookie 名字每次都不一样** → 上一轮那条永远没人覆盖它，只会堆着。
 *   4. cookie 的头是 `HttpOnly; SameSite=Strict; Path=/`，`Max-Age` 给足一年（`cookieMaxAgeDays`），
 *      所以它是**持久 cookie**，落盘在
 *      `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies`（Electron 的 defaultSession）。
 *   5. 关键一点：cookie 的作用域是 **host**（127.0.0.1），**不含端口**。于是历史上所有
 *      `dsh-auth-*` 对这些端口全都算「命中 Path=/ 的同域 cookie」，一次请求会被**全部发出**。
 *   6. 累积到 71 条时 Cookie 头 ≈ 16,009 字符（每条 ≈ 225B），加上 Host/UA/Accept 等，
 *      越过 Node `http` 默认的 `maxHeaderSize = 16384` 字节 →
 *   7. 宿主侧直接回 **`HTTP/1.1 431 Request Header Fields Too Large`**，响应头都没进业务逻辑。
 *   8. 壳进程这边 `connectDesktopWelcome()` 里 `const authenticated = await send(url, {credentials:"include"})`
 *      拿到 `ok === false`，就 `throw new Error("desktop welcome: Web authentication failed")`。
 *
 * 复现数据（本机实测，2026-11-03）：71 条 cookie、host_key 全为 `127.0.0.1`、
 * name 全为 `dsh-auth-*`、`name+value` 合计 15,867 字节。71 条名字全部能用
 * `sha256("127.0.0.1:" + port)` 精确反推出端口 —— 这就是「一次启动一条、从不清理」的铁证。
 * 离线自测（selftest.mjs）用同一套算法从 0 跑起：第 73 次启动首次 431，与实机吻合。
 *
 * ## 为什么在宿主侧修、怎么修
 *
 * cookie 库属于 Electron 主进程（`session.defaultSession`），宿主插件摸不到，**也不需要摸**：
 * 每一个发往宿主端口的请求，宿主都能看到完整的 `Cookie` 请求头，也都能改自己的响应头。
 * 于是用两层：
 *
 *   A. **抬高头上限（先救命）**：`server.maxHeaderSize` 在 Node 里是运行期可写字段
 *      （实测：默认 16KB 时 16.2KB 的 Cookie 头回 431；设成 1MB 后同样的请求回 200）。
 *      这样即使某台机器上已经堆了一大坨，本次启动也一定能握手成功。
 *   B. **在种新 cookie 的那一刻顺手删旧的（再根治）**：`BrowserAuth.authorizeIndex()`
 *      种新 cookie 走的是 `res.writeHead(303, {... "set-cookie": ... })`。我们在响应落笔前
 *      追加若干 `dsh-auth-*=; Max-Age=0; Path=/` 的删除指令，把**本次请求 Cookie 头里除新种之外
 *      的全部 `dsh-auth-*`** 一并清掉。
 *
 *      Chromium 处理 `Max-Age=0` 是**真删**（从持久库里移除，不是覆盖成空值），
 *      所以下一轮启动时库里只剩上轮那 1 条，再删 1 条、再种 1 条 —— 稳态恒为 1 条。
 *
 *      「只在种新 cookie 的响应上动手」是硬约束，不是优化：只有那一刻我们才知道
 *      **哪一条是刚生效的**（它在同一个响应的 Set-Cookie 里），其余按定义全是过期垃圾。
 *      换成「见到旧的就删」，就会把当前这条有效的也删掉，等于自杀。
 *
 * ## 一个真实踩到的坑：删除指令不能无限堆
 *
 * 每条删除指令占约 72 字节。若某台机器已经堆了 200 条，一次性回 200 条删除指令
 * 就是 14KB 响应头 —— **把自己撑爆**（自测 T5 就是这么炸出来的：客户端报
 * `Parse Error: Header overflow`）。所以：
 *   - 删除指令只带最小必要属性（`Max-Age=0; Path=/`）：Path 必须与种的时候一致
 *     才是同一条 cookie，其余属性删除时无意义，带上只是白占体积；
 *   - 单次响应最多删 `maxDeletionsPerResponse` 条（默认 128，约 9KB），
 *     多余的留给下一次启动继续收敛。稳态本来是 1~2 条，这个上限只为病态库兜底。
 *
 * ## 两个安全边界
 *
 * - 只动**本进程 webServer 的单次请求响应对象**（`server.prependListener('request')` → 改那个 `res`），
 *   不碰 `ServerResponse.prototype`，别的代码路径一点不受影响。
 * - 守卫本身任何异常都被吞掉并原样放行真实响应：**宁可没清理，也绝不干扰认证**。
 */

/** 宿主认证 cookie 的名字前缀，与 dsh-client-connection 的 `COOKIE_PREFIX` 一致。 */
export const COOKIE_PREFIX = 'dsh-auth-'

/**
 * 默认抬到 1MiB。Node 默认 16384B 只够放约 73 条本插件的目标 cookie，71 条就崩；
 * 1MiB 相当于约 4600 条，留足余量。监听口本来就是 127.0.0.1，没有放大到公网的面。
 */
export const DEFAULT_MAX_HEADER_SIZE = 1024 * 1024

/** 单次响应最多下发多少条删除指令（约 72B/条 → 默认约 9KB，稳在 16KB 以内）。 */
export const DEFAULT_MAX_DELETIONS_PER_RESPONSE = 128

/**
 * 删除指令的属性段，**只保留必要项**：
 * - `Path=/` 必须与种的时候完全一致，否则 Chromium 认为是另一条 cookie，删不掉；
 * - `Max-Age=0` 是真正起作用的那一项（RFC 6265 里优先级高于 Expires）；
 * - HttpOnly / SameSite / Expires 在「删除」这件事上没有任何作用，只会白占响应头体积。
 */
const DELETION_ATTRIBUTES = 'Max-Age=0; Path=/'

/** 估算一条 Cookie 头/字符串的线上体积（按 UTF-8 字节，不是字符数）。 */
export function headerBytes(value) {
  if (typeof value !== 'string' || value.length === 0) return 0
  return Buffer.byteLength(value, 'utf8')
}

/**
 * 取一条 Set-Cookie 值里的 cookie 名（第一个 `=` 之前的部分）。
 * 只做这一件事：名字是 base64url，不含 `=`，所以切第一个 `=` 是安全的。
 */
export function setCookieName(raw) {
  const text = String(raw ?? '')
  const at = text.indexOf('=')
  if (at <= 0) return ''
  return text.slice(0, at).trim()
}

/**
 * 从 Cookie 请求头里挑出所有宿主认证 cookie 的名字。
 *
 * @param header 原始 Cookie 请求头（`a=1; b=2`）
 * @param prefix 名字前缀，默认 `dsh-auth-`
 * @returns 名字集合（去重；出现顺序不保证，删除指令之间无需顺序）
 */
export function collectAuthCookieNames(header, prefix = COOKIE_PREFIX) {
  const names = new Set()
  if (typeof header !== 'string' || header.length === 0) return names
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at <= 0) continue
    const name = segment.slice(0, at).trim()
    if (name.length > 0 && name.startsWith(prefix)) names.add(name)
  }
  return names
}

/** 合成一条「删掉这个 cookie」的 Set-Cookie 值。 */
export function deletionCookie(name) {
  return `${name}=; ${DELETION_ATTRIBUTES}`
}

/**
 * 往一个响应的 Set-Cookie 列表里追加删除指令。
 *
 * **只有当这个响应本身正在种至少一条 `dsh-auth-*` 时才会动手** —— 见文件头「为什么只在
 * 种新 cookie 时动手」。其余情况原样返回，`added === 0`。
 *
 * @param currentSetCookie 响应现有的 set-cookie（undefined / 字符串 / 字符串数组）
 * @param staleNames       本次请求 Cookie 头里的名字集合
 * @param options          `{ prefix, maxDeletions }`
 * @returns `{ list, added, removed, deferred }` —— list 是要写回响应的最终列表；
 *          deferred 是因单次上限而留到下次的那些条数
 */
export function withDeletionCookies(currentSetCookie, staleNames, options = {}) {
  const prefix = typeof options.prefix === 'string' && options.prefix ? options.prefix : COOKIE_PREFIX
  const maxDeletions =
    Number.isFinite(options.maxDeletions) && options.maxDeletions >= 0
      ? Math.floor(options.maxDeletions)
      : DEFAULT_MAX_DELETIONS_PER_RESPONSE

  const list =
    currentSetCookie === undefined || currentSetCookie === null
      ? []
      : Array.isArray(currentSetCookie)
        ? currentSetCookie.map(String)
        : [String(currentSetCookie)]

  // 「这一笔正在种哪些」—— 这些绝对不能删。
  const keep = new Set()
  for (const raw of list) {
    const name = setCookieName(raw)
    if (name.startsWith(prefix)) keep.add(name)
  }
  // 不是种 cookie 的响应：一个字节都不碰。
  if (keep.size === 0) return { list, added: 0, removed: [], deferred: 0 }

  const removed = []
  let deferred = 0
  for (const name of staleNames) {
    if (keep.has(name)) continue
    if (removed.length >= maxDeletions) {
      deferred += 1
      continue
    }
    list.push(deletionCookie(name))
    removed.push(name)
  }
  return { list, added: removed.length, removed, deferred }
}

/**
 * 从 writeHead 的参数里找出 header 键值对象。
 * 兼容 `writeHead(code, headers)` 与 `writeHead(code, message, headers)`；
 * 数组形态（raw pairs）不认，交给 getHeader 兜底。
 */
function resolveHeaderBag(args) {
  for (const index of [1, 2]) {
    const candidate = args[index]
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate
  }
  return undefined
}

/**
 * 在响应落笔前注入删除指令。
 *
 * 两种落点都必须覆盖，因为 Node 允许两种写法：
 *   1. `writeHead(303, { 'set-cookie': ... })` —— 真实 DSH 用的就是这种；
 *   2. 先 `res.setHeader('set-cookie', ...)` 再 `writeHead(303)`。
 */
function injectDeletions(res, args, staleNames, options, state) {
  const bag = resolveHeaderBag(args)
  const optionsWithPrefix = options

  if (bag !== undefined) {
    const key = Object.keys(bag).find((name) => name.toLowerCase() === 'set-cookie')
    if (key !== undefined) {
      const merged = withDeletionCookies(bag[key], staleNames, optionsWithPrefix)
      if (merged.added > 0) {
        bag[key] = merged.list
        recordPurge(state, merged)
      }
      return
    }
    // writeHead 的 headers 里没有 set-cookie，但可能早先用 setHeader 存过 → 往下走
  }

  if (typeof res.getHeader !== 'function' || typeof res.setHeader !== 'function') return
  const current = res.getHeader('set-cookie')
  if (current === undefined) return
  const merged = withDeletionCookies(current, staleNames, optionsWithPrefix)
  if (merged.added > 0) {
    // 必须写回 setHeader：writeHead 的 headers 里没有这个键，不会覆盖它。
    res.setHeader('set-cookie', merged.list)
    recordPurge(state, merged)
  }
}

function recordPurge(state, merged) {
  state.purges += 1
  state.removedTotal += merged.added
  state.deferredTotal += merged.deferred
  state.lastPurge = { at: new Date().toISOString(), removed: merged.removed.slice() }
}

/**
 * 装好守卫，返回句柄。
 *
 * 做两件事，缺一不可：
 *   1. 抬高 `server.maxHeaderSize`（先救命：已经堆爆的机器也能启动）；
 *   2. 挂 request 前置监听，在该响应种新 cookie 时清掉所有旧 cookie（再根治）。
 *
 * @param server Node `http.Server`（或 https，两者都有 `request` 事件）
 * @param options `{ maxHeaderSize, prefix, raiseHeaderLimit, maxDeletionsPerResponse }`
 * @returns `{ state, restore }`
 */
export function installGuard(server, options = {}) {
  const prefix = typeof options.prefix === 'string' && options.prefix ? options.prefix : COOKIE_PREFIX
  const raiseHeaderLimit = options.raiseHeaderLimit !== false
  const maxDeletionsPerResponse =
    Number.isFinite(options.maxDeletionsPerResponse) && options.maxDeletionsPerResponse >= 0
      ? Math.floor(options.maxDeletionsPerResponse)
      : DEFAULT_MAX_DELETIONS_PER_RESPONSE
  const targetSize =
    Number.isFinite(options.maxHeaderSize) && options.maxHeaderSize > 0
      ? Math.floor(options.maxHeaderSize)
      : DEFAULT_MAX_HEADER_SIZE

  const state = {
    version: 1,
    prefix,
    startedAt: new Date().toISOString(),
    maxHeaderSizeBefore: server.maxHeaderSize,
    maxHeaderSizeAfter: server.maxHeaderSize,
    maxDeletionsPerResponse,
    requests: 0,
    maxCookies: 0,
    maxCookieBytes: 0,
    purges: 0,
    removedTotal: 0,
    deferredTotal: 0,
    lastPurge: null,
  }

  if (raiseHeaderLimit) {
    // Node 里这是可写字段：默认 undefined（内部按 16384 走），显式赋值后该值生效。
    const previous = server.maxHeaderSize
    try {
      server.maxHeaderSize = targetSize
      state.maxHeaderSizeAfter = server.maxHeaderSize
    } catch (error) {
      state.headerLimitError = String((error && error.message) || error)
      state.maxHeaderSizeAfter = previous
    }
  }

  const purgeOptions = { prefix, maxDeletions: maxDeletionsPerResponse }

  const onRequest = (req, res) => {
    const raw = req.headers && req.headers.cookie
    if (typeof raw !== 'string' || raw.length === 0 || !raw.includes(prefix)) return

    const stale = collectAuthCookieNames(raw, prefix)
    // 只统计，不改任何东西：每请求一次 O(段数) 扫描。
    state.requests += 1
    state.maxCookies = Math.max(state.maxCookies, stale.size)
    state.maxCookieBytes = Math.max(state.maxCookieBytes, headerBytes(raw))
    if (stale.size === 0) return

    // 只改这个 res 实例的 writeHead（own property），不碰 prototype。
    const original = res.writeHead
    res.writeHead = function guardedWriteHead(...args) {
      try {
        injectDeletions(res, args, stale, purgeOptions, state)
      } catch {
        /* 守卫绝不能打断真实响应：清理失败就按原样放行 */
      }
      return Reflect.apply(original, this, args)
    }
  }

  server.prependListener('request', onRequest)

  return {
    state,
    restore() {
      server.removeListener('request', onRequest)
      if (!raiseHeaderLimit) return
      if (state.maxHeaderSizeBefore === undefined) {
        // 原来没有这个自有属性，删掉让 Node 回到默认（--max-http-header-size）
        try {
          delete server.maxHeaderSize
        } catch {
          /* 忽略 */
        }
      } else {
        server.maxHeaderSize = state.maxHeaderSizeBefore
      }
    },
  }
}
