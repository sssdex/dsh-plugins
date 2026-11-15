// 视频接口连通性测试：建任务 -> 轮询 -> 下载 mp4
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createAgnesClient } from '../lib/agnes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, '..', 'agnes.config.json'), 'utf8'))
const client = createAgnesClient({ apiKey: cfg.apiKey })

const model = process.env.AGNES_VIDEO_MODEL ?? 'agnes-video-2.5-flash'
const outDir = join(here, '..', 'out')
mkdirSync(outDir, { recursive: true })

const t0 = Date.now()
const created = await client.createVideo({
  model,
  prompt: '一只蓝发鲸鱼女仆在浅海里转圈，鲸尾拍起水花，镜头缓缓拉远，阳光透过水面',
  mode: 'text',
  seconds: '4',
  size: '720P',
  aspect_ratio: '16:9',
})
const compact = JSON.stringify(created).slice(0, 1200)
console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] create ->`, compact)

const videoId = created.video_id ?? created.id ?? created.task_id
const status = String(created.status ?? '').toLowerCase()
let final = created
if (!(status === 'completed' || status === 'succeeded' || status === 'success') && videoId) {
  final = await client.waitVideo(videoId, model, {
    intervalMs: 3000,
    timeoutMs: 900000,
    onProgress: (p) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] poll`, p?.status, p?.progress ?? ''),
  })
}
console.log('final ->', JSON.stringify(final).slice(0, 1500))

const url = final.url ?? final.video_url ?? final?.data?.url
if (url) {
  const dest = join(outDir, `test-video-${model}.mp4`)
  const saved = await client.download(url, dest)
  console.log(`downloaded ${saved.path} (${saved.bytes} bytes) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  writeFileSync(join(outDir, `test-video-${model}.json`), JSON.stringify({ created, final, url }, null, 2))
} else {
  console.log('!! 没有拿到 url 字段，完整响应：', JSON.stringify(final).slice(0, 4000))
}
