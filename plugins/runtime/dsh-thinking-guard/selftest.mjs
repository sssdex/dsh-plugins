/**
 * dsh-thinking-guard 自测：跑合成 chunk 流，用「和 DSH BlockAssembler 同语义」的
 * 迷你汇编器还原成块，断言 <thinking> 绝不出现在 text 块里。
 *
 * 语义照抄 dsh-llm/lib/types/assembler.js：
 *   - block-start 记录 blockType；一个 index 的类型由第一次出现决定
 *   - block-end 的 block 字段即最终块，首次关闭生效
 *   - 顺序由 index 首次出现顺序决定（与 index 数值无关）
 *   - 容忍没有 block-start 的纯 delta 协议
 */
import assert from 'node:assert/strict'
import { apply } from './index.js'

// ----------------------------------------------------------------- 迷你汇编器
function assemble(chunks) {
  const partials = new Map()
  const order = []
  const ensure = (i, blockType) => {
    let p = partials.get(i)
    if (p === undefined) {
      p = { blockType, text: '', toolCallArguments: '' }
      partials.set(i, p)
      order.push(i)
    }
    return p
  }
  for (const c of chunks) {
    if (c.type === 'block-start') ensure(c.index, c.blockType)
    else if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
      const p = ensure(c.index, c.type === 'text-delta' ? 'text' : 'reasoning')
      if (p.block === undefined) p.text += c.text
    } else if (c.type === 'tool-call-delta') {
      const p = ensure(c.index, 'tool-call')
      p.toolCallId = c.id
      if (c.name) p.toolCallName = c.name
      p.toolCallArguments += c.argumentsDelta
    } else if (c.type === 'block-end') {
      const p = ensure(c.index, c.block.type)
      if (p.block === undefined) p.block = c.block
    }
  }
  return order.map((i) => {
    const p = partials.get(i)
    if (p.block !== undefined) return p.block
    if (p.blockType === 'text') return { type: 'text', text: p.text }
    if (p.blockType === 'reasoning') return { type: 'reasoning', text: p.text }
    return { type: 'tool-call', id: p.toolCallId, name: p.toolCallName, arguments: p.toolCallArguments }
  })
}

// -------------------------------------------------------------------- 跑插件
async function run(chunks, config = {}, opts = {}) {
  let listener = null
  const ctx = { on: (e, fn) => { assert.equal(e, 'llm/stream'); listener = fn }, logger: { info() {}, warn() {} } }
  apply(ctx, config)
  assert.ok(listener, '必须注册 llm/stream 监听')
  const source = (async function* () { for (const c of chunks) yield c })()
  const out = []
  const stream = listener({}, () => source)
  for await (const c of stream) out.push(c)
  const blocks = assemble(out)
  return { chunks: out, blocks }
}

/** 把一段文本按给定大小切碎成 text-delta（模拟 SSE 分片把标签切开）。 */
function textDeltas(index, text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push({ type: 'text-delta', index, text: text.slice(i, i + size) })
  return out
}

const T = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
const R = (blocks) => blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')
const types = (blocks) => blocks.map((b) => b.type).join(',')

let pass = 0
const cases = []
function check(name, fn) { cases.push([name, fn]) }

// 1. 真实样本：思考和正文连在同一个 text 块里（session-00ab7fdc 原样）
check('真实样本：思考+正文同块', async () => {
  const body = '<thinking>Now write the reply — 一句话接茬 + 图 + 简短延伸。</thinking>  [表情: 得意闭眼拳头]  哦——'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, ...textDeltas(0, body, 7), { type: 'block-end', index: 0, block: { type: 'text', text: body } }]
  const { blocks } = await run(chunks)
  assert.equal(types(blocks), 'reasoning,text', '应拆成 reasoning + text')
  assert.equal(R(blocks), 'Now write the reply — 一句话接茬 + 图 + 简短延伸。')
  assert.equal(T(blocks), '  [表情: 得意闭眼拳头]  哦——')
  assert.ok(!T(blocks).includes('<thinking>'), '正文里不得有标签')
})

// 2. 整块都是思考 → 只剩 reasoning，不产出空白 text 块
check('整块都是思考', async () => {
  const body = '\n\n<thinking>Only 2 lines — so the log uses a frame format.</thinking>'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, ...textDeltas(0, body, 3), { type: 'block-end', index: 0, block: { type: 'text', text: body } }]
  const { blocks } = await run(chunks)
  assert.equal(types(blocks), 'reasoning')
  assert.equal(R(blocks), 'Only 2 lines — so the log uses a frame format.')
})

// 3. 逐字符切片（最极端的分片）
check('逐字符分片', async () => {
  const body = '<thinking>abc</thinking>xyz'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, ...textDeltas(0, body, 1), { type: 'block-end', index: 0, block: { type: 'text', text: body } }]
  const { blocks } = await run(chunks)
  assert.equal(types(blocks), 'reasoning,text')
  assert.equal(R(blocks), 'abc')
  assert.equal(T(blocks), 'xyz')
})

// 4. 无 thinking，纯正文 → 原样透传（块数与内容完全一致）
check('纯正文不受影响', async () => {
  const body = '这是一段普通回答，没有任何标签。'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, ...textDeltas(0, body, 4), { type: 'block-end', index: 0, block: { type: 'text', text: body } }]
  const { chunks: out, blocks } = await run(chunks)
  assert.equal(types(blocks), 'text')
  assert.equal(T(blocks), body)
  assert.deepEqual(out[0], chunks[0])
  assert.deepEqual(out.at(-1), chunks.at(-1))
})

// 5. 中途出现标签（前面有正文）
check('正文中间夹思考', async () => {
  const body = '开始 <thinking>内部推理</thinking> 结束'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, ...textDeltas(0, body, 2), { type: 'block-end', index: 0, block: { type: 'text', text: body } }]
  const { blocks } = await run(chunks)
  assert.equal(types(blocks), 'text,reasoning,text')
  assert.equal(T(blocks), '开始  结束')
  assert.equal(R(blocks), '内部推理')
})

// 6. 标签没闭合就断流 → 整段当 reasoning，内容不丢
check('标签未闭合', async () => {
  const body = '<thinking>断流了没闭合'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, ...textDeltas(0, body, 5)]
  const { blocks } = await run(chunks)
  assert.equal(types(blocks), 'reasoning')
  assert.equal(R(blocks), '断流了没闭合')
})

// 7. reasoning / tool-call 通道必须原样不动
check('其他通道不受影响', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '原生思考' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '原生思考' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    ...textDeltas(1, '<thinking>混进来的</thinking>正文', 4),
    { type: 'block-end', index: 1, block: { type: 'text', text: '<thinking>混进来的</thinking>正文' } },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'pwsh', argumentsDelta: '{}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { blocks } = await run(chunks)
  assert.equal(types(blocks), 'reasoning,reasoning,text,tool-call')
  assert.equal(blocks[0].text, '原生思考')
  assert.equal(blocks[1].text, '混进来的')
  assert.equal(blocks[2].text, '正文')
  assert.equal(blocks[3].name, 'pwsh')
})

// 8. strip 模式：思考直接丢掉
check('strip 模式', async () => {
  const body = '<thinking>不要这段</thinking>只要正文'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, ...textDeltas(0, body, 3), { type: 'block-end', index: 0, block: { type: 'text', text: body } }]
  const { blocks } = await run(chunks, { mode: 'strip' })
  assert.equal(types(blocks), 'text')
  assert.equal(T(blocks), '只要正文')
})

// 9. block-end 缺失（只有 delta）也要能收尾
check('纯 delta 协议', async () => {
  const body = '<thinking>甲</thinking>乙'
  const { blocks } = await run(textDeltas(0, body, 2))
  assert.equal(types(blocks), 'reasoning,text')
  assert.equal(R(blocks), '甲')
  assert.equal(T(blocks), '乙')
})

// 10. 大小写不敏感 + 多个标签
check('大小写与多标签', async () => {
  const body = '<THINKING>a</THINKING>正文<Thinking>b</Thinking>尾巴'
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, ...textDeltas(0, body, 3), { type: 'block-end', index: 0, block: { type: 'text', text: body } }]
  const { blocks } = await run(chunks)
  assert.equal(types(blocks), 'reasoning,text,reasoning,text')
  assert.equal(R(blocks), 'ab')
  assert.equal(T(blocks), '正文尾巴')
})

for (const [n, fn] of cases) {
  try { await fn(); pass++; console.log(`  ok  ${n}`) }
  catch (e) { console.log(`FAIL  ${n}\n      ${e.message}`) }
}
console.log(`\n${pass}/${cases.length} passed`)
process.exit(pass === cases.length ? 0 : 1)
