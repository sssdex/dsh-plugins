#!/usr/bin/env node
// 审计脚本：专门验证 dsh-token-tree 的已知/疑似缺陷。
//   node audit.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { __test__ } from './index.js'

const { frameOffsets, decodeLog, foldSession, buildTree, findRoot } = __test__
const HOME = process.env.DSH_HOME || 'D:\\DeepSeek-DSH'
const SESSIONS = path.join(HOME, 'sessions')

const problems = []
const ok = []

function report(level, title, detail) {
  if (level === 'BAD') problems.push({ level, title, detail })
  else ok.push({ level, title, detail })
  console.log(`[${level}] ${title}${detail ? '  — ' + detail : ''}`)
}

function readRaw(f) {
  const raw = fs.readFileSync(f)
  const parts = []
  for (const [a, b] of frameOffsets(raw)) {
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8'))
    } catch {}
  }
  return parts.join('')
}

/* ---------------------------------------------------------------- 1. 漏算类 */
// usage 里有哪些字段？我们是否漏了 provider 上报但没计入的 key？
{
  const keys = new Map()
  let samples = 0
  let missingReasoning = 0
  let withReasoningKey = 0
  const dirs = fs.readdirSync(SESSIONS, { withFileTypes: true })
  outer: for (const ws of dirs) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(SESSIONS, ws.name)
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const f = path.join(wsDir, sd.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      let text
      try {
        text = readRaw(f)
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let e
        try {
          e = JSON.parse(line)
        } catch {
          continue
        }
        if (e.type === 'assistant/message' && e.data?.usage) {
          samples++
          const u = e.data.usage
          for (const k of Object.keys(u)) keys.set(k, (keys.get(k) || 0) + 1)
          if ('reasoningTokens' in u) withReasoningKey++
          else missingReasoning++
        }
      }
      if (samples > 3000) break outer
    }
    if (samples > 3000) break
  }
  console.log('\n=== 1. usage 字段覆盖 ===')
  console.log('抽样 assistant/message.usage 条数:', samples)
  console.log('出现过的 key:', JSON.stringify([...keys.entries()]))
  report('INFO', 'usage key 集合', [...keys.keys()].join(', '))
  if (missingReasoning > 0) {
    report('WARN', `有 ${missingReasoning}/${samples} 条 usage 不含 reasoningTokens`, '这部分推理 token 计为 0，可能低估')
  }
}

/* ---------------------------------------------------------- 2. 缺失文件类 */
// 父会话的 subagent/catalog 指向的子会话，在磁盘上是否都能找到？
{
  console.log('\n=== 2. catalog 子会话是否都能找到 ===')
  const all = new Map() // id -> {file}
  const parents = []
  for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(SESSIONS, ws.name)
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const f = path.join(wsDir, sd.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      all.set(sd.name, { file: f, ws: ws.name })
    }
  }
  let catalogRefs = 0
  let catalogMissing = 0
  const missingIds = []
  for (const [id, meta] of all) {
    let text
    try {
      text = readRaw(meta.file)
    } catch {
      continue
    }
    const heads = text.split('\n').filter(Boolean)
    // 只取有 header 会话文件
    const hasHeader = heads.some((l) => l.includes('"type":"session"'))
    if (!hasHeader) continue
    for (const line of heads) {
      if (!line.includes('"subagent/catalog"')) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      const cid = e.data?.childId
      if (typeof cid === 'string' && cid) {
        catalogRefs++
        if (!all.has(cid)) {
          catalogMissing++
          if (missingIds.length < 8) missingIds.push({ parent: id, child: cid })
        }
      }
    }
  }
  report(
    catalogMissing === 0 ? 'OK' : 'BAD',
    `catalog 引用 ${catalogRefs} 个子会话，磁盘缺失 ${catalogMissing}`,
    catalogMissing ? JSON.stringify(missingIds) : '全部能找到',
  )
  parents.length = 0
}

/* ------------------------------------------------------ 3. parent 断链类 */
// parentSession 指向的会话，磁盘上是否还在？（决定树根上溯是否会截断）
{
  console.log('\n=== 3. parentSession 断链 ===')
  const recs = new Map()
  for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(SESSIONS, ws.name)
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const f = path.join(wsDir, sd.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      let text
      try {
        text = readRaw(f)
      } catch {
        continue
      }
      const first = text.split('\n').find((l) => l.includes('"type":"session"'))
      if (!first) continue
      let h
      try {
        h = JSON.parse(first)
      } catch {
        continue
      }
      recs.set(h.id, { parent: h.parentSession || null, origin: h.origin || 'root' })
    }
  }
  let orphans = 0
  const orphanList = []
  for (const [id, r] of recs) {
    if (r.parent && !recs.has(r.parent)) {
      orphans++
      if (orphanList.length < 8) orphanList.push({ id: id.slice(0, 24), missingParent: r.parent.slice(0, 24), origin: r.origin })
    }
  }
  report(
    orphans === 0 ? 'OK' : 'BAD',
    `${recs.size} 个会话中，parentSession 指向不存在会话的有 ${orphans} 个`,
    orphans ? JSON.stringify(orphanList) : '无断链',
  )
  report(
    'INFO',
    '断链后果',
    '这些子会话的 findRoot 会返回自己，面板会把它们当成"根"，看不到真正的父树',
  )
}

/* ------------------------------------------------------------ 4. 重复计数类 */
// 同一个 session id 是否在多个 workspace 目录下各存一份？（会重复统计）
{
  console.log('\n=== 4. 同一 sessionId 是否重复存放 ===')
  const seen = new Map()
  for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(SESSIONS, ws.name)
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const f = path.join(wsDir, sd.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      if (!seen.has(sd.name)) seen.set(sd.name, [])
      seen.get(sd.name).push(ws.name)
    }
  }
  const dups = [...seen.entries()].filter(([, v]) => v.length > 1)
  report(
    dups.length === 0 ? 'OK' : 'BAD',
    `重复 sessionId: ${dups.length}`,
    dups.length ? JSON.stringify(dups.slice(0, 5)) : '无重复',
  )
  report('INFO', '影响', 'scan() 用 Map<id, rec>，重复时后写入的覆盖前者，不会双计；但会随机选一份日志')
}

/* --------------------------------------------------- 5. 同名/无 title 类 */
{
  console.log('\n=== 5. 标题缺失率 ===')
  let total = 0
  let noTitle = 0
  for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(SESSIONS, ws.name)
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const f = path.join(wsDir, sd.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      let text
      try {
        text = readRaw(f)
      } catch {
        continue
      }
      const events = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line))
        } catch {}
      }
      const rec = foldSession(sd.name, events)
      total++
      if (!rec.title) noTitle++
    }
  }
  report(noTitle === 0 ? 'OK' : 'WARN', `${total} 个会话中无标题 ${noTitle}`, `面板会退化成显示 session id 前 24 字符`)
}

/* ------------------------------------------------- 6. 真·树根判定正确性 */
{
  console.log('\n=== 6. 从子会话上溯树根 ===')
  const all = new Map()
  for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(SESSIONS, ws.name)
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const f = path.join(wsDir, sd.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      let text
      try {
        text = readRaw(f)
      } catch {
        continue
      }
      const first = text.split('\n').find((l) => l.includes('"type":"session"'))
      if (!first) continue
      let h
      try {
        h = JSON.parse(first)
      } catch {
        continue
      }
      all.set(h.id, { parent: h.parentSession || null, origin: h.origin || 'root' })
    }
  }
  const children = [...all.entries()].filter(([, r]) => r.parent)
  let correct = 0
  let wrong = 0
  for (const [id, r] of children.slice(0, 200)) {
    const root = findRoot(all, id)
    if (root === r.parent || (root && !all.get(root)?.parent)) correct++
    else wrong++
  }
  report(wrong === 0 ? 'OK' : 'BAD', `抽样 ${Math.min(200, children.length)} 个子会话上溯，错误 ${wrong}`)
}

/* --------------------------------------------- 7. 缓存失效：写入中的会话 */
{
  console.log('\n=== 7. 正在写入的会话（尾部半帧） ===')
  // 找 mtime 最近的几个，检查最后一帧能否解压
  const files = []
  for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(SESSIONS, ws.name)
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const f = path.join(wsDir, sd.name, 'session.v4.jsonl.zstd')
      if (fs.existsSync(f)) files.push({ f, m: fs.statSync(f).mtimeMs })
    }
  }
  files.sort((a, b) => b.m - a.m)
  const top = files.slice(0, 5)
  let badFrames = 0
  for (const { f } of top) {
    const raw = fs.readFileSync(f)
    const offs = frameOffsets(raw)
    const last = offs[offs.length - 1]
    if (!last) continue
    try {
      zlib.zstdDecompressSync(raw.subarray(last[0], last[1]))
    } catch {
      badFrames++
      console.log(`  最后帧不可解: ${path.basename(path.dirname(f)).slice(0, 30)}`)
    }
  }
  report('INFO', `最近 ${top.length} 个会话中，最后帧不可解 ${badFrames}`, 'decodeLog 会跳过它，属于预期行为')
}

console.log('\n================ 汇总 ================')
console.log(`可疑/确认问题: ${problems.length}`)
for (const p of problems) console.log(`  [${p.level}] ${p.title}${p.detail ? ' — ' + p.detail : ''}`)
