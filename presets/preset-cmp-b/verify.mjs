/**
 * 冲刺·sprint 预设的静态自检。
 *
 * 模拟 DSH Loader 激活预设时会做的检查，不需要重启 DSH、不需要真实会话：
 *
 *   1. YAML 能否解析（含 DSH 的自定义 !!js 标量）。
 *   2. 每个插件行的 Config 要么不存在，要么是 StandardSchemaV1（带 ~standard.validate）。
 *      —— 这就是 2026-11-11 那次「reading 'validate'」崩溃的根因。
 *   3. 每个非 @local 行引用的 npm 包确实存在于打包的 asar 里，**含 cordis:group 子行递归**。
 *      —— file-fast 的校验器最初遇到 group 直接 continue，compaction 组里 3 个包
 *         从来没被校验过。这里递归。
 *   4. 行级 config 的键名真的存在于该插件的 Config 里，且它声明的 required 字段都给了。
 *      —— 「$.source missing required value」这类错就是这么漏的。
 *   5. 本预设自己挂的每一行，**真的注册了 restrict.js 里 KEEP 的那个工具名**。
 *      —— 声明了 tool-fs 但工具名拼错、或 KEEP 里写了没人注册的名字，
 *         在运行时都表现为「工具静默消失」，restrict() 因为看不见而不报错。
 *   6. KEEP 集合里每个名字，要么在实测 standard header 里出现过（有字节记录），
 *         要么在本文件的 EXPECTED_ANCESTOR_ONLY 里显式豁免。
 *      —— 这条能抓住「KEEP 里写了个根本不存在的工具名」。
 *   7. restrict.js 的幂等闸、RESERVED(run_code)、以及「不导出 Config」三条硬要求。
 *   8. 估算 header：KEEP 各工具实测字节求和 ÷ 4.04，对比 standard 现状。
 *
 * 用法：
 *   node verify.mjs                      # 校验本目录
 *   node verify.mjs D:\path\to\copy      # 校验副本（做反向测试用）
 *
 * 退出码 0 = 全绿，1 = 有失败项。
 */
import { openSync, readSync, closeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const ASAR = 'D:/Programs/DeepSeek-Harness/resources/app.asar'
const PRESET_DIR = process.argv[2] ?? 'D:/DeepSeek-Workspace/preset-cmp-b'
// js-yaml 从 profile 解析（那里有 node_modules），本目录是 link 安装、没有 node_modules。
const require = createRequire('D:/DeepSeek-DSH/profiles/desktop/package.json')

const failures = []
const notes = []
const warnz = []

// ── 打包文件清单（一次性读完 asar 头部，之后按需读 payload） ────────────────
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

/** 从 asar 里读一个文件的文本内容；不存在返回 undefined。 */
function readAsarFile(path) {
  const entry = asarEntries.get(path)
  if (entry === undefined) return undefined
  const buf = Buffer.alloc(entry.size)
  readSync(fd, buf, 0, entry.size, asarBase + Number(entry.offset))
  return buf.toString('utf8')
}

function packageIsPackaged(name) {
  return asarEntries.has(`dsh/node_modules/${name}/package.json`)
}

/**
 * 抠出插件 `const Config = z.object({...})` 的顶层键名与 required 字段。
 * 正则近似即可——目标是抓「键名拼错 / 必填漏给」，不是完整 schema 解析。
 * 抠不到返回 undefined（表示该插件没有静态可识别的 Config）。
 * @returns {{ keys: Set<string>, required: Set<string> } | undefined}
 */
function declaredConfigSchema(packageName) {
  const text = readAsarFile(`dsh/node_modules/${packageName}/lib/index.js`)
  if (text === undefined) return undefined
  const open = text.indexOf('const Config = z.object({')
  if (open === -1) return undefined
  const braceStart = text.indexOf('{', open)
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
    // 只在最外层认键名，跳过嵌套对象的键。
    if (inner === 0) {
      const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(line.trim())
      if (match) {
        keys.add(match[1])
        if (/\.required\(\)/.test(line)) required.add(match[1])
      }
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') inner++
      else if (ch === '}' || ch === ')' || ch === ']') inner--
    }
  }
  return keys.size > 0 ? { keys, required } : undefined
}

/**
 * 某个工具包里，`tools.register(defineTool({ name: "<x>" ... }))` 注册了哪些工具名。
 * 用来验证「YAML 行 → 工具名」这条链真的连上了。
 * @returns {Set<string>}
 */
function registeredToolNames(packageName) {
  const text = readAsarFile(`dsh/node_modules/${packageName}/lib/index.js`)
  if (text === undefined) return new Set()
  const names = new Set()
  for (const match of text.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)) {
    const name = match[1]
    // 只收「像工具名」的：defineTool 里的 name 前面不远必有 defineTool。
    const at = match.index ?? 0
    const before = text.slice(Math.max(0, at - 4000), at)
    if (before.includes('defineTool(')) names.add(name)
  }
  return names
}

// ── 读预设 YAML ─────────────────────────────────────────────────────────────
const yaml = require('js-yaml')
const fs = require('node:fs')
const JsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: d => `<js:${d}>`,
})
const schema = yaml.DEFAULT_SCHEMA.extend([JsTag])

let doc
try {
  const source = fs.readFileSync(`${PRESET_DIR}/cordis.patch.yml`, 'utf8')
  doc = yaml.load(source, { schema })
  notes.push('YAML 解析通过')
} catch (error) {
  failures.push(`YAML 解析失败: ${error.message}`)
}

const presetRow = doc?.[0]?.insert?.[0]
const preset = presetRow?.config
if (!preset) failures.push('找不到预设声明行（顶层应为 [{ insert: [{ id, name, config }] }]）')

// ── 1. 预设自身的 Config 字段 ───────────────────────────────────────────────
for (const key of ['id', 'plugins']) {
  if (preset?.[key] === undefined) failures.push(`预设 config 缺少必填字段 ${key}`)
}
{
  // dsh-agent-preset 的 Config 是 z.object({id, name, description, order, plugins})
  const allowed = new Set(['id', 'name', 'description', 'order', 'plugins'])
  const unknown = Object.keys(preset ?? {}).filter(k => !allowed.has(k))
  if (unknown.length > 0) failures.push(`预设 config 里有不认识的键 ${unknown.join(', ')}（可用: ${[...allowed].join(', ')}）`)
}
// config.id 不能撞 shipped 的内置预设 —— 撞了会「shipped 同名赢、自定义静默失效」。
{
  const RESERVED_IDS = new Set(['standard', 'minimal', 'ptc', 'cordis'])
  if (RESERVED_IDS.has(preset?.id)) failures.push(`config.id = "${preset?.id}" 与内置预设撞名，自定义会静默失效`)
  else notes.push(`config.id = "${preset?.id}" 未撞内置预设（standard/minimal/ptc/cordis）`)
}

// ── 2. 本地插件登记 ────────────────────────────────────────────────────────
const LOCAL = {
  '@local/dsh-preset-sprint/restrict': './restrict.js',
  '@local/dsh-preset-sprint/tune': './tune.js',
}

// 本地插件没有 Config schema，这里手写它实际读取的键。
// 改了 apply() 里读的字段，就要同步改这里，否则校验器会误报/漏报。
const LOCAL_KEYS = {
  '@local/dsh-preset-sprint/restrict': [],
  '@local/dsh-preset-sprint/tune': ['reasoningEffort'],
}

// 本预设自己挂的包 → 它应当注册出来的工具名。
// 用于交叉验证「YAML 行覆盖到的工具」是否真的存在。
const EXPECTED_TOOLS = {
  '@deepseek-ai/dsh-tool-fs': ['read', 'write', 'edit', 'read_image'],
  '@deepseek-ai/dsh-tool-fs-search': ['glob', 'grep'],
  '@deepseek-ai/dsh-tool-pwsh': ['pwsh'],
  '@deepseek-ai/dsh-tool-bash': ['bash'],
  '@deepseek-ai/dsh-tool-jobs': ['job_list', 'job_output', 'job_kill'],
  '@deepseek-ai/dsh-tool-skill': ['skill'],
  '@deepseek-ai/dsh-tool-web': ['web_search', 'web_fetch'],
  '@deepseek-ai/dsh-tool-todo': ['todo_write'],
  '@deepseek-ai/dsh-tool-ask-user': ['ask_user_question'],
  '@deepseek-ai/dsh-tool-present': ['present'],
}

// 静态识别只能看到源码里有没有 defineTool({name})，看不到「这个分支被 config 关掉了」。
// 这里登记「源里有、但本预设的 config 明确关掉」的工具，免得常驻 warn 训练出对警告的钝感。
const CONFIG_DISABLED = {
  '@deepseek-ai/dsh-tool-fs': {
    // config.applyPatch: false → apply_patch 不会被注册
    apply_patch: 'applyPatch: false（本预设 YAML 显式关掉）',
  },
}

const rowIds = new Set()
const mountedTools = new Set()   // 本预设 YAML 行覆盖到的工具名
const packagesSeen = new Set()

/**
 * 检查一行预设。递归处理 cordis:group 的嵌套子行。
 * @param row - 预设行
 * @param prefix - 所在 group 的路径前缀，用于报错定位
 */
async function checkRow(row, prefix = '') {
  if (row === null || typeof row !== 'object') {
    failures.push(`${prefix}(非对象行): ${JSON.stringify(row)}`)
    return
  }
  const label = `${prefix}${row.id} (${row.name})`

  if (row.id === undefined) failures.push(`${prefix}(缺 id 行): name=${row.name}`)
  if (rowIds.has(row.id)) failures.push(`${prefix}行 id 重复: ${row.id}`)
  rowIds.add(row.id)

  if (row.name === 'cordis:group') {
    if (row.group !== true) failures.push(`${label}: cordis:group 行必须有 group: true`)
    if (!Array.isArray(row.config)) {
      failures.push(`${label}: group 行的 config 必须是数组`)
      return
    }
    // group 的 config 是嵌套子行列表。file-fast 的校验器曾在这里直接 continue，
    // 导致 compaction 组里的 3 个插件包从未被校验过 —— 漏检。
    notes.push(`${label}: group 行，递归校验 ${row.config.length} 个子行`)
    for (const child of row.config) await checkRow(child, `${row.id}/`)
    return
  }

  if (LOCAL[row.name]) {
    let mod
    try {
      mod = await import(pathToFileURL(`${PRESET_DIR}/${LOCAL[row.name].slice(2)}`).href)
    } catch (error) {
      failures.push(`${label}: 模块导入失败 ${error.message}`)
      return
    }
    if (typeof mod.apply !== 'function') failures.push(`${label}: 没有导出 apply(ctx, config)`)

    // 关键：Config 必须是 StandardSchemaV1，否则 Loader 调 .validate 就崩。
    if (mod.Config !== undefined) {
      const std = mod.Config?.['~standard']
      if (!std || typeof std.validate !== 'function') {
        failures.push(`${label}: 导出了 Config 但不是 StandardSchemaV1（缺 ~standard.validate）——这正是崩溃原因`)
      } else {
        notes.push(`${label}: Config 是合法 StandardSchemaV1`)
      }
    } else {
      notes.push(`${label}: 未导出 Config（取值校验改在 apply 内，安全）`)
    }

    if (Array.isArray(mod.inject)) notes.push(`${label}: inject = [${mod.inject.join(', ')}]`)
    else failures.push(`${label}: 没有导出 inject 数组`)

    // 本地插件没有 schema 可对，但键名仍然要对得上 apply() 里实际读的字段，
    // 否则写错一个键就会静默失效（不报错，只是永远走默认分支）。
    const accepted = LOCAL_KEYS[row.name]
    if (accepted !== undefined && row.config && typeof row.config === 'object') {
      const unknownLocal = Object.keys(row.config).filter(key => !accepted.includes(key))
      if (unknownLocal.length > 0) {
        failures.push(
          `${label}: config 里有该插件不读取的键 ${unknownLocal.join(', ')}（可用键: ${accepted.join(', ') || '(无)'}）`,
        )
      } else {
        notes.push(`${label}: config 键名全部被 apply() 读取`)
      }
    }
    return
  }

  if (!packageIsPackaged(row.name)) {
    failures.push(`${label}: 打包的 asar 里找不到这个包`)
    return
  }
  packagesSeen.add(row.name)

  // 行级 config 的键名必须真的存在于该插件的 Config 里，且必填字段必须被提供。
  const decl = declaredConfigSchema(row.name)
  if (decl !== undefined) {
    const rowConfig =
      row.config !== undefined && typeof row.config === 'object' && !Array.isArray(row.config)
        ? row.config
        : {}

    const unknown = Object.keys(rowConfig).filter(key => !decl.keys.has(key))
    if (unknown.length > 0) {
      failures.push(
        `${label}: config 里有该插件不认识的键 ${unknown.join(', ')}（可用键: ${[...decl.keys].join(', ')}）`,
      )
    }

    const missing = [...decl.required].filter(key => rowConfig[key] === undefined)
    if (missing.length > 0) {
      failures.push(
        `${label}: 缺必填 config 字段 ${missing.join(', ')}（该插件的 Config 声明了 required）`,
      )
    }

    if (unknown.length === 0 && missing.length === 0) {
      notes.push(`${label}: config 键名与必填项全部满足`)
    }
  } else {
    notes.push(`${label}: 已确认包存在（该包无可静态识别的 Config）`)
  }

  // 「YAML 行 → 工具名」这条链：包里真的注册了 EXPECTED_TOOLS 里的名字吗？
  const expected = EXPECTED_TOOLS[row.name]
  if (expected !== undefined) {
    const actual = registeredToolNames(row.name)
    if (actual.size === 0) {
      warnz.push(`${label}: 无法从包里静态识别工具名（跳过差集校验）`)
    } else {
      const missed = expected.filter(t => !actual.has(t))
      if (missed.length > 0) {
        failures.push(`${label}: 包里没有注册 ${missed.join(', ')}（实际注册: ${[...actual].join(', ')}）`)
      } else {
        notes.push(`${label}: 注册了 ${expected.join(' / ')} ✓`)
        for (const t of expected) mountedTools.add(t)
      }
    }
    // 该包是否还注册了 EXPECTED_TOOLS 之外的工具（会白占 schema）。
    const extra = [...actual].filter(t => !expected.includes(t))
    const declaredOff = CONFIG_DISABLED[row.name] ?? {}
    const reallyExtra = extra.filter(t => !(t in declaredOff))
    for (const t of extra) {
      if (t in declaredOff) notes.push(`${label}: ${t} 静态可见但已被 config 关掉（${declaredOff[t]}）`)
    }
    if (reallyExtra.length > 0) {
      warnz.push(`${label}: 该包还注册了 ${reallyExtra.join(', ')} —— 未列入 EXPECTED_TOOLS，确认是不是想要的`)
    }
  }
}

// 逐行检查（递归进入 cordis:group）
for (const row of preset?.plugins ?? []) await checkRow(row, '')

if (!rowIds.has('persona')) failures.push('缺少 persona 行')
if (!rowIds.has('sprint-restrict')) failures.push('缺少工具收窄器行（sprint-restrict）')

// ── 3. 祖先层提供、但不在本预设 YAML 里的工具 ──────────────────────────────
// 这些名字由 profile / dsh-base bundle 全局挂载，本预设靠 restrict 的 KEEP 放行。
// 每条都要写清来源，否则「KEEP 里写了个不存在的名字」查不出来。
const EXPECTED_ANCESTOR_ONLY = {
  bash: '本预设自己声明了 tool-bash 行，但在 win32 上 disabled → 不进 header。只为 linux/mac 保留。',
  working_directory: 'dsh-base bundle 全局挂（dsh-base/cordis.patch.yml:169 tool-working-directory）',
  read_pdf: 'dsh-pdf-mineru 插件全局挂（profile bundles）',
  async_parse_pdf: 'dsh-pdf-mineru 插件全局挂（profile bundles）',
  convert_to_markdown: 'dsh-markdownize 插件全局挂（profile bundles）',
  load_workspace_dependencies: 'desktop-office 在 profile 层挂 tool-workspace-dependencies',
  open_local_file: 'dsh-file-launcher 插件全局挂（profile bundles）',
}

// ── 4. 解析 restrict.js 的 KEEP 集合 ──────────────────────────────────────
const restrictText = fs.readFileSync(`${PRESET_DIR}/restrict.js`, 'utf8')
const keepMatch = /const KEEP = new Set\(\[([\s\S]*?)\]\)/.exec(restrictText)
let keep = []
if (!keepMatch) {
  failures.push('restrict.js 里找不到 `const KEEP = new Set([...])`')
} else {
  keep = [...keepMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  if (keep.length === 0) failures.push('restrict.js 的 KEEP 集合是空的')
  else notes.push(`restrict.js KEEP = ${keep.length} 个工具`)
  const dup = keep.filter((n, i) => keep.indexOf(n) !== i)
  if (dup.length > 0) failures.push(`restrict.js KEEP 里有重复项 ${[...new Set(dup)].join(', ')}`)
}

// KEEP 里的名字必须真的会存在：本预设挂的 ∪ 祖先层提供的。
const available = new Set([...mountedTools, ...Object.keys(EXPECTED_ANCESTOR_ONLY)])
const phantom = keep.filter(n => !available.has(n) && !Object.keys(EXPECTED_TOOLS).length)
{
  // 只有当 EXPECTED_TOOLS 全部静态识别成功时，差集才有意义。
  const mountedOk = mountedTools.size > 0
  const reallyPhantom = keep.filter(n => !mountedTools.has(n) && !(n in EXPECTED_ANCESTOR_ONLY))
  if (mountedOk && reallyPhantom.length > 0) {
    failures.push(
      `restrict.js KEEP 里有没人注册的工具名: ${reallyPhantom.join(', ')}（既不在 YAML 行的包里，也不在 EXPECTED_ANCESTOR_ONLY）`,
    )
  } else if (mountedOk) {
    notes.push('restrict.js KEEP 里每个名字都有归属（YAML 行或祖先层）')
  }
  void phantom; void available
}

// 三条硬要求（2026-11-11 事故防回归）
{
  const must = [
    [/let\s+applying\s*=\s*false/, '幂等闸 1：`let applying = false`'],
    [/let\s+lastDenyKey\s*=\s*''/, '幂等闸 2：`let lastDenyKey = \'\'`'],
    [/ctx\.on\(\s*'tools\/change'/, '在 tools/change 上重跑'],
    [/RESERVED\s*=\s*new Set\(\[\s*'run_code'\s*\]\)/, "RESERVED 里剔除 'run_code'（PTC 保留名，restrict 点名会 throw）"],
    [/ctx\.tools\.restrict\(\{\s*deny\s*\}\)/, '用 deny 而不是 allow'],
  ]
  for (const [re, label] of must) {
    if (re.test(restrictText)) notes.push(`restrict.js: ${label} ✓`)
    else failures.push(`restrict.js: 缺少 ${label}`)
  }
  if (/export\s+const\s+Config/.test(restrictText)) {
    failures.push('restrict.js 导出了 Config —— 本包 import 不到 schemastery，会崩（勿导出）')
  }
}

// tune.js 的坑（resolveModel 不存在）
//
// 注意：这里必须先把注释剥掉再查。tune.js 的注释里**故意**写了解释
// 「正确的是 resolveModelInfo，写成 resolveModel 会静默失效」，
// 直接在原文上匹配会被自己的说明文字骗过去（反向测试第 11 例就是这么漏的）。
{
  const tunePath = `${PRESET_DIR}/tune.js`
  if (fs.existsSync(tunePath)) {
    const code = fs.readFileSync(tunePath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
      .replace(/^\s*\/\/.*$/gm, '')       // 整行行注释
    if (/\.resolveModel\s*\(/.test(code) && !/\.resolveModelInfo\s*\(/.test(code)) {
      failures.push('tune.js 用了 resolveModel( ) —— 该方法在 llm 服务上不存在，正确名是 resolveModelInfo')
    } else if (/\.resolveModelInfo\s*\(/.test(code)) {
      notes.push('tune.js: 用的是 resolveModelInfo ✓')
    } else {
      warnz.push('tune.js: 既没找到 resolveModelInfo，也没找到 resolveModel —— 它到底怎么查的能力？')
    }
    if (/export\s+const\s+Config/.test(code)) {
      failures.push('tune.js 导出了 Config —— 本包 import 不到 schemastery，会崩（勿导出）')
    }
    if (/export\s+const\s+inject\s*=\s*\[\s*'llm'\s*\]/.test(code)) notes.push("tune.js: inject = ['llm'] ✓")
    else failures.push("tune.js: inject 应包含 'llm'")
  }
}

// ── 5. 别声明 workspace-dependencies（source 必填绝对路径，profile 已挂） ──
{
  const flat = JSON.stringify(preset?.plugins ?? [])
  if (flat.includes('dsh-tool-workspace-dependencies')) {
    failures.push('预设里声明了 dsh-tool-workspace-dependencies —— source 是必填绝对路径，profile 已挂，重复声明会报 $.source missing required value')
  } else {
    notes.push('没有重复声明 tool-workspace-dependencies ✓')
  }
}

// ── 6. persona 的两条关键配置 ─────────────────────────────────────────────
{
  const persona = (preset?.plugins ?? []).find(r => r?.id === 'persona')
  const cfg = persona?.config ?? {}
  if (cfg.complete !== true) failures.push('persona 未设 complete: true（否则 DSH 自带提示段会与 persona 冲突/叠加）')
  else notes.push('persona: complete = true ✓')
  if (cfg.includeRuntimeContext !== false) failures.push('persona 未设 includeRuntimeContext: false')
  else notes.push('persona: includeRuntimeContext = false ✓')
  if (typeof cfg.prefix !== 'string' || cfg.prefix.trim().length < 200) {
    failures.push('persona.prefix 太短（complete: true 下它是唯一的系统提示，必须写全动作纪律）')
  } else {
    notes.push(`persona.prefix 长度 ${cfg.prefix.length} 字符`)
  }
  // 绝对不能出现「认真思考」类词（routing-suite P10：收敛率归零）
  const BANNED = ['认真思考', '深思熟虑', '仔细分析', '深入思考']
  const hit = BANNED.filter(w => (cfg.prefix ?? '').includes(w))
  if (hit.length > 0) failures.push(`persona 里出现禁用词 ${hit.join('/')} —— routing-suite P10 实测这类词让收敛率归零`)
  else notes.push('persona: 无「认真思考/深思熟虑/仔细分析/深入思考」类禁用词 ✓')
}

// ── 7. .js 语法（node --check） ───────────────────────────────────────────
for (const file of ['restrict.js', 'tune.js']) {
  const path = `${PRESET_DIR}/${file}`
  if (!fs.existsSync(path)) {
    if (file === 'tune.js') warnz.push('tune.js 不存在（可选文件）')
    else failures.push(`${file} 不存在`)
    continue
  }
  try {
    // ESM 文件用 --input-type 检查；node --check 对 .js 在 type=module 包里也支持。
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
    notes.push(`${file}: node --check 通过`)
  } catch (error) {
    failures.push(`${file}: node --check 失败 ${String(error.stderr ?? error.message).trim().split('\n')[0]}`)
  }
}

// ── 8. header 估算 ────────────────────────────────────────────────────────
{
  // 字节来源：_evidence/_header_budget.json（由 _evidence/_header_budget.mjs 从
  // 233 个真实 standard request/header 逐工具求均值生成）。找不到就退到 _evidence/，
  // 再找不到就跳过估算（不阻断校验）。
  const candidates = [
    `${PRESET_DIR}/_header_budget.json`,
    `${PRESET_DIR}/_evidence/_header_budget.json`,
  ]
  let budget
  for (const path of candidates) {
    try {
      budget = JSON.parse(fs.readFileSync(path, 'utf8'))
      notes.push(`header 字节来源: ${path}`)
      break
    } catch {
      // 试下一个
    }
  }
  if (budget === undefined) {
    warnz.push('_header_budget.json 不存在，跳过 header 估算')
  } else {
    const bytes = budget.perHeaderBytes
    // 这些名字在 standard header 里不存在，用同源测量值补（都是自己挂的工具行）
    const OVERRIDE = {
      bash: 0,
      working_directory: bytes.working_directory ?? 205,
    }
    let keepBytes = 0
    const missing = []
    for (const name of keep) {
      const b = bytes[name] ?? OVERRIDE[name]
      if (b === undefined) { missing.push(name); continue }
      keepBytes += b
    }
    // preset 作用域 restrict() **挡不掉**的工具：agent-team 插件往 agent 自己的
    // agent.ctx 注册的那 9 个。file-fast 实测它们在自己的 deny 之后仍留在 header 里。
    // 这里必须计入，否则估出来的 header 比实际乐观 1,188 tok。
    const EXEMPT_BYTES = 4799
    const EXEMPT_LIST = [
      'interrupt_agent', 'list_agents', 'send_message', 'spawn_teammate',
      'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'wait_agent',
    ]
    const base = budget.sumPerToolAverageBytes
    const num = (x) => Math.round(x).toLocaleString('en-US')
    notes.push(
      `header 估算 A：KEEP ${keep.length} 个 = ${num(keepBytes)} B ≈ ${num(keepBytes / 4.04)} tok`
      + `；standard 基线 = ${num(base)} B ≈ ${num(base / 4.04)} tok`,
    )
    notes.push(
      `header 估算 B（现实值）：KEEP + 挡不掉的 ${EXEMPT_LIST.length} 个 agent-scope 工具`
      + ` = ${num(keepBytes + EXEMPT_BYTES)} B ≈ ${num((keepBytes + EXEMPT_BYTES) / 4.04)} tok，`
      + `${keep.filter(n => n !== 'bash').length + EXEMPT_LIST.length} 个工具`,
    )
    notes.push(
      `省下 ${num(base - keepBytes - EXEMPT_BYTES)} B ≈ ${num((base - keepBytes - EXEMPT_BYTES) / 4.04)} tok `
      + `（${(((base - keepBytes - EXEMPT_BYTES) / base) * 100).toFixed(1)}%）`,
    )
    if (missing.length > 0) warnz.push(`header 估算里没有字节记录的名字: ${missing.join(', ')}`)
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
closeSync(fd)
console.log('===== sprint 预设静态校验 =====')
console.log(`目录: ${PRESET_DIR}`)
console.log(`预设: ${preset?.id} / ${preset?.name}  order=${preset?.order}  (${(preset?.plugins ?? []).length} 顶层行)`)
console.log(`YAML 行覆盖工具 ${mountedTools.size} 个；restrict KEEP ${keep.length} 个`)
console.log('')
for (const note of notes) console.log('  ok   ' + note)
if (warnz.length > 0) {
  console.log('')
  for (const w of warnz) console.log('  warn ' + w)
}
if (failures.length === 0) {
  console.log('\n结果: 全部通过（' + notes.length + ' 项 ok，' + warnz.length + ' 项 warn）')
  process.exit(0)
}
console.log('')
for (const failure of failures) console.log('  FAIL ' + failure)
console.log(`\n结果: ${failures.length} 项失败`)
process.exit(1)
