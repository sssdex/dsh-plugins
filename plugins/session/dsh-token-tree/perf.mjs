#!/usr/bin/env node
// 性能与正确性探针
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { __test__ } from './index.js'
const { frameOffsets, foldSession } = __test__
const SESSIONS = 'D:\\DeepSeek-DSH\\sessions'

function readRaw(f) {
  const raw = fs.readFileSync(f)
  const p = []
  for (const [a, b] of frameOffsets(raw)) {
    try {
      p.push(zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8'))
    } catch {}
  }
  return p.join('')
}

// 收集所有会话文件
const files = []
for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue
  const d = path.join(SESSIONS, ws.name)
  for (const sd of fs.readdirSync(d, { withFileTypes: true })) {
    if (!sd.isDirectory()) continue
    const f = path.join(d, sd.name, 'session.v4.jsonl.zstd')
    if (fs.existsSync(f)) files.push(f)
  }
}

console.log('=== A. 全量扫描成本 ===')
console.log('会话文件数:', files.length)
const t0 = Date.now()
let totalBytes = 0
let totalEvents = 0
let maxBytes = 0
let maxFile = ''
for (const f of files) {
  const st = fs.statSync(f)
  totalBytes += st.size
  if (st.size > maxBytes) {
    maxBytes = st.size
    maxFile = f
  }
  const text = readRaw(f)
  totalEvents += text.split('\n').filter(Boolean).length
}
const t1 = Date.now()
console.log(`全量解压+解析耗时: ${t1 - t0} ms`)
console.log(`总字节: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
console.log(`最大单文件: ${(maxBytes / 1024 / 1024).toFixed(2)} MB  ${path.basename(path.dirname(maxFile)).slice(0, 30)}`)
console.log(`总事件数: ${totalEvents}`)
console.log(`结论: 每次点刷新/自动刷新都会重跑上面这整个流程`)

// 缓存是否真的生效？看 scan 的缓存键
console.log('\n=== B. 缓存键分析 ===')
console.log('cache.logs 的键是: entry.file（完整路径）')
console.log('命中条件: mtime===mtimeMs && size===size')
console.log('=> 只要会话被写入，该会话就要重新全量解压（无法增量）')

// 当前会话（正在写入）会不会导致每次都 miss？
console.log('\n=== C. 正在写入的会话必然 cache miss ===')
const recent = files
  .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, 3)
for (const { f, m } of recent) {
  console.log(`  ${path.basename(path.dirname(f)).slice(0, 34)}  mtime=${new Date(m).toISOString()}`)
}
console.log('=> 当前对话进行中，mtime 每轮都变，必然 miss => 每 5 秒重解一次这个会话')

// 最坏情况：大文件重复解压成本
console.log('\n=== D. 最大文件单次解压成本 ===')
const t2 = Date.now()
for (let i = 0; i < 3; i++) readRaw(maxFile)
const t3 = Date.now()
console.log(`最大文件解压 3 次: ${t3 - t2} ms  (单次约 ${((t3 - t2) / 3).toFixed(0)} ms)`)

// E. findRoot 的 undefined 边界
console.log('\n=== E. findRoot 边界 ===')
const map = new Map([['a', { id: 'a', parent: 'b' }]]) // b 不存在
console.log('  map 里没有 b 时，findRoot(map,"a") =', __test__.findRoot(map, 'a'))
console.log('  => 返回 a 自身，面板会把断链子会话当成根（可接受，但无提示）')
