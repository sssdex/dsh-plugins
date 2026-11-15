/**
 * 把条件式 TRS 约束注入「酒馆·扮演」预设的 persona.prefix 末尾。
 *
 * 为什么用脚本而不是手改：prefix 是 YAML 块标量，块内每行必须与父级严格对齐
 * （16 空格）。手动补进去的行少一个空格就是 bad indentation，整个 profile 起不来。
 * 脚本负责对齐 + 写完立刻校验。
 *
 * 用法：
 *   node scripts/inject-trconstr.mjs            演练，只报告不写盘
 *   node scripts/inject-trconstr.mjs --write    真的写盘（先自己备份）
 */

import fs from 'node:fs';

const PRESET = 'D:/DeepSeek-Workspace/dsh-tavern-preset/cordis.patch.yml';
const DOC = 'D:/DeepSeek-Workspace/dsh-tavern-render/docs/PRESET-CONSTRAINT.md';
const WRITE = process.argv.includes('--write');

const INDENT = ' '.repeat(16);
const MARKER = '我是在「演」，还是在「干活」';

/* ── 1. 取约束文本 ── */
function constraintBlock() {
  const raw = fs.readFileSync(DOC, 'utf8');
  const m = /```text\r?\n([\s\S]*?)```/.exec(raw);
  if (!m) throw new Error('PRESET-CONSTRAINT.md 里找不到 ```text 代码块');
  const body = m[1].replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (body.includes('{{')) throw new Error('约束文本含双花括号，会炸 prompt 模板引擎');
  return body;
}

/* ── 2. 定位 play 预设的 prefix 块 ── */
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
const block = constraintBlock();
const loc = findPrefixBlock(lines);

console.log(`prefix 块：第 ${loc.prefixLine + 1} 行起，内容到第 ${loc.end} 行（${loc.end - loc.prefixLine - 1} 行）`);
console.log(`约束文本：${block.split('\n').length} 行`);

/* ── 3. 先修掉与 <scene> 直接冲突的旧句 ── */
const OLD = `${INDENT}- 不用 markdown 标题、列表、粗体排版剧情正文。正文就是正文，分行就好。`;
const OLD2 = `${INDENT}  （卡面自带的状态栏/面板块是例外，那是卡的格式，照它输出。）`;
const NEW = `${INDENT}- 不用 markdown 标题、列表、粗体去排版剧情正文。层级交给下面的 <scene> 格式。`;

const work = [...lines];
const at = work.findIndex((l, i) => i > loc.prefixLine && i < loc.end && l === OLD);
if (at >= 0 && work[at + 1] === OLD2) {
  work.splice(at, 1, NEW);
  console.log(`✓ 改掉冲突句（第 ${at + 1} 行）：删「正文就是正文，分行就好」→ 指向 <scene>`);
} else {
  console.log('… 冲突句未找到（或已改过）');
}

/* ── 4. 追加约束到块尾（幂等） ── */
const loc2 = findPrefixBlock(work);
const exists = work.slice(loc2.prefixLine, loc2.end).some((l) => l.includes(MARKER));
if (exists) {
  console.log('… 约束已存在，不重复注入');
} else {
  const inject = ['', ...block.split('\n').map((l) => (l.trim() === '' ? '' : INDENT + l))];
  work.splice(loc2.end, 0, ...inject);
  console.log(`✓ 追加 ${inject.length} 行到 prefix 末尾（第 ${loc2.end + 1} 行）`);
}

const out = work.join('\n');

/* ── 5. 校验 ── */
let yamlOk = false;
let prefix = '';
try {
  const { createRequire } = await import('node:module');
  // js-yaml 在 desktop profile 的 node_modules 里（DSH 自己的依赖）
  const require = createRequire('D:/DeepSeek-DSH/profiles/desktop/package.json');
  const yaml = require('js-yaml');
  // 这个文件里有 DSH 自己的 `!!js <表达式>` 自定义 tag（见 disabled: !!js process.platform…），
  // 标准 js-yaml 不认识会直接抛 unknown tag。注册成普通字符串即可通过结构校验。
  const JsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({ __js: data }),
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([JsType]);
  const parsed = yaml.load(out, { schema });
  const play = parsed.flatMap((e) => e.insert ?? []).find((e) => e.id === 'preset-tavern-play');
  if (!play) throw new Error('解析后找不到 preset-tavern-play');
  const persona = play.config.plugins.find((p) => p.id === 'persona');
  prefix = persona.config.prefix;
  yamlOk = true;
} catch (err) {
  console.log(`\n⚠ YAML 校验跳过：${String(err.message).split('\n')[0]}`);
}

const checks = [
  ['YAML 可解析', yamlOk],
  ['含条件判断句', yamlOk ? prefix.includes(MARKER) : out.includes(MARKER)],
  ['含 <scene> 骨架', yamlOk ? prefix.includes('<scene>') : out.includes('<scene>')],
  ['含退出条件（不是工作日志）', yamlOk ? prefix.includes('不是你的工作日志') : out.includes('不是你的工作日志')],
  ['无 <scene> 与旧句冲突', yamlOk ? !prefix.includes('正文就是正文') : !out.includes('正文就是正文')],
  ['无双花括号', yamlOk ? !prefix.includes('{{') : !out.includes('{{')],
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
  console.log(`\n演练模式，未写盘。加 --write 才会写入。`);
  console.log(`行数将变为：${lines.length} → ${work.length}`);
}
