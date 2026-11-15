/**
 * dsh-qq-hands · test-burst.mjs
 *
 * lib/burst.js 的验收测试：node --test test-burst.mjs
 * 覆盖：单句/多句/条数上限、围栏与表格不切、超长硬切、短碎片合并、
 *       emoji 不被切半、引号归位、URL 保护、延迟函数的确定性与区间。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitBubbles, delayForBubble, DEFAULT_MAX_BUBBLES } from './lib/burst.js'

/** 去空白比较：允许把边界空白压缩成换行，但不允许丢正文。 */
const strip = (value) => value.replace(/\s+/g, '')

/** 拼回全文（拆分契约：join('\n') 不丢内容）。 */
const joinAll = (bubbles) => bubbles.join('\n')

/** 断言所有气泡都满足「已裁空白、非空、码点不超长」。 */
function assertWellFormed(bubbles, limit = 1900) {
  for (const bubble of bubbles) {
    assert.equal(bubble, bubble.trim(), `气泡首尾不应有空白：${JSON.stringify(bubble)}`)
    assert.notEqual(bubble, '', '不应输出空气泡')
    assert.ok(
      [...bubble].length <= limit,
      `气泡超长：${[...bubble].length} > ${limit}，${JSON.stringify(bubble.slice(0, 40))}`,
    )
  }
}

test('DEFAULT_MAX_BUBBLES 是 3', () => {
  assert.equal(DEFAULT_MAX_BUBBLES, 3)
})

test('空串 / 纯空白 → []', () => {
  assert.deepEqual(splitBubbles(''), [])
  assert.deepEqual(splitBubbles('   \n\n \t \r\n'), [])
  assert.deepEqual(splitBubbles('\r\n'), [])
  assert.deepEqual(splitBubbles(undefined), [])
  assert.deepEqual(splitBubbles(12345), [])
})

test('单句 → 1 条气泡', () => {
  const text = '主人早，白饭已经盛好了。'
  const bubbles = splitBubbles(text)
  assert.equal(bubbles.length, 1)
  assert.equal(bubbles[0], text)
})

test('5 句 + maxBubbles=3 → 3 条，拼回内容一致', () => {
  const text = '早上我起得很早，先去公园跑了两圈。回来煮了一锅白饭。然后洗了洗鲸尾。下午看了会儿云。晚上准备早点睡。'
  const bubbles = splitBubbles(text, { maxBubbles: 3 })
  assert.equal(bubbles.length, 3)
  assert.equal(strip(joinAll(bubbles)), strip(text))
  assertWellFormed(bubbles)
})

test('maxBubbles=1 时全部并成一条（放得下的情况下）', () => {
  const text = '第一句。第二句。第三句。'
  const bubbles = splitBubbles(text, { maxBubbles: 1 })
  assert.equal(bubbles.length, 1)
  assert.equal(strip(bubbles[0]), strip(text))
})

test('围栏代码块整块保留，块内多句也不拆', () => {
  const text = [
    '先看这段代码：',
    '',
    '```js',
    'const a = 1。这句不能被拆。',
    'const b = 2！这句也不能被拆。',
    '```',
    '',
    '看懂了吗。',
  ].join('\n')

  const bubbles = splitBubbles(text, { maxBubbles: 6 })
  const fenceBubble = bubbles.find((bubble) => bubble.includes('```js'))
  assert.ok(fenceBubble, '应该有包含围栏的气泡')
  assert.ok(fenceBubble.includes('const a = 1。这句不能被拆。'))
  assert.ok(fenceBubble.includes('const b = 2！这句也不能被拆。'))
  assert.ok(fenceBubble.endsWith('```'), '围栏结束标记要在同一条气泡里')
  // 围栏里的内容只出现在一条气泡里，且围栏前后的正文各自独立
  assert.equal(bubbles.filter((bubble) => bubble.includes('const b')).length, 1)
  assert.ok(bubbles.includes('先看这段代码：'))
  assert.ok(bubbles.includes('看懂了吗。'))
  assert.equal(strip(joinAll(bubbles)), strip(text))
})

test('GFM 表格：表头 + 分隔行 + 数据行在同一个气泡', () => {
  const text = [
    '统计如下：',
    '',
    '| 名字 | 数量 |',
    '| --- | --- |',
    '| 白饭 | 2 碗 |',
    '| 小鱼干 | 3 条 |',
    '',
    '就这样。',
  ].join('\n')

  const bubbles = splitBubbles(text, { maxBubbles: 6 })
  const tableBubble = bubbles.find((bubble) => bubble.includes('| 名字 |'))
  assert.ok(tableBubble, '应该有包含表格的气泡')
  assert.ok(tableBubble.includes('| --- | --- |'), '分隔行必须跟着表头')
  assert.ok(tableBubble.includes('| 白饭 | 2 碗 |'))
  assert.ok(tableBubble.includes('| 小鱼干 | 3 条 |'))
  // 表格的每一行都不能跑进别的气泡
  assert.equal(bubbles.filter((bubble) => bubble.includes('|')).length, 1)
  assert.equal(strip(joinAll(bubbles)), strip(text))
})

test('围栏与表格都出现时各自独立成泡', () => {
  const text = [
    '| 步骤 | 命令 |',
    '| --- | --- |',
    '| 一 | npm test |',
    '',
    '```bash',
    'npm test。注意别断行！',
    '```',
  ].join('\n')

  const bubbles = splitBubbles(text, { maxBubbles: 6 })
  assert.equal(bubbles.length, 2)
  assert.ok(bubbles[0].includes('| 步骤 | 命令 |'))
  assert.ok(bubbles[1].includes('```bash'))
  assert.ok(bubbles[1].includes('npm test。注意别断行！'))
})

test('3000 字单句：每条 <= maxCodepoints 且无丢失', () => {
  const text = '鲸'.repeat(3000)
  const bubbles = splitBubbles(text)
  assert.ok(bubbles.length >= 2)
  assertWellFormed(bubbles, 1900)
  assert.equal(strip(joinAll(bubbles)), strip(text))
})

test('硬切优先保长度上限：7600 字单句宁可变 4 条也不超长', () => {
  const text = '🐋'.repeat(7600)
  const bubbles = splitBubbles(text, { maxBubbles: 3 })
  assert.ok(bubbles.length > 3, '长度上限比条数上限更硬')
  assertWellFormed(bubbles, 1900)
  assert.equal(strip(joinAll(bubbles)), strip(text))
})

test('超长围栏：结构完整优先（会被允许超过 maxCodepoints）', () => {
  const text = ['```text', 'A'.repeat(2500), '```'].join('\n')
  const bubbles = splitBubbles(text)
  assert.equal(bubbles.length, 1)
  assert.ok(bubbles[0].includes('A'.repeat(2500)), '围栏正文不能被切碎')
})

test('极短碎片合并，不出现「嗯。」「好呀。」单独成泡', () => {
  const text = '嗯。好呀。今天天气不错，要不要出去走走？'
  const bubbles = splitBubbles(text)
  assert.ok(!bubbles.includes('嗯。'), '「嗯。」不该单独成泡')
  assert.ok(!bubbles.includes('好呀。'), '「好呀。」不该单独成泡')
  for (const bubble of bubbles) {
    assert.ok([...bubble].length >= 4, `气泡太碎：${JSON.stringify(bubble)}`)
  }
  // 合并绝不能丢字或复制：拼回去必须和原文一致
  assert.equal(strip(joinAll(bubbles)), strip(text))
})

test('短碎片链式合并：精确输出，不重复不丢失', () => {
  const text = '嗯。好。'
  const bubbles = splitBubbles(text)
  assert.equal(bubbles.length, 1, `应该并成一条：${JSON.stringify(bubbles)}`)
  assert.equal(strip(bubbles[0]), '嗯。好。')
  assert.equal(bubbles[0], '嗯。\n好。')

  const chain = '嗯。好。对。收到。'
  const chained = splitBubbles(chain)
  assert.equal(strip(joinAll(chained)), strip(chain))
  for (const bubble of chained) {
    assert.ok([...bubble].length >= 4, `气泡太碎：${JSON.stringify(bubble)}`)
  }
})

test('短碎片被结构块挡住时，向后合并（不破坏围栏）', () => {
  const text = ['```js', 'const x = 1', '```', '嗯。好呀。'].join('\n')
  const bubbles = splitBubbles(text, { maxBubbles: 6 })
  assert.equal(bubbles.length, 2)
  assert.ok(bubbles[0].startsWith('```js'))
  assert.ok(bubbles[0].endsWith('```'))
  assert.equal(strip(bubbles[1]), '嗯。好呀。')
  assert.equal(strip(joinAll(bubbles)), strip(text))
})

test('emoji 不被切半（无孤立代理项）', () => {
  const emoji = '😀🐋'
  const bubbles = splitBubbles(emoji.repeat(6), { maxCodepoints: 5 })
  assert.equal(strip(joinAll(bubbles)), emoji.repeat(6))
  for (const bubble of bubbles) {
    assert.ok([...bubble].length <= 5)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(bubble), '出现了孤立高位代理')
    assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(bubble), '出现了孤立低位代理')
  }
})

test('中文标点 + 闭合引号/括号归前一句', () => {
  const text = '他说：「今天不写作业。」然后跑了。她喊了一声“好呀！”也走了。'
  const bubbles = splitBubbles(text, { maxBubbles: 6 })
  assert.deepEqual(bubbles, [
    '他说：「今天不写作业。」',
    '然后跑了。',
    '她喊了一声“好呀！”',
    '也走了。',
  ])
})

test('超长片段降级：换行优先于逗号', () => {
  const text = `${'甲'.repeat(25)}\n${'乙'.repeat(25)}，${'丙'.repeat(25)}`
  const bubbles = splitBubbles(text, { maxCodepoints: 30, maxBubbles: 9 })
  assert.equal(bubbles[0], '甲'.repeat(25), '应该先在新行处断开')
  assert.equal(strip(joinAll(bubbles)), strip(text))
  assertWellFormed(bubbles, 30)
})

test('超长片段降级：没有换行时用逗号', () => {
  const text = `${'甲'.repeat(25)}，${'乙'.repeat(25)}`
  const bubbles = splitBubbles(text, { maxCodepoints: 30, maxBubbles: 9 })
  assert.equal(bubbles[0], `${'甲'.repeat(25)}，`)
  assertWellFormed(bubbles, 30)
})

test('空行段落优先：两个段落各自成泡', () => {
  const text = '第一段的第一句。第一段的第二句。\n\n第二段只有一句。'
  const bubbles = splitBubbles(text, { maxBubbles: 6 })
  assert.equal(bubbles.length, 3)
  assert.equal(bubbles[0], '第一段的第一句。')
  assert.equal(bubbles[1], '第一段的第二句。')
  assert.equal(bubbles[2], '第二段只有一句。')
})

test('URL 里的 ? 不当作断句点', () => {
  const text = '看这里 https://a.com/?q=鲸 就懂了。'
  const bubbles = splitBubbles(text)
  assert.equal(bubbles.length, 1)
  assert.ok(bubbles[0].includes('https://a.com/?q=鲸'))
})

test('CRLF 换行被统一，不把 \\r 发出去', () => {
  const bubbles = splitBubbles('第一句。\r\n第二句。\r\n')
  assert.ok(!bubbles.some((bubble) => bubble.includes('\r')))
  assert.deepEqual(bubbles, ['第一句。', '第二句。'])
})

test('综合文本：join 拼回后正文一字不少，结构块不被切', () => {
  const text = [
    '主人，我把这件事拆开说。',
    '',
    '第一，代码围栏整块保留：',
    '',
    '```js',
    'const rice = 3。',
    'const fish = 5；',
    '```',
    '',
    '第二，表格也整块保留：',
    '',
    '| 项目 | 值 |',
    '| :--- | ---: |',
    '| 白饭 | 3 碗 |',
    '',
    '最后一句收尾。',
  ].join('\n')

  const bubbles = splitBubbles(text, { maxBubbles: 5 })
  assert.equal(strip(joinAll(bubbles)), strip(text))
  assert.ok(bubbles.some((bubble) => bubble.includes('const rice = 3。') && bubble.includes('const fish = 5；')))
  assert.ok(bubbles.some((bubble) => bubble.includes('| 项目 | 值 |') && bubble.includes('| 白饭 | 3 碗 |')))
  assertWellFormed(bubbles)
})

test('delayForBubble：同参确定性且落在 min..max', () => {
  const bubble = '今天的白饭特别香。'
  const first = delayForBubble(bubble)
  const second = delayForBubble(bubble)
  assert.equal(first, second)
  assert.ok(Number.isInteger(first), '应该是整数毫秒')
  assert.ok(first >= 550 && first <= 1450, `越界：${first}`)

  const custom = delayForBubble(bubble, { minMs: 100, maxMs: 200, seed: 7 })
  assert.equal(custom, delayForBubble(bubble, { minMs: 100, maxMs: 200, seed: 7 }))
  assert.ok(custom >= 100 && custom <= 200, `越界：${custom}`)

  // 空内容也不炸，并且仍在区间内
  const empty = delayForBubble('', { minMs: 10, maxMs: 20 })
  assert.ok(empty >= 10 && empty <= 20)
})

test('delayForBubble：越长越慢，>= 120 字封顶', () => {
  const shortDelay = delayForBubble('短')
  const longDelay = delayForBubble('长'.repeat(100))
  assert.ok(shortDelay < longDelay, `短内容应更早发出：${shortDelay} vs ${longDelay}`)
  assert.equal(delayForBubble('长'.repeat(120)), 1450)
  assert.equal(delayForBubble('长'.repeat(500)), 1450)
  assert.equal(delayForBubble('长'.repeat(120), { minMs: 100, maxMs: 300 }), 300)
})
