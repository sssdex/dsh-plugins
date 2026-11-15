/**
 * dsh-qq-hands 媒体模块测试
 * ---------------------------------------------------------------------------
 * 跑法：node --test test-media.mjs
 *
 * 这里的断言尽量贴近「真实能不能用」：
 *   - SILK 不看长度拍脑袋，直接校验 QQ 要求的 02 23 21 53 49 4c 4b 5f 56 33 头，
 *     并真的 decode() 回来确认不是一段垃圾数据
 *   - 截图校验 JPEG/PNG 魔数、上报宽高与真实字节数一致
 *   - 所有错误分支都断言「抛出带中文说明的错误」，而不是静默返回
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, open } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { probeEnv, synthesizeSilk, audioFileToSilk, captureScreen } from './lib/media.js';
import { decode } from 'silk-wasm';

/** SILK v3 头：QQ 语音的唯一合法开头 */
const SILK_V3_HEAD = Buffer.from('02232153494c4b5f5633', 'hex');
/** JPEG 魔数 FF D8 FF */
const JPEG_MAGIC = Buffer.from('ffd8ff', 'hex');
/** PNG 魔数 89 50 4E 47 0D 0A 1A 0A */
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

const tmpFiles = [];
function tmpPath(name) {
  const p = nodePath.join(os.tmpdir(), `dsh-qq-hands-test-${process.pid}-${name}`);
  tmpFiles.push(p);
  return p;
}

test.after(async () => {
  for (const p of tmpFiles) {
    try {
      await unlink(p);
    } catch {
      /* 已经删过或没创建，无所谓 */
    }
  }
});

/** 用 Silk 的 pcm 现造一个标准 24kHz/16bit/单声道 WAV，用来测 .wav 输入分支 */
async function makeWavFromSilk(silkBuffer) {
  const { data: pcm } = await decode(silkBuffer, 24000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt 块长度
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(24000, 24); // 采样率
  header.writeUInt32LE(24000 * 2, 28); // 字节率
  header.writeUInt16LE(2, 32); // 块对齐
  header.writeUInt16LE(16, 34); // 位深
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

// ── 1) probeEnv ─────────────────────────────────────────────────────────────

test('probeEnv：能探测到 PowerShell、SAPI 中文女声、silk-wasm 版本', async () => {
  const env = await probeEnv();

  assert.equal(typeof env.powershell, 'string', '应当探测到可用的 PowerShell');
  assert.ok(env.powershell.length > 0, 'PowerShell 命令名不应为空');
  assert.match(env.powershell, /pwsh|powershell/i, 'PowerShell 命令名看起来不对劲');

  assert.ok(Array.isArray(env.voices), 'voices 必须是数组');
  assert.ok(env.voices.length >= 1, '系统里应当至少有一个 SAPI 语音');
  assert.ok(
    env.voices.every((v) => typeof v === 'string' && v.length > 0),
    'voices 里必须全是非空字符串',
  );
  assert.ok(
    env.voices.some((v) => /Huihui|Yaoyao|Kangkang|zh/i.test(v)),
    '应当找到中文语音',
  );

  // 中文女声排在最前面（Huihui Desktop / Yaoyao 优先）
  assert.match(env.voices[0], /Huihui|Yaoyao|Xiaoxiao/i, `首个语音应为中文女声，实际是 ${env.voices[0]}`);
  const firstMaleIdx = env.voices.findIndex((v) => /Kangkang|Male/i.test(v));
  const firstFemaleZhIdx = env.voices.findIndex((v) => /Huihui|Yaoyao/i.test(v));
  if (firstMaleIdx !== -1) {
    assert.ok(
      firstFemaleZhIdx === -1 || firstFemaleZhIdx < firstMaleIdx,
      '中文女声应当排在中文男声前面',
    );
  }

  assert.equal(typeof env.ffmpeg, 'boolean', 'ffmpeg 必须是布尔值');
  assert.equal(env.silkWasm, '3.7.1', `silk-wasm 版本应为 3.7.1，实际 ${env.silkWasm}`);
});

// ── 2) synthesizeSilk ───────────────────────────────────────────────────────

test('synthesizeSilk：中文合成出合法 SILK v3，头部正确且体积合理', async () => {
  const result = await synthesizeSilk({ text: '主人你好，这是一条语音测试消息。' });

  assert.ok(Buffer.isBuffer(result.silk), 'silk 必须是 Buffer');
  assert.ok(result.silk.length > 2000, `silk 应当大于 2000 字节，实际 ${result.silk.length}`);
  assert.deepEqual(
    result.silk.subarray(0, SILK_V3_HEAD.length),
    SILK_V3_HEAD,
    `SILK 头部必须是 ${SILK_V3_HEAD.toString('hex')}，实际 ${result.silk
      .subarray(0, SILK_V3_HEAD.length)
      .toString('hex')}`,
  );

  assert.ok(result.durationMs > 1000, `时长应当大于 1 秒，实际 ${result.durationMs}ms`);
  assert.ok(result.durationMs < 60000, `时长不该超过 60 秒，实际 ${result.durationMs}ms`);
  assert.ok(result.wavBytes > 1000, `WAV 字节数应当大于 1000，实际 ${result.wavBytes}`);
  assert.match(result.voice, /Huihui|Yaoyao|Xiaoxiao|zh/i, `默认应当选中文女声，实际 ${result.voice}`);
  assert.equal(result.text, '主人你好，这是一条语音测试消息。', 'text 应当原样回显');

  // 真的能解码回来，证明不是拼出来的假数据
  const decoded = await decode(result.silk, 24000);
  assert.ok(decoded.data.length > 0, 'SILK 应当能解码出 PCM');
  assert.ok(
    Math.abs(decoded.duration - result.durationMs) < 500,
    `解码时长(${decoded.duration}) 与上报时长(${result.durationMs}) 偏差过大`,
  );
});

test('synthesizeSilk：支持指定语音、语速偏高、音量调小', async () => {
  const env = await probeEnv();
  const voice = env.voices.find((v) => /Huihui Desktop/i.test(v)) || env.voices[0];

  const result = await synthesizeSilk({
    text: '语速和音量参数测试。',
    voice,
    rate: 4,
    volume: 60,
  });

  assert.deepEqual(result.silk.subarray(0, SILK_V3_HEAD.length), SILK_V3_HEAD);
  assert.ok(result.silk.length > 2000);
  assert.equal(result.voice.toLowerCase(), voice.toLowerCase(), '应当使用指定语音');
});

test('synthesizeSilk：非法参数抛出中文错误', async () => {
  await assert.rejects(() => synthesizeSilk({}), /语音文本不能为空/, '空文本应当报错');
  await assert.rejects(() => synthesizeSilk({ text: '   ' }), /语音文本不能为空/, '纯空白应当报错');
  await assert.rejects(() => synthesizeSilk({ text: 123 }), /语音文本不能为空/, '非字符串应当报错');

  // 300 字上限
  await assert.rejects(
    () => synthesizeSilk({ text: '好'.repeat(301) }),
    /语音文本过长（301 字），最多 300 字/,
    '超长文本应当报错',
  );

  await assert.rejects(
    () => synthesizeSilk({ text: '测试', rate: 11 }),
    /rate 必须是 -10 到 10 之间的整数/,
    'rate 越界应当报错',
  );
  await assert.rejects(
    () => synthesizeSilk({ text: '测试', rate: -11 }),
    /rate 必须是 -10 到 10 之间的整数/,
    'rate 下越界应当报错',
  );
  await assert.rejects(
    () => synthesizeSilk({ text: '测试', volume: 101 }),
    /volume 必须是 0 到 100 之间的整数/,
    'volume 越界应当报错',
  );
  await assert.rejects(
    () => synthesizeSilk({ text: '测试', voice: 'Microsoft NotInstalled Voice' }),
    /未安装。可用语音：/,
    '不存在的语音应当报错并列出可用语音',
  );
});

// ── 3) captureScreen ────────────────────────────────────────────────────────

test('captureScreen：默认出 JPEG，宽高与字节数自洽', async () => {
  const shot = await captureScreen({});

  assert.equal(shot.format, 'jpg', '默认格式应当是 jpg');
  assert.ok(Buffer.isBuffer(shot.data), 'data 必须是 Buffer');
  assert.deepEqual(shot.data.subarray(0, 3), JPEG_MAGIC, 'JPEG 魔数不对（FF D8 FF）');
  assert.ok(shot.width > 0 && shot.height > 0, `宽高应当为正，实际 ${shot.width}x${shot.height}`);
  assert.ok(shot.bytes > 1000, `图片字节数应当大于 1000，实际 ${shot.bytes}`);
  assert.equal(shot.bytes, shot.data.length, 'bytes 必须等于 data.length');
  // 默认 maxWidth=1600，屏幕再宽也会被压到 1600
  assert.ok(shot.width <= 1600, `默认应当缩到 1600 以内，实际宽 ${shot.width}`);
  assert.ok(shot.sourceWidth >= shot.width, '原始宽度不应小于输出宽度');
  assert.ok(shot.height > 100, `高度看起来不对：${shot.height}`);
});

test('captureScreen：PNG + region 裁剪，尺寸精确', async () => {
  const shot = await captureScreen({
    format: 'png',
    region: '100,120,400,300',
    maxWidth: 1600,
    delayMs: 50,
  });

  assert.equal(shot.format, 'png');
  assert.deepEqual(shot.data.subarray(0, 8), PNG_MAGIC, 'PNG 魔数不对');
  assert.equal(shot.width, 400, `裁剪宽度应当是 400，实际 ${shot.width}`);
  assert.equal(shot.height, 300, `裁剪高度应当是 300，实际 ${shot.height}`);
  assert.equal(shot.bytes, shot.data.length);
  assert.ok(shot.bytes > 1000);
});

test('captureScreen：maxWidth 生效且等比缩放；0 表示不缩放', async () => {
  const scaled = await captureScreen({ maxWidth: 800 });
  assert.ok(scaled.width <= 800, `应当缩到 800 以内，实际 ${scaled.width}`);
  // 等比：输出宽高比与原始宽高比一致（容许 1px 取整误差）
  const srcRatio = scaled.sourceWidth / scaled.sourceHeight;
  const outRatio = scaled.width / scaled.height;
  assert.ok(Math.abs(srcRatio - outRatio) < 0.02, `宽高比不该变形：${srcRatio} vs ${outRatio}`);

  const full = await captureScreen({ maxWidth: 0 });
  assert.equal(full.width, full.sourceWidth, 'maxWidth=0 时应当保持原始宽度');
  assert.equal(full.height, full.sourceHeight, 'maxWidth=0 时应当保持原始高度');
});

test('captureScreen：非法 region 忽略并继续全屏；非法参数报中文错误', async () => {
  // 非法 region 不报错，退回全屏（宽高比原始屏幕）
  for (const region of ['abc', '1,2,3', '-5,-5,0,0', '1,2,3,4,5', { x: 'a', y: 0, w: 10, h: 10 }]) {
    const shot = await captureScreen({ region, maxWidth: 400 });
    assert.ok(shot.width > 0 && shot.height > 0, `非法 region(${region}) 应当退回全屏`);
    assert.ok(shot.width <= 400);
  }

  await assert.rejects(
    () => captureScreen({ format: 'gif' }),
    /不支持的图片格式「gif」，只支持 png \/ jpg/,
    '不支持的格式应当报错',
  );
  await assert.rejects(
    () => captureScreen({ display: -1 }),
    /display 必须是非负整数/,
    '负的 display 应当报错',
  );
  await assert.rejects(
    () => captureScreen({ display: 'abc' }),
    /display 必须是非负整数/,
    '非法 display 应当报错',
  );
  await assert.rejects(
    () => captureScreen({ maxWidth: -1 }),
    /maxWidth 必须是非负整数/,
    '负的 maxWidth 应当报错',
  );
});

test('captureScreen：display 越界回落主屏而不是崩掉', async () => {
  const shot = await captureScreen({ display: 9, maxWidth: 320 });
  assert.ok(shot.width > 0 && shot.height > 0, '越界 display 应当回落主屏成功截图');
  assert.ok(shot.width <= 320);
});

// ── 4) audioFileToSilk ──────────────────────────────────────────────────────

test('audioFileToSilk：.silk 原样返回并校验头部', async () => {
  const tts = await synthesizeSilk({ text: '音频文件转码测试。' });
  const silkPath = tmpPath('input.silk');
  await writeFile(silkPath, tts.silk);

  const result = await audioFileToSilk({ path: silkPath });
  assert.deepEqual(result.silk, tts.silk, '.silk 应当原样返回');
  assert.deepEqual(result.silk.subarray(0, SILK_V3_HEAD.length), SILK_V3_HEAD);
  assert.equal(result.via, 'silk');
  assert.ok(result.durationMs > 0, '应当能算出 SILK 时长');
  assert.ok(
    Math.abs(result.durationMs - tts.durationMs) < 500,
    `SILK 时长(${result.durationMs}) 与合成时(${tts.durationMs}) 应接近`,
  );

  // 假装成 silk 的垃圾文件要报错
  const fakePath = tmpPath('fake.silk');
  await writeFile(fakePath, Buffer.from('not a silk file at all', 'utf8'));
  await assert.rejects(
    () => audioFileToSilk({ path: fakePath }),
    /不是有效的 SILK 文件/,
    '头部不对的 .silk 应当报错',
  );
});

test('audioFileToSilk：.wav 直接吃 data 段编码成 SILK', async () => {
  const tts = await synthesizeSilk({ text: '音频文件转码测试。' });
  const wavPath = tmpPath('input.wav');
  const wav = await makeWavFromSilk(tts.silk);
  await writeFile(wavPath, wav);

  const result = await audioFileToSilk({ path: wavPath });
  assert.deepEqual(result.silk.subarray(0, SILK_V3_HEAD.length), SILK_V3_HEAD);
  assert.equal(result.via, 'wav');
  assert.ok(result.silk.length > 2000, `silk 应当大于 2000 字节，实际 ${result.silk.length}`);
  assert.ok(
    Math.abs(result.durationMs - tts.durationMs) < 500,
    `WAV 转出的时长(${result.durationMs}) 应接近原始(${tts.durationMs})`,
  );

  const back = await decode(result.silk, 24000);
  assert.ok(back.data.length > 0, '转出来的 SILK 应当能解码');
});

test('audioFileToSilk：文件不存在 / 空路径 / 超大 / 不支持的格式都抛中文错误', async () => {
  await assert.rejects(
    () => audioFileToSilk({ path: 'C:/definitely/not/here.wav' }),
    /音频文件不存在/,
  );
  await assert.rejects(() => audioFileToSilk({}), /音频路径不能为空/);
  await assert.rejects(() => audioFileToSilk({ path: '   ' }), /音频路径不能为空/);

  // 21MB 稀疏文件：超过 20MB 上限
  const bigPath = tmpPath('big.wav');
  await writeFile(bigPath, Buffer.alloc(1024));
  const fh = await open(bigPath, 'r+');
  try {
    await fh.truncate(21 * 1024 * 1024);
  } finally {
    await fh.close();
  }
  await assert.rejects(() => audioFileToSilk({ path: bigPath }), /音频文件过大（21\.0MB），最多 20MB/);

  const weirdPath = tmpPath('weird.xyz');
  await writeFile(weirdPath, Buffer.alloc(64));
  await assert.rejects(() => audioFileToSilk({ path: weirdPath }), /不支持的音频格式「\.xyz」/);
});

/** 用 ffmpeg 造一段 1 秒 440Hz 正弦波，作为转码输入 */
async function makeSineWithFfmpeg(filePath, { channels = 1, codecArgs = [] } = {}) {
  const { spawn } = await import('node:child_process');
  // ffmpeg 可能不在 PATH（本机就是），必须用探测到的真实路径来造测试音频
  const env = await probeEnv();
  const bin = env.ffmpegPath || 'ffmpeg';
  await new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
       '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
       '-ac', String(channels), ...codecArgs, filePath],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`造测试音频失败（ffmpeg exit ${code}）：${stderr.slice(0, 300)}`)),
    );
  });
}

test('audioFileToSilk：mp3/ogg/flac/m4a 与立体声 WAV（无 ffmpeg 时给出清晰指引）', async () => {
  const env = await probeEnv();
  const exts = ['mp3', 'ogg', 'flac', 'm4a'];

  if (!env.ffmpeg) {
    // 本机没有 ffmpeg：每一种都必须是「说清原因 + 给出替代方案」的中文错误，不能 500 也不能静默
    for (const ext of exts) {
      const p = tmpPath(`input.${ext}`);
      await writeFile(p, Buffer.alloc(2048));
      await assert.rejects(
        () => audioFileToSilk({ path: p }),
        new RegExp(`没有检测到 ffmpeg.*\\.${ext}.*请安装 ffmpeg`),
        `${ext} 在没有 ffmpeg 时应当给出清晰指引`,
      );
    }

    // 立体声 WAV 不借 ffmpeg 就没法降成单声道，同样要说得明白
    const stereo = tmpPath('stereo.wav');
    await writeFile(stereo, await makeWavFromSilk((await synthesizeSilk({ text: '测试' })).silk));
    // 上面这个其实是单声道，手工把它改成 2 声道让分支真的命中
    const stereoBuf = await readFile(stereo);
    stereoBuf.writeUInt16LE(2, 22);
    stereoBuf.writeUInt32LE(24000 * 4, 28);
    stereoBuf.writeUInt16LE(4, 32);
    await writeFile(stereo, stereoBuf);
    await assert.rejects(
      () => audioFileToSilk({ path: stereo }),
      /该 WAV 是 2 声道.*本机没有检测到 ffmpeg/s,
      '立体声 WAV 缺 ffmpeg 时应当解释清楚',
    );
    return;
  }

  // 有 ffmpeg：真转码，每种格式都要产出合法 SILK 且时长接近 1 秒
  const codecs = {
    mp3: ['-c:a', 'libmp3lame', '-b:a', '64k'],
    ogg: ['-c:a', 'libvorbis'],
    flac: ['-c:a', 'flac'],
    m4a: ['-c:a', 'aac', '-b:a', '64k'],
  };

  for (const ext of exts) {
    const p = tmpPath(`input.${ext}`);
    await makeSineWithFfmpeg(p, { channels: 2, codecArgs: codecs[ext] });
    const result = await audioFileToSilk({ path: p });
    assert.equal(result.via, 'ffmpeg', `${ext} 应当走 ffmpeg 分支`);
    assert.deepEqual(
      result.silk.subarray(0, SILK_V3_HEAD.length),
      SILK_V3_HEAD,
      `${ext} 转出的 SILK 头部不对`,
    );
    assert.ok(result.silk.length > 1000, `${ext} 转出的 silk 太小：${result.silk.length}`);
    assert.ok(
      Math.abs(result.durationMs - 1000) < 400,
      `${ext} 转出时长应当接近 1000ms，实际 ${result.durationMs}ms`,
    );
    const back = await decode(result.silk, 24000);
    assert.ok(back.data.length > 0, `${ext} 转出的 SILK 应当能解码`);
  }

  // 立体声 44.1kHz WAV：本该直接吃，但声道/采样率不合规 → 自动重采样
  const stereo = tmpPath('stereo.wav');
  await makeSineWithFfmpeg(stereo, { channels: 2, codecArgs: ['-c:a', 'pcm_s16le'] });
  const stereoResult = await audioFileToSilk({ path: stereo });
  assert.equal(stereoResult.via, 'ffmpeg', '立体声 WAV 应当走 ffmpeg 重采样');
  assert.deepEqual(stereoResult.silk.subarray(0, SILK_V3_HEAD.length), SILK_V3_HEAD);
  assert.ok(Math.abs(stereoResult.durationMs - 1000) < 400);
});
