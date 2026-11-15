/**
 * dsh-file-launcher 自测：不依赖 DSH，用假 ctx 把插件跑起来，
 * 起一个真 HTTP 服务把路由接上，然后逐项验证。
 *
 * v0.2.0 起插件有**两个口**：
 *   - 直连口（自己开的真 server，默认 19587）：主人从聊天里点的链接必须走它，
 *     因为 DSH 侧边栏内嵌浏览器拒绝加载「应用自身 origin」的地址。
 *   - 同源口（挂进假宿主的 webServer）：给客户端插件/健康检查用。
 * 所以本测试同时验两口的服务能力，并且**断言工具生成的链接指向直连口**。
 *
 * 用法：node dsh-file-launcher/selftest.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = 19399            // 假宿主的端口（同源口）
const BASE = `http://127.0.0.1:${PORT}`
const LAUNCH_PORT = 19599     // 直连口（真开的 server，避开默认 19587）
const LBASE = `http://127.0.0.1:${LAUNCH_PORT}`
const ROUTE = '/dsh-launcher'
const TARGET = 'D:\\DeepSeek-Workspace\\.launcher-test-target.cmd'
const MARKER = 'D:\\DeepSeek-Workspace\\.launcher-test-marker.txt'
const STATE = 'D:\\DeepSeek-Workspace\\.launcher-selftest-state.json'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label} ${extra}`) }
}

// 准备靶子脚本：跑起来就写一个 marker 文件
fs.writeFileSync(TARGET, `@echo off\r\necho ran-ok %TIME% > "${MARKER}"\r\n`, 'ascii')
fs.rmSync(MARKER, { force: true })
fs.rmSync(STATE, { force: true })   // 确保走「首次启动」分支，验随机 token

// ---- 假 ctx ----
const routes = []
const tools = []
const disposers = []
let effectCalls = 0
const ctx = {
  tools: { register(t) { tools.push(t) } },
  webServer: {
    host: '127.0.0.1',
    port: PORT,
    register(spec) { routes.push(spec); return () => {} },
  },
  get() { return undefined },
  effect(fn) {
    effectCalls++
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d
  },
}

// ---- 自造 @deepseek-ai/dsh-tools 替身（真机上是 DSH 运行时按别名解析的，盘上没有） ----
const STUB_DIR = 'D:\\DeepSeek-Workspace\\node_modules\\@deepseek-ai\\dsh-tools'
const STUB_PARENT = path.dirname(STUB_DIR)
fs.mkdirSync(STUB_DIR, { recursive: true })
fs.writeFileSync(path.join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-tools', version: '0.0.0-selftest-stub', type: 'module',
  main: 'index.js', exports: { '.': './index.js' },
}, null, 2))
fs.writeFileSync(path.join(STUB_DIR, 'index.js'), 'export function defineTool(def) { return def }\n')

const plugin = await import('./index.js')
console.log(`插件：${plugin.name}  inject=${JSON.stringify(plugin.inject)}`)
plugin.apply(ctx, { stateFile: STATE, port: LAUNCH_PORT })
await sleep(400)   // 等直连口 listen（端口是异步就绪的）

console.log('\n【1】注册面与状态文件')
check('ctx.effect 被调用 2 次（直连口 + 同源路由）', effectCalls === 2, `got ${effectCalls}`)
check('宿主侧注册了 1 条路由', routes.length === 1, `got ${routes.length}`)
check('路由是 prefix 且 path 正确', routes[0]?.kind === 'prefix' && routes[0]?.path === ROUTE)
check('注册了 1 个工具 open_local_file', tools.length === 1 && tools[0].name === 'open_local_file')
check('工具声明了 3 个参数', Object.keys(tools[0].parameters).length === 3)
check('状态文件已落盘', fs.existsSync(STATE))
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
check('状态含 token（16 位 hex）', typeof state.token === 'string' && state.token.length === 16)
check(`直连口端口 = ${LAUNCH_PORT}`, state.launcherPort === LAUNCH_PORT, `got ${state.launcherPort}`)
check('直连口 base 正确', state.launcherBase === LBASE, `got ${state.launcherBase}`)
check('同源口 base 正确', state.dshBase === BASE, `got ${state.dshBase}`)
check('直连口指向 127.0.0.1 而非 0.0.0.0', String(state.launcherBase).startsWith('http://127.0.0.1:'))
check(
  '两口 origin 不同 —— 这是绕开侧边栏守卫的关键',
  new URL(state.launcherBase).origin !== new URL(state.dshBase).origin
)

const get = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.text() } }
const TOKEN = state.token
const link = (mode, p = TARGET, t = TOKEN, base = LBASE) =>
  `${base}${ROUTE}/open?t=${encodeURIComponent(t)}&p=${encodeURIComponent(p)}&m=${mode}`

// ---- 真 HTTP 服务，把同源口路由接上 ----
const srv = http.createServer((req, res) => {
  for (const r of routes) {
    if (String(req.url).startsWith(r.path)) return r.handler(req, res)
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no route')
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))

console.log('\n【2】直连口（主人真正点的那条链路）')
const lhealth = await get(`${LBASE}${ROUTE}/health`)
check('health 200 且 ok=true', lhealth.status === 200 && JSON.parse(lhealth.body).ok === true,
  `status=${lhealth.status}`)

const bad = await get(link('run', TARGET, 'wrong-token'))
check('错 token → 403', bad.status === 403, `got ${bad.status}`)
check('错 token 不执行（没写 marker）', !fs.existsSync(MARKER))

const notfound = await get(link('run', 'D:\\DeepSeek-Workspace\\__nope__.cmd'))
check('文件不存在 → 404 且是中文回执页', notfound.status === 404 && notfound.body.includes('找不到文件'))

const badmode = await get(`${LBASE}${ROUTE}/open?t=${TOKEN}&p=${encodeURIComponent(TARGET)}&m=explode`)
check('非法 mode → 400', badmode.status === 400, `got ${badmode.status}`)

const unknown = await get(`${LBASE}${ROUTE}/nope`)
check('未知子路由 → 404 JSON', unknown.status === 404 && JSON.parse(unknown.body).ok === false)

console.log('\n【3】直连口真跑一个 .cmd')
const ran = await get(link('run'))
check('run 返回 200 回执页', ran.status === 200 && ran.body.includes('已在新窗口运行'), `status=${ran.status}`)
await sleep(3000)
check('目标脚本真的执行了（marker 文件出现）', fs.existsSync(MARKER))
if (fs.existsSync(MARKER)) console.log(`     marker 内容：${fs.readFileSync(MARKER, 'utf8').trim()}`)

const j = await get(link('run') + '&json=1')
check('&json=1 返回 JSON', j.status === 200 && JSON.parse(j.body).ok === true)

console.log('\n【4】同源口（挂进宿主 webServer 的那条）')
const shealth = await get(`${BASE}${ROUTE}/health`)
check('同源口 health 200', shealth.status === 200 && JSON.parse(shealth.body).ok === true,
  `status=${shealth.status}`)

console.log('\n【5】工具 open_local_file')
const t1 = await tools[0].execute({ path: TARGET, mode: 'reveal', action: 'link' })
check('action=link 生成 url 且不执行', t1.ok === true && typeof t1.url === 'string' && t1.url.includes(`${ROUTE}/open`))
check('url 里 mode 正确', t1.url.includes('m=reveal'))
check('★ url 指向直连口而不是 DSH 端口（否则侧边栏打不开）',
  t1.url.startsWith(LBASE), `got ${t1.url}`)
const t2 = await tools[0].execute({ path: 'D:\\__ghost__\\x.cmd', mode: 'run', action: 'link' })
check('文件不存在时仍给链接但 ok=false', t2.ok === false && !!t2.url)
const t3 = await tools[0].execute({ path: '', mode: 'run' })
check('缺少 path 时明确报错', t3.ok === false && t3.message.includes('缺少 path'))
const t4 = await tools[0].execute({ path: TARGET, mode: 'EDIT', action: 'link' })
check('mode 大小写不敏感', t4.url.includes('m=edit'))

console.log('\n【6】auto 动作按扩展名分派（纯函数，无副作用）')
const rm = plugin.resolveMode
check('auto + .cmd → run', rm('auto', '.cmd') === 'run')
check('auto + .bat → run', rm('auto', '.bat') === 'run')
check('auto + .ps1 → run', rm('auto', '.ps1') === 'run')
check('auto + .exe → run', rm('auto', '.exe') === 'run')
check('auto + .docx → open', rm('auto', '.docx') === 'open')
check('auto + .xlsx → open', rm('auto', '.xlsx') === 'open')
check('auto + .pptx → open', rm('auto', '.pptx') === 'open')
check('auto + .pdf → open', rm('auto', '.pdf') === 'open')
check('auto + .png → open', rm('auto', '.png') === 'open')
check('auto + 无扩展名 → open（绝不误执行）', rm('auto', '') === 'open')
check('auto 大小写不敏感', rm('AUTO', '.DOCX') === 'open')
check('不传 mode 默认走 auto', rm(undefined, '.docx') === 'open')
check('显式 open 能压过 .cmd', rm('open', '.cmd') === 'open')
check('显式 run 能压过 .docx', rm('run', '.docx') === 'run')
check('未知动作回落到 auto 的结果', rm('explode', '.docx') === 'open')

// ---- 收尾：关两个口、清替身 ----
srv.close()
for (const d of disposers) { try { d() } catch { /* 已关 */ } }
await sleep(150)

// 清掉替身，别在真机上遮蔽真模块
fs.rmSync(STUB_DIR, { recursive: true, force: true })
try { fs.rmdirSync(STUB_PARENT) } catch { /* 非空就留着 */ }
fs.rmSync(STATE, { force: true })
console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
