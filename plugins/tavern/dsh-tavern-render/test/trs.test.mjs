/**
 * TRS v1 规范语法测试。
 * 重点验证：**属性顺序打乱、字段缺失、属性自定义**，显示结果都不能错位。
 * 这是「不同模型输出不一样」的核心保障。
 */

import { parseMessage, summarize, parseAttrs, splitProse, scrubUnknownTags } from '../lib/parse.js';
import { renderMessage } from '../lib/render.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ── 1. 属性解析 ── */
console.log('\n[1] 属性解析');
{
  const { attrs, bare } = parseAttrs('name="清韵" affection=62 mood="紧张 又 期待" flag');
  check('带引号属性', attrs.name === '清韵');
  check('裸值属性', attrs.affection === '62');
  check('含空格引号值', attrs.mood === '紧张 又 期待');
  check('布尔属性', bare.includes('flag'));

  const q = parseAttrs("name='单引号' reason=18");
  check('单引号', q.attrs.name === '单引号');
  check('第二属性', q.attrs.reason === '18');
}

/* ── 2. 标准 TRS 消息 ── */
const TRS = `<scene>
<prose>
晨光从露台的玻璃门斜切进来。
"爸爸，早……啊❤"她转过身来，*两只手在围裙上蹭了两下*。
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
<feed source="推特">
  <post name="养女日常" handle="Petropavlovsk" stats="43k">
    周六早上！爸爸还在睡
    <note>图片：吧台上的煎蛋.jpg</note>
  </post>
</feed>
<list title="推荐">
  <item>咖啡套装买一送一</item>
  <item>真空睡裙新款上架</item>
</list>
<choice>
  <opt>先喝牛奶</opt>
  <opt>把昕彤抱上吧台</opt>
</choice>
</panel>
</scene>`;

console.log('\n[2] 标准 TRS');
{
  const p = parseMessage(TRS);
  check('识别为 trs', p.syntax === 'trs', p.syntax);
  check('结构化', p.kind === 'structured');
  console.log('   blocks:', summarize(p).join(' '));

  const prose = p.blocks.find((b) => b.type === 'prose');
  check('正文有对白', prose.segments.filter((s) => s.kind === 'speech').length === 2,
    String(prose.segments.filter((s) => s.kind === 'speech').length));
  check('正文有动作', prose.segments.filter((s) => s.kind === 'action').length === 1);
  check('正文有旁白', prose.segments.filter((s) => s.kind === 'narration').length >= 1);
  check('正文不含标签', !prose.segments.some((s) => s.text.includes('<')));

  const chars = p.blocks.find((b) => b.type === 'chars');
  check('两个角色', chars.chars.length === 2);
  check('角色名正确', chars.chars[0].name === '清韵');
  check('affection 有中文标签', chars.chars[0].fields.find((f) => f.key === 'affection').label === '好感');
  check('心声被提取', chars.chars[0].inner.includes('爸爸在看这边'));

  check('聊天 2 条', p.blocks.find((b) => b.type === 'wechat').messages.length === 2);
  check('动态 1 条', p.blocks.find((b) => b.type === 'social').accounts.length === 1);
  check('动态 note 提取', p.blocks.find((b) => b.type === 'social').accounts[0].append.includes('煎蛋.jpg'));
  check('列表 2 项', p.blocks.find((b) => b.type === 'list').items.length === 2);
  check('选项 2 项', p.blocks.find((b) => b.type === 'choices').items.length === 2);
  check('info 合并成一行', (p.blocks.find((b) => b.type === 'meta') || {}).value?.includes('时间 07:22'));
}

/* ── 3. 属性顺序打乱：绝不错位 ── */
console.log('\n[3] 属性乱序（关键）');
{
  const shuffled = `<scene><prose>"测试。"</prose><panel><status>
    <char mood="开心" name="甲" body="发烫" affection=30 outfit="裙子"/>
    <char body="冷汗" reason=90 name="乙"/>
  </status></panel></scene>`;
  const p = parseMessage(shuffled);
  const chars = p.blocks.find((b) => b.type === 'chars');
  const a = chars.chars[0];
  const b = chars.chars[1];
  check('乱序后角色名仍正确', a.name === '甲' && b.name === '乙');
  const get = (c, k) => (c.fields.find((f) => f.key === k) || {}).value;
  check('甲 affection', get(a, 'affection') === '30');
  check('甲 mood', get(a, 'mood') === '开心');
  check('甲 body', get(a, 'body') === '发烫');
  check('甲 outfit', get(a, 'outfit') === '裙子');
  check('乙 reason', get(b, 'reason') === '90');
  check('乙 没有 affection', get(b, 'affection') === undefined);
  check('缺字段不报错', b.fields.length === 2, String(b.fields.length));
}

/* ── 4. 自定义属性不会丢 ── */
console.log('\n[4] 自定义属性');
{
  const p = parseMessage(`<scene><prose>"嗯。"</prose><panel><status>
    <char name="丙" affection=10 stamina=40 灵力=88 自定义标记="临时"/>
  </status></panel></scene>`);
  const c = p.blocks.find((b) => b.type === 'chars').chars[0];
  const keys = c.fields.map((f) => f.key);
  check('未知属性保留', keys.includes('stamina') && keys.includes('灵力') && keys.includes('自定义标记'), keys.join(','));
  check('已知属性排前面', keys[0] === 'affection');
  check('未知属性无中文标签时用原名', c.fields.find((f) => f.key === 'stamina').label === '体力');
}

/* ── 5. 旧格式仍然兼容 ── */
console.log('\n[5] 旧格式兼容');
{
  const legacy = `<mainbody> 正文。
"对白一句。"她说。
"对白两句。"他又说。
<phone> 07:22 <Status> <清韵>62|18|心声|穿着<br> </Status> <choice>选项一|选项二</choice> </phone> </mainbody>`;
  const p = parseMessage(legacy);
  check('识别为 legacy', p.syntax === 'legacy', p.syntax);
  check('旧状态行解析', p.blocks.some((b) => b.type === 'status' && b.rows.length === 1));
  check('旧选项解析', p.blocks.find((b) => b.type === 'choices')?.items.length === 2);
}

/* ── 6. 解析失败必须不接管 ── */
console.log('\n[6] 不接管的情况');
{
  check('纯技术回复', parseMessage('改好了，运行测试通过。\n- 1\n- 2').kind === 'plain');
  check('空消息', parseMessage('').kind === 'plain');
  check('代码块', parseMessage('```js\nconst a = 1;\n```').kind === 'plain');
  check('无对白无动作的散文', parseMessage('今天天气不错，适合出门散步。').kind === 'plain');
  check('只有一句对白不足阈值', parseMessage('他说："好。"').kind === 'structured');
}

/* ── 7. prose 切分边界 ── */
console.log('\n[7] 正文切分');
{
  const segs = splitProse('他说："甲"然后走了。*叹气*');
  check('对白在前', segs[0].kind === 'narration');
  check('切出对白', segs.some((s) => s.kind === 'speech' && s.text === '甲'));
  check('切出动作', segs.some((s) => s.kind === 'action' && s.text === '叹气'));
  const segs2 = splitProse('“中文引号”和「直角」');
  check('中文双引号', segs2.some((s) => s.kind === 'speech' && s.text === '中文引号'));
  check('直角引号', segs2.some((s) => s.kind === 'speech' && s.text === '直角'));
}

/* ── 8. 回归：TRS 的 <panel> 里写位置式 <status> 不能吞内容 ── */
// 模型迁就旧语法时很常见（新旧混用）。上一版 parseTrs 里 <status> 只试 parseChars，
// 没有 <char> 就整块放弃 —— 心声、穿着全部消失。这是真丢内容。
console.log('\n[8] 回归：新旧语法混用的 <status>');
{
  const mixed = `<scene>
<prose>雨还没停。</prose>
<panel>
<status><清韵>62|18|心声内容在这里|米色长裙</status>
</panel>
</scene>`;
  const p = parseMessage(mixed);
  check('识别为 trs', p.syntax === 'trs', p.syntax);
  const status = p.blocks.find((b) => b.type === 'status');
  check('位置式 status 被回退解析（不吞内容）', status !== undefined && status.rows.length === 1,
    status ? String(status.rows.length) : 'block 不存在');
  check('心声没丢', status && status.rows[0].fields.some((f) => f.includes('心声内容')));
  check('穿着没丢', status && status.rows[0].fields.some((f) => f.includes('米色长裙')));

  // 正常 <char> 写法仍然走新路径，不该被回退影响
  const normal = parseMessage(`<scene><panel><status><char name="甲" affection=50/></status></panel></scene>`);
  check('正常 <char> 仍解析为 chars', normal.blocks.some((b) => b.type === 'chars'));
}

/* ── 9. 回归：<account1> 里多条账号要逐条拆开 ── */
// 上一版只取第一条，后面用 <br> 分隔的评论全落进 extra，
// 显示成一串带 <br> 的碎片。
console.log('\n[9] 回归：一个 <account1> 里的多条账号');
{
  const social = `<mainbody>正文。
"一。"甲说。
"二。"乙说。
<phone><twitter><account1>主帖君|MainHandle|43k|主帖正文
<Append>图片：a.jpg</Append>
评论甲|CommentA|这话我信了<br>评论乙|CommentB|太甜了<br></account1></twitter></phone></mainbody>`;
  const p = parseMessage(social);
  const s = p.blocks.find((b) => b.type === 'social');
  check('拆出 3 条账号', s && s.accounts.length === 3, s ? String(s.accounts.length) : '无 social block');
  check('主帖 stats 有值', s && s.accounts[0].stats === '43k', s && s.accounts[0].stats);
  check('主帖正文正确', s && s.accounts[0].text.includes('主帖正文'));
  check('评论甲正文不串到 stats', s && s.accounts[1].text === '这话我信了', s && s.accounts[1].text);
  check('评论甲 stats 为空', s && s.accounts[1].stats === '', s && s.accounts[1].stats);
  check('评论乙 handle 正确', s && s.accounts[2].handle === 'CommentB');
  check('没丢账号名', s && s.accounts.map((a) => a.name).join(',') === '主帖君,评论甲,评论乙',
    s && s.accounts.map((a) => a.name).join(','));
}

/* ── 10. 回归：<mainbody> 里嵌套 <phone> 不能把标签漏进正文 ── */
// 真实会话（fcc0a5b9）实测：模型这样写，旧版把 mainbody 整块当正文，
// <Status>/<twitter>/<adv> 全部以裸标签形式出现在排版后的正文里，
// 动态一条都出不来。
console.log('\n[10] 回归：mainbody 内嵌 phone');
{
  const nested = `<mainbody>
耳机里的电极贴着耳道轻轻一颤。
"好~今天继续来打老恶魔王哦——"她声音软软的。
你托着她的腰把她往上提了半寸。
<phone>
23:52|2025-06-15
<Status>
<清韵>96|78|心声文字|猫耳耳机，黑色丝袜|身体描述<br>
</Status>
<twitter>
虚拟偶像情报站|Vtuber_Info|126k|深夜直播中！这事有点犯规了|1720|740|9100<br>
半页无限连|SoulsBro|这呼吸频率绝对不正常www<br>
</twitter>
<wechat>
<time>23:48</time>
<昕彤>姐姐的声音都飘了w</昕彤>
</wechat>
<adv>
深夜必备能量饮料|电竞椅久坐不累
</adv>
<choice>松手让她坐下去|扶稳她的腰
</choice>
</phone>
</mainbody>`;
  const p = parseMessage(nested);
  check('识别为 legacy', p.syntax === 'legacy', p.syntax);

  // 核心断言：正文里不能残留任何标签
  const proseAll = p.blocks.filter((b) => b.type === 'prose')
    .flatMap((b) => b.segments.map((s) => s.text)).join('');
  const leaked = proseAll.match(/<\/?[A-Za-z][^>]*>/g) ?? [];
  check('正文无泄漏标签', leaked.length === 0, `泄漏: ${[...new Set(leaked)].join(' ')}`);

  // 各分区都要解析出来
  check('状态解析出', p.blocks.some((b) => b.type === 'status' && b.rows.length === 1));
  check('动态解析出 2 条', p.blocks.some((b) => b.type === 'social' && b.accounts.length === 2),
    String(p.blocks.find((b) => b.type === 'social')?.accounts.length));
  check('消息解析出', p.blocks.some((b) => b.type === 'wechat' && b.messages.length === 1));
  check('列表解析出', p.blocks.some((b) => b.type === 'list' && b.items.length === 2));
  check('选项解析出 2 项', p.blocks.some((b) => b.type === 'choices' && b.items.length === 2));

  // 正文文字还在
  check('正文文字保留', proseAll.includes('电极贴着耳道'));
}

/* ── 11. 回归：<twitter> 不带 <account> 包裹也要能解析 ── */
// 真实会话里模型直接把「名字|handle|正文」按 <br> 分行写，
// 旧版返回空数组 → 整块动态消失。
console.log('\n[11] 回归：裸行 twitter');
{
  const bare = `<mainbody>正文。
"一句对白。"她说。
"两句对白。"他说。
<phone><twitter>
虚拟偶像情报站|Vtuber_Info|126k|主帖正文在这里|1720|740|9100<br>
半页无限连|SoulsBro|评论内容甲<br>
深夜の绅士|NightGent|评论内容乙<br>
</twitter><choice>选项一|选项二</choice></phone></mainbody>`;
  const p = parseMessage(bare);
  const s = p.blocks.find((b) => b.type === 'social');
  check('裸行 twitter 解析出 3 条', s !== undefined && s.accounts.length === 3,
    s ? String(s.accounts.length) : '无 social block');
  if (s) {
    check('主帖 stats 正确', s.accounts[0].stats === '126k', s.accounts[0].stats);
    check('主帖正文正确', String(s.accounts[0].text).includes('主帖正文'));
    check('评论无 stats', s.accounts[1].stats === '');
    check('评论正文正确', String(s.accounts[1].text) === '评论内容甲', String(s.accounts[1].text));
    check('三条名字都在', s.accounts.map((a) => a.name).join(',') === '虚拟偶像情报站,半页无限连,深夜の绅士',
      s.accounts.map((a) => a.name).join(','));
  }
}

/* ── 12. <peachhub> 平台内容块 ── */
console.log('\n[12] peachhub 平台内容块');
{
  const hub = `<mainbody>正文。
"一句对白。"她说。
"两句对白。"他说。
<phone>
<choice>选项一|选项二</choice>
<peachhub>
<title>深夜直播回放</title>
<parameter>播放量|12.6万|好评率|96%</parameter>
<description>一段描述文字在这里。</description>
<tags>深夜|直播|ASMR</tags>
<comment>评论甲|评论乙|评论丙</comment>
</peachhub>
</phone></mainbody>`;
  const p = parseMessage(hub);
  const block = p.blocks.find((b) => b.type === 'peachhub');
  check('peachhub 被解析', block !== undefined);
  if (block) {
    check('标题正确', block.hub.title === '深夜直播回放', block.hub.title);
    check('参数成对拆开', block.hub.params.length === 2,
      JSON.stringify(block.hub.params));
    check('参数名值正确', block.hub.params[0].label === '播放量' && block.hub.params[0].value === '12.6万',
      JSON.stringify(block.hub.params[0]));
    check('描述正确', block.hub.description.includes('一段描述文字'));
    check('标签 3 个', block.hub.tags.length === 3, JSON.stringify(block.hub.tags));
    check('评论 3 条', block.hub.comments.length === 3, JSON.stringify(block.hub.comments));
  }
  const html = renderMessage(p);
  check('渲染出 tt-hub', html.includes('tt-hub'));
  check('渲染出标题', html.includes('深夜直播回放'));
  check('渲染出标签', html.includes('tt-hub-tag'));
}

/* ── 13. 未知标签：剥标签留文字并告警 ── */
console.log('\n[13] 未知标签兜底');
{
  const raw = '这里<uterus_list>一些内容</uterus_list>还有<自创标签>别的字</自创标签>和<scene>已知标签</scene>';
  const { text, unknown } = scrubUnknownTags(raw);
  check('未知标签被记录', unknown.includes('uterus_list') && unknown.includes('自创标签'),
    unknown.join(','));
  check('已知标签不误报', !unknown.includes('scene'));
  check('文字全部保留', text.includes('一些内容') && text.includes('别的字') && text.includes('已知标签'));
  check('标签被剥掉', !text.includes('<uterus_list>') && !text.includes('<自创标签>'));
}

console.log(`\n━━━ ${pass} 通过 / ${fail} 失败 ━━━`);
process.exit(fail === 0 ? 0 : 1);
