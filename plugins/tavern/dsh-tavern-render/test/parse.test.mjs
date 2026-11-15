import { parseMessage, summarize } from '../lib/parse.js';

const sample = `<mainbody> 晨光从露台的玻璃门斜切进来，在主卧的长绒地毯上划出一道浅金色的边。你还没完全睁开眼，楼下的动静就顺着楼梯爬了上来——油在锅里炸开的细响，碗碟轻轻碰撞，还有一个脚步在木地板上来回小跑，跑得一点也不掩饰。
厨房里第一个抬眼的是清韵。她穿着那件盖过膝盖的浅米色棉布裙，外面系了条围裙，黑发整整齐齐垂在腰后。她正把煎蛋翻过来，听见脚步声就一直盯着锅，耳朵先红了。 "爸爸，早……啊❤"她把铲子放下，转过身来，两只手在围裙上无意义地蹭了两下，"清韵做了早饭。那个……蛋有点焦，对不起。" 她说到一半忽然停住，膝盖轻轻并了一下，眼睛眨得慢了半拍——大概是围裙的带子在腰后勒得紧了。

"焦的才香哦！"昕彤从吧台那边蹦起来，金色侧马尾一甩，赤着脚就扑到你身上，一件宽大的白衬衫在她身上当裙子穿，扣子只扣了两颗，露出来的小肚子直接贴在你的手臂上。"爸爸昨天回来好晚，彤彤等到都快睡着了。"她仰起脸，蓝眼睛眨得很慢，语气听起来是抱怨，指尖却已经在往你腰侧探。 "所以待会儿要好好补偿人家哦❤"

吧台后面的月绮把牛奶杯推过来，笑眯眯的，脚在凳子下面一晃一晃。"老公大人，别理彤彤，先尝尝这个。"她托着下巴，红眼睛弯成细细一线，"昨天人家挤的——最新的。" 杯子在台面上滑到你手边，环着杯沿的，是一层薄薄的水汽。

<phone> 07:22|2025-04-12 周六 <Status> <清韵>62|18|爸爸在看这边❤围裙在腰上勒得紧紧的……清韵好奇怪，明明只是做早饭|米色棉布长裙，外面系着浅棕色围裙，赤足踩着棉拖鞋，头发绑在脑后|隔着布料微微发烫，贴着内裤的一小片已经湿了|菊穴紧闭|2yn2gf.jpg|la8k07.jpg|2yn2gf.jpg<br> <昕彤>75|12|爸爸的手好暖哦❤可是要是不主动一点，爸爸肯定又先去看姐姐了|白衬衫当裙子穿，只扣两颗扣子，赤脚，金发侧马尾，里面什么都没穿|小穴还干着，但已经开始一跳一跳|菊穴干净，等爸爸检查|tumbn9.gif|la8k07.jpg|2yn2gf.jpg<br> <月绮>85|30|老公大人会先喝谁的牛奶呢❤要是不先喝人家的，可要罚哦|轻薄吊带睡裙，真空，赤足踩在凳脚上，尾巴收在体内|小穴含着尾巴尖端，温热湿润|菊穴紧闭|brknum.jpg|a1bff2.gif|2yn2gf.jpg<br> </Status> <twitter> <account1> 养女日常|Petropavlovsk|43k|周六早上！爸爸还在睡，彤彤已经做完早饭了哦（其实是姐姐做的）(；´Д\`A #日常 #周六 #早餐 <Append> 图片1：吧台上的煎蛋.jpg 盘子里摆着两颗略微焦边的煎蛋，旁边是两只小手比着V。 </Append> #家庭 #早晨 #女儿 #可爱|920|340|2100<br> 草莓味小甜心|StrawberrySweet|姐姐做的好吃！彤彤偷懒了吧www<br> 单推昕彤喵|TongtongOnly|爸爸视角？太甜了太甜了<br> 只想守护彤彤的笑容|ProtectTongtong|焦的才香，这话我信了<br> </account1> </twitter> <wechat> <time>07:20</time> <昕彤>爸爸起床了哦！快下来快下来！</昕彤> <月绮>人家今天想被老公大人先叫名字❤</月绮> <清韵>……蛋要凉了呢</清韵> </wechat> <adv> 周六限时：家用手冲咖啡套装，买一送一|真空睡裙新款上架，薄如蝉翼，一夜好眠|最新款人体工学椅，久坐不累，支撑完美|机动战士高达UC纪元新作预告，吉翁万岁！ </adv> <bilibili> 未开播|无<br> 无<br> 周六都不开播吗|Seiyun酱是不是在睡懒觉|等等看今晚吧|听说深夜档会有惊喜 </bilibili> <choice>先喝月绮递来的牛奶，再坐下吃早饭|把在背后往你身上贴的昕彤抱上吧台|让清韵把围裙解下来，看看她到底怎么了|把三人都赶去洗漱，先按日常作息来|问月绮这杯"牛奶"到底是什么</choice> </phone> </mainbody>`;

const parsed = parseMessage(sample);
console.log('kind:', parsed.kind);
console.log('blocks:', summarize(parsed).join(' '));
console.log('');
for (const b of parsed.blocks) {
  if (b.type === 'prose') {
    const counts = {};
    for (const s of b.segments) counts[s.kind] = (counts[s.kind] || 0) + 1;
    console.log(`[prose ${b.origin}] ${JSON.stringify(counts)}`);
    const speech = b.segments.filter((s) => s.kind === 'speech').map((s) => s.text);
    console.log('   对白:', speech.slice(0, 6).join(' / '));
  } else if (b.type === 'status') {
    console.log('[status]');
    for (const r of b.rows) console.log('   ', r.name, '→', r.fields.length, '字段:', r.fields.slice(0, 4));
  } else if (b.type === 'social') {
    console.log('[social]');
    for (const a of b.accounts) console.log('   ', a.name, '|', a.handle, '|', a.stats, '|', a.text.slice(0, 20), '| append:', a.append.slice(0, 18));
  } else if (b.type === 'wechat') {
    console.log('[wechat] time=', b.time, b.messages.map((m) => `${m.from}:${m.text}`).join(' ; '));
  } else if (b.type === 'choices') {
    console.log('[choices]', b.items.length, b.items.map((s) => s.slice(0, 12)));
  } else if (b.type === 'list') {
    console.log(`[list ${b.variant}]`, b.items.length, b.items.slice(0, 3));
  } else {
    console.log('[', b.type, ']', JSON.stringify(b).slice(0, 120));
  }
}

// 兜底：无标签老预设
const loose = `她抬起眼睛，看着你。\n"你来了。"她轻声说。\n*她的手指在桌沿敲了两下。*\n窗外开始下雨。`;
const p2 = parseMessage(loose);
console.log('\n--- loose ---', p2.kind, summarize(p2).join(' '));
console.log(p2.blocks[0]?.segments.map((s) => `${s.kind}:${s.text}`).join(' | '));

// 兜底：纯技术回复必须原样不动
const plain = '我把文件写到了 `D:\\x\\a.js`，然后运行了测试。\n\n- 第一项\n- 第二项\n\n| a | b |\n|---|---|\n| 1 | 2 |';
const p3 = parseMessage(plain);
console.log('\n--- plain ---', p3.kind, 'blocks:', p3.blocks.length);
