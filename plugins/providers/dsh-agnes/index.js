/**
 * dsh-agnes — 把 Agnes AI 的多模态能力（生图 / 生视频）接进 DeepSeek Harness。
 *
 * 注册三个 agent 工具：
 *   agnes_image         文生图 / 图生图 / 多图合成
 *   agnes_video         文生视频 / 首尾帧 / 参考素材（图片·音频·视频）驱动
 *   agnes_video_status  查任务进度，完成后可顺手下载 mp4
 *
 * 配置（cordis.patch.yml 的 config，或环境变量，或 $DSH_HOME/agnes.config.json）：
 *   { apiKey, baseUrl?, outputDir?, imageModel?, videoModel? }
 * 生成的图片/视频默认落在会话工作目录的 agnes-out/ 下，图片还会作为图片块回给模型看。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgnesError,
  ASPECT_RATIOS,
  IMAGE_MODELS,
  IMAGE_SIZES,
  VIDEO_MODELS,
  VIDEO_MODES,
  VIDEO_SIZES,
  createAgnesClient,
  guessMime,
  toImageRef,
} from './lib/agnes.mjs'

export const name = 'dsh-agnes'
export const inject = ['tools']

const DEFAULT_OUTPUT_DIR = 'agnes-out'
const DEFAULT_IMAGE_MODEL = 'agnes-image-2.5-flash'
const DEFAULT_VIDEO_MODEL = 'agnes-video-2.5'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DIAG_LOG = join(PLUGIN_DIR, 'out', '.diagnostics.log')

/** 把任意值摊平成 "路径 = 类型 值" 的清单，undefined 一眼可见（排查 lossless JSON 用）。 */
function describeValue(value, prefix = '', out = []) {
  if (value === undefined) {
    out.push(`${prefix} = <undefined>`)
    return out
  }
  if (value === null || typeof value !== 'object') {
    out.push(`${prefix} = ${typeof value} ${String(value).slice(0, 60)}`)
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => describeValue(item, `${prefix}[${index}]`, out))
    return out
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    out.push(`${prefix} = <${value?.constructor?.name ?? 'object'}>`)
    return out
  }
  for (const [key, item] of Object.entries(value)) describeValue(item, prefix === '' ? key : `${prefix}.${key}`, out)
  return out
}

/** 追加一段诊断（插件自身排障用；失败就算了）。 */
function diag(...lines) {
  try {
    mkdirSync(dirname(DIAG_LOG), { recursive: true })
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${lines.join(' ')}\n`)
  } catch {
    /* 诊断写不进去也不影响工具本体 */
  }
}

/** 读取 agnes.config.json：插件目录 → $DSH_HOME → $DSH_PROFILE_DIR（key 不写死在代码里）。 */
function readConfigFile() {
  const here = dirname(fileURLToPath(import.meta.url))
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [
    join(here, 'agnes.config.json'),
    join(home, 'agnes.config.json'),
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'agnes.config.json') : '',
  ].filter(Boolean)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      /* 配置文件坏了就忽略，继续找下一个 */
    }
  }
  return {}
}

function slugify(text, max = 40) {
  const cleaned = String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (cleaned || 'agnes').slice(0, max)
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function imageRefOf(ref) {
  return compact({
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    name: ref.name,
  })
}

const fail = (message) => ({ ok: false, message })

/** 工具返回值必须是 lossless JSON：递归丢掉值为 undefined 的键。 */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter((item) => item !== undefined)
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value // Buffer / Date 等原样留着，别拆坏
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const cleaned = compact(item)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return out
  }
  return value
}

export function apply(ctx, config = {}) {
  diag(`apply() mounted, pluginDir=${PLUGIN_DIR}, pid=${process.pid}`)
  const fileConfig = readConfigFile()
  const apiKey = String(config.apiKey ?? process.env.AGNES_API_KEY ?? fileConfig.apiKey ?? '').trim()
  const baseUrl = config.baseUrl ?? process.env.AGNES_BASE_URL ?? fileConfig.baseUrl ?? undefined
  const defaultOutputDir = String(config.outputDir ?? fileConfig.outputDir ?? DEFAULT_OUTPUT_DIR)
  const defaultImageModel = String(config.imageModel ?? DEFAULT_IMAGE_MODEL)
  const defaultVideoModel = String(config.videoModel ?? DEFAULT_VIDEO_MODEL)

  let client = null
  function getClient() {
    if (client === null) client = createAgnesClient({ apiKey, baseUrl })
    return client
  }
  const noKey = () =>
    fail('没配置 Agnes API key。请在插件的 config.apiKey、环境变量 AGNES_API_KEY，或 $DSH_HOME/agnes.config.json 里放上 key。')

  function outDirFor(args, exec) {
    const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
    const wanted = args.output_dir || defaultOutputDir
    return isAbsolute(wanted) ? wanted : resolve(cwd, wanted)
  }

  function uniquePath(dir, fileName, ext) {
    mkdirSync(dir, { recursive: true })
    const base = fileName ? slugify(fileName, 60) : `${stamp()}-${Math.random().toString(36).slice(2, 6)}`
    let path = join(dir, base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`)
    let i = 2
    while (existsSync(path)) path = join(dir, `${base}-${i++}${ext}`)
    return path
  }

  // ────────────────────────────── agnes_image ──────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'agnes_image',
      description:
        '用 Agnes AI 生成图片（文生图 / 图生图 / 多图合成），返回本地文件路径与图片本身。' +
        `模型：${IMAGE_MODELS.join(' / ')}；尺寸如 1024x1024、1024x768。` +
        '图生图/合成时把原图放进 reference_images（公网 URL 或本地文件路径都行）。' +
        '需要改图、换背景、合成、出素材图时用这个工具。',
      timeoutMs: 600000,
      parameters: {
        prompt: { type: 'string', required: true, description: '画面描述（中文/英文均可，越具体越好）' },
        model: { type: 'string', description: `图像模型，默认 ${DEFAULT_IMAGE_MODEL}`, enum: IMAGE_MODELS },
        size: { type: 'string', description: '输出尺寸，默认 1024x1024', enum: IMAGE_SIZES },
        reference_images: {
          type: 'array',
          description: '参考图列表（http(s) URL、本地路径或 data URI）。给了就是图生图/多图合成',
        },
        file_name: { type: 'string', description: '文件名（不含扩展名），不给就自动起名' },
        output_dir: { type: 'string', description: `输出目录，默认会话工作目录下的 ${DEFAULT_OUTPUT_DIR}/` },
        save: { type: 'boolean', description: '是否把图片存到本地文件，默认 true' },
        attach: { type: 'boolean', description: '是否把生成的图片附回对话给模型看，默认 true' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [
          { type: 'text', text: value.message },
          ...(value.image === undefined ? [] : [{ type: 'image', attachment: value.image }]),
        ],
      },
      async execute(args, exec) {
        const prompt = String(args.prompt ?? '').trim()
        if (prompt === '') return fail('prompt 不能为空')
        if (apiKey === '') return noKey()
        const signal = exec?.signal
        try {
          signal?.throwIfAborted?.()
          const refs = []
          for (const item of Array.isArray(args.reference_images) ? args.reference_images : []) {
            const { ref } = toImageRef(resolvePath(item, exec))
            refs.push(ref)
          }
          const model = args.model ?? defaultImageModel
          const size = args.size ?? '1024x1024'
          const wantsFile = args.save !== false
          const result = await getClient().generateImage({ model, prompt, size, images: refs, signal })
          const dir = outDirFor(args, exec)
          let file
          let bytes
          if (result.b64) {
            bytes = Buffer.from(result.b64, 'base64')
          } else if (result.url) {
            const res = await fetch(result.url, { signal: signal ?? AbortSignal.timeout(300000) })
            if (!res.ok) throw new AgnesError(`下载生成结果失败：HTTP ${res.status}`, { status: res.status })
            bytes = Buffer.from(await res.arrayBuffer())
          }
          if (wantsFile && bytes) {
            file = uniquePath(dir, args.file_name, '.png')
            writeFileSync(file, bytes)
          }
          let image
          const attachments = ctx.get?.('attachments')
          if (args.attach !== false && bytes && attachments && typeof attachments.saveImage === 'function') {
            try {
              const input = { data: bytes, mediaType: guessMime(file ?? '.png') }
              if (file) input.name = file.split(/[\\/]/).pop()
              image = imageRefOf(await attachments.saveImage(input))
            } catch {
              image = undefined // 附件入库失败不影响产图
            }
          }
          const kind = refs.length > 0 ? '图生图' : '文生图'
          const payload = {
            ok: true,
            kind,
            model,
            size,
            file,
            url: result.url,
            revised_prompt: result.revisedPrompt,
            task_id: result.taskId,
            image,
            message:
              `${kind}完成（${model} · ${size}）` +
              (file ? `\n文件：${file}` : result.url ? `\nURL：${result.url}` : '') +
              (result.revisedPrompt ? `\n模型改写后的提示词：${result.revisedPrompt}` : '') +
              (image === undefined ? '' : '\n（图片已附在下面）'),
          }
          diag(`agnes_image raw value:\n  ${describeValue(payload).join('\n  ')}`)
          return compact(payload)
        } catch (error) {
          return fail(`生图失败：${errorMessage(error)}`)
        }
      },
    }),
  )

  // ────────────────────────────── agnes_video ──────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'agnes_video',
      description:
        '用 Agnes AI 生成视频（异步任务，本工具会等到出结果或等到 max_wait_seconds 用完）。' +
        `模式 mode：text（纯提示词）/ keyframe（首帧 first_frame、尾帧 last_frame）/ reference（参考素材 images、audios、videos）。` +
        `模型：${VIDEO_MODELS.join(' / ')}（-flash 更便宜更快，只能 720P、素材上限更低）；时长 seconds 4~12；尺寸 720P/1080P/1K/2K；比例 21:9/16:9/4:3/1:1/3:4/9:16。` +
        '还没跑完就返回任务 id，用 agnes_video_status 继续查。',
      timeoutMs: 1800000,
      parameters: {
        prompt: { type: 'string', required: true, description: '视频描述。reference 模式可用 <Picture 1>/<Audio 1>/<Video 1> 指代素材' },
        mode: { type: 'string', description: '生成模式，默认 text', enum: VIDEO_MODES },
        model: { type: 'string', description: `视频模型，默认 ${DEFAULT_VIDEO_MODEL}`, enum: VIDEO_MODELS },
        seconds: { type: 'string', description: '时长（秒），"4"~"12"，默认 "5"' },
        size: { type: 'string', description: '分辨率，默认 720P（-flash 只能 720P）', enum: VIDEO_SIZES },
        aspect_ratio: { type: 'string', description: '画面比例，默认 16:9', enum: ASPECT_RATIOS },
        seed: { type: 'integer', description: '随机种子（可选）' },
        first_frame: { type: 'string', description: 'keyframe 模式首帧（公网 URL 最稳）' },
        last_frame: { type: 'string', description: 'keyframe 模式尾帧（公网 URL 最稳）' },
        images: { type: 'array', description: 'reference 模式的参考图（URL / 本地路径 / data URI，最多 8 张）' },
        audios: { type: 'array', description: 'reference 模式的参考音频（URL）' },
        videos: { type: 'array', description: 'reference 模式的参考视频：[{url, start_seconds?, require_audio?}]（2.5 最多 1 段）' },
        file_name: { type: 'string', description: 'mp4 文件名（不含扩展名）' },
        output_dir: { type: 'string', description: `输出目录，默认会话工作目录下的 ${DEFAULT_OUTPUT_DIR}/` },
        save: { type: 'boolean', description: '完成后是否下载 mp4 到本地，默认 true' },
        wait: { type: 'boolean', description: '是否在这里等任务跑完，默认 true' },
        max_wait_seconds: { type: 'integer', description: '最多等多少秒（默认 600，最多 1500）' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        const prompt = String(args.prompt ?? '').trim()
        if (prompt === '') return fail('prompt 不能为空')
        if (apiKey === '') return noKey()
        const signal = exec?.signal
        try {
          signal?.throwIfAborted?.()
          const mode = args.mode ?? 'text'
          const model = args.model ?? defaultVideoModel
          const size = args.size ?? '720P'
          const params = { model, prompt, mode, seconds: args.seconds ?? '5', size, aspect_ratio: args.aspect_ratio ?? '16:9' }
          if (args.seed !== undefined) params.seed = args.seed
          if (args.first_frame) params.first_frame = toImageRef(resolvePath(args.first_frame, exec)).ref
          if (args.last_frame) params.last_frame = toImageRef(resolvePath(args.last_frame, exec)).ref
          if (Array.isArray(args.images) && args.images.length > 0) params.images = args.images.map((i) => toImageRef(resolvePath(i, exec)).ref)
          if (Array.isArray(args.audios) && args.audios.length > 0) params.audios = args.audios.map((i) => resolvePath(i, exec))
          if (Array.isArray(args.videos) && args.videos.length > 0) params.videos = args.videos

          const created = await getClient().createVideo(params, { signal })
          const videoId = created.video_id ?? created.id ?? created.task_id
          const head = `视频任务已创建（${model} · ${mode} · ${secondsOf(params)}s · ${size}）\nvideo_id：${videoId}\n初始状态：${created.status ?? 'queued'}`
          if (args.wait === false) return compact({ ok: true, phase: 'created', video_id: videoId, status: created.status, message: `${head}\n（未等待，稍后用 agnes_video_status 查询）` })

          const maxWait = Math.min(Math.max(Number(args.max_wait_seconds ?? 600), 30), 1500) * 1000
          let final = created
          let timedOut = false
          try {
            final = await getClient().waitVideo(videoId, model, { timeoutMs: maxWait, signal })
          } catch (error) {
            if (error instanceof AgnesError && error.code === 'VIDEO_TIMEOUT') {
              final = error.body ?? {}
              timedOut = true
            } else {
              throw error
            }
          }
          if (timedOut) {
            return compact({
              ok: true,
              phase: 'in_progress',
              video_id: videoId,
              status: final?.status,
              progress: final?.progress,
              message: `${head}\n等了 ${Math.round(maxWait / 1000)}s 还没跑完，当前 ${final?.status ?? '未知'}${final?.progress !== undefined ? ` ${final.progress}%` : ''}。\n继续用 agnes_video_status（video_id=${videoId}）查询。`,
            })
          }
          const url = final?.url ?? final?.video_url ?? final?.data?.url
          let file
          if (url && args.save !== false) {
            const saved = await getClient().download(url, uniquePath(outDirFor(args, exec), args.file_name, '.mp4'), { signal })
            file = saved.path
          }
          return compact({
            ok: true,
            phase: 'completed',
            video_id: videoId,
            status: final?.status ?? 'completed',
            file,
            url,
            model,
            mode,
            seconds: params.seconds,
            size,
            use_audio: final?.use_audio,
            message: `视频生成完成 ✅\n${file ? `文件：${file}` : ''}${url ? `\nURL：${url}` : ''}`,
          })
        } catch (error) {
          return fail(`生视频失败：${errorMessage(error)}`)
        }
      },
    }),
  )

  // ─────────────────────────── agnes_video_status ──────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'agnes_video_status',
      description:
        '查询 Agnes 视频任务状态（agnes_video 返回 in_progress 时用它续查）。' +
        '可选 wait=true 在这里轮询到结束；完成后给 save=true 就顺手把 mp4 下载到本地。',
      timeoutMs: 1800000,
      parameters: {
        video_id: { type: 'string', required: true, description: 'agnes_video 返回的 video_id' },
        model: { type: 'string', description: '创建时用的模型（推荐带上，查询更准）', enum: VIDEO_MODELS },
        wait: { type: 'boolean', description: '是否轮询到结束，默认 false' },
        max_wait_seconds: { type: 'integer', description: 'wait=true 时最多等多少秒（默认 300，最多 1500）' },
        save: { type: 'boolean', description: '完成后是否下载 mp4，默认 true' },
        file_name: { type: 'string', description: 'mp4 文件名（不含扩展名）' },
        output_dir: { type: 'string', description: '输出目录（默认会话工作目录的 agnes-out/）' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      async execute(args, exec) {
        const videoId = String(args.video_id ?? '').trim()
        if (videoId === '') return fail('video_id 不能为空')
        if (apiKey === '') return noKey()
        const signal = exec?.signal
        const model = args.model ?? defaultVideoModel
        try {
          signal?.throwIfAborted?.()
          let current = await getClient().queryVideo(videoId, model, { signal })
          if (args.wait === true) {
            const status = String(current?.status ?? '').toLowerCase()
            const done = ['completed', 'succeeded', 'success', 'failed', 'error', 'canceled', 'cancelled'].includes(status)
            if (!done) {
              const maxWait = Math.min(Math.max(Number(args.max_wait_seconds ?? 300), 30), 1500) * 1000
              try {
                current = await getClient().waitVideo(videoId, model, { timeoutMs: maxWait, signal })
              } catch (error) {
                if (error instanceof AgnesError && error.code === 'VIDEO_TIMEOUT') current = error.body ?? current
                else if (error instanceof AgnesError && error.code === 'VIDEO_TASK_FAILED') current = error.body ?? current
                else throw error
              }
            }
          }
          const status = String(current?.status ?? '').toLowerCase()
          const url = current?.url ?? current?.video_url ?? current?.data?.url
          if (status === 'failed' || status === 'error' || status === 'canceled' || status === 'cancelled') {
            return fail(`视频任务失败（${videoId}）：${current?.error?.message ?? current?.message ?? status}`)
          }
          let file
          if (url && args.save !== false) {
            const saved = await getClient().download(url, uniquePath(outDirFor(args, exec), args.file_name, '.mp4'), { signal })
            file = saved.path
          }
          return compact({
            ok: true,
            video_id: videoId,
            status: current?.status,
            progress: current?.progress,
            file,
            url,
            message:
              `任务 ${videoId}：${current?.status ?? '未知'}` +
              (current?.progress !== undefined ? ` ${current.progress}%` : '') +
              (file ? `\n文件：${file}` : '') +
              (url ? `\nURL：${url}` : ''),
          })
        } catch (error) {
          return fail(`查视频失败：${errorMessage(error)}`)
        }
      },
    }),
  )
}

function resolvePath(value, exec) {
  const raw = String(value ?? '').trim()
  if (raw === '' || /^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw
  if (isAbsolute(raw)) return raw
  const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
  return resolve(cwd, raw)
}

function secondsOf(params) {
  return params.seconds ?? '5'
}

function errorMessage(error) {
  if (error instanceof AgnesError) {
    const extra = error.status ? `（HTTP ${error.status}${error.code ? ` · ${error.code}` : ''}）` : ''
    return `${error.message}${extra}`
  }
  return error instanceof Error ? error.message : String(error)
}
