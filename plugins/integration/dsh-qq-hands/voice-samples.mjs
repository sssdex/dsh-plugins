/**
 * 音色试听：把候选少女音各合成一条，直接发到主人 QQ。
 * 用法：node voice-samples.mjs [xiaoyi,xiaoyi_sweet,xiaoxiao]
 */
import { synthesizeSilkEdge, EDGE_VOICES } from './lib/tts-edge.js'
import { resolveQqAccount } from './lib/config.js'
import { createState } from './lib/state.js'
import { createQqClient } from './lib/qq.js'

const LINE = '主人，我是鲸鱼娘呀。这个声音你听着舒服吗？要是喜欢，以后我就用这个声音跟你说话。'

const wanted = process.argv[2]
  ? process.argv[2].split(',').map((item) => item.trim()).filter(Boolean)
  : ['xiaoyi', 'xiaoyi_sweet', 'xiaoxiao']

const account = await resolveQqAccount({})
const state = createState(`${process.env.TEMP}\\dsh-qq-hands-samples-${process.pid}.json`)
const api = createQqClient({ appId: account.appId, appSecret: account.appSecret, fetchImpl: globalThis.fetch, state })
const target = api.target('dm', account.openid)

for (const [index, id] of wanted.entries()) {
  const preset = EDGE_VOICES[id]
  if (!preset) { console.log(`跳过未知音色 ${id}`); continue }
  const started = Date.now()
  try {
    const synth = await synthesizeSilkEdge({ text: LINE, voice: id })
    await api.sendText(target, `${index + 1}️⃣ ${preset.label}`, { burst: false, minGapMs: 0, maxGapMs: 0 })
    await api.sendMedia(target, { fileType: 3, name: 'voice.silk', data: synth.silk })
    console.log(`✔ ${id} ${preset.label} ${synth.silk.length}B ${synth.durationMs}ms ${Date.now() - started}ms`)
  } catch (error) {
    console.log(`✖ ${id} ${Date.now() - started}ms ${error?.message ?? error}`)
  }
}
state.flush()
