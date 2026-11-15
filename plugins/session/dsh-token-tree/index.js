/**
 * dsh-token-tree — 宿主半。
 *
 * 问题：DSH 内核的 token 计量全部按「单个 Session」算（ctx.tokenMeter / contextPressure /
 * tokenUsage 都吃 session），而每个 subagent 是一个独立 Session，父会话日志里只留
 * 一条 subagent/catalog 事件记住 childId。所以界面永远只显示「当前这个 agent」的用量，
 * 没有任何地方把父 + 子加起来。
 *
 * 本插件补这一层：直接读 sessions/<workspace>/<session>/session.v4.jsonl.zstd，
 * 按 header 的 parentSession / origin 还原代理树，把每个会话的 assistant/message.usage
 * 累加，再沿树向上求和。
 *
 * 一个必须知道的底层细节：这个 .zstd 是**追加写、多帧**的。
 * zlib.zstdDecompressSync 只解第一帧，于是会读到一条 202 字节的 {"type":"session"} 就结束，
 * 看起来像「日志是空的」。必须按 magic(28 B5 2F FD) 切帧，逐帧解压。
 *
 * 只读：不写任何会话文件。
 */
import { readFile, stat, readdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

export const name = 'dsh-token-tree'
export const inject = ['webServer']

const API = '/api/dsh-token-tree'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const DEFAULTS = {
  /** 会话目录列表缓存毫秒数。 */
  scanCacheMs: 4000,
  /** 最多扫描多少个会话目录，防止巨量目录拖慢。 */
  maxSessions: 4000,
}

/* ------------------------------------------------------------------ utils */

function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
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

function isLoopbackAddress(addr) {
  if (typeof addr !== 'string' || addr === '') return false
  if (addr === '::1') return true
  if (addr.startsWith('127.')) return true
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr)
  if (m) return m[1].startsWith('127.')
  return false
}

function isLoopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false
  let n = host
  if (n.startsWith('[')) {
    const end = n.indexOf(']')
    n = end > 0 ? n.slice(1, end) : n
  } else {
    const colon = n.lastIndexOf(':')
    if (colon > 0) n = n.slice(0, colon)
  }
  n = n.toLowerCase()
  return n === 'localhost' || n === '::1' || n === '127.0.0.1' || n.startsWith('127.')
}

function guard(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return 'remote address is not loopback'
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

/* --------------------------------------------------------------- zstd 多帧 */

/** 按 zstd 帧 magic 切分，返回 [start, end) 区间列表。 */
function frameOffsets(raw) {
  const out = []
  let start = -1
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) {
      if (start >= 0) out.push([start, i])
      start = i
    }
  }
  if (start >= 0) out.push([start, raw.length])
  return out
}

/** 解压整个多帧日志为事件数组；尾部半帧（正在写入）自动跳过。 */
function decodeLog(raw) {
  const text = []
  for (const [a, b] of frameOffsets(raw)) {
    try {
      text.push(zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8'))
    } catch {
      /* 半帧，跳过 */
    }
  }
  const events = []
  for (const chunk of text) {
    for (const line of chunk.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        events.push(JSON.parse(s))
      } catch {
        /* 半行，跳过 */
      }
    }
  }
  return events
}

/* ------------------------------------------------------------------ 折叠 */

/** 新建一个空的用量记录。 */
function emptyRecord(id) {
  return {
    id,
    parent: null,
    origin: 'root',
    depth: 0,
    title: null,
    cwd: null,
    createdAt: null,
    steps: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    requests: 0,
    compactionRequests: 0,
    compactionInput: 0,
    compactionOutput: 0,
    compactionCacheRead: 0,
    compactionCacheWrite: 0,
    byProvider: Object.create(null),
    byModel: Object.create(null),
    cacheHitRate: null,
  }
}

/** 把一批事件累加进已有记录（全量与增量共用，保证两条路径口径一致）。 */
function applyEvents(rec, events) {
  for (const e of events) {
    switch (e.type) {
      case 'session':
        rec.id = e.id || rec.id
        rec.parent = e.parentSession || null
        rec.origin = e.origin || 'root'
        rec.depth = e.delegationDepth || 0
        rec.cwd = e.cwd || null
        rec.createdAt = e.createdAt || null
        if (typeof e.title === 'string' && e.title) rec.title = e.title
        break
      case 'session/title': {
        const t = e.data?.title ?? e.data?.text
        if (typeof t === 'string' && t) rec.title = t
        break
      }
      case 'step/end':
        rec.steps++
        break
      case 'assistant/message': {
        const u = e.data?.usage
        if (!u) break
        const inp = u.inputTokens || 0
        const outp = u.outputTokens || 0
        rec.input += inp
        rec.output += outp
        rec.cacheRead += u.cacheReadTokens || 0
        rec.cacheWrite += u.cacheWriteTokens || 0
        rec.reasoning += u.reasoningTokens || 0
        rec.requests++
        const p = e.data?.message?.source?.provider
        if (typeof p === 'string' && p) rec.byProvider[p] = (rec.byProvider[p] || 0) + inp + outp
        const m = e.data?.message?.source?.model
        if (typeof m === 'string' && m) rec.byModel[m] = (rec.byModel[m] || 0) + inp + outp
        break
      }
      case 'compaction/summary': {
        // 压缩摘要本身也是一次模型调用，带完整 usage。
        // 不统计它会让 totals 系统性偏低（实测最高单会话漏 1.76%）。
        const u = e.data?.usage
        if (!u) break
        const inp = u.inputTokens || 0
        const outp = u.outputTokens || 0
        rec.input += inp
        rec.output += outp
        rec.cacheRead += u.cacheReadTokens || 0
        rec.cacheWrite += u.cacheWriteTokens || 0
        rec.reasoning += u.reasoningTokens || 0
        rec.requests++
        rec.compactionRequests++
        rec.compactionInput += inp
        rec.compactionOutput += outp
        rec.compactionCacheRead += u.cacheReadTokens || 0
        rec.compactionCacheWrite += u.cacheWriteTokens || 0
        const p = e.data?.message?.source?.provider ?? e.data?.provider
        if (typeof p === 'string' && p) rec.byProvider[p] = (rec.byProvider[p] || 0) + inp + outp
        const m = e.data?.message?.source?.model ?? e.data?.model
        if (typeof m === 'string' && m) rec.byModel[m] = (rec.byModel[m] || 0) + inp + outp
        break
      }
      default:
        break
    }
  }
  rec.billed = rec.input + rec.output + rec.cacheRead + rec.cacheWrite
  rec.fresh = rec.input + rec.output
  rec.compactionBilled = rec.compactionInput + rec.compactionOutput + rec.compactionCacheRead + rec.compactionCacheWrite
  rec.compactionFresh = rec.compactionInput + rec.compactionOutput
  rec.cacheHitRate = cacheHitRate(rec.cacheRead, rec.input)
  return rec
}

/**
 * 缓存命中率 = 缓存读 /（缓存读 + 未缓存输入）。
 *
 * 分母刻意不含输出和缓存写：命中率回答的是「这次请求的提示词有多少是直接
 * 从缓存里读到的」，输出本来就不可能命中缓存，放进分母会把命中率系统性压低。
 * 分母为 0（一次请求都还没有）时返回 null，UI 显示为「—」而不是误导性的 0%。
 */
function cacheHitRate(cacheRead, input) {
  const cached = cacheRead || 0
  const uncached = input || 0
  const denom = cached + uncached
  if (denom <= 0) return null
  return cached / denom
}

/** 把一个会话日志折叠成用量记录。 */
function foldSession(id, events) {
  return applyEvents(emptyRecord(id), events)
}

/* ------------------------------------------------------------------ 扫描 */

function createScanner(cfg) {
  const cache = {
    files: null,
    filesAt: 0,
    logs: new Map(), // file -> { mtime, size, rec }
    inflight: null, // 单飞：并发扫描合并成一次
    lastScanAt: 0,
  }

  async function listSessionFiles() {
    const now = Date.now()
    if (cache.files && now - cache.filesAt < cfg.scanCacheMs) return cache.files
    const root = join(resolveDshHome(), 'sessions')
    const files = []
    let workspaces
    try {
      workspaces = await readdir(root, { withFileTypes: true })
    } catch {
      return (cache.files = [])
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue
      let subs
      try {
        subs = await readdir(join(root, ws.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const sd of subs) {
        if (!sd.isDirectory()) continue
        files.push({
          workspace: ws.name,
          dir: sd.name,
          file: join(root, ws.name, sd.name, 'session.v4.jsonl.zstd'),
        })
        if (files.length >= cfg.maxSessions) break
      }
      if (files.length >= cfg.maxSessions) break
    }
    cache.files = files
    cache.filesAt = now
    return files
  }

  async function loadOne(entry) {
    let st
    try {
      st = await stat(entry.file)
    } catch {
      return null
    }
    const hit = cache.logs.get(entry.file)

    // 未变化：直接复用。
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.rec

    // 只追加（size 变大且前缀没变）：只解压新增的帧，增量累加。
    // 这是关键优化——进行中的会话每轮都会写入，全量重解会让 7 秒的全量扫描
    // 每 5 秒重跑一遍。zstd 帧是独立可解的，所以可以只解尾部。
    if (hit && st.size > hit.size) {
      let appended = null
      try {
        const fd = await open(entry.file, 'r')
        try {
          const len = st.size - hit.size
          const buf = Buffer.allocUnsafe(len)
          await fd.read(buf, 0, len, hit.size)
          appended = buf
        } finally {
          await fd.close()
        }
      } catch {
        appended = null
      }
      if (appended !== null) {
        let events = null
        try {
          events = decodeLog(appended)
        } catch {
          events = null
        }
        // 尾部可能带一个半帧（正在写），decodeLog 会跳过它；
        // 但若整段一个事件都没解出来，说明切歪了，退回全量。
        if (events !== null && events.length > 0) {
          const rec = hit.rec
          applyEvents(rec, events)
          rec.mtime = st.mtimeMs
          rec.size = st.size
          return rec
        }
      }
    }

    // 其余情况（首次、被截断/重写）：全量解。
    let raw
    try {
      raw = await readFile(entry.file)
    } catch {
      return null
    }
    let rec
    try {
      rec = foldSession(entry.dir, decodeLog(raw))
    } catch {
      return null
    }
    rec.workspace = entry.workspace
    rec.mtime = st.mtimeMs
    rec.size = st.size
    cache.logs.set(entry.file, { mtime: st.mtimeMs, size: st.size, rec })
    return rec
  }

  /** 扫全部会话，返回 id -> rec。 */
  async function scan() {
    // 单飞：并发请求共享同一次扫描。否则 2 个面板 × 15 秒轮询
    // 会同时各跑一遍全量解压，把 CPU 打满。
    if (cache.inflight) return cache.inflight
    cache.inflight = (async () => {
      const entries = await listSessionFiles()
      const out = new Map()
      const limit = 16
      let i = 0
      const workers = new Array(Math.min(limit, entries.length)).fill(0).map(async () => {
        while (i < entries.length) {
          const e = entries[i++]
          const rec = await loadOne(e)
          if (rec) out.set(rec.id, rec)
        }
      })
      await Promise.all(workers)
      cache.lastScanAt = Date.now()
      return out
    })()
    try {
      return await cache.inflight
    } finally {
      cache.inflight = null
    }
  }

  return { scan }
}

/* ------------------------------------------------------------------ 建树 */

function buildTree(map, rootId) {
  const root = map.get(rootId)
  if (!root) return null

  const kids = new Map()
  for (const rec of map.values()) {
    if (!rec.parent) continue
    if (!kids.has(rec.parent)) kids.set(rec.parent, [])
    kids.get(rec.parent).push(rec)
  }
  for (const list of kids.values()) list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

  const sumKeys = [
    'steps',
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'reasoning',
    'requests',
    'billed',
    'fresh',
    'compactionRequests',
    'compactionBilled',
    'compactionFresh',
  ]

  function aggregate(rec) {
    const node = {
      id: rec.id,
      title: rec.title,
      origin: rec.origin,
      depth: rec.depth,
      steps: rec.steps,
      input: rec.input,
      output: rec.output,
      cacheRead: rec.cacheRead,
      cacheWrite: rec.cacheWrite,
      reasoning: rec.reasoning,
      requests: rec.requests,
      billed: rec.billed,
      fresh: rec.fresh,
      cacheHitRate: rec.cacheHitRate,
      compactionRequests: rec.compactionRequests,
      compactionBilled: rec.compactionBilled,
      compactionFresh: rec.compactionFresh,
      byProvider: rec.byProvider,
      byModel: rec.byModel,
      count: 1,
      selfBilled: rec.billed,
      selfFresh: rec.fresh,
      selfInput: rec.input,
      selfOutput: rec.output,
      selfCacheRead: rec.cacheRead,
      selfCompactionBilled: rec.compactionBilled,
      children: [],
    }
    for (const k of kids.get(rec.id) || []) {
      const sub = aggregate(k)
      node.children.push(sub)
      for (const key of sumKeys) node[key] += sub[key]
      node.count += sub.count
    }
    // 命中率是派生量：必须等 input / cacheRead 汇总完再算，
    // 不能放进 sumKeys（比率相加没有意义）。
    node.cacheHitRate = cacheHitRate(node.cacheRead, node.input)
    return node
  }

  return aggregate(root)
}

/** 从任意会话 id 上溯到树根。 */
function findRoot(map, id) {
  let cur = map.get(id)
  if (!cur) return null
  const seen = new Set([id])
  while (cur.parent && map.has(cur.parent) && !seen.has(cur.parent)) {
    seen.add(cur.parent)
    cur = map.get(cur.parent)
  }
  return cur.id || cur.parent || id
}

/* ------------------------------------------------------------------ 输出 */

function stripNode(node) {
  return {
    id: node.id,
    title: node.title,
    origin: node.origin,
    depth: node.depth,
    steps: node.steps,
    requests: node.requests,
    input: node.input,
    output: node.output,
    cacheRead: node.cacheRead,
    cacheWrite: node.cacheWrite,
    reasoning: node.reasoning,
    billed: node.billed,
    fresh: node.fresh,
    cacheHitRate: node.cacheHitRate,
    compactionRequests: node.compactionRequests,
    compactionBilled: node.compactionBilled,
    compactionFresh: node.compactionFresh,
    count: node.count,
    selfBilled: node.selfBilled,
    selfFresh: node.selfFresh,
    selfInput: node.selfInput,
    selfOutput: node.selfOutput,
    selfCacheRead: node.selfCacheRead,
    selfCompactionBilled: node.selfCompactionBilled,
    children: node.children.map(stripNode),
  }
}

/* ------------------------------------------------------------------ 路由 */

const state = { scanner: null }

async function dispatch(req, res) {
  const denied = guard(req)
  if (denied !== null) {
    json(res, 403, { ok: false, error: denied })
    return
  }
  const scanner = state.scanner
  if (scanner === null) {
    json(res, 503, { ok: false, error: 'dsh-token-tree plugin is not active' })
    return
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname.replace(/\/+$/, '')
  try {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
      return
    }

    if (path === `${API}/tree`) {
      const sessionId = url.searchParams.get('sessionId') || ''
      if (!sessionId) {
        json(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const map = await scanner.scan()
      const rootId = findRoot(map, sessionId) || sessionId
      const tree = buildTree(map, rootId)
      if (tree === null) {
        json(res, 200, { ok: true, data: { found: false, sessionId, rootId: null, tree: null } })
        return
      }
      json(res, 200, {
        ok: true,
        data: {
          found: true,
          sessionId,
          rootId,
          isRoot: rootId === sessionId,
          tree: stripNode(tree),
        },
      })
      return
    }

    if (path === `${API}/list`) {
      const n = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 15) || 15))
      const map = await scanner.scan()
      const roots = [...map.values()]
        .filter((r) => !r.parent || r.origin !== 'subagent')
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
        .slice(0, n)
      const items = roots.map((r) => {
        const t = buildTree(map, r.id)
        return {
          id: r.id,
          title: r.title,
          workspace: r.workspace,
          updatedAt: r.mtime,
          billed: t ? t.billed : r.billed,
          fresh: t ? t.fresh : r.fresh,
          agents: t ? t.count : 1,
          steps: t ? t.steps : r.steps,
        }
      })
      json(res, 200, { ok: true, data: { sessions: items, scanned: map.size } })
      return
    }

    json(res, 404, { ok: false, error: `unknown action: ${path}` })
  } catch (e) {
    try {
      json(res, 500, { ok: false, error: String(e?.message ?? e) })
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------- apply */

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const int = (v, d, min, max) => {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) return d
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  return {
    scanCacheMs: int(c.scanCacheMs, DEFAULTS.scanCacheMs, 0, 60_000),
    maxSessions: int(c.maxSessions, DEFAULTS.maxSessions, 100, 50_000),
  }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const scanner = createScanner(cfg)
  state.scanner = scanner

  let disposer = null
  try {
    disposer = ctx.webServer.register({ kind: 'prefix', path: API, handler: dispatch })
  } catch (e) {
    const message = String(e?.message ?? e)
    if (!message.includes('duplicate prefix route')) throw e
    // 热重载：旧 handler 也是 dispatch，会指向新 scanner，复用即可。
  }

  const dispose = () => {
    if (state.scanner === scanner) state.scanner = null
    try {
      disposer?.()
    } catch {
      /* ignore */
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}

/* 自检用导出（不参与运行时） */
export const __test__ = { frameOffsets, decodeLog, foldSession, applyEvents, emptyRecord, buildTree, findRoot, cacheHitRate }
