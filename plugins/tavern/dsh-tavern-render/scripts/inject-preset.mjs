/**
 * 把 TRS 约束段插入「酒馆·扮演」预设的 persona.prefix 末尾。
 * 用 Node 做文本操作，避免 PowerShell 把中文当变量名插值。
 */
import fs from 'node:fs';
import path from 'node:path';

const PATCH = 'D:/DeepSeek-Workspace/dsh-tavern-preset/cordis.patch.yml';
const BODY = 'D:/DeepSeek-Workspace/dsh-tavern-render/docs/_constraint-body.txt';
const INDENT = ' '.repeat(16);
const MARKER = '## 输出格式：铁律（TRS v1）';

const raw = fs.readFileSync(BODY, 'utf8').replace(/\r\n/g, '\n').trim();
const lines = raw.split('\n');

const section = [
  '',
  `${INDENT}${MARKER}`,
  INDENT,
  `${INDENT}下面这一节优先于你所有的写作习惯。不遵守 = 这条回复无效。`,
  INDENT,
  ...lines.map((l) => (l.trim() === '' ? INDENT : INDENT + l)),
  INDENT,
];

let text = fs.readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');

if (text.includes(MARKER)) {
  console.log('已存在约束段，先移除旧的再插入');
  // 简单起见：从 MARKER 那行删到「# ── 工具收窄」
  const start = text.indexOf(`${INDENT}${MARKER}`);
  const end = text.indexOf('          # ── 工具收窄');
  if (start >= 0 && end > start) text = text.slice(0, start) + text.slice(end);
}

// 插在 prefix 块结束之后：找「- 遇到文件读不到」那一行，插到它后面
const anchor = `${INDENT}- 遇到文件读不到、卡解析坏了`;
const idx = text.indexOf(anchor);
if (idx < 0) {
  console.error('找不到插入锚点');
  process.exit(1);
}
const lineEnd = text.indexOf('\n', idx);
const insertAt = lineEnd + 1;

const before = text.slice(0, insertAt);
const after = text.slice(insertAt);
text = before + section.join('\n') + '\n' + after;

fs.writeFileSync(PATCH, text, 'utf8');
console.log('已插入，新增行数:', section.length);
