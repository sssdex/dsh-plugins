/**
 * dsh-file-launcher —— 把聊天里的文件变成「点一下就运行 / 打开 / 定位」。
 *
 * 动机：DSH 聊天里的蓝色文件名是**文件引用链接**，语义是「在侧边栏预览」，
 * 不是执行；主人要跑一个 .cmd 只能自己去资源管理器里翻。本插件给出一层
 * 本地 HTTP 路由：链接一点、动作就发生，不必找文件、不必拖拽。
 *
 * 形态：**纯宿主插件**（不需要 client bundle），因此安装后无需构建。
 *
 * 两个出口：
 *   1. HTTP：GET /dsh-launcher/open?t=<token>&p=<绝对路径>&m=<动作>
 *      —— 这是给主人点的链接，动作在服务端执行（页面是回执）。
 *   2. 工具 open_local_file —— 让 AI 自己拿到可点的链接、或直接执行。
 *
 * ⚠️ 两个 HTTP 监听口，缺一不可（血泪教训）：
 *   - 「直连口」127.0.0.1:19587（本插件自己开的 server）：**主人点的链接必须走这个**。
 *     原因：DSH 侧边栏内嵌浏览器有一道硬守卫，直接拒绝加载「应用自身 origin」的地址
 *     （@deepseek-ai/dsh-client-ui-sidebar-browser lib/client.js:387-393：
 *      `if (url.origin === new URL(applicationOrigin).origin) → reason "application-origin"`，
 *      文案「不能在嵌入浏览器中打开 DSH 应用自身」）。
 *     挂在 DSH 端口上的路由，主人从聊天里点是**永远打不开**的 —— 实测踩过。
 *     换端口 = 换 origin = 放行。
 *   - 「宿主口」挂进 DSH webServer 的 /dsh-launcher：与 GUI 同源，便于将来的
 *     客户端插件直接 fetch，也给 curl / 健康检查一个落脚点。
 *
 * 安全：两个口都只监听本机，且都必须带 token。token 与端口都落在
 *       ~/.dsh-launcher.json 并跨重启续用 —— 否则重启一次，之前给出的链接全废。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const name = 'dsh-file-launcher'
export const inject = ['tools', 'webServer']

// @deepseek-ai/dsh-tools 由 DSH 运行时按包名别名解析 —— profile 的 node_modules 里
// 并没有这个包（dsh-meme 也是这么静态 import 的，靠运行时别名）。
// 这里用顶层 await + 兜底：万一解析不到，HTTP 链接通道照样能用，只是少一个工具。
let defineTool = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  defineTool = mod.defineTool ?? (mod.default && mod.default.defineTool) ?? null
} catch (e) {
  console.error('[dsh-file-launcher] @deepseek-ai/dsh-tools 解析失败，仅链接通道可用：', e && e.message)
}

const VERSION = '0.2.1'
const ROUTE = '/dsh-launcher'
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.dsh-launcher.json')
const DEFAULT_PORT = 19587

/**
 * 支持的动作：
 *   auto   按扩展名自动选（默认）：脚本 → run，其余一切 → open
 *   run    执行（.cmd/.bat → 新控制台窗口；.ps1 → powershell -File；.exe → 直接起）
 *   open   交给系统默认程序（Word / WPS / Excel / PDF 阅读器…）
 *   reveal 打开资源管理器并选中该文件
 *   folder 打开文件所在文件夹
 *   edit   用记事本打开
 */
const MODES = ['auto', 'run', 'open', 'reveal', 'folder', 'edit']

/**
 * 把 auto 定义成「按扩展名自动选」：
 *   .cmd/.bat/.ps1/.exe → run（新窗口真的跑起来）
 *   其余一切（docx/xlsx/pptx/pdf/图片/txt…）→ open（交给系统默认程序打开）
 * 这样递文件时不必猜动作：脚本跑得起来，文档打开得开，谁都不会被误执行。
 */
export function resolveMode(mode, ext) {
  const m = String(mode || 'auto').toLowerCase()
  if (m !== 'auto' && MODES.includes(m)) return m
  const e = String(ext || '').toLowerCase()
  return (e === '.cmd' || e === '.bat' || e === '.ps1' || e === '.exe') ? 'run' : 'open'
}

// ---------------------------------------------------------------- 进程启动

/** 独立进程启动：不继承 stdio，父进程退出不影响它已启动的事实 */
function spawnDetached(file, args) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  child.on('error', (e) => console.error('[dsh-file-launcher] 启动失败', file, e && e.message))
  return child.pid
}

/**
 * 按动作启动目标。返回 { ok, message }。
 * 注意 start 的第一个参数是窗口标题，必须是空串，否则带空格路径会被当标题吃掉。
 */
function launchPath(target, mode) {
  const ext = path.extname(target).toLowerCase()
  const dir = path.dirname(target)
  mode = resolveMode(mode, ext)

  if (mode === 'reveal') {
    spawnDetached('explorer.exe', ['/select,' + target])
    return { ok: true, message: '已在资源管理器中选中该文件' }
  }
  if (mode === 'folder') {
    spawnDetached('explorer.exe', [dir])
    return { ok: true, message: '已打开所在文件夹' }
  }
  if (mode === 'edit') {
    spawnDetached('notepad.exe', [target])
    return { ok: true, message: '已用记事本打开' }
  }
  if (mode === 'open') {
    spawnDetached('cmd.exe', ['/c', 'start', '', target])
    return { ok: true, message: '已交给系统默认程序打开' }
  }

  // mode === 'run'
  if (ext === '.cmd' || ext === '.bat' || ext === '') {
    spawnDetached('cmd.exe', ['/c', 'start', '', '/d', dir, target])
    return { ok: true, message: '已在新窗口运行' }
  }
  if (ext === '.ps1') {
    spawnDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target])
    return { ok: true, message: '已运行 PowerShell 脚本' }
  }
  if (ext === '.exe') {
    spawnDetached(target, [])
    return { ok: true, message: '已运行' }
  }
  spawnDetached('cmd.exe', ['/c', 'start', '', target])
  return { ok: true, message: '不是可执行文件，已交给系统默认程序' }
}

// ---------------------------------------------------------------- HTTP 回执页

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
))

function page(res, code, title, detail, tone) {
  const color = tone === 'bad' ? '#d3455b' : '#2f9e6e'
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:15px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f6f7fb}
@media(prefers-color-scheme:dark){body{background:#16181d}}
.card{max-width:640px;margin:24px;padding:28px 32px;border-radius:16px;background:#fff;
box-shadow:0 10px 30px rgba(0,0,0,.10)}
@media(prefers-color-scheme:dark){.card{background:#20232a;color:#e8eaf0}}
h1{margin:0 0 12px;font-size:19px;color:${color}}
code{display:block;margin:14px 0 0;padding:12px 14px;border-radius:10px;background:#f1f3f8;
word-break:break-all;font:13px/1.5 Consolas,monospace}
@media(prefers-color-scheme:dark){code{background:#2b2f38}}
p{margin:0;color:#5b6270}
@media(prefers-color-scheme:dark){p{color:#a8afbd}}
</style></head><body><div class="card">
<h1>${esc(title)}</h1><p>${esc(detail)}</p><code>${esc(title === '找不到文件' ? detail : '')}</code>
<p style="margin-top:16px;font-size:13px;opacity:.7">这个页面只是回执，可以关掉。</p>
</div></body></html>`
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

// ---------------------------------------------------------------- 路由

function makeHandler(token) {
  return function handler(req, res) {
    let u
    try { u = new URL(String(req.url || '/'), 'http://127.0.0.1') } catch { return json(res, 400, { ok: false, error: 'bad url' }) }
    const sub = u.pathname.slice(ROUTE.length).replace(/^\/+/, '').replace(/\/+$/, '')
    const wantsJson = u.searchParams.get('json') === '1'

    if (sub === 'health') {
      return json(res, 200, { ok: true, name, version: VERSION, route: ROUTE })
    }
    if (sub !== '' && sub !== 'open') {
      return json(res, 404, { ok: false, error: 'unknown route: ' + sub })
    }
    if (u.searchParams.get('t') !== token) {
      if (wantsJson) return json(res, 403, { ok: false, error: 'bad token' })
      return page(res, 403, '令牌不对', '这条链接的 t 参数与服务端不匹配。请让 AI 重新生成一条链接。', 'bad')
    }

    const raw = (u.searchParams.get('p') || '').trim()
    const mode = (u.searchParams.get('m') || 'auto').toLowerCase()
    if (!raw) return json(res, 400, { ok: false, error: 'missing p' })
    if (!MODES.includes(mode)) return json(res, 400, { ok: false, error: 'bad mode: ' + mode })

    const target = path.resolve(raw)
    if (!fs.existsSync(target)) {
      if (wantsJson) return json(res, 404, { ok: false, error: 'not found: ' + target })
      return page(res, 404, '找不到文件', target, 'bad')
    }

    let r
    try {
      r = launchPath(target, mode)
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (wantsJson) return json(res, 500, { ok: false, error: msg })
      return page(res, 500, '启动失败', msg, 'bad')
    }

    if (wantsJson) return json(res, 200, { ok: true, mode, path: target, message: r.message })
    page(res, 200, r.message, target, 'good')
  }
}

// ---------------------------------------------------------------- 直连口

/**
 * 本插件自己开的 HTTP 服务。存在的唯一理由是绕开侧边栏浏览器的
 * 「application-origin」守卫（详见文件头注释）。
 * 端口占用时自动 +1 重试，最多 25 次。
 */
function startOwnServer(token, preferredPort, onReady) {
  const srv = http.createServer(makeHandler(token))
  let port = preferredPort
  let tries = 0

  srv.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE' && tries < 25) {
      tries += 1
      port += 1
      setTimeout(() => { try { srv.listen(port, '127.0.0.1') } catch { /* 下一轮 error 再处理 */ } }, 0)
      return
    }
    console.error('[dsh-file-launcher] 直连口启动失败：', (e && e.message) || e)
  })

  srv.on('listening', () => {
    const addr = srv.address()
    onReady(addr && typeof addr === 'object' ? addr.port : port)
  })

  srv.listen(port, '127.0.0.1')
  return srv
}

// ---------------------------------------------------------------- 工具

function registerTools(ctx, ctxApi) {
  const { token, resolveBase } = ctxApi
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return
  if (typeof defineTool !== 'function') {
    console.error('[dsh-file-launcher] defineTool 不可用，跳过工具注册（链接通道不受影响）')
    return
  }

  ctx.tools.register(defineTool({
    name: 'open_local_file',
    description:
      '生成一条「点一下就触发」的本地链接（dsh-file-launcher 插件）。' +
      '主人抱怨「文件点不开 / 还得去文件夹里找 / 拖不进终端」时用这个：把返回的 url 字段作为 markdown 链接贴进回复，主人点一下就会运行或打开。' +
      'mode: auto=按扩展名自动（默认；脚本→执行、Word/Excel/PDF/图片→用默认程序打开）、run=执行(.cmd/.bat/.ps1/.exe)、open=系统默认程序打开、reveal=资源管理器中选中、folder=打开所在文件夹、edit=记事本打开。' +
      'action=link 只给链接（默认，推荐）；action=exec 是立刻执行（AI 自己触发，主人不用点）。',
    parameters: {
      path: { type: 'string', description: '目标文件的绝对路径' },
      mode: { type: 'string', description: 'run | open | reveal | folder | edit，默认 run' },
      action: { type: 'string', description: 'link=只返回可点链接（默认）；exec=立刻执行并同时返回链接' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const raw = String(args.path || '').trim()
      const mode = MODES.includes(String(args.mode || '').toLowerCase()) ? String(args.mode).toLowerCase() : 'auto'
      const action = String(args.action || 'link').toLowerCase()
      if (!raw) return { ok: false, url: null, message: '缺少 path' }

      // 链接必须在调用时取：直连口的端口是异步就绪的，注册工具时还不知道。
      const base = typeof resolveBase === 'function' ? resolveBase() : null
      if (!base) return { ok: false, url: null, message: '两个出口都没起来，无法生成链接' }

      const target = path.resolve(raw)
      const exists = fs.existsSync(target)
      const url = base + ROUTE + '/open?t=' + encodeURIComponent(token)
        + '&p=' + encodeURIComponent(target) + '&m=' + mode

      let ran = null
      if (action === 'exec') {
        if (!exists) return { ok: false, url, message: '文件不存在：' + target }
        try { ran = launchPath(target, mode) } catch (e) { return { ok: false, url, message: '启动失败：' + String((e && e.message) || e) } }
      }

      const head = ran ? ran.message : (exists ? '链接已生成' : '警告：文件当前不存在（链接仍可复制）')
      return {
        ok: exists,
        url,
        mode,
        path: target,
        message: `${head}\n路径：${target}\n动作：${mode}\n链接：${url}`,
      }
    },
  }))
}

// ---------------------------------------------------------------- 生命周期

export function apply(ctx, config) {
  const cfg = config || {}

  // stateFile 必须先算出来：token 与端口都要跨重启续用。
  // 踩过的坑：每次启动都随机新 token，主人重启一次，之前给过的所有链接就全部 403。
  const stateFile = (typeof cfg.stateFile === 'string' && cfg.stateFile) ? cfg.stateFile : DEFAULT_STATE_FILE
  let persisted = {}
  try { persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {} } catch { /* 首次启动没有状态文件，正常 */ }

  const token = (typeof cfg.token === 'string' && cfg.token)
    ? cfg.token
    : (typeof persisted.token === 'string' && persisted.token ? persisted.token : crypto.randomBytes(8).toString('hex'))

  // 端口也续用：不然重启一次端口就变，旧链接同样废掉。
  const preferredPort = Number.isInteger(cfg.port) && cfg.port > 0
    ? cfg.port
    : (Number.isInteger(persisted.launcherPort) && persisted.launcherPort > 0 ? persisted.launcherPort : DEFAULT_PORT)

  const runtime = { launcherPort: null, launcherBase: null }
  let dshBase = null

  const writeState = () => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({
        version: VERSION,
        token,
        // 主人点的链接用这个（独立端口，侧边栏守卫才放行）
        launcherBase: runtime.launcherBase,
        launcherPort: runtime.launcherPort,
        route: ROUTE,
        // 与 DSH GUI 同源的口（供将来的客户端插件 fetch / 健康检查）
        dshBase,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }, null, 2), 'utf8')
    } catch (e) {
      console.error('[dsh-file-launcher] 状态文件写入失败：', e && e.message)
    }
  }

  // ---- 出口 1：独立端口的直连服务（主人真正点的那个）----
  try {
    const srv = startOwnServer(token, preferredPort, (actualPort) => {
      runtime.launcherPort = actualPort
      runtime.launcherBase = 'http://127.0.0.1:' + actualPort
      writeState()
      console.log(`[dsh-file-launcher] 直连口就绪 ${runtime.launcherBase}${ROUTE}`)
    })
    ctx.effect(() => () => { try { srv.close() } catch { /* 已关闭 */ } })
  } catch (e) {
    console.error('[dsh-file-launcher] 直连服务异常：', e && e.message)
  }

  // ---- 出口 2：挂进 DSH webServer 的同源口 ----
  const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
  if (webServer) {
    const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : (webServer.host || '127.0.0.1')
    dshBase = 'http://' + host + ':' + webServer.port
    try {
      // 挂 ctx.effect：插件被关掉/热重载时由宿主跑 disposer 摘掉路由，
      // 否则同进程再次 apply 会撞 duplicate route。
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: makeHandler(token),
      }))
    } catch (e) {
      console.error('[dsh-file-launcher] 路由注册失败：', e && e.message)
    }
  } else {
    console.error('[dsh-file-launcher] 拿不到 webServer，同源口不可用（直连口不受影响）')
  }

  writeState()

  // 链接优先级：直连口（侧边栏放行）→ 同源口
  const resolveBase = () => runtime.launcherBase || dshBase

  try {
    registerTools(ctx, { token, resolveBase })
  } catch (e) {
    console.error('[dsh-file-launcher] 工具注册失败：', e && e.message)
  }

  console.log(`[dsh-file-launcher] ready — 直连口 ${runtime.launcherBase || '(pending)'} / 同源口 ${dshBase || '(none)'}  state=${stateFile}`)
}
