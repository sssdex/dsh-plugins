/**
 * 字体候选对比页生成器。
 *
 * 目的：对白要「换字体、换颜色，但字号不变」。字体挑错一次就白改一轮，
 * 所以这里把候选一次性摆出来，让主人用眼睛选。
 *
 * 约束（来自本机实测的已安装字体，见 README 或运行 --list）：
 *   Windows 上没有 Songti SC / Noto Serif CJK SC，写了也是白写，会回退成系统宋体。
 *   本机确实有：思源宋体 CN Medium、思源黑体 CN Regular、楷体、华文楷体、
 *   方正悠宋 简 508R、汉仪书宋一简、汉仪长仿宋体、微软雅黑 等。
 *
 * 用法：node scripts/font-lab.mjs
 *   → font-lab.html，然后 chrome --headless --screenshot 看起来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 所有候选共用同一字号 —— 主人明确要求「大小不变」。 */
const SIZE = 15;
const LINE = 1.95;

/** 一段有旁白、有对白、有动作的正文，用来对比观感。 */
const SAMPLE = [
  { kind: 'narration', text: '晨光从露台的玻璃门斜切进来，在地毯上划出一道浅金色的边。' },
  { kind: 'speech', text: '爸爸，早……啊❤' },
  { kind: 'narration', text: '她把铲子放下，转过身来，' },
  { kind: 'action', text: '两只手在围裙上蹭了两下' },
  { kind: 'narration', text: '。' },
  { kind: 'speech', text: '清韵做了早饭。那个……蛋有点焦，对不起。' },
];

/**
 * 候选清单。
 * font 用本机确实装了的名字；color 是对白字色（旁白保持主题色不动）。
 */
const CANDIDATES = [
  {
    id: 'kai-amber',
    name: '楷体 · 暖琥珀',
    font: '楷体, KaiTi, STKaiti, serif',
    color: '#e0b878',
    note: '楷体偏手写，像小说里引出来的话。暖色不刺眼。',
  },
  {
    id: 'kai-blue',
    name: '楷体 · 雾蓝',
    font: '楷体, KaiTi, STKaiti, serif',
    color: '#8fb8dd',
    note: '同字体，冷一点，夜里看着安静。',
  },
  {
    id: 'yuansong-cream',
    name: '方正悠宋 · 米白',
    font: '"方正悠宋 简 508R", "方正悠宋", 宋体, serif',
    color: '#e8dcc0',
    note: '悠宋是现代化过的宋体，字面干净，不像老宋体那么硬。',
  },
  {
    id: 'siyuan-serif-amber',
    name: '思源宋体 · 暖琥珀',
    font: '"思源宋体 CN Medium", "思源宋体 CN", "Source Han Serif CN", 宋体, serif',
    color: '#ddb279',
    note: '思源宋体字重均匀，小字号不糊，最稳的衬线选择。',
  },
  {
    id: 'huawen-kai-rose',
    name: '华文楷体 · 藕荷',
    font: '"华文楷体", STKaiti, 楷体, serif',
    color: '#d8a0b4',
    note: '华文楷体比系统楷体略饱满，藕荷色偏柔。',
  },
  {
    id: 'shusong-jade',
    name: '汉仪书宋 · 淡青灰',
    font: '"汉仪书宋一简", "思源宋体 CN Medium", 宋体, serif',
    color: '#a9c6c4',
    note: '书宋偏瘦长，淡青灰很克制（不是之前那种扎眼的绿）。',
  },
  {
    id: 'siyuanhei-lavender',
    name: '思源黑体 · 淡紫',
    font: '"思源黑体 CN Regular", "思源黑体 CN", "Source Han Sans CN", sans-serif',
    color: '#b8a8d8',
    note: '唯一一个无衬线候选：对白和旁白骨架相同、只换颜色，最不抢戏。',
  },
  {
    id: 'changfangsong-warm',
    name: '汉仪长仿宋 · 暖褐',
    font: '"汉仪长仿宋体", 仿宋, FangSong, serif',
    color: '#d4b896',
    note: '长仿宋挺拔，有书卷气，暖褐色接近纸色。',
  },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderLine(seg, font, color) {
  if (seg.kind === 'speech') {
    return `<span style="font-family:${font};color:${color};font-size:${SIZE}px;
      background:rgba(255,255,255,0.045);border-left:2px solid rgba(255,255,255,0.22);
      border-radius:2px 5px 5px 2px;padding:0 7px 0 8px;">${esc(seg.text)}</span>`;
  }
  if (seg.kind === 'action') {
    return `<span style="font-style:italic;font-size:14px;color:#aeb8c6;">${esc(seg.text)}</span>`;
  }
  return `<span>${esc(seg.text)}</span>`;
}

function card(c) {
  const body = SAMPLE.map((s) => renderLine(s, c.font, c.color)).join('');
  return `
  <section class="card">
    <header>
      <span class="tag">${esc(c.id)}</span>
      <strong>${esc(c.name)}</strong>
      <code>${esc(c.font)}</code>
    </header>
    <div class="stage" style="font-size:${SIZE}px;line-height:${LINE};">${body}</div>
    <p class="note">${esc(c.note)}</p>
  </section>`;
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>对白字体候选</title>
<style>
html,body{margin:0;padding:0;background:#12171d;color:#d8dee9;
  font-family:-apple-system,"Segoe UI","微软雅黑","Microsoft YaHei",sans-serif;}
body{padding:28px 32px 40px;}
h1{font-size:18px;margin:0 0 6px;font-weight:600;}
.lead{font-size:12.5px;color:#8b95a5;margin:0 0 22px;line-height:1.7;}
.lead b{color:#e0b878;font-weight:600;}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;}
.card{border:1px solid rgba(255,255,255,0.10);border-radius:12px;
  background:rgba(255,255,255,0.025);padding:14px 16px 12px;}
.card header{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;
  padding-bottom:9px;margin-bottom:11px;border-bottom:1px solid rgba(255,255,255,0.08);}
.tag{font:600 10px ui-monospace,Consolas,monospace;color:#7fb2e8;
  border:1px solid rgba(127,178,232,0.35);border-radius:5px;padding:1px 5px;}
.card strong{font-size:13px;color:#e6ebf2;font-weight:600;}
.card code{font:11px ui-monospace,Consolas,monospace;color:#7a8493;margin-left:auto;}
.stage{white-space:pre-wrap;overflow-wrap:anywhere;color:#d8dee9;
  padding:2px 0 4px;letter-spacing:0.012em;}
.note{margin:10px 0 0;font-size:11.5px;color:#7a8493;line-height:1.65;}
</style></head><body>
<h1>对白字体候选 · 字号统一 ${SIZE}px</h1>
<p class="lead">
  全部候选<b>字号完全相同</b>（${SIZE}px / 行高 ${LINE}），只有字体族和对白字色不同；旁白一律用宿主正文字体、主题色。<br>
  字体名都是本机<b>确实装了的</b>——之前用的 Songti SC / Noto Serif CJK SC 在 Windows 上不存在，所以回退成了难看的系统宋体。
</p>
<div class="grid">
${CANDIDATES.map(card).join('\n')}
</div>
</body></html>`;

const out = path.join(ROOT, 'font-lab.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已写出 ${out}（${CANDIDATES.length} 个候选，字号统一 ${SIZE}px）`);
console.log('截图：');
console.log(`  chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1500,1500 \\`);
console.log(`    --screenshot="${path.join(ROOT, 'font-lab.png')}" "file:///${out.replace(/\\/g, '/')}"`);
