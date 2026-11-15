// Agnes AI API 客户端（生图 / 生视频）——零依赖，纯 Node。
// Base: https://apihub.agnes-ai.com/v1
// 认证: Authorization: Bearer <API_KEY>
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1'
export const QUERY_BASE_URL = 'https://apihub.agnes-ai.com/agnesapi'

export const IMAGE_MODELS = ['agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-image-2.5-flash']
export const VIDEO_MODELS = ['agnes-video-2.5', 'agnes-video-2.5-flash']
export const IMAGE_SIZES = ['1024x1024', '1024x768', '768x1024', '1280x720', '720x1280', '1536x1024', '1024x1536', '2048x2048']
export const VIDEO_SIZES = ['720P', '1080P', '1K', '2K']
export const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
export const VIDEO_MODES = ['text', 'keyframe', 'reference']
/** 文档明令禁用、传了会 400 的字段，用来在本地先拦一道。 */
export const FORBIDDEN_VIDEO_FIELDS = [
  'video_url', 'video_path', 'video_reference', 'input_reference', 'reference_url',
  'width', 'height', 'fps', 'num_frames', 'quality', 'num_inference_steps',
]
/** 可重试的瞬时错误：限流 / 排队满 / 网关抖动。 */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }

export class AgnesError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message)
    this.name = 'AgnesError'
    this.status = status
    this.code = code
    this.body = body
  }
}

const trimBase = (url) => String(url ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

function apiError(status, payload) {
  const detail = payload?.error?.message ?? payload?.message ?? payload?.error ?? payload?.detail
  const text = typeof detail === 'string' ? detail : detail === undefined ? '' : JSON.stringify(detail)
  const code = payload?.error?.code ?? payload?.code
  return new AgnesError(`Agnes API ${status}${text ? `: ${text}` : ''}`, { status, code, body: payload })
}

async function readJson(res) {
  const text = await res.text()
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 2000) }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new AgnesError('已取消'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 指数退避重试：只重试瞬时错误（429/5xx/网络抖动）。 */
async function withRetry(fn, { attempts = 6, baseDelayMs = 8000, maxDelayMs = 90000, signal, onRetry } = {}) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const status = error instanceof AgnesError ? error.status : undefined
      const retryable = error instanceof AgnesError ? RETRYABLE_STATUS.has(status) : error?.name !== 'AbortError'
      if (!retryable || i === attempts - 1) throw error
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** i)
      if (typeof onRetry === 'function') onRetry({ attempt: i + 1, delayMs: delay, error })
      await sleep(delay, signal)
    }
  }
  throw lastError
}

/**
 * @param {{ apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch }} options
 */
export function createAgnesClient(options = {}) {
  const apiKey = String(options.apiKey ?? '').trim()
  if (apiKey === '') throw new AgnesError('缺少 Agnes API key（config.apiKey / 环境变量 AGNES_API_KEY / agnes.config.json）')
  const baseUrl = trimBase(options.baseUrl)
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new AgnesError('当前运行环境没有 fetch，无法调用 Agnes API')

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }

  async function post(path, body, { timeoutMs = 600000, signal, retry } = {}) {
    const send = async () => {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      })
      const payload = await readJson(res)
      if (!res.ok) throw apiError(res.status, payload)
      return payload
    }
    return retry === false ? send() : withRetry(send, { signal, ...(retry ?? {}) })
  }

  /** 生图。images 为图生图/合成的参考图（http(s) URL 或 data:image/...;base64,...）。 */
  async function generateImage({ model, prompt, size, images, returnBase64 = false, timeoutMs, signal, retry, onRetry } = {}) {
    const extra = { response_format: returnBase64 ? 'b64_json' : 'url' }
    const refs = (Array.isArray(images) ? images : []).filter((item) => typeof item === 'string' && item !== '')
    if (refs.length > 0) extra.image = refs // 图生图：extra_body.image 与顶层 image 实测都生效，两个都带上
    const body = {
      model: model ?? 'agnes-image-2.5-flash',
      prompt,
      size: size ?? '1024x1024',
      extra_body: extra,
      ...(returnBase64 ? { return_base64: true } : {}),
      ...(refs.length > 0 ? { image: refs } : {}),
    }
    const payload = await post('/images/generations', body, { timeoutMs, signal, retry: { onRetry, ...(retry ?? {}) } })
    const item = Array.isArray(payload?.data) ? payload.data[0] : undefined
    if (item === undefined) throw new AgnesError('Agnes 图像接口没有返回 data[0]', { body: payload })
    return {
      url: item.url || undefined,
      b64: item.b64_json || undefined,
      revisedPrompt: item.revised_prompt || undefined,
      taskId: payload?.task_id || undefined,
      created: payload?.created,
      raw: payload,
    }
  }

  /** 创建视频任务（异步）。排队满（503 video_queue_full）会自动重试。 */
  async function createVideo(params = {}, { timeoutMs = 180000, signal, retry, onRetry } = {}) {
    const body = { ...params }
    const bad = FORBIDDEN_VIDEO_FIELDS.filter((key) => body[key] !== undefined)
    if (bad.length > 0) throw new AgnesError(`Agnes 视频接口不支持这些参数（会 400）：${bad.join(', ')}`)
    if (body.mode === undefined) body.mode = 'text'
    if (body.mode === 'keyframe' && body.first_frame === undefined && body.last_frame === undefined) {
      throw new AgnesError('keyframe 模式至少要给 first_frame 或 last_frame')
    }
    if (body.mode === 'text') {
      for (const key of ['images', 'audios', 'videos', 'first_frame', 'last_frame']) {
        if (body[key] !== undefined) throw new AgnesError(`text 模式不能带 ${key}（请改用 keyframe / reference 模式）`)
      }
    }
    if (body.mode === 'keyframe') {
      for (const key of ['images', 'audios', 'videos']) {
        if (body[key] !== undefined) throw new AgnesError(`keyframe 模式不能带 ${key}`)
      }
    }
    if (body.mode === 'reference') {
      if (body.first_frame !== undefined || body.last_frame !== undefined) {
        throw new AgnesError('reference 模式不能带 first_frame / last_frame')
      }
      const anyMedia = ['images', 'audios', 'videos'].some((key) => Array.isArray(body[key]) && body[key].length > 0)
      if (!anyMedia) throw new AgnesError('reference 模式至少要给 images / audios / videos 之一')
    }
    const payload = await post('/videos', body, {
      timeoutMs,
      signal,
      // 视频队列经常满，多给几次机会（约 2 分钟窗口）
      retry: { attempts: 8, baseDelayMs: 15000, maxDelayMs: 60000, onRetry, ...(retry ?? {}) },
    })
    return { ...payload, model: body.model ?? 'agnes-video-2.5', mode: body.mode }
  }

  /** 查询视频任务状态。 */
  async function queryVideo(videoId, model, { timeoutMs = 60000, signal, retry } = {}) {
    if (!videoId) throw new AgnesError('查询视频需要 video_id')
    const params = new URLSearchParams({ video_id: String(videoId) })
    if (model) params.set('model_name', String(model))
    const send = async () => {
      const res = await doFetch(`${QUERY_BASE_URL}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      })
      const payload = await readJson(res)
      if (!res.ok) throw apiError(res.status, payload)
      return payload
    }
    return retry === false ? send() : withRetry(send, { attempts: 4, baseDelayMs: 4000, signal, ...(retry ?? {}) })
  }

  /** 轮询到终态；返回最后一次响应（含 url）。 */
  async function waitVideo(videoId, model, { intervalMs = 3000, timeoutMs = 1200000, signal, onProgress } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = {}
    for (;;) {
      last = await queryVideo(videoId, model, { signal })
      const status = String(last?.status ?? '').toLowerCase()
      if (typeof onProgress === 'function') onProgress(last)
      if (status === 'completed' || status === 'succeeded' || status === 'success') return last
      if (status === 'failed' || status === 'error' || status === 'canceled' || status === 'cancelled') {
        const message = last?.error?.message ?? last?.message ?? 'Agnes 视频任务失败'
        throw new AgnesError(String(message), { code: 'VIDEO_TASK_FAILED', body: last })
      }
      if (Date.now() >= deadline) {
        throw new AgnesError(`等待超时（${Math.round(timeoutMs / 1000)}s），任务 ${videoId} 仍在 ${status || '未知'} 状态`, {
          code: 'VIDEO_TIMEOUT',
          body: last,
        })
      }
      await sleep(intervalMs, signal)
    }
  }

  /** 下载远端产物到本地文件。 */
  async function download(url, destPath, { timeoutMs = 300000, signal, retry } = {}) {
    const send = async () => {
      const res = await doFetch(url, { signal: signal ?? AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw apiError(res.status, { message: `下载失败 ${url}` })
      const buffer = Buffer.from(await res.arrayBuffer())
      mkdirSync(dirname(destPath), { recursive: true })
      writeFileSync(destPath, buffer)
      return { path: destPath, bytes: buffer.byteLength, buffer }
    }
    return retry === false ? send() : withRetry(send, { attempts: 3, baseDelayMs: 3000, signal, ...(retry ?? {}) })
  }

  return { apiKey, baseUrl, generateImage, createVideo, queryVideo, waitVideo, download, post }
}

/** 本地图片路径 -> data URI；已经是 URL 或 data URI 的原样返回。 */
export function toImageRef(input, { maxBytes = 12 * 1024 * 1024 } = {}) {
  const value = String(input ?? '').trim()
  if (value === '') throw new AgnesError('参考图路径为空')
  if (/^https?:\/\//i.test(value)) return { ref: value, kind: 'url' }
  if (value.startsWith('data:')) return { ref: value, kind: 'data' }
  if (!existsSync(value)) throw new AgnesError(`参考图不存在：${value}`)
  const buf = readFileSync(value)
  if (buf.byteLength > maxBytes) throw new AgnesError(`参考图超过 ${Math.round(maxBytes / 1048576)}MB：${value}`)
  const ext = value.toLowerCase().split('.').pop()
  return {
    ref: `data:${MIME_BY_EXT[ext] ?? 'image/png'};base64,${buf.toString('base64')}`,
    kind: 'file',
    bytes: buf.byteLength,
    mime: MIME_BY_EXT[ext] ?? 'image/png',
  }
}

/** 远端 URL 或本地路径统一成 data URI / URL 列表（视频接口的 first_frame 等只吃 URL）。 */
export function toMediaList(value, options) {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]
  return list.map((item) => toImageRef(item, options).ref)
}

export function guessMime(name = '') {
  const ext = String(name).toLowerCase().split('.').pop()
  return MIME_BY_EXT[ext] ?? 'image/png'
}
