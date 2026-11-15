#!/usr/bin/env node
// 正确性复审：找"数字算错"类问题
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

/* 1. totalTokens 与四项之和是否一致？不一致说明有漏项 */
console.log('=== 1. totalTokens vs input+output+cacheRead+cacheWrite ===')
let n = 0
let mismatch = 0
const samples = []
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
    for (const e of ev) {
      if (e.type !== 'assistant/message' || !e.data?.usage) continue
      const u = e.data.usage
      const sum = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
      n++
      if (typeof u.totalTokens === 'number' && u.totalTokens !== sum) {
        mismatch++
        if (samples.length < 6) {
          samples.push({ total: u.totalTokens, sum, parts: { i: u.inputTokens, o: u.outputTokens, cr: u.cacheReadTokens, cw: u.cacheWriteTokens } })
        }
      }
    }
    if (n > 8000) break
  }
  if (n > 8000) break
}
console.log(`抽样 ${n} 条，totalTokens ≠ 四项之和 的有 ${mismatch}`)
if (samples.length) for (const s of samples) console.log('   ', JSON.stringify(s))
console.log(`占比: ${((mismatch / n) * 100).toFixed(1)}%`)

/* 2. inputTokens 是否已经包含 cacheRead？ */
console.log('\n=== 2. inputTokens 语义（是否含缓存）===')
let withCache = 0
let sample = null
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
    for (const e of ev) {
      if (e.type !== 'assistant/message' || !e.data?.usage) continue
      const u = e.data.usage
      if ((u.cacheReadTokens || 0) > 0) {
        withCache++
        if (!sample) sample = u
      }
    }
  }
  if (withCache > 2000) break
}
console.log('样例:', JSON.stringify(sample))
if (sample) {
  const i = sample.inputTokens || 0
  const cr = sample.cacheReadTokens || 0
  const tot = sample.totalTokens || 0
  console.log(`  input=${i} cacheRead=${cr} total=${tot}`)
  console.log(`  input+cacheRead=${i + cr}  ; input 单独=${i}`)
  console.log(
    tot === i + cr + (sample.outputTokens || 0)
      ? '  => total ≈ input + cacheRead + output：inputTokens 是「未缓存输入」'
      : '  => 关系不明确，需进一步确认',
  )
}

/* 3. 一个会话内有没有非 assistant/message 的用量来源（如压缩摘要）被漏掉？ */
console.log('\n=== 3. 其它带 usage 的事件类型 ===')
const usageTypes = new Map()
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
    for (const e of ev) {
      if (e.data && typeof e.data === 'object' && 'usage' in e.data) {
        usageTypes.set(e.type, (usageTypes.get(e.type) || 0) + 1)
      }
    }
  }
}
console.log('带 usage 的事件类型:', JSON.stringify([...usageTypes.entries()]))
const onlyAssistant = [...usageTypes.keys()].every((t) => t === 'assistant/message')
console.log(onlyAssistant ? '  => 只有 assistant/message 带 usage，不漏计' : '  => 有其他类型带 usage，会被漏计！')

/* 4. 压缩(compaction)用的 token 从哪来 */
console.log('\n=== 4. 压缩事件是否单独消耗 token ===')
const compactionTypes = new Map()
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
    for (const e of ev) {
      if (/compact|prune|summar/i.test(e.type)) compactionTypes.set(e.type, (compactionTypes.get(e.type) || 0) + 1)
    }
  }
}
console.log('压缩相关事件类型:', JSON.stringify([...compactionTypes.entries()]))
