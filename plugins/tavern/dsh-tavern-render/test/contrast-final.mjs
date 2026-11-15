/**
 * 验证提亮后的次要色在各档壁纸上的表现（深色主题）。
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
  深色: hex2rgb('#16233d'),
  中等: hex2rgb('#5a6470'),
  亮: hex2rgb('#c9d2de'),
  纯白: hex2rgb('#ffffff'),
};

const CANDIDATES = ['#97a4b6', '#a8b5c7', '#b6c2d4', '#c3cddc'];
const ALPHA = 0.75;

console.log(`深色主题 · alpha ${ALPHA} · 次要信息色候选\n`);
console.log('  颜色      | ' + Object.keys(WALLS).map((k) => k.padEnd(11)).join(''));
for (const c of CANDIDATES) {
  const row = [];
  let worst = 99;
  for (const w of Object.values(WALLS)) {
    const bg = composite(hex2rgb('#0e111c'), ALPHA, w);
    const r = ratio(hex2rgb(c), bg);
    worst = Math.min(worst, r);
    row.push(`${r.toFixed(2)}${r >= 4.5 ? '✓' : '✗'}`.padEnd(11));
  }
  console.log(`  ${c}  | ` + row.join('') + `  最差 ${worst.toFixed(2)}`);
}

console.log('\n════ 全部文字色在「纯白壁纸」上的最终检查（alpha 0.75）════\n');
const bgWhite = composite(hex2rgb('#0e111c'), ALPHA, WALLS['纯白']);
const FINAL = {
  旁白: '#eef2f8',
  对白: '#e0b878',
  神态: '#c4b0e8',
  次要: '#b6c2d4',
  暖色: '#e5b567',
};
for (const [n, c] of Object.entries(FINAL)) {
  const r = ratio(hex2rgb(c), bgWhite);
  console.log(`  ${n.padEnd(4)} ${c}: ${r.toFixed(2)} ${r >= 4.5 ? '✓' : '✗'}`);
}
