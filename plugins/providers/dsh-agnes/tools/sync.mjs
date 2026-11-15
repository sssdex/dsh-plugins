// 把工作区源码同步进 profile 的 node_modules/dsh-agnes（pnpm 用 file: 复制而非软链）
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = process.env.AGNES_DEST ?? 'D:/DeepSeek-DSH/profiles/desktop/node_modules/dsh-agnes'
if (!existsSync(dest)) {
  console.error(`目标不存在：${dest}（先在 profile 里 pnpm install）`)
  process.exit(1)
}
const files = ['index.js', 'lib/agnes.mjs', 'package.json', 'cordis.patch.yml', 'README.md']
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)
for (const rel of files) {
  const from = join(src, rel)
  const to = join(dest, rel)
  if (!existsSync(from)) continue
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  console.log(`${rel.padEnd(20)} ${hash(from)} -> ${hash(to)} ${hash(from) === hash(to) ? 'OK' : 'MISMATCH'}`)
}
