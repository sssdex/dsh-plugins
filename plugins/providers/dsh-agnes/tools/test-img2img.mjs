// 图生图参数位置实测：顶层 image vs extra_body.image
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, '..', 'agnes.config.json'), 'utf8'))
const BASE = 'https://apihub.agnes-ai.com/v1'

async function call(label, body) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${BASE}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    })
    const text = await res.text()
    const short = text.replace(/\s+/g, ' ').slice(0, 260)
    console.log(`[${label}] HTTP ${res.status} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${short}`)
    if (res.ok) {
      try {
        const url = JSON.parse(text)?.data?.[0]?.url
        if (url) console.log(`[${label}] url = ${url}`)
      } catch {}
    }
    return res.ok ? JSON.parse(text) : null
  } catch (err) {
    console.log(`[${label}] FAILED ${err?.name}: ${err?.message}`)
    return null
  }
}

// 1) 先生成一张底图
const seed = await call('t2i', {
  model: 'agnes-image-2.5-flash',
  prompt: '一只戴草帽的蓝发鲸鱼女仆坐在木箱上，动漫插画，纯白背景',
  size: '1024x1024',
  extra_body: { response_format: 'url' },
})
const refUrl = seed?.data?.[0]?.url
console.log('refUrl =', refUrl)
if (!refUrl) process.exit(1)

const prompt = '把这张图改成夜晚的星空背景，人物保持不变'

// 2) 只有顶层 image
await call('img2img/top-level', {
  model: 'agnes-image-2.5-flash',
  prompt,
  size: '1024x1024',
  image: [refUrl],
  extra_body: { response_format: 'url' },
})

// 3) 只有 extra_body.image
await call('img2img/extra_body', {
  model: 'agnes-image-2.5-flash',
  prompt,
  size: '1024x1024',
  extra_body: { response_format: 'url', image: [refUrl] },
})
