/**
 * 渲染器：把 parse.js 的结构化结果转成 HTML 字符串。
 *
 * 所有动态文本都经 esc() 转义；这里只产出「受控的语义标签」，
 * 样式全部交给 styles.js 里的 CSS 变量控制，换主题不用改这里。
 */

import { esc, classifyStatusField } from './parse.js';

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
export function renderMessage(parsed, opts = {}) {
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
