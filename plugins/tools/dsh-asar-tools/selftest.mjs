/**
 * 自测：直接打真实 app.asar，验证列表 / 搜索 / 外置成员 / 边界行为。
 * 不依赖宿主，纯 Node 可跑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ASAR = process.env.DSH_ASAR ?? 'D:/Programs/DeepSeek-Harness/resources/app.asar'

if (!fs.existsSync(ASAR)) {
  console.log(`SKIP: 归档不存在 ${ASAR}`)
  process.exit(0)
}

// ---- 被测逻辑（与 index.js 同源实现，这里直接引 index.js 的内部函数不可行，
// 因为它们没有导出；改为通过 apply() 捕获注册的 tool 定义来测，等价于宿主路径。）
const registrations = new Map()
const fakeCtx = {
  tools: {
    register(def) {
      registrations.set(def.name, def)
      return () => { registrations.delete(def.name) }
    },
  },
}

const mod = await import('./index.js')
mod.apply(fakeCtx, { asarPath: ASAR })

const list = registrations.get('asar_list')
const grep = registrations.get('asar_grep')
assert.ok(list !== undefined, '注册了 asar_list')
assert.ok(grep !== undefined, '注册了 asar_grep')

const run = (def, args) => def.execute(args, { signal: { throwIfAborted() {} } })
let checks = 0
const ok = (label) => { checks++; console.log('ok   ' + label) }

// 1) 列出全部：条目数应接近 21717
const all = await run(list, { limit: 100 })
assert.ok(all.total > 20000, `归档条目数异常：${all.total}`)
assert.equal(all.entries.length, 100, 'limit 生效')
assert.ok(all.truncated, '超过 limit 时标记 truncated')
ok(`列出全量（total=${all.total}）`)

// 2) 按名字过滤：能定位 dsh-tools
const byName = await run(list, { pattern: 'dsh-tools/package.json', limit: 10 })
assert.equal(byName.matched, 1, `应恰好命中 1 条，实际 ${byName.matched}`)
assert.equal(byName.entries[0].path, 'dsh/node_modules/@deepseek-ai/dsh-tools/package.json')
assert.equal(byName.entries[0].kind, 'packed', '归档内成员 kind=packed')
ok('按路径过滤命中 dsh-tools/package.json')

// 3) 通配符过滤：片段不锚定开头也能命中（模型常写中间片段）
const wild = await run(list, { pattern: 'dsh-agent/lib/*.js', limit: 20 })
assert.ok(wild.matched >= 1, '通配符应命中 dsh-agent/lib/*.js')
assert.ok(wild.entries.every((e) => /\/dsh-agent\/lib\/[^/]+\.js$/.test(e.path)),
  '通配符结果都符合模式')
ok(`通配符过滤（命中 ${wild.matched}）`)

// 4) 外置成员必须标记 kind=unpacked
const unpacked = await run(list, { pattern: 'libreoffice-kit-win32-x64/licenses/DeepSeek-Harness-MIT.txt', limit: 5 })
assert.equal(unpacked.matched, 1, '外置成员可被列出')
assert.equal(unpacked.entries[0].kind, 'unpacked', '外置成员 kind=unpacked')
ok('外置成员标记正确')

// 5) 内容搜索：命中 dsh-tools 的 version 字段
const g1 = await run(grep, { pattern: '"version": "0.2.2-rc.3"', include: 'dsh-tools/package.json', limit: 5 })
assert.ok(g1.matches.length >= 1, 'asar_grep 应能在归档内找到 version')
assert.ok(g1.matches[0].hits.some((h) => h.text.includes('0.2.2-rc.3')), '命中行内容正确')
ok(`内容搜索命中（scanned=${g1.scanned}, skippedBinary=${g1.skippedBinary}）`)

// 5b) **关键回归**：数据区起点必须精确，否则成员内容前面会混入头部残留。
//     用文件首个字符校验：package.json 的第一个字符必须是 '{'，
//     早期版本 dataStart 少算 11 字节，读到的是 "\"]}}}}}}\0\0\0{" 这类残留。
const head1 = await run(grep, { pattern: '"name": "@deepseek-ai/dsh-tools"', include: 'dsh-tools/package.json', limit: 1 })
assert.equal(head1.matches.length, 1, '应命中 name 字段')
const nameLine = head1.matches[0].hits.find((h) => h.text.includes('"name"'))
assert.ok(nameLine.text.trimStart().startsWith('"name"'), `行首必须干净（实际 ${JSON.stringify(nameLine.text.slice(0, 40))}）`)
ok('数据区起点精确（行首无头部残留）')

// 6) 字面量语义：含正则元字符不应被当正则
const g2 = await run(grep, { pattern: '"version": "0.2.2-rc.3"', include: 'dsh-tools/package.json', limit: 1 })
const g3 = await run(grep, { pattern: '"version": "0.2.2.rc.3"', include: 'dsh-tools/package.json', limit: 1 })
assert.equal(g3.matches.length, 0, '把 . 当字面量：换成 rc 之外的字符应不命中')
ok('入参按字面量处理，不被当正则')

// 7) 大小写不敏感（默认）
const g4 = await run(grep, { pattern: 'DEEPSEEK-AI', include: 'dsh-tools/package.json', limit: 3 })
assert.ok(g4.matches.length >= 1, '默认大小写不敏感')
const g5 = await run(grep, { pattern: 'DEEPSEEK-AI', include: 'dsh-tools/package.json', caseSensitive: true, limit: 3 })
assert.equal(g5.matches.length, 0, 'caseSensitive=true 时不匹配不同大小写')
ok('caseSensitive 生效')

// 8) 二进制跳过：搜 LibreOffice 那棵二进制树不该崩
const g6 = await run(grep, { pattern: 'DeepSeek', include: 'libreoffice-kit-win32-x64/*', limit: 3 })
assert.ok(Array.isArray(g6.matches), '二进制目录搜索不崩')
ok(`二进制被跳过（skippedBinary=${g6.skippedBinary}）`)

// 8b) 但同一棵树里的**小文本**必须能搜到（回归：排除表一刀切曾把许可证文本也排除）
const g7 = await run(grep, {
  pattern: 'Browser presentation',
  include: 'libreoffice-kit-win32-x64/licenses/DeepSeek-Harness-MIT.txt',
  limit: 3,
})
assert.ok(g7.matches.length >= 1, '外置小文本应能搜到内容（排除表不该一刀切）')
assert.ok(g7.matches[0].hits[0].text.includes('Browser presentation'), '外置文本内容正确')
ok('外置小文本可搜（回归项）')

// 8c) 真实 DSH 源码内容能搜到（这是本插件存在的意义：
//     dsh-advisors 是工作区里自己写的插件，不在 asar 内，不能用来测；
//     这里搜宿主自身 dsh-tools 实现里的真实符号）
const g8 = await run(grep, { pattern: 'ToolActivationError', include: 'dsh-tools/lib', limit: 5 })
assert.ok(g8.matches.length >= 1, '应能搜到宿主 dsh-tools 实现里的真实符号')
assert.ok(g8.matches.some((m) => /dsh-tools\/lib\/.+\.js$/.test(m.path)), '命中的是 dsh-tools 的 js')
ok(`搜到宿主真实源码符号（${g8.matches.length} 个文件）`)

// 8d) **大文件回归**：desktop-runtime.json 有 4.7 MB，是 DSH 的运行时清单
//     （插件/模型/预设都在里面），属于最需要搜的目标之一。
//     早期把它按「2 MB 以上算打包产物」跳过，等于把最有价值的目标漏掉了。
const bigFile = await run(grep, { pattern: '"schemaVersion": 1', include: 'desktop-runtime.json', limit: 3 })
assert.equal(bigFile.matches.length, 1, '4.7 MB 的 desktop-runtime.json 必须可搜')
ok('大文件（4.7 MB 运行时清单）可搜（回归项）')

// 9) 空 pattern 报错
await assert.rejects(() => run(grep, { pattern: '' }), /不能为空/, '空 pattern 应报错')
ok('空 pattern 报错')

// 10) 不存在的归档报错（不是静默返回空）
await assert.rejects(
  () => run(list, { asarPath: 'D:/definitely/not/here/app.asar', limit: 1 }),
  (e) => /ENOENT|no such file/i.test(e.message + e.code),
  '不存在的归档应报错',
)
ok('不存在的归档明确报错')

// 11) render 输出可读
const rendered = list.output.render({}, byName)
assert.ok(Array.isArray(rendered) && rendered[0].type === 'text', 'render 返回文本块')
assert.ok(rendered[0].text.includes('dsh-tools/package.json'), 'render 内容含路径')
ok('render 输出可读')

// 12) output schema 与真实返回值一致（最小校验：必需字段都在）
for (const key of ['asar', 'total', 'matched', 'truncated', 'entries']) {
  assert.ok(key in byName, `返回值缺字段 ${key}`)
}
ok('返回值符合 output.schema 字段')

console.log(`\n${checks} 项全部通过`)
