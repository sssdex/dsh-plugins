/**
 * 三个垫底方案的并排预览。
 *
 * 用一张模拟壁纸（深蓝调 + 亮吊灯 + 窗光）当背景，
 * 因为真实问题就出在「亮部」压不住文字。
 *
 * 输出 preview-scrim.html，用 Chrome 截图看效果。
 */
import fs from 'node:fs';
import { parseMessage } from '../lib/parse.js';
import { renderMessage } from '../lib/render.js';
import { buildCSS } from '../lib/styles.js';
import { SCRIM_VARIANTS, scrimVars } from '../lib/scrim.js';

const SAMPLE = `<scene>
<prose>
雨敲在老旧公寓的窗框上，屋子里只有台灯一圈黄光。补课用的练习册摊了一桌，笔帽滚到桌沿，没人去捡。
她趴在桌面上，制服的袖口卷到手肘，*校服领口的第二颗扣子早不知什么时候松了*，露出一小截被灯光染成蜜色的锁骨。
"……老师，这道题我不会。"她的手指在纸面上慢慢划过去，指尖停在空白处，然后抬眼看你，眼睫毛上还挂着一点湿气，"讲了四遍了。你是不是觉得我很笨？"
*她把椅子往后一推，坐直了，膝盖并拢，裙摆压出一道很浅的褶*。"还是说——"她声音放低，尾音拖着，"你根本不想我学会。"
</prose>
<panel>
<info time="20:47 雨夜" place="补课公寓的小客厅"/>
<status>
  <char name="她" affection=41 reason=27 mood="试探而笃定" outfit="校服，领口松散，裙下是短袜" body="身上带着雨水的凉">
    心声：他不敢看我。可他也没走。
  </char>
</status>
<choice>
  <opt>把笔捡起来，指着题目，正经讲第五遍</opt>
  <opt>把台灯转过去，让她看不清你的表情</opt>
</choice>
</panel>
</scene>`;

const parsed = parseMessage(SAMPLE);
const html = renderMessage(parsed);
const baseCss = buildCSS();

/* 模拟壁纸：深蓝调的室内 + 右上强光 + 金色装饰 */
const WALLPAPER = `
background-color: #0a1020;
background-image:
  radial-gradient(ellipse 46% 30% at 78% 8%, rgba(255, 214, 150, 0.55), transparent 70%),
  radial-gradient(ellipse 30% 22% at 12% 26%, rgba(120, 170, 240, 0.16), transparent 72%),
  radial-gradient(ellipse 60% 34% at 50% 96%, rgba(90, 130, 200, 0.14), transparent 74%),
  repeating-linear-gradient(96deg, rgba(255,255,255,0.028) 0 2px, transparent 2px 9px),
  linear-gradient(168deg, #16233d 0%, #0d1730 46%, #070d1c 100%);
`;

function panel(key) {
  const v = SCRIM_VARIANTS[key];
  return `
  <section class="col">
    <header class="colhead">
      <span class="badge">${key}</span>
      <strong>${v.label}</strong>
      <span class="note">${v.note}</span>
    </header>
    <div class="stage">
      <div class="wall ${key}">
        <div class="msg">${html}</div>
      </div>
    </div>
  </section>`;
}

const scrimCss = Object.keys(SCRIM_VARIANTS).map((k) => `
/* ── 方案 ${k} ── */
.wall.${k} {
${scrimVars(k)}
}

.wall.${k} .tt-root {
  background: var(--tt-veil);
  -webkit-backdrop-filter: blur(var(--tt-veil-blur));
  backdrop-filter: blur(var(--tt-veil-blur));
  border-radius: var(--tt-veil-radius);
  box-shadow: var(--tt-veil-rim);
  padding: var(--tt-veil-pad);
}

${k === 'D' ? `
/* 方案 D：不给卡片，只在文字上加极轻投影托底 */
.wall.D .tt-narration,
.wall.D .tt-speech,
.wall.D .tt-action {
  text-shadow: var(--tt-text-shadow);
}
` : ''}

${k === 'C' ? `
/* 方案 C：只给文字本身垫底（行内高亮） */
.wall.C .tt-narration,
.wall.C .tt-speech,
.wall.C .tt-action {
  background: var(--tt-inline-bg);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  padding: var(--tt-inline-pad);
  border-radius: var(--tt-inline-radius);
}
.wall.C .tt-action { font-style: italic; }
` : ''}
`).join('\n');

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>酒馆回话 · 垫底方案对比</title>
<style>
html, body { margin: 0; background: #06090f; }
body {
  padding: 22px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #cfd8e6;
}
.col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.colhead { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; padding: 0 2px; }
.badge {
  display: inline-grid; place-items: center;
  width: 20px; height: 20px; border-radius: 5px;
  background: #1b2537; border: 1px solid #2e3d55;
  font: 700 11px/1 ui-monospace, monospace; color: #8fb4e8;
}
.colhead strong { font-size: 13px; color: #e6edf7; font-weight: 600; }
.note { font-size: 11px; color: #6b7a90; }
.stage { flex: 1; border-radius: 12px; overflow: hidden; border: 1px solid #1b2537; }
.wall {
  ${WALLPAPER}
  padding: 26px 22px 34px;
  min-height: 620px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}
.msg { width: 100%; max-width: 460px; }
/* 让渲染块在壁纸上呈现，颜色走主题变量（暗色） */
.wall { --dsw-alias-label-primary: #eef2f8; --dsw-alias-label-secondary: #b9c4d4; --dsw-alias-label-tertiary: #8a97a9; }
${baseCss}
${scrimCss}
</style>
</head>
<body data-ds-dark-theme data-dsh-tavern-render>
${Object.keys(SCRIM_VARIANTS).map(panel).join('\n')}
</body></html>`;

fs.writeFileSync('D:/DeepSeek-Workspace/dsh-tavern-render/preview-scrim.html', page, 'utf8');
console.log('wrote preview-scrim.html');

