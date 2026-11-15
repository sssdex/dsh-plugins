/**
 * 预览页生成器：把 lib/{parse,render,styles}.js 的真实输出变成**可脱离 DSH 客户端**
 * 直接截图的静态 HTML。
 *
 * 为什么需要它：
 *   DSH Web 页面带鉴权，无头浏览器进不去，视觉验收只能靠 file:// 的静态快照。
 *   上一轮的 preview.html 是手工敲出来的，改一次样式就要重敲一遍 —— 这里改成
 *   生成脚本：改完 lib/ 里的源码，跑一次 `node scripts/preview.mjs` 就能截图。
 *
 * 产出（默认写到仓库根）：
 *   preview.html        深色版（body 同时带 SCOPE_ATTR 与 data-ds-dark-theme）
 *   preview-light.html  浅色版（body 只带 SCOPE_ATTR，走 styles.js 的亮色分支）
 *
 * 为什么拆两个文件而不是同页切换：
 *   styles.js 的主题分支选择器是 body:where([SCOPE_ATTR]) 与
 *   body:where([SCOPE_ATTR]):not([data-ds-dark-theme]) —— 只输出一份样式表，
 *   靠 body 上的属性切换。同一个文档只有一个 body，两个主题必然打架；
 *   所以用同一个生成函数产出两份文件，各自 body 属性不同，最稳妥。
 *
 * 用法：
 *   node scripts/preview.mjs
 *   node scripts/preview.mjs --out preview-dev.html   # 浅色自动变成 preview-dev-light.html
 *
 * 约束：纯 Node（只用 node:fs / node:path / node:url），不装任何依赖；
 *       产物自包含（CSS 全内联、无外部请求、无 <script>），方便 Chrome --screenshot。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMessage, summarize } from '../lib/parse.js';
import { renderMessage } from '../lib/render.js';
import { buildCSS, SCOPE_ATTR, STYLE_ID } from '../lib/styles.js';

/* ROOT 的求法与 scripts/build.mjs 一致：脚本目录的上一级 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ─────────────────────────── 样例 ─────────────────────────── */

/**
 * a) TRS v1 完整样例（规范语法，主路径）。
 * 覆盖：旁白 / 对白 / *动作*；<info> <status>(2 个 char) <chat>(2 条)
 *       <feed>(1 条带 <note>) <list>(3 条) <choice>(3 项)。
 */
const SAMPLE_TRS = `<scene>
<prose>
晨光从露台的玻璃门斜切进来，在厨房的地砖上划出一道浅金色的边。你还没完全睁开眼，楼下已经热闹起来——油在锅里炸开的细响，碗碟轻轻碰撞，还有一个脚步在木地板上小跑。
厨房里第一个抬眼的是清韵。她把煎蛋翻过来，听见脚步声就一直盯着锅，*耳朵先红了*。
"爸爸，早……啊❤"她把铲子放下，转过身来，"清韵做了早饭。那个……蛋有点焦，对不起。"
她说到一半忽然停住，*两只手在围裙上无意识地蹭了两下*。
"焦的才香哦！"昕彤从吧台那边蹦起来，金色侧马尾一甩，赤着脚就扑到你身上。
</prose>
<panel>
<info time="07:22 周六" place="家中厨房" weather="晴"/>
<status>
  <char name="清韵" affection=62 reason=18 mood="紧张又期待" outfit="米色棉布长裙，外系浅棕色围裙，赤足踩着棉拖鞋" body="指尖还沾着一点面粉">
    心声：爸爸在看这边……明明只是做早饭。
  </char>
  <char name="昕彤" affection=75 reason=12 mood="黏人撒娇" outfit="宽大白衬衫当裙子穿，只扣两颗扣子，赤脚" body="刚睡醒，头发乱糟糟">
    心声：爸爸的手好暖哦❤可是要是不主动一点，爸爸肯定又先去看姐姐了。
  </char>
</status>
<chat time="07:20">
  <msg from="昕彤">爸爸起床了哦！快下来快下来！</msg>
  <msg from="清韵">……蛋要凉了呢</msg>
</chat>
<feed source="推特">
  <post name="养女日常" handle="Petropavlovsk" stats="43k">
    周六早上！爸爸还在睡，彤彤已经做完早饭了哦（其实是姐姐做的） #日常 #周六 #早餐
    <note>图片：吧台上的煎蛋.jpg —— 盘子里摆着两颗略微焦边的煎蛋，旁边是两只小手比着V。</note>
  </post>
</feed>
<list title="推荐">
  <item>周六限时：家用手冲咖啡套装，买一送一</item>
  <item>亚麻家居服新款上架，轻薄透气</item>
  <item>最新款人体工学椅，久坐不累，支撑完美</item>
</list>
<choice>
  <opt>先喝清韵递来的牛奶，再坐下吃早饭</opt>
  <opt>把扑过来的昕彤抱上吧台</opt>
  <opt>让清韵把围裙解下来，看看她到底怎么了</opt>
</choice>
</panel>
</scene>`;

/**
 * b) 旧格式样例（网上现成酒馆预设的写法，位置式状态）。
 * 覆盖：<mainbody> 正文 + <phone> 里的 <Status>（位置式 62|18|心声|穿着…）、
 *       <twitter><account1>（parseSocial：名字|handle|stats|正文|<Append>）、
 *       <bilibili>（直播列表）、<wechat>、<adv>、<choice>。
 */
const SAMPLE_LEGACY = `<mainbody> 晨光从露台的玻璃门斜切进来，你还没完全睁开眼，楼下的动静就顺着楼梯爬了上来。
厨房里第一个抬眼的是清韵。她正把煎蛋翻过来，听见脚步声就一直盯着锅，耳朵先红了。"爸爸，早……啊❤"她把铲子放下，转过身来，"清韵做了早饭。那个……蛋有点焦，对不起。"
"焦的才香哦！"昕彤从吧台那边蹦起来，金色侧马尾一甩，赤着脚就扑到你身上。 </mainbody>
<phone> 07:22|2025-04-12 周六 <Status> <清韵>62|18|爸爸在看这边❤围裙在腰上勒得紧紧的……明明只是做早饭|米色棉布长裙，外面系着浅棕色围裙，赤足踩着棉拖鞋，头发绑在脑后|指尖还沾着一点面粉<br> <昕彤>75|12|爸爸的手好暖哦❤可是要是不主动一点，爸爸肯定又先去看姐姐了|白衬衫当裙子穿，只扣两颗扣子，赤脚，金发侧马尾|刚睡醒，头发乱糟糟<br> </Status> <twitter> <account1> 养女日常|Petropavlovsk|43k|周六早上！爸爸还在睡，彤彤已经做完早饭了哦（其实是姐姐做的） <Append> 图片1：吧台上的煎蛋.jpg 盘子里摆着两颗略微焦边的煎蛋，旁边是两只小手比着V。 </Append> #日常 #周六 #早餐|920|340|2100<br> 草莓味小甜心|StrawberrySweet|姐姐做的好吃！彤彤偷懒了吧www<br> 单推昕彤喵|TongtongOnly|爸爸视角？太甜了太甜了<br> </account1> </twitter> <bilibili> 未开播|无<br> 周六都不开播吗|Seiyun酱是不是在睡懒觉|等等看今晚吧|听说深夜档会有惊喜 </bilibili> <wechat> <time>07:20</time> <昕彤>爸爸起床了哦！快下来快下来！</昕彤> <清韵>……蛋要凉了呢</清韵> </wechat> <adv> 周六限时：家用手冲咖啡套装，买一送一|亚麻家居服新款上架，轻薄透气|最新款人体工学椅，久坐不累 </adv> <choice>先喝清韵递来的牛奶，再坐下吃早饭|把扑过来的昕彤抱上吧台|让清韵把围裙解下来，看看她到底怎么了</choice> </phone>`;

/**
 * c) 普通回复样例（对照组，**不该被排版**）。
 * 特意放技术性 Markdown：代码块、有序列表、带引号的字符串、`*` 通配符。
 * 用数组拼行是为了避免模板字面量里的反引号转义。
 */
const SAMPLE_PLAIN = [
  '## 预览页生成器怎么跑',
  '',
  '1. 先跑 `node scripts/preview.mjs`，产物落在仓库根。',
  '2. 想换路径就加 `--out preview-dev.html`，浅色版会自动跟着改名。',
  '3. 通配符 `*.js` 与 `**/*.mjs` 都会匹配，别只测一层。',
  '',
  '```js',
  "import { renderMessage } from '../lib/render.js';",
  '',
  'const html = renderMessage(parsed, { wrap: false });',
  'console.log(html.length, "chars");',
  '```',
  '',
  '如果 `html` 是空字符串，说明这条回复不该被接管，保留原生 Markdown 即可。',
].join('\n');

/**
 * d) 畸形 / 容错组：肉眼确认「看不懂就原样保留、不吞内容」。
 *
 * 拆成三段**互相独立**的消息，各自 parse + render —— 拼成一条会互相干扰
 * （未闭合的 <scene> 会一路吞到后面那条消息的 </scene>，那不是被测对象的行为，
 * 而是我们自己造出来的输入错误）。每段对应一条容错路径：
 *   d1 未闭合 <scene>（缺 </scene>）—— eachTag 的「有开始没结束」分支，应吞到结尾照常解析；
 *   d2 大写 <Status> 在旧格式 <phone> 里 —— 旧解析器大小写不敏感，位置式字段应照常出卡；
 *   d3 自创标签 <心情> —— 解析器不认识，去掉标签后文字必须一个字不少。
 */
const SAMPLE_ROBUST_PARTS = [
  {
    id: 'd1',
    label: '未闭合 <scene>（缺 </scene>）',
    note: '有开始没结束 → 吞到结尾，正文与选项都必须还在',
    mustKeep: ['雨还没停', '你等很久了吧', '把伞接过来', '先问问她路上怎么了'],
    raw: `<scene>
<prose>
雨还没停。她把伞收起来，甩了两下，水珠在地砖上溅开。
"你等很久了吧？"
</prose>
<panel>
<choice>
  <opt>把伞接过来</opt>
  <opt>先问问她路上怎么了</opt>
</choice>
</panel>`,
  },
  {
    id: 'd2',
    label: '大写 <Status> 混在旧格式 <phone> 里',
    note: '旧解析器大小写不敏感，位置式 62|18|心声|穿着 应照常出状态卡',
    mustKeep: [
      '屋檐下的水一连串地滴下来',
      '进来吧',
      '爸爸在看这边',
      '米色棉布长裙',
      '指尖还沾着雨水',
      '爸爸终于回来了',
      '刚睡醒',
      '把伞接过来',
      '先问问她路上怎么了',
    ],
    raw: `<mainbody>
雨声渐小，屋檐下的水一连串地滴下来。"进来吧，别站在门口。"
</mainbody>
<phone> 21:40 <Status>
  <清韵>62|18|爸爸在看这边|米色棉布长裙|指尖还沾着雨水
  <昕彤>75|12|爸爸终于回来了|白衬衫当裙子穿|刚睡醒
</Status> <choice>把伞接过来|先问问她路上怎么了</choice> </phone>`,
  },
  {
    id: 'd3',
    label: '自创标签 <心情>',
    note: '解析器不认识这个标签 → 剥掉标签，里面的文字必须留在正文里',
    mustKeep: ['雨还没停', '有点紧张', '你等很久了吧'],
    // 注意：标签名本身会被剥掉（那是预期行为），所以 mustKeep 里不写「心情」
    raw: `<scene><prose>雨还没停。<心情>有点紧张</心情>"你等很久了吧？"</prose></scene>`,
  },
];

const SAMPLES = [
  {
    id: 'a',
    title: 'TRS v1 完整样例',
    expect: '结构化 → 排版',
    mode: 'render',
    desc:
      '旁白 / "对白" / *动作*；<panel> 里 info + status（2 个 char，带 affection/reason 数值、' +
      'mood/outfit 短词与长句、心声正文）+ chat（2 条）+ feed（1 条带 note）+ list（3 条）+ choice（3 项）',
    raw: SAMPLE_TRS,
  },
  {
    id: 'b',
    title: '旧格式样例（兼容兜底）',
    expect: 'syntax=legacy → 排版',
    mode: 'render',
    desc:
      '<mainbody> 正文 + <phone> 里的 <Status> 位置式（<清韵>62|18|心声|穿着…）+ ' +
      '<twitter><account1>（parseSocial，含主帖 + 2 条评论）+ <bilibili> 直播列表 + ' +
      '<wechat> + <adv> + <choice>；字段顺序靠猜，但必须能显示出来',
    raw: SAMPLE_LEGACY,
  },
  {
    id: 'c',
    title: '普通回复样例（对照组）',
    expect: 'syntax=loose → 客户端明确拒绝',
    mode: 'plain',
    desc:
      '技术性 Markdown：代码块、有序列表、带引号的字符串、`*` 通配符。' +
      '这段是「误伤检测」用的——排版栏里直接显示原文，不展示渲染结果',
    raw: SAMPLE_PLAIN,
  },
  {
    id: 'd',
    title: '畸形 / 容错组',
    expect: '看不懂就原样保留，不吞内容',
    mode: 'tolerant',
    desc:
      '三段**独立**的坏输入，各自解析：未闭合 <scene>（缺 </scene>）、' +
      '大写 <Status> 混在旧格式 <phone> 里、自创标签 <心情>。' +
      '用来肉眼确认解析器没有把内容吃掉',
    // 三段分别 parse + render，页面上也分开显示
    parts: SAMPLE_ROBUST_PARTS,
  },
];

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** 转义为 HTML 文本（与 lib/parse.js 的 esc 同义，这里自带一份避免多一个耦合点）。 */
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 字节数，打印用。 */
function bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * 预览页上的「客户端会不会接管」判定。
 *
 * 对齐当前客户端契约：**只接管有明确标签指纹的消息** —— syntax 必须是
 * 'trs' 或 'legacy'。'loose'（无标签兜底）在根上就被拒绝，跟
 * passesThreshold 的 minSpeech 门槛完全无关；门槛以后怎么调都不会复活 loose。
 *
 * 刻意不 import 客户端代码（那是浏览器 bundle，跑不了），也不改插件行为 ——
 * 这里只是把同一份契约复述一遍用于展示。
 */
const TAKEABLE_SYNTAX = new Set(['trs', 'legacy']);

function clientWouldTakeOver(parsed) {
  if (!parsed) return { yes: false, why: '没有解析结果' };

  // 第一道闸（根上拒绝）：语法指纹
  if (parsed.kind !== 'structured') {
    return { yes: false, why: `kind=${parsed.kind}，没有结构化分区，客户端不看` };
  }
  if (!TAKEABLE_SYNTAX.has(parsed.syntax)) {
    return {
      yes: false,
      why: `syntax=${parsed.syntax} —— 客户端明确拒绝（只接管 trs / legacy），非门槛判定`,
    };
  }

  // 第二道闸：结构化分区的内容量门槛（与 loose 无关，loose 已经在上一步出局）
  let speech = 0;
  for (const b of parsed.blocks) {
    if (b.type === 'prose') {
      for (const s of b.segments) if (s.kind === 'speech') speech += 1;
    } else if (
      b.type === 'status' || b.type === 'chars' ||
      b.type === 'choices' || b.type === 'wechat' || b.type === 'list'
    ) {
      return { yes: true, why: `syntax=${parsed.syntax}，命中 <${b.type}> 分区，客户端接管` };
    } else if (b.type === 'social' && b.accounts.length > 0) {
      return { yes: true, why: `syntax=${parsed.syntax}，命中 <social> 分区，客户端接管` };
    }
  }
  // 门槛必须等于客户端默认值（lib/client.bundle.tpl.js 的 DEFAULTS.minSpeech）。
  // 写死别的数字会让预览页与实际行为不符，等于骗人。
  const minSpeech = 1;
  const yes = speech >= minSpeech;
  return {
    yes,
    why: yes
      ? `syntax=${parsed.syntax}，对白 ${speech} 段 ≥ 门槛 ${minSpeech}，客户端接管`
      : `syntax=${parsed.syntax}，但对白 ${speech} 段 < 门槛 ${minSpeech}，客户端暂不接管`,
  };
}

/* ─────────────────────────── 解析 + 渲染 ─────────────────────────── */

const cases = [];
for (const sample of SAMPLES) {
  // d 组是「多个互相独立的坏输入」，各自 parse + render；其它组只有一条 raw
  const parts = Array.isArray(sample.parts)
    ? sample.parts.map((p) => {
        const parsed = parseMessage(p.raw);
        const rendered = renderMessage(parsed);
        const renderedText = rendered.replace(/<[^>]*>/g, '');
        const lost = p.mustKeep.filter((f) => !renderedText.includes(f));
        return {
          ...p,
          parsed,
          rendered,
          renderedText,
          lost,
          kind: parsed.kind,
          syntax: parsed.syntax,
          summary: summarize(parsed).join(' · ') || '（无分区）',
          takeover: clientWouldTakeOver(parsed),
        };
      })
    : null;

  const parsed = parts ? null : parseMessage(sample.raw);
  const rendered = parts ? '' : renderMessage(parsed);

  cases.push({
    ...sample,
    parts,
    parsed,
    rendered,
    takeover: parts ? null : clientWouldTakeOver(parsed),
    summary: parts ? '' : summarize(parsed).join(' · ') || '（无分区）',
    kind: parts ? '（三段见右）' : parsed.kind,
    syntax: parts ? 'mixed' : parsed.syntax,
  });
}

const byId = Object.fromEntries(cases.map((c) => [c.id, c]));

/* ─────────────────────────── 自检 ─────────────────────────── */

const checks = [];
function check(ok, message) {
  checks.push({ ok, message });
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  return ok;
}

console.log('自检：');

// a) 结构化渲染：四类关键标记必须都在
{
  const c = byId.a;
  const html = c.rendered || '';
  const need = ['tt-speech', 'tt-char', 'tt-choice', 'tt-bubble'];
  const missing = need.filter((n) => !html.includes(n));
  check(
    missing.length === 0,
    `[a] TRS 渲染 HTML 含 ${need.join(' / ')}（${missing.length ? '缺 ' + missing.join(',') : '全部命中'}，${html.length} 字符）`
  );
  check(c.kind === 'structured' && c.syntax === 'trs', `[a] parse → kind=${c.kind} syntax=${c.syntax}（应为 structured/trs）`);
  check(c.takeover.yes, `[a] 客户端接管判定：${c.takeover.yes ? '会接管' : '不接管'}（${c.takeover.why}）`);
}

// b) 旧格式：必须判成 legacy 且渲染出状态卡 / 社交 / 直播
{
  const c = byId.b;
  const html = c.rendered || '';
  check(c.syntax === 'legacy', `[b] parse → kind=${c.kind} syntax=${c.syntax}（应为 legacy）`);
  check(html.includes('tt-char'), `[b] 旧格式渲染 HTML 含 tt-char 状态卡（${html.length} 字符）`);
  check(html.includes('tt-gauge'), '[b] 旧格式位置式数值渲染出环形仪表（tt-gauge）');
  check(
    html.includes('tt-social') && html.includes('tt-post-handle'),
    '[b] <twitter><account1> 解析出社交帖（tt-social + handle）'
  );
  check(
    html.includes('data-variant="bilibili"'),
    '[b] <bilibili> 解析出直播列表（data-variant="bilibili"）'
  );
}

// c) 对照组：syntax=loose 是**预期值**，证明它落在客户端明确拒绝的分支里
{
  const c = byId.c;
  console.log(`  · [c] 实际值 kind=${c.kind} syntax=${c.syntax}`);
  check(
    c.syntax === 'loose',
    `[c] syntax === 'loose'（预期值；这是客户端在根上拒绝的分支，不是门槛兜底）`
  );
  check(
    !c.takeover.yes,
    `[c] 客户端不接管：${c.takeover.why}`
  );
  check(
    !TAKEABLE_SYNTAX.has(c.syntax),
    `[c] 不在可接管语法集合内（${[...TAKEABLE_SYNTAX].join('/')}），与 minSpeech 门槛无关`
  );
  check(
    c.mode === 'plain',
    '[c] 走对照组模式：排版栏显示原文（renderMessage 输出只作「假设被接管」的反例折叠展示）'
  );
}

// d) 畸形 / 容错组：三段坏输入各自独立，坏输入不能吞内容
{
  const c = byId.d;
  const parts = c.parts || [];
  check(parts.length === 3, `[d] 三段互相独立的坏输入（实际 ${parts.length} 段）`);

  const d1 = parts[0];
  check(
    d1 && d1.syntax === 'trs',
    `[d1] 未闭合 <scene> 仍判成 trs（kind=${d1?.kind} syntax=${d1?.syntax}）`
  );

  const d2 = parts[1];
  const statusBlock = d2?.parsed.blocks.find((b) => b.type === 'status');
  check(
    d2?.syntax === 'legacy' && Boolean(statusBlock) && statusBlock.rows.length >= 2,
    `[d2] 大写 <Status> 在 <phone> 里仍判 legacy 且解析出 ${statusBlock ? statusBlock.rows.length : 0} 行状态`
  );

  const d3 = parts[2];
  const d3Text = d3
    ? d3.parsed.blocks
        .filter((b) => b.type === 'prose')
        .flatMap((b) => b.segments.map((s) => s.text))
        .join('\n')
    : '';
  check(
    d3Text.includes('有点紧张') && !d3Text.includes('<心情>'),
    '[d3] 自创 <心情> 标签被剥掉，但里面的文字保留在正文里（不吞内容）'
  );

  // 逐段核对 mustKeep：渲染结果里每个片段都得在
  for (const p of parts) {
    check(
      p.lost.length === 0,
      `[${p.id}] 渲染保留全部 ${p.mustKeep.length} 个关键片段` +
        (p.lost.length ? `（丢失：${p.lost.join(' / ')}）` : '，零丢失')
    );
  }
}

// 产物：自包含（无脚本、无外链）
{
  const css = buildCSS();
  check(!/<script/i.test(css), '[页面] 内联 CSS 里没有 <script');
}

const failed = checks.filter((x) => !x.ok);
if (failed.length > 0) {
  console.error(`\n✗ 自检失败 ${failed.length} 项：${failed.map((f) => f.message).join(' | ')}`);
  process.exit(1);
}

/* ─────────────────────────── 页面主题 ─────────────────────────── */

/**
 * 两套页面配色。注意：插件的 --tt-* 变量里有一部分读宿主变量
 * （--dsw-alias-label-primary 等），真实 DSH 里由宿主提供；预览页里我们
 * 手工把这些宿主变量写进 body，才能模拟「暗色 / 亮色主题下插件长什么样」。
 */
const THEMES = {
  dark: {
    key: 'dark',
    label: '深色',
    darkAttr: true,
    pageBg: '#0a0e13',
    text: '#cfd8e4',
    head: '#e9eff7',
    dim: '#8b95a5',
    accent: '#7fd3c4',
    panel: '#121820',
    stage: '#101720',
    border: 'rgba(255,255,255,0.13)',
    rawBg: '#0c1116',
    rawColor: '#9fb0c2',
    rowBg: 'rgba(255,255,255,0.03)',
    okBg: 'rgba(127,211,196,0.12)',
    okColor: '#7fd3c4',
    warnBg: 'rgba(229,181,103,0.12)',
    warnColor: '#e5b567',
    hostVars: `--dsw-alias-label-primary:#e6ebf2;
  --dsw-alias-label-secondary:#b6c0cd;
  --dsw-alias-label-tertiary:#8b95a5;
  --dsw-alias-border-l1:rgba(255,255,255,0.13);
  --dsw-alias-bg-layer-2:rgba(255,255,255,0.03);
  --dsw-alias-markdown-code-block:rgba(255,255,255,0.05);`,
  },
  light: {
    key: 'light',
    label: '浅色',
    darkAttr: false,
    pageBg: '#eef1f6',
    text: '#28303d',
    head: '#131a24',
    dim: '#5c6a7d',
    accent: '#0f7a6c',
    panel: '#ffffff',
    stage: '#ffffff',
    border: 'rgba(15,30,60,0.14)',
    rawBg: '#f2f5f9',
    rawColor: '#3d495c',
    rowBg: 'rgba(15,30,60,0.025)',
    okBg: 'rgba(15,122,108,0.1)',
    okColor: '#0f7a6c',
    warnBg: 'rgba(180,125,30,0.12)',
    warnColor: '#8a5d10',
    hostVars: `--dsw-alias-label-primary:#1e2430;
  --dsw-alias-label-secondary:#41495a;
  --dsw-alias-label-tertiary:#69768a;
  --dsw-alias-border-l1:rgba(15,30,60,0.14);
  --dsw-alias-bg-layer-2:rgba(15,30,60,0.025);
  --dsw-alias-markdown-code-block:rgba(15,30,60,0.04);`,
  },
};

/** 页头的一行徽标：样例数 / 主题 / 生成时间。 */
function stamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

/* ─────────────────────────── 页面拼装 ─────────────────────────── */

/** 单栏：原始文本。 */
function rawPane(c) {
  const label =
    c.mode === 'plain'
      ? '原始 / 未排版（技术回复）'
      : c.mode === 'tolerant'
        ? '原始 / 未排版（三段畸形输入）'
        : '原始 / 未排版';
  return `<div class="pv-pane">
        <h3 class="pv-pane-title">${esc(label)}</h3>
        <pre class="pv-raw">${esc(c.raw)}</pre>
      </div>`;
}

/** 单栏：排版结果（c 组走原文回退；d 组要额外标出内容保留情况）。 */
function resultPane(c) {
  if (c.mode === 'plain') {
    const wrong = String(c.rendered || '').trim();
    const details = wrong
      ? `<details class="pv-details">
          <summary>如果被错误接管，loose 兜底会渲染成这样（客户端已拒绝 loose，正常情况下不会出现）</summary>
          <div class="pv-stage pv-stage-wrong">${wrong}</div>
        </details>`
      : '';
    return `<div class="pv-pane">
        <h3 class="pv-pane-title">排版后 <span class="pv-badge pv-badge-warn">未调用排版 / 原文回退</span></h3>
        <div class="pv-notice">
          <strong>不该被接管，应保持原样。</strong>
          parse → <code>kind=${esc(c.kind)} · syntax=${esc(c.syntax)}</code>。
          <br><code>syntax=loose</code> —— 客户端<strong>明确拒绝</strong>（只接管 trs / legacy），非门槛判定。
          已在客户端根上拒绝 loose，与门槛配置无关：以后 <code>minSpeech</code> 怎么调都不会复活它。
          所以这一栏显示的就是原文，插件不会碰它。
        </div>
        <pre class="pv-raw pv-raw-plain">${esc(c.raw)}</pre>
        ${details}
      </div>`;
  }

  const html = String(c.rendered || '');

  // d 组：三段独立输入，各自一左一右，并在每段上标注内容保留情况
  if (c.mode === 'tolerant' && Array.isArray(c.parts)) {
    const blocks = c.parts.map((p) => {
      const keep = p.lost.length
        ? `<div class="pv-notice">
            <strong>✗ 有内容丢失（${p.lost.length}/${p.mustKeep.length}）：</strong>
            <code>${esc(p.lost.join(' / '))}</code>
          </div>`
        : `<div class="pv-notice pv-notice-ok">
            <strong>✓ 零丢失：</strong>${p.mustKeep.length} 个关键片段全部保留
          </div>`;
      const stage = String(p.rendered || '').trim()
        ? `<div class="pv-stage">${p.rendered}</div>`
        : `<div class="pv-stage pv-stage-wrong"><pre class="pv-raw">${esc(p.raw)}</pre></div>`;
      return `<div class="pv-sub">
        <div class="pv-sub-head">
          <span class="pv-sub-id">${esc(p.id)}</span>
          <span class="pv-sub-label">${esc(p.label)}</span>
          <span class="pv-badge ${p.lost.length ? 'pv-badge-warn' : 'pv-badge-ok'}">${esc(p.kind)} / ${esc(p.syntax)}</span>
        </div>
        <p class="pv-sub-note">${esc(p.note)}</p>
        <p class="pv-parse">summarize() → <code>${esc(p.summary)}</code></p>
        <div class="pv-cols">
          <div class="pv-pane">
            <h3 class="pv-pane-title">原始 / 未排版</h3>
            <pre class="pv-raw">${esc(p.raw)}</pre>
          </div>
          <div class="pv-pane">
            <h3 class="pv-pane-title">排版后 <span class="pv-badge pv-badge-ok">renderMessage()</span></h3>
            ${keep}
            ${stage}
          </div>
        </div>
      </div>`;
    }).join('\n');
    return `<div class="pv-pane pv-pane-wide">${blocks}</div>`;
  }

  if (!html.trim()) {
    return `<div class="pv-pane">
        <h3 class="pv-pane-title">排版后 <span class="pv-badge pv-badge-warn">renderMessage() 返回空</span></h3>
        <pre class="pv-raw pv-raw-plain">${esc(c.raw)}</pre>
      </div>`;
  }

  return `<div class="pv-pane">
        <h3 class="pv-pane-title">排版后 <span class="pv-badge pv-badge-ok">renderMessage()</span></h3>
        <div class="pv-stage">${html}</div>
      </div>`;
}

/** 顶部总览卡片。 */
function overviewCard(c) {
  let ok;
  let meta2 = c.takeover ? c.takeover.why : '';
  let syntaxText = c.syntax;

  if (c.mode === 'plain') {
    // 对照组：通过 = 客户端不接管（syntax 不在可接管集合里）
    ok = !c.takeover.yes;
  } else if (c.mode === 'tolerant') {
    // 容错组：通过 = 三段都渲染出东西且零丢失
    const parts = c.parts || [];
    ok = parts.length === 3 && parts.every((p) => String(p.rendered || '').trim() && p.lost.length === 0);
    syntaxText = parts.map((p) => `${p.id}:${p.syntax}`).join(' ');
    meta2 = ok
      ? '三段坏输入全部原样保留，零内容丢失'
      : '有段内容被吞，展开看红色提示';
  } else {
    ok = c.takeover.yes && Boolean(String(c.rendered || '').trim());
  }

  return `<div class="pv-card">
        <div class="pv-card-id">${esc(c.id)}</div>
        <div class="pv-card-body">
          <div class="pv-card-title">${esc(c.title)}</div>
          <div class="pv-card-meta"><code>kind=${esc(c.kind)}</code> <code>syntax=${esc(syntaxText)}</code></div>
          <div class="pv-card-meta">${esc(meta2)}</div>
        </div>
        <div class="pv-card-flag ${ok ? 'pv-flag-ok' : 'pv-flag-warn'}">${ok ? '✓' : '!'}</div>
      </div>`;
}

function caseBlock(c) {
  const badge = c.mode === 'plain' ? 'pv-badge-warn' : 'pv-badge-ok';

  // d 组：三段各自成对（原始 / 排版），不再外套一层公共双栏
  if (c.mode === 'tolerant') {
    return `  <section class="pv-case" id="case-${esc(c.id)}">
    <div class="pv-case-head">
      <span class="pv-case-id">${esc(c.id)}</span>
      <div>
        <h2>${esc(c.title)} <span class="pv-tag">${esc(c.expect)}</span></h2>
        <p class="pv-desc">${esc(c.desc)}</p>
      </div>
      <span class="pv-badge ${badge}">${(c.parts || []).map((p) => `${p.id}:${p.syntax}`).join(' ')}</span>
    </div>
    ${resultPane(c)}
  </section>`;
  }

  return `  <section class="pv-case" id="case-${esc(c.id)}">
    <div class="pv-case-head">
      <span class="pv-case-id">${esc(c.id)}</span>
      <div>
        <h2>${esc(c.title)} <span class="pv-tag">${esc(c.expect)}</span></h2>
        <p class="pv-desc">${esc(c.desc)}</p>
      </div>
      <span class="pv-badge ${badge}">${esc(c.kind)} / ${esc(c.syntax)}</span>
    </div>
    <p class="pv-parse">summarize() → <code>${esc(c.summary)}</code></p>
    ${c.limitation ? `<div class="pv-notice pv-notice-info"><strong>⚠ 已知局限：</strong>${c.limitation}</div>` : ''}    <div class="pv-cols">
      ${rawPane(c)}
      ${resultPane(c)}
    </div>
  </section>`;
}

function checksBlock() {
  const rows = checks
    .map(
      (x) => `<li class="${x.ok ? 'pv-ok' : 'pv-bad'}">${x.ok ? '✓' : '✗'} ${esc(x.message)}</li>`
    )
    .join('\n      ');
  return `<section class="pv-checks">
    <h2>自检 <span class="pv-tag">脚本内断言，任一失败 exit 1</span></h2>
    <ul>
      ${rows}
    </ul>
  </section>`;
}

/**
 * 生成一份完整页面。
 * @param {object} theme THEMES 里的一项
 * @param {{css:string}} parts
 */
function buildPage(theme, css) {
  // 深色版带 data-ds-dark-theme，浅色版不带 —— 正好对应 styles.js 的两个分支
  const bodyAttrs = theme.darkAttr
    ? `${SCOPE_ATTR}="" data-ds-dark-theme`
    : `${SCOPE_ATTR}=""`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1500, initial-scale=1">
<title>酒馆回话排版 · 预览（${esc(theme.label)}）</title>
<style>
/* ── 预览页自身的骨架样式（插件样式在下面那个 <style id="${STYLE_ID}"> 里） ── */
* { box-sizing: border-box; }
html { background: ${theme.pageBg}; }
body {
  margin: 0 auto;
  padding: 26px 30px 56px;
  width: 1500px;
  max-width: 1500px;
  background: ${theme.pageBg};
  color: ${theme.text};
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  /* 模拟宿主主题变量：styles.js 里 --tt-narration 等读的是这几个 */
  ${theme.hostVars}
}

/* 页头 */
.pv-head { border-bottom: 1px solid ${theme.border}; padding-bottom: 14px; margin-bottom: 20px; }
.pv-head h1 { margin: 0 0 8px; font-size: 21px; font-weight: 700; color: ${theme.head}; letter-spacing: .01em; }
.pv-head h1 .pv-theme { color: ${theme.accent}; }
.pv-sub { margin: 3px 0 0; font-size: 12.5px; line-height: 1.7; color: ${theme.dim}; }
.pv-sub code, .pv-parse code, .pv-card-meta code, .pv-notice code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11.5px;
  background: ${theme.rowBg};
  border: 1px solid ${theme.border};
  border-radius: 5px;
  padding: 0 5px;
  color: ${theme.text};
}

/* 总览 */
.pv-overview { display: grid; grid-template-columns: repeat(${SAMPLES.length}, minmax(0, 1fr)); gap: 12px; margin: 16px 0 24px; }
.pv-card {
  display: flex; align-items: flex-start; gap: 10px;
  border: 1px solid ${theme.border}; border-radius: 11px;
  background: ${theme.panel}; padding: 10px 12px;
}
.pv-card-id {
  flex: none; width: 22px; height: 22px; border-radius: 50%;
  display: grid; place-items: center;
  font: 700 11.5px ui-monospace, Consolas, monospace;
  color: ${theme.accent}; border: 1px solid ${theme.accent};
}
.pv-card-body { min-width: 0; flex: 1; }
.pv-card-title { font-size: 13px; font-weight: 600; color: ${theme.head}; margin-bottom: 5px; }
.pv-card-meta { font-size: 11.5px; line-height: 1.65; color: ${theme.dim}; }
.pv-card-flag { flex: none; font-weight: 700; font-size: 13px; }
.pv-flag-ok { color: ${theme.okColor}; }
.pv-flag-warn { color: ${theme.warnColor}; }

/* 每个样例 */
.pv-case { margin-bottom: 30px; }
.pv-case-head { display: flex; align-items: flex-start; gap: 11px; }
.pv-case-id {
  flex: none; width: 24px; height: 24px; border-radius: 7px;
  display: grid; place-items: center; margin-top: 1px;
  background: ${theme.rowBg}; border: 1px solid ${theme.border};
  font: 700 12px ui-monospace, Consolas, monospace; color: ${theme.accent};
}
.pv-case-head > div { flex: 1; min-width: 0; }
.pv-case h2 { margin: 0 0 5px; font-size: 15px; font-weight: 700; color: ${theme.head}; }
.pv-tag {
  font-size: 10.5px; font-weight: 500; letter-spacing: .04em;
  color: ${theme.dim}; border: 1px dashed ${theme.border};
  border-radius: 999px; padding: 1px 7px; margin-left: 6px;
  white-space: nowrap;
}
.pv-desc { margin: 0; font-size: 12px; line-height: 1.7; color: ${theme.dim}; }
.pv-badge {
  flex: none; font: 600 10.5px ui-monospace, Consolas, monospace;
  border-radius: 999px; padding: 2px 9px; letter-spacing: .03em;
  white-space: nowrap;
}
.pv-badge-ok { color: ${theme.okColor}; background: ${theme.okBg}; border: 1px solid ${theme.okColor}; }
.pv-badge-warn { color: ${theme.warnColor}; background: ${theme.warnBg}; border: 1px solid ${theme.warnColor}; }
.pv-parse { margin: 9px 0 11px; font-size: 11.5px; line-height: 1.7; color: ${theme.dim}; }

/* 双栏 */
.pv-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.pv-pane { min-width: 0; }
.pv-pane-wide { width: 100%; }

/* d 组：每段坏输入一组，段之间用分隔线隔开 */
.pv-sub {
  border-top: 1px dashed ${theme.border};
  padding-top: 14px;
  margin-top: 16px;
}
.pv-sub:first-child { border-top: 0; padding-top: 0; margin-top: 4px; }
.pv-sub-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 9px; }
.pv-sub-id {
  font: 700 11px ui-monospace, Consolas, monospace;
  color: ${theme.accent};
  border: 1px solid ${theme.border};
  border-radius: 5px;
  padding: 0 5px;
}
.pv-sub-label { font-size: 13px; font-weight: 600; color: ${theme.head}; }
.pv-sub-note { margin: 5px 0 0; font-size: 11.5px; line-height: 1.7; color: ${theme.dim}; }
.pv-pane-title {
  margin: 0 0 9px; font-size: 11px; font-weight: 700;
  letter-spacing: .16em; text-transform: uppercase; color: ${theme.dim};
  display: flex; align-items: center; gap: 8px;
}
.pv-raw {
  margin: 0; padding: 16px 18px;
  background: ${theme.rawBg}; border: 1px solid ${theme.border}; border-radius: 12px;
  color: ${theme.rawColor};
  font: 12.5px/1.85 ui-monospace, "Cascadia Code", Consolas, monospace;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
}
.pv-raw-plain { color: ${theme.text}; }
.pv-stage {
  padding: 18px 20px;
  background: ${theme.stage}; border: 1px solid ${theme.border}; border-radius: 12px;
  min-height: 60px;
}
.pv-stage-wrong { border-style: dashed; opacity: .8; margin-top: 8px; }
.pv-notice {
  margin: 0 0 10px; padding: 9px 12px;
  font-size: 12px; line-height: 1.75;
  color: ${theme.text};
  background: ${theme.warnBg};
  border: 1px solid ${theme.warnColor};
  border-left-width: 3px;
  border-radius: 8px;
}
/* 「内容零丢失」这类正向结论用绿色，别和警告混在一起 */
.pv-notice-ok {
  background: ${theme.okBg};
  border-color: ${theme.okColor};
}
/* 已知局限：中性提示，用蓝色区别于「有问题」的橙色 */
.pv-notice-info {
  background: ${theme.rowBg};
  border-color: ${theme.accent};
  color: ${theme.dim};
  font-size: 11.5px;
}
.pv-details { margin-top: 10px; font-size: 11.5px; color: ${theme.dim}; }
.pv-details summary { cursor: default; }

/* 自检清单 */
.pv-checks { border: 1px solid ${theme.border}; border-radius: 12px; background: ${theme.panel}; padding: 16px 18px; }
.pv-checks h2 { margin: 0 0 10px; font-size: 14px; color: ${theme.head}; }
.pv-checks ul { margin: 0; padding: 0; list-style: none; }
.pv-checks li { font: 12px/1.9 ui-monospace, Consolas, monospace; }
.pv-ok { color: ${theme.okColor}; }
.pv-bad { color: ${theme.warnColor}; }

/* 页脚 */
.pv-foot { margin-top: 22px; font-size: 11.5px; line-height: 1.8; color: ${theme.dim}; }
</style>
<style id="${STYLE_ID}">
/* ── 插件样式：直接来自 lib/styles.js 的 buildCSS()，一字未改 ── */
${css}
</style>
</head>
<body ${bodyAttrs}>
  <header class="pv-head">
    <h1>酒馆回话排版 · 预览 — <span class="pv-theme">${esc(theme.label)}主题</span></h1>
    <p class="pv-sub">
      生成时间 ${esc(stamp())} · 样例 ${SAMPLES.length} 段 · 用法
      <code>node scripts/preview.mjs</code> → <code>${esc(MAIN_NAME)}</code>（深色）+ <code>${esc(LIGHT_NAME)}</code>（浅色）
    </p>
    <p class="pv-sub">
      静态快照：CSS 全内联、无外部请求、无 &lt;script&gt;，可直接
      <code>chrome --headless --screenshot</code> 截。主题分支靠 body 属性切换：
      ${theme.darkAttr
        ? `body 带 <code>data-ds-dark-theme</code>（暗色分支）+ <code>${esc(SCOPE_ATTR)}</code>`
        : `body <strong>不带</strong> <code>data-ds-dark-theme</code>（亮色分支）+ <code>${esc(SCOPE_ATTR)}</code>`}
    </p>
  </header>

  <div class="pv-overview">
    ${cases.map(overviewCard).join('\n    ')}
  </div>

${cases.map(caseBlock).join('\n\n')}

  ${checksBlock()}

  <p class="pv-foot">
    左栏是原始 TRS 文本（等宽、未排版）；右栏是 <code>renderMessage(parseMessage(raw))</code> 的真实输出，外包 <code>.tt-root</code>。
    ${theme.darkAttr
      ? '本文件用于验证暗色：<code>body:where([data-dsh-tavern-render])</code> 的默认变量 + <code>--dsw-alias-*</code> 暗色取值。'
      : '本文件用于验证亮色：<code>body:where([data-dsh-tavern-render]):not([data-ds-dark-theme])</code> 分支 + <code>--dsw-alias-*</code> 亮色取值。'}
    插件变量本身未做任何覆写，颜色全部来自 <code>lib/styles.js</code>。
  </p>
</body>
</html>
`;
}

/* ─────────────────────────── 命令行 ─────────────────────────── */

function parseArgs(argv) {
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/preview.mjs [--out <path>]');
      console.log('  默认输出仓库根的 preview.html（深色）+ preview-light.html（浅色）');
      process.exit(0);
    } else if (arg.trim()) {
      console.error(`未知参数：${arg}（可用：--out <path>）`);
      process.exit(2);
    }
  }
  const main = out ? path.resolve(process.cwd(), out) : path.join(ROOT, 'preview.html');
  return main;
}

/** 由主文件名推浅色文件名：preview.html → preview-light.html；foo-dark.html → foo-light.html。 */
function lightPathFor(mainPath) {
  const dir = path.dirname(mainPath);
  const ext = path.extname(mainPath) || '.html';
  const base = path.basename(mainPath, path.extname(mainPath));
  const name = /-dark$/i.test(base) ? base.replace(/-dark$/i, '-light') : `${base}-light`;
  return path.join(dir, `${name}${ext}`);
}

const mainPath = parseArgs(process.argv.slice(2));
const lightPath = lightPathFor(mainPath);
const MAIN_NAME = path.relative(ROOT, mainPath) || mainPath;
const LIGHT_NAME = path.relative(ROOT, lightPath) || lightPath;

/* ────────────────────── 生成前的核对输出 ────────────────────── */

console.log('\n样例解析结果：');
for (const c of cases) {
  console.log(`\n  [${c.id}] ${c.title}`);

  // d 组：三段各自一条，分别打印 kind/syntax/summarize/接管判定/内容核对
  if (c.mode === 'tolerant' && Array.isArray(c.parts)) {
    for (const p of c.parts) {
      const lostNote = p.lost.length
        ? `丢失 ${p.lost.length} 个片段: ${p.lost.join(' / ')}`
        : `零丢失（${p.mustKeep.length} 个片段全在）`;
      console.log(`      ${p.id} 「${p.label}」`);
      console.log(`         kind=${p.kind}  syntax=${p.syntax}`);
      console.log(`         summarize: ${p.summary}`);
      console.log(`         客户端接管: ${p.takeover.yes ? '会' : '不会'} —— ${p.takeover.why}`);
      console.log(`         渲染 ${bytes(p.rendered)} 字节，${lostNote}`);
    }
    continue;
  }

  const html = String(c.rendered || '');
  const okRender =
    c.mode === 'plain'
      ? '按对照组处理（排版栏显示原文）'
      : html.trim()
        ? `渲染成功 ${bytes(html)} 字节`
        : '渲染为空 → 回退原文';
  console.log(`      kind=${c.kind}  syntax=${c.syntax}`);
  console.log(`      summarize: ${c.summary}`);
  console.log(`      客户端接管: ${c.takeover.yes ? '会' : '不会'} —— ${c.takeover.why}`);
  console.log(`      ${okRender}`);
}

/* ────────────────────── 写文件 ────────────────────── */

const css = buildCSS();
const pages = [
  { theme: THEMES.dark, file: mainPath, name: MAIN_NAME },
  { theme: THEMES.light, file: lightPath, name: LIGHT_NAME },
];

for (const p of pages) {
  const html = buildPage(p.theme, css);
  // 自包含兜底：产物里不能出现脚本或外链（否则 file:// 截图会受网络影响）
  if (/<script/i.test(html) || /<link\b/i.test(html) || /src\s*=\s*["']https?:/i.test(html)) {
    console.error(`✗ ${p.name} 里出现了 <script> / <link> / 外链，产物必须自包含`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, html, 'utf8');
  console.log(`\n写出 ${p.name}（${p.theme.label}，${bytes(html)} 字节）→ ${p.file}`);
}

console.log(`\n✓ 全部完成：${pages.map((p) => p.name).join(' + ')}`);
console.log('  截图（窗口高度要够，否则「你的选择」选项区会被截掉）：');
console.log('  chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1500,2600 \\');
console.log(`         --screenshot=preview-dark.png "file:///${mainPath.replace(/\\/g, '/')}"`);
console.log('         （浅色把文件名换成 preview-light.html / preview-light.png）');
