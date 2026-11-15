/**
 * 端到端实测：真的往主人的 QQ 发消息（文字/表情包/语音/截图/文件）。
 *
 * 用法：
 *   node e2e.mjs                 # 全部 5 项
 *   node e2e.mjs --only text,voice
 *   node e2e.mjs --to group:XXXX # 发到群
 *
 * 它和插件走同一套 lib（配置解析、状态账本、QQ 客户端、媒体管线），
 * 所以这里通过 == 宿主里注册的工具能通过（只差工具外壳）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { resolveQqAccount } from './lib/config.js'
import { createState } from './lib/state.js'
import { createQqClient } from './lib/qq.js'
import { searchMemes } from './lib/memes.js'

const args = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const ALL = ['text', 'meme', 'voice', 'screenshot', 'file']
const only = argOf('only') ? argOf('only').split(',').map((item) => item.trim()).filter(Boolean) : ALL
const chat = argOf('to', 'dm')

const results = []
async function step(name, run) {
  const startedAt = Date.now()
  try {
    const detail = await run()
    results.push({ step: name, ok: true, ms: Date.now() - startedAt, detail })
    console.log(`✔ ${name} (${Date.now() - startedAt}ms) ${JSON.stringify(detail)}`)
  } catch (error) {
    const info = {
      message: error?.message ?? String(error),
      status: error?.status,
      errCode: error?.errCode,
    }
    results.push({ step: name, ok: false, ms: Date.now() - startedAt, error: info })
    console.error(`✖ ${name} (${Date.now() - startedAt}ms) ${info.message}`)
  }
}

const account = await resolveQqAccount({})
console.log(`账号 ${account.accountId} / appId ${account.appId} / openid ${account.openid}`)
const state = createState(path.join(process.env.TEMP || '.', `dsh-qq-hands-e2e-${process.pid}.json`))
const api = createQqClient({ appId: account.appId, appSecret: account.appSecret, fetchImpl: globalThis.fetch, state })
const target = api.target(chat, account.openid)
console.log(`目标 ${target.kind}:${target.openid}`)

await step('auth', async () => {
  const token = await api.accessToken()
  return { tokenLength: String(token).length }
})

if (only.includes('text')) {
  await step('text', async () => {
    const result = await api.sendText(
      target,
      '主人，这是鲸鱼娘新装的 QQ 之手在说话。第一句先打个招呼。第二句说正事：以后我可以主动找你了。第三句收个尾，别再熬夜啦。',
      { maxBubbles: 3, minGapMs: 500, maxGapMs: 900 },
    )
    return result
  })
}

if (only.includes('meme')) {
  await step('meme', async () => {
    const hits = await searchMemes('得意', { limit: 3 })
    if (!hits.length) throw new Error('表情库里没搜到「得意」')
    const picked = hits[0]
    const data = fs.readFileSync(picked.file)
    const result = await api.sendMedia(target, {
      fileType: 1,
      name: path.basename(picked.file),
      data,
    })
    return { file: path.basename(picked.file), caption: picked.caption, bytes: data.length, ...result }
  })
}

if (only.includes('voice')) {
  await step('voice', async () => {
    const media = await import('./lib/media.js')
    const synth = await media.synthesizeSilk({ text: '主人，鲸鱼娘现在会在 QQ 里跟你说话啦。' })
    const result = await api.sendMedia(target, { fileType: 3, name: 'voice.silk', data: synth.silk })
    return { voice: synth.voice, bytes: synth.silk.length, durationMs: synth.durationMs, ...result }
  })
}

if (only.includes('screenshot')) {
  await step('screenshot', async () => {
    const media = await import('./lib/media.js')
    const shot = await media.captureScreen({ format: 'jpg', maxWidth: 1600 })
    const result = await api.sendMedia(target, { fileType: 1, name: `screenshot.${shot.format}`, data: shot.data })
    return { width: shot.width, height: shot.height, bytes: shot.data.length, ...result }
  })
}

if (only.includes('file')) {
  await step('file', async () => {
    const file = path.join(import.meta.dirname, 'package.json')
    const data = fs.readFileSync(file)
    const result = await api.sendMedia(target, { fileType: 4, name: 'dsh-qq-hands-package.json', data })
    return { bytes: data.length, ...result }
  })
}

state.flush()
const failed = results.filter((item) => !item.ok)
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 成功 =====`)
console.log(JSON.stringify(results, null, 2))
process.exitCode = failed.length ? 1 : 0
