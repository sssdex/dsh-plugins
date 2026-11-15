/**
 * 全局 fetch 拦截器：把 IM Connect（QQ 通道）发出去的每一条文字回复，
 * 改成「按句拆成几条气泡、中间带停顿」地发。
 *
 * 为什么用拦截而不是改 im-connect 源码：
 *   - 插件装在 profile 的 node_modules 里，改源码会被下一次 pnpm install / 插件更新覆盖；
 *     而官方仓库没有给回复投递留任何 hook（gateway.deliver → channel.send 是写死的）。
 *   - QQ 通道最终只有一种出口：POST https://api.sgroup.qq.com/v2/{users|groups}/{id}/messages。
 *     拦这一层就够，改动全部在本插件内，卸载即完全还原。
 *
 * 同时顺手解决两个必须共享的信息：
 *   1. msg_seq —— 主动接管成全局递增，否则我们额外发的气泡会和适配器自己的计数器撞车
 *      （平台规则：同一个 msg_id + msg_seq 重复发送会直接失败）。
 *   2. msg_id —— 出现在适配器的被动回复里，记下来我们自己的工具也能被动回复（省主动消息配额）。
 *
 * 已知边界：只拦文字（msg_type 0 / 2）。富媒体（msg_type 7）原样放行，只校正 msg_seq。
 */
import { splitBubbles, delayForBubble } from './burst.js'

const MESSAGE_URL = /^https:\/\/api\.sgroup\.qq\.com\/v2\/(users|groups)\/([^/?#]+)\/messages(?:[?#]|$)/

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

function urlOf(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url
  return ''
}

function methodOf(input, init) {
  const raw = init?.method || (input && typeof input === 'object' ? input.method : '')
  return String(raw || 'GET').toUpperCase()
}

export function installQqInterceptor({ state, log = () => {}, config = {}, fetchTarget = globalThis } = {}) {
  const original = fetchTarget.fetch
  if (typeof original !== 'function') throw new Error('全局 fetch 不可用，无法安装 QQ 回复拦截器')
  const maxBubbles = Number(config.maxBubbles) > 0 ? Number(config.maxBubbles) : 3
  const minGapMs = Number(config.minGapMs) >= 0 ? Number(config.minGapMs) : 550
  const maxGapMs = Number(config.maxGapMs) >= minGapMs ? Number(config.maxGapMs) : Math.max(minGapMs, 1450)
  const stats = { seen: 0, burst: 0, bubbles: 0, skipped: 0, failed: 0 }
  let installed = true

  const patched = async function patchedFetch(input, init) {
    const url = urlOf(input)
    if (!installed || methodOf(input, init) !== 'POST' || !url) return original.call(this, input, init)
    const matched = MESSAGE_URL.exec(url)
    if (!matched) return original.call(this, input, init)

    const kind = matched[1] === 'groups' ? 'group' : 'dm'
    const openid = matched[2]
    const key = `${kind}:${openid}`

    let body
    try {
      const raw = init?.body
      if (typeof raw !== 'string') return original.call(this, input, init)
      body = JSON.parse(raw)
    } catch {
      return original.call(this, input, init)
    }
    if (!body || typeof body !== 'object') return original.call(this, input, init)

    stats.seen += 1
    // 适配器带 msg_id 说明这是被动回复：这条 id 对我们也有价值（60 分钟内可复用）。
    if (body.msg_id) state.recordInbound(key, String(body.msg_id))

    const makeInit = (nextBody) => {
      const headers = { ...(init?.headers || {}) }
      // body 变了，旧的 content-length 一定是错的；交给 undici 重算。
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'content-length') delete headers[name]
      }
      return { ...init, headers, body: JSON.stringify(nextBody) }
    }
    const nextSeq = () => state.nextSeq(key)

    // ---- 富媒体 / 其它类型：只校正 seq，行为保持不变 ----
    const msgType = Number(body.msg_type)
    if (msgType !== 0 && msgType !== 2) {
      return original.call(this, input, makeInit({ ...body, msg_seq: nextSeq() }))
    }

    const field = msgType === 2 ? 'markdown' : 'content'
    const content = msgType === 2 ? body.markdown?.content : body.content
    if (typeof content !== 'string' || !content.trim()) {
      return original.call(this, input, makeInit({ ...body, msg_seq: nextSeq() }))
    }

    let bubbles
    try {
      bubbles = splitBubbles(content, { maxBubbles })
    } catch (error) {
      // 拆分本身出问题绝不能连累正常发送。
      log(`[intercept] 拆分失败，原样发送：${error?.message ?? error}`)
      bubbles = [content]
    }
    if (bubbles.length <= 1) {
      const single = { ...body, msg_seq: nextSeq() }
      if (msgType === 2) single.markdown = { ...body.markdown, content: bubbles[0] ?? content }
      else single.content = bubbles[0] ?? content
      if (body.msg_id) state.countReply(String(body.msg_id))
      return original.call(this, input, makeInit(single))
    }

    stats.burst += 1
    stats.bubbles += bubbles.length
    log(`[intercept] 回复拆成 ${bubbles.length} 条气泡发送（上限 ${maxBubbles}）`)

    const signal = init?.signal || undefined
    let firstResponse
    for (let index = 0; index < bubbles.length; index += 1) {
      if (index > 0) {
        if (signal?.aborted) { stats.skipped += 1; break }
        await sleep(delayForBubble(bubbles[index], { minMs: minGapMs, maxMs: maxGapMs, seed: index }), signal)
        if (signal?.aborted) { stats.skipped += 1; break }
      }
      const next = { ...body, msg_seq: nextSeq() }
      if (msgType === 2) next.markdown = { ...body.markdown, content: bubbles[index] }
      else next.content = bubbles[index]

      const response = await original.call(this, input, makeInit(next))
      if (!response.ok) {
        stats.failed += 1
        if (index === 0) {
          // 第一条就被拒：把平台的拒绝原样交回去，让 im-connect 自己走降级/重试逻辑。
          return response
        }
        // 后面的气泡失败：前面已经送达，不能整条重发（会重复）。
        log(`[intercept] 第 ${index + 1}/${bubbles.length} 条气泡发送失败（HTTP ${response.status}），已送达的不再重发`)
        break
      }
      if (body.msg_id) state.countReply(String(body.msg_id))
      if (index === 0) {
        firstResponse = response
        continue
      }
      // 中间气泡的响应体没人读，主动排空，避免连接泄漏。
      await response.arrayBuffer().catch(() => undefined)
    }
    return firstResponse ?? original.call(this, input, makeInit({ ...body, msg_seq: nextSeq() }))
  }

  fetchTarget.fetch = patched

  return {
    stats,
    dispose() {
      installed = false
      if (fetchTarget.fetch === patched) fetchTarget.fetch = original
    },
  }
}
