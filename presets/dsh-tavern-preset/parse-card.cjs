#!/usr/bin/env node
/**
 * 角色卡解析器 —— 无依赖，纯 Node。
 *
 * 输入：SillyTavern 角色卡（PNG 或 JSON，V1/V2/V3）
 * 输出：<outDir>/card.md      扮演用的唯一事实源
 *       <outDir>/state.json  可变状态（好感/心情/地点/flag）
 *       <outDir>/meta.json   原始卡面数据（换开场、排查用）
 *
 * 用法：
 *   node parse-card.cjs <卡文件> [输出根目录]
 *   node parse-card.cjs --selftest
 *
 * 为什么自己写而不用依赖：PNG 的 tEXt chunk 结构极简单
 * （length(4B) + type(4B) + data + crc(4B)），遍历一遍就能拿到 base64 载荷，
 * 省掉 png-chunks-extract / png-chunk-text 两个包。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/* ────────────────────────── PNG chunk 遍历 ────────────────────────── */

/**
 * 从 PNG buffer 里取出所有 tEXt chunk，返回 [{keyword, text}]。
 * tEXt 的 data 是 `keyword \0 text`，均为 Latin-1；text 对角色卡而言是 base64。
 */
function readTextChunks(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  const out = []
  let p = 8
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    const dataStart = p + 8
    const dataEnd = dataStart + len
    if (dataEnd + 4 > buf.length) break
    if (type === 'tEXt') {
      const data = buf.subarray(dataStart, dataEnd)
      const sep = data.indexOf(0)
      if (sep > 0) {
        out.push({
          keyword: data.toString('latin1', 0, sep),
          text: data.toString('latin1', sep + 1),
        })
      }
    }
    if (type === 'IEND') break
    p = dataEnd + 4
  }
  return out
}

/** ccv3 优先，chara 次之；载荷是 base64 编码的 UTF-8 JSON。 */
function cardJsonFromPng(buf) {
  const chunks = readTextChunks(buf)
  if (!chunks || chunks.length === 0) return null
  const pick =
    chunks.find(c => c.keyword === 'ccv3') ?? chunks.find(c => c.keyword === 'chara')
  if (!pick) return null
  const raw = Buffer.from(pick.text, 'base64').toString('utf8')
  return JSON.parse(raw)
}

/* ────────────────────────── 卡面归一化 ────────────────────────── */

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 把 V1 / V2 / V3 三种形态统一成同一组字段。
 * V1 是扁平结构（name/description/personality/... 直接在顶层）；
 * V2/V3 把同样的东西放在 data 里，V3 还多一个 nickname/creator_notes 之类的宽松集合。
 */
function normalize(card) {
  let spec = 'v1'
  let d = card
  if (isObject(card) && (card.spec === 'chara_card_v2' || card.spec === 'chara_card_v3')) {
    spec = card.spec === 'chara_card_v3' ? 'v3' : 'v2'
    d = isObject(card.data) ? card.data : {}
  }
  const str = k => (typeof d[k] === 'string' ? d[k] : '')
  const book = isObject(d.character_book) && Array.isArray(d.character_book.entries)
    ? d.character_book
    : null
  let entries = []
  if (book) {
    entries = book.entries
      .filter(e => isObject(e) && typeof e.content === 'string' && e.content.trim())
      .map(e => ({
        keys: Array.isArray(e.keys) ? e.keys : [],
        content: e.content.trim(),
        constant: !!e.constant,
        order: Number.isFinite(e.insertion_order) ? e.insertion_order : 0,
        comment: typeof e.comment === 'string' ? e.comment : '',
      }))
      // constant 条目优先，其余按 insertion_order 升序 —— 与原版 ST 的注入次序同向。
      .sort((a, b) => (Number(b.constant) - Number(a.constant)) || (a.order - b.order))
  }
  return {
    spec,
    name: str('name') || '未命名角色',
    description: str('description'),
    personality: str('personality'),
    scenario: str('scenario'),
    firstMes: str('first_mes'),
    mesExample: str('mes_example'),
    systemPrompt: str('system_prompt'),
    postHistory: str('post_history_instructions'),
    creatorNotes: str('creator_notes'),
    alternateGreetings: Array.isArray(d.alternate_greetings)
      ? d.alternate_greetings.filter(x => typeof x === 'string' && x.trim())
      : [],
    tags: Array.isArray(d.tags) ? d.tags.filter(x => typeof x === 'string') : [],
    worldEntries: entries,
  }
}

/* ────────────────────────── card.md 生成 ────────────────────────── */

/**
 * 把 ST 的 {{user}} / {{char}} 宏替换成实际称呼。
 *
 * 目的不是「更正确」，是「少一次模型判断」。卡里到处是占位符时，模型得在
 * 每一句里自己换算，偶尔会漏或者念错（把 {{user}} 原样念出来）。生成时就替换掉，
 * 模型读到的就是成文的中文。
 *
 * 只做这两个宏。ST 的其他宏（{{time}}、{{random}}、{{getvar}} …）这里不实现 ——
 * 它们和「一张静态卡」的前提冲突，硬做只会引入不确定性。
 */
function substituteMacros(text, charName) {
  if (!text) return text
  return text
    .replace(/\{\{user\}\}/gi, '你')
    .replace(/\{\{char\}\}/gi, charName)
}

/**
 * 统计剩余的花括号宏（ST 运行时宏，静态卡里无法求值）。
 *
 * 两类处理方式不同：
 *   · {{user}} / {{char}} —— 上面已经换掉了，这里不该再出现。
 *   · {{date}} / {{time}} / {{getvar}} / {{random}} 等 —— 需要 SillyTavern 运行时，
 *     静态卡里没有值可填。保留原文，让扮演预设按上下文自然处理（比如「今天是几号」
 *     这种，角色随口说一句就行），而不是替换成某个假值。
 *     报出来是为了让备卡预设能提醒用户：这张卡依赖运行时宏，效果会打折。
 */
function findResidualMacros(text) {
  const hits = text.match(/\{\{[^{}]{1,60}\}\}/g) || []
  const counts = {}
  for (const h of hits) counts[h] = (counts[h] || 0) + 1
  return counts
}

/**
 * card.md 是扮演时唯一的读取对象 —— 所有内容必须在这一份文件里，
 * 不要再让模型去翻 meta.json（那等于多一步往返，每步 6 秒）。
 *
 * 分节原则：硬约束在前（身份/性格/说话风格），情境在中（场景/世界书），
 * 风格参考在后（范例对话原文）。每节都标了「怎么用」，防止模型把
 * 范例对话当台词照抄。
 */
function buildCardMd(n) {
  const L = []
  const add = (s = '') => L.push(substituteMacros(s, n.name))

  add(`# ${n.name}`)
  add()
  add('> 本文件是这场扮演的唯一事实源。每节都写了「怎么用」，按它执行。')
  add()

  if (n.description) {
    add('## 身份档案（硬约束）')
    add('> 你怎么定义自己、有哪些经历、与对方什么关系。与本节冲突的话绝不能自己编。')
    add()
    add(n.description.trim())
    add()
  }

  if (n.personality) {
    add('## 性格（硬约束）')
    add('> 你的内在反应模式。写心理活动、做选择都要符合它，不能只当标签贴。')
    add()
    add(n.personality.trim())
    add()
  }

  if (n.scenario) {
    add('## 场景与开端')
    add('> 你此刻所处的情境。开场白按它建立现场感。')
    add()
    add(n.scenario.trim())
    add()
  }

  if (n.worldEntries.length) {
    add('## 世界观与设定')
    add('> 背景事实。涉及相关话题时自然体现，不要整段复述给用户听。')
    add()
    for (const e of n.worldEntries) {
      const head = e.comment || (e.keys.length ? e.keys.join(' / ') : '设定')
      add(`### ${head}${e.constant ? '（常驻）' : ''}`)
      add(e.content)
      add()
    }
  }

  if (n.mesExample) {
    add('## 范例对话（只学风格，禁止照抄）')
    add('> 学你的口吻、句长、动作描写密度。原句一律不许出现在回复里。')
    add()
    add(n.mesExample.trim())
    add()
  }

  if (n.systemPrompt || n.postHistory) {
    add('## 创作约束')
    add('> 这是作者给扮演者的硬性规则，优先级高于上面任何风格描述。')
    add()
    if (n.systemPrompt) {
      add(n.systemPrompt.trim())
      add()
    }
    if (n.postHistory) {
      add(n.postHistory.trim())
      add()
    }
  }

  add('## 开场白')
  add('> 卡片自带的第一段。用户第一次进来时把它发出去，直接照原文说，不要改写。')
  add()
  add(n.firstMes.trim() || '（这张卡没有写开场白，由你根据场景与开端自行开场。）')
  add()

  if (n.alternateGreetings.length) {
    add('## 备选开场')
    add('> 用户说「换个开场」时按顺序取下一个。')
    add()
    n.alternateGreetings.forEach((g, i) => {
      add(`### 备选 ${i + 1}`)
      add(g.trim())
      add()
    })
  }

  return L.join('\n')
}

/**
 * 从场景里挑一个地点词做初始值，挑不出就留空。
 *
 * 先按「场所后缀」找（塔/镇/城/馆…），这类词几乎不可能是天气或时间；
 * 找不到才退回「在 X」模式，并且过滤掉雨/风/夜这类非地点词。
 * 宁可留空也不要写错 —— 地点写错了扮演时会持续串味。
 */
const PLACE_SUFFIX = '塔|镇|城|村|馆|店|室|屋|房|院|校|园|楼|厅|桥|港|岛|山|林|街|站|船|厅|殿|宫|府|阁|公寓|大道|码头|广场|车站|机场|酒吧|教堂|森林|沙漠|海边'
const NOT_PLACE = /^(雨|大雨|小雨|暴雨|风|海风|夜|深夜|黄昏|清晨|雪|雾|阴天|晴天)/

function guessLocation(n) {
  const src = (n.scenario || '').trim()
  if (!src) return ''
  const re = new RegExp(`([\\u4e00-\\u9fa5A-Za-z0-9]{1,8}(?:${PLACE_SUFFIX}))`, 'g')
  const all = [...src.matchAll(re)].map(m => m[1])
  if (all.length) {
    // 取第一个场所词：场景的第一句通常先交代地点，后面的场所词往往嵌在动作里
    // （「推开了塔顶的门」那种）。再掐掉可能粘连的动词前缀。
    const first = all[0].replace(/^(走|来|到|进|上|在|位于|身处|推开|打开)/, '')
    if (!NOT_PLACE.test(first)) return first.slice(-14)
  }
  const m = src.match(/(?:在|位于|身处)\s*([^\n。，,]{2,12})/)
  if (!m) return ''
  const cand = m[1].trim()
  return NOT_PLACE.test(cand) ? '' : cand
}

function buildState(n) {
  return {
    character: n.name,
    affection: 0,
    mood: '',
    location: guessLocation(n),
    scene: n.scenario ? n.scenario.slice(0, 60) : '',
    flags: [],
    notes: '',
    turns: 0,
  }
}

/** 文件夹名：角色名 ASCII 安全化 + 短哈希，避免同名卡互相覆盖。 */
function cardDirName(name, srcFile) {
  const ascii = name
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'card'
  const { createHash } = require('node:crypto')
  const hash = createHash('sha1').update(fs.readFileSync(srcFile)).digest('hex').slice(0, 6)
  return `${ascii}-${hash}`
}

/* ────────────────────────── 主流程 ────────────────────────── */

function processCard(srcFile, outRoot) {
  const buf = fs.readFileSync(srcFile)
  let rawJson = null
  let isPng = false

  // 先按 PNG 试；不是 PNG（或没有 tEXt）就当 JSON 读。
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    isPng = true
    rawJson = cardJsonFromPng(buf)
    if (!rawJson) {
      throw new Error(
        '这是 PNG 但没有角色卡元数据（tEXt 里既没有 ccv3 也没有 chara）。' +
          '纯图卡需要视觉兜底：先 read_image 读一遍立绘，再按卡面内容手写 card.md。'
      )
    }
  } else {
    try {
      rawJson = JSON.parse(buf.toString('utf8'))
    } catch {
      throw new Error('文件既不是带元数据的 PNG，也不是合法 JSON。')
    }
  }

  const n = normalize(rawJson)
  const id = cardDirName(n.name, srcFile)
  const outDir = path.resolve(outRoot || '.', id)
  fs.mkdirSync(outDir, { recursive: true })

  const cardMd = buildCardMd(n)
  fs.writeFileSync(path.join(outDir, 'card.md'), cardMd, 'utf8')
  fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(buildState(n), null, 2), 'utf8')
  fs.writeFileSync(
    path.join(outDir, 'meta.json'),
    JSON.stringify(
      {
        source: path.resolve(srcFile),
        parsedAt: new Date().toISOString(),
        spec: n.spec,
        name: n.name,
        tags: n.tags,
        alternateGreetings: n.alternateGreetings,
        creatorNotes: n.creatorNotes,
        // 静态卡无法求值的运行时宏，报出来让用户知道这张卡会打折在哪
        residualMacros: findResidualMacros(cardMd),
      },
      null,
      2
    ),
    'utf8'
  )

  return {
    id,
    outDir,
    name: n.name,
    spec: n.spec,
    isPng,
    worldEntries: n.worldEntries.length,
    residualMacros: findResidualMacros(cardMd),
  }
}

/* ────────────────────────── selftest ────────────────────────── */

/** 造一个最小 PNG，塞一个 tEXt chunk（ccv3 + chara），验证提取管线。 */
function selftest() {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Blanche',
      description: '灯塔守夜人，寡言。',
      personality: '克制，习惯用行动代替解释。',
      scenario: '深夜的海边灯塔里。',
      first_mes: '“……又是你。”',
      mes_example: '{{char}}: “灯油不多了。”',
      character_book: {
        entries: [
          { keys: ['灯塔'], content: '塔高七层，第七层不能开窗。', constant: true, insertion_order: 0 },
        ],
      },
    },
  }
  const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64')

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const mkChunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(0, 0) // 解析不看 CRC，置零足够
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc])
  }
  const textData = Buffer.concat([
    Buffer.from('ccv3', 'latin1'),
    Buffer.from([0]),
    Buffer.from(payload, 'latin1'),
  ])
  const png = Buffer.concat([
    sig,
    mkChunk('IHDR', Buffer.alloc(13)),
    mkChunk('tEXt', textData),
    mkChunk('IEND', Buffer.alloc(0)),
  ])

  const chunks = readTextChunks(png)
  const okChunks = !!chunks && chunks.length === 1 && chunks[0].keyword === 'ccv3'
  const parsed = cardJsonFromPng(png)
  const okJson = !!parsed && parsed.data && parsed.data.name === 'Blanche'
  const n = normalize(parsed)
  const okNorm = n.name === 'Blanche' && n.worldEntries.length === 1
  const md = buildCardMd(n)
  const okMd = md.includes('## 身份档案') && md.includes('塔高七层')

  const results = {
    'PNG chunk 遍历': okChunks,
    'tEXt → base64 → JSON': okJson,
    'V2 归一化 + 世界书': okNorm,
    'card.md 生成': okMd,
  }
  let pass = true
  for (const [k, v] of Object.entries(results)) {
    console.log(`[selftest] ${k}: ${v ? '✅ 通过' : '❌ 失败'}`)
    if (!v) pass = false
  }
  return pass
}

/* ────────────────────────── CLI ────────────────────────── */

function main(argv) {
  if (argv[0] === '--selftest') {
    process.exitCode = selftest() ? 0 : 1
    return
  }
  if (!argv[0]) {
    console.log('用法: node parse-card.cjs <卡文件> [输出根目录] | --selftest')
    process.exitCode = 1
    return
  }
  const src = argv[0]
  if (!fs.existsSync(src)) {
    console.log(`❌ 找不到文件: ${src}`)
    process.exitCode = 1
    return
  }
  try {
    const r = processCard(src, argv[1])
    console.log(`✅ ${path.basename(src)}`)
    console.log(`   格式: ${r.isPng ? 'PNG' : 'JSON'} (${r.spec}) | 角色: ${r.name} | 世界书: ${r.worldEntries} 条`)
    console.log(`   输出: ${r.outDir}`)
    console.log(`   卡名: ${r.id}`)
    const residual = Object.entries(r.residualMacros)
    if (residual.length) {
      // 排序后只报前 6 个，避免长卡刷屏
      const shown = residual.sort((a, b) => b[1] - a[1]).slice(0, 6)
      console.log(`⚠️  还有 ${residual.length} 种运行时宏无法求值（静态卡没有运行时）：`)
      for (const [macro, n] of shown) console.log(`      ${macro} × ${n}`)
      console.log('   保留原文，扮演时角色会按上下文自然处理。')
    }
  } catch (error) {
    console.log(`❌ ${error.message}`)
    process.exitCode = 1
  }
}

if (require.main === module) main(process.argv.slice(2))

module.exports = { readTextChunks, cardJsonFromPng, normalize, buildCardMd, processCard }
