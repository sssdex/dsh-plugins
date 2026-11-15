/**
 * 边界与健壮性测试：构造最小 asar，覆盖非法 offset / 路径穿越 / BOM 等。
 * 这些是主链路测不到的防御分支，单列一份。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-edge-'))

/**
 * 按真实 asar 布局造一个归档（实测字节推导，别凭记忆改）：
 *
 *   N = jsonSize
 *   padding = (4 - N % 4) % 4
 *   offset 0  = 4                      pickle 前缀
 *   offset 4  = headerPickleSize = 8 + N + padding
 *   offset 8  = 4 + N + padding        pickle payload 长度
 *   offset 12 = N                      JSON 字节长度
 *   offset 16          JSON 正文
 *   数据区    = 8 + headerPickleSize
 *
 * 实测对照（真实 app.asar，N=5669961、padding=3）：
 *   offset4=5669972=8+N+3 ✓  offset8=5669968=4+N+3 ✓
 */
function buildAsar(files, contents) {
  const tree = { files }
  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  const N = json.length
  const padding = (4 - (N % 4)) % 4
  const headerPickleSize = 8 + N + padding
  const out = Buffer.alloc(8 + headerPickleSize)
  out.writeUInt32LE(4, 0)
  out.writeUInt32LE(headerPickleSize, 4)
  out.writeUInt32LE(4 + N + padding, 8)
  out.writeUInt32LE(N, 12)
  json.copy(out, 16)
  return Buffer.concat([out, ...contents])
}

const reg = new Map()
const ctx = { tools: { register(d) { reg.set(d.name, d); return () => {} } } }
const mod = await import('../index.js')

const run = (def, args) => def.execute(args, { signal: { throwIfAborted() {} } })
let checks = 0
const ok = (l) => { checks++; console.log('ok   ' + l) }

// --- 用例 1：负 offset 必须被拒绝，而不是静默降级 ---
{
  const body = Buffer.from('hello world')
  const asar = buildAsar(
    { 'a.txt': { size: body.length, offset: '-5' } },
    [body],
  )
  const p = path.join(tmp, 'neg.asar')
  fs.writeFileSync(p, asar)
  mod.apply(ctx, { asarPath: p })
  const list = reg.get('asar_list')
  const r = await run(list, { limit: 10 })
  assert.equal(r.entries[0].kind, 'invalid', '负 offset 归类为 invalid')
  ok('负 offset 被拒绝（不降级成 unpacked）')
}

// --- 用例 2：offset 是小数也拒绝 ---
{
  const body = Buffer.from('abc')
  const p = path.join(tmp, 'frac.asar')
  fs.writeFileSync(p, buildAsar({ 'b.txt': { size: body.length, offset: '1.5' } }, [body]))
  mod.apply(ctx, { asarPath: p })
  const r = await run(reg.get('asar_list'), { limit: 10 })
  assert.equal(r.entries[0].kind, 'invalid', '小数 offset 归类为 invalid')
  ok('小数 offset 被拒绝')
}

// --- 用例 2b：invalidEntries 与 readErrors 必须互斥，不能重复计数 ---
{
  const body = Buffer.from('abc')
  const p = path.join(tmp, 'invalid-count.asar')
  fs.writeFileSync(p, buildAsar({ 'x.txt': { size: body.length, offset: '-1' } }, [body]))
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: 'abc', limit: 5 })
  assert.equal(g.invalidEntries, 1, `invalid 条目应计入 invalidEntries（实际 ${g.invalidEntries}）`)
  assert.equal(g.readErrors, 0, `invalid 不该重复计入 readErrors（实际 ${g.readErrors}）`)
  assert.ok(g.errorSamples.length >= 1, 'invalid 仍应给出错误样本')
  ok('invalidEntries 与 readErrors 互斥（不重复计数）')
}

// --- 用例 3：size 越界（大于数据区）必须报错而非读出垃圾 ---
{
  const body = Buffer.from('short')
  const p = path.join(tmp, 'oom.asar')
  fs.writeFileSync(p, buildAsar({ 'c.txt': { size: 999999, offset: '0' } }, [body]))
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: 'short', limit: 5 })
  // 越界成员被计入 readErrors，而不是当成零命中
  assert.ok(g.readErrors >= 1, `越界成员应计入 readErrors（实际 ${g.readErrors}）`)
  assert.ok(g.errorSamples.length >= 1, '应给出错误样本')
  ok(`越界成员计入 readErrors 并附样本（${g.errorSamples[0]?.slice(0, 50)}…）`)
}

// --- 用例 4：正常读取（正例，确认上面的拒绝不是把正常路径也搞坏）---
{
  const body = Buffer.from('{"name": "edge-ok"}')
  const p = path.join(tmp, 'good.asar')
  fs.writeFileSync(p, buildAsar({ 'd.json': { size: body.length, offset: '0' } }, [body]))
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: 'edge-ok', limit: 5 })
  assert.equal(g.matches.length, 1, '正常归档应命中')
  assert.equal(g.matches[0].hits[0].text.trim(), '{"name": "edge-ok"}', '内容必须逐字节正确')
  ok('正常归档逐字节正确')
}

// --- 用例 5：BOM 的 UTF-16LE 文本应被识别为文本而非二进制 ---
{
  const text = 'hello utf16'
  const body = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')])
  const p = path.join(tmp, 'utf16.asar')
  fs.writeFileSync(p, buildAsar({ 'e.txt': { size: body.length, offset: '0' } }, [body]))
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: 'hello utf16', limit: 5 })
  assert.equal(g.matches.length, 1, 'UTF-16LE 带 BOM 应被当文本并命中')
  ok('UTF-16LE BOM 文本可搜（不误判为二进制）')
}

// --- 用例 6：外置成员路径穿越必须被拒 ---
{
  const p = path.join(tmp, 'trav.asar')
  const body = Buffer.from('x')
  fs.writeFileSync(p, buildAsar({ '../../etc/passwd': { size: 1, unpacked: true } }, [body]))
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: 'root', limit: 5 })
  assert.ok(g.readErrors >= 1, '穿越路径应被拒绝并计入 readErrors')
  assert.ok(g.matches.length === 0, '不得读到归档外文件')
  ok('外置路径穿越被拒绝')
}

// --- 用例 7：损坏头部必须明确报错 ---
{
  const p = path.join(tmp, 'broken.asar')
  fs.writeFileSync(p, Buffer.from('not an asar at all, just junk bytes here'))
  mod.apply(ctx, { asarPath: p })
  await assert.rejects(() => run(reg.get('asar_list'), { limit: 1 }), /asar|pickle|头部/i, '损坏归档应报错')
  ok('损坏头部明确报错')
}

// --- 用例 8：合法 link 节点（没有 size）应归为 link，不是 invalid ---
{
  const body = Buffer.from('{"x": 1}')
  const p = path.join(tmp, 'link.asar')
  fs.writeFileSync(p, buildAsar({
    'real.json': { size: body.length, offset: '0' },
    'alias.json': { link: 'real.json' }, // 合法 link 不带 size
  }, [body]))
  mod.apply(ctx, { asarPath: p })
  const r = await run(reg.get('asar_list'), { limit: 10 })
  const alias = r.entries.find((e) => e.path === 'alias.json')
  assert.ok(alias !== undefined, 'link 条目应存在')
  assert.equal(alias.kind, 'link', `合法 link 应为 link（实际 ${alias.kind}）`)
  ok('合法 link 节点归类为 link（不再误判 invalid）')
}

// --- 用例 9：link 计入 skippedLinks，不冒充 readErrors ---
{
  const body = Buffer.from('{"x": 1}')
  const p = path.join(tmp, 'link2.asar')
  fs.writeFileSync(p, buildAsar({
    'real.json': { size: body.length, offset: '0' },
    'alias.json': { link: 'real.json' },
  }, [body]))
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: 'x', limit: 5 })
  assert.equal(g.skippedLinks, 1, `link 应计入 skippedLinks（实际 ${g.skippedLinks}）`)
  assert.equal(g.readErrors, 0, 'link 不该算读取失败')
  ok('link 计入 skippedLinks 而非 readErrors')
}

// --- 用例 10：奇数长度 UTF-16 文件不能中断整次搜索，后续文件仍要命中 ---
{
  const odd = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from([0x41, 0x00, 0x42])]) // 3 字节正文
  const good = Buffer.from('{"after": "yes"}')
  const p = path.join(tmp, 'odd-utf16.asar')
  fs.writeFileSync(p, buildAsar({
    'a-odd.txt': { size: odd.length, offset: '0' },
    'b-good.json': { size: good.length, offset: String(odd.length) },
  }, [odd, good]))
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: '"after": "yes"', limit: 5 })
  assert.ok(g.readErrors >= 1, '奇数 UTF-16 应计入错误（单文件失败）')
  assert.equal(g.matches.length, 1, '后续正常文件仍必须命中（不能被坏文件毁掉）')
  ok('奇数 UTF-16 单文件失败，不中断整次搜索')
}

// --- 用例 11：UTF-8 BOM 必须剥离，命中行首干净 ---
{
  const body = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"bom": "clean"}')])
  const p = path.join(tmp, 'bom8.asar')
  fs.writeFileSync(p, buildAsar({ 'c.json': { size: body.length, offset: '0' } }, [body]))
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: '"bom": "clean"', limit: 5 })
  assert.equal(g.matches.length, 1, 'UTF-8 BOM 文件应命中')
  assert.ok(g.matches[0].hits[0].text.startsWith('{"bom"'), `片段首字符必须干净（实际 ${JSON.stringify(g.matches[0].hits[0].text.slice(0, 20))}）`)
  ok('UTF-8 BOM 被剥离')
}

// --- 用例 12：外置根用 `${asar}.unpacked`，非 app.asar 也要正确 ---
{
  const p = path.join(tmp, 'foo.asar')
  const body = Buffer.from('x')
  fs.writeFileSync(p, buildAsar({ 'f.txt': { size: 1, unpacked: true } }, [body]))
  // 造同名 unpacked 目录与文件
  const unpackedDir = `${p}.unpacked`
  fs.mkdirSync(unpackedDir, { recursive: true })
  fs.writeFileSync(path.join(unpackedDir, 'f.txt'), 'external-content')
  mod.apply(ctx, { asarPath: p })
  const g = await run(reg.get('asar_grep'), { pattern: 'external-content', limit: 5 })
  assert.equal(g.matches.length, 1, `${path.basename(p)} 的外置根应为 ${path.basename(p)}.unpacked`)
  ok('非 app.asar 归档的外置根正确（foo.asar → foo.asar.unpacked）')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${checks} 项边界测试全部通过`)
