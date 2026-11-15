/**
 * 发送状态账本：所有「跨进程要知道的计数」都放这里。
 *
 * 为什么要落盘而不是只放内存：
 *   - QQ 被动回复的去重键是 `msg_id + msg_seq`，同一个组合重复发送会直接失败。
 *     宿主重启后如果 seq 从 0 重新数，很可能撞上重启前用过的组合，用户就会看到「发送失败」。
 *   - 主动消息每天有配额（单聊 1000 条/用户），统计一下至少能在日志里看出异常。
 *   - `lastMsgId` 是「还能不能被动回复」的唯一凭据（单聊 60 分钟有效、每条最多回 4 次），
 *     重启后还要继续用，否则只能走主动消息、白白消耗配额。
 */
import fs from 'node:fs'
import path from 'node:path'

const FLUSH_DELAY_MS = 400

function emptyState() {
  return {
    version: 1,
    targets: {},
    replies: {},
    stats: { text: 0, image: 0, voice: 0, file: 0, bubbles: 0, active: 0, passive: 0, failed: 0 },
  }
}

/** 原子写：先写临时文件再 rename，避免宿主被杀时留下半截 JSON。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function createState(file, log = () => {}) {
  let data = emptyState()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object') {
      data = {
        ...emptyState(),
        ...raw,
        targets: raw.targets && typeof raw.targets === 'object' ? raw.targets : {},
        replies: raw.replies && typeof raw.replies === 'object' ? raw.replies : {},
        stats: { ...emptyState().stats, ...(raw.stats || {}) },
      }
    }
  } catch (error) {
    // 文件不存在是首次启动的正常情况；损坏就换一份新的，但要说清楚。
    if (error?.code !== 'ENOENT') log(`[state] 读取失败，改用空账本：${error?.message ?? error}`)
  }

  let timer
  const flush = () => {
    timer = undefined
    try {
      writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
    } catch (error) {
      log(`[state] 写入失败：${error?.message ?? error}`)
    }
  }
  const save = () => {
    if (timer) return
    timer = setTimeout(flush, FLUSH_DELAY_MS)
    // 宿主退出时不一定还有机会等 setTimeout，unref 让进程不被它拖住。
    timer.unref?.()
  }

  const targetOf = (key) => {
    const existing = data.targets[key]
    if (existing && typeof existing === 'object') {
      existing.seq ??= 0
      existing.lastMsgId ??= ''
      existing.lastMsgAt ??= 0
      return existing
    }
    const fresh = { seq: 0, lastMsgId: '', lastMsgAt: 0 }
    data.targets[key] = fresh
    return fresh
  }

  return {
    file,
    get raw() { return data },
    target: targetOf,

    /** 每条真正发出去的消息都必须拿一个全局递增的 seq。 */
    nextSeq(key) {
      const target = targetOf(key)
      target.seq = Number(target.seq || 0) + 1
      save()
      return target.seq
    },

    /** 记住最近一条用户消息，被动回复窗口就靠它。 */
    recordInbound(key, msgId) {
      if (!msgId) return
      const target = targetOf(key)
      target.lastMsgId = msgId
      target.lastMsgAt = Date.now()
      data.replies[msgId] = 0
      // 只留最近 20 条的消息计数器，别让文件无限长。
      const ids = Object.keys(data.replies)
      if (ids.length > 20) for (const id of ids.slice(0, ids.length - 20)) delete data.replies[id]
      save()
    },

    /** 被动回复次数记账：单聊上限 4 次，超了就只能走主动消息。 */
    countReply(msgId) {
      if (!msgId) return 0
      const next = Number(data.replies[msgId] || 0) + 1
      data.replies[msgId] = next
      save()
      return next
    },

    replyCount(msgId) {
      return Number(data.replies[msgId] || 0)
    },

    /** 被动回复还剩几次；凭据过期或没凭据就返回 0。 */
    passiveBudget(key, { ttlMs = 55 * 60 * 1000, limit = 3 } = {}) {
      const target = targetOf(key)
      if (!target.lastMsgId) return { msgId: '', remaining: 0, ageMs: Infinity }
      const ageMs = Date.now() - Number(target.lastMsgAt || 0)
      if (ageMs > ttlMs) return { msgId: target.lastMsgId, remaining: 0, ageMs }
      const used = this.replyCount(target.lastMsgId)
      return { msgId: target.lastMsgId, remaining: Math.max(0, limit - used), ageMs }
    },

    bump(field, by = 1) {
      data.stats[field] = Number(data.stats[field] || 0) + by
      save()
    },

    flush,
  }
}
