/**
 * 第二版对比：按验算结果定档。
 *
 * 关键结论（见 test/contrast.mjs）：
 *   · 0.68（专家推荐）在最亮壁纸上对白 4.20、神态 3.75，不达标
 *   · 0.75 才能让对白 5.31、神态(提亮)4.74 全部过线
 *   · 壁纸只剩 25% 可见 → 要靠边缘处理与留白找回氛围，不能只靠透明度
 *
 * 所以本版对比的是**同样 0.75 上下的三档**，看哪种"找回氛围"的手法最好：
 *   F1  纯色 + 内高光（专家基线）
 *   F2  纯色 + 内高光 + 极轻噪点纹理
 *   F3  双色渐变（左上偏暖、右下偏冷）+ 噪点  ← 呼应暖色吊灯与冷色窗光
 */
import fs from 'node:fs';
import { parseMessage } from '../lib/parse.js';
import { renderMessage } from '../lib/render.js';
import { buildCSS } from '../lib/styles.js';

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

const html = renderMessage(parseMessage(SAMPLE));
const baseCss = buildCSS();

/* 噪点纹理：3% 透明度，破坏纯数字化的平 */
const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E")`;

const WALLPAPER = `
background-color: #0a1020;
background-image:
  radial-gradient(ellipse 46% 30% at 78% 8%, rgba(255, 214, 150, 0.55), transparent 70%),
  radial-gradient(ellipse 30% 22% at 12% 26%, rgba(120, 170, 240, 0.16), transparent 72%),
  radial-gradient(ellipse 60% 34% at 50% 96%, rgba(90, 130, 200, 0.14), transparent 74%),
  repeating-linear-gradient(96deg, rgba(255,255,255,0.028) 0 2px, transparent 2px 9px),
  linear-gradient(168deg, #16233d 0%, #0d1730 46%, #070d1c 100%);
`;

const VARIANTS = {
  F1: {
    label: '纯色 + 内高光',
    note: '专家基线：0.75 纯色，顶边 1px 高光',
    css: `
      background: rgba(12, 16, 28, 0.75);
      box-shadow: 0 1px 3px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.05);
    `,
  },
  F2: {
    label: '纯色 + 噪点',
    note: '在 F1 上叠 4.5% 噪点纹理，去数字化',
    css: `
      background-image: ${NOISE}, linear-gradient(rgba(12,16,28,0.75), rgba(12,16,28,0.75));
      box-shadow: 0 1px 3px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.055);
    `,
  },
  F3: {
    label: '双色渐变 + 噪点',
    note: '左上偏暖呼应吊灯、右下偏冷呼应窗光，共 0.75 平均',
    css: `
      background-image:
        ${NOISE},
        linear-gradient(145deg,
          rgba(30, 24, 20, 0.74) 0%,
          rgba(14, 17, 28, 0.76) 42%,
          rgba(10, 13, 23, 0.78) 100%);
      box-shadow: 0 1px 3px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.055);
    `,
  },
};

function panel(key) {
  const v = VARIANTS[key];
  return `
  <section class="col">
    <header class="colhead">
      <span class="badge">${key}</span>
      <strong>${v.label}</strong>
      <span class="note">${v.note}</span>
    </header>
    <div class="stage">
      <div class="wall">
        <div class="msg ${key}">${html}</div>
      </div>
    </div>
  </section>`;
}

const variantCss = Object.entries(VARIANTS).map(([k, v]) => `
.msg.${k} .tt-root {
  border-radius: 11px;
  padding: 15px 19px;
  ${v.css}
}
.msg.${k} .tt-root::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 12px;
  padding: 1px;
  background: linear-gradient(135deg, rgba(255,255,255,0.075) 0%, transparent 62%);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
.msg.${k} .tt-root { position: relative; }
`).join('\n');

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>垫底方案 v2</title>
<style>
html, body { margin: 0; background: #06090f; }
body {
  padding: 22px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #cfd8e6;
}
.col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.colhead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 0 2px; }
.badge {
  display: inline-grid; place-items: center;
  width: 22px; height: 20px; border-radius: 5px;
  background: #1b2537; border: 1px solid #2e3d55;
  font: 700 10px/1 ui-monospace, monospace; color: #8fb4e8;
}
.colhead strong { font-size: 13px; color: #e6edf7; font-weight: 600; }
.note { font-size: 11px; color: #6b7a90; line-height: 1.4; }
.stage { border-radius: 12px; overflow: hidden; border: 1px solid #1b2537; }
.wall {
  ${WALLPAPER}
  padding: 24px 18px 30px;
  min-height: 560px;
  display: flex; align-items: flex-start; justify-content: center;
  --dsw-alias-label-primary: #eef2f8;
  --dsw-alias-label-secondary: #b9c4d4;
  --dsw-alias-label-tertiary: #97a4b6;
}
.msg { width: 100%; max-width: 470px; }
${baseCss}
${variantCss}
</style>
</head>
<body data-ds-dark-theme data-dsh-tavern-render>
${Object.keys(VARIANTS).map(panel).join('\n')}
</body></html>`;

fs.writeFileSync('D:/DeepSeek-Workspace/dsh-tavern-render/preview-scrim2.html', page, 'utf8');
console.log('wrote preview-scrim2.html');
