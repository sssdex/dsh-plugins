/**
 * 端到端验证：用**真实的 dsh-memory 注入代码**，而不是我自己的 mock。
 *
 * 为什么必须有这一层：前一版自检全过，但真实的 dsh-memory 可能：
 *   - 消息不带我预期的 source 标记；
 *   - 用别的段名注册系统提示；
 *   - 追加消息的时机与我假设的不同。
 * 这里直接读它安装好的源码，核对契约是否与我的假设一致 —— 契约一变，
 * 这个脚本就会失败，而不是等线上「看着像好了其实没拦住」。
 *
 * 只做静态契约核对（不启动真宿主），因为真宿主启动需要整个 Electron 外壳。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const MEMORY_PKG = 'D:\\DeepSeek-DSH\\profiles\\desktop\\node_modules\\@restregular\\dsh-memory'

function readInject() {
  const file = path.join(MEMORY_PKG, 'lib', 'inject', 'apply.js')
  return { file, source: fs.readFileSync(file, 'utf8') }
}

test('契约（冒烟，非端到端保证）：文件里仍出现 source.kind=memory 的构造', () => {
  const { file, source } = readInject()
  assert.ok(
    /source:\s*\{\s*kind:\s*'memory'/.test(source),
    `${file} 里找不到 source: { kind: 'memory' } —— 上游改了消息标记，本插件会漏删（记忆照旧注入）`,
  )
  // 诚实说明这条断言的强度：它只证明「文件里存在这个写法」，**不能**证明
  // 「每一条注入消息都带它」。真正的端到端保证需要构造一次真实请求来验。
  console.log('  ✓ 冒烟：文件里存在 source.kind=memory 的构造（不证明覆盖率）')
})

test('契约（冒烟）：三个系统提示段的名字仍出现在源码里', () => {
  const { file, source } = readInject()
  for (const name of ['memory:policy', 'memory:rules', 'memory:procedures']) {
    assert.ok(
      source.includes(`name: '${name}'`),
      `${file} 里找不到 name: '${name}' —— 上游改了段名，本插件剥不掉这一段`,
    )
  }
  console.log('  ✓ 冒烟：三个段名都还在（不证明它们没被改成 complete 段）')
})

test('契约：记忆三段都不是 complete 段（否则剥掉后宿主又会放回去）', () => {
  const { file, source } = readInject()
  // 宿主 assemble() 在有 complete 段时，会用 waterfall **之前**捕获的
  // [completeSection] 覆盖 transformed.sections —— 那种情况下我们删普通段无效。
  // 这里确认记忆三段没有一个是 complete:true。
  for (const name of ['memory:policy', 'memory:rules', 'memory:procedures']) {
    const at = source.indexOf(`name: '${name}'`)
    assert.ok(at >= 0, `${file} 里找不到 ${name}`)
    const block = source.slice(at, at + 600)
    assert.ok(
      !/complete:\s*true/.test(block),
      `${name} 变成了 complete 段 —— 宿主会在 waterfall 后覆盖 sections，本插件的剥离会失效`,
    )
  }
  console.log('  ✓ 三段都不是 complete（剥离路径有效）')
})

test('契约：dsh-memory 仍用 prepend 注册 pre-step（决定我们的注册策略）', () => {
  const { file, source } = readInject()
  // 注意：不能只往回看一小段。这个监听体很长（约 490 行），`{ prepend: true }`
  // 写在监听函数**结束之后**那一行，正则跨距给小了会误报「不是 prepend」——
  // 第一版写 2500 字符就这么假警了一次。这里取到文件尾再判定。
  const at = source.indexOf("ctx.on('agent/pre-step'")
  assert.ok(at >= 0, `${file} 里找不到 agent/pre-step 注册`)
  const fromHere = source.slice(at)
  // 结束边界：下一个顶层 ctx.on / ctx.inject / 文件尾。
  const endMatch = /\n  (?:ctx\.on|ctx\.inject|const |\/\/ ----)/.exec(fromHere.slice(10))
  const blockEnd = endMatch === null ? fromHere.length : 10 + endMatch.index
  const block = fromHere.slice(0, blockEnd)
  assert.ok(
    /prepend:\s*true/.test(block),
    `${file} 的 agent/pre-step 不再是 prepend —— 注册顺序前提变了，需要重新评估第 1 层是否还抢得到外层`,
  )
  console.log('  ✓ 仍以 prepend:true 注册 agent/pre-step（这是第 1 层策略的**必要**前提，不是充分保证）')
})

test('契约：注入消息全部经由 createUserMessage 构造（保证 source 一定存在）', () => {
  const { file, source } = readInject()
  // 统计构造消息的所有写法：createUserMessage / createAssistantMessage / createDeveloperMessage…
  // 只断言「至少一处」证明不了覆盖率，所以这里把 createUserMessage 的**调用参数块**
  // 逐个检查，确认都带 source 标记；并报告总数，供人判断是否异常。
  const calls = [...source.matchAll(/createUserMessage\(\{([\s\S]{0,400}?)\}\)/g)].map((m) => m[1])
  assert.ok(calls.length >= 1, `${file} 不再用 createUserMessage —— 消息结构可能变了`)
  for (const [index, args] of calls.entries()) {
    assert.ok(
      /source:\s*\{/.test(args),
      `${file} 第 ${index + 1} 处 createUserMessage 没有 source —— 那种消息本插件认不出来`,
    )
  }
  console.log(`  ✓ 逐处核对：${calls.length} 处 createUserMessage 都带 source`)
})

test('插件侧：剥离后消息数组只删 memory 来源，顺序与其它消息不变', async () => {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'mswitch-e2e-'))
  const url = new URL('../index.js', import.meta.url)
  url.search = `?t=${Date.now()}-${Math.random()}`
  const mod = await import(url.href)
  const captured = []
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    on() { return () => {} },
    effect(fn) { return typeof fn === 'function' ? fn() : undefined },
    inject() { return false },
    provide(key, value) { captured.push(value) },
  }
  mod.apply(ctx, {})
  await new Promise((r) => setImmediate(r))
  const api = captured[0]

  const mk = (kind, text) => ({
    id: `${kind}-${text}`, role: 'user',
    content: [{ type: 'text', text }], source: { kind },
  })
  const input = [
    mk('user', '第一句'),
    mk('memory', '【相关记忆】A'),
    mk('user', '第二句'),
    mk('memory', '【已有记忆摘要】B'),
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'assistant' } },
  ]
  const out = api.stripMemoryMessages(input)

  assert.equal(out.length, 3, '应只剩 user/assistant 三条')
  assert.deepEqual(out.map((m) => m.source.kind), ['user', 'user', 'assistant'])
  assert.deepEqual(out.map((m) => m.content[0].text), ['第一句', '第二句', '回答'])
  console.log('  ✓ 只删 memory 来源，其余消息内容与顺序不变')

  // 幂等：再遍历一次必须不再变化（兜底层防重入依赖这一点）
  const twice = api.stripMemoryMessages(out)
  assert.equal(twice, out, '第二次剥离必须原样返回同一个数组（防重入闸门）')
  console.log('  ✓ 剥离是幂等的（兜底层防重入成立）')
})
