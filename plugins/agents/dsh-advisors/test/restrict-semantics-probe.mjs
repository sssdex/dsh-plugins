/**
 * 真机语义探针：tools.restrict({ allow: [...] }) 到底是不是执行级拦截，
 * 以及「allow 里给不存在的名字」会不会抛错。
 *
 * 为什么需要对源码断言而不是只跑替身：host-probe.mjs 用的是替身，只能证明
 * 插件「调用了」什么，证明不了 dsh-tools 的真实语义。这里直接对真实源码做断言。
 *
 * 历史教训：本文件最初写来论证 `restrict({ allow: [] })` 能「只留自身 scope
 * 的只读工具」，结论是错的——真机跑出来工具面直接变 0（会话 8e83baa6），
 * 因为 read/glob/grep 是 bundle 级插件注册在**全局层**的，不在 agent 自己的
 * scope 里，被 allow:[] 一并掐掉。现有实现因此改成精确白名单。
 */
import fs from 'node:fs'

const srcPath = 'D:/DeepSeek-Workspace/_asar/dsh-tools__src__index.ts'
const src = fs.readFileSync(srcPath, 'utf8')

const checks = [
  ['restrict() 要求 scoped ctx（全局 view 上调用会抛错）',
    /restrict\(filter: ToolRestriction\): \(\) => void \{[\s\S]{0,200}requires a scoped context/],
  ['空 filter 才报错；给了 allow 就合法（allow 为空数组也算给了）',
    /if \(allow === undefined && deny === undefined\)/],
  ['unknown 只校验 allow/deny 里列出的名字 → 白名单里写错名字会抛错，起到自校验作用',
    /\[\.\.\.allow \?\? \[\], \.\.\.deny \?\? \[\]\]\.filter\(name => !known\.has\(name\)\)/],
  ['全局继承的工具必须先过 layers.every(layer => layer.admits(name))',
    /layers\.every\(layer => layer\.admits\(name\)\)/],
  ['admits(): allow 不含该名字即拒绝',
    /filter\.allow !== undefined && !filter\.allow\.has\(name\)/],
  ['executable() 读 view(scope).visible → restrict 是执行级，不是仅藏 schema',
    /executable\(name: string[\s\S]{0,400}view\.visible\.get\(name\)/],
  ['guardDeny 之外还有 guard 一条链：checkGuards 按 agent 链求值',
    /checkGuards\(exec: ToolExecution\)[\s\S]{0,300}chainLayers\(exec\.agent\)/],
]

let ok = 0
for (const [label, re] of checks) {
  const pass = re.test(src)
  console.log(pass ? `ok   ${label}` : `FAIL ${label}`)
  if (pass) ok++
}

// 白名单名字写错时 unknown 非空 → 真实 restrict() 会抛错（我们的代码据此退回仅 guard）。
const whitelist = ['read', 'read_image', 'glob', 'grep']
const known = new Set(whitelist) // 模拟全部已知
const unknown = whitelist.filter((n) => !known.has(n))
console.log(`\n白名单 unknown = ${JSON.stringify(unknown)}（空 → 不抛错）`)
console.log(`${ok}/${checks.length} 源码断言通过`)
process.exit(ok === checks.length ? 0 : 1)
