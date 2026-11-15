/**
 * file-fast 预设的静态校验。
 *
 * 模拟 DSH Loader 激活预设时会做的检查，不需要重启 DSH：
 *   1. 每个插件行的 Config 要么不存在，要么是 StandardSchemaV1（带 ~standard.validate）；
 *      ——这就是 2026-11-11 那次「reading 'validate'」崩溃的根因。
 *   2. YAML 能解析（含 DSH 的自定义 !!js 标量）。
 *   3. 每个非 @local 行引用的 npm 包确实存在于打包的 asar 里。
 *   4. 行级 config 的必填字段齐全（workspace-dependencies 的 $.source 就是这么漏的）。
 */
import { openSync, readSync, closeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ASAR = 'D:/Programs/DeepSeek-Harness/resources/app.asar'
// 允许用第一个命令行参数指定别的目录，方便拿副本做反向测试。
const PRESET_DIR = process.argv[2] ?? 'D:/DeepSeek-Workspace/file-fast-preset'
const require = createRequire('D:/DeepSeek-DSH/profiles/desktop/package.json')

const failures = []
const notes = []

// ── 打包文件清单 ────────────────────────────────────────────────────────────
const fd = openSync(ASAR, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
readSync(fd, headerBuf, 0, headerSize, 16)
const asarJson = JSON.parse(headerBuf.toString('utf8'))
// 不在这里 close：后面要按需读 asar 里的插件源码，末尾统一关。

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

// ── 读预设 YAML ─────────────────────────────────────────────────────────────
const yaml = require('js-yaml')
const fs = require('node:fs')
const JsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: d => `<js:${d}>`,
})
const schema = yaml.DEFAULT_SCHEMA.extend([JsTag])

const source = fs.readFileSync(`${PRESET_DIR}/cordis.patch.yml`, 'utf8')
let doc
try {
  doc = yaml.load(source, { schema })
  notes.push('YAML 解析通过')
} catch (error) {
  failures.push(`YAML 解析失败: ${error.message}`)
}

const presetRow = doc?.[0]?.insert?.[0]
const preset = presetRow?.config
if (!preset) failures.push('找不到预设声明行')

// ── 1. 预设自身的 Config 字段 ───────────────────────────────────────────────
for (const key of ['id', 'plugins']) {
  if (preset?.[key] === undefined) failures.push(`预设 config 缺少必填字段 ${key}`)
}

// ── 2. 逐行检查 ─────────────────────────────────────────────────────────────
const LOCAL = {
  '@local/dsh-file-fast-preset/restrict': './restrict.js',
  '@local/dsh-file-fast-preset/tune': './tune.js',
}

// 本地插件没有 Config schema，这里手写它实际读取的键。
// 改了 apply() 里读的字段，就要同步改这里，否则校验器会误报/漏报。
const LOCAL_KEYS = {
  '@local/dsh-file-fast-preset/restrict': [],
  '@local/dsh-file-fast-preset/tune': ['reasoningEffort'],
}

const rowIds = new Set()

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

  if (rowIds.has(row.id)) failures.push(`${prefix}行 id 重复: ${row.id}`)
  rowIds.add(row.id)

  if (row.name === 'cordis:group') {
    if (!Array.isArray(row.config)) {
      failures.push(`${label}: group 行的 config 必须是数组`)
      return
    }
    // group 的 config 是嵌套子行列表。曾经这里直接 continue，
    // 导致 compaction 组里的 3 个插件包从未被校验过——漏检。
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

    // 本地插件没有 schema 可对，但键名仍然要对得上 apply() 里实际读的字段，
    // 否则写错一个键就会静默失效（不报错，只是永远走默认分支）。
    const accepted = LOCAL_KEYS[row.name]
    if (accepted !== undefined && row.config && typeof row.config === 'object') {
      const unknownLocal = Object.keys(row.config).filter(key => !accepted.includes(key))
      if (unknownLocal.length > 0) {
        failures.push(
          `${label}: config 里有该插件不读取的键 ${unknownLocal.join(', ')}（可用键: ${accepted.join(', ') || '(无)'}）`,
        )
      }
    }
    return
  }

  if (!packageIsPackaged(row.name)) {
    failures.push(`${label}: 打包的 asar 里找不到这个包`)
    return
  }

  // 行级 config 的键名必须真的存在于该插件的 Config 里，
  // 且该插件的必填字段必须被提供。
  // 「$.source missing required value」这类错就是必填没给上。
  const schema = declaredConfigSchema(row.name)
  if (schema !== undefined) {
    const rowConfig =
      row.config !== undefined && typeof row.config === 'object' && !Array.isArray(row.config)
        ? row.config
        : {}

    const unknown = Object.keys(rowConfig).filter(key => !schema.keys.has(key))
    if (unknown.length > 0) {
      failures.push(
        `${label}: config 里有该插件不认识的键 ${unknown.join(', ')}（可用键: ${[...schema.keys].join(', ')}）`,
      )
    }

    const missing = [...schema.required].filter(key => rowConfig[key] === undefined)
    if (missing.length > 0) {
      failures.push(
        `${label}: 缺必填 config 字段 ${missing.join(', ')}（该插件的 Config 声明了 required）`,
      )
    }

    if (unknown.length === 0 && missing.length === 0) {
      notes.push(`${label}: config 键名与必填项全部满足`)
    }
  } else {
    // 包存在，但没有可静态识别的 Config（或 lib/index.js 未打包）。
    // 记一条，避免「检查过」和「根本没检查」在输出里长得一样。
    notes.push(`${label}: 已确认包存在（该包无可静态识别的 Config）`)
  }
}

// 逐行检查（递归进入 cordis:group）
for (const row of preset?.plugins ?? []) await checkRow(row, '')

// ── 3. 未使用的/多余的行 ────────────────────────────────────────────────────
if (!rowIds.has('persona')) failures.push('缺少 persona 行')

// ── 报告 ────────────────────────────────────────────────────────────────────
closeSync(fd)
console.log('===== file-fast 预设静态校验 =====')
console.log(`预设: ${preset?.id} / ${preset?.name}  (${(preset?.plugins ?? []).length} 行)`)
console.log('')
for (const note of notes) console.log('  ok   ' + note)
if (failures.length === 0) {
  console.log('\n结果: 全部通过')
  process.exit(0)
}
console.log('')
for (const failure of failures) console.log('  FAIL ' + failure)
console.log(`\n结果: ${failures.length} 项失败`)
process.exit(1)
