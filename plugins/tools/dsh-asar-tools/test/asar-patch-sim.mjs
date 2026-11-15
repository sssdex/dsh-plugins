/**
 * 宿主 asar 补丁模拟测试。
 *
 * ## 为什么必须有这一份
 *
 * DSH 桌面版（Electron）给 `fs` 打了 asar 补丁：`.asar` 路径被解释成
 * 「归档虚拟根目录」而不是磁盘文件。表现为：
 *
 *     fs.statSync('...\app.asar').size  → 0
 *     fs.openSync('...\app.asar', 'r')  → ENOENT
 *
 * 而普通 node 里这些调用完全正常。于是 `selftest.mjs` / `test/edge.mjs`
 * **全部在普通 node 跑，测不出这类问题** —— 曾经 29 项全绿、实机一调就挂。
 *
 * 这份测试用 monkey-patch 伪造同样的宿主行为，从而在进程外验证绕过链路：
 * 只要它通过，说明「源被虚拟成目录」时仍能读到正确内容。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = 'D:/Programs/DeepSeek-Harness/resources/app.asar'

if (!fs.existsSync(SRC)) {
  console.log(`SKIP: 归档不存在 ${SRC}`)
  process.exit(0)
}

// ---- 伪造宿主 asar 补丁 ----
const realStatSync = fs.statSync.bind(fs)
const realOpenSync = fs.openSync.bind(fs)
const isAsarSelf = (p) => String(p).replace(/\\/g, '/').toLowerCase().endsWith('/app.asar')

fs.statSync = function patchedStatSync(p, ...rest) {
  if (isAsarSelf(p)) {
    return { isFile: () => false, size: 0, mtimeMs: 0, ctimeMs: 0, isDirectory: () => true }
  }
  return realStatSync(p, ...rest)
}
fs.openSync = function patchedOpenSync(p, ...rest) {
  if (isAsarSelf(p)) {
    const error = new Error(`ENOENT, not found in ${p}`)
    error.code = 'ENOENT'
    throw error
  }
  return realOpenSync(p, ...rest)
}

process.env.DSH_HOME = process.env.DSH_HOME ?? 'D:/DeepSeek-DSH'

const reg = new Map()
const ctx = { tools: { register(d) { reg.set(d.name, d); return () => {} } } }
const mod = await import('../index.js')
mod.apply(ctx, { asarPath: SRC })
const run = (d, a) => d.execute(a, { signal: { throwIfAborted() {} } })

let checks = 0
const ok = (l) => { checks++; console.log('ok   ' + l) }

// 1) 补丁生效确认：原始路径确实读不到
assert.throws(() => fs.openSync(SRC, 'r'), /ENOENT/, '伪造的补丁应让原始路径抛 ENOENT')
assert.equal(fs.statSync(SRC).size, 0, '伪造的补丁应让 stat 返回 0')
ok('宿主补丁已伪造（原始路径 stat=0 / open=ENOENT）')

// 2) asar_list 仍能工作
const list = await run(reg.get('asar_list'), { pattern: 'dsh-tools/package.json', limit: 3 })
assert.equal(list.matched, 1, `清单应能命中（实际 ${list.matched}）`)
ok(`asar_list 在补丁下可用（total=${list.total}）`)

// 3) asar_grep 仍能读到内容（这是绕过的核心证据）
const grep = await run(reg.get('asar_grep'), { pattern: 'ToolActivationError', include: 'dsh-tools/lib', limit: 3 })
assert.ok(grep.matches.length > 0, '补丁下仍应搜到内容')
ok(`asar_grep 在补丁下可用（${grep.matches.length} 文件）`)

// 4) 读到的内容必须逐字符正确（不能只是"能读"）
const hit = grep.matches[0]
assert.ok(/dsh-tools\/lib/.test(hit.path), '命中路径应属 dsh-tools/lib')
assert.ok(hit.hits[0].text.includes('ToolActivationError'), '命中行应含搜索词')
ok('补丁下内容逐字符正确')

// 5) 镜像确实被创建
const mirrorDir = `${process.env.DSH_HOME}/_asar-mirror`
assert.ok(fs.existsSync(mirrorDir), '镜像目录应存在')
const mirrors = fs.readdirSync(mirrorDir).filter((f) => f.endsWith('.bin'))
assert.ok(mirrors.length > 0, `镜像文件应存在（实际 ${mirrors.length} 个）`)
const mirrorStat = realStatSync(`${mirrorDir}/${mirrors[0]}`)
assert.ok(mirrorStat.size > 1_000_000, `镜像应是完整归档（实际 ${mirrorStat.size}）`)
ok(`镜像已建立（${mirrors[0]}, ${mirrorStat.size} 字节）`)

console.log(`\n${checks} 项宿主补丁模拟测试全部通过`)
