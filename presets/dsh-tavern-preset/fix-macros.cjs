/**
 * 一次性修补：把已解析卡片里的 {{user}} / {{char}} 宏就地换成实际称呼。
 *
 * 背景：parse-card.cjs 现在生成时就替换，但之前解析出来的 card.md 还留着占位符。
 * 模型读得到，只是每句都要自己换算，偶尔漏掉会念出 "{{user}}" 这种字面量。
 *
 * 用法：node fix-macros.cjs <cards 目录>
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2]
if (!root) {
  console.log('用法: node fix-macros.cjs <cards 目录>')
  process.exit(1)
}

let touched = 0
let replaced = 0
for (const name of fs.readdirSync(root)) {
  const dir = path.join(root, name)
  if (!fs.statSync(dir).isDirectory()) continue
  const cardFile = path.join(dir, 'card.md')
  if (!fs.existsSync(cardFile)) continue

  // 角色名优先取 meta.json，取不到就从目录名前缀猜
  let charName = name.replace(/-[0-9a-f]{6}$/, '')
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    if (meta.name) charName = meta.name
  } catch {
    // meta.json 缺失或坏了，用目录名兜底
  }

  const before = fs.readFileSync(cardFile, 'utf8')
  const count = (before.match(/\{\{(user|char)\}\}/gi) || []).length
  if (count === 0) continue

  const after = before
    .replace(/\{\{user\}\}/gi, '你')
    .replace(/\{\{char\}\}/gi, charName)

  fs.writeFileSync(cardFile, after, 'utf8')
  touched += 1
  replaced += count
  console.log(`  ${name}: 替换 ${count} 处（角色名 ${charName}）`)
}

console.log(`完成：${touched} 张卡，共替换 ${replaced} 处占位符`)
