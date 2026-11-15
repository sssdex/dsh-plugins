/**
 * preset-lean 静态自检（不启动 DSH，不跑会话）
 *
 * 检查项：
 *   1. YAML 能解析（含 DSH 自定义的 !!js 标量）
 *   2. 声明行本身合法：id / config.id / order / plugins 齐全，config.id 不撞 shipped 预设
 *   3. 每个插件行的 `name` 包在 asar 或 profile node_modules 里存在；
 *      带子路径的（@x/y/tools）还要 package.json exports 里真有该子路径
 *   4. 行级 config 的键名存在于该插件的 Config schema，必填字段不漏
 *      （`sampleOverCapGlobResults` / `allowParallelInProgress` / `maxBytes` 这类
 *       required 无默认值的字段，漏写会在 Loader 加载时报错）
 *   5. persona 行：complete: true 时 prefix 必填，且不得出现被实测否定的措辞
 *   6. 树结构与 standard 对照：算出删了哪些工具、header 估算降到多少
 *
 * 用法：
 *   node verify.mjs                 # 校验本目录
 *   node verify.mjs <preset目录>     # 校验别的目录
 *
 * 为什么用 asar 而不是 profile/node_modules：
 *   profile 的 node_modules/@deepseek-ai 下只有 7 个包（大部分插件打包在
 *   app.asar 里）。只看 profile 会误报一堆「包不存在」。
 */
import { openSync, readSync, closeSync, readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRESET_DIR = process.argv[2] ?? HERE
const ASAR = 'D:/Programs/DeepSeek-Harness/resources/app.asar'
const ASAR_UNPACKED = 'D:/Programs/DeepSeek-Harness/resources/app.asar.unpacked/'
const PROFILE_MODULES = 'D:/DeepSeek-DSH/profiles/desktop/node_modules'

const failures = []
const notes = []
const fail = (m) => failures.push(m)

// ── asar 读取 ────────────────────────────────────────────────────────────────
if (!existsSync(ASAR)) {
  console.error(`找不到 asar: ${ASAR}`)
  process.exit(2)
}
const fd = openSync(ASAR, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
readSync(fd, headerBuf, 0, headerSize, 16)
const asarJson = JSON.parse(headerBuf.toString('utf8'))
const asarBase = 16 + headerSize
const asarEntries = new Map()
;(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else asarEntries.set(p, entry)
  }
})(asarJson, '')

function readAsarFile(relPath) {
  const entry = asarEntries.get(relPath)
  if (entry === undefined) return undefined
  if (entry.unpacked) {
    const onDisk = ASAR_UNPACKED + relPath
    return existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : undefined
  }
  const buf = Buffer.alloc(entry.size)
  readSync(fd, buf, 0, entry.size, asarBase + Number(entry.offset))
  return buf.toString('utf8')
}

// ── 包定位 ──────────────────────────────────────────────────────────────────
/** 把 '@scope/pkg/sub' 拆成 { pkg:'@scope/pkg', sub:'sub' }；'pkg' → sub: undefined */
function splitPackageName(name) {
  const parts = name.split('/')
  if (name.startsWith('@')) {
    const pkg = parts.slice(0, 2).join('/')
    const sub = parts.length > 2 ? parts.slice(2).join('/') : undefined
    return { pkg, sub }
  }
  return { pkg: parts[0], sub: parts.length > 1 ? parts.slice(1).join('/') : undefined }
}

/** 返回包的 package.json 内容与来源位置，找不到返回 undefined。 */
function locatePackage(pkg) {
  const fromAsar = readAsarFile(`dsh/node_modules/${pkg}/package.json`)
  if (fromAsar !== undefined) return { json: JSON.parse(fromAsar), where: 'asar', root: `dsh/node_modules/${pkg}` }
  const onDisk = path.join(PROFILE_MODULES, pkg, 'package.json')
  if (existsSync(onDisk)) return { json: JSON.parse(readFileSync(onDisk, 'utf8')), where: 'profile', root: onDisk }
  return undefined
}

/** exports 里是否有这个子路径（'.' 表示包根）。 */
function hasSubpathExport(pkgJson, sub) {
  const exports = pkgJson.exports
  if (exports === undefined) return false
  if (typeof exports === 'string' || Array.isArray(exports)) return sub === undefined
  const key = sub === undefined ? '.' : `./${sub}`
  if (Object.hasOwn(exports, key)) return true
  // 通配子路径，例如 './src/*' 或 './locale/*.json'
  return Object.keys(exports).some((k) => k.includes('*') && key.startsWith(k.slice(0, k.indexOf('*'))))
}

// ── Config schema 抽取（近似正则，不执行插件代码）────────────────────────────
/**
 * 从 lib/index.js 抠出 `Config = z.object({...})` 或 `static Config = z.object({...})`
 * 的顶层键名与 required 字段。抠不到返回 undefined。
 *
 * 为什么不用正则逐行拆：schemastery 的写法有嵌套 object 与多行链式调用，
 * 这里按花括号/圆括号/方括号深度只在最外层认键名，够用且不误报。
 */
function declaredConfigSchema(pkgRoot) {
  const text = readAsarFile(`${pkgRoot}/lib/index.js`)
  if (text === undefined) return undefined
  const m = /(?:static\s+)?Config\s*=\s*z\.object\(/.exec(text)

  // 手工校验器分支：dsh-plan-mode 没有 zod Config，而是在 apply 前调
  // resolveConfig() 自己检查。它抛 "unknown key(s)"，所以这份名单同样是硬约束，
  // 不检查就会漏掉「写错键名静默失效 / 写错键直接抛错」。
  // 例：dsh-plan-mode —— const section = config.section;
  //     if (typeof section !== "string") throw；
  //     Object.keys(config).filter(key => key !== "section")
  if (m === null) {
    const fn = /function\s+resolveConfig\s*\([^)]*\)\s*\{/.exec(text)
    if (fn === null) return undefined
    let depth = 0
    let end = -1
    const start = text.indexOf('{', fn.index + fn[0].length - 1)
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) return undefined
    const body = text.slice(start + 1, end)
    // 白名单：`key !== "x"` 里的 x，以及 `config.x` 直读的字段
    const allowed = new Set()
    for (const km of body.matchAll(/key\s*!==\s*["'`]([\w$]+)["'`]/g)) allowed.add(km[1])
    for (const km of body.matchAll(/config\.([\w$]+)/g)) allowed.add(km[1])
    // 必填：`const v = config.x` 之后 `typeof v !== "string"` 抛错
    const required = new Set()
    const locals = new Map()
    for (const km of body.matchAll(/const\s+([\w$]+)\s*=\s*config\.([\w$]+)/g)) locals.set(km[1], km[2])
    for (const km of body.matchAll(/typeof\s+([\w$]+)\s*!==?\s*["'][\w]+["']/g)) {
      const key = locals.get(km[1])
      if (key !== undefined) required.add(key)
    }
    return allowed.size > 0 ? { keys: allowed, required } : undefined
  }
  const braceStart = text.indexOf('{', m.index + m[0].length - 1)
  if (braceStart === -1) return undefined
  let depth = 0
  let end = -1
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return undefined
  const body = text.slice(braceStart + 1, end)
  const keys = new Set()
  const required = new Set()
  let inner = 0
  for (const line of body.split('\n')) {
    if (inner === 0) {
      const km = /^([A-Za-z_$][\w$]*)\s*:/.exec(line.trim())
      if (km !== null) {
        keys.add(km[1])
        if (/\.required\(\)/.test(line)) required.add(km[1])
      }
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') inner++
      else if (ch === '}' || ch === ')' || ch === ']') inner--
    }
  }
  return keys.size > 0 ? { keys, required } : undefined
}

// ── 读 YAML ─────────────────────────────────────────────────────────────────
const require = createRequire(path.join(PROFILE_MODULES, 'package.json'))
let yaml
try {
  yaml = require('js-yaml')
} catch {
  console.error('profile 里找不到 js-yaml，无法解析 YAML')
  process.exit(2)
}
const JsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => `<js:${d}>` })
const schema = yaml.DEFAULT_SCHEMA.extend([JsTag])

const SOURCE = path.join(PRESET_DIR, 'cordis.patch.yml')
if (!existsSync(SOURCE)) {
  console.error(`找不到 ${SOURCE}`)
  process.exit(2)
}
let doc
try {
  doc = yaml.load(readFileSync(SOURCE, 'utf8'), { schema })
  notes.push('YAML 解析通过')
} catch (error) {
  console.error(`YAML 解析失败: ${error.message}`)
  process.exit(1)
}

// ── 1. 声明行 ───────────────────────────────────────────────────────────────
const ROW = doc?.[0]?.insert?.[0]
if (ROW === undefined) fail('顶层不是 [ { insert: [ {...} ] } ] 结构，找不到预设声明行')
const preset = ROW?.config
if (preset === undefined) fail('声明行缺少 config')

for (const key of ['id', 'plugins']) {
  if (preset?.[key] === undefined) fail(`预设 config 缺少必填字段 ${key}`)
}
// shipped 预设同名会赢，自定义静默失效。
const SHIPPED_IDS = new Set(['standard', 'minimal', 'ptc', 'cordis'])
if (SHIPPED_IDS.has(preset?.id)) fail(`config.id "${preset?.id}" 与内置预设撞名，自定义会被静默忽略`)
if (ROW?.name !== '@deepseek-ai/dsh-agent-preset') fail(`声明行 name 应为 '@deepseek-ai/dsh-agent-preset'，实际 ${ROW?.name}`)
if (preset !== undefined && !Array.isArray(preset.plugins)) fail('config.plugins 必须是数组')

notes.push(`预设 id=${preset?.id} name=${preset?.name ?? '(未设)'} order=${preset?.order ?? '(未设)'} 顶层 ${(preset?.plugins ?? []).length} 行`)

// ── 2. 逐行检查（含 cordis:group 递归）──────────────────────────────────────
const rowIds = new Set()

function checkRow(row, prefix) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    fail(`${prefix}(非对象行): ${JSON.stringify(row)}`)
    return
  }
  const label = `${prefix}${row.id} (${row.name})`

  if (typeof row.id === 'string') {
    if (rowIds.has(row.id)) fail(`${label}: 行 id 重复（Loader 编辑地址必须全进程唯一）`)
    rowIds.add(row.id)
  } else {
    notes.push(`${label}: 未写行 id，由 Loader 分配`)
  }

  if (typeof row.name !== 'string' || row.name.length === 0) {
    fail(`${label}: name 必须是非空字符串`)
    return
  }

  if (row.name === 'cordis:group') {
    if (row.group !== true) fail(`${label}: cordis:group 行必须写 group: true`)
    if (!Array.isArray(row.config)) {
      fail(`${label}: group 行的 config 必须是行数组`)
      return
    }
    for (const child of row.config) checkRow(child, `${row.id}/`)
    return
  }

  // 本地插件（本预设按设计不该出现，出现则没有 schema 可对，只能记一条）
  if (row.name.startsWith('@local/') || row.name.startsWith('.') || row.name.startsWith('/')) {
    fail(`${label}: 本预设声称纯 YAML 无插件代码，不应出现本地插件行`)
    return
  }

  const { pkg, sub } = splitPackageName(row.name)
  const found = locatePackage(pkg)
  if (found === undefined) {
    fail(`${label}: asar 与 profile node_modules 里都找不到包 ${pkg}`)
    return
  }
  if (sub !== undefined && !hasSubpathExport(found.json, sub)) {
    fail(`${label}: 包 ${pkg} 的 package.json exports 里没有子路径 ./${sub}`)
    return
  }

  // disabled 若是 !!js，确认表达式被解析成我们预期的字符串
  if (row.disabled !== undefined && typeof row.disabled === 'string' && !row.disabled.startsWith('<js:')) {
    if (typeof row.disabled !== 'boolean') fail(`${label}: disabled 既不是布尔也不是 !!js 表达式`)
  }
  if (row.disabled !== undefined && typeof row.disabled === 'string' && row.disabled.startsWith('<js:')) {
    const inner = row.disabled.slice(4, -1)
    notes.push(`${label}: disabled 是 !!js 表达式 → ${inner}`)
  }

  const declared = declaredConfigSchema(found.root)
  // 注意 typeof null === 'object'：删掉最后一个键后 YAML 会给出 `config: null`，
  // 不显式排除 null 就会在 Object.keys(null) 上抛崩（负例测试踩到过）。
  const rowConfig =
    row.config !== null && row.config !== undefined && typeof row.config === 'object' && !Array.isArray(row.config)
      ? row.config
      : {}

  if (declared === undefined) {
    if (Object.keys(rowConfig).length > 0) {
      fail(`${label}: 该包没有可静态识别的 Config，却在行里给了 config ${Object.keys(rowConfig).join(', ')}（会被忽略或报错）`)
    } else {
      notes.push(`${label}: 包存在（无可静态识别的 Config，未给 config）`)
    }
    return
  }

  const unknown = Object.keys(rowConfig).filter((k) => !declared.keys.has(k))
  if (unknown.length > 0) {
    fail(`${label}: config 里有该插件不认识的键 ${unknown.join(', ')}（可用: ${[...declared.keys].join(', ')}）`)
  }
  const missing = [...declared.required].filter((k) => rowConfig[k] === undefined)
  if (missing.length > 0) {
    fail(`${label}: 缺必填 config 字段 ${missing.join(', ')}（该插件 Config 声明了 .required()）`)
  }
  if (unknown.length === 0 && missing.length === 0) {
    notes.push(`${label}: 包存在 @${found.where}，config 键名与必填项全部满足`)
  }
}

for (const row of preset?.plugins ?? []) checkRow(row, '')

// ── 3. persona 专项 ─────────────────────────────────────────────────────────
const personaRow = (preset?.plugins ?? []).find((r) => r?.id === 'persona')
if (personaRow === undefined) {
  fail('缺少 persona 行（预设就没有身份段了）')
} else {
  const pc = personaRow.config ?? {}
  if (pc.complete === true && (typeof pc.prefix !== 'string' || pc.prefix.trim() === '')) {
    fail('persona: complete: true 时 prefix 必填且非空')
  }
  if (pc.complete === true && pc.includeRuntimeContext === undefined) {
    fail('persona: 设了 complete: true 却没设 includeRuntimeContext —— 两者应成对出现')
  }
  // routing-suite P10 实测：这类词让收敛率归零，写进 prefix 是负收益。
  const BANNED = ['认真思考', '深思熟虑', '仔细分析', '深入思考', 'think carefully', 'think step by step']
  const prefix = typeof pc.prefix === 'string' ? pc.prefix : ''
  for (const w of BANNED) {
    if (prefix.toLowerCase().includes(w.toLowerCase())) fail(`persona.prefix 含被实测否定的措辞「${w}」（routing-suite P10：收敛率归零）`)
  }
  notes.push(`persona: prefix ${prefix.length} 字符 ≈ ${Math.round(prefix.length / 4.04)} tok，complete=${pc.complete} includeRuntimeContext=${pc.includeRuntimeContext}`)
}

// ── 4. 与 standard 的差集 + header 估算 ─────────────────────────────────────
// 这些字节数不是猜的：从 D:\DeepSeek-DSH\sessions 里 234 份真实 standard
// request/header 逐工具取 JSON 字节数的均值（脚本见 README「可复现」一节）。
// 换算 4.04 字符/token 来自 87 个冷首请求回归。
const STANDARD_TOOL_TOKENS = {
  pwsh: 834, workflow: 807, schedule_create: 638, subagent: 400, schedule_update: 382,
  ask_user_question: 308, subagent_fork: 282, edit: 267, update_goal: 232, todo_write: 202,
  present: 200, write: 198, plugin_manager: 191, glob: 179, grep: 167, job_output: 145,
  create_goal: 136, read: 104, read_image: 93, job_kill: 87, exit_plan_mode: 79, skill: 79,
  web_search: 77, web_fetch: 58, schedule_list: 57, schedule_delete: 49, get_goal: 40,
  job_list: 40, schedule_edit: 101, schedule_view: 13, plugin_market: 0,
}
const STANDARD_HEADER_TOOLS = 96
const STANDARD_HEADER_TOKENS = 25405 // 234 份 standard header 均值，含宿主那 74.6%

// 按「行 id」而不是包名索引：tool-subagent 这个包被 spawn 和 fork 两行共用，
// 按包名索引会把两者混为一谈（fork 被删了却算成还在，或者反过来）。
// 必须声明在 mountedTools 之前（函数里引用它，提前调用会踩 TDZ）。
const TOOL_TOOLS_BY_ROW_ID = {
  'tool-fs': ['read', 'write', 'edit', 'read_image'],
  'tool-fs-search': ['glob', 'grep'],
  'tool-pwsh': ['pwsh'],
  'tool-bash': ['bash'],
  'tool-jobs': ['job_list', 'job_output', 'job_kill'],
  'tool-skill': ['skill'],
  'tool-web': ['web_search', 'web_fetch'],
  'tool-todo': ['todo_write'],
  'tool-ask-user': ['ask_user_question'],
  present: ['present'],
  'tool-schedule': ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view', 'schedule_delete', 'schedule_update'],
  'tool-goal': ['create_goal', 'get_goal', 'update_goal'],
  'plan-mode': ['exit_plan_mode'],
  'tool-workflow': ['workflow'],
  'tool-subagent': ['subagent'],
  'tool-subagent-fork': ['subagent_fork'],
  'tool-subagent-control': ['list_agents', 'send_message', 'interrupt_agent'],
  'tool-plugin-manager': ['plugin_manager'],
  'tool-plugin-market': ['plugin_market'],
}

// 一行是否「在 Windows 上真的挂出工具」。
// 坑：tool-bash / tool-pwsh 用 !!js 按平台禁用，被解析成 '<js:...>' 字符串。
// 把禁用行当「存在」会漏算，当「不存在」又会把 pwsh 误算成已删 ——
// 这里按表达式里的平台条件判，而不是按有没有 disabled 判。
function rowIsActive(row) {
  const d = row?.disabled
  if (d === true) return false
  if (typeof d !== 'string') return true
  const expr = d.startsWith('<js:') && d.endsWith('>') ? d.slice(4, -1) : d
  if (expr.includes("process.platform === 'win32'")) return false // win32 上关闭
  if (expr.includes("process.platform !== 'win32'")) return true // win32 上开启
  // 其余条件（如 profileContext）本机为真，按启用算
  return true
}

/** 收集本预设「在 win32 上真的会挂出」的工具名。 */
function mountedTools(rows, acc = []) {
  for (const row of rows ?? []) {
    if (row === null || typeof row !== 'object') continue
    if (row.name === 'cordis:group') {
      mountedTools(row.config, acc)
      continue
    }
    if (!rowIsActive(row)) continue
    const tools = TOOL_TOOLS_BY_ROW_ID[row.id]
    if (tools !== undefined) acc.push(...tools)
  }
  return acc
}

// 每工具在 234 份 standard header 里的「出现率」。
// 不能假设删除的工具在每份 header 里都出现：schedule_* 各工具出现率差异很大
// （create 93% / update 65% / edit 28%），按 1 算会高估减少的工具数。
const STANDARD_TOOL_PRESENCE = {
  pwsh: 0.97, workflow: 0.96, schedule_create: 0.93, subagent: 0.96, schedule_update: 0.65,
  ask_user_question: 0.96, subagent_fork: 0.96, edit: 0.96, update_goal: 0.96, todo_write: 0.96,
  present: 0.96, write: 0.96, plugin_manager: 0.29, glob: 0.96, grep: 0.96, job_output: 0.96,
  create_goal: 0.96, read: 0.96, read_image: 0.97, job_kill: 0.96, exit_plan_mode: 0.68, skill: 0.96,
  web_search: 0.97, web_fetch: 0.97, schedule_list: 0.93, schedule_delete: 0.65, get_goal: 0.96,
  job_list: 0.96, schedule_edit: 0.28, schedule_view: 0.28, plugin_market: 0,
}

const mounted = new Set(mountedTools(preset?.plugins))
const trulyDropped = Object.entries(STANDARD_TOOL_TOKENS).filter(([tool]) => !mounted.has(tool))
const droppedTokens = trulyDropped.reduce((a, [, v]) => a + v, 0)
const droppedCount = trulyDropped.reduce((a, [t]) => a + (STANDARD_TOOL_PRESENCE[t] ?? 1), 0)

notes.push(`在 win32 上挂出的 standard 工具：${[...mounted].sort().join(' ')}`)
notes.push(
  `工具面：standard 实测 ${STANDARD_HEADER_TOOLS} 个工具 / ≈${STANDARD_HEADER_TOKENS} tok；` +
    `本预设删掉 ${trulyDropped.length} 个工具名，按出现率折合每份 header 实际少 ${droppedCount.toFixed(2)} 个 ` +
    `≈${droppedTokens} tok [${trulyDropped.map(([t]) => t).join(' ')}]`,
)
notes.push(
  `header 估算：≈${(STANDARD_HEADER_TOOLS - droppedCount).toFixed(1)} 个工具 / ≈${STANDARD_HEADER_TOKENS - droppedTokens} tok` +
    `（宿主平面那 74.6% 预设碰不到，这部分不变）`,
)

// ── 报告 ────────────────────────────────────────────────────────────────────
closeSync(fd)
console.log('===== preset-lean 静态自检 =====')
console.log(`目录: ${PRESET_DIR}`)
console.log('')
for (const n of notes) console.log('  ok    ' + n)
if (failures.length > 0) {
  console.log('')
  for (const f of failures) console.log('  FAIL  ' + f)
  console.log(`\n结果: ${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n结果: 全部通过（静态检查，未验证运行时行为）')
