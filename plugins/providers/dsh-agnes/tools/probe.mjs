const key = process.env.AGNES_KEY
const r = await fetch('https://apihub.agnes-ai.com/v1/images/generations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'agnes-image-2.5-flash', prompt: '一只戴草帽的蓝发鲸鱼女仆，动漫风格，海边白天', size: '1024x1024', extra_body: { response_format: 'url' } })
})
const t = await r.text()
console.log('status', r.status)
console.log(t.slice(0, 900))
