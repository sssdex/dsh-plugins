/**
 * Bundle 契约测试：验证客户端 bundle 符合 DSH 的 __ModuleLoader__ 协议，
 * 并且四道闸在贴近真实 DOM 的结构上确实生效。
 *
 * 这是最接近「装进 DSH 后实际发生什么」的一层测试。重点不是「能不能渲染」，
 * 而是 **「不该渲染的时候是不是真的一个字都没动」** —— 上一轮就是死在这里。
 *
 * DOM 结构照抄宿主真实层级（见 docs/SLOT-RESEARCH.md §4.2）：
 *
 *   div[data-conversation-session="sid"]
 *   └─ div[data-chat-flow]
 *      └─ div[data-chat-flow-kind="assistant-step"]
 *         └─ div[data-slot="conversation.chat.node"]        ← display:contents
 *            └─ div.xMeOpW_root
 *               └─ div.xMeOpW_body
 *                  ├─ div.zzzz_markdown[data-text-interaction-source]   ← 正文
 *                  └─ div[data-turn-process-inline]
 *                     └─ div.VJlF5q_root > div.thinkBody[data-text-interaction-source]
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { JSDOM } = require('D:\\DeepSeek-DSH\\apps\\dsh-tavern\\node_modules\\jsdom');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '..', 'lib', 'client.js');
const source = fs.readFileSync(BUNDLE, 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ── 1. 静态契约 ── */
console.log('\n[1] bundle 静态契约');
{
  check('使用 __ModuleLoader__.load', source.includes('window.__ModuleLoader__.load('));
  check('id 等于包名', /id:\s*'dsh-tavern-render'/.test(source));
  check('有 factory', /factory\s*\(/.test(source));
  check('无顶层 import', !/^\s*import\s/m.test(source));
  check('无顶层 export', !/^\s*export\s/m.test(source));
  check('包了 IIFE', /^\s*\(\(\)\s*=>\s*\{/m.test(source));
  check('内联了 parseMessage', source.includes('function parseMessage'));
  check('内联了 renderMessage', source.includes('function renderMessage'));
  check('内联了 buildCSS', source.includes('function buildCSS'));
  check('没有留下占位符', !source.includes('__INLINE_'));
  check('inject 含 sessions', /inject:\s*\[[^\]]*'sessions'/.test(source));
  check('白名单硬编码 tavern-play', source.includes("['tavern-play']"));
}

/* ── 2. 在 jsdom 里执行 bundle（不跑 apply） ── */
function makeDom(html) {
  return new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
}

function loadBundle(dom) {
  const win = dom.window;
  let registered = null;
  win.__ModuleLoader__ = { load(spec) { registered = spec; } };
  win.eval(source);
  if (!registered) throw new Error('bundle 没有调用 __ModuleLoader__.load');
  const exports = registered.factory(() => ({}));
  return { spec: registered, exports };
}

function bindGlobals(dom) {
  global.window = dom.window;
  global.document = dom.window.document;
  global.MutationObserver = dom.window.MutationObserver;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SAMPLE_TRS = `<scene>
<prose>
晨光从露台的玻璃门斜切进来。
"爸爸，早……啊❤"她转过身来，*耳朵先红了*。
"清韵做了早饭。那个……蛋有点焦，对不起。"
</prose>
<panel>
<info time="07:22 周六" place="家中厨房"/>
<status>
  <char name="清韵" affection=62 reason=18 mood="紧张又期待" outfit="浅棕围裙" body="微微发烫">
    心声：爸爸在看这边。
  </char>
  <char name="昕彤" affection=75 mood="黏人撒娇"/>
</status>
<chat time="07:20">
  <msg from="昕彤">爸爸起床了哦！</msg>
  <msg from="清韵">……蛋要凉了呢</msg>
</chat>
<choice>
  <opt>先喝牛奶</opt>
  <opt>把昕彤抱上吧台</opt>
</choice>
</panel>
</scene>`;

const SAMPLE_LEGACY = `<mainbody> 正文。
"对白一句。"她说。
"对白两句。"他又说。
<phone> 07:22 <Status> <清韵>62|18|心声|穿着<br> </Status> <choice>选项一|选项二</choice> </phone> </mainbody>`;

const SAMPLE_PLAIN = `我改好了，测试通过。

\`\`\`js
const x = parseMessage("chars");
\`\`\`

- 第一项
- 第二项

这里有个 * 通配符和一个 "引号字符串"。`;

/**
 * 造一条完整的助手消息 DOM（层级照抄宿主）。
 * @param {string} text 正文纯文本
 * @param {object} [opts]
 * @param {boolean} [opts.withThinking] 是否附带思考行
 * @param {string} [opts.groupPart] data-chat-group-part
 * @param {boolean} [opts.streaming] 是否带 data-streaming
 * @param {string} [opts.preset] 模拟的 agentPreset 值
 * @param {string} [opts.sessionId]
 * @param {number} [opts.extraTextNodes] 额外挂几个正文 markdown 容器（测多匹配放弃）
 */
function messageHtml(text, opts = {}) {
  const {
    withThinking = true,
    groupPart,
    streaming = false,
    sessionId = 'sid-1',
    extraTextNodes = 0,
  } = opts;

  const thinking = withThinking ? `
      <div data-turn-process-inline>
        <div class="VJlF5q_root" data-variant="think">
          <div class="VJlF5q_row">思考中……这里提到了 <scene> 和 "引号"</div>
          <div class="thinkBody" data-text-interaction-source="">展开的思考正文</div>
        </div>
      </div>` : '';

  const extra = Array.from({ length: extraTextNodes }, (_, i) =>
    `<div class="zzzz_markdown" data-text-interaction-source="">第二段正文 ${i}</div>`).join('');

  const groupAttr = groupPart === undefined ? '' : ` data-chat-group-part="${groupPart}"`;

  return `
  <div data-conversation-session="${sessionId}" data-conversation-region="chat">
    <div data-chat-flow="">
      <div class="flowItem" data-chat-flow-key="assistant-step" data-chat-node-key="assistant-step"${groupAttr}
           data-chat-flow-kind="assistant-step" data-chat-turn="1">
        <div data-slot="conversation.chat.node" style="display:contents">
          <div class="xMeOpW_root"${streaming ? ' data-streaming="1"' : ''}>
            <div class="xMeOpW_body">
              <div class="zzzz_markdown" data-text-interaction-source="">${esc(text)}</div>
              ${extra}
              ${thinking}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/** 假的 ctx.sessions：按 sessionId 返回固定 preset。 */
function fakeCtx(preset, cleanups = [], extra = {}) {
  return {
    sessions: {
      binding(sid) {
        return {
          session: {
            projections: {
              faceOf(name) {
                if (name !== 'agentPreset') throw new Error(`unexpected projection ${name}`);
                return { getSnapshot: () => preset };
              },
            },
          },
        };
      },
    },
    effect(fn) { cleanups.push(fn()); },
    ...extra,
  };
}

const wait = (dom, ms = 260) => new Promise((r) => dom.window.setTimeout(r, ms));

const bodyOf = (dom) => dom.window.document.querySelector('.xMeOpW_body');
const paintedOf = (dom) => dom.window.document.querySelector('.xMeOpW_body > [data-dsh-tavern-render]');

/* ── 2. 协议与解析（纯函数层） ── */
console.log('\n[2] bundle 在 jsdom 中执行');
{
  const dom = makeDom('');
  bindGlobals(dom);
  const { spec, exports } = loadBundle(dom);

  check('注册 id 正确', spec.id === 'dsh-tavern-render', spec.id);
  check('返回 inject', Array.isArray(exports.inject));
  check('inject 不含多余的 slots（本插件不注册槽位）', !exports.inject.includes('slots'));
  check('inject 含 sessions', exports.inject.includes('sessions'));
  check('返回 apply', typeof exports.apply === 'function');

  const t = exports.__test;
  const parsed = t.parseMessage(SAMPLE_TRS);
  check('TRS 解析为 trs', parsed.syntax === 'trs', parsed.syntax);
  check('2 个角色', parsed.blocks.find((b) => b.type === 'chars').chars.length === 2);

  const html = t.renderMessage(parsed);
  check('渲染出状态卡', html.includes('tt-char'));
  check('渲染出对白', html.includes('tt-speech'));
  check('渲染出选项', html.includes('tt-choice'));
}

/* ── 3. 闸 1：预设不在白名单 → 零改动 ── */
console.log('\n[3] 闸 1 预设白名单');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('standard', cleanups), {});
  await wait(dom);

  const body = bodyOf(dom);
  check('非酒馆预设：未接管', body.getAttribute('data-tt-done') === null);
  check('非酒馆预设：无排版节点', paintedOf(dom) === null);
  check('非酒馆预设：原文完整', body.textContent.includes('<scene>'));
  check('非酒馆预设：body 无作用域属性', !dom.window.document.body.hasAttribute('data-dsh-tavern-render'));

  for (const c of cleanups) c();
}

/* ── 4. 闸 1：拿不到预设 → 也不接管（新建会话等） ── */
console.log('\n[4] 闸 1 预设读不到时的保守行为');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  // 没有 sessions 服务
  exports.apply({ effect(fn) { cleanups.push(fn()); } }, {});
  await wait(dom);

  check('无 sessions 服务：未接管', bodyOf(dom).getAttribute('data-tt-done') === null);
  for (const c of cleanups) c();
}

/* ── 5. 白名单命中 → 正常渲染（TRS） ── */
console.log('\n[5] 白名单命中：TRS 渲染');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);

  const body = bodyOf(dom);
  check('已接管', body.getAttribute('data-tt-done') === '1');
  check('语法标记为 trs', body.getAttribute('data-tt-syntax') === 'trs');
  check('生成排版节点', paintedOf(dom) !== null);
  check('状态卡 2 个角色', body.querySelectorAll('.tt-char').length === 2);
  check('仪表盘渲染', body.querySelectorAll('.tt-gauge').length >= 2);
  check('聊天气泡 2 条', body.querySelectorAll('.tt-bubble').length === 2);
  check('选项 2 项', body.querySelectorAll('.tt-choice').length === 2);
  check('样式注入', !!dom.window.document.getElementById('dsh-tavern-render/styles'));
  check('body 作用域标记', dom.window.document.body.hasAttribute('data-dsh-tavern-render'));

  // ★ 关键：宿主原生节点一个都没被删
  const nativeNodes = body.querySelectorAll(':scope > :not([data-dsh-tavern-render])');
  check('原生正文节点仍在（未被删除）', nativeNodes.length >= 1, `实际 ${nativeNodes.length}`);
  check('原生正文文本仍可读出 <scene>', body.textContent.includes('<scene>'));
  check('原生思考行仍在', body.querySelector('.VJlF5q_root') !== null);

  for (const c of cleanups) c();
}

/* ── 6. ★ 思考过程绝不被接管（上一轮事故的回归测试） ── */
console.log('\n[6] 思考过程零改动（事故回归）');
{
  // 思考行自己也带 data-text-interaction-source，且内含 <scene> 与引号
  const thinkingTrap = `
    <scene><prose>"思考里的假对白"</prose>
      <panel><status><char name="假角色" affection=1/></status></panel>
    </scene>`;

  const dom = makeDom(messageHtml(thinkingTrap, { withThinking: true }));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);

  const doc = dom.window.document;
  const thinkBody = doc.querySelector('.thinkBody');
  const thinkRow = doc.querySelector('.VJlF5q_root');

  check('思考行未被标记', thinkBody.getAttribute('data-tt-done') === null);
  check('思考行内无排版节点', thinkRow.querySelector('[data-dsh-tavern-render]') === null);
  check('思考行原文完整', thinkBody.textContent.includes('展开的思考正文'));

  // 正文被接管了（因为确实是 TRS），但思考行没被连带
  check('正文正常接管（对照）', bodyOf(dom).getAttribute('data-tt-done') === '1');

  for (const c of cleanups) c();
}

/* ── 7. groupPart=reasoning 的 flowItem 整体跳过 ── */
console.log('\n[7] reasoning 分组跳过');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS, { withThinking: false, groupPart: 'reasoning' }));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);

  check('reasoning 分组未接管', bodyOf(dom).getAttribute('data-tt-done') === null);
  check('reasoning 分组无排版节点', paintedOf(dom) === null);

  for (const c of cleanups) c();
}

/* ── 8. 闸 3：多个正文容器 → 放弃 ── */
console.log('\n[8] 闸 3 多匹配放弃');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS, { extraTextNodes: 1 }));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);

  check('两个正文容器 → 不接管', bodyOf(dom).getAttribute('data-tt-done') === null);
  check('两个正文容器 → 无排版节点', paintedOf(dom) === null);

  for (const c of cleanups) c();
}

/* ── 9. 闸 4：loose 明确拒绝（上一轮误伤的根因） ── */
console.log('\n[9] 闸 4 拒绝 loose 兜底');
{
  const dom = makeDom(messageHtml(SAMPLE_PLAIN, { withThinking: false }));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  // 先确认这段确实会被解析成 loose —— 证明拒绝发生在客户端，不是解析器
  const parsed = exports.__test.parseMessage(SAMPLE_PLAIN);
  check('普通技术回复被解析为 loose（前置事实）', parsed.syntax === 'loose', parsed.syntax);
  check('isAcceptable 拒绝 loose', exports.__test.isAcceptable(parsed) === false);

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);

  const body = bodyOf(dom);
  check('普通回复未接管', body.getAttribute('data-tt-done') === null);
  check('普通回复无排版节点', paintedOf(dom) === null);
  check('普通回复内容保留', body.textContent.includes('测试通过'));

  for (const c of cleanups) c();
}

/* ── 10. 流式保护 ── */
console.log('\n[10] 流式期间不接管');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS, { streaming: true }));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);

  check('流式中未接管', bodyOf(dom).getAttribute('data-tt-done') === null);

  for (const c of cleanups) c();
}

/* ── 11. 旧格式兼容 ── */
console.log('\n[11] 旧格式兼容（legacy 仍接受）');
{
  const dom = makeDom(messageHtml(SAMPLE_LEGACY, { withThinking: false }));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);

  const body = bodyOf(dom);
  check('旧格式被接管', body.getAttribute('data-tt-done') === '1');
  check('语法标记为 legacy', body.getAttribute('data-tt-syntax') === 'legacy');
  check('旧状态行渲染', body.querySelectorAll('.tt-char').length === 1);
  check('旧选项渲染', body.querySelectorAll('.tt-choice').length === 2);

  for (const c of cleanups) c();
}

/* ── 12. 幂等 + 还原 + 卸载 ── */
console.log('\n[12] 幂等 / 还原 / 卸载');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);

  const body = bodyOf(dom);
  const snapshot = body.innerHTML;

  // 幂等：再扫一遍不应该多出第二个排版节点
  exports.__test.renderInto(
    { body, root: body.parentElement },
    { enabled: true, presets: ['tavern-play'], minSpeech: 1 },
    fakeCtx('tavern-play'),
  );
  check('重复处理幂等', body.innerHTML === snapshot);
  check('只有一个排版节点', body.querySelectorAll(':scope > [data-dsh-tavern-render]').length === 1);

  // 还原
  exports.__test.restoreBody(body);
  check('还原后无排版节点', body.querySelectorAll(':scope > [data-dsh-tavern-render]').length === 0);
  check('还原后摘掉标记', body.getAttribute('data-tt-done') === null);

  // 卸载
  for (const c of cleanups) c();
  check('卸载移除样式', !dom.window.document.getElementById('dsh-tavern-render/styles'));
  check('卸载移除作用域属性', !dom.window.document.body.hasAttribute('data-dsh-tavern-render'));
}

/* ── 13. 卸载时正在显示的消息会被还原成原文 ── */
console.log('\n[13] 卸载还原');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), {});
  await wait(dom);
  check('卸载前已接管', bodyOf(dom).getAttribute('data-tt-done') === '1');

  for (const c of cleanups) c();

  const body = bodyOf(dom);
  check('卸载后还原', body.getAttribute('data-tt-done') === null);
  check('卸载后无排版节点', paintedOf(dom) === null);
  check('卸载后原文仍在', body.textContent.includes('晨光从露台的玻璃门'));
}

/* ── 14. enabled:false 时不接管 ── */
console.log('\n[14] 开关关闭');
{
  const dom = makeDom(messageHtml(SAMPLE_TRS));
  bindGlobals(dom);
  const { exports } = loadBundle(dom);
  const cleanups = [];

  exports.apply(fakeCtx('tavern-play', cleanups), { enabled: false });
  await wait(dom);

  check('开关关闭未接管', bodyOf(dom).getAttribute('data-tt-done') === null);
  for (const c of cleanups) c();
}

console.log(`\n━━━ ${pass} 通过 / ${fail} 失败 ━━━`);
process.exit(fail === 0 ? 0 : 1);
