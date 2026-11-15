/**
 * 验算：在给定的 scrim 上，各文字色的实际对比度。
 *
 * 关键点：scrim 是半透明的，真实背景是「壁纸」，所以必须先做
 * 合成（alpha compositing），再算对比度。只在纯黑底上算没有意义。
 */

function hex2rgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error('bad hex: ' + h);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lum(rgb) {
  const c = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function ratio(a, b) {
  const L1 = lum(a);
  const L2 = lum(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

/** 把半透明前景合成到背景上。 */
function composite(fg, alpha, bg) {
  return fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));
}

/** 常见的壁纸底色档位（从极暗到极亮）。 */
const WALLPAPERS = {
  '极暗壁纸 #0a0f1c': hex2rgb('#0a0f1c'),
  '深蓝壁纸 #16233d': hex2rgb('#16233d'),
  '中等 #3a4658': hex2rgb('#3a4658'),
  '亮部(窗光) #8a94a6': hex2rgb('#8a94a6'),
  '极亮(纯白) #e8ecf2': hex2rgb('#e8ecf2'),
};

const SCRIMS = {
  'A 柔光 0.46': { color: '#0a0e18', alpha: 0.46 },
  'B 专家 0.68': { color: '#0c101c', alpha: 0.68 },
  'B 加深 0.75': { color: '#0c101c', alpha: 0.75 },
  'D 影调 0.58中': { color: '#080c16', alpha: 0.58 },
};

const TEXTS = {
  旁白: '#d8dee9',
  对白: '#7fd3c4',
  神态原: '#b39ddb',
  神态提亮: '#c4b0e8',
  次要: '#8b95a5',
};

const THRESHOLD = 4.5;

for (const [sname, s] of Object.entries(SCRIMS)) {
  const fg = hex2rgb(s.color);
  console.log(`\n════ ${sname} ════`);
  const header = ['文字', ...Object.keys(WALLPAPERS)];
  console.log('  ' + header.map((h) => h.padEnd(16)).join(''));
  for (const [tname, tcolor] of Object.entries(TEXTS)) {
    const trgb = hex2rgb(tcolor);
    const row = [tname];
    for (const w of Object.values(WALLPAPERS)) {
      const bg = composite(fg, s.alpha, w);
      const r = ratio(trgb, bg);
      const mark = r >= THRESHOLD ? '✓' : '✗';
      row.push(`${r.toFixed(2)} ${mark}`.padEnd(16));
    }
    console.log('  ' + row.map((c) => c.padEnd(16)).join(''));
  }
}

console.log('\n\n════ 反推：要让最亮壁纸也过 4.5，scrim 需要多黑 ════');
const brightest = WALLPAPERS['极亮(纯白) #e8ecf2'];
const fgDark = hex2rgb('#0c101c');
for (const tname of ['旁白', '对白', '神态提亮']) {
  const trgb = hex2rgb(TEXTS[tname]);
  let need = null;
  for (let a = 0.3; a <= 0.9; a += 0.01) {
    const bg = composite(fgDark, a, brightest);
    if (ratio(trgb, bg) >= THRESHOLD) { need = a; break; }
  }
  console.log(`  ${tname} ${TEXTS[tname]}: 需要 alpha >= ${need === null ? '>0.90（达不到）' : need.toFixed(2)}`);
}
