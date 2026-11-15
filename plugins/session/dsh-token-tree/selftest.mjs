#!/usr/bin/env node
// dsh-token-tree 宿主半的自检：直接调 index.js 导出的纯函数，不需要跑 DSH。
//   node selftest.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { __test__ } from './index.js'

const foldSession = __test__.foldSession

let pass = 0
let fail = 0

function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? '  ' + JSON.stringify(extra) : ''}`)
  }
}

/* 1. 多帧解码：造一个两帧的 zstd，确认只解第一帧会丢数据。 */
{
  const a = Buffer.from(JSON.stringify({ type: 'session', id: 's1', cwd: 'C:\\x' }) + '\n', 'utf8')
  const b = Buffer.from(
    JSON.stringify({ type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 } } }) + '\n',
    'utf8',
  )
  const multi = Buffer.concat([zlib.zstdCompressSync(a), zlib.zstdCompressSync(b)])

  console.log('多帧 zstd 解码')
  const naive = zlib.zstdDecompressSync(multi).toString('utf8')
  check('单次 zstdDecompressSync 只拿到第一帧（这就是踩坑现象）', naive.includes('session') && !naive.includes('assistant/message'))

  const events = __test__.decodeLog(multi)
  check('decodeLog 拿到两帧', events.length === 2, { got: events.length })
  check('第二帧是 assistant/message', events[1]?.type === 'assistant/message')

  const offs = __test__.frameOffsets(multi)
  check('frameOffsets 切出两帧', offs.length === 2, { got: offs.length })
}

/* 2. 折叠：usage 累加口径。 */
{
  console.log('foldSession 用量折叠')
  const events = [
    { type: 'session', id: 's1', origin: 'root', delegationDepth: 0 },
    { type: 'step/end' },
    { type: 'step/end' },
    {
      type: 'assistant/message',
      data: {
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 5 },
        message: { source: { provider: 'p1', model: 'm1' } },
      },
    },
    {
      type: 'assistant/message',
      data: { usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 }, message: { source: { provider: 'p1', model: 'm2' } } },
    },
    { type: 'assistant/message', data: {} }, // 没有 usage，必须忽略
  ]
  const rec = foldSession('s1', events)
  check('input 累加', rec.input === 150, { got: rec.input })
  check('output 累加', rec.output === 30, { got: rec.output })
  check('cacheRead 累加', rec.cacheRead === 900, { got: rec.cacheRead })
  check('cacheWrite 累加', rec.cacheWrite === 5, { got: rec.cacheWrite })
  check('billed = 四项之和', rec.billed === 150 + 30 + 900 + 5, { got: rec.billed })
  check('fresh = input + output', rec.fresh === 180, { got: rec.fresh })
  check('steps 只算 step/end', rec.steps === 2, { got: rec.steps })
  check('requests 只算带 usage 的', rec.requests === 2, { got: rec.requests })
  check('byProvider 累加', rec.byProvider.p1 === 180, { got: rec.byProvider.p1 })
  check('byModel m1 = 120', rec.byModel.m1 === 120, { got: rec.byModel.m1 })
  // 缓存命中率 = cacheRead / (cacheRead + input)，分母不含 output / cacheWrite。
  check('缓存命中率 = 900 / (900+150)', Math.abs(rec.cacheHitRate - 900 / 1050) < 1e-12, { got: rec.cacheHitRate })
}

/* 2a. 缓存命中率的边界：分母为 0 时必须是 null，不能是 0 或 NaN。 */
{
  console.log('cacheHitRate 边界')
  const rate = __test__.cacheHitRate
  check('全空 → null', rate(0, 0) === null, { got: rate(0, 0) })
  check('缺参 → null', rate(undefined, undefined) === null)
  check('零缓存读 → 0', rate(0, 500) === 0, { got: rate(0, 500) })
  check('零未缓存 → 1（满命中）', rate(500, 0) === 1, { got: rate(500, 0) })
  check('半命中 → 0.5', rate(500, 500) === 0.5, { got: rate(500, 500) })
  check('结果恒在 [0,1]', [rate(1, 999999), rate(999999, 1)].every((v) => v >= 0 && v <= 1))
}

/* 2b. compaction/summary 也必须计入（这是修过的漏算 bug）。 */
{
  console.log('compaction/summary 计入')
  const events = [
    { type: 'session', id: 's1' },
    { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 50 } } },
    { type: 'compaction/summary', data: { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 } } },
  ]
  const rec = foldSession('s1', events)
  check('compaction 的 input 计入总量', rec.input === 1100, { got: rec.input })
  check('compaction 的 output 计入总量', rec.output === 250, { got: rec.output })
  check('compaction 的 cacheRead 计入总量', rec.cacheRead === 5000, { got: rec.cacheRead })
  check('compaction 单独记账', rec.compactionBilled === 6200, { got: rec.compactionBilled })
  check('compaction 单独 fresh', rec.compactionFresh === 1200, { got: rec.compactionFresh })
  check('compaction 计入 requests', rec.requests === 2, { got: rec.requests })
  check('compactionRequests = 1', rec.compactionRequests === 1, { got: rec.compactionRequests })
}

/* 2c. 增量折叠 == 全量折叠（防止增量优化算错）。 */
{
  console.log('增量折叠与全量折叠一致性')
  const base = [
    { type: 'session', id: 'inc1', origin: 'subagent', parentSession: 'p0', delegationDepth: 2 },
    { type: 'step/end' },
    { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 } } },
  ]
  const more = [
    { type: 'step/end' },
    { type: 'assistant/message', data: { usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 300 } } },
    { type: 'compaction/summary', data: { usage: { inputTokens: 40, outputTokens: 9 } } },
  ]

  const full = foldSession('inc1', [...base, ...more])
  const inc = __test__.foldSession('inc1', base)
  __test__.applyEvents(inc, more)
  inc.billed = inc.input + inc.output + inc.cacheRead + inc.cacheWrite
  inc.fresh = inc.input + inc.output
  inc.compactionBilled = inc.compactionInput + inc.compactionOutput + inc.compactionCacheRead + inc.compactionCacheWrite

  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'steps', 'requests', 'billed', 'fresh', 'parent', 'origin', 'depth']) {
    check(`增量 == 全量: ${k}`, JSON.stringify(inc[k]) === JSON.stringify(full[k]), { inc: inc[k], full: full[k] })
  }
}

/* 3. 建树：父子求和 + 根上溯。 */
{
  console.log('buildTree 父子汇总')
  const mk = (id, parent, input, output) => ({
    id,
    parent,
    origin: parent ? 'subagent' : 'root',
    depth: parent ? 1 : 0,
    title: id,
    steps: 1,
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    requests: 1,
    byProvider: {},
    byModel: {},
    billed: input + output,
    fresh: input + output,
    createdAt: 0,
    cacheHitRate: __test__.cacheHitRate(0, input),
  })
  const map = new Map([
    ['root', mk('root', null, 100, 50)],
    ['c1', mk('c1', 'root', 200, 100)],
    ['c2', mk('c2', 'root', 300, 150)],
    ['g1', mk('g1', 'c2', 10, 5)],
  ])
  const tree = __test__.buildTree(map, 'root')
  check('根 billed = 全部之和', tree.billed === 915, { got: tree.billed })
  check('代理数 4', tree.count === 4, { got: tree.count })
  check('根自身 billed 只算自己', tree.selfBilled === 150, { got: tree.selfBilled })
  check('子代理合计 = 765', tree.billed - tree.selfBilled === 765, { got: tree.billed - tree.selfBilled })

  const c2 = tree.children.find((c) => c.id === 'c2')
  check('中间节点也汇总了孙代', c2 && c2.billed === 465, { got: c2 && c2.billed })
  check('孙代挂在 c2 下', c2 && c2.children.length === 1 && c2.children[0].id === 'g1')
  // 命中率是派生量：必须在汇总之后算，不能当比率直接相加。
  // 这组数据 cacheRead 全为 0，所以整棵树的命中率必须是 0，而不是 null。
  check('树节点带 cacheHitRate', typeof tree.cacheHitRate === 'number', { got: tree.cacheHitRate })
  check('零缓存读 → 整树命中率 0', tree.cacheHitRate === 0, { got: tree.cacheHitRate })

  check('findRoot 从孙代上溯到根', __test__.findRoot(map, 'g1') === 'root')
  check('findRoot 从子代上溯到根', __test__.findRoot(map, 'c1') === 'root')
  check('findRoot 根本身不变', __test__.findRoot(map, 'root') === 'root')
  check('findRoot 未知 id 返回 null', __test__.findRoot(map, 'nope') === null)
}

/* 4. 真实日志（如果本机有的话）。 */
{
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dir = path.join(home, 'sessions')
  console.log(`真实会话日志（${dir}）`)
  if (!fs.existsSync(dir)) {
    console.log('  skip（没有 sessions 目录）')
  } else {
    let found = 0
    let okd = 0
    for (const ws of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      const wsDir = path.join(dir, ws.name)
      for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!sd.isDirectory()) continue
        const f = path.join(wsDir, sd.name, 'session.v4.jsonl.zstd')
        if (!fs.existsSync(f)) continue
        found++
        const events = __test__.decodeLog(fs.readFileSync(f))
        if (events.length > 1) okd++
        if (found === 1) {
          check('真实日志能解出 >1 个事件', events.length > 1, { got: events.length })
          const rec = foldSession(sd.name, events)
          check('真实的 rec 有 id', typeof rec.id === 'string' && rec.id.length > 0)
        }
        if (found >= 60) break
      }
      if (found >= 60) break
    }
    check(`抽样 ${found} 个真实日志全部可解`, found > 0 && okd === found, { found, okd })
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
