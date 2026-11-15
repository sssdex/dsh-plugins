// 脱离 DSH 宿主的冒烟测试：apply() -> 注册的工具 -> 真调 Agnes API
// 用法： node --import ./tools/_register-stub.mjs tools/smoke.mjs [image|video|all]
import { apply } from '../index.js'
import { createHash } from 'node:crypto'

const registered = []
const stored = []
const attachments = {
  imageLimits: { maxImagesPerMessage: 8, maxMessageImageBytes: 32 * 1024 * 1024, maxImageBytes: 12 * 1024 * 1024, mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] },
  async saveImage({ data, mediaType, name }) {
    const ref = {
      attachmentId: `stub-${stored.length + 1}`,
      mediaType,
      bytes: data.byteLength,
      width: 1024,
      height: 1024,
      ...(name === undefined ? {} : { name }),
    }
    stored.push({ data, ref })
    return ref
  },
}

const ctx = {
  tools: { register: (tool) => registered.push(tool) },
  get: (name) => (name === 'attachments' ? attachments : undefined),
}

apply(ctx, {})
console.log('已注册工具：', registered.map((t) => t.name).join(', '))
for (const tool of registered) {
  const params = tool.parameters ?? {}
  const missingDesc = Object.entries(params).filter(([, v]) => !v || typeof v.description !== 'string').map(([k]) => k)
  console.log(`  ${tool.name}: ${Object.keys(params).length} 个参数${missingDesc.length ? `（缺 description: ${missingDesc.join(',')}）` : ''}，timeoutMs=${tool.timeoutMs}`)
}

const exec = { agent: { session: { header: { cwd: 'D:/DeepSeek-Workspace' } } }, signal: undefined }
const which = process.argv[2] ?? 'image'
const prompt = process.argv[3] ?? '一只蓝发鲸鱼女仆抱着小鱼干，Q 版贴纸风格，纯白背景'

if (which === 'image' || which === 'all') {
  const tool = registered.find((t) => t.name === 'agnes_image')
  const t0 = Date.now()
  const value = await tool.execute({ prompt, size: '1024x1024', file_name: 'smoke-image' }, exec)
  console.log(`[agnes_image] ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify({ ...value, image: value.image ? { ...value.image, attachmentId: 'stub' } : undefined }, null, 2))
  const blocks = tool.output.render({}, value)
  console.log('  render 块：', blocks.map((b) => b.type).join(' + '), '| image sha16 =', value.image ? createHash('sha256').update(stored.at(-1).data).digest('hex').slice(0, 16) : 'n/a')
}

if (which === 'video' || which === 'all') {
  const tool = registered.find((t) => t.name === 'agnes_video')
  const t0 = Date.now()
  const value = await tool.execute({ prompt, mode: 'text', seconds: '4', size: '720P', model: 'agnes-video-2.5-flash', max_wait_seconds: 900 }, exec)
  console.log(`[agnes_video] ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(value, null, 2))
}
