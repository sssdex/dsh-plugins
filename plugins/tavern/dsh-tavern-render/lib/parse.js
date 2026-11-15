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
export function esc(text) {
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
export function scrubUnknownTags(text) {
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
export function parseAttrs(source) {
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
export function splitProse(text) {
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
export function parseChars(body) {
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
export function parseStatusRows(body) {
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
export function classifyStatusField(value, index) {
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

export function parseChat(body) {
  const messages = [];
  eachTag(body, 'msg', (inner, parsed) => {
    const text = norm(stripTags(inner));
    if (!text) return null;
    messages.push({ from: parsed.attrs?.from || '', text });
    return null;
  });
  return messages;
}

export function parseFeed(body) {
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

export function parseListItems(body) {
  return eachTag(body, 'item', (inner) => norm(stripTags(inner)) || null);
}

export function parseOptions(body) {
  return eachTag(body, 'opt', (inner) => norm(stripTags(inner)) || null);
}

export function parseInfo(body) {
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
export function parsePeachhub(body) {
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

export function parseWechat(body) {
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

export function parseChoices(body) {
  return String(body ?? '')
    .split(/<br\s*\/?>|\n|\|/gi)
    .map((s) => norm(s))
    .filter(Boolean);
}

export function parseLines(body) {
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

export function parseSocial(body) {
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
export function parseMessage(raw) {
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
export function parseTrs(body) {
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
export function parsePhone(body) {
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
export function parseLoose(text) {
  const segments = splitProse(norm(text));
  const hasSpeech = segments.some((s) => s.kind === 'speech');
  const hasAction = segments.some((s) => s.kind === 'action');
  if (!hasSpeech && !hasAction) return [];
  return [{ type: 'prose', segments, origin: 'loose' }];
}

/** 调试摘要。 */
export function summarize(parsed) {
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
