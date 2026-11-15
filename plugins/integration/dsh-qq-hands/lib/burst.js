/**
 * dsh-qq-hands · lib/burst.js
 *
 * 「按句拆气泡」纯函数：把一条已经准备好的 QQ Markdown 回复，拆成 1..N 条分别发送的气泡，
 * 让机器人看起来像真人连发几条短消息，而不是丢一个长条大段。
 *
 * 为什么要限条数：QQ 官方机器人一次 API 调用只能发一条气泡；单聊被动回复对同一条用户
 * 消息最多能回 4 条，所以默认上限取 3（留一条余量给「兜底错误提示」之类的后手）。
 * 单条消息本身也有长度上限，默认按 1900 个 Unicode 码点算（emoji 记 1 个）。
 *
 * 拆分优先级（从高到低，切点选择严格按这个顺序降级）：
 *   空行段落 → 句末标点（。！？!?…；;）→ 换行 → 逗号（，,）→ 硬切
 *
 * 绝不切断的两类结构：
 *   - ``` / ~~~ 围栏代码块（含未闭合的围栏：整块保留，宁可结构不完整也不拦腰切）
 *   - GFM 管道表格（表头 + 分隔行 + 数据行，必须待在同一个气泡里）
 * 这两类整块独立成气泡，块内即使有多句话也不拆。
 *
 * 其它约定：
 *   - 句末标点后面的闭合引号/括号（」』”’"'）】》等）跟着前一句走，不甩到下一句开头；
 *   - 相邻的极短碎片（< 4 码点，如「嗯。」「好。」）会并到相邻气泡，避免一堆碎渣；
 *   - 条数超上限时合并相邻最短的一对正文气泡（结构块不参与合并，免得破坏 Markdown 渲染）；
 *   - 合并永远不越过 maxCodepoints：长度上限比条数上限更硬，宁可多一条也不超长；
 *   - 全程按码点（code point）处理，绝不切出孤立代理项（emoji 不会被劈成两半）；
 *   - 纯函数、零依赖：不读环境变量、不做 IO、不用 Math.random。
 */

/** 默认最多几条气泡（QQ 被动回复留给调用方的余量是 4）。 */
export const DEFAULT_MAX_BUBBLES = 3

/** 默认单条气泡的码点上限。 */
const DEFAULT_MAX_CODEPOINTS = 1900

/** 低于这个码点数的正文碎片会被并到相邻气泡。 */
const SHORT_FRAGMENT = 4

/** 句末标点：到这里就允许断句。 */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '!', '?', '…', '；', ';'])

/** 句末标点后面可能紧跟的闭合引号/括号，归前一句。 */
const CLOSERS = new Set([
  '」', '』', '”', '’', '"', "'", '）', ')', ']', '】', '》', '〉', '〕', '］', '}',
])

/** 围栏开始行：行首最多 3 个空格，然后 3 个以上的 ` 或 ~。 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** 围栏结束行：与开始行同字符、不短于开始行，且行内没有别的内容。 */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** 表格分隔行里的单个单元格。 */
const TABLE_DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 按 Unicode 码点计算长度：emoji 算 1，不会因为代理对多算一个。 */
function countCodePoints(value) {
  return Array.from(value).length
}

/** 去掉首尾空白（含换行），内部结构原样保留。 */
function trimBubble(value) {
  return value.replace(/^\s+/, '').replace(/\s+$/, '')
}

/** 两个气泡拼成一个：用换行连接，这是 QQ Markdown 里最安全的自然分隔。 */
function joinBubbles(first, second) {
  return trimBubble(`${first}\n${second}`)
}

/** 拼起来放不放得进一条气泡。 */
function fits(first, second, limit) {
  return countCodePoints(first) + 1 + countCodePoints(second) <= limit
}

/* ------------------------------------------------------------------ *
 * Markdown 结构识别
 * ------------------------------------------------------------------ */

/** 返回围栏标记（如 ``` 或 ~~~~）；不是围栏开始行返回 null。 */
function fenceMarker(line) {
  const matched = FENCE_OPEN.exec(line)
  return matched ? matched[1] : null
}

/** 判断某行是否是某个围栏的结束标记。 */
function isFenceClose(line, opener) {
  const matched = FENCE_CLOSE.exec(line)
  return Boolean(matched)
    && matched[1][0] === opener[0]
    && matched[1].length >= opener.length
}

/**
 * 拆一行表格的单元格。跳过转义竖线（\|）与行内代码里的竖线，
 * 并允许省略首尾的外围竖线。没有竖线就返回 null（不是表格行）。
 */
function tableCells(line) {
  if (typeof line !== 'string') return null
  const cells = []
  let cell = ''
  let pipes = 0
  let index = 0
  while (index < line.length) {
    const char = line[index]
    if (char === '\\' && index + 1 < line.length) {
      cell += line[index + 1]
      index += 2
      continue
    }
    if (char === '`') {
      let run = 1
      while (line[index + run] === '`') run += 1
      const marker = '`'.repeat(run)
      const end = line.indexOf(marker, index + run)
      if (end === -1) {
        cell += marker
        index += run
        continue
      }
      cell += line.slice(index, end + run)
      index = end + run
      continue
    }
    if (char === '|') {
      cells.push(cell)
      cell = ''
      pipes += 1
      index += 1
      continue
    }
    cell += char
    index += 1
  }
  if (pipes === 0) return null
  cells.push(cell)
  // 首尾的空单元格是外围竖线造成的，去掉
  if (cells[0].trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.length > 0 ? cells : null
}

/**
 * 起始于 start 行的表格结束位置（不含该位置的行号）。
 * 判定必须严格：表头行有竖线、下一行是列数相同的分隔行（--- / :---: 之类）。
 * 不是表格返回 -1，避免把正文里随便一个竖线当成表格。
 */
function findTableEnd(lines, start) {
  const header = tableCells(lines[start])
  if (!header) return -1
  const delimiter = tableCells(lines[start + 1])
  if (!delimiter || delimiter.length !== header.length) return -1
  if (!delimiter.every((cell) => TABLE_DELIMITER_CELL.test(cell))) return -1
  let end = start + 2
  while (end < lines.length && tableCells(lines[end])) end += 1
  return end
}

/**
 * 把整段文本切成「正文 / 围栏 / 表格」三种块，保持原始顺序。
 * 围栏优先于表格：围栏里的竖线不算表格；未闭合围栏吞到文末。
 */
function parseBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let prose = []
  const flushProse = () => {
    if (prose.length === 0) return
    blocks.push({ kind: 'prose', text: prose.join('\n') })
    prose = []
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const opener = fenceMarker(line)
    if (opener) {
      let closing = -1
      for (let at = index + 1; at < lines.length; at += 1) {
        if (isFenceClose(lines[at], opener)) {
          closing = at
          break
        }
      }
      flushProse()
      const end = closing === -1 ? lines.length : closing + 1
      blocks.push({ kind: 'fence', text: lines.slice(index, end).join('\n') })
      index = end
      continue
    }
    const tableEnd = findTableEnd(lines, index)
    if (tableEnd > index) {
      flushProse()
      blocks.push({ kind: 'table', text: lines.slice(index, tableEnd).join('\n') })
      index = tableEnd
      continue
    }
    prose.push(line)
    index += 1
  }
  flushProse()
  return blocks
}

/* ------------------------------------------------------------------ *
 * 正文断句
 * ------------------------------------------------------------------ */

/**
 * 判断句末标点是不是「URL / 标识符」里的符号而非断句点。
 * 例：https://a.com/?q=1 里的 ? 后面紧跟的是 URL 字符，不该在这里断。
 * 中文全角标点不参与这个判断（中文本来就没有词间空格）。
 */
function looksLikeUrlPunctuation(chars, index, ender) {
  if (ender !== '?' && ender !== '!') return false
  const previous = chars[index - 1]
  const next = chars[index + 1]
  if (previous === undefined || next === undefined) return false
  const wordy = (char) => Boolean(char) && /[0-9A-Za-z]/.test(char)
  // 前面是 URL 字符（含 / = & . _ - % 这些路径/查询分隔符）时才可能是 URL 标点
  if (!wordy(previous) && !'/&=._-%'.includes(previous)) return false
  return wordy(next) || '/&=%._-+'.includes(next)
}

/**
 * 把一个段落切成句子级片段。
 * 句末标点后紧跟的重复标点（「……」「？！」）和闭合引号/括号都算这一句的。
 * 纯空白片段会被丢掉。
 */
function scanSentences(paragraph) {
  const chars = Array.from(paragraph)
  const units = []
  let buffer = ''
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    buffer += char
    if (!SENTENCE_ENDERS.has(char)) continue
    if (looksLikeUrlPunctuation(chars, index, char)) continue
    // 收尾：重复标点 + 闭合引号/括号归前一句
    while (index + 1 < chars.length) {
      const next = chars[index + 1]
      if (!SENTENCE_ENDERS.has(next) && !CLOSERS.has(next)) break
      buffer += next
      index += 1
    }
    units.push(buffer)
    buffer = ''
  }
  if (buffer !== '') units.push(buffer)
  return units.map(trimBubble).filter((unit) => unit !== '')
}

/**
 * 单个句子级片段超长（> maxCodepoints）时的降级切分：
 * 换行 → 逗号 → 硬切。按码点切，不会切碎 emoji。
 */
function splitLongUnit(unit, limit) {
  const chars = Array.from(unit)
  const pieces = []
  let rest = chars
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = 0
    // 1) 换行最优先：切完还带着原排版
    for (let index = window.length - 1; index >= 0; index -= 1) {
      if (window[index] === '\n') {
        cut = index + 1
        break
      }
    }
    // 2) 逗号（中英文）
    if (cut === 0) {
      for (let index = window.length - 1; index >= 0; index -= 1) {
        if (window[index] === '，' || window[index] === ',') {
          cut = index + 1
          break
        }
      }
    }
    // 3) 硬切：window 本身已经是码点数组，天然不会切碎代理对
    if (cut === 0) cut = window.length
    const piece = trimBubble(window.slice(0, cut).join(''))
    if (piece !== '') pieces.push(piece)
    rest = rest.slice(cut)
  }
  const tail = trimBubble(rest.join(''))
  if (tail !== '') pieces.push(tail)
  return pieces
}

/**
 * 正文块 → 句子级气泡。优先在空行段落处断开，段落内按句末标点断，
 * 单句仍超长才降级到换行/逗号/硬切。
 */
function proseBubbles(text, limit) {
  const bubbles = []
  const paragraphs = text.split(/\n[ \t]*\n+/)
  for (const paragraph of paragraphs) {
    for (const unit of scanSentences(paragraph)) {
      if (countCodePoints(unit) <= limit) {
        bubbles.push(unit)
        continue
      }
      for (const piece of splitLongUnit(unit, limit)) bubbles.push(piece)
    }
  }
  return bubbles
}

/* ------------------------------------------------------------------ *
 * 气泡合并
 * ------------------------------------------------------------------ */

/**
 * 极短碎片并到相邻正文气泡，避免「嗯。」「好。」各占一条。
 * 只并正文↔正文：结构块（围栏/表格）保持独立，拼在一起容易破坏 Markdown 渲染。
 * 并完不超长度上限才算数；实在放不下就留着，宁可碎一条也不塞爆。
 */
function mergeShortFragments(entries, limit) {
  const guard = entries.length * 2 + 16
  for (let round = 0; round < guard; round += 1) {
    let merged = false
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (!entry.prose || countCodePoints(entry.text) >= SHORT_FRAGMENT) continue
      const previous = entries[index - 1]
      const next = entries[index + 1]
      const withPrevious = previous && previous.prose && fits(previous.text, entry.text, limit)
        ? joinBubbles(previous.text, entry.text)
        : null
      const withNext = next && next.prose && fits(entry.text, next.text, limit)
        ? joinBubbles(entry.text, next.text)
        : null
      if (withPrevious === null && withNext === null) continue
      // 两个方向都行时，并到合并后更短的那一边（平手优先往前并，保持顺序稳定）
      const toPrevious = withPrevious !== null
        && (withNext === null || countCodePoints(withPrevious) <= countCodePoints(withNext))
      if (toPrevious) {
        entries[index - 1] = { text: withPrevious, prose: true }
        entries.splice(index, 1)
      } else {
        entries[index] = { text: withNext, prose: true }
        entries.splice(index + 1, 1)
      }
      merged = true
      break
    }
    if (!merged) break
  }
}

/**
 * 条数超上限：反复合并相邻最短的一对（按合并后码点数，平手取靠前的那对），
 * 直到条数达标、或再也找不出放得下的相邻对。
 * 结构块不参与合并；长度上限是硬约束，宁可超条数也不超长度。
 */
function mergeToLimit(entries, maxCount, limit) {
  while (entries.length > maxCount) {
    let bestIndex = -1
    let bestSize = Number.POSITIVE_INFINITY
    for (let index = 0; index + 1 < entries.length; index += 1) {
      const first = entries[index]
      const second = entries[index + 1]
      if (!first.prose || !second.prose) continue
      if (!fits(first.text, second.text, limit)) continue
      const size = countCodePoints(first.text) + countCodePoints(second.text)
      if (size < bestSize) {
        bestSize = size
        bestIndex = index
      }
    }
    if (bestIndex === -1) break
    entries[bestIndex] = {
      text: joinBubbles(entries[bestIndex].text, entries[bestIndex + 1].text),
      prose: true,
    }
    entries.splice(bestIndex + 1, 1)
  }
}

/* ------------------------------------------------------------------ *
 * 导出 API
 * ------------------------------------------------------------------ */

/**
 * 把一条 QQ Markdown 文本拆成 1..maxBubbles 条气泡。
 *
 * @param {string} text 已准备好的 QQ Markdown 文本
 * @param {{ maxBubbles?: number, maxCodepoints?: number }} [options]
 * @returns {string[]} 拆分后的气泡；空串/纯空白返回 []
 *
 * 不变量：
 *   - 每个元素已去掉首尾空白，且码点数 <= maxCodepoints（唯一的例外是本身超过上限的
 *     整块围栏/表格：结构完整优先，交给调用方的长度兜底处理）；
 *   - 把结果 join('\n') 后，除被压缩的空白外原文一个字都不会少；
 *   - 围栏代码块和 GFM 表格不会被切开。
 */
export function splitBubbles(text, { maxBubbles = DEFAULT_MAX_BUBBLES, maxCodepoints = DEFAULT_MAX_CODEPOINTS } = {}) {
  if (typeof text !== 'string') return []
  // 统一换行符：CRLF/CR 都按 LF 处理，避免把 \r 当正文发出去
  const normalized = text.replace(/\r\n?/g, '\n')
  if (normalized.trim() === '') return []

  const limit = Number.isFinite(maxCodepoints) && maxCodepoints >= 1
    ? Math.floor(maxCodepoints)
    : DEFAULT_MAX_CODEPOINTS
  const maxCount = Number.isFinite(maxBubbles) && maxBubbles >= 1
    ? Math.floor(maxBubbles)
    : DEFAULT_MAX_BUBBLES

  /** @type {{ text: string, prose: boolean }[]} */
  const entries = []
  for (const block of parseBlocks(normalized)) {
    if (block.kind === 'prose') {
      for (const bubble of proseBubbles(block.text, limit)) {
        entries.push({ text: bubble, prose: true })
      }
      continue
    }
    // 围栏 / 表格整块一个气泡：只裁掉块首尾的空行，块内一个字符都不动
    const whole = block.text.replace(/^\n+/, '').replace(/\n+$/, '')
    if (whole.trim() !== '') entries.push({ text: whole, prose: false })
  }

  mergeShortFragments(entries, limit)
  mergeToLimit(entries, maxCount, limit)

  // 最后统一再裁一次首尾空白（合并可能带进换行），顺手去掉空泡
  return entries
    .map((entry) => trimBubble(entry.text))
    .filter((bubble) => bubble !== '')
}

/** FNV-1a 32 位 hash：给延迟用的确定性伪随机。 */
function hashString(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * 每条气泡发送前的停顿（毫秒），模拟真人打字节奏。
 *
 * - 确定性：同一 (bubble, options) 永远得到同一个值，同参两次相等（不用 Math.random，
 *   这样测试可复现，也不会让重发逻辑抖动）；
 * - 内容越长停越久，0..120 码点线性映射到 minMs..maxMs，达到 120 码点直接封顶 maxMs；
 * - 叠加 ±12% 的 hash 抖动，让连发的好几条不至于像节拍器；
 * - 结果保证落在 [minMs, maxMs] 内。
 *
 * @param {string} bubble 单条气泡内容
 * @param {{ minMs?: number, maxMs?: number, seed?: number }} [options]
 * @returns {number} 毫秒
 */
export function delayForBubble(bubble, { minMs = 550, maxMs = 1450, seed = 0 } = {}) {
  const low = Math.min(minMs, maxMs)
  const high = Math.max(minMs, maxMs)
  const text = typeof bubble === 'string' ? bubble : String(bubble ?? '')
  const length = countCodePoints(text)
  // 120 码点以上就是「长消息」，直接给最长停顿
  if (length >= 120) return high

  const base = low + (high - low) * (length / 120)
  const span = (high - low) * 0.12
  const unit = hashString(`${seed}\u0000${text}`) / 0xffffffff // 0..1
  const jittered = Math.round(base + (unit * 2 - 1) * span)
  return Math.min(high, Math.max(low, jittered))
}
