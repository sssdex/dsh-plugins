/**
 * dsh-qq-hands —— 给助手装上「QQ 的手」。
 *
 * 解决三件事：
 *   1. 主动触达：不用主人先说话，也能直接往他 QQ 发消息（主动消息，单聊 1000 条/天）。
 *   2. 多模态：发表情包 / 图片、发语音（SAPI 合成 → SILK）、发电脑截图、发文件（自动分片）。
 *   3. 像真人：把回复按句拆成几条气泡、中间带停顿发送（见 lib/intercept.js）。
 *
 * 密钥不重复存：直接复用 IM Connect 已经配好的 QQ 机器人账号（appId / appSecret / ownerOpenId）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createState } from './lib/state.js'
import { dshHome, resolveQqAccount } from './lib/config.js'
import { createQqClient } from './lib/qq.js'
import { installQqInterceptor } from './lib/intercept.js'
import { searchMemes, memeLibraryInfo } from './lib/memes.js'

export const name = 'dsh-qq-hands'
// credentials 必须声明在 inject 里：cordis 的 ctx 是受限代理，没注入就访问 ctx.credentials
// 会直接抛「cannot get property "credentials" without inject」（2026-10-20 实测踩到）。
// 声明之后 DSH 会等凭据服务就绪再 apply，正好也用它解析 IM Connect 存的 appSecret。
export const inject = ['tools', 'credentials']

// @deepseek-ai/dsh-tools 由宿主按包名别名解析，profile 的 node_modules 里并没有这个包。
let defineTool = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  defineTool = mod.defineTool ?? mod.default?.defineTool ?? null
} catch (error) {
  console.error('[dsh-qq-hands] @deepseek-ai/dsh-tools 解析失败，工具不可用：', error?.message ?? error)
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 200 * 1024 * 1024
const TRUTHY = /^(1|true|yes|on|是|开)$/i

function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return TRUTHY.test(String(value).trim())
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : (value === undefined || value === null ? fallback : String(value).trim())
}

function readCapped(file, limit, label = '文件') {
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error(`${label}不是普通文件：${file}`)
  if (stat.size > limit) throw new Error(`${label} ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过上限 ${(limit / 1024 / 1024).toFixed(0)}MB`)
  return fs.readFileSync(file)
}

export function apply(ctx, rawConfig) {
  const cfg = {
    burst: true,
    maxBubbles: 3,
    minGapMs: 550,
    maxGapMs: 1450,
    accountId: '',
    openid: '',
    appId: '',
    appSecret: '',
    stateFile: '',
    ...(rawConfig || {}),
  }
  const log = (line) => {
    try { ctx.logger?.(name)?.info?.(line) ?? console.log(`[dsh-qq-hands] ${line}`) } catch { console.log(`[dsh-qq-hands] ${line}`) }
  }

  // 必须在拦截器安装前抓住原生 fetch：我们自己的发送要绕过拦截器（自带分句逻辑，避免双拆）。
  const nativeFetch = globalThis.fetch?.bind(globalThis)
  const stateFile = cfg.stateFile || path.join(dshHome(), 'dsh-qq-hands', 'state.json')
  const state = createState(stateFile, log)

  let accountCache
  // 凭据服务在 inject 里已声明；再包一层 try 是为了热重载/降级时还能退到读 .credentials.yaml，
  // 不让「拿不到服务」把整个插件判死。
  function credentialService() {
    try { return ctx.credentials ?? ctx.get?.('credentials') ?? null } catch { return null }
  }
  async function account() {
    if (!accountCache) {
      accountCache = resolveQqAccount(cfg, credentialService())
      accountCache.catch(() => { accountCache = undefined })
    }
    return accountCache
  }

  let clientCache
  async function client() {
    if (!clientCache) {
      clientCache = (async () => {
        const info = await account()
        return { info, api: createQqClient({ appId: info.appId, appSecret: info.appSecret, fetchImpl: nativeFetch, log, state }) }
      })()
      clientCache.catch(() => { clientCache = undefined })
    }
    return clientCache
  }

  // ---- 像真人的回复投递：拦 IM Connect 发往 QQ 的文字消息并按句拆条 ----
  if (cfg.burst !== false) {
    try {
      const interceptor = installQqInterceptor({ state, log, config: cfg, fetchTarget: globalThis })
      ctx.effect(() => () => interceptor.dispose())
      log(`已挂上 QQ 回复拦截器（每条回复最多拆 ${cfg.maxBubbles} 条气泡，间隔 ${cfg.minGapMs}~${cfg.maxGapMs}ms）`)
    } catch (error) {
      console.error('[dsh-qq-hands] 回复拦截器安装失败（不影响其它工具）：', error?.message ?? error)
    }
  }

  if (typeof defineTool !== 'function' || !ctx.tools || typeof ctx.tools.register !== 'function') {
    console.error('[dsh-qq-hands] 工具注册条件不满足，跳过注册')
    return
  }

  /** 统一渲染返回值。 */
  const renderText = (_args, value) => [{ type: 'text', text: String(value?.message ?? '(无输出)') }]

  function commonParams(extra = {}) {
    return {
      chat: { type: 'string', description: "目标会话：留空或 'dm' = 主人私聊（默认）；'group:<群openid>' = 群聊" },
      mode: { type: 'string', description: "auto（默认，能被动就省配额）| passive（必须回复主人刚才那句）| active（主动消息，不依赖上下文）" },
      ...extra,
    }
  }

  // ---------------------------------------------------------------- 文字
  const sendTextTool = defineTool({
    name: 'qq_send_text',
    description:
      '在 QQ 里给主人发文字消息（dsh-qq-hands 插件）。默认会把长内容按句拆成几条气泡、中间带停顿发出去，像真人连发。'
      + '主人说「发我 QQ」「在 QQ 上跟我说」时用这个；回复很短就直接发一条。mode=active 是主动消息，主人没说话也能发。',
    parameters: commonParams({
      text: { type: 'string', description: '要发送的文字内容（必填）' },
      burst: { type: 'string', description: '是否按句拆成多条气泡，默认 true' },
      markdown: { type: 'string', description: 'true=用 QQ Markdown（默认纯文本，更稳）' },
      wakeup: { type: 'string', description: 'true=互动召回消息（主动消息被关闭时的备选）' },
      maxBubbles: { type: 'string', description: '最多拆几条气泡，默认 3（单聊被动回复平台上限 4 条）' },
    }),
    output: { schema: { type: 'json' }, render: renderText },
    async execute(args) {
      const content = text(args.text)
      if (!content) return { ok: false, message: '缺少 text' }
      try {
        const { info, api } = await client()
        const target = api.target(args.chat, info.openid)
        const result = await api.sendText(target, content, {
          markdown: flag(args.markdown, false),
          mode: text(args.mode) || 'auto',
          wakeup: flag(args.wakeup, false),
          burst: flag(args.burst, true),
          maxBubbles: Number(args.maxBubbles) > 0 ? Number(args.maxBubbles) : cfg.maxBubbles,
          minGapMs: cfg.minGapMs,
          maxGapMs: cfg.maxGapMs,
        })
        const where = target.kind === 'group' ? `群 ${target.openid}` : '主人私聊'
        return {
          ok: true,
          bubbles: result.bubbles,
          mode: result.msgId ? 'passive' : 'active',
          message: `已发到 QQ（${where}）：${result.bubbles} 条气泡，${result.msgId ? '被动回复' : '主动消息'}。`,
        }
      } catch (error) {
        return { ok: false, message: `发送失败：${error?.message ?? error}` }
      }
    },
  })

  // ---------------------------------------------------------------- 图片 / 表情包
  const sendImageTool = defineTool({
    name: 'qq_send_image',
    description:
      '在 QQ 里给主人发图片或表情包（dsh-qq-hands 插件）。'
      + 'path=本地图片路径，url=网络图片，meme=按中文关键词从本机图库挑表情（如「生气」「得意」「干饭」「害羞」），三者给一个即可。'
      + '主人说「发个表情包」「发张图」时用它。',
    parameters: commonParams({
      path: { type: 'string', description: '本地图片绝对路径' },
      url: { type: 'string', description: 'http(s) 图片地址' },
      meme: { type: 'string', description: '表情关键词，从本机表情库检索' },
      caption: { type: 'string', description: '发图前先说一句（可选）' },
      tag: { type: 'string', description: '表情分类，如 happy/angry/confused/daily' },
    }),
    output: { schema: { type: 'json' }, render: renderText },
    async execute(args) {
      try {
        const { info, api } = await client()
        const target = api.target(args.chat, info.openid)
        const mode = text(args.mode) || 'auto'
        const caption = text(args.caption)
        let file = text(args.path)
        let name = ''
        let picked

        if (!file && !text(args.url)) {
          const query = [text(args.meme), text(args.tag)].filter(Boolean).join(' ')
          const hits = await searchMemes(query, { limit: 5 })
          if (!hits.length) return { ok: false, message: `表情库里没找到「${query || '(随机)'}」，换个关键词，或直接用 path 指定图片。` }
          picked = hits[Math.floor(Math.random() * hits.length)]
          file = picked.file
        }

        let data
        if (file) {
          const resolved = path.resolve(file)
          if (!fs.existsSync(resolved)) return { ok: false, message: `图片不存在：${resolved}` }
          data = readCapped(resolved, MAX_IMAGE_BYTES, '图片')
          name = path.basename(resolved)
        } else {
          const res = await nativeFetch(text(args.url), { signal: AbortSignal.timeout(30_000) })
          if (!res.ok) return { ok: false, message: `下载图片失败：HTTP ${res.status}` }
          const buffer = Buffer.from(await res.arrayBuffer())
          if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, message: `图片 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限` }
          data = buffer
          name = path.basename(new URL(text(args.url)).pathname) || 'image.jpg'
        }

        if (caption) {
          await api.sendText(target, caption, { mode, burst: false, minGapMs: cfg.minGapMs, maxGapMs: cfg.maxGapMs })
        }
        const fileType = api.mediaFileType(name, data)
        const result = await api.sendMedia(target, { fileType: fileType === 3 ? 1 : fileType, name, data, mode })
        const label = picked ? `表情「${picked.caption || picked.name}」（${picked.tag}）` : `图片 ${name}`
        return { ok: true, file, message: `已发到 QQ：${label}，${result.msgId ? '被动回复' : '主动消息'}。` }
      } catch (error) {
        return { ok: false, message: `发图失败：${error?.message ?? error}` }
      }
    },
  })

  // ---------------------------------------------------------------- 语音
  const sendVoiceTool = defineTool({
    name: 'qq_send_voice',
    description:
      '在 QQ 里给主人发语音消息（dsh-qq-hands 插件）。'
      + 'text=要念的中文（默认用 Edge 神经网络少女音「晓伊」，最多 300 字）；path=已有音频文件（wav/silk/mp3 等）。'
      + 'voice 可选少女音色：xiaoyi（晓伊·活泼，默认）/ xiaoyi_sweet（晓伊·更软更甜）/ xiaoxiao（晓晓·温柔）/ xiaoxiao_soft（晓晓·轻声撒娇）/ xiaobei（东北）/ xiaoni（陕北）/ yunxia（少年音）。'
      + 'engine=auto（默认，Edge 优先、断网回落 SAPI）/ edge / sapi。'
      + '主人说「发条语音」「用说的」时用它。',
    parameters: commonParams({
      text: { type: 'string', description: '要朗读的文字（与 path 二选一）' },
      path: { type: 'string', description: '已有音频文件路径' },
      voice: { type: 'string', description: '音色：xiaoyi（默认）/ xiaoyi_sweet / xiaoxiao / xiaoxiao_soft / xiaobei / xiaoni / yunxia，或完整音色名' },
      engine: { type: 'string', description: 'auto（默认）/ edge（强制神经网络音）/ sapi（强制本地老引擎）' },
      rate: { type: 'string', description: '语速 -10..10，默认 0（正数更快）' },
      volume: { type: 'string', description: '音量 0..100，默认 100' },
      note: { type: 'string', description: '发语音前先说一句（可选）' },
    }),
    output: { schema: { type: 'json' }, render: renderText },
    async execute(args) {
      try {
        const media = await import('./lib/media.js')
        const { info, api } = await client()
        const target = api.target(args.chat, info.openid)
        const mode = text(args.mode) || 'auto'

        let silk
        let durationMs = 0
        let engine = 'file'
        let voiceName = ''
        if (text(args.path)) {
          const converted = await media.audioFileToSilk({ path: path.resolve(text(args.path)) })
          silk = converted.silk
          durationMs = converted.durationMs
        } else {
          const spoken = text(args.text)
          if (!spoken) return { ok: false, message: 'text 和 path 至少给一个' }
          const synth = await media.synthesizeSilk({
            text: spoken,
            // 不给 voice 就走 Edge 默认少女音；点 Microsoft xxx 才回落 SAPI
            voice: text(args.voice) || undefined,
            engine: text(args.engine) || 'auto',
            rate: args.rate === undefined || args.rate === '' ? 0 : Number(args.rate),
            volume: args.volume === undefined || args.volume === '' ? 100 : Number(args.volume),
          })
          silk = synth.silk
          durationMs = synth.durationMs
          engine = synth.engine || 'sapi'
          voiceName = synth.voice || ''
        }

        const note = text(args.note)
        if (note) await api.sendText(target, note, { mode, burst: false, minGapMs: cfg.minGapMs, maxGapMs: cfg.maxGapMs })
        const result = await api.sendMedia(target, { fileType: 3, name: 'voice.silk', data: silk, mode })
        const engineLabel = engine === 'edge' ? '神经网络少女音' : engine === 'sapi' ? '本地 SAPI（旧引擎）' : '音频文件'
        return {
          ok: true,
          durationMs,
          engine,
          voice: voiceName,
          message: `已发到 QQ：语音 ${(silk.length / 1024).toFixed(1)}KB / ${(durationMs / 1000).toFixed(1)} 秒，${engineLabel}${voiceName ? `（${voiceName}）` : ''}，${result.msgId ? '被动回复' : '主动消息'}。`,
        }
      } catch (error) {
        return { ok: false, message: `发语音失败：${error?.message ?? error}` }
      }
    },
  })

  // ---------------------------------------------------------------- 截屏
  const screenshotTool = defineTool({
    name: 'qq_screenshot',
    description:
      '截取本机电脑屏幕并发到 QQ（dsh-qq-hands 插件）。'
      + '主人说「看看我屏幕」「截个图发我」时用它。region 可裁剪 ("x,y,w,h")，display 选显示器序号（从 0 开始），delayMs 先等一下再截。',
    parameters: commonParams({
      region: { type: 'string', description: '裁剪区域 "x,y,w,h"（可选）' },
      display: { type: 'string', description: '显示器序号，默认 0' },
      delayMs: { type: 'string', description: '截图前等待毫秒数，默认 0（最大 10000）' },
      format: { type: 'string', description: "png 或 jpg，默认 jpg（体积小）" },
      maxWidth: { type: 'string', description: '超过该宽度就等比缩小，默认 1600' },
      note: { type: 'string', description: '发图前先说一句（可选）' },
      savePath: { type: 'string', description: '同时把截图保存到这个路径（可选）' },
    }),
    output: { schema: { type: 'json' }, render: renderText },
    async execute(args) {
      try {
        const media = await import('./lib/media.js')
        const shot = await media.captureScreen({
          display: Number(args.display) || 0,
          region: text(args.region) || undefined,
          delayMs: Number(args.delayMs) || 0,
          format: text(args.format) || 'jpg',
          maxWidth: Number(args.maxWidth) || 1600,
        })
        if (text(args.savePath)) {
          const out = path.resolve(text(args.savePath))
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, shot.data)
        }
        const { info, api } = await client()
        const target = api.target(args.chat, info.openid)
        const mode = text(args.mode) || 'auto'
        const note = text(args.note)
        if (note) await api.sendText(target, note, { mode, burst: false, minGapMs: cfg.minGapMs, maxGapMs: cfg.maxGapMs })
        const result = await api.sendMedia(target, {
          fileType: 1,
          name: `screenshot.${shot.format}`,
          data: shot.data,
          mode,
        })
        return {
          ok: true,
          width: shot.width,
          height: shot.height,
          message: `已发到 QQ：屏幕截图 ${shot.width}x${shot.height}，${(shot.data.length / 1024).toFixed(0)}KB，${result.msgId ? '被动回复' : '主动消息'}。`,
        }
      } catch (error) {
        return { ok: false, message: `截图发送失败：${error?.message ?? error}` }
      }
    },
  })

  // ---------------------------------------------------------------- 文件
  const sendFileTool = defineTool({
    name: 'qq_send_file',
    description:
      '把本机文件发到 QQ（dsh-qq-hands 插件）。≤5MB 直传，更大自动分片上传，上限 200MB。'
      + '主人说「发我文件」「把这个传我」时用它；路径必须是绝对路径。',
    parameters: commonParams({
      path: { type: 'string', description: '文件绝对路径（必填）' },
      name: { type: 'string', description: '显示的文件名（可选，默认用原文件名）' },
      note: { type: 'string', description: '发文件前先说一句（可选）' },
    }),
    output: { schema: { type: 'json' }, render: renderText },
    async execute(args) {
      const raw = text(args.path)
      if (!raw) return { ok: false, message: '缺少 path' }
      try {
        const resolved = path.resolve(raw)
        if (!fs.existsSync(resolved)) return { ok: false, message: `文件不存在：${resolved}` }
        const data = readCapped(resolved, MAX_FILE_BYTES)
        const { info, api } = await client()
        const target = api.target(args.chat, info.openid)
        const mode = text(args.mode) || 'auto'
        const note = text(args.note)
        if (note) await api.sendText(target, note, { mode, burst: false, minGapMs: cfg.minGapMs, maxGapMs: cfg.maxGapMs })
        const name = text(args.name) || path.basename(resolved)
        const fileType = api.mediaFileType(name, data)
        const result = await api.sendMedia(target, { fileType, name, data, mode })
        return {
          ok: true,
          bytes: data.length,
          message: `已发到 QQ：${name}（${(data.length / 1024 / 1024).toFixed(2)}MB），${result.msgId ? '被动回复' : '主动消息'}。`,
        }
      } catch (error) {
        return { ok: false, message: `发文件失败：${error?.message ?? error}` }
      }
    },
  })

  // ---------------------------------------------------------------- 状态
  const statusTool = defineTool({
    name: 'qq_status',
    description: '查看 dsh-qq-hands 的状态：QQ 账号绑定、token、表情库、TTS/截图环境、被动回复余额、发送统计。排查「QQ 发不出去」时先用它。',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderText },
    async execute() {
      const lines = []
      try {
        const info = await account()
        const api = await (async () => (await client()).api)()
        let tokenOk = false
        try { await api.accessToken(); tokenOk = true } catch (error) { lines.push(`token：失败 ${error?.message ?? error}`) }
        lines.push(`账号：${info.accountId}（appId ${info.appId}）`)
        lines.push(`主人 openid：${info.openid}`)
        lines.push(`token：${tokenOk ? '正常' : '不可用'}`)
        const budget = state.passiveBudget(`dm:${info.openid}`)
        lines.push(`被动回复：${budget.remaining ? `还剩 ${budget.remaining} 次（凭据 ${String(budget.msgId).slice(0, 8)}…）` : '当前没有可用凭据，只能发主动消息'}`)
      } catch (error) {
        lines.push(`账号：不可用 —— ${error?.message ?? error}`)
      }
      try {
        const lib = await memeLibraryInfo()
        lines.push(`表情库：${lib.count} 张，分类 ${lib.tags.join('/') || '(空)'}`)
      } catch (error) {
        lines.push(`表情库：读取失败 ${error?.message ?? error}`)
      }
      try {
        const media = await import('./lib/media.js')
        const env = await media.probeEnv()
        lines.push(`语音/截图：PowerShell ${env.powershell ? '可用' : '缺失'}，中文声音 ${env.voices.length} 个，ffmpeg ${env.ffmpeg ? `可用（${env.ffmpegPath || 'PATH'}）` : '缺失'}`)
        // Edge 语音是本机新音色的来源，单独报一句，免得主人以为还在用 SAPI
        try {
          const edge = await import('./lib/tts-edge.js')
          const ok = await edge.probeEdgeTts()
          lines.push(ok
            ? `语音引擎：Edge 神经网络语音可用（默认 ${edge.EDGE_VOICES[edge.DEFAULT_EDGE_VOICE].label}）`
            : '语音引擎：Edge 不可用（缺 edge-tts 或网络），会回落 SAPI 老声音')
        } catch (error) {
          lines.push(`语音引擎：Edge 探测失败 ${error?.message ?? error}`)
        }
      } catch (error) {
        lines.push(`媒体环境：探测失败 ${error?.message ?? error}`)
      }
      lines.push(`回复分条：${cfg.burst === false ? '关闭' : `开启（最多 ${cfg.maxBubbles} 条，间隔 ${cfg.minGapMs}~${cfg.maxGapMs}ms）`}`)
      const stats = state.raw.stats || {}
      lines.push(`统计：文字 ${stats.text || 0} / 图 ${stats.image || 0} / 语音 ${stats.voice || 0} / 文件 ${stats.file || 0} / 气泡 ${stats.bubbles || 0} / 主动 ${stats.active || 0} / 被动 ${stats.passive || 0} / 失败 ${stats.failed || 0}`)
      lines.push(`账本：${stateFile}`)
      return { ok: true, message: lines.join('\n') }
    },
  })

  for (const tool of [sendTextTool, sendImageTool, sendVoiceTool, screenshotTool, sendFileTool, statusTool]) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      console.error(`[dsh-qq-hands] 注册工具 ${tool?.name} 失败：`, error?.message ?? error)
    }
  }
  log('ready —— 工具 qq_send_text / qq_send_image / qq_send_voice / qq_screenshot / qq_send_file / qq_status')
}

export { searchMemes }
