/**
 * 深色主题 + 极亮壁纸 = 最坏组合的实际验算。
 *
 * 这是真实会发生的：用户开着深色主题，但选了一张很亮的壁纸。
 * 之前只按「深色主题 + 深色壁纸」验证，漏了这一档。
 */
function hex2rgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
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
  const L1 = lum(a), L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}
function composite(fg, alpha, bg) {
  return fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));
}

const WALLS = {
  深色壁纸: hex2rgb('#16233d'),
  中等壁纸: hex2rgb('#5a6470'),
  亮壁纸: hex2rgb('#c9d2de'),
  纯白: hex2rgb('#ffffff'),
};

const TEXTS_DARK = {
  旁白: '#eef2f8',
  对白: '#e0b878',
  神态: '#c4b0e8',
  次要: '#97a4b6',
};

console.log('════ 深色主题文字 #eef2f8 等，在不同 alpha 垫底上 ════\n');
console.log('  alpha | ' + Object.keys(WALLS).map((k) => k.padEnd(12)).join(''));
for (const alpha of [0.68, 0.72, 0.75, 0.80, 0.85, 0.9]) {
  const row = [];
  for (const w of Object.values(WALLS)) {
    // 垫底色取渐变中间那档 rgba(14,17,28)
    const bg = composite(hex2rgb('#0e111c'), alpha, w);
    const r = ratio(hex2rgb('#eef2f8'), bg);
    row.push(`${r.toFixed(2)}${r >= 4.5 ? '✓' : '✗'}`.padEnd(12));
  }
  console.log(`  ${alpha.toFixed(2)}  | ` + row.join(''));
}

console.log('\n════ 每档 alpha 下，最差的那个文字色 ════\n');
for (const alpha of [0.75, 0.8, 0.85, 0.9]) {
  let worst = { r: 99, name: '', wall: '' };
  for (const [wname, w] of Object.entries(WALLS)) {
    const bg = composite(hex2rgb('#0e111c'), alpha, w);
    for (const [tname, tc] of Object.entries(TEXTS_DARK)) {
      const r = ratio(hex2rgb(tc), bg);
      if (r < worst.r) worst = { r, name: tname, wall: wname };
    }
  }
  console.log(`  alpha ${alpha.toFixed(2)} → 最差 ${worst.name} @ ${worst.wall}: ${worst.r.toFixed(2)} ${worst.r >= 4.5 ? '✓' : '✗'}`);
}

console.log('\n════ 结论 ════');
console.log('  深色主题 + 纯白壁纸是最坏组合。要让它也过 4.5，需要较高的 alpha。');
console.log('  但 alpha 太高会盖死壁纸 → 更合理的做法是：检测到极亮壁纸时，');
console.log('  切换到「浅色垫底 + 深色文字」，而不是一味压暗。');
