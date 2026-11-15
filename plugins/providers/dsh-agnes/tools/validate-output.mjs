// 用宿主真身的 lossless-JSON 校验器验证工具返回值
import { apply } from '../index.js'
import { snapshotJsonValue, isJsonValue } from './_values.js'

const registered = []
const ctx = {
  tools: { register: (t) => registered.push(t) },
  get: () => ({ saveImage: async ({ data, mediaType, name }) => ({ attachmentId: 'x1', mediaType, bytes: data.byteLength, width: 8, height: 8, ...(name ? { name } : {}) }) }),
}
apply(ctx, {})
console.log('isJsonValue 可用：', typeof isJsonValue)

const cases = {
  '旧写法（含 undefined 键）': {
    ok: true,
    file: 'a.png',
    url: 'https://x/y.png',
    revised_prompt: undefined,
    task_id: 't1',
    message: 'hi',
  },
  '旧写法带 image': {
    ok: true,
    file: 'a.png',
    url: 'https://x/y.png',
    revised_prompt: undefined,
    image: { attachmentId: 'x1', mediaType: 'image/png', bytes: 10, width: 8, height: 8 },
    message: 'hi',
  },
  'compact 后（新写法）': {
    ok: true,
    file: 'a.png',
    url: 'https://x/y.png',
    task_id: 't1',
    image: { attachmentId: 'x1', mediaType: 'image/png', bytes: 10, width: 8, height: 8, name: 'a.png' },
    message: 'hi',
  },
  'Buffer 字段（错误示范）': { ok: true, data: Buffer.from('abc') },
  'NaN/Infinity': { ok: true, n: Number.NaN },
  'null 字段': { ok: true, progress: null },
}
for (const [name, value] of Object.entries(cases)) {
  const ok = isJsonValue(value)
  let snap
  try {
    snap = snapshotJsonValue(value)
  } catch (error) {
    snap = `throw: ${error.message}`
  }
  console.log(`${ok ? '✅' : '❌'} ${name} -> isJsonValue=${ok} snapshot=${snap === undefined ? 'undefined' : 'ok'}`)
}

// 真调一次，验证工具真实返回值能过校验
const tool = registered.find((t) => t.name === 'agnes_image')
const exec = { agent: { session: { header: { cwd: 'D:/DeepSeek-Workspace' } } } }
const value = await tool.execute({ prompt: '一只卡通小鲸鱼图标，白色背景', size: '1024x1024', file_name: 'validate-check' }, exec)
const pass = isJsonValue(value)
const snap = snapshotJsonValue(value)
console.log(`\n真实返回值 isJsonValue=${pass}，snapshot ${snap === undefined ? '為 undefined（会被宿主拒收）' : '通过'}`)
console.log('keys =', Object.keys(value).join(','), '| image?', value.image ? 'yes' : 'no')
if (snap !== undefined) console.log('detached keys =', Object.keys(snap).join(','))
