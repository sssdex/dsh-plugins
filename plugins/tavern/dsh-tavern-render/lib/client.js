/**
 * dsh-tavern-render —— DSH 客户端 bundle（浏览器侧）。
 *
 * 加载契约（务必保持）：
 *   window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名，
 *   factory 返回 { inject, apply }。宿主把多个插件的源码拼进同一个 <script>，
 *   所以整个 bundle 包一层 IIFE，避免顶层 const 泄漏到全局词法作用域。
 *
 * 浏览器里没有 import 相对路径的能力（不会被当成 ES 模块），所以解析器、
 * 渲染器、样式表由 build.mjs 内联进本文件。改那三个文件的源码后运行：
 *   node scripts/build.mjs
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么是「读 DOM 再另画一层」而不是「用 slot 自己渲染正文」
 * ═══════════════════════════════════════════════════════════════════════
 * 详见 docs/SLOT-RESEARCH.md。结论：
 *   · 助手正文由内部 AssistantMarkdown 渲染，宿主没暴露「替换正文渲染」的 slot；
 *   · 唯一能拿到渲染权的路是抢注 keyed slot `assistant-step`（priority: -1 可顶掉），
 *     但那要自己重写 reasoning 折叠 / 工具卡片 / 图片槽 / assistant-actions / 流式策略，
 *     而 AssistantMarkdown 没有对外导出，复用不了 —— 代价不可接受；
 *   · 正文纯文本其实拿得到（props.node.data.blocks），所以「只能读 DOM」不准确，
 *     准确说法是「有数据、没渲染权」。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 上一轮为什么出事故，这一轮怎么堵（四道闸）
 * ═══════════════════════════════════════════════════════════════════════
 * 坑 1：用 CSS Module 类名指纹（<hash>_root + <hash>_body）找正文容器。
 *       该命名在 DSH 里不唯一，至少 8 个组件共用，其中包含思考过程容器
 *       → 思考文本被当酒馆回话重排。
 * 坑 2：「有引号/星号就当正文」的宽松兜底 → 普通技术回复被误伤。
 * 坑 3：预设约束写成绝对律 → 模型在编程任务里把代码塞进 <scene>。
 *
 * 这一轮的闸（按执行顺序，任何一关不过就彻底不接管）：
 *   闸 1  预设白名单：会话的 agentPreset 不在白名单 → 什么都不做。
 *   闸 2  锚点：只在 [data-chat-flow-kind="assistant-step"] 内工作，
 *        排除 [data-chat-group-part="reasoning"] 与 [data-turn-process-inline] 子树。
 *        全部用宿主自己的业务语义属性，不用构建哈希类名。
 *   闸 3  唯一性：正文 markdown 容器必须恰好 1 个，且能确认落在 _root > _body 里；
 *        0 个或多个一律放弃。
 *   闸 4  严格解析：只接受 syntax === 'trs' 或 'legacy'，
 *        **明确拒绝 'loose'**（「有引号就当正文」的兜底已从根上不要）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 最关键的改动：不覆盖宿主 DOM，只加一层
 * ═══════════════════════════════════════════════════════════════════════
 * 上一轮用 `body.innerHTML = html` 改写宿主节点，原文另存字符串以便还原。
 * 这种写法有两个根本缺陷：破坏 React 管理的节点树；一旦保存/还原环节出错，
 * 用户的内容就真没了。
 *
 * 现在改成**纯叠加**：
 *   · 给 `_body` 打一个标记 data-tt-body="1"；
 *   · 把排版结果作为**新节点追加**到 `_body` 末尾（React 自己的子节点一个没碰）；
 *   · 用一段 CSS 把 `_body` 里「非本插件节点」的子元素 display:none。
 * 还原 = 删掉我们那个节点 + 去掉标记，宿主的 DOM 从头到尾没被改写过，
 * 所以**任何情况下都不可能吞内容**。
 */
(() => {
  window.__ModuleLoader__.load({
    id: 'dsh-tavern-render',
    factory(require) {
      /* ===================== 内联：parse.js ===================== */
      /* ---- 内联 parse.js ---- */
const { esc, scrubUnknownTags, parseAttrs, splitProse, parseChars, parseStatusRows, classifyStatusField, parseChat, parseFeed, parseListItems, parseOptions, parseInfo, parsePeachhub, parseWechat, parseChoices, parseLines, parseSocial, parseMessage, parseTrs, parsePhone, parseLoose, summarize } = (() => {
/**
 * 酒馆回话解析器（纯函数，无 DOM、无副作用）。
 *
 * 支持两代语法：
 *   A. 规范语法 TRS v1（推荐，见 docs/SYNTAX.md）：
 *      <scene><prose>…</prose><panel>
 *        <status><char name="清韵" affection=62 reason=18 mood="紧张"/></status>
 *        <chat><msg from="昕彤">…</msg></chat>
 *        <feed><post name="…" handle="…">…<note>…</note></post></feed>
 *        <list><item>…</item></list>
 *        <choice><opt>…</opt></choice>
 *        <info time="…" place="…"/>
 *      </panel></scene>
 *   B. 旧版兼容（网上现成酒馆预设）：
 *      <mainbody>…</mainbody> / <phone> 07:22 <Status><清韵>62|18|…<br></Status>
 *        <twitter><account1>…</account1></twitter> <wechat> <adv> <choice>
 *
 * 设计原则：
 *   1. 绝不抛异常：任何看不懂的东西原样保留（raw），消息永不丢内容。
 *   2. 命名属性优先：新语法每个值自带名字，顺序无关、可缺省。
 *   3. 位置式仅作旧格式兜底，且只在旧标签里启用。
 */

/* ─────────────────────────── 通用工具 ─────────────────────────── */

/** 转义为 HTML 文本。 */
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 折叠空白：合并多余空行（模型常连发两三个换行，会把正文撑出大片留白）。 */
function norm(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 去标签后的纯文本。 */
function stripTags(text) {
  return String(text ?? '').replace(/<[^>]*>/g, '');
}

/**
 * 我们已经认识的标签。任何不在这个表里的 `<xxx>` 出现在正文中，
 * 都说明模型又发明了新格式 —— 按「剥标签、留文字」处理，并记进 unknownTags。
 */
const KNOWN_TAGS = new Set([
  // TRS v1
  'scene', 'prose', 'panel', 'status', 'char', 'chat', 'msg', 'feed', 'post', 'note',
  'list', 'item', 'choice', 'opt', 'info', 'peachhub',
  // peachhub 子字段
  'title', 'parameter', 'description', 'tags', 'comment',
  // 旧格式
  'mainbody', 'phone', 'twitter', 'wechat', 'adv', 'bilibili', 'time', 'append',
  // 常见 HTML / 排错用
  'br', 'b', 'i', 'em', 'strong', 'p', 'div', 'span', 'script', 'style',
]);

/**
 * 找出正文里残留的未知标签，并把它们剥掉（只留文字）。
 *
 * 决策依据（主人 2026-11-12 决定）：遇到不认识的新标签，
 * **剥掉标签保留文字 + 告警**，绝不整块丢弃内容。
 *
 * @param {string} text 已剥过一次标签的文本
 * @returns {{text:string, unknown:string[]}}
 */
function scrubUnknownTags(text) {
  const unknown = [];
  // 标签名允许中文：模型常自创 <心情> <状态> 这类中文标签。
  // 用 \p{L} 覆盖拉丁与 CJK。
  // 注意不能用 \b 收尾 —— JS 的 \b 只认 ASCII 单词字符，中文标签名后面永远不构成边界，
  // 会导致 <自创标签> 这种整个漏掉。改成显式 lookahead：标签名后必须是空白/斜杠/右尖括号。
  const out = String(text ?? '').replace(/<\/?([\p{L}_][\p{L}\p{N}_-]*)(?=[\s/>])[^>]*>/gu, (whole, name) => {
    const lower = name.toLowerCase();
    if (!KNOWN_TAGS.has(lower)) {
      if (!unknown.includes(lower)) unknown.push(lower);
      console.warn(`[dsh-tavern-render] 未知标签 <${name}>，已剥掉标签保留文字`);
    }
    return '';
  });
  return { text: out, unknown };
}

/**
 * 解析一个标签的属性串，支持 `name="a b"` / `name='a'` / `name=a` / `flag`。
 * 属性名允许 Unicode（模型的属性名常写中文，如 灵力=88），不能只认 ASCII。
 * @param {string} source 属性部分
 * @returns {{attrs:Object<string,string>, bare:string[]}}
 */
function parseAttrs(source) {
  const attrs = {};
  const bare = [];
  const re = /([\p{L}_][\p{L}\p{N}_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu;
  let m;
  while ((m = re.exec(String(source ?? ''))) !== null) {
    const key = m[1];
    const raw = m[2] ?? m[3] ?? m[4];
    if (raw === undefined) {
      bare.push(key);
    } else {
      attrs[key] = raw.trim();
    }
  }
  return { attrs, bare };
}

/**
 * 扫描开始标签：正确处理属性值里的 `>` 与引号。
 * 单条正则的 `[^>]*` 遇到 `mood="a>b"` 这类值会提前截断，所以手工扫。
 */
function scanOpenTag(source, from, tagName) {
  const re = new RegExp(`<${tagName}\\b`, 'gi');
  re.lastIndex = from;
  const m = re.exec(source);
  if (!m) return null;
  let i = m.index + m[0].length;
  let quote = '';
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { start: m.index, attrSource: source.slice(m.index + m[0].length, i), openEnd: i + 1 };
    }
    i += 1;
  }
  return null;
}

/**
 * 取所有指定标签的内容。
 * 用「扫描开始标签 → 找对应结束标签」，而不是单条正则：
 * 属性值可能含 `>`，正则会提前截断；这样也能正确跳过内层同名标签。
 */
function eachTag(source, tag, callback) {
  const text = String(source ?? '');
  const lower = text.toLowerCase();
  const out = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = scanOpenTag(text, cursor, tag);
    if (!open) break;

    // 自闭合标签 <char ... />：没有结束标签，正文为空。
    // 不处理它会导致后面所有同名标签被整块跳过（自闭合标签常出现在末位）。
    const selfClosed = /\/\s*$/.test(open.attrSource);
    if (selfClosed) {
      const parsed = parseAttrs(open.attrSource.replace(/\/\s*$/, ''));
      const value = callback ? callback('', parsed, open.start) : '';
      if (value !== undefined && value !== null) out.push(value);
      cursor = open.openEnd;
      continue;
    }

    const closeAt = lower.indexOf(`</${tag}`, open.openEnd);
    if (closeAt < 0) {
      // 有开始没结束：当成到结尾为止，宁可显示也不要吞掉内容
      const body = text.slice(open.openEnd);
      const parsed = parseAttrs(open.attrSource);
      const value = callback ? callback(body, parsed, open.start) : body;
      if (value !== undefined && value !== null) out.push(value);
      break;
    }
    const closeEnd = text.indexOf('>', closeAt);
    if (closeEnd < 0) break;

    const body = text.slice(open.openEnd, closeAt);
    const parsed = parseAttrs(open.attrSource);
    const value = callback ? callback(body, parsed, open.start) : body;
    if (value !== undefined && value !== null) out.push(value);
    cursor = closeEnd + 1;
  }
  return out;
}

/** 取第一个指定标签。 */
function firstTag(source, tag) {
  const values = eachTag(source, tag, (body, parsed, start) => ({ body, ...parsed, start }));
  return values.length > 0 ? values[0] : null;
}

/** 取自闭合标签 `<info ... />`。 */
function selfClosing(source, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*?)\\/\\s*>`, 'i');
  const m = re.exec(String(source ?? ''));
  if (!m) return null;
  return { ...parseAttrs(m[1]), start: m.index, end: m.index + m[0].length };
}

/* ─────────────────────────── 正文：旁白 / 对白 / 动作 ─────────────────────────── */

const QUOTE_PAIRS = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
];

/**
 * 把一段正文切成 旁白(narration) / 对白(speech) / 动作(action)。
 * 对白 = 成对引号；动作 = *星号* 包裹。
 */
function splitProse(text) {
  const segments = [];
  const push = (kind, value) => {
    if (!value) return;
    if (!value.trim()) return;
    segments.push({ kind, text: value });
  };

  let index = 0;
  const length = text.length;

  const nextQuote = (from) => {
    for (let i = from; i < length; i += 1) {
      for (const [open, close] of QUOTE_PAIRS) {
        if (text.startsWith(open, i)) {
          const end = text.indexOf(close, i + open.length);
          if (end > i + open.length) {
            return { start: i, end: end + close.length, inner: text.slice(i + open.length, end) };
          }
        }
      }
    }
    return null;
  };

  const nextAction = (from) => {
    const start = text.indexOf('*', from);
    if (start < 0) return null;
    const end = text.indexOf('*', start + 1);
    if (end <= start + 1) return null;
    return { start, end: end + 1, inner: text.slice(start + 1, end) };
  };

  while (index < length) {
    const q = nextQuote(index);
    const a = nextAction(index);

    let pick = null;
    if (q && a) pick = q.start <= a.start ? { type: 'speech', ...q } : { type: 'action', ...a };
    else if (q) pick = { type: 'speech', ...q };
    else if (a) pick = { type: 'action', ...a };

    if (!pick) {
      push('narration', text.slice(index));
      break;
    }
    if (pick.start > index) push('narration', text.slice(index, pick.start));
    push(pick.type === 'speech' ? 'speech' : 'action', pick.inner);
    index = pick.end;
  }

  return segments;
}

/* ─────────────────────────── 新语法：状态 ─────────────────────────── */

/** 属性名到「显示顺序 + 语义」的映射（新语法用）。 */
const CHAR_FIELD_ORDER = [
  'affection', 'reason', 'mood', 'outfit', 'body', 'place', 'flag',
];

/** 属性名 → 中文小标签（用于非数值属性）。 */
const CHAR_FIELD_LABEL = {
  affection: '好感', reason: '理性', mood: '心情', outfit: '穿着',
  body: '身体', place: '位置', flag: '状态', stamina: '体力',
  lust: '情欲', trust: '信任', hp: '生命', mp: '魔力',
};

/** 解析新语法 `<status>` 里的 `<char>`。 */
function parseChars(body) {
  const chars = [];
  eachTag(body, 'char', (inner, parsed) => {
    const attrs = parsed.attrs || {};
    const name = attrs.name || '';
    // 属性按已知顺序排前面，其余按出现顺序排后面 —— 顺序无关，不会错位
    const known = CHAR_FIELD_ORDER.filter((k) => attrs[k] !== undefined);
    const rest = Object.keys(attrs).filter((k) => k !== 'name' && !known.includes(k));
    const fields = [...known, ...rest].map((key) => ({
      key,
      label: CHAR_FIELD_LABEL[key] || key,
      value: attrs[key],
      known: CHAR_FIELD_LABEL[key] !== undefined,
    }));
    chars.push({ name, fields, inner: norm(stripTags(inner)) });
    return null;
  });
  return chars;
}

/* ─────────────────────────── 旧语法：位置式状态 ─────────────────────────── */

/** 旧格式状态行：`名字` + `|` 分隔字段（顺序靠猜，仅作兼容）。 */
function parseStatusRows(body) {
  const rows = [];
  const chunks = String(body ?? '')
    .split(/<br\s*\/?>|\n/gi)
    .map((s) => norm(s))
    .filter(Boolean);

  for (const chunk of chunks) {
    const m = /^<([^<>]{1,24})>\s*([\s\S]*)$/.exec(chunk);
    const name = m ? m[1].trim() : '';
    const rest = m ? m[2] : chunk;
    const fields = rest.split('|').map((s) => s.trim());
    if (fields.length < 2 && !name) continue;
    rows.push({ name, fields });
  }
  return rows;
}

/** 旧格式字段语义猜测。 */
function classifyStatusField(value, index) {
  const text = String(value ?? '').trim();
  if (/^\d{1,3}$/.test(text)) {
    const n = Number(text);
    if (index <= 1) return { kind: 'gauge', value: n };
    return { kind: 'number', value: n };
  }
  if (/\.(jpg|jpeg|png|gif|webp)\b/i.test(text)) return { kind: 'media' };
  if (text.length <= 12 && !/[，。！？、]/.test(text)) return { kind: 'tag' };
  return { kind: 'text' };
}

/* ─────────────────────────── 新语法：聊天 / 动态 / 列表 / 选项 ─────────────────────────── */

function parseChat(body) {
  const messages = [];
  eachTag(body, 'msg', (inner, parsed) => {
    const text = norm(stripTags(inner));
    if (!text) return null;
    messages.push({ from: parsed.attrs?.from || '', text });
    return null;
  });
  return messages;
}

function parseFeed(body) {
  const posts = [];
  const source = firstTag(body, 'feed')?.attrs?.source || '';
  eachTag(body, 'post', (inner, parsed) => {
    const note = firstTag(inner, 'note');
    const noteText = note ? norm(stripTags(note.body)) : '';
    const text = norm(stripTags(note ? inner.replace(note.raw || '', '') : inner));
    const attrs = parsed.attrs || {};
    posts.push({
      name: attrs.name || '',
      handle: attrs.handle || '',
      stats: attrs.stats || '',
      text: note ? norm(stripTags(inner)).replace(noteText, '').trim() : text,
      append: noteText,
      extra: [],
    });
    return null;
  });
  return { source, posts };
}

function parseListItems(body) {
  return eachTag(body, 'item', (inner) => norm(stripTags(inner)) || null);
}

function parseOptions(body) {
  return eachTag(body, 'opt', (inner) => norm(stripTags(inner)) || null);
}

function parseInfo(body) {
  // <info .../> 与 <info ...>…</info> 两种写法都收
  const list = eachTag(body, 'info', (inner, parsed) => parsed);
  if (list.length > 0 && Object.keys(list[0].attrs || {}).length > 0) {
    return { label: '场景', fields: list[0] };
  }
  return null;
}

/**
 * 平台内容块 `<peachhub>`（某些角色卡自定义的「上传作品」面板）。
 *
 * 结构是固定的：
 *   <peachhub>
 *     <title>标题</title>
 *     <parameter>播放量|好评率</parameter>
 *     <description>描述</description>
 *     <tags>tag1|tag2</tags>
 *     <comment>评论1|评论2</comment>
 *   </peachhub>
 *
 * 字段名固定、含义明确，所以可以安全地结构化成卡片。
 * 未知的子标签按「剥标签留文字」处理，绝不丢内容。
 */
function parsePeachhub(body) {
  const pick = (tag) => {
    const hit = firstTag(body, tag);
    return hit ? norm(stripTags(hit.body)) : '';
  };
  const title = pick('title');
  const rawParams = pick('parameter');
  const description = pick('description');
  const rawTags = pick('tags');
  const rawComments = pick('comment');

  // 「播放量|好评率」这种是「字段名|字段值」成对出现，也可能只有值。
  const paramParts = rawParams.split('|').map((s) => s.trim()).filter(Boolean);
  const params = [];
  if (paramParts.length >= 2 && paramParts.length % 2 === 0) {
    for (let i = 0; i < paramParts.length; i += 2) {
      params.push({ label: paramParts[i], value: paramParts[i + 1] });
    }
  } else if (paramParts.length > 0) {
    params.push({ label: '', value: paramParts.join(' · ') });
  }

  const splitAll = (s) => s.split(/[|｜]/).map((x) => x.trim()).filter(Boolean);
  const tags = splitAll(rawTags);
  const comments = rawComments
    .split(/[|｜]|<br\s*\/?>|\n/gi)
    .map((s) => norm(s))
    .filter(Boolean);

  // 兜底：如果上面全都没取到，就把整块剥标签后的文字塞进 description，不丢内容
  const isEmpty = !title && params.length === 0 && !description && tags.length === 0 && comments.length === 0;
  const fallback = isEmpty ? norm(stripTags(body)) : '';

  return { title, params, description: description || fallback, tags, comments };
}

/* ─────────────────────────── 旧语法：phone 子块 ─────────────────────────── */

function parseWechat(body) {
  const timeMatch = /<time>([\s\S]*?)<\/time>/i.exec(body);
  const time = timeMatch ? norm(timeMatch[1]) : '';
  const rest = timeMatch ? body.replace(timeMatch[0], '') : body;
  const messages = [];
  const re = /<([^<>/]{1,24})>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    const text = norm(m[2]);
    if (!text) continue;
    messages.push({ from: m[1].trim(), text });
  }
  return { time, messages };
}

function parseChoices(body) {
  return String(body ?? '')
    .split(/<br\s*\/?>|\n|\|/gi)
    .map((s) => norm(s))
    .filter(Boolean);
}

function parseLines(body) {
  return String(body ?? '')
    .split(/<br\s*\/?>|\n|\|/gi)
    .map((s) => norm(s))
    .filter(Boolean);
}

/**
 * 像不像一个互动计数：`43k`、`920`、`2.1万`、`1,234`。
 * 用来区分「主帖的 stats 位」和「评论行没有 stats」两种形状。
 */
const LOOKS_LIKE_STATS = /^[\d.,]+\s*[kKmM万wW]?$/;

function parseSocial(body) {
  const accounts = [];

  /** 解析一段「行」为账号/评论；不是该形状就返回 null。 */
  const parseRow = (chunk, primary) => {
    const appendMatch = /<Append>([\s\S]*?)<\/Append>/i.exec(chunk);
    const withoutAppend = appendMatch ? chunk.replace(appendMatch[0], '') : chunk;
    const parts = withoutAppend.split('|').map((s) => s.trim());
    // 不是「名字|handle|…」形状的行，返回 null 交给调用方兜底。
    if (parts.length < 3) return null;
    // 主帖是「名字|handle|stats|正文」，评论/转推只有「名字|handle|正文」。
    // 第三段是不是 stats，看它像不像计数（43k / 920 / 2.1万），别硬按位置切。
    const hasStats = parts.length >= 4 || LOOKS_LIKE_STATS.test(parts[2] ?? '');
    return {
      name: parts[0] ?? '',
      handle: parts[1] ?? '',
      stats: hasStats ? (parts[2] ?? '') : '',
      text: hasStats ? (parts[3] ?? '') : (parts[2] ?? ''),
      extra: parts.slice(hasStats ? 4 : 3),
      append: appendMatch ? norm(appendMatch[1]) : '',
      primary,
    };
  };

  /** 一个 <accountN> 块内可能有多条（<br> 分隔）：第一条是主帖，其余是评论。 */
  const pushBlock = (inner) => {
    const chunks = inner.split(/<br\s*\/?>|\n/gi).map((s) => s.trim()).filter(Boolean);
    let first = true;
    for (const chunk of chunks) {
      const row = parseRow(chunk, first);
      if (row) {
        accounts.push(row);
        first = false;
      } else if (accounts.length > 0) {
        // 不是标准行：并进上一条的 extra，绝不丢内容。
        accounts[accounts.length - 1].extra.push(norm(stripTags(chunk)));
      }
    }
  };

  const re = /<account(\d+)>([\s\S]*?)<\/account\1>/gi;
  let m;
  let last = 0;
  let matched = false;
  while ((m = re.exec(body)) !== null) {
    matched = true;
    // 包裹块之前的裸内容也要认（模型常常只给第一行套 <account>，其余裸写）。
    if (m.index > last) pushBlock(body.slice(last, m.index));
    pushBlock(m[2]);
    last = m.index + m[0].length;
  }
  if (matched) {
    if (last < body.length) pushBlock(body.slice(last));
  } else {
    // ★ 完全没有 <account> 包裹：模型直接把「名字|handle|正文」按 <br> 分行写。
    // 实测真实会话就是这么写的，以前这里返回空数组 → 整块动态被丢掉。
    pushBlock(body);
  }

  return accounts;
}

/* ─────────────────────────── 顶层入口 ─────────────────────────── */

/**
 * 解析整条助手消息。
 * @param {string} raw 纯文本
 * @returns {{kind:'structured'|'plain', blocks:Array, raw:string, syntax:'trs'|'legacy'|'loose'|'plain'}}
 */
function parseMessage(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return { kind: 'plain', blocks: [], raw: text, syntax: 'plain' };

  // ── 新语法优先 ──
  const scene = firstTag(text, 'scene');
  const hasTrs = scene !== null || /<panel\b/i.test(text) || /<char\b/i.test(text);
  if (hasTrs) {
    const blocks = parseTrs(scene ? scene.body : text);
    if (blocks.length > 0) {
      return { kind: 'structured', blocks, raw: text, syntax: 'trs' };
    }
  }

  // ── 旧语法 ──
  //
  // 注意：模型非常常见的写法是 <mainbody> 里**嵌套** <phone>：
  //     <mainbody>
  //       正文……
  //       <phone> 23:52 <Status>…</Status> <twitter>…</twitter> </phone>
  //     </mainbody>
  // 如果按「mainbody 整块当正文」处理，<phone> 里的所有标签会原样漏进正文，
  // 动态/状态/选项全部解析不出来（实测过：一整条回复的右半部分全是裸标签）。
  // 所以这里必须先剥掉 mainbody 内嵌的 <phone>，两者分别解析。
  const mainMatch = /<mainbody>([\s\S]*?)<\/mainbody>/i.exec(text);
  const phoneMatch = /<phone>([\s\S]*?)<\/phone>/i.exec(text);
  if (mainMatch || phoneMatch) {
    const blocks = [];

    /** 把一段旧格式正文按「正文 + 内嵌 <phone>」拆开解析。 */
    const pushLegacyBody = (chunk, origin) => {
      let rest = chunk;
      // 先掏出所有内嵌 <phone>（可能不止一个）
      const re = /<phone>([\s\S]*?)<\/phone>/gi;
      const phones = [];
      let m;
      while ((m = re.exec(chunk)) !== null) phones.push({ index: m.index, length: m[0].length, body: m[1] });
      // 从后往前删，避免索引位移
      for (let i = phones.length - 1; i >= 0; i -= 1) {
        const ph = phones[i];
        rest = rest.slice(0, ph.index) + rest.slice(ph.index + ph.length);
      }
      // stripTags 之后再 scrub 一遍：模型在 <mainbody> 里乱写 </prose> 这类
      // 半截标签很常见，不剥掉就会以裸标签露在版面上。
      const prose = scrubUnknownTags(stripTags(norm(rest))).text;
      if (prose.trim()) {
        blocks.push({ type: 'prose', segments: splitProse(prose), origin });
      }
      for (const ph of phones) blocks.push(...parsePhone(ph.body));
    };

    if (mainMatch && phoneMatch && phoneMatch.index > mainMatch.index
      && phoneMatch.index < mainMatch.index + mainMatch[0].length) {
      // ── phone 嵌在 mainbody 里：拆成「外层前后文字 + mainbody 内容」 ──
      const before = norm(text.slice(0, mainMatch.index));
      if (before && stripTags(before).trim()) {
        blocks.push({ type: 'prose', segments: splitProse(before), origin: 'outside' });
      }
      pushLegacyBody(mainMatch[1], 'mainbody');
      const after = norm(text.slice(mainMatch.index + mainMatch[0].length));
      if (after && stripTags(after).trim()) {
        blocks.push({ type: 'prose', segments: splitProse(after), origin: 'outside' });
      }
    } else {
      // ── 两者并列（原逻辑） ──
      let cursor = 0;
      const containers = [];
      if (mainMatch) containers.push({ type: 'mainbody', index: mainMatch.index, match: mainMatch });
      if (phoneMatch) containers.push({ type: 'phone', index: phoneMatch.index, match: phoneMatch });
      containers.sort((a, b) => a.index - b.index);

      for (const c of containers) {
        if (c.index > cursor) {
          const between = norm(text.slice(cursor, c.index));
          if (between) blocks.push({ type: 'prose', segments: splitProse(between), origin: 'outside' });
        }
        if (c.type === 'mainbody') {
          pushLegacyBody(c.match[1], 'mainbody');
        } else {
          blocks.push(...parsePhone(c.match[1]));
        }
        cursor = c.index + c.match[0].length;
      }
      const tail = norm(text.slice(cursor));
      if (tail) blocks.push({ type: 'prose', segments: splitProse(tail), origin: 'outside' });
    }

    if (blocks.length > 0) {
      return { kind: 'structured', blocks, raw: text, syntax: 'legacy' };
    }
  }

  // ── 宽松兜底（无标签老预设） ──
  const loose = parseLoose(text);
  if (loose.length > 0) {
    return { kind: 'structured', blocks: loose, raw: text, syntax: 'loose' };
  }

  return { kind: 'plain', blocks: [], raw: text, syntax: 'plain' };
}

/** 解析 TRS v1 的 scene 内容。 */
function parseTrs(body) {
  const blocks = [];

  const prose = firstTag(body, 'prose');
  if (prose) {
    // 先 stripTags 去掉已知标签，再 scrub 一遍把「模型自创的未知标签」也剥掉
    // （只留文字），避免 <心情> 这种裸标签出现在排版后的正文里。
    const cleaned = scrubUnknownTags(stripTags(prose.body)).text;
    const segs = splitProse(norm(cleaned));
    if (segs.length > 0) blocks.push({ type: 'prose', segments: segs, origin: 'prose' });
  }

  const panel = firstTag(body, 'panel');
  const panelBody = panel ? panel.body : '';

  // scene 里若没有 prose，把 scene 自身除 panel 外的文字当正文（宽松）
  if (!prose && !panel) {
    const cleaned = scrubUnknownTags(stripTags(body)).text;
    const segs = splitProse(norm(cleaned));
    if (segs.length > 0) blocks.push({ type: 'prose', segments: segs, origin: 'prose' });
  }

  if (panelBody) {
    const info = parseInfo(panelBody);
    if (info) blocks.push({ type: 'meta', label: info.label, value: formatInfo(info.fields) });

    const status = firstTag(panelBody, 'status');
    if (status) {
      const chars = parseChars(status.body);
      if (chars.length > 0) {
        blocks.push({ type: 'chars', chars });
      } else {
        // 新旧语法混用：模型在 TRS 的 <panel> 里写了旧式位置表达
        // （<清韵>62|18|心声|穿着）。不回退就会整块吞掉状态 —— 那是真丢内容。
        // parsePhone 里一直有这条回退，TRS 路径漏了。
        const rows = parseStatusRows(status.body);
        if (rows.length > 0) blocks.push({ type: 'status', rows });
      }
    }

    const chat = firstTag(panelBody, 'chat');
    if (chat) {
      const messages = parseChat(chat.body);
      if (messages.length > 0) blocks.push({ type: 'wechat', time: chat.attrs?.time || '', messages });
    }

    const feed = firstTag(panelBody, 'feed');
    if (feed) {
      const posts = parseFeed(feed.body).posts;
      if (posts.length > 0) blocks.push({ type: 'social', accounts: posts, label: feed.attrs?.source || '动态' });
    }

    const lists = eachTag(panelBody, 'list', (inner, parsed) => ({ inner, parsed }));
    for (const l of lists) {
      const items = parseListItems(l.inner);
      if (items.length > 0) {
        blocks.push({ type: 'list', variant: l.parsed.attrs?.title || 'list', items });
      }
    }

    const choice = firstTag(panelBody, 'choice');
    if (choice) {
      const items = parseOptions(choice.body);
      if (items.length > 0) blocks.push({ type: 'choices', items });
    }

    // 平台内容块（角色卡自定义）
    const peach = firstTag(panelBody, 'peachhub');
    if (peach) {
      const hub = parsePeachhub(peach.body);
      if (hub.title || hub.description || hub.params.length) {
        blocks.push({ type: 'peachhub', hub });
      }
    }
  }

  return blocks;
}

/** `<info time="…" place="…"/>` → 一行可读文本。 */
function formatInfo(fields) {
  const attrs = fields.attrs || {};
  const parts = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (!v) continue;
    const label = { time: '时间', place: '地点', weather: '天气', date: '日期' }[k] || k;
    parts.push(`${label} ${v}`);
  }
  return parts.join(' · ');
}

/** 解析旧语法 `<phone>`。 */
function parsePhone(body) {
  const blocks = [];
  const re = /<(status|twitter|wechat|adv|bilibili|choice|time|peachhub)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  let last = 0;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) {
      const stray = norm(body.slice(last, m.index));
      if (stray && stripTags(stray).trim()) {
        const meta = asPhoneMeta(stray);
        if (meta) blocks.push(meta);
        else blocks.push({ type: 'prose', segments: splitProse(stray), origin: 'phone' });
      }
    }
    const tag = m[1].toLowerCase();
    const inner = m[2];
    if (tag === 'status') {
      // 旧语法里也可能混用了 <char>
      const chars = parseChars(inner);
      if (chars.length > 0) blocks.push({ type: 'chars', chars });
      else blocks.push({ type: 'status', rows: parseStatusRows(inner) });
    } else if (tag === 'twitter') blocks.push({ type: 'social', accounts: parseSocial(inner) });
    else if (tag === 'wechat') blocks.push({ type: 'wechat', ...parseWechat(inner) });
    else if (tag === 'adv') blocks.push({ type: 'list', variant: 'adv', items: parseLines(inner) });
    else if (tag === 'bilibili') blocks.push({ type: 'list', variant: 'bilibili', items: parseLines(inner) });
    else if (tag === 'choice') blocks.push({ type: 'choices', items: parseChoices(inner) });
    else if (tag === 'time') blocks.push({ type: 'meta', label: '时间', value: norm(inner) });
    else if (tag === 'peachhub') {
      const hub = parsePeachhub(inner);
      if (hub.title || hub.description || hub.params.length) blocks.push({ type: 'peachhub', hub });
    }
    last = m.index + m[0].length;
  }
  const tail = norm(body.slice(last));
  if (tail && stripTags(tail).trim()) {
    const meta = asPhoneMeta(tail);
    if (meta) blocks.push(meta);
    else blocks.push({ type: 'prose', segments: splitProse(tail), origin: 'phone' });
  }
  return blocks;
}

/** 手机面板里的裸文本若是短元信息，归成 meta。 */
function asPhoneMeta(stray) {
  const plain = stripTags(stray).trim();
  if (!plain || plain.length > 40) return null;
  if (!/[\d]/.test(plain)) return null;
  if (/[。！？…]/.test(plain)) return null;
  return { type: 'meta', label: '场景', value: plain.replace(/\|/g, ' · ') };
}

/** 宽松模式：整条消息就是正文。 */
function parseLoose(text) {
  const segments = splitProse(norm(text));
  const hasSpeech = segments.some((s) => s.kind === 'speech');
  const hasAction = segments.some((s) => s.kind === 'action');
  if (!hasSpeech && !hasAction) return [];
  return [{ type: 'prose', segments, origin: 'loose' }];
}

/** 调试摘要。 */
function summarize(parsed) {
  return parsed.blocks.map((b) => {
    if (b.type === 'prose') return `prose(${b.origin}:${b.segments.length})`;
    if (b.type === 'chars') return `chars(${b.chars.length}人)`;
    if (b.type === 'status') return `status(${b.rows.length}行)`;
    if (b.type === 'social') return `social(${b.accounts.length}条)`;
    if (b.type === 'wechat') return `wechat(${b.messages.length}条)`;
    if (b.type === 'choices') return `choices(${b.items.length}项)`;
    if (b.type === 'list') return `list(${b.variant}:${b.items.length})`;
    return b.type;
  });
}

return { esc, scrubUnknownTags, parseAttrs, splitProse, parseChars, parseStatusRows, classifyStatusField, parseChat, parseFeed, parseListItems, parseOptions, parseInfo, parsePeachhub, parseWechat, parseChoices, parseLines, parseSocial, parseMessage, parseTrs, parsePhone, parseLoose, summarize };
})();
/* ---- /内联 parse.js ---- */

      /* ===================== 内联：render.js ==================== */
      /* ---- 内联 render.js ---- */
const { renderMessage } = (() => {
/**
 * 渲染器：把 parse.js 的结构化结果转成 HTML 字符串。
 *
 * 所有动态文本都经 esc() 转义；这里只产出「受控的语义标签」，
 * 样式全部交给 styles.js 里的 CSS 变量控制，换主题不用改这里。
 */

/* ───────────────────────── 小零件 ───────────────────────── */

/** 好感度环：数字 + 一圈进度。 */
function gauge(label, value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return `<span class="tt-gauge" data-value="${v}">
    <span class="tt-gauge-ring" style="--tt-gauge:${v}"></span>
    <span class="tt-gauge-text">${v}</span>
    ${label ? `<span class="tt-gauge-label">${esc(label)}</span>` : ''}
  </span>`;
}

/** 正文片段：旁白 / 对白 / 动作。 */
function renderProse(block) {
  const parts = block.segments.map((seg) => {
    if (seg.kind === 'speech') {
      return `<span class="tt-speech">“<span class="tt-speech-inner">${esc(seg.text)}</span>”</span>`;
    }
    if (seg.kind === 'action') {
      return `<span class="tt-action">${esc(seg.text)}</span>`;
    }
    return `<span class="tt-narration">${esc(seg.text)}</span>`;
  });
  return `<div class="tt-prose" data-origin="${esc(block.origin)}">${parts.join('')}</div>`;
}

/* ───────────────── 规范语法：命名属性状态卡（主路径） ───────────────── */

/**
 * 一个属性渲染成什么，完全由「名字 + 是否数值」决定，不依赖位置。
 * 这是「不同模型输出不一样」也能稳定显示的关键。
 */
function renderCharField(field) {
  const { key, label, value } = field;
  const numeric = /^\d{1,3}(?:\.\d+)?$/.test(String(value).trim());

  // 好感 / 理性 / 体力 这类 0-100 数值 → 环形仪表
  if (numeric && Number(value) <= 100) {
    return `<span class="tt-field tt-field-num" data-key="${esc(key)}">${gauge(label, Number(value))}</span>`;
  }
  if (numeric) {
    return `<span class="tt-field tt-field-num" data-key="${esc(key)}">
      <span class="tt-num">${esc(value)}</span><span class="tt-num-label">${esc(label)}</span>
    </span>`;
  }

  const text = String(value);
  // 短词 → 彩色标签；长句 → 说明条
  if (text.length <= 14 && !/[，。！？；、]/.test(text)) {
    return `<span class="tt-field tt-field-tag" data-key="${esc(key)}">
      <span class="tt-tag-label">${esc(label)}</span><span class="tt-tag-value">${esc(text)}</span>
    </span>`;
  }
  return `<span class="tt-field tt-field-text" data-key="${esc(key)}">
    <span class="tt-text-label">${esc(label)}</span>${esc(text)}
  </span>`;
}

/** 新语法状态：每个角色一张卡。 */
function renderChars(block) {
  if (!block.chars || block.chars.length === 0) return '';
  const cards = block.chars.map((c) => {
    const fields = c.fields.map(renderCharField).join('');
    const inner = c.inner
      ? `<div class="tt-char-inner">${esc(c.inner)}</div>`
      : '';
    return `<div class="tt-char">
      <div class="tt-char-name">${esc(c.name || '状态')}</div>
      <div class="tt-char-body">${fields}</div>
      ${inner}
    </div>`;
  }).join('');
  return `<section class="tt-status" data-section="status">
    <div class="tt-section-title">状态</div>
    <div class="tt-status-grid">${cards}</div>
  </section>`;
}

/** 状态栏：每个角色一张卡，字段按语义上色。 */
function renderStatus(block) {
  if (block.rows.length === 0) return '';
  const cards = block.rows.map((row) => {
    const fields = row.fields.map((field, i) => {
      const info = classifyStatusField(field, i);
      if (info.kind === 'gauge') {
        // 前两个数字当成 好感/理性 之类的双数值
        const label = i === 0 ? '好感' : i === 1 ? '理性' : '';
        return `<span class="tt-field tt-field-num">${gauge(label, info.value)}</span>`;
      }
      if (info.kind === 'number') {
        return `<span class="tt-field tt-field-num"><span class="tt-num">${esc(field)}</span></span>`;
      }
      if (info.kind === 'media') {
        return `<span class="tt-field tt-field-media">${esc(field)}</span>`;
      }
      if (info.kind === 'tag') {
        return `<span class="tt-field tt-field-tag">${esc(field)}</span>`;
      }
      return `<span class="tt-field tt-field-text">${esc(field)}</span>`;
    }).join('');
    return `<div class="tt-char">
      <div class="tt-char-name">${esc(row.name || '状态')}</div>
      <div class="tt-char-body">${fields}</div>
    </div>`;
  }).join('');
  return `<section class="tt-status" data-section="status">
    <div class="tt-section-title">状态</div>
    <div class="tt-status-grid">${cards}</div>
  </section>`;
}

/** 社交平台帖。 */
function renderSocial(block) {
  if (block.accounts.length === 0) return '';
  const cards = block.accounts.map((a) => {
    const stats = a.stats ? `<span class="tt-social-stats">${esc(a.stats)}</span>` : '';
    const extra = a.extra?.length
      ? `<div class="tt-social-extra">${a.extra.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`
      : '';
    const append = a.append ? `<div class="tt-social-append">${esc(a.append)}</div>` : '';
    const handle = a.handle ? `<span class="tt-post-handle">@${esc(a.handle)}</span>` : '';
    return `<article class="tt-post">
      <header class="tt-post-head">
        <span class="tt-post-name">${esc(a.name)}</span>
        ${handle}
        ${stats}
      </header>
      <p class="tt-post-text">${esc(a.text)}</p>
      ${append}${extra}
    </article>`;
  }).join('');
  return `<section class="tt-social" data-section="social">
    <div class="tt-section-title">${esc(block.label || '动态')}</div>
    ${cards}
  </section>`;
}

/** 微信聊天。 */
function renderWechat(block) {
  const time = block.time ? `<div class="tt-chat-time">${esc(block.time)}</div>` : '';
  const rows = block.messages.map((m) => `<div class="tt-bubble">
    <span class="tt-bubble-from">${esc(m.from)}</span>
    <span class="tt-bubble-text">${esc(m.text)}</span>
  </div>`).join('');
  return `<section class="tt-chat" data-section="chat">
    <div class="tt-section-title">消息${block.time ? ` · ${esc(block.time)}` : ''}</div>
    ${rows || time}
  </section>`;
}

/** 列表类分区（广告 / 直播 / 其他 feed）。 */
function renderList(block) {
  if (block.items.length === 0) return '';
  const titles = { adv: '推荐', bilibili: '直播' };
  const title = titles[block.variant] || block.variant;
  const items = block.items.map((x) => `<li>${esc(x)}</li>`).join('');
  return `<section class="tt-feed" data-variant="${esc(block.variant)}">
    <div class="tt-section-title">${esc(title)}</div>
    <ul class="tt-feed-list">${items}</ul>
  </section>`;
}

/**
 * 选项：可点击的按钮列表。
 *
 * 点击行为不在 HTML 里绑（事件由 clpient 层统一委托，见 bundle 的 installChoiceHandler），
 * 这里只把「要发送的文本」放进 data-tt-send，并标记为可点击。
 */
function renderChoices(block) {
  if (block.items.length === 0) return '';
  const items = block.items.map((x, i) => `<li class="tt-choice" data-tt-send="${esc(x)}" role="button" tabindex="0">
    <span class="tt-choice-index">${i + 1}</span>
    <span class="tt-choice-text">${esc(x)}</span>
  </li>`).join('');
  return `<section class="tt-choices" data-section="choices">
    <div class="tt-section-title">你的选择<small class="tt-choices-hint">点一下直接发送</small></div>
    <ol class="tt-choice-list">${items}</ol>
  </section>`;
}

/** 平台内容块（角色卡自定义的 <peachhub>）。 */
function renderPeachhub(block) {
  const hub = block.hub || {};
  const params = (hub.params || []).map((p) => `<span class="tt-hub-param">
      ${p.label ? `<span class="tt-hub-param-label">${esc(p.label)}</span>` : ''}
      <span class="tt-hub-param-value">${esc(p.value)}</span>
    </span>`).join('');
  const tags = (hub.tags || []).length
    ? `<div class="tt-hub-tags">${hub.tags.map((x) => `<span class="tt-hub-tag">${esc(x)}</span>`).join('')}</div>`
    : '';
  const comments = (hub.comments || []).length
    ? `<div class="tt-hub-comments">${hub.comments.map((x) => `<div class="tt-hub-comment">${esc(x)}</div>`).join('')}</div>`
    : '';
  const desc = hub.description ? `<p class="tt-hub-desc">${esc(hub.description)}</p>` : '';
  const title = hub.title ? `<div class="tt-hub-title">${esc(hub.title)}</div>` : '';
  if (!title && !desc && !params && !tags && !comments) return '';
  return `<section class="tt-hub" data-section="hub">
    <div class="tt-section-title">上传</div>
    <div class="tt-hub-card">
      ${title}${params ? `<div class="tt-hub-params">${params}</div>` : ''}${desc}${tags}${comments}
    </div>
  </section>`;
}

/** 元信息（时间 / 场景）。 */
function renderMeta(block) {
  return `<div class="tt-meta"><span class="tt-meta-label">${esc(block.label)}</span><span class="tt-meta-value">${esc(block.value)}</span></div>`;
}

/* ───────────────────────── 入口 ───────────────────────── */

/**
 * 把解析结果渲染为 HTML。
 * @param {{kind:string, blocks:Array, raw:string}} parsed
 * @param {{wrap?:boolean}} [opts]
 * @returns {string} HTML；不需要接管时返回 ''（调用方保留原生渲染）
 */
function renderMessage(parsed, opts = {}) {
  if (!parsed || parsed.kind !== 'structured') return '';
  const inner = parsed.blocks.map((b) => {
    switch (b.type) {
      case 'prose': return renderProse(b);
      case 'chars': return renderChars(b);
      case 'status': return renderStatus(b);
      case 'social': return renderSocial(b);
      case 'wechat': return renderWechat(b);
      case 'list': return renderList(b);
      case 'choices': return renderChoices(b);
      case 'peachhub': return renderPeachhub(b);
      case 'meta': return renderMeta(b);
      default: return '';
    }
  }).join('');
  if (!inner.trim()) return '';
  if (opts.wrap === false) return inner;
  return `<div class="tt-root" data-dsh-tavern-render="1" data-tt-syntax="${esc(parsed.syntax || 'legacy')}">${inner}</div>`;
}

return { renderMessage };
})();
/* ---- /内联 render.js ---- */

      /* ===================== 内联：styles.js ==================== */
      /* ---- 内联 styles.js ---- */
const { STYLE_ID, SCOPE_ATTR, buildCSS } = (() => {
/**
 * 样式表。
 *
 * 设计约束：
 *   1. 全部用 CSS 变量定义颜色/字号/字体，主题切换只改变量。
 *   2. 颜色尽量走宿主主题变量（--dsw-alias-*），亮暗自动跟随；
 *      但语义色（对白/状态/选项）需要强调，所以自带一套并做暗色覆盖。
 *   3. 不写全局选择器（除了 body[data-dsh-tavern-render] 前缀），不影响宿主。
 */

const STYLE_ID = 'dsh-tavern-render/styles';
const SCOPE_ATTR = 'data-dsh-tavern-render';

function buildCSS() {
  return `
/* ═══════════════ 壁纸可读性：文字垫底层 ═══════════════
 *
 * 背景是用户自选的壁纸，亮部（窗光、吊灯、白墙）会让正文对比度掉到 2–3:1。
 * 实测（test/contrast.mjs）：壁纸最亮到 #e8ecf2 时，
 *   alpha 0.68 → 对白 4.20、神态 3.75（不达标）
 *   alpha 0.75 → 对白 5.31、神态 4.74（达标）
 * 所以取 0.75 为基准档。
 *
 * 0.75 会让壁纸只剩 25% 可见，直接铺一块纯色就是「黑框」。
 * 这里用三个手法把氛围找回来：
 *   1. 双色渐变：左上偏暖（呼应暖色吊灯）、右下偏冷（呼应冷色窗光）
 *   2. 4.5% 噪点纹理：去掉纯数字色的塑料感，质感像布
 *   3. 1px 内高光 + 外描边渐变：让容器有厚度，不是贴上去的色块
 *
 * 变量可被覆写：宿主或用户想更透/更实，只改 --tt-veil-alpha 即可。
 */
body:where([${SCOPE_ATTR}]) {
  --tt-veil-alpha: 0.75;
  --tt-veil-radius: 11px;
  --tt-veil-pad: 15px 19px;
  /* 噪点：fractalNoise，4.5% 不透明度，180px 平铺 */
  --tt-veil-noise: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");
}

body:where([${SCOPE_ATTR}]) .tt-root {
  position: relative;
  border-radius: var(--tt-veil-radius);
  padding: var(--tt-veil-pad);
  /* 双色渐变 + 噪点叠加。alpha 由变量控制，默认 0.75 */
  background-image:
    var(--tt-veil-noise),
    linear-gradient(145deg,
      rgba(30, 24, 20, calc(var(--tt-veil-alpha) + 0.01)) 0%,
      rgba(14, 17, 28, var(--tt-veil-alpha)) 42%,
      rgba(10, 13, 23, calc(var(--tt-veil-alpha) + 0.03)) 100%);
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.22),
    inset 0 1px 0 rgba(255, 255, 255, 0.055);
}

/* 顶边 1px 渐变描边：让容器的上沿「有光」，避免观感变成一块黑板 */
body:where([${SCOPE_ATTR}]) .tt-root::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: calc(var(--tt-veil-radius) + 1px);
  padding: 1px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.075) 0%, transparent 62%);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
}

/* 亮色主题：壁纸通常更亮，需要更实的浅色垫底。
 *
 * 关键教训：这里的垫底**必须跟着正文文字色走**。
 * 之前只改了 alpha 和垫底色，文字仍是深色主题的浅色 → 浅字压浅底，完全看不见。
 * 所以亮色分支把 --tt-narration / --tt-dialog / --tt-action 一起换掉。 */
body:where([${SCOPE_ATTR}]):not([data-ds-dark-theme]) {
  --tt-veil-alpha: 0.86;
  --tt-narration: #1c2430;
  --tt-narration-soft: #46536a;
  --tt-dialog: #8a5a12;
  --tt-action: #4a3a78;
  --tt-dim: #5c6a80;
}

body:where([${SCOPE_ATTR}]):not([data-ds-dark-theme]) .tt-root {
  background-image:
    var(--tt-veil-noise),
    linear-gradient(145deg,
      rgba(252, 250, 246, calc(var(--tt-veil-alpha) + 0.01)) 0%,
      rgba(247, 249, 253, var(--tt-veil-alpha)) 42%,
      rgba(240, 244, 250, calc(var(--tt-veil-alpha) + 0.03)) 100%);
  box-shadow:
    0 1px 3px rgba(15, 30, 60, 0.10),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
}

body:where([${SCOPE_ATTR}]):not([data-ds-dark-theme]) .tt-root::before {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.85) 0%, transparent 62%);
}

/* ═══════════════ 主题变量 ═══════════════ */
body:where([${SCOPE_ATTR}]) {
  /* 全部正文共用宿主自己的正文字体。
   * 之前给对白单独配了 Georgia / Songti SC / Noto Serif CJK 的衬线栈，
   * 但 Windows 上那几个中文字体根本不存在，回退到系统宋体，小字号下发虚发丑。
   * 现在统一用 --dsh-font-family（宿主已经在 body 上设好），中文英文都跟界面一致。 */
  --tt-font-prose: var(--dsh-font-family, var(--dsw-font-family, inherit));

  /* 对白：楷体。本机实测存在（楷体 / KaiTi / STKaiti 三档兜底，
   * 前两个 Windows 自带，第三个是 macOS 名字，都取不到才退到 serif）。
   * 字号与旁白完全相同 —— 只换字体和颜色，不放大。 */
  --tt-font-dialog: "楷体", "KaiTi", "STKaiti", var(--dsh-font-family, serif);

  --tt-font-mono: var(--ds-font-family-code, ui-monospace, "Cascadia Code", Consolas, monospace);

  /* 对白不再放大 —— 字号和行高都与正文一致。 */
  --tt-prose-size: 15px;
  --tt-prose-line: 1.95;
  --tt-meta-size: 12px;
  --tt-title-size: 11.5px;

  --tt-narration: var(--dsw-alias-label-primary, #eef2f8);
  --tt-narration-soft: var(--dsw-alias-label-secondary, #b6c2d4);

  /* 对白：暖琥珀。不刺眼、夜间友好，和正文灰白有区分但不打架。
   * 数值依据（test/contrast-final.mjs）：0.75 垫底上
   *   纯白壁纸 4.55:1、亮壁纸 5.48:1，均过 4.5 门槛。 */
  --tt-dialog: #e0b878;
  --tt-dialog-bg: transparent;
  --tt-dialog-border: rgba(224, 184, 120, 0.42);

  /* 动作/神态：明确的淡紫，不用宿主的 secondary。
   * #cdbcf0 在纯白壁纸 4.85:1、亮壁纸 5.84:1（#c4b0e8 只有 4.32，擦边不过）。 */
  --tt-action: #cdbcf0;
  --tt-action-soft: transparent;

  --tt-surface: var(--dsw-alias-markdown-code-block, rgba(255, 255, 255, 0.045));
  --tt-surface-2: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.03));
  --tt-border: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12));
  --tt-radius: 12px;

  --tt-accent: #7fb2e8;
  --tt-warm: #e5b567;
  --tt-pink: #e88fa8;
  --tt-blue: #7fb2e8;
  --tt-violet: #c4b0e8;
  --tt-green: #8fd694;
  --tt-dim: var(--dsw-alias-label-tertiary, #8b95a5);
}

/* 亮色主题（宿主没有 dark 标记时） */
body:where([${SCOPE_ATTR}]):not([data-ds-dark-theme]) {
  /* 浅底上琥珀色会糊，换成同色系的深琥珀/赭石，观感一致且够对比度。 */
  --tt-dialog: #a9762a;
  --tt-dialog-bg: transparent;
  --tt-dialog-border: rgba(169, 118, 42, 0.38);
  --tt-action: var(--dsw-alias-label-secondary, rgba(15, 30, 60, 0.62));
  --tt-action-soft: transparent;
  --tt-surface: rgba(15, 30, 60, 0.035);
  --tt-surface-2: rgba(15, 30, 60, 0.02);
  --tt-border: rgba(15, 30, 60, 0.12);
  --tt-accent: #2a6db5;
  --tt-warm: #b47d1e;
  --tt-pink: #c04a67;
  --tt-blue: #2a6db5;
  --tt-violet: #6a4fa8;
  --tt-green: #2e7d32;
  --tt-dim: rgba(15, 30, 60, 0.52);
}

/* ═══════════════ 根容器 ═══════════════ */
.tt-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: var(--tt-font-prose);
  color: var(--tt-narration);
}

/* ═══════════════ 正文：旁白 / 对白 / 动作 ═══════════════ */
.tt-prose {
  font-size: var(--tt-prose-size);
  line-height: var(--tt-prose-line);
  letter-spacing: 0.012em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tt-narration {
  color: var(--tt-narration);
}

/* 对白：换楷体 + 暖琥珀色，字号与旁白完全一致（不放大）。
 * 左侧竖线保留，作为「这段是说的」的第二个提示；不铺底色块。 */
/* 对白：楷体 + 暖琥珀，靠字色与字体区分。
 * 早前用过 border-left 做「竖线提示」，但内联元素换行时
 * box-decoration-break: clone 会在**每一行**行首各画一条竖线，
 * 长对白里就变成一串竖线，反而更脏。改成纯字体+颜色。 */
.tt-speech {
  color: var(--tt-dialog);
  font-family: var(--tt-font-dialog);
  font-size: inherit;
  line-height: inherit;
  letter-spacing: 0.02em;
  background: var(--tt-dialog-bg);
  padding: 0 2px;
}

.tt-speech-inner { font-style: normal; }

/* 动作 / 神态：淡色斜体，不铺底色（主人指定「不要色块」）。 */
.tt-action {
  color: var(--tt-action);
  font-style: italic;
  font-size: inherit;
  background: var(--tt-action-soft);
  padding: 0 1px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}

/* ═══════════════ 分区通用标题 ═══════════════ */
.tt-section-title {
  font-size: var(--tt-title-size);
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--tt-dim);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tt-section-title::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--tt-border), transparent);
}

/* ═══════════════ 元信息 ═══════════════ */
.tt-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--tt-meta-size);
  font-family: var(--tt-font-mono);
  color: var(--tt-dim);
  border: 1px dashed var(--tt-border);
  border-radius: 999px;
  padding: 3px 12px;
  align-self: flex-start;
}
.tt-meta-label {
  color: var(--tt-accent);
  opacity: 0.85;
  letter-spacing: 0.08em;
}

/* ═══════════════ 状态栏：可视化卡片 ═══════════════ */
.tt-status {
  border: 1px solid var(--tt-border);
  border-radius: var(--tt-radius);
  background: var(--tt-surface);
  padding: 12px 14px 14px;
}

.tt-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
  align-items: start;
}

.tt-char {
  border: 1px solid var(--tt-border);
  border-radius: 10px;
  background: var(--tt-surface-2);
  padding: 10px 11px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tt-char-name {
  font-family: inherit;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--tt-warm);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--tt-border);
}

.tt-char-body {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: flex-start;
}

.tt-field { display: inline-flex; }

/* 数值字段：环 + 数字 */
.tt-field-num { align-items: center; }

.tt-gauge {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--tt-font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--tt-accent);
}
.tt-gauge-ring {
  --p: calc(var(--tt-gauge) * 1%);
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background:
    conic-gradient(var(--tt-accent) var(--p), var(--tt-border) 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3.5px));
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3.5px));
  flex: none;
}
.tt-gauge-text { color: var(--tt-narration); }
.tt-gauge-label {
  font-family: var(--tt-font-prose);
  font-size: 10.5px;
  font-weight: 400;
  color: var(--tt-dim);
  letter-spacing: 0.05em;
}

.tt-num {
  font-family: var(--tt-font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--tt-warm);
  background: var(--tt-surface);
  border: 1px solid var(--tt-border);
  border-radius: 999px;
  padding: 1px 9px;
}

/* 长描述字段：独占一行 */
.tt-field-text {
  flex: 1 1 100%;
  font-size: 12.5px;
  line-height: 1.62;
  color: var(--tt-narration);
  opacity: 0.88;
  background: var(--tt-surface);
  border-left: 2px solid var(--tt-border);
  border-radius: 0 6px 6px 0;
  padding: 4px 9px;
}

/* 短标签：名字 + 值 */
.tt-field-tag {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--tt-blue);
  background: var(--tt-surface);
  border: 1px solid var(--tt-border);
  border-radius: 6px;
  padding: 2px 8px;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.tt-tag-label {
  font-size: 10px;
  color: var(--tt-dim);
  letter-spacing: 0.06em;
}
.tt-tag-value { color: var(--tt-blue); font-weight: 500; }

/* 数值标签（非 0-100 的数值） */
.tt-num-label {
  font-size: 10px;
  color: var(--tt-dim);
  margin-left: 4px;
  letter-spacing: 0.05em;
}

/* 长描述：带字段名 */
.tt-text-label {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--tt-warm);
  margin-right: 7px;
  vertical-align: 1px;
  white-space: nowrap;
}

/* 心声：斜体引用块，与属性区分 */
.tt-char-inner {
  font-size: 12.5px;
  line-height: 1.68;
  font-style: italic;
  color: var(--tt-narration);
  opacity: 0.82;
  background: var(--tt-surface);
  border-left: 2px solid var(--tt-violet);
  border-radius: 0 6px 6px 0;
  padding: 5px 10px;
  margin-top: 2px;
}

/* 媒体文件名：等宽、弱化、小图钉 */
.tt-field-media {
  font-family: var(--tt-font-mono);
  font-size: 10.5px;
  color: var(--tt-dim);
  border: 1px dashed var(--tt-border);
  border-radius: 5px;
  padding: 1px 6px;
  opacity: 0.85;
}

/* ═══════════════ 社交动态 ═══════════════ */
.tt-social {
  border: 1px solid var(--tt-border);
  border-radius: var(--tt-radius);
  background: var(--tt-surface);
  padding: 12px 14px 14px;
}
.tt-post {
  border-left: 2px solid var(--tt-pink);
  border-radius: 0 8px 8px 0;
  background: var(--tt-surface-2);
  padding: 9px 12px;
  margin-top: 8px;
}
.tt-post-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}
.tt-post-name {
  font-weight: 700;
  font-size: 13.5px;
  color: var(--tt-pink);
}
.tt-post-handle {
  font-family: var(--tt-font-mono);
  font-size: 11px;
  color: var(--tt-dim);
}
.tt-social-stats {
  font-family: var(--tt-font-mono);
  font-size: 10.5px;
  color: var(--tt-warm);
  margin-left: auto;
  border: 1px solid var(--tt-border);
  border-radius: 999px;
  padding: 0 8px;
}
.tt-post-text {
  font-size: 13.5px;
  line-height: 1.78;
  margin: 0;
  color: var(--tt-narration);
}
.tt-social-append {
  margin-top: 7px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--tt-narration-soft);
  border-left: 2px dashed var(--tt-border);
  padding-left: 9px;
}
.tt-social-extra {
  display: flex;
  gap: 7px;
  margin-top: 7px;
  flex-wrap: wrap;
}
.tt-social-extra > span {
  font-family: var(--tt-font-mono);
  font-size: 10.5px;
  color: var(--tt-dim);
  border: 1px solid var(--tt-border);
  border-radius: 999px;
  padding: 0 8px;
}

/* ═══════════════ 聊天消息 ═══════════════ */
.tt-chat {
  border: 1px solid var(--tt-border);
  border-radius: var(--tt-radius);
  background: var(--tt-surface);
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.tt-chat-time {
  font-family: var(--tt-font-mono);
  font-size: 10.5px;
  color: var(--tt-dim);
}
.tt-bubble {
  display: flex;
  align-items: baseline;
  gap: 9px;
  background: var(--tt-surface-2);
  border: 1px solid var(--tt-border);
  border-radius: 4px 12px 12px 12px;
  padding: 6px 11px;
}
.tt-bubble-from {
  flex: none;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--tt-blue);
  letter-spacing: 0.05em;
}
.tt-bubble-text {
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--tt-narration);
  overflow-wrap: anywhere;
}

/* ═══════════════ 推荐 / 列表 ═══════════════ */
.tt-feed {
  border: 1px solid var(--tt-border);
  border-radius: var(--tt-radius);
  background: var(--tt-surface);
  padding: 12px 14px 14px;
}
.tt-feed-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.tt-feed-list > li {
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--tt-narration-soft);
  padding-left: 14px;
  position: relative;
}
.tt-feed-list > li::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 0.72em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--tt-warm);
  opacity: 0.7;
}
.tt-feed[data-variant="bilibili"] .tt-feed-list > li::before { background: var(--tt-pink); }

/* ═══════════════ 选项：可点击的卡片 ═══════════════ */
.tt-choices {
  border: 1px solid var(--tt-border);
  border-radius: var(--tt-radius);
  background: linear-gradient(160deg, var(--tt-surface), transparent);
  padding: 12px 14px 14px;
}
.tt-choices-hint {
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.04em;
  color: var(--tt-dim);
  opacity: 0.75;
  text-transform: none;
  margin-left: 4px;
}
.tt-choice-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  counter-reset: none;
}
.tt-choice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border: 1px solid var(--tt-border);
  border-radius: 9px;
  background: var(--tt-surface-2);
  padding: 8px 12px;
  transition: border-color 0.14s, background 0.14s, transform 0.14s, opacity 0.14s;
  cursor: pointer;
  user-select: none;
}
.tt-choice:hover {
  border-color: var(--tt-accent);
  background: var(--tt-dialog-bg);
  transform: translateX(2px);
}
.tt-choice:focus-visible {
  outline: 2px solid var(--tt-accent);
  outline-offset: 1px;
}
/* 发送中：整组变暗并禁止再点 */
.tt-choice-busy {
  opacity: 0.45;
  cursor: progress;
}
.tt-choice-sending {
  border-color: var(--tt-warm);
  opacity: 1;
}
/* 发送成功：勾一下，明确「已经替你发出去了」 */
.tt-choice-sent {
  border-color: var(--tt-warm);
  opacity: 1;
}
.tt-choice-sent .tt-choice-index::after {
  content: "✓";
  position: absolute;
  opacity: 0;
}
.tt-choice-sent .tt-choice-index {
  color: var(--tt-warm);
  border-color: var(--tt-warm);
}
/* 发送失败：短暂标红 */
.tt-choice-failed {
  border-color: #e0716f !important;
  background: rgba(224, 113, 111, 0.10) !important;
  opacity: 1 !important;
}
.tt-choice-index {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-family: var(--tt-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--tt-accent);
  border: 1px solid var(--tt-accent);
  opacity: 0.9;
  margin-top: 1px;
}
.tt-choice-text {
  font-size: 13.5px;
  line-height: 1.72;
  color: var(--tt-narration);
  overflow-wrap: anywhere;
}

/* ═══════════════ 平台内容块（peachhub） ═══════════════ */
.tt-hub {
  border: 1px solid var(--tt-border);
  border-radius: var(--tt-radius);
  background: var(--tt-surface);
  padding: 12px 14px 14px;
}
.tt-hub-card {
  border-left: 2px solid var(--tt-pink);
  border-radius: 0 8px 8px 0;
  background: var(--tt-surface-2);
  padding: 10px 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tt-hub-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--tt-pink);
  letter-spacing: 0.02em;
}
.tt-hub-params {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.tt-hub-param {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  border: 1px solid var(--tt-border);
  border-radius: 999px;
  background: var(--tt-surface);
  padding: 1px 9px;
}
.tt-hub-param-label {
  font-size: 10px;
  color: var(--tt-dim);
  letter-spacing: 0.05em;
}
.tt-hub-param-value {
  font-family: var(--tt-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--tt-warm);
}
.tt-hub-desc {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.78;
  color: var(--tt-narration);
  white-space: pre-wrap;
}
.tt-hub-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tt-hub-tag {
  font-size: 11px;
  color: var(--tt-blue);
  background: var(--tt-surface);
  border: 1px solid var(--tt-border);
  border-radius: 6px;
  padding: 1px 7px;
}
.tt-hub-comments {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px dashed var(--tt-border);
  padding-top: 7px;
}
.tt-hub-comment {
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--tt-narration-soft);
}

/* ═══════════════ 窄屏 ═══════════════ */
@media (max-width: 560px) {
  body:where([${SCOPE_ATTR}]) {
    --tt-prose-size: 14.5px;
  }
  .tt-status-grid { grid-template-columns: 1fr; }
}

/* 尊重「减少动态效果」 */
@media (prefers-reduced-motion: reduce) {
  .tt-choice { transition: none; }
  .tt-choice:hover { transform: none; }
}
`;
}

return { STYLE_ID, SCOPE_ATTR, buildCSS };
})();
/* ---- /内联 styles.js ---- */

      /* ===================== 客户端逻辑 ===================== */

      const PLUGIN = 'dsh-tavern-render';
      const LOG = `[${PLUGIN}]`;

      /** 我们把排版结果挂进 _body 后，用它认领自己的节点。 */
      const ATTR_BODY = 'data-tt-body';
      /** 已经处理过的 body（幂等标记）。 */
      const ATTR_DONE = 'data-tt-done';
      /** 单条消息的语法来源，便于排查。 */
      const ATTR_SYNTAX = 'data-tt-syntax';

      /** 默认配置。presets 是硬编码白名单，用户可在 profile 里覆盖。 */
      const DEFAULTS = Object.freeze({
        enabled: true,
        // 只在这个（些）预设里生效。不匹配 = 彻底不接管，从根上杜绝污染其他工作区。
        presets: ['tavern-play'],
        // 接管门槛：结构化正文至少要有一段对白或一个面板块，避免把一段散文重排。
        minSpeech: 1,
      });

      /* ─────────────────────────── 闸 1：预设白名单 ─────────────────────────── */

      /**
       * 从任意节点回溯到它所属的会话 id。
       * 证据：dsh-client-ui-conversation `data-conversation-session`（SLOT-RESEARCH §5.4）。
       * @param {Element|null} el
       * @returns {string|null}
       */
      function sessionIdOf(el) {
        if (!el || typeof el.closest !== 'function') return null;
        const host = el.closest('[data-conversation-session]');
        if (!host) return null;
        const id = host.getAttribute('data-conversation-session');
        return id || null;
      }

      /**
       * 读当前会话用的预设 id。
       *
       * 证据：dsh-client-ui-conversation:16156 `session.projections.faceOf('agentPreset').getSnapshot()`，
       * 类型是 string | undefined；且它出现在普通类（非 React）的构造函数里，说明不依赖 hook。
       *
       * ⚠️ 未在真机核对：返回值到底是预设的 `id`（'tavern-play'）还是 `name`（'酒馆·扮演'）。
       * 因此下面同时接受 id 与显示名——两种都对，宁可宽松也不能整个闸失效。
       * 真机验证命令见 README「排错」一节。
       *
       * @param {Element} el 该会话里的任意节点
       * @param {object} ctx 客户端根上下文
       * @returns {string|null}
       */
      function presetOf(el, ctx) {
        const sid = sessionIdOf(el);
        if (!sid) return null;
        const sessions = ctx && ctx.sessions;
        if (!sessions || typeof sessions.binding !== 'function') return null;
        let binding;
        try {
          binding = sessions.binding(sid);
        } catch {
          return null;
        }
        const session = binding && binding.session;
        const projections = session && session.projections;
        if (!projections || typeof projections.faceOf !== 'function') return null;
        try {
          const value = projections.faceOf('agentPreset').getSnapshot();
          return typeof value === 'string' ? value : null;
        } catch {
          return null;
        }
      }

      /**
       * 闸 1。不匹配就返回 false —— 调用方必须立刻收手，一个字节都不要改。
       * @param {Element} el
       * @param {object} cfg
       * @param {object} ctx
       * @returns {boolean}
       */
      function isTavernSession(el, cfg, ctx) {
        const allow = Array.isArray(cfg.presets) && cfg.presets.length > 0 ? cfg.presets : DEFAULTS.presets;
        const preset = presetOf(el, ctx);
        // 拿不到预设（无 sessions 服务、新建会话、读取异常）→ 一律当「不是酒馆会话」。
        // 这一条是整个插件安全性的基石：宁可什么都不做，也不能误伤。
        if (preset === null) return false;
        return allow.includes(preset);
      }

      /* ───────────────────── 闸 2 + 闸 3：找正文容器 ───────────────────── */

      /** CSS Module 类名形如 `xMeOpW_body`：只认后缀形式，不认具体哈希。 */
      const RE_BODY_CLASS = /(?:^|\s)[A-Za-z0-9_-]+_body(?:\s|$)/;
      const RE_ROOT_CLASS = /(?:^|\s)[A-Za-z0-9_-]+_root(?:\s|$)/;

      /**
       * 确认「正文 markdown 容器」确实是 AssistantMarkdown 的 `_body` 的直接子元素，
       * 且它的父链上认得出 `_root`。
       *
       * 层级（SLOT-RESEARCH §4.2，已核对）：
       *   div[data-chat-flow-kind="assistant-step"]
       *   └─ div[data-slot="conversation.chat.node"]   ← display:contents 的槽位锚点
       *      └─ div.<hash>_root
       *         └─ div.<hash>_body
       *            ├─ div.<hash>_markdown[data-text-interaction-source]   ← 正文
       *            └─ div[data-turn-process-inline] > div.<hash>_root     ← 思考行（要排除）
       *
       * @param {Element} src 候选正文 markdown 容器
       * @param {Element} flowItem assistant-step 的 flowItem
       * @returns {{body: Element, root: Element}|null}
       */
      function confirmBody(src, flowItem) {
        const body = src.parentElement;
        if (!body) return null;
        const cls = body.getAttribute('class') || '';
        if (!RE_BODY_CLASS.test(cls)) return null;

        const root = body.parentElement;
        if (!root) return null;
        const rootCls = root.getAttribute('class') || '';
        if (!RE_ROOT_CLASS.test(rootCls)) return null;

        // root 必须在 flowItem 之下，且与 flowItem 之间只隔着槽位锚点这一层。
        // 不满足就说明结构变了 —— 直接放弃，交给原生渲染。
        if (root === flowItem || !flowItem.contains(root)) return null;
        const between = root.parentElement;
        const plausible =
          between === flowItem ||
          (between !== null && between.hasAttribute('data-slot')) ||
          (between !== null && between.parentElement === flowItem);
        if (!plausible) return null;

        return { body, root };
      }

      /**
       * 在一个 assistant-step 的 flowItem 里找出唯一合法的正文容器。
       * 0 个或多个 → 返回 null（放弃）。
       * @param {Element} flowItem
       * @returns {{body: Element, root: Element}|null}
       */
      function findBodyIn(flowItem) {
        // 闸 2 补充：reasoning 分组不碰（取值域只有 "reasoning" | "response" | 缺失）。
        if (flowItem.getAttribute('data-chat-group-part') === 'reasoning') return null;

        // 候选：宿主自己给「已结束的正文」挂的语义标记。
        // 它只在 settled 且拿到 messageId 时才渲染，所以流式期间天然不命中。
        const all = flowItem.querySelectorAll('[data-text-interaction-source]');
        const hits = [];
        for (const node of all) {
          // 排除思考行（它也被挂了同一个属性）。
          if (node.closest('[data-turn-process-inline]') !== null) continue;
          hits.push(node);
        }
        // 闸 3：必须恰好一个。多个说明这条消息有分段的正文，我们不猜。
        if (hits.length !== 1) return null;

        const confirmed = confirmBody(hits[0], flowItem);
        if (!confirmed) return null;

        // 流式保护：AssistantMarkdown 的根在流式时带 data-streaming。
        if (confirmed.root.hasAttribute('data-streaming')) return null;
        if (confirmed.root.closest('[data-chat-running]') !== null) return null;

        return confirmed;
      }

      /* ───────────────────────── 闸 4：严格解析 ───────────────────────── */

      /**
       * 只接受有明确标签指纹的消息。
       *
       * 'trs'    —— <scene>/<panel>/<char> 规范语法
       * 'legacy' —— <mainbody>/<phone> 旧格式
       * 'loose'  —— ❌ 明确拒绝。「有引号/星号就当正文」正是上一轮误伤普通回复的原因，
       *             这次从根上不要，而不是靠 minSpeech 门槛去挡。
       * @param {{kind:string, syntax:string}} parsed
       * @returns {boolean}
       */
      function isAcceptable(parsed) {
        if (!parsed || parsed.kind !== 'structured') return false;
        return parsed.syntax === 'trs' || parsed.syntax === 'legacy';
      }

      /**
       * 接管门槛：结构化消息要有可看的东西。
       * 有面板块（状态/消息/动态/列表/选项）直接通过；只有正文时要求至少一段对白。
       * @param {object} parsed
       * @param {object} cfg
       * @returns {boolean}
       */
      function passesThreshold(parsed, cfg) {
        const minSpeech = Number(cfg.minSpeech ?? DEFAULTS.minSpeech);
        let speech = 0;
        for (const block of parsed.blocks) {
          if (block.type === 'prose') {
            for (const seg of block.segments) if (seg.kind === 'speech') speech += 1;
          } else if (block.type === 'chars' || block.type === 'status' || block.type === 'choices') {
            return true;
          } else if (block.type === 'social' && block.accounts.length > 0) {
            return true;
          } else if (block.type === 'wechat' && block.messages.length > 0) {
            return true;
          } else if (block.type === 'list' && block.items.length > 0) {
            return true;
          }
        }
        return speech >= minSpeech;
      }

      /* ─────────────────────────── 挂 / 卸 ─────────────────────────── */

      /** 只显示我们的节点，其余原生子节点一律隐藏（不删除）。 */
      const HIDE_CSS = `
[${ATTR_BODY}="1"] > :not([data-dsh-tavern-render]) {
  display: none !important;
}
`;

      /**
       * 把排版结果叠加到一条消息上。
       * 不写宿主的 innerHTML / textContent —— 只追加一个节点 + 打标记。
       * @param {{body: Element, root: Element}} found
       * @param {object} cfg
       * @param {object} ctx
       * @returns {'rendered'|'skipped'|'plain'}
       */
      function renderInto(found, cfg, ctx) {
        const { body } = found;
        if (!body || !body.isConnected) return 'skipped';
        if (body.getAttribute(ATTR_DONE) === '1') return 'rendered';

        // 闸 1：不是酒馆预设，立刻收手。
        if (!isTavernSession(body, cfg, ctx)) return 'skipped';

        const text = body.textContent || '';
        const parsed = parseMessage(text);
        // 闸 4
        if (!isAcceptable(parsed)) return 'plain';
        if (!passesThreshold(parsed, cfg)) return 'plain';

        const html = renderMessage(parsed);
        if (!html) return 'plain';

        const node = body.ownerDocument.createElement('div');
        node.innerHTML = html;
        const painted = node.firstElementChild;
        if (!painted) return 'plain';

        body.appendChild(painted);
        body.setAttribute(ATTR_BODY, '1');
        body.setAttribute(ATTR_DONE, '1');
        body.setAttribute(ATTR_SYNTAX, parsed.syntax || 'trs');
        return 'rendered';
      }

      /**
       * 还原一条消息：删掉我们的节点，摘掉标记。
       * 宿主的子节点从头到尾没被碰过，所以还原后就是原样。
       * @param {Element} body
       */
      function restoreBody(body) {
        if (!body) return;
        for (const node of body.querySelectorAll(':scope > [data-dsh-tavern-render]')) {
          node.remove();
        }
        body.removeAttribute(ATTR_BODY);
        body.removeAttribute(ATTR_DONE);
        body.removeAttribute(ATTR_SYNTAX);
      }

      /* ─────────────────────────── 选项点击发送 ─────────────────────────── */

      /**
       * 把点击翻译成一次真实的用户消息发送。
       *
       * 宿主入口（证据见 docs/SLOT-RESEARCH.md）：
       *   `send()` 在会话作用域的 BoundConversation 上，根服务只有 binding/imageUrl 等。
       *   官方报错文案直接写明了正确取法：
       *     "conversation.send requires a session scope — address one via ctx.sessions.scope(id).conversation"
       *   所以走 `ctx.sessions.scope(sessionId).get('conversation').send(text)`。
       *
       * 安全边界：
       *   · 仍然只在酒馆预设会话里生效（先过闸 1）；
       *   · 任何异常都只 catch 打日志，绝不影响渲染主流程；
       *   · 发送中/完成后给视觉反馈，避免重复点。
       *
       * @param {Element} el 被点的 .tt-choice
       * @param {object} cfg
       * @param {object} ctx
       * @returns {Promise<boolean>} 是否真的发出了
       */
      async function sendChoice(el, cfg, ctx) {
        const text = el.getAttribute('data-tt-send');
        if (!text) return false;
        // 闸 1：不是酒馆预设，不接管交互
        if (!isTavernSession(el, cfg, ctx)) return false;

        const sessionId = sessionIdOf(el);
        if (!sessionId) return false;

        const sessions = ctx && ctx.sessions;
        if (!sessions || typeof sessions.scope !== 'function') {
          console.warn(`${LOG} 无法发送选项：ctx.sessions.scope 不可用`);
          return false;
        }

        let conversation;
        try {
          const scope = sessions.scope(sessionId);
          conversation = scope && typeof scope.get === 'function' ? scope.get('conversation') : undefined;
        } catch (err) {
          console.warn(`${LOG} 取会话作用域失败：`, err);
          return false;
        }
        if (!conversation || typeof conversation.send !== 'function') {
          console.warn(`${LOG} 无法发送选项：会话作用域里没有 conversation.send`);
          return false;
        }

        // 视觉反馈：先锁定，避免连点发两条
        const section = el.closest('.tt-choices');
        const all = section ? Array.from(section.querySelectorAll('.tt-choice')) : [el];
        for (const node of all) {
          node.setAttribute('aria-disabled', 'true');
          node.classList.add('tt-choice-busy');
        }
        el.classList.add('tt-choice-sending');

        try {
          await conversation.send(text);
          el.classList.remove('tt-choice-sending');
          el.classList.add('tt-choice-sent');
          return true;
        } catch (err) {
          console.warn(`${LOG} 发送选项失败：`, err);
          for (const node of all) {
            node.removeAttribute('aria-disabled');
            node.classList.remove('tt-choice-busy');
          }
          el.classList.remove('tt-choice-sending');
          el.classList.add('tt-choice-failed');
          window.setTimeout(() => el.classList.remove('tt-choice-failed'), 1600);
          return false;
        }
      }

      /**
       * 在 document 上挂一个委托监听（只装一次），处理 .tt-choice 的点击/回车。
       * 用委托而不是给每个节点绑事件：我们的排版节点会被反复重建，委托不会漏。
       */
      function installChoiceHandler(cfg, ctx) {
        const onClick = (event) => {
          const target = event.target;
          if (!target || typeof target.closest !== 'function') return;
          const choice = target.closest('.tt-choice[data-tt-send]');
          if (!choice) return;
          // 已经发过/正在发，忽略
          if (choice.classList.contains('tt-choice-sent')
            || choice.classList.contains('tt-choice-sending')
            || choice.getAttribute('aria-disabled') === 'true') return;
          event.preventDefault();
          event.stopPropagation();
          void sendChoice(choice, cfg, ctx);
        };

        const onKey = (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const target = event.target;
          if (!target || typeof target.closest !== 'function') return;
          if (!target.closest('.tt-choice[data-tt-send]')) return;
          event.preventDefault();
          onClick(event);
        };

        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }

      /* ─────────────────────────── apply ─────────────────────────── */

      function apply(ctx, config) {
        const cfg = { ...DEFAULTS, ...(config || {}) };
        const doc = document;

        // 样式：只注入一次。选择器全部以 .tt-* / [data-tt-body] 为根，不外溢。
        let styleEl = doc.getElementById(STYLE_ID);
        if (styleEl === null) {
          styleEl = doc.createElement('style');
          styleEl.id = STYLE_ID;
          styleEl.dataset.plugin = PLUGIN;
          styleEl.textContent = buildCSS() + HIDE_CSS;
          doc.head.appendChild(styleEl);
        }

        let disposed = false;
        let timer = 0;
        /** 见过并可能被我们处理过的 body，用于卸载时还原。 */
        const touched = new Set();
        /** 作用域属性只在「确实渲染了东西」时才挂到 body 上。 */
        let scoped = false;

        const ensureScope = () => {
          if (scoped) return;
          doc.body.setAttribute(SCOPE_ATTR, '');
          scoped = true;
        };

        const releaseScope = () => {
          if (!scoped) return;
          doc.body.removeAttribute(SCOPE_ATTR);
          scoped = false;
        };

        const scan = () => {
          if (disposed) return;

          // 只扫会话内容容器，不扫整个 body。
          const hosts = doc.querySelectorAll('[data-conversation-session]');
          for (const host of hosts) {
            const flowItems = host.querySelectorAll('[data-chat-flow-kind="assistant-step"]');
            for (const flowItem of flowItems) {
              const found = findBodyIn(flowItem);
              if (!found) continue;

              touched.add(found.body);

              if (!cfg.enabled) {
                restoreBody(found.body);
                continue;
              }
              try {
                const outcome = renderInto(found, cfg, ctx);
                if (outcome === 'rendered') ensureScope();
              } catch (err) {
                // 单条消息出错只影响这一条：把残留摘干净，保留原生显示。
                console.warn(`${LOG} 渲染失败，保留原生显示：`, err);
                try { restoreBody(found.body); } catch { /* 已卸载 */ }
              }
            }
          }

          // 关掉开关后，把之前渲染过的也还原。
          if (!cfg.enabled) {
            for (const body of touched) restoreBody(body);
            touched.clear();
            releaseScope();
          }
        };

        const schedule = () => {
          if (disposed || timer) return;
          timer = window.setTimeout(() => {
            timer = 0;
            scan();
          }, 120);
        };

        /**
         * 只观察会话内容区。且忽略「我们自己追加节点」引起的变动（否则会自激）。
         */
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target;
            if (target && target.nodeType === 1 && target.closest
              && target.closest('[data-dsh-tavern-render]') !== null) {
              continue;
            }
            schedule();
            return;
          }
        });

        const observeHosts = () => {
          for (const host of doc.querySelectorAll('[data-conversation-session]')) {
            observer.observe(host, { childList: true, subtree: true });
          }
        };
        observeHosts();
        schedule();

        // 选项点击 → 真实发送。只装一次；卸载时摘掉。
        let removeChoiceHandler = null;
        try {
          removeChoiceHandler = installChoiceHandler(cfg, ctx);
        } catch (err) {
          console.warn(`${LOG} 选项点击功能安装失败（不影响排版）：`, err);
        }

        // 会话是动态挂载的：会话容器本身出现时补一次观察。
        const hostWatch = new MutationObserver(() => {
          observeHosts();
          schedule();
        });
        hostWatch.observe(doc.body, { childList: true, subtree: true });

        ctx.effect(() => () => {
          disposed = true;
          observer.disconnect();
          hostWatch.disconnect();
          if (timer) window.clearTimeout(timer);
          if (removeChoiceHandler) {
            try { removeChoiceHandler(); } catch { /* 已卸载 */ }
            removeChoiceHandler = null;
          }
          for (const body of touched) {
            try { restoreBody(body); } catch { /* 已卸载 */ }
          }
          touched.clear();
          releaseScope();
          // 样式元素留着也无害，但卸载就干净点：只有本插件创建的那一个才删。
          const el = doc.getElementById(STYLE_ID);
          if (el && el.dataset && el.dataset.plugin === PLUGIN) el.remove();
        }, `${PLUGIN}: observer + styles`);

        return { scan };
      }

      return {
        // 只要 sessions：闸 1 靠它读 agentPreset。
        // 不 inject 'slots' —— 本插件不注册任何槽位，少一个依赖就少一处可能挡启动的地方。
        inject: ['sessions'],
        apply,
        // 供测试与调试
        __test: {
          parseMessage,
          renderMessage,
          buildCSS,
          findBodyIn,
          confirmBody,
          isAcceptable,
          passesThreshold,
          isTavernSession,
          presetOf,
          sessionIdOf,
          renderInto,
          restoreBody,
          DEFAULTS,
        },
      };
    },
  });
})();
