/**
 * QQ 官方机器人 API 客户端（单聊 / 群聊）。
 *
 * 只用官方 v2 接口，实测通过：
 *   - 取 token：POST https://bots.qq.com/app/getAppAccessToken
 *   - 发文字：POST /v2/users/{openid}/messages  { content, msg_type: 0, msg_seq }
 *   - 发 Markdown：同上，{ markdown: { content }, msg_type: 2 }
 *   - 发富媒体：先 POST /v2/users/{openid}/files 传二进制（≤5MB）拿 file_info，
 *              再发 { media: { file_info }, msg_type: 7 }
 *   - 大文件：upload_prepare → 分片 PUT 预签名 URL → upload_part_finish → /files 带 upload_id 合并
 *
 * 两条平台硬规则（官方文档「消息收发概述」）决定了实现方式：
 *   1. 被动回复（带 msg_id）单聊只有 60 分钟窗口，同一条用户消息最多回 4 次；
 *      所以要限气泡数、并且要记账，超了自动改用主动消息。
 *   2. 主动消息（不带 msg_id）单聊每天 1000 条/用户，单关系 20 条/分钟。
 *      用户能在客户端关掉「允许主动发送」，失败时要给出可理解的提示。
 */
import crypto from 'node:crypto'
import { splitBubbles, delayForBubble } from './burst.js'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API = 'https://api.sgroup.qq.com'
/** 二进制直传上限，官方文档写 5M；留一点余量给 base64 与 json 开销。 */
const DIRECT_UPLOAD_LIMIT = 5 * 1024 * 1024 - 64 * 1024
/** 硬上限 200MB，超过平台会直接报 850031。 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
/** md5_10m 的定义是「前 10002432 字节」，不是 10MB，别算错。 */
const TEN_MB_CHUNK = 10002432
const CODE_POINT_MAX = 1900

export class QqApiError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'QqApiError'
    if (detail.status !== undefined) this.status = detail.status
    if (detail.code !== undefined) this.errCode = detail.code
    if (detail.body !== undefined) this.body = detail.body
  }
}

function errCodeOf(payload) {
  if (!payload || typeof payload !== 'object') return undefined
  for (const key of ['code', 'err_code']) {
    const value = payload[key]
    if (typeof value === 'number' && value !== 0) return value
    if (typeof value === 'string' && value !== '' && value !== '0' && !Number.isNaN(Number(value))) return Number(value)
  }
  return undefined
}

function combineSignals(...signals) {
  const usable = signals.filter(Boolean)
  if (!usable.length) return undefined
  if (usable.length === 1) return usable[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(usable)
  return usable[0]
}

/** 富媒体类型判定：先看魔数再看扩展名，改过名的文件才不会传错类型。 */
export function mediaFileType(name, data) {
  const head = data.subarray(0, 16)
  const ascii = (offset, text) => head.length >= offset + text.length
    && [...text].every((char, index) => head[offset + index] === char.charCodeAt(0))
  const isPng = head[0] === 0x89 && ascii(1, 'PNG')
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  const isGif = ascii(0, 'GIF8')
  const isWebp = ascii(0, 'RIFF') && ascii(8, 'WEBP')
  const isSilk = data.length > 10 && data[0] === 0x02 && ascii(1, '#!SILK')
  if (isSilk) return 3
  if (isPng || isJpeg || isGif || isWebp) return 1
  if (ascii(4, 'ftyp')) return 2
  const ext = (/\.[^.]+$/.exec(name || '')?.[0] || '').toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return 1
  if (['.mp4'].includes(ext)) return 2
  if (['.silk', '.slk'].includes(ext)) return 3
  return 4
}

export function createQqClient({ appId, appSecret, fetchImpl, log = () => {}, state }) {
  if (typeof fetchImpl !== 'function') throw new Error('createQqClient 需要 fetchImpl')
  let token = ''
  let tokenExpireAt = 0
  let refreshing

  async function accessToken() {
    if (token && Date.now() < tokenExpireAt) return token
    if (refreshing) return refreshing
    refreshing = (async () => {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      let payload
      try { payload = JSON.parse(text) } catch { throw new QqApiError(`QQ 取 token 返回非 JSON：HTTP ${res.status} ${text.slice(0, 160)}`, { status: res.status }) }
      if (!res.ok || !payload?.access_token) {
        throw new QqApiError(`QQ 取 token 失败：HTTP ${res.status} ${payload?.message ?? text.slice(0, 160)}`, { status: res.status, body: payload })
      }
      token = payload.access_token
      // 提前 5 分钟过期，避免正好卡在边界上被 401。
      tokenExpireAt = Date.now() + Math.max(60, (Number(payload.expires_in) || 7200) - 300) * 1000
      return token
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  async function api(pathname, { method = 'POST', body, signal, timeoutMs = 60_000 } = {}) {
    const doRequest = async () => {
      const bearer = await accessToken()
      return fetchImpl(`${API}${pathname}`, {
        method,
        headers: {
          Authorization: `QQBot ${bearer}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combineSignals(signal, AbortSignal.timeout(timeoutMs)),
      })
    }
    let res = await doRequest()
    if (res.status === 401) {
      // token 可能被吊销或时钟漂移提前失效：清缓存重取一次。
      token = ''
      tokenExpireAt = 0
      await res.arrayBuffer().catch(() => undefined)
      res = await doRequest()
    }
    const text = await res.text()
    let payload
    try { payload = text ? JSON.parse(text) : {} } catch { payload = undefined }
    if (!res.ok) {
      const code = errCodeOf(payload)
      throw new QqApiError(`QQ 接口 ${pathname} 失败：HTTP ${res.status} ${text.slice(0, 200)}`, { status: res.status, code, body: payload })
    }
    const code = errCodeOf(payload)
    if (code !== undefined) {
      throw new QqApiError(`QQ 接口 ${pathname} 被拒绝：err_code=${code}`, { status: res.status, code, body: payload })
    }
    return payload
  }

  /** 群聊 / 单聊的资源前缀。chat 参数支持 'dm' 或 'group:<openid>'。 */
  function targetOf(chat, defaultOpenid) {
    const raw = String(chat || '').trim()
    if (!raw || raw === 'dm' || raw === 'c2c') return { kind: 'dm', openid: defaultOpenid, key: `dm:${defaultOpenid}` }
    if (raw.startsWith('group:')) {
      const openid = raw.slice('group:'.length).trim()
      if (!openid) throw new Error('group 后必须跟群 openid，例如 group:ABC123')
      return { kind: 'group', openid, key: `group:${openid}` }
    }
    throw new Error(`不认识的会话类型 ${raw}，只支持 dm 或 group:<openid>`)
  }

  function rootOf(target) {
    return target.kind === 'group' ? `/v2/groups/${target.openid}` : `/v2/users/${target.openid}`
  }

  function md5(data) { return crypto.createHash('md5').update(data).digest('hex') }
  function sha1(data) { return crypto.createHash('sha1').update(data).digest('hex') }

  /**
   * 上传富媒体拿 file_info。≤5MB 走二进制直传，更大走分片。
   * 返回值里的 ttl 是 file_info 的有效期，过期要重传（调用方直接用一次就好）。
   */
  async function upload(target, { fileType, name, data, signal }) {
    if (!data?.length) throw new Error('上传内容为空')
    if (data.length > MAX_UPLOAD_BYTES) {
      throw new Error(`文件 ${(data.length / 1024 / 1024).toFixed(1)}MB 超过 QQ 200MB 上限`)
    }
    const root = rootOf(target)
    const fileName = name || 'file.bin'

    if (data.length <= DIRECT_UPLOAD_LIMIT) {
      const payload = await api(`${root}/files`, {
        method: 'POST',
        signal,
        body: {
          file_type: fileType,
          file_name: fileName,
          file_data: data.toString('base64'),
          srv_send_msg: false,
        },
      })
      if (!payload?.file_info) throw new QqApiError('QQ 上传未返回 file_info', { body: payload })
      return payload
    }

    // ---- 分片上传 ----
    log(`[qq] 大文件 ${(data.length / 1024 / 1024).toFixed(1)}MB 走分片上传`)
    const prepare = await api(`${root}/upload_prepare`, {
      method: 'POST',
      signal,
      timeoutMs: 120_000,
      body: {
        file_type: fileType,
        file_size: String(data.length),
        file_name: fileName,
        md5: md5(data),
        sha1: sha1(data),
        md5_10m: md5(data.subarray(0, Math.min(TEN_MB_CHUNK, data.length))),
      },
    })
    const uploadId = prepare?.upload_id
    const parts = Array.isArray(prepare?.parts) ? prepare.parts : []
    if (!uploadId || !parts.length) throw new QqApiError('QQ 分片预上传未返回 upload_id/parts', { body: prepare })

    let offset = 0
    for (const part of parts) {
      signal?.throwIfAborted()
      const blockSize = Number(part.block_size) || Math.ceil(data.length / parts.length)
      const chunk = data.subarray(offset, offset + blockSize)
      if (!chunk.length) break
      // 预签名 URL 是 S3 风格：不能带 Authorization，带了反而签名不匹配。
      const put = await fetchImpl(part.presigned_url, {
        method: 'PUT',
        body: chunk,
        signal: combineSignals(signal, AbortSignal.timeout(180_000)),
      })
      if (!put.ok) {
        const detail = await put.text().catch(() => '')
        throw new QqApiError(`QQ 分片 ${part.index} 上传失败：HTTP ${put.status} ${detail.slice(0, 160)}`, { status: put.status })
      }
      await put.arrayBuffer().catch(() => undefined)
      await api(`${root}/upload_part_finish`, {
        method: 'POST',
        signal,
        timeoutMs: 120_000,
        body: {
          upload_id: uploadId,
          part_index: Number(part.index),
          block_size: String(chunk.length),
          md5: md5(chunk),
        },
      })
      offset += chunk.length
    }
    if (offset < data.length) throw new Error(`分片没传完（${offset}/${data.length} 字节），QQ 预上传给的分片信息不完整`)

    const payload = await api(`${root}/files`, {
      method: 'POST',
      signal,
      timeoutMs: 180_000,
      body: { file_type: fileType, srv_send_msg: false, file_name: fileName, upload_id: uploadId },
    })
    if (!payload?.file_info) throw new QqApiError('QQ 合并分片后未返回 file_info', { body: payload })
    return payload
  }

  /**
   * 决定这次用被动还是主动：
   * 宫格逻辑在 state.passiveBudget —— 窗口过期或次数用完就必须走主动消息。
   */
  function chooseMsgId(target, mode) {
    if (mode === 'active') return ''
    const budget = state.passiveBudget(target.key)
    if (mode === 'passive') {
      if (!budget.remaining) {
        throw new Error(
          budget.msgId
            ? '这条用户消息的被动回复额度已用完（单聊最多 4 次 / 60 分钟内）。等主人再发一句，或改用主动消息。'
            : '当前没有可用的被动回复凭据（需要主人先在 QQ 里发一句话）。',
        )
      }
      return budget.msgId
    }
    // auto：能被动就被动（省配额、走回复气泡更像真人）
    return budget.remaining > 0 ? budget.msgId : ''
  }

  async function postMessage(target, { body, msgId, signal }) {
    const seq = state.nextSeq(target.key)
    const payload = {
      ...body,
      msg_seq: seq,
      ...(msgId ? { msg_id: msgId } : {}),
    }
    const result = await api(`${rootOf(target)}/messages`, { method: 'POST', body: payload, signal })
    if (msgId) state.countReply(msgId)
    return { result, seq, msgId }
  }

  /**
   * 发文字。burst=true 时按句拆成多条气泡（像真人在连发），
   * 条数受 maxBubbles 限制 —— 单聊被动回复最多次 4 条，默认只给 3 条留余量。
   */
  async function sendText(target, text, options = {}) {
    const {
      markdown = false,
      mode = 'auto',
      wakeup = false,
      burst = true,
      maxBubbles = 3,
      minGapMs = 550,
      maxGapMs = 1450,
      signal,
      seed = 0,
    } = options
    const content = String(text ?? '')
    if (!content.trim()) return { ok: true, bubbles: 0, skipped: true }

    const bubbles = burst && content.length > 12
      ? splitBubbles(content, { maxBubbles, maxCodepoints: CODE_POINT_MAX })
      : [content]
    const msgId = chooseMsgId(target, mode)
    const sent = []
    for (let index = 0; index < bubbles.length; index += 1) {
      signal?.throwIfAborted()
      const bubble = bubbles[index]
      if (index > 0) {
        const gap = delayForBubble(bubble, { minMs: minGapMs, maxMs: maxGapMs, seed: seed + index })
        await new Promise((resolve) => setTimeout(resolve, gap))
        signal?.throwIfAborted()
      }
      const body = markdown
        ? { msg_type: 2, markdown: { content: bubble } }
        : { msg_type: 0, content: bubble }
      if (wakeup && !msgId) body.is_wakeup = true
      try {
        const posted = await postMessage(target, { body, msgId, signal })
        sent.push(posted.seq)
        state.bump('text')
        if (index > 0) state.bump('bubbles')
        if (msgId) state.bump('passive'); else state.bump('active')
      } catch (error) {
        state.bump('failed')
        // err_code 存在 payload 里，QqApiError 上叫 errCode；只有「平台明确拒绝」才值得退回纯文本。
        if (markdown && error instanceof QqApiError && error.errCode !== undefined) {
          // Markdown 权限被拒时退回纯文本，别让整条消息发不出去。
          log(`[qq] Markdown 被拒（err_code=${error.errCode}），本气泡改发纯文本`)
          const retryBody = { msg_type: 0, content: bubble }
          const posted = await postMessage(target, { body: retryBody, msgId, signal })
          sent.push(posted.seq)
          continue
        }
        if (sent.length) {
          // 已经送出过气泡：不能整条重发，否则用户会看到重复。
          throw Object.assign(new Error(`第 ${index + 1}/${bubbles.length} 条发送失败，前面的已经送达：${error?.message ?? error}`), { partial: true, cause: error })
        }
        throw error
      }
    }
    return { ok: true, bubbles: bubbles.length, seqs: sent, msgId }
  }

  /** 发富媒体（图片 / 语音 / 视频 / 文件共用一条路径）。 */
  async function sendMedia(target, { fileType, name, data, mode = 'auto', wakeup = false, signal }) {
    const uploaded = await upload(target, { fileType, name, data, signal })
    const msgId = chooseMsgId(target, mode)
    const body = { msg_type: 7, media: { file_info: uploaded.file_info } }
    if (wakeup && !msgId) body.is_wakeup = true
    const posted = await postMessage(target, { body, msgId, signal })
    return { fileInfo: uploaded.file_info, ttl: uploaded.ttl, seq: posted.seq, msgId: posted.msgId }
  }

  async function rememberInbound(target, msgId) {
    state.recordInbound(target.key, msgId)
  }

  return {
    appId,
    target: targetOf,
    rootOf,
    accessToken,
    api,
    upload,
    sendText,
    sendMedia,
    rememberInbound,
    mediaFileType,
  }
}
