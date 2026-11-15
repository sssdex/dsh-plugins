/**
 * dsh-auth-cookie-guard —— 根治「DSH 启动即崩：desktop welcome: Web authentication failed」。
 *
 * 完整根因推导、实测数据与两层修复的原理，见 lib/guard.js 顶部注释（那里是唯一事实来源）。
 * 这里只负责把守卫挂到宿主的 http server 上、暴露状态、以及提供离线修复入口。
 *
 * 形态：**纯宿主插件**（不需要 client bundle），装上即生效，无需构建。
 *
 * 三个出口：
 *   1. 运行时守卫（自动）：抬高 maxHeaderSize + 种新 cookie 时清旧 cookie。
 *   2. 工具 auth_cookie_status：让 AI / 主人当场看到实时状态（含「若不修，还能撑几次启动」）。
 *   3. CLI：`node index.js --status` / `--prune-db`，给开机健康检查与离线抢救用。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installGuard, COOKIE_PREFIX, DEFAULT_MAX_HEADER_SIZE, collectAuthCookieNames } from './lib/guard.js'

export const name = 'dsh-auth-cookie-guard'
export const inject = ['webServer']

const VERSION = '1.0.0'

/** 桌面端 cookie 库的默认位置（Electron userData 下的 Network\Cookies）。 */
const DESKTOP_USERDATA =
  process.env.DSH_AUTH_COOKIE_USERDATA ||
  (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '@deepseek-ai', 'dsh-desktop')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), '@deepseek-ai', 'dsh-desktop'))

const COOKIE_DB = path.join(DESKTOP_USERDATA, 'Network', 'Cookies')

/**
 * 一条 cookie 的估算体积（名字 + 值 + 属性 + 分隔符）。
 * 实测本机 71 条对应 15,867 字节 → 平均 223.5B/条，这个估算与实测吻合。
 *
 * 注意这里必须用**实测经验值**而不是「当前长度 ÷ 当前条数」：cookie 库会被 Chromium
 * 加密存储（encrypted_value），仅靠 SQLite 读出的明文 value 常为空，除出来会偏小。
 */
const BYTES_PER_COOKIE = 225

/** 安全水位：Cookie 头占用超过 Node 上限的这个比例就报警。 */
const WARN_RATIO = 0.75

// ---------------------------------------------------------------- 运行时守卫

/**
 * 把守卫装到宿主的 http server 上。
 * `webServer.server` 是 WebServer 服务的公开字段（`this.server = createServer(listener)`），
 * 但插件激活时序上它不一定已经赋值，因此带一个有上限的重试。
 */
function attachGuard(ctx, config, report) {
  const maxHeaderSize =
    Number.isFinite(config.maxHeaderSize) && config.maxHeaderSize > 0
      ? Math.floor(config.maxHeaderSize)
      : DEFAULT_MAX_HEADER_SIZE
  const prefix = typeof config.cookiePrefix === 'string' && config.cookiePrefix ? config.cookiePrefix : COOKIE_PREFIX

  let cancelled = false
  let handle = null
  let timer = null

  const tryAttach = () => {
    if (cancelled || handle) return true
    const webServer = ctx.webServer
    const server = webServer && webServer.server
    if (!server || typeof server.prependListener !== 'function') return false

    handle = installGuard(server, {
      maxHeaderSize,
      prefix,
      raiseHeaderLimit: config.raiseHeaderLimit !== false,
    })
    report.handle = handle
    const before = handle.state.maxHeaderSizeBefore
    const after = handle.state.maxHeaderSizeAfter
    console.log(
      `[dsh-auth-cookie-guard] 已挂载到宿主 ${webServer.protocol || 'http:'}//${webServer.host || '127.0.0.1'}:${webServer.port} — ` +
        `maxHeaderSize ${before === undefined ? '(默认 16384)' : before} → ${after}；` +
        `将在种新 ${prefix}* cookie 时批量删除旧 cookie`,
    )
    return true
  }

  if (!tryAttach()) {
    // inject: ['webServer'] 保证 apply() 跑的时候服务已经初始化完，正常路径下会一次挂上。
    // 这个重试是为兜底：万一时序/顺序变了（热重载、其它插件先改 server），也不至于静默失效。
    let tries = 0
    const maxTries = 300 // 30s
    timer = setInterval(() => {
      tries += 1
      if (tryAttach() || tries >= maxTries) {
        clearInterval(timer)
        timer = null
        if (!handle) {
          report.error = `等待 webServer.server 超时（${maxTries} 次重试后仍未就绪），守卫未挂载`
          console.error(`[dsh-auth-cookie-guard] ${report.error}（工具/CLI 通道不受影响）`)
        }
      }
    }, 100)
    if (typeof timer.unref === 'function') timer.unref()
  }

  ctx.effect(() => () => {
    cancelled = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (handle) {
      handle.restore()
      handle = null
    }
  })
}

// ---------------------------------------------------------------- cookie 库巡检

/**
 * 只读扫描桌面端 cookie 库，统计 dsh-auth-* 的占用。
 *
 * 为什么这里是「只读 + 备用」而不是主修法：Chromium 运行期间会独占
 * `Network\Cookies`（实测 FileShare 全开也打不开），所以**应用开着的正常场景下摸不到库**。
 * 真正干活的是运行时守卫；本函数服务于两件事：
 *   - 应用已关闭时做体检 / 抢救；
 *   - 用「库里到底堆了几条」给人看铁证。
 *
 * @returns `{ ok, available, reason, total, authCookies, bytes, limit, healthy }`
 */
export async function inspectCookieStore(dbPath = COOKIE_DB) {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (error) {
    return { ok: false, available: false, reason: 'node:sqlite 不可用：' + String((error && error.message) || error) }
  }
  if (!fs.existsSync(dbPath)) {
    return { ok: false, available: false, reason: 'cookie 库不存在：' + dbPath }
  }

  const { DatabaseSync } = sqlite
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    // 应用正在运行 → Chromium 独占，属正常情况，不是故障。
    return {
      ok: false,
      available: false,
      dbPath,
      reason: 'cookie 库被占用（DSH 正在运行）：' + String((error && error.message) || error),
    }
  }

  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM cookies WHERE host_key = '127.0.0.1' AND name LIKE ?")
      .get(COOKIE_PREFIX + '%')
    const authCookies = Number(row && row.n ? row.n : 0)
    // 16KB 是 Node 默认上限；按每条 225B 算，约 73 条越线（实机 71 条已崩，与之吻合）。
    const crashThreshold = Math.floor(16384 / BYTES_PER_COOKIE)
    const bytes = authCookies * BYTES_PER_COOKIE
    return {
      ok: true,
      available: true,
      dbPath,
      total: authCookies,
      authCookies,
      bytes,
      nodeDefaultLimit: 16384,
      crashThreshold,
      healthy: bytes < 16384 * WARN_RATIO,
      remainingStarts: Math.max(0, crashThreshold - authCookies),
    }
  } catch (error) {
    return { ok: false, available: false, dbPath, reason: String((error && error.message) || error) }
  } finally {
    try {
      db.close()
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 离线清库：把 dsh-auth-* 全删掉（应用必须已关闭）。
 * 先备份成 `Cookies.bak-<时间戳>-auth-cookie-guard`，再删。
 *
 * @returns `{ ok, removed, backup, reason }`
 */
export async function pruneCookieStore(dbPath = COOKIE_DB) {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (error) {
    return { ok: false, removed: 0, reason: 'node:sqlite 不可用：' + String((error && error.message) || error) }
  }
  if (!fs.existsSync(dbPath)) return { ok: false, removed: 0, reason: 'cookie 库不存在：' + dbPath }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const backup = path.join(path.dirname(dbPath), `Cookies.bak-${stamp}-auth-cookie-guard`)
  try {
    fs.copyFileSync(dbPath, backup)
  } catch (error) {
    return {
      ok: false,
      removed: 0,
      reason:
        '备份失败（多半是 DSH 还开着，Chromium 独占 cookie 库 — 请先完全退出 DSH 桌面端）：' +
        String((error && error.message) || error),
    }
  }

  const { DatabaseSync } = sqlite
  let db
  try {
    db = new DatabaseSync(dbPath)
  } catch (error) {
    return { ok: false, removed: 0, backup, reason: String((error && error.message) || error) }
  }
  try {
    const before = db.prepare("SELECT COUNT(*) AS n FROM cookies WHERE name LIKE ?").get(COOKIE_PREFIX + '%')
    db.prepare('DELETE FROM cookies WHERE name LIKE ?').run(COOKIE_PREFIX + '%')
    const after = db.prepare("SELECT COUNT(*) AS n FROM cookies WHERE name LIKE ?").get(COOKIE_PREFIX + '%')
    return {
      ok: true,
      removed: Number(before && before.n ? before.n : 0) - Number(after && after.n ? after.n : 0),
      remaining: Number(after && after.n ? after.n : 0),
      backup,
    }
  } catch (error) {
    return { ok: false, removed: 0, backup, reason: String((error && error.message) || error) }
  } finally {
    try {
      db.close()
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------- 工具

/**
 * 动态取 defineTool（profile 里没有这个包，靠宿主运行时别名解析）。
 *
 * 允许被替换是为了**可离线自测**：这个包只在 DSH 运行时里存在，离线跑自测时必然
 * 解析不到，那样 `registerTools()` 就整条路径都测不到（真实踩过：工具静默没注册上，
 * 而自测却「通过」）。所以留一个 `setDefineToolLoader()` 的接缝，让自测能注入一个假的。
 */
let defineToolLoader = async () => {
  const mod = await import('@deepseek-ai/dsh-tools')
  return mod.defineTool ?? (mod.default && mod.default.defineTool) ?? null
}

/** 仅自测使用：替换 defineTool 的解析方式。传 null 恢复默认。 */
export function setDefineToolLoader(loader) {
  const previous = defineToolLoader
  defineToolLoader = typeof loader === 'function' ? loader : async () => {
    const mod = await import('@deepseek-ai/dsh-tools')
    return mod.defineTool ?? (mod.default && mod.default.defineTool) ?? null
  }
  return previous
}

async function loadDefineTool() {
  try {
    return await defineToolLoader()
  } catch {
    return null
  }
}

async function registerTools(ctx, report, config) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return
  const defineTool = await loadDefineTool()
  if (typeof defineTool !== 'function') {
    console.error('[dsh-auth-cookie-guard] defineTool 不可用，跳过工具注册（守卫本身不受影响）')
    return
  }

  const dbPath = typeof config.cookieDb === 'string' && config.cookieDb ? config.cookieDb : COOKIE_DB

  ctx.tools.register(
    defineTool({
      name: 'auth_cookie_status',
      description:
        '查看 DSH 认证 cookie 守卫的实时状态（dsh-auth-cookie-guard 插件）。' +
        '用途：DSH 启动崩溃（desktop welcome: Web authentication failed）、或想确认「还会不会再崩」时看这个。' +
        '它会给出：本次进程已清掉多少条旧 cookie、历史上最多一次请求带了多少条 dsh-auth-* cookie、' +
        'Cookie 头峰值字节数、当前头上限，以及 cookie 库里还剩几条（库里若被运行中的进程占用会如实说明）。' +
        'action=status 只看状态（默认）；action=prune 尝试离线清库（DSH 必须已完全退出，会先自动备份）。',
      parameters: {
        action: { type: 'string', description: 'status=看状态（默认）；prune=离线清库（需先退出 DSH）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const action = String(args.action || 'status').toLowerCase()

        if (action === 'prune') {
          const pruned = await pruneCookieStore(dbPath)
          const message = pruned.ok
            ? `已清掉 ${pruned.removed} 条 dsh-auth-* cookie（剩余 ${pruned.remaining} 条）。\n备份：${pruned.backup}`
            : `清库未完成：${pruned.reason}`
          return { ok: pruned.ok, ...pruned, message }
        }

        const guard = report.handle ? report.handle.state : null
        const store = await inspectCookieStore(dbPath)
        const lines = []
        if (guard) {
          const before = guard.maxHeaderSizeBefore
          lines.push(
            `守卫：已挂载（${guard.startedAt}）`,
            `头上限：${before === undefined ? '默认 16384' : before} → ${guard.maxHeaderSizeAfter} 字节`,
            `已清理旧 cookie：${guard.removedTotal} 条（横跨 ${guard.purges} 次响应）`,
            `本进程见过的峰值：一次请求 ${guard.maxCookies} 条 / Cookie 头 ${guard.maxCookieBytes} 字节`,
            `本进程请求计数（带认证 cookie 的）：${guard.requests}`,
          )
          if (guard.lastPurge) lines.push(`最近一次清理：${guard.lastPurge.at}，删 ${guard.lastPurge.removed.length} 条`)
        } else {
          lines.push(`守卫：未挂载${report.error ? '（' + report.error + '）' : ''}`)
        }
        lines.push('')
        if (store.available) {
          lines.push(
            `cookie 库：${store.authCookies} 条 dsh-auth-*（约 ${store.bytes} 字节）`,
            `距越线（${store.nodeDefaultLimit} 字节 ≈ ${store.crashThreshold} 条）还有约 ${store.remainingStarts} 次启动的余量`,
            store.healthy ? '判定：健康' : '判定：偏高，建议清理',
          )
        } else {
          lines.push(`cookie 库：未读取 — ${store.reason}`)
        }
        lines.push('', `库路径：${dbPath}`)
        return { ok: true, guard, store, message: lines.join('\n') }
      },
    }),
  )
}

// ---------------------------------------------------------------- 生命周期

export async function apply(ctx, config) {
  const cfg = config || {}
  const report = { handle: null, error: null }

  attachGuard(ctx, cfg, report)

  try {
    await registerTools(ctx, report, cfg)
  } catch (error) {
    console.error('[dsh-auth-cookie-guard] 工具注册失败：', (error && error.message) || error)
  }

  const dbPath = typeof cfg.cookieDb === 'string' && cfg.cookieDb ? cfg.cookieDb : COOKIE_DB
  console.log(`[dsh-auth-cookie-guard] v${VERSION} ready — 目标 cookie 前缀 ${cfg.cookiePrefix || COOKIE_PREFIX}，库 ${dbPath}`)
}

// ---------------------------------------------------------------- CLI

/**
 * 给开机健康检查 / 离线抢救用的命令行入口。
 *   node index.js --status      只读体检（应用开着也能看运行时部分，库部分会说明占用）
 *   node index.js --prune-db    离线清库（先备份；应用必须已退出）
 */
async function cli() {
  const argv = new Set(process.argv.slice(2))

  if (argv.has('--status') || argv.size === 0) {
    const store = await inspectCookieStore()
    console.log(`[dsh-auth-cookie-guard] v${VERSION}`)
    console.log(`cookie 库：${COOKIE_DB}`)
    if (store.available) {
      console.log(`  dsh-auth-* 条数：${store.authCookies}`)
      console.log(`  估算 Cookie 头：${store.bytes} 字节（Node 默认上限 ${store.nodeDefaultLimit}）`)
      console.log(`  距越线还有约 ${store.remainingStarts} 次启动余量`)
      console.log(`  判定：${store.healthy ? '健康' : '偏高，建议清理'}`)
    } else {
      console.log(`  未能读取：${store.reason}`)
    }
    // 退出码：0 = 健康或读不到（读不到不算故障，运行时守卫兜着）；1 = 偏高
    process.exitCode = store.available && !store.healthy ? 1 : 0
    return
  }

  if (argv.has('--prune-db')) {
    const pruned = await pruneCookieStore()
    if (pruned.ok) {
      console.log(`已清掉 ${pruned.removed} 条 dsh-auth-* cookie，剩余 ${pruned.remaining} 条。`)
      console.log(`备份：${pruned.backup}`)
      process.exitCode = 0
    } else {
      console.error(`清库失败：${pruned.reason}`)
      process.exitCode = 1
    }
    return
  }

  console.error('用法：node index.js [--status | --prune-db]')
  process.exitCode = 2
}

/**
 * 被 `node index.js` 直接执行时进 CLI；被宿主 import 时 apply() 才是入口。
 *
 * 这里必须用 `pathToFileURL` 而不是手拼字符串：Windows 下 argv[1] 是
 * `D:\...\index.js`，拼成 `file://D:/...` 会把驱动器号解析成 URL 的 host，
 * 和 import.meta.url 永远不相等 —— 结果就是 CLI 静默不生效（踩过）。
 */
function invokedAsScript() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  await cli()
}

export { COOKIE_PREFIX, COOKIE_DB, DESKTOP_USERDATA, collectAuthCookieNames }
