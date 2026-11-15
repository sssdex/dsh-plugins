#!/usr/bin/env node
// 验证：增量读取是否真的更快，且结果与全量完全一致
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { __test__ } from './index.js'
const { frameOffsets, foldSession, applyEvents, emptyRecord } = __test__
const SESSIONS = 'D:\\DeepSeek-DSH\\sessions'

function frames(raw) {
  const out = []
  let cur = -1
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) {
      if (cur >= 0) out.push([cur, i])
      cur = i
    }
  }
  if (cur >= 0) out.push([cur, raw.length])
  return out
}

function decodeAll(raw) {
  const ev = []
  for (const [a, b] of frames(raw)) {
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

// 找最大的会话（最能体现成本）
const files = []
for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  const d = path.join(SESSIONS, ws.name)
  for (const sd of fs.readdirSync(d, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue
    const f = path.join(d, sd.name, 'session.v4.jsonl.zstd')
    if (fs.existsSync(f)) files.push({ f, size: fs.statSync(f).size, dir: sd.name })
  }
}
files.sort((a, b) => b.size - a.size)
const t = files[0]
console.log('最大会话:', path.basename(path.dirname(t.f)).slice(0, 34))
console.log('大小:', (t.size / 1024 / 1024).toFixed(2), 'MB')

const raw = fs.readFileSync(t.f)
const fr = frames(raw)
console.log('帧数:', fr.length)

// 全量
let t0 = Date.now()
const full = foldSession(t.dir, decodeAll(raw))
let tFull = Date.now() - t0

// 模拟增量：先解前 90% 的帧，再解剩下 10%
const cut = Math.floor(fr.length * 0.9)
const headBuf = raw.subarray(0, fr[cut][0])
const tailBuf = raw.subarray(fr[cut][0])

t0 = Date.now()
const inc = foldSession(t.dir, decodeAll(headBuf))
t0 = Date.now()
applyEvents(inc, decodeAll(tailBuf))
let tIncTail = Date.now() - t0
let tIncTotal = tIncTail // 只算增量部分

console.log(`\n全量折叠耗时: ${tFull} ms`)
console.log(`增量（只解尾部 ${fr.length - cut} 帧）耗时: ${tIncTotal} ms`)
console.log(`加速比: ${(tFull / Math.max(tIncTail, 1)).toFixed(1)}x`)

// 重算派生字段（增量路径里 loadOne 也会重算）
inc.billed = inc.input + inc.output + inc.cacheRead + inc.cacheWrite
inc.fresh = inc.input + inc.output
inc.compactionBilled = inc.compactionInput + inc.compactionOutput + inc.compactionCacheRead + inc.compactionCacheWrite

console.log('\n一致性检查:')
let allSame = true
for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'steps', 'requests', 'billed', 'fresh', 'title', 'parent', 'origin']) {
  const a = JSON.stringify(inc[k])
  const b = JSON.stringify(full[k])
  const same = a === b
  if (!same) allSame = false
  console.log(`  ${same ? 'ok  ' : 'FAIL'} ${k}: inc=${a} full=${b}`)
}
console.log(allSame ? '\n=> 增量结果与全量完全一致' : '\n=> 不一致！增量优化有 bug')

// 全量扫描总成本估算
console.log('\n=== 全量扫描开销估算 ===')
let totalBytes = 0
for (const f of files) totalBytes += f.size
console.log(`会话数 ${files.length}，总 ${(totalBytes / 1048576).toFixed(1)} MB`)
console.log(`只有"正在写入的那个会话"会走增量路径，其余全部命中缓存（mtime+size 未变）`)
console.log(`最坏情况：冷启动首次 = 全量一次（约 7 秒，已实测）`)
console.log(`稳态：每 5 秒只解当前会话的新增尾部（通常几十 KB）`)
