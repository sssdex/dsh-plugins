/**
 * 真机壁纸验证：用皮肤插件真实的背景图当底，检查垫底后的可读性。
 *
 * 同时测一个最坏情况（纯白壁纸），因为用户会换壁纸。
 */
import fs from 'node:fs';
import path from 'node:path';
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

const RT = 'D:/DeepSeek-DSH/profiles/desktop/node_modules/@smalltailqwq/dsh-client-ui-skin-maid-atelier/assets/runtime';
const files = fs.readdirSync(RT).filter((f) => /\.(webp|png|jpg)$/i.test(f));
// 取体积最大的几张当「真实壁纸」样本
const byBig = files
  .map((f) => ({ f, size: fs.statSync(path.join(RT, f)).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 2);

function toUrl(f) {
  return 'file:///' + path.join(RT, f).replace(/\\/g, '/');
}

const stages = [
  { key: 'real1', label: '真实壁纸 · 最大图', bg: toUrl(byBig[0].f) },
  { key: 'real2', label: '真实壁纸 · 次大图', bg: toUrl(byBig[1].f) },
  { key: 'white', label: '最坏情况 · 纯白', bg: null, css: 'background:#f2f4f8' },
];

const stageHtml = stages.map((s) => `
  <section class="col">
    <header class="colhead"><strong>${s.label}</strong></header>
    <div class="stage" ${s.css ? `style="${s.css}"` : `style="background-image:url('${s.bg}');background-size:cover;background-position:center"`}>
      <div class="msg">${html}</div>
    </div>
  </section>`).join('\n');

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>真机壁纸验证</title>
<style>
html, body { margin: 0; background: #06090f; }
body {
  padding: 20px; display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 14px;
  font-family: system-ui, "Segoe UI", sans-serif; color: #cfd8e6;
}
.col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.colhead strong { font-size: 12px; color: #e6edf7; }
.stage {
  border-radius: 12px; overflow: hidden; border: 1px solid #1b2537;
  padding: 22px 18px 28px; min-height: 640px;
  display: flex; align-items: flex-start; justify-content: center;
  --dsw-alias-label-primary: #eef2f8;
  --dsw-alias-label-secondary: #b9c4d4;
  --dsw-alias-label-tertiary: #97a4b6;
}
.msg { width: 100%; max-width: 460px; }
${baseCss}
</style></head>
<body data-ds-dark-theme data-dsh-tavern-render>
${stageHtml}
</body></html>`;

fs.writeFileSync('D:/DeepSeek-Workspace/dsh-tavern-render/preview-real.html', page, 'utf8');
console.log('wrote preview-real.html');
console.log('使用壁纸:', byBig.map((b) => b.f.slice(0, 12) + '…(' + Math.round(b.size / 1024) + 'KB)').join(', '));
