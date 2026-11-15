/**
 * Edge 神经网络语音（少女音）→ SILK，给 QQ 语音用。
 *
 * 为什么不用 Windows SAPI：SAPI 的中文女声只有 Huihui / Yaoyao，是拼接式合成，
 * 语调平、停顿硬，主人一句「死板、难听」说得很准。Edge 的 Neural 声音是端到端模型，
 * zh-CN-Xiaoyi / Xiaoxiao 这批是真正的年轻女声。
 *
 * 为什么绕道 Python：Edge 接口现在要求 v2 版 DRM 令牌（`<16 位 CS64>-<64 位 SHA256>`），
 * 里面那套 CS64 是套改过初始状态的 SHA256，手写复刻风险大。
 * 本机已有 Python 3.12 + edge-tts 7.3.1（实测能用），直接借它的协议实现最稳。
 *
 * 为什么不需要 ffmpeg：edge-tts 只能出 mp3，本机没有 ffmpeg，
 * 所以用纯 WASM 的 mpg123-decoder 把 mp3 解成 PCM，再交给 silk-wasm 编码。
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { encode } from 'silk-wasm'
import { MPEGDecoder } from 'mpg123-decoder'

/**
 * 候选音色：都来自官方音色表实测可用的 zh-CN 女声（2026-10 核对）。
 * 中国大陆目前只有晓伊（活泼）和晓晓（温柔）两个年轻女声，其余是方言和男声；
 * 「更软更甜」是同一个晓伊抬调后的少女感版本。
 */
export const EDGE_VOICES = {
  xiaoyi: { name: 'zh-CN-XiaoyiNeural', label: '晓伊 · 少女活泼', style: { rate: '+8%', pitch: '+14Hz' } },
  xiaoyi_sweet: { name: 'zh-CN-XiaoyiNeural', label: '晓伊 · 更软更甜', style: { rate: '+4%', pitch: '+32Hz' } },
  xiaoxiao: { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔甜美', style: { rate: '+6%', pitch: '+20Hz' } },
  xiaoxiao_soft: { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 轻声撒娇', style: { rate: '-4%', pitch: '+26Hz', volume: '-10%' } },
  xiaobei: { name: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北姑娘', style: { rate: '+6%', pitch: '+10Hz' } },
  xiaoni: { name: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕北亮嗓', style: { rate: '+4%', pitch: '+8Hz' } },
  yunxia: { name: 'zh-CN-YunxiaNeural', label: '云夏 · 少年音', style: { rate: '+4%', pitch: '+6Hz' } },
}

/** 默认音色：少女感最强的晓伊（活泼）。 */
export const DEFAULT_EDGE_VOICE = 'xiaoyi'

/** 默认音调微抬、语速略快，贴「鲸鱼娘」的活泼语气。 */
export const DEFAULT_EDGE_STYLE = { rate: '+8%', pitch: '+14Hz', volume: '+0%' }

const PYTHON_CANDIDATES = [
  process.env.DSH_QQ_HANDS_PYTHON,
  process.env.DSH_PYTHON,
  'D:\\DeepSeek-DSH\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  'python',
].filter(Boolean)

let cachedPython = null
let checkedEdgeTts = false

function pythonPath() {
  if (cachedPython !== null) return cachedPython
  for (const candidate of PYTHON_CANDIDATES) {
    if (candidate === 'python') { cachedPython = candidate; return candidate }
    if (fs.existsSync(candidate)) { cachedPython = candidate; return candidate }
  }
  cachedPython = 'python'
  return cachedPython
}

function run(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出 */ }
      reject(new Error(`调用 ${path.basename(command)} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`退出码 ${code}：${(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 300)}`))
    })
  })
}

/** 探测 edge-tts 是否装在这个 Python 里（只查一次）。 */
export async function probeEdgeTts({ refresh = false } = {}) {
  if (checkedEdgeTts && !refresh) return true
  try {
    const py = pythonPath()
    await run(py, ['-c', 'import edge_tts,sys; sys.stdout.write(getattr(edge_tts, "__version__", "?"))'], { timeoutMs: 20_000 })
    checkedEdgeTts = true
    return true
  } catch {
    return false
  }
}

/** mp3 → 单声道 16bit PCM。edge-tts 固定出 24kHz mp3，所以这里不需要重采样。 */
function mp3ToPcm16(mp3) {
  const decoder = new MPEGDecoder()
  return decoder.ready.then(() => {
    try {
      const result = decoder.decode(new Uint8Array(mp3))
      const channels = result.channelData || []
      if (!channels.length || !result.samplesDecoded) throw new Error('mp3 解码没有拿到音频数据')
      const sampleRate = result.sampleRate || 24000
      const frames = result.samplesDecoded
      const pcm = Buffer.alloc(frames * 2)
      // 多声道取平均降成单声道：QQ 语音链路本来就是单声道。
      const mono = channels.length === 1
        ? channels[0]
        : Array.from({ length: frames }, (_, index) => {
          let sum = 0
          for (const channel of channels) sum += channel[index] || 0
          return sum / channels.length
        })
      for (let index = 0; index < frames; index += 1) {
        const sample = Math.max(-1, Math.min(1, mono[index] || 0))
        pcm.writeInt16LE(Math.round(sample * 32767), index * 2)
      }
      return { pcm, sampleRate }
    } finally {
      decoder.free()
    }
  })
}

/**
 * 合成 SLIK。返回 { silk, durationMs, voice, voiceId, mp3Bytes, sampleRate }。
 * text 上限 800 字：Edge 支持长文本，但语音消息太长没人听，调用方自己再收。
 *
 * voice 既接受本地音色 id（'xiaoyi' / 'xiaoyi_sweet'），也接受完整音色名
 * （'zh-CN-XiaoyiNeural'）。前者会连带套用它自己的语调预设。
 */
export async function synthesizeSilkEdge({
  text,
  voice = DEFAULT_EDGE_VOICE,
  rate,
  pitch,
  volume,
  timeoutMs = 90_000,
} = {}) {
  const spoken = String(text ?? '').trim()
  if (!spoken) throw new Error('要念的文字是空的')
  if (spoken.length > 800) throw new Error(`语音文字 ${spoken.length} 字太长，上限 800 字`)

  const preset = EDGE_VOICES[voice]
  const resolved = preset?.name || voice
  // 没显式给参数时用音色预设，再退到全局默认：抬调才有少女感，别让默认值盖掉预设。
  const style = {
    rate: rate ?? preset?.style?.rate ?? DEFAULT_EDGE_STYLE.rate,
    pitch: pitch ?? preset?.style?.pitch ?? DEFAULT_EDGE_STYLE.pitch,
    volume: volume ?? preset?.style?.volume ?? DEFAULT_EDGE_STYLE.volume,
  }
  const file = path.join(os.tmpdir(), `dsh-qq-hands-edge-${crypto.randomUUID()}.mp3`)
  try {
    const py = pythonPath()
    await run(py, [
      '-m', 'edge_tts',
      '--voice', resolved,
      `--rate=${normalizePercent(style.rate)}`,
      `--pitch=${normalizeHertz(style.pitch)}`,
      `--volume=${normalizePercent(style.volume)}`,
      '--text', spoken,
      '--write-media', file,
    ], { timeoutMs })

    const stat = fs.statSync(file)
    if (!stat.size) throw new Error('edge-tts 没有写出音频文件')
    const mp3 = fs.readFileSync(file)
    const { pcm, sampleRate } = await mp3ToPcm16(mp3)
    const encoded = await encode(pcm, sampleRate)
    const silk = Buffer.from(encoded.data)
    if (silk[0] !== 0x02) throw new Error('silk 编码结果异常（缺少 SILK v3 头）')
    return {
      silk,
      durationMs: encoded.duration || Math.round((pcm.length / 2 / sampleRate) * 1000),
      voice: resolved,
      voiceId: preset ? voice : '',
      style,
      mp3Bytes: mp3.length,
      pcmBytes: pcm.length,
      sampleRate,
    }
  } finally {
    fs.rm(file, { force: true }, () => {})
  }
}

/** edge-tts 的 CLI 要 `+8%` 这种格式，宽容接受 `8`、`8%`、`+8%`。 */
function normalizePercent(value) {
  if (value === undefined || value === null || value === '') return '+0%'
  const raw = String(value).trim()
  if (raw.includes('%')) return raw.startsWith('+') || raw.startsWith('-') ? raw : `+${raw}`
  const num = Number(raw)
  if (Number.isNaN(num)) return '+0%'
  return `${num >= 0 ? '+' : ''}${num}%`
}

function normalizeHertz(value) {
  if (value === undefined || value === null || value === '') return '+0Hz'
  const raw = String(value).trim()
  if (/hz$/i.test(raw)) return raw.startsWith('+') || raw.startsWith('-') ? raw : `+${raw}`
  const num = Number(raw)
  if (Number.isNaN(num)) return '+0Hz'
  return `${num >= 0 ? '+' : ''}${num}Hz`
}

/** 列出可用音色（本地固定表，不走网络）。 */
export function listEdgeVoices() {
  return Object.entries(EDGE_VOICES).map(([id, item]) => ({ id, ...item }))
}

if (process.argv[1]?.endsWith('tts-edge.mjs')) {
  const sample = '主人，这个声音是不是好听多了呀？鲸鱼娘终于不像念稿子的机器人啦。'
  for (const [id, item] of Object.entries(EDGE_VOICES).slice(0, 3)) {
    const started = Date.now()
    try {
      const result = await synthesizeSilkEdge({ text: sample, voice: item.name })
      const out = path.join(process.env.TEMP, `edge-${id}.silk`)
      fs.writeFileSync(out, result.silk)
      console.log(`✔ ${id} ${item.label} ${result.silk.length}B ${result.durationMs}ms ${Date.now() - started}ms -> ${out}`)
    } catch (error) {
      console.log(`✖ ${id} ${Date.now() - started}ms ${error?.message ?? error}`)
    }
  }
}
