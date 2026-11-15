// 视频队列经常满(503 video_queue_full)：耐心排队 + 建任务 + 轮询 + 下载
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createAgnesClient, AgnesError } from '../lib/agnes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, '..', 'agnes.config.json'), 'utf8'))
const client = createAgnesClient({ apiKey: cfg.apiKey })

const model = process.env.AGNES_VIDEO_MODEL ?? 'agnes-video-2.5-flash'
const totalWaitMs = Number(process.env.AGNES_QUEUE_WAIT_MS ?? 25 * 60 * 1000)
const outDir = join(here, '..', 'out')
mkdirSync(outDir, { recursive: true })
const t0 = Date.now()
const el = () => ((Date.now() - t0) / 1000).toFixed(0)

const params = {
  model,
  prompt: '一只蓝发鲸鱼女仆在浅海里转圈，鲸尾拍起水花，气泡上浮，镜头缓缓拉远，阳光透过水面',
  mode: 'text',
  seconds: '4',
  size: '720P',
  aspect_ratio: '16:9',
}

let created = null
let attempt = 0
while (created === null) {
  attempt += 1
  try {
    created = await client.createVideo(params, { retry: false })
    console.log(`[${el()}s] 第 ${attempt} 次建任务成功`)
  } catch (error) {
    const queueFull = error instanceof AgnesError && (error.code === 'video_queue_full' || error.status === 503)
    console.log(`[${el()}s] 第 ${attempt} 次被拒：${error.message}`)
    if (!queueFull || Date.now() - t0 > totalWaitMs) throw error
    await new Promise((r) => setTimeout(r, 60000))
  }
}

const videoId = created.video_id ?? created.id ?? created.task_id
console.log(`[${el()}s] video_id = ${videoId}，状态 ${created.status}`)
const final = await client.waitVideo(videoId, model, {
  intervalMs: 3000,
  timeoutMs: 25 * 60 * 1000,
  onProgress: (p) => console.log(`[${el()}s] poll ${p?.status ?? '?'} ${p?.progress ?? ''}`),
})
console.log(`[${el()}s] final:`, JSON.stringify(final).slice(0, 900))

const url = final.url ?? final.video_url ?? final?.data?.url
if (url) {
  const dest = join(outDir, `test-video-${model}.mp4`)
  const saved = await client.download(url, dest)
  console.log(`[${el()}s] downloaded ${saved.path} (${saved.bytes} bytes)`)
  writeFileSync(join(outDir, `test-video-${model}.json`), JSON.stringify({ params, created, final }, null, 2))
} else {
  console.log('!! 没有 url 字段:', JSON.stringify(final).slice(0, 3000))
}
