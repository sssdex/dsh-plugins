/**
 * dsh-client-patchguard —— 客户端插件补丁守卫
 *
 * 要解决的问题（血泪教训，2026-10-31）：
 *   WorkBuddy 在设置页的分区不是插件自带的，而是本地补丁往 dsh-connect-workbuddy 的
 *   lib/client.js 里注入了一个 settings.section 注册。市场一更新这个包，安装文件被整份
 *   覆盖回原版，补丁就没了 —— 表现是「设置页里又没有自己的侧边栏了」。
 *
 * 两个必须同时成立的机制：
 *   1. 每次宿主启动把配方重新打进已安装的 bundle；运行期再按文件戳轮询，
 *      市场在会话中途更新插件时也能打回去。配方是 JSON（锚点字符串 + 期望 sha256），
 *      上游改版导致锚点失配时只告警、绝不动手。
 *   2. 写文件必须「同目录临时文件 + rename」，绝不就地写。原因：pnpm 的安装文件与
 *      内容寻址存储（CAS，本机 <盘符>\.pnpm-store\v11\files\..）是**硬链接**，
 *      就地写会把 store 里的原始内容一起改掉（nlink=2 时两个路径是同一个 inode）。
 *      写穿 store 会让所有共享这份内容的 profile / 版本一起变脏，而且没有任何报错。
 *
 * 独立自检：node index.js [--dry] [--profile <dir>] [--store <dir>] [--recipe-dir <dir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-client-patchguard'
// 纯文件操作，不依赖任何服务：宿主什么时候启动它就什么时候跑。
export const inject = []

const VERSION = '0.1.0'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const RECIPE_DIR = path.join(HERE, 'recipes')
const DEFAULT_PROFILE = 'desktop'
const DEFAULT_POLL_MS = 3000

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('hex')

// ---------------------------------------------------------------- 路径

/** 与 @deepseek-ai/dsh-home-paths 同语义：DSH_HOME 优先，否则 ~/.dsh。 */
function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME.trim() : path.join(homedir(), '.dsh')
  return path.resolve(raw)
}

/**
 * 定位 profile 目录。
 * 顺序：显式目录 > DSH_HOME/profiles/<name> > ~/.dsh/profiles/<name>，两者都要求
 * profiles/<name>/package.json 真实存在才算数（宿主由桌面启动器拉起，环境变量未必
 * 传到本进程；写错目录会静默地把补丁打到不存在的路径上）。
 */
function resolveProfileDir(profile, explicitDir) {
  if (typeof explicitDir === 'string' && explicitDir.trim().length > 0) return path.resolve(explicitDir)
  const name = profile || DEFAULT_PROFILE
  const candidates = []
  const env = process.env.DSH_HOME
  if (env && env.trim().length > 0) candidates.push(path.resolve(env.trim()))
  candidates.push(path.join(homedir(), '.dsh'))
  for (const home of candidates) {
    const dir = path.join(home, 'profiles', name)
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return path.join(candidates[0], 'profiles', name)
}

/** 从 profile 目录向上找现成的 .pnpm-store；找不到退回盘符根（pnpm 的默认位置）。 */
function resolveStoreRoot(profileDir, configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured)
  let dir = path.resolve(profileDir)
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.pnpm-store')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(path.parse(path.resolve(profileDir)).root, '.pnpm-store')
}

/** CAS 条目路径：files/<sha512[0:2]>/<sha512[2:]>。 */
function casPath(storeRoot, contentSha512) {
  return path.join(storeRoot, 'files', contentSha512.slice(0, 2), contentSha512.slice(2))
}

// ---------------------------------------------------------------- 配方

function loadRecipes(dir = RECIPE_DIR) {
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const n of names) {
    const file = path.join(dir, n)
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof r.package !== 'string' || typeof r.file !== 'string' || !Array.isArray(r.ops) || r.ops.length === 0 || !r.id) {
        out.push({ id: n, recipeFile: file, invalid: 'package/file/ops/id 字段不全' })
        continue
      }
      out.push({ ...r, recipeFile: file })
    } catch (e) {
      out.push({ id: n, recipeFile: file, invalid: String((e && e.message) || e) })
    }
  }
  return out
}

const hitsOf = (text, needle) => text.split(needle).length - 1
const allPresent = (text, markers) => Array.isArray(markers) && markers.length > 0 && markers.every((m) => text.includes(m))

/**
 * 判定安装文件状态：
 *   applied  已打过补丁
 *   pristine 原始未打补丁
 *   unknown  上游改版，锚点失配 —— 只告警，绝不动手
 */
function detectState(text, recipe) {
  if (allPresent(text, recipe.appliedMarkers)) return 'applied'
  if (allPresent(text, recipe.pristineMarkers)) return 'pristine'
  const opHits = recipe.ops.map((op) => ({ old: hitsOf(text, op.old), now: hitsOf(text, op.new) }))
  if (opHits.every((h) => h.old === 1 && h.now === 0)) return 'pristine'
  if (opHits.every((h) => h.now === 1)) return 'applied'
  return 'unknown'
}

function applyOps(text, recipe) {
  let out = text
  const applied = []
  for (const op of recipe.ops) {
    const n = hitsOf(out, op.old)
    if (n !== 1) throw new Error(`锚点「${op.tag}」命中 ${n} 次（需要 1 次）——上游多半改了这段代码`)
    out = out.replace(op.old, op.new)
    applied.push(op.tag)
  }
  return { text: out, applied }
}

/**
 * 结果合法性检查：客户端 bundle 是 classic script（`window.__ModuleLoader__.load({...})`），
 * 所以用 `new vm.Script` 编译一次即可发现括号/引号级别的破坏。
 * 若上游改成了 ESM 形态，`new vm.Script` 会报 "Cannot use import statement outside a module"
 * —— 那不是坏了，是"用这个解析器判断不了"，按通过处理（与 dshmarket 的 checkClientBundle 同策略）。
 */
const MODULE_SYNTAX_ERROR = /Cannot use import statement|Unexpected token 'export'|await is only valid/i
function checkSyntax(buf, recipe) {
  try {
    new vm.Script(buf.toString('utf8'), { filename: `${recipe.package}/${recipe.file}` })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (MODULE_SYNTAX_ERROR.test(message)) return { ok: true, moduleForm: true }
    return { ok: false, reason: message }
  }
}

function reverseOps(text, recipe) {
  let out = text
  for (const op of [...recipe.ops].reverse()) {
    const n = hitsOf(out, op.new)
    if (n !== 1) throw new Error(`反向锚点「${op.tag}」命中 ${n} 次（需要 1 次）`)
    out = out.replace(op.new, op.old)
  }
  return out
}

// ---------------------------------------------------------------- 落盘

/**
 * 唯一的写文件入口：同目录临时文件 + rename。
 * rename 之后新文件是独立 inode，硬链接的另一端（pnpm store）内容不受影响。
 */
function writeBreakingHardlink(target, data) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.patchguard-tmp`)
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, target)
}

function backupOnce(target, backupDir) {
  const stamp = path.join(backupDir, path.basename(target) + '.orig')
  if (fs.existsSync(stamp)) return stamp
  fs.mkdirSync(backupDir, { recursive: true })
  fs.copyFileSync(target, stamp)
  return stamp
}

// ---------------------------------------------------------------- store 卫生

/**
 * 检查/修复 pnpm CAS 污染。
 *
 * 判据：安装文件仍是硬链接（nlink>1）却已经不是原始内容 —— 说明有人就地写过它，
 * 而 CAS 条目与它是同一个 inode，store 里那份「按内容寻址」的原始文件已被改脏。
 *
 * 修复顺序不能反（反了就会把补丁内容写回到 store，或把 pristine 写进安装文件）：
 *   1. 先用「临时文件 + rename」把安装文件变成独立 inode，保住补丁内容；
 *   2. 再就地写回 pristine 内容到 CAS 条目（此时安装文件不受影响）。
 */
function healStore(recipe, { profileDir, storeRoot, log = () => {} } = {}) {
  const target = path.join(profileDir, 'node_modules', recipe.package, recipe.file)
  if (!fs.existsSync(target)) return null
  const buf = fs.readFileSync(target)
  if (fs.statSync(target).nlink <= 1) return null // 独立 inode，store 与它无关
  if (recipe.pristineSha256 && sha256(buf) === recipe.pristineSha256) {
    return { action: 'ok', detail: 'store 未受污染（安装文件仍是原始版）' }
  }
  let pristine
  try {
    pristine = Buffer.from(reverseOps(buf.toString('utf8'), recipe), 'utf8')
  } catch (e) {
    return { action: 'skip', detail: `反向还原失败，未改动 store：${(e && e.message) || e}` }
  }
  const cas = casPath(storeRoot, sha512(pristine))
  if (!fs.existsSync(cas)) return { action: 'skip', detail: `CAS 条目不存在，未改动：${cas}` }

  // 第 1 步：断开硬链接（保留当前已打补丁的内容）
  writeBreakingHardlink(target, buf)
  // 第 2 步：把 CAS 条目还原成 pristine
  if (!fs.readFileSync(cas).equals(pristine)) fs.writeFileSync(cas, pristine)
  log(`[patchguard] 修复被就地写穿的 pnpm store 条目：${cas}`)
  return { action: 'repaired', detail: cas }
}

// ---------------------------------------------------------------- 一次守护

function guardOne(recipe, { profileDir, storeRoot, dry = false, log = () => {} } = {}) {
  const id = recipe.id
  const target = path.join(profileDir, 'node_modules', recipe.package, recipe.file)
  if (!fs.existsSync(target)) return { id, state: 'missing', action: 'none', detail: `未安装：${target}` }

  const original = fs.readFileSync(target)
  const text = original.toString('utf8')
  const state = detectState(text, recipe)
  const nlink = fs.statSync(target).nlink

  if (state === 'applied') {
    const sha = sha256(original)
    if (recipe.patchedSha256 && sha !== recipe.patchedSha256) {
      return { id, state, action: 'none', nlink, drift: true, detail: `已是补丁状态，但整份 sha256=${sha} 与配方记录 ${recipe.patchedSha256} 不同（上游有其它改动；补丁本身仍在）` }
    }
    return { id, state, action: 'none', nlink, detail: '已是补丁状态' }
  }
  if (state === 'unknown') {
    return { id, state, action: 'none', nlink, detail: '锚点失配：上游改了这段代码，需要人工更新配方（未做任何改动）' }
  }

  let result
  try {
    result = applyOps(text, recipe)
  } catch (e) {
    return { id, state, action: 'none', nlink, detail: `打补丁失败：${(e && e.message) || e}` }
  }
  const patched = Buffer.from(result.text, 'utf8')
  // 放行的真正条件：锚点都唯一命中（applyOps 已保证）+ 结果能被解析成合法脚本。
  // 不用 sha256 当闸门 —— 上游改一句注释、升一次版本号，整份文件哈希就变，
  // 那样补丁会被静默拒绝，正是本次事故想避免的那种"看似生效其实没有"。
  const syntax = checkSyntax(patched, recipe)
  if (!syntax.ok) {
    return { id, state, action: 'none', nlink, detail: `套用后语法不合法（未落盘）：${syntax.reason}` }
  }
  const drift = recipe.patchedSha256 && sha256(patched) !== recipe.patchedSha256
  if (dry) return { id, state, action: 'would-patch', nlink, detail: result.applied.join(' / ') + (drift ? '｜注意：结果哈希与配方记录不同（上游有其它改动）' : '') }

  const backup = backupOnce(target, path.join(profileDir, '.dsh-patchguard', 'backup'))
  writeBreakingHardlink(target, patched)
  if (!fs.readFileSync(target).equals(patched)) {
    writeBreakingHardlink(target, original) // 写坏了就回滚，宁可没补丁也不留半坏 bundle
    return { id, state, action: 'rolled-back', nlink, detail: '写入后校验失败，已回滚为原内容' }
  }
  log(`[patchguard] patched ${recipe.package}/${recipe.file}（${result.applied.length} 个锚点），备份 ${backup}`)
  return {
    id, state, action: 'patched', nlink, backup,
    detail: result.applied.join(' / ') + (drift ? '｜上游有其它改动，结果哈希与配方记录不同（已告警但仍打上）' : ''),
  }
}

/** 跑一遍全部配方，返回报表。任何异常都被收敛成状态字符串，绝不抛给宿主。 */
export function runOnce(options = {}) {
  const profileDir = resolveProfileDir(options.profile, options.profileDir)
  const storeRoot = resolveStoreRoot(profileDir, options.storeRoot)
  const log = options.log || (() => {})
  const entries = []
  for (const recipe of loadRecipes(options.recipeDir)) {
    if (recipe.invalid) { entries.push({ id: recipe.id, state: 'invalid-recipe', action: 'none', detail: recipe.invalid }); continue }
    let store = null
    try { store = healStore(recipe, { profileDir, storeRoot, log }) } catch (e) { store = { action: 'error', detail: String((e && e.message) || e) } }
    let guard
    try { guard = guardOne(recipe, { profileDir, storeRoot, dry: options.dry, log }) } catch (e) { guard = { id: recipe.id, state: 'error', action: 'none', detail: String((e && e.message) || e) } }
    entries.push(store === null ? guard : { ...guard, store })
  }
  return { version: VERSION, profileDir, storeRoot, at: new Date().toISOString(), entries }
}

function writeReport(profileDir, report) {
  try {
    const dir = path.join(profileDir, '.dsh-patchguard')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch { /* 报表写不了不是错误 */ }
}

// ---------------------------------------------------------------- 宿主生命周期

export function apply(ctx, config) {
  const cfg = (config && typeof config === 'object') ? config : {}
  const profileDir = resolveProfileDir(cfg.profile, cfg.profileDir)
  const storeRoot = resolveStoreRoot(profileDir, cfg.storeRoot)
  const log = (m) => console.log(m)

  try {
    const report = runOnce({ profileDir, storeRoot, log })
    writeReport(profileDir, report)
    for (const e of report.entries) {
      if (e.action === 'patched' || e.state === 'applied') continue
      console.warn(`[patchguard] ${e.id}: ${e.state} — ${e.detail}`)
    }
  } catch (e) {
    console.error('[patchguard] 启动守护失败（不影响宿主）：', (e && e.message) || e)
  }

  // 运行期看护：市场可以在会话中途更新插件。client-hmr 每 500ms stat 轮询
  // lib/client.js，我们改写后它会自动热换 bundle，无需重启宿主。
  const pollMs = Number.isFinite(cfg.pollIntervalMs) && cfg.pollIntervalMs >= 500 ? Math.floor(cfg.pollIntervalMs) : DEFAULT_POLL_MS
  const seen = new Map()
  const tick = () => {
    for (const recipe of loadRecipes()) {
      if (recipe.invalid) continue
      const target = path.join(profileDir, 'node_modules', recipe.package, recipe.file)
      let st
      try { st = fs.statSync(target) } catch { continue }
      const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`
      if (seen.get(recipe.id) === stamp) continue
      seen.set(recipe.id, stamp)
      try {
        const store = healStore(recipe, { profileDir, storeRoot, log })
        const r = guardOne(recipe, { profileDir, storeRoot, log })
        if (r.action === 'patched') {
          const st2 = fs.statSync(target)
          seen.set(recipe.id, `${st2.mtimeMs}:${st2.size}:${st2.ino}`)
        } else if (r.state === 'unknown' || r.action === 'rolled-back') {
          console.warn(`[patchguard] ${r.id}: ${r.detail}`)
        }
        if (store && store.action === 'repaired') console.warn(`[patchguard] ${r.id}: 已修复 store 污染`)
      } catch (e) {
        console.error('[patchguard] 看护失败：', (e && e.message) || e)
      }
    }
  }
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(tick, pollMs)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'dsh-client-patchguard: bundle watcher')
  } else {
    const timer = setInterval(tick, pollMs)
    timer.unref?.()
  }
}

// ---------------------------------------------------------------- 独立自检

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}
const invokedDirectly = argv.length >= 0 && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  const report = runOnce({
    dry: argv.includes('--dry'),
    profile: flag('--profile'),
    profileDir: flag('--profile-dir'),
    storeRoot: flag('--store'),
    recipeDir: flag('--recipe-dir'),
    log: (m) => console.log(m),
  })
  console.log(`[patchguard] v${report.version}  profile = ${report.profileDir}`)
  console.log(`[patchguard] store = ${report.storeRoot}`)
  for (const e of report.entries) {
    console.log(`  ${e.state.padEnd(10)} ${String(e.action).padEnd(12)} ${e.id}${e.nlink ? ` (nlink=${e.nlink})` : ''}`)
    if (e.detail) console.log(`    ${e.detail}`)
    if (e.store) console.log(`    store: ${e.store.action} — ${e.store.detail}`)
  }
  // 需要人工介入的情况全部返回 1：上游改版、读写出错、以及"本该能打但没打上"。
  const bad = report.entries.filter((e) =>
    e.state === 'unknown' || e.state === 'error' || e.state === 'invalid-recipe' ||
    (e.state === 'pristine' && e.action === 'none') || e.action === 'rolled-back')
  process.exitCode = bad.length === 0 ? 0 : 1
}






