/**
 * dsh-thinking-guard —�?把被塞进「正文」里的思考还原成 reasoning 块�? *
 * 症状：用第三方中转（或某些模型）时，模型会把思考用 `<thinking>�?/thinking>`
 * 直接写在 content 里。DSH �?pi-ai 适配层只�?`reasoning_content` 字段�? * 认不出这段标签，于是它变成普�?`text` �?—�?用户看到的「最终答案」就是思考�? *
 * 实测�?5 个会话里�?14 个中招；同一块里常见「思�?+ 正文」连在一起：
 *   "<thinking>Now write the reply �?一句话接茬 + �?+ 简短延伸�?/thinking> 哦—�?
 *
 * 修法：挂 `llm/stream` waterfall，流式地�?text 通道按标签切�? * reasoning / text 两条通道，各自发 block-start / *-delta / block-end�? *
 *  - 标签可能�?TCP/SSE 分片切开 �?用「保留尾巴」策略（最多多�?len(tag)-1 字符�? *  - 开标签前的空白：确认是思考后直接丢掉，避免产出一个只有空白的 text �? *  - 标签没闭合就断流：整段按 reasoning 处理（数据不丢，只是不算正文�? *  - strip 模式：直接丢掉思考段，正文更干净
 *  - 任何异常：回落成原样透传，绝不吞内容
 */
const OPEN_DEFAULT = '<thinking>'
const CLOSE_DEFAULT = '</thinking>'
const WS_RE = /^[\s\u200b\ufeff]+/
const MAX_WS = 4096
const FRESH_BASE = 1_000_000

export const name = 'dsh-thinking-guard'
export const inject = []

/** 小工具：把源流整体包一层�?*/
function makeStream(source, opt) {
  const { openTag, closeTag, strip } = opt
  const openLower = openTag.toLowerCase()
  const closeLower = closeTag.toLowerCase()
  const openKeep = Math.max(0, openLower.length - 1)
  const closeKeep = Math.max(0, closeLower.length - 1)

  const lanes = new Map() // 原始 index -> lane
  const foreign = new Set() // �?text 块（tool-call 等）�?index
  const pending = []
  let fresh = FRESH_BASE
  let openLane = null

  function push(c) {
    pending.push(c)
  }
  function laneOf(i) {
    let L = lanes.get(i)
    if (L === undefined) {
      L = {
        orig: i,
        held: null, // 上游�?block-start{blockType:'text'}，先扣着
        out: [], // 我发出去的块（按发出顺序�?        emitted: false,
        dropped: false,
        ws: '',
        carry: '',
        mode: 'lead',
        textIdx: null,
      }
      lanes.set(i, L)
    }
    return L
  }
  function openOut(L, kind) {
    let index
    if (!L.emitted) {
      index = L.orig
      if (kind === 'reasoning') {
        // 上游�?text 声明过，这里必须重新声明�?reasoning
        push({ type: 'block-start', index, blockType: 'reasoning' })
        L.held = null
      } else if (L.held !== null) {
        push(L.held)
        L.held = null
      } else {
        push({ type: 'block-start', index, blockType: 'text' })
      }
    } else {
      index = fresh++
      push({ type: 'block-start', index, blockType: kind })
    }
    L.emitted = true
    const rec = { kind, index, text: '', closed: false }
    L.out.push(rec)
    if (kind === 'text') L.textIdx = index
    return rec
  }
  function routeReasoning(L, s) {
    if (s === '') return
    if (strip) {
      L.dropped = true
      return
    }
    const rec = L.out.at(-1)?.kind === 'reasoning' ? L.out.at(-1) : openOut(L, 'reasoning')
    rec.text += s
    push({ type: 'reasoning-delta', index: rec.index, text: s })
  }
  function routeText(L, s) {
    if (s === '') return
    const rec = L.out.at(-1)?.kind === 'text' && L.textIdx !== null ? L.out.at(-1) : openOut(L, 'text')
    rec.text += s
    push({ type: 'text-delta', index: rec.index, text: s })
  }

  /** 扫描器：把一段一段的 text 拆成 reasoning / text 两路�?*/
  function feed(L, text) {
    L.carry += text
    for (let guard = 0; guard < 1e6; guard++) {
      if (L.mode === 'lead') {
        const m = WS_RE.exec(L.carry)
        if (m !== null) {
          L.ws += m[0]
          L.carry = L.carry.slice(m[0].length)
        }
        if (L.carry === '') {
          if (L.ws.length > MAX_WS) {
            // 病态：光空白太长，别再等了
            routeText(L, L.ws)
            L.ws = ''
            L.mode = 'passthrough'
            continue
          }
          return
        }
        const probe = L.carry.toLowerCase()
        if (probe.length < openLower.length && openLower.startsWith(probe)) return // 还可能变成开标签
        if (probe.startsWith(openLower)) {
          L.ws = '' // 开标签前的空白丢掉
          L.carry = L.carry.slice(openLower.length)
          L.mode = 'inthink'
          continue
        }
        // 确认不是思考：先把扣着的空白按顺序吐出去，再进入透传
        if (L.ws !== '') {
          routeText(L, L.ws)
          L.ws = ''
        }
        L.mode = 'passthrough'
        continue
      }
      if (L.mode === 'passthrough') {
        if (L.carry === '') return
        const k = L.carry.toLowerCase().indexOf(openLower)
        if (k < 0) {
          if (L.carry.length > openKeep) {
            routeText(L, L.carry.slice(0, L.carry.length - openKeep))
            L.carry = L.carry.slice(L.carry.length - openKeep)
          }
          return
        }
        if (k > 0) {
          routeText(L, L.carry.slice(0, k))
          L.carry = L.carry.slice(k)
        }
        L.carry = L.carry.slice(openLower.length)
        L.mode = 'inthink'
        continue
      }
      // inthink
      if (L.carry === '') return
      const k = L.carry.toLowerCase().indexOf(closeLower)
      if (k < 0) {
        if (L.carry.length > closeKeep) {
          routeReasoning(L, L.carry.slice(0, L.carry.length - closeKeep))
          L.carry = L.carry.slice(L.carry.length - closeKeep)
        }
        return
      }
      routeReasoning(L, L.carry.slice(0, k))
      L.carry = L.carry.slice(k + closeLower.length)
      L.mode = 'lead'
    }
  }

  function finishLane(L, endChunk) {
    if (L.mode === 'inthink' && L.carry !== '') {
      // 没闭合就收尾：整段当思考，标签本身丢掉
      routeReasoning(L, L.carry)
      L.carry = ''
    } else if (L.carry !== '') {
      routeText(L, L.ws + L.carry)
      L.carry = ''
      L.ws = ''
    } else if (L.ws !== '' && L.textIdx !== null) {
      routeText(L, L.ws)
      L.ws = ''
    }
    if (!L.emitted) {
      // 一个块都没发出来：没丢东西就把上游原样放行，丢了（strip）就整块撤掉
      if (!L.dropped) {
        if (L.held !== null) push(L.held)
        if (endChunk !== undefined) push(endChunk)
      }
    } else {
      for (const rec of L.out) {
        if (!rec.closed) {
          rec.closed = true
          push({ type: 'block-end', index: rec.index, block: { type: rec.kind, text: rec.text } })
        }
      }
    }
    lanes.delete(L.orig)
    if (openLane === L) openLane = null
  }
  function finishAll() {
    for (const L of [...lanes.values()]) finishLane(L, undefined)
  }

  function handle(chunk) {
    const t = chunk?.type
    if (t === 'text-delta') {
      if (foreign.has(chunk.index)) {
        push(chunk)
        return
      }
      const L = laneOf(chunk.index)
      if (openLane !== null && openLane !== L) finishLane(openLane, undefined)
      openLane = L
      feed(L, typeof chunk.text === 'string' ? chunk.text : '')
      return
    }
    if (t === 'block-start') {
      if (chunk.blockType === 'text') {
        const L = laneOf(chunk.index)
        if (L.held === null) L.held = chunk
        // 不是 text-delta 时也要把别的开�?lane 收掉
        if (openLane !== null && openLane !== L) finishLane(openLane, undefined)
        return
      }
      foreign.add(chunk.index)
      push(chunk)
      return
    }
    if (t === 'block-end') {
      const L = lanes.get(chunk.index)
      if (L !== undefined) {
        finishLane(L, chunk)
        return
      }
      push(chunk)
      return
    }
    if (t === 'finish') {
      finishAll()
      push(chunk)
      return
    }
    push(chunk)
  }

  const iterator = (async function* run() {
    try {
      for await (const chunk of source) {
        handle(chunk)
        while (pending.length > 0) yield pending.shift()
      }
      finishAll()
      while (pending.length > 0) yield pending.shift()
    } catch (error) {
      // 出错就原样吐回去，绝不吞内容
      finishAll()
      while (pending.length > 0) yield pending.shift()
      throw error
    }
  })()

  return iterator
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  if (process.env.DSH_THINKING_GUARD === '0') return
  const opt = {
    openTag: typeof config.openTag === 'string' && config.openTag !== '' ? config.openTag : OPEN_DEFAULT,
    closeTag: typeof config.closeTag === 'string' && config.closeTag !== '' ? config.closeTag : CLOSE_DEFAULT,
    strip: config.mode === 'strip',
  }
  const listen = (options, next) => {
    let inner
    try {
      inner = next()
    } catch (error) {
      throw error
    }
    if (inner === undefined || inner === null) return inner
    try {
      return makeStream(inner, opt)
    } catch (error) {
      try {
        ctx?.logger?.warn?.('[thinking-guard] 包裹失败，原样透传�?o', error)
      } catch {}
      return inner
    }
  }
  ctx.on('llm/stream', listen, { global: true, prepend: true })
  try {
    ctx?.logger?.info?.(`[thinking-guard] active (mode=${opt.strip ? 'strip' : 'reasoning'}, tag=${opt.openTag})`)
  } catch {}
}
