#!/usr/bin/env node
// 量化 compaction/summary 漏算的影响
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { __test__ } from './index.js'
const { frameOffsets, foldSession } = __test__
const SESSIONS = 'D:\\DeepSeek-DSH\\sessions'

function readEvents(f) {
  const raw = fs.readFileSync(f)
  const ev = []
  for (const [a, b] of frameOffsets(raw)) {
    let t = ''
    try {
      t = zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8')
    } catch {
      continue
    }
    for (const line of t.split('\n')) {
      if (!line.trim()) continue
      try {
        ev.push(JSON.parse(line))
      } catch {}
    }
  }
  return ev
}

console.log('=== compaction/summary 的 usage 结构 ===')
let shown = 0
const rows = []
for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  const d = path.join(SESSIONS, ws.name)
  for (const sd of fs.readdirSync(d, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue
    const f = path.join(d, sd.name, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    let ev
    try {
      ev = readEvents(f)
    } catch {
      continue
    }
    let asst = 0
    let asstBilled = 0
    let sumBilled = 0
    let sumCount = 0
    let sumFresh = 0
    for (const e of ev) {
      if (e.type === 'assistant/message' && e.data?.usage) {
        const u = e.data.usage
        asst++
        asstBilled += (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
      }
      if (e.type === 'compaction/summary' && e.data?.usage) {
        const u = e.data.usage
        sumCount++
        sumBilled += (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
        sumFresh += (u.inputTokens || 0) + (u.outputTokens || 0)
        if (shown < 3) {
          console.log(`  样例 ${shown + 1}:`, JSON.stringify(u))
          shown++
        }
      }
    }
    if (sumCount > 0) {
      rows.push({
        session: sd.name.slice(0, 26),
        asstMsgs: asst,
        asstBilled,
        sumCount,
        sumBilled,
        sumFresh,
        pct: asstBilled ? ((sumBilled / (asstBilled + sumBilled)) * 100).toFixed(2) : 'n/a',
      })
    }
  }
}

console.log('\n=== 受影响的会话 ===')
if (!rows.length) console.log('  没有会话包含 compaction/summary usage')
for (const r of rows) console.log(' ', JSON.stringify(r))

const totSum = rows.reduce((a, r) => a + r.sumBilled, 0)
const totAsst = rows.reduce((a, r) => a + r.asstBilled, 0)
console.log(`\n受影响会话: ${rows.length}`)
console.log(`这些会话的 assistant billed 合计: ${totAsst.toLocaleString()}`)
console.log(`被漏掉的 compaction billed: ${totSum.toLocaleString()}`)
console.log(`漏算比例: ${totAsst ? ((totSum / (totAsst + totSum)) * 100).toFixed(3) : 0}%`)
