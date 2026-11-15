/**
 * 表情包检索：复用 dsh-meme 已经装好的图库（它是本机唯一有中文 caption 的图库）。
 *
 * 图库结构（实测）：
 *   <dsh-meme>/memes/<packId>/manifest.json
 *   <dsh-meme>/memes/<packId>/memes/<tag>/<file>.jpg
 *   <dsh-meme>/memes/<packId>/index.db   ← sqlite，表 memes(path, tag, file_name, caption, keywords, ...)
 *
 * caption / keywords 是中文的，所以「发张生气的表情」这种话能直接命中。
 * node:sqlite 在 Node 22.5+ 才有；宿主版本不确定，所以做成可选依赖：
 * 拿不到就退回「目录 tag + 文件名」匹配，功能不至于整块失效。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

/** 额外的手工图库目录：主人自己往里丢图，按子目录名当 tag。 */
export const CUSTOM_MEME_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'memes')

function safeDirs() {
  const dirs = []
  if (process.env.DSH_MEME_DIR) dirs.push(process.env.DSH_MEME_DIR)
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  dirs.push(path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-meme', 'memes'))
  dirs.push(CUSTOM_MEME_DIR)
  return [...new Set(dirs)]
}

function listPacks() {
  const packs = []
  for (const dir of safeDirs()) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      packs.push({ id: entry.name, dir: path.join(dir, entry.name) })
    }
  }
  return packs
}

async function openSqlite(file) {
  try {
    const mod = await import('node:sqlite')
    const DatabaseSync = mod.DatabaseSync || mod.default?.DatabaseSync
    if (!DatabaseSync) return null
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

/** 目录扫描兜底：没有 sqlite 时也能按 tag / 文件名找图。 */
function scanFiles(pack) {
  const rows = []
  const root = path.join(pack.dir, 'memes')
  let tags = []
  try { tags = fs.readdirSync(root, { withFileTypes: true }) } catch { return rows }
  for (const tagEntry of tags) {
    if (!tagEntry.isDirectory()) continue
    const tagDir = path.join(root, tagEntry.name)
    let files = []
    try { files = fs.readdirSync(tagDir, { withFileTypes: true }) } catch { continue }
    for (const file of files) {
      if (!file.isFile()) continue
      const ext = path.extname(file.name).toLowerCase()
      if (!IMAGE_EXT.has(ext)) continue
      rows.push({
        pack: pack.id,
        tag: tagEntry.name,
        file: path.join(tagDir, file.name),
        name: file.name,
        caption: '',
        keywords: '',
      })
    }
  }
  return rows
}

let cache = { at: 0, rows: [] }

async function loadRows({ ttlMs = 60_000 } = {}) {
  if (cache.rows.length && Date.now() - cache.at < ttlMs) return cache.rows
  const rows = []
  for (const pack of listPacks()) {
    const dbFile = path.join(pack.dir, 'index.db')
    let usedDb = false
    if (fs.existsSync(dbFile)) {
      const db = await openSqlite(dbFile)
      if (db) {
        try {
          const list = db.prepare('select path, tag, file_name, caption, keywords from memes').all()
          for (const row of list) {
            const file = path.join(pack.dir, String(row.path || '').replace(/\//g, path.sep))
            if (!row.path || !fs.existsSync(file)) continue
            rows.push({
              pack: pack.id,
              tag: String(row.tag || ''),
              file,
              name: String(row.file_name || ''),
              caption: String(row.caption || ''),
              keywords: String(row.keywords || ''),
            })
          }
          usedDb = true
        } catch {
          usedDb = false
        } finally {
          try { db.close() } catch { /* 已经关了 */ }
        }
      }
    }
    if (!usedDb) rows.push(...scanFiles(pack))
  }
  cache = { at: Date.now(), rows }
  return rows
}

/** 拆词：中文按 2 字滑窗、英文按空格，和 dsh-meme 的检索思路保持一致。 */
function tokens(query) {
  const text = String(query || '').toLowerCase().trim()
  if (!text) return []
  const out = new Set()
  for (const part of text.split(/[\s,，、/]+/).filter(Boolean)) {
    out.add(part)
    if (/^[\u4e00-\u9fa5]+$/.test(part)) {
      for (let i = 0; i < part.length - 1; i += 1) out.add(part.slice(i, i + 2))
    }
  }
  return [...out]
}

export async function searchMemes(query, { limit = 8 } = {}) {
  const rows = await loadRows()
  if (!rows.length) return []
  const words = tokens(query)
  if (!words.length) {
    // 没给关键词就随机给几张，让调用方自己挑。
    const shuffled = [...rows].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, Math.max(1, limit))
  }
  const scored = []
  for (const row of rows) {
    const haystack = `${row.tag} ${row.name} ${row.caption} ${row.keywords}`.toLowerCase()
    let score = 0
    for (const word of words) {
      if (row.tag.toLowerCase() === word) score += 6
      if (row.name.toLowerCase().includes(word)) score += 3
      if (row.keywords.toLowerCase().includes(word)) score += 2
      if (row.caption.toLowerCase().includes(word)) score += 2
      if (haystack.includes(word)) score += 1
    }
    if (score > 0) scored.push({ row, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, limit)).map((item) => item.row)
}

export async function memeLibraryInfo() {
  const rows = await loadRows()
  const packs = [...new Set(rows.map((row) => row.pack))]
  const tags = [...new Set(rows.map((row) => row.tag))].filter(Boolean).sort()
  return { count: rows.length, packs, tags }
}

export function resetMemeCache() {
  cache = { at: 0, rows: [] }
}
