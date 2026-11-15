import fs from 'node:fs';
import { parseMessage, summarize } from '../lib/parse.js';

const texts = JSON.parse(fs.readFileSync('D:/DeepSeek-Workspace/_real.json', 'utf8'));

texts.forEach((t, i) => {
  const p = parseMessage(t);
  console.log(`\n═══ #${i + 1} ═══ syntax=${p.syntax} kind=${p.kind}`);
  console.log('  blocks:', summarize(p).join(' '));
  for (const b of p.blocks) {
    if (b.type === 'chars') console.log('    chars:', b.chars.map((c) => c.name + '(' + c.fields.length + '字段)').join(', '));
    if (b.type === 'status') console.log('    status rows:', b.rows.map((r) => r.name + '[' + r.fields.length + ']').join(', '));
    if (b.type === 'social') console.log('    social:', b.accounts.length);
    if (b.type === 'wechat') console.log('    wechat:', b.messages.length);
    if (b.type === 'choices') console.log('    choices:', b.items.length);
    if (b.type === 'list') console.log('    list', b.variant + ':', b.items.length);
    if (b.type === 'prose') {
      const kinds = {};
      for (const s of b.segments) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
      console.log('    prose(' + b.origin + '):', JSON.stringify(kinds));
    }
  }
  const blocksText = JSON.stringify(p.blocks);
  const leftover = /<\/?(mainbody|phone|status|twitter|wechat|adv|bilibili|prose|panel|scene)[\s>]/i.test(blocksText);
  console.log('  解析结果里残留标签:', leftover);
  if (leftover) {
    const m = blocksText.match(/<\/?(mainbody|phone|status|twitter|wechat|adv|bilibili|prose|panel|scene)[^>]*>/gi);
    console.log('    残留:', [...new Set(m)].join(' '));
  }
});
