/**
 * 往「酒馆·扮演」预设的 persona.prefix 里注入「不许思考 / 不许自检」约束。
 *
 * 为什么用脚本：prefix 是 YAML 块标量，块内每行必须与父级严格对齐（16 空格），
 * 手敲少一个空格就是 bad indentation，整个 profile 起不来。
 *
 * 用法：
 *   node scripts/inject-nothink.mjs            演练，只报告不写盘
 *   node scripts/inject-nothink.mjs --write    真的写盘（自己先备份）
 */

import fs from 'node:fs';

const PRESET = 'D:/DeepSeek-Workspace/dsh-tavern-preset/cordis.patch.yml';
const WRITE = process.argv.includes('--write');

const INDENT = ' '.repeat(16);
const MARKER = '不许思考，先回答';
/** 插在这一行之前（play 预设里「怎么开场」那节的开头） */
const ANCHOR = `${INDENT}## 怎么开场`;

const BLOCK = `## 不许思考，先回答

这是本场对话里**优先级最高**的一条，压过下面所有关于「怎么写」的要求。

- **不推理、不自检、不权衡。** 不判断「这样说对不对」、不判断「符不符合设定」、不判断「会不会和上文冲突」。想到什么写什么，写完立刻发。
- **写之前不检查，写之后不复核。** 没有「我应该先确认一下」这一步，也没有「刚那句是不是不太对」这一步。
- **一致性靠记性，不靠回查。** 上文发生过的事你直接记得，凭记忆接着说。不要为了核对去读文件、翻会话、对比前文。
- **不列提纲、不打草稿、不写「让我想想」。** 第一个字符就是正文的第一个字符。
- **允许说错话。** 角色记错名字、说漏嘴、情绪过头，都是戏的一部分，比慢半拍的完美回答好一百倍。
- **不加收尾。** 写完就结束。不加总结段、不加自我点评、不加「如果你希望……」这类补丁句。

唯一的例外：用户点名了卡名但目录里找不到那张卡 —— 这时才允许停下来问一句。其余任何情况一律先回话。

`;

/* ── 定位 play 预设的 prefix 块 ── */
function findPrefixBlock(lines) {
  const playStart = lines.findIndex((l) => l.includes('id: preset-tavern-play'));
  if (playStart < 0) throw new Error('找不到 preset-tavern-play');
  let stop = lines.length;
  for (let i = playStart + 1; i < lines.length; i += 1) {
    if (/^    - id: /.test(lines[i])) { stop = i; break; }
  }
  let prefixLine = -1;
  for (let i = playStart; i < stop; i += 1) {
    if (/^\s*prefix: \|/.test(lines[i])) { prefixLine = i; break; }
  }
  if (prefixLine < 0) throw new Error('play 预设里找不到 prefix: |');
  const baseIndent = lines[prefixLine].search(/\S/);
  let end = prefixLine + 1;
  for (let i = prefixLine + 1; i < stop; i += 1) {
    if (lines[i].trim() === '') continue;
    if (lines[i].search(/\S/) <= baseIndent) break;
    end = i + 1;
  }
  while (end > prefixLine + 1 && lines[end - 1].trim() === '') end -= 1;
  return { prefixLine, end };
}

const norm = (s) => s.replace(/\r\n/g, '\n');
const lines = norm(fs.readFileSync(PRESET, 'utf8')).split('\n');
const loc = findPrefixBlock(lines);

console.log(`prefix 块：第 ${loc.prefixLine + 1} 行起，内容到第 ${loc.end} 行（${loc.end - loc.prefixLine - 1} 行）`);

if (BLOCK.includes('{{')) throw new Error('约束文本含双花括号，会炸 prompt 模板引擎');

const work = [...lines];
const exists = work.slice(loc.prefixLine, loc.end).some((l) => l.includes(MARKER));

if (exists) {
  console.log('… 约束已存在，不重复注入');
} else {
  const at = work.findIndex((l, i) => i > loc.prefixLine && i < loc.end && l === ANCHOR);
  if (at < 0) throw new Error(`找不到锚点行「${ANCHOR.trim()}」，中止`);
  const inject = BLOCK.replace(/\s+$/, '').split('\n').map((l) => (l.trim() === '' ? '' : INDENT + l));
  work.splice(at, 0, ...inject, '');
  console.log(`✓ 在第 ${at + 1} 行前插入 ${inject.length + 1} 行`);
}

const out = work.join('\n');

/* ── 校验 ── */
let yamlOk = false;
let prefix = '';
try {
  const { createRequire } = await import('node:module');
  const require = createRequire('D:/DeepSeek-DSH/profiles/desktop/package.json');
  const yaml = require('js-yaml');
  const JsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({ __js: data }),
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([JsType]);
  const parsed = yaml.load(out, { schema });
  const play = parsed.flatMap((e) => e.insert ?? []).find((e) => e.id === 'preset-tavern-play');
  if (!play) throw new Error('解析后找不到 preset-tavern-play');
  prefix = play.config.plugins.find((p) => p.id === 'persona').config.prefix;
  yamlOk = true;
} catch (err) {
  console.log(`\n⚠ YAML 校验失败：${String(err.message).split('\n')[0]}`);
}

const has = (s) => (yamlOk ? prefix.includes(s) : out.includes(s));
const checks = [
  ['YAML 可解析', yamlOk],
  ['含「不许思考」节', has(MARKER)],
  ['含「写之后不复核」', has('写之后不复核')],
  ['仍含「怎么开场」节', has('## 怎么开场')],
  ['仍含 <scene> 骨架', has('<scene>')],
  ['仍含退出条件', has('不是你的工作日志')],
  ['无双花括号', !has('{{')],
];
console.log('\n=== 校验 ===');
let allOk = true;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) allOk = false;
}
if (yamlOk) console.log(`\nprefix 长度：${prefix.length} 字符`);

if (!allOk) {
  console.log('\n✗ 校验未通过，不写盘');
  process.exit(1);
}

if (WRITE) {
  fs.writeFileSync(PRESET, out, 'utf8');
  console.log(`\n✓ 已写入 ${PRESET}（${lines.length} → ${work.length} 行）`);
} else {
  console.log(`\n演练模式，未写盘。行数将变为：${lines.length} → ${work.length}`);
}
