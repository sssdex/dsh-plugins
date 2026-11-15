/**
 * dsh-qq-hands 媒体模块
 * ---------------------------------------------------------------------------
 * 只做三件「用系统现成能力就能做对」的事，不引入任何新依赖：
 *   1) SAPI 文本转语音 → WAV → SILK v3（QQ 官方机器人语音只认 SILK）
 *   2) 已有音频文件（wav/silk/mp3/m4a/ogg/flac）→ SILK v3
 *   3) 屏幕截图 → PNG / JPEG（可裁剪、缩放）
 *
 * 几个踩过的坑，写在最前面免得以后又踩：
 *   - SAPI 默认吐 22.05kHz / 16bit 立体声的 WAV，而 silk-wasm 的 encode()
 *     只接受 8000/12000/16000/24000/32000/44100/48000 这几档采样率，
 *     所以必须显式用 SpeechAudioFormatInfo 强制 24000Hz / 16bit / 单声道。
 *   - encode() 要的是「裸 PCM」，不是整个 WAV 文件；直接塞 WAV 文件进去
 *     会把 44 字节头当成噪声编进去。所以要用 getWavFileInfo() 找到 data 段。
 *   - 截屏必须用 Screen.AllScreens[i].Bounds 取尺寸，不能硬编码分辨率：
 *     这台机器开了 DPI 缩放（1707x1067 是虚拟化后的逻辑像素），
 *     而 CopyFromScreen 用的也是同一套虚拟化坐标，两边一致才能截全。
 *   - Windows PowerShell 5.1 读 .ps1 时按 ANSI 解码、控制台输出也按 OEM 码页，
 *     中文会乱。所以我们用 -EncodedCommand（UTF-16LE base64）传脚本，
 *     用户数据（文本、声音名、区域）一律走 UTF-8 的 JSON 配置文件，
 *     结果也写 UTF-8 JSON 文件回读 —— 既躲开编码问题，也彻底没有注入面。
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import os from 'node:os';
import nodePath from 'node:path';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** SILK v3 文件头：\x02#!SILK_V3。QQ 语音必须是这个开头 */
const SILK_V3_HEAD = Buffer.from('02232153494c4b5f5633', 'hex');
/** 更老的 SILK 头（\x02#!SILK，不带 _V3），QQ 也认，读旧文件时放行 */
const SILK_LOOSE_HEAD = Buffer.from('02232153494c4b', 'hex');

/** silk-wasm encode() 支持的采样率档位（见其 index.d.ts） */
const SILK_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 32000, 44100, 48000]);

/** SILK 编码统一用 24kHz：比 8k 明显好听，又在 QQ 与 silk-wasm 都支持的档位内 */
const TTS_SAMPLE_RATE = 24000;

/** 单条语音文本上限（QQ 语音本身有时长限制，300 字约 60~90 秒，够用且不会撑爆） */
const MAX_TTS_CHARS = 300;

/** 音频文件大小上限，超过直接拒，避免把内存/接口撑爆 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** 截屏最长边默认压到 1600：QQ 图片再大也会被压，先压省流量也省时间 */
const DEFAULT_MAX_WIDTH = 1600;

/** 默认 JPEG 质量 */
const DEFAULT_JPEG_QUALITY = 88;

/** 截屏前最长等待（防止调用方传入离谱的延迟把工具卡死） */
const MAX_DELAY_MS = 10000;

/** SAPI 女声优先顺序：Huihui Desktop 音质最好，其次 Yaoyao、Huihui */
const VOICE_PREFERENCE = [
  'Microsoft Huihui Desktop',
  'Microsoft Yaoyao',
  'Microsoft Huihui',
  'Microsoft Xiaoxiao',
  'Microsoft Xiaoyi',
];

const PS_BASE_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// ── silk-wasm 懒加载 ────────────────────────────────────────────────────────

let silkModulePromise = null;

/**
 * 懒加载 silk-wasm。
 * 理由：silk 的 wasm 模块初始化有固定开销，只在真要编码时才付这笔钱；
 * 而且 silk-wasm 缺失时插件其余功能（截图）仍然可用。
 */
function loadSilk() {
  if (!silkModulePromise) {
    silkModulePromise = import('silk-wasm').catch((err) => {
      silkModulePromise = null;
      throw new Error(
        `无法加载 silk-wasm：${err?.message || err}（请确认插件目录 node_modules 内已安装 silk-wasm）`,
      );
    });
  }
  return silkModulePromise;
}

// ── 通用小工具 ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpFile(prefix, ext) {
  return nodePath.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}${ext}`,
  );
}

async function safeUnlink(p) {
  if (!p) return;
  try {
    await unlink(p);
  } catch {
    /* 临时文件删不掉不影响主流程 */
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** 把 stderr/stdout 压成一句话，用于错误信息摘要（不刷屏） */
function summarize(text, limit = 300) {
  if (!text) return '';
  const flat = String(text).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const joined = flat.join(' | ');
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined;
}

async function readJsonFile(p) {
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 杀掉进程树。Windows 上 child.kill() 常常只杀到 PowerShell 外壳，孙进程会漏，用 taskkill /T */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出了 */
  }
  if (process.platform === 'win32' && child.pid) {
    try {
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      tk.on('error', () => {});
      tk.unref?.();
    } catch {
      /* 尽力而为 */
    }
  }
}

/**
 * 跑一个外部进程，带超时与强制杀进程。
 * 注意：全程不经过 shell，argv 逐个传参，不做字符串拼接。
 */
function runProcess(cmd, args, { timeoutMs = 60000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (err) {
      reject(new Error(`无法启动进程 ${cmd}：${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const done = (fn, payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(payload);
    };

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      done(reject, new Error(`无法启动进程 ${cmd}：${err.message}`));
    });
    child.on('close', (code) => {
      done(resolve, { code: code ?? -1, stdout, stderr });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        done(
          reject,
          new Error(`进程 ${cmd} 执行超时（${timeoutMs}ms），已强制结束`),
        );
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

/** 快速判断某命令是否可用（用于 ffmpeg 这类可选依赖） */
async function commandWorks(cmd, args, timeoutMs = 8000) {
  try {
    const res = await runProcess(cmd, args, { timeoutMs });
    return res.code === 0;
  } catch {
    return false;
  }
}

// ── PowerShell 探测与调用 ───────────────────────────────────────────────────

/** PowerShell 脚本里通用的收尾片段：把结果写成 UTF-8 JSON 文件（绕开控制台码页问题） */
const PS_COMMON_HEAD = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$resultPath = $env:DSH_MEDIA_RESULT
function Write-Result($obj) {
  try {
    $json = $obj | ConvertTo-Json -Compress -Depth 8
    [System.IO.File]::WriteAllText($resultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}
function Read-Cfg() {
  $cfgPath = $env:DSH_MEDIA_CFG
  if ([string]::IsNullOrEmpty($cfgPath)) { throw '缺少配置环境变量 DSH_MEDIA_CFG' }
  $raw = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{} }
  return ($raw | ConvertFrom-Json)
}
function Fail($msg) {
  Write-Result @{ ok = $false; error = [string]$msg }
  try { [Console]::Error.WriteLine([string]$msg) } catch { }
  exit 1
}
`;

/** 探测 PowerShell 本身（要个只有 ASCII 的极简脚本，避免任何编码风险） */
const PS_VERSION_SCRIPT = `[Console]::Out.WriteLine($PSVersionTable.PSVersion.ToString())`;

/** 列出 SAPI 已安装语音 */
const PS_VOICES_SCRIPT = `${PS_COMMON_HEAD}
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $list = @()
  try {
    foreach ($v in $synth.GetInstalledVoices()) {
      $info = $v.VoiceInfo
      $list += [pscustomobject]@{
        name = [string]$info.Name
        culture = [string]$info.Culture.Name
        gender = [string]$info.Gender.ToString()
        enabled = [bool]$v.Enabled
      }
    }
  } finally {
    $synth.Dispose()
  }
  Write-Result @{ ok = $true; voices = $list }
} catch {
  Fail $_.Exception.Message
}
`;

/**
 * SAPI 合成 WAV。
 * 只做「说一句话、吐一个 wav 文件」，SILK 编码交给 Node 侧的 silk-wasm —— 
 * 这样 PowerShell 里没有二进制/RPC 粘合，出错也容易定位。
 */
const PS_TTS_SCRIPT = `${PS_COMMON_HEAD}
try {
  $cfg = Read-Cfg
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $usedVoice = ''
  try {
    $wantVoice = [string]$cfg.voice
    if (-not [string]::IsNullOrWhiteSpace($wantVoice)) { $synth.SelectVoice($wantVoice) }
    $synth.Rate = [int]$cfg.rate
    $synth.Volume = [int]$cfg.volume
    $usedVoice = [string]$synth.Voice.VoiceInfo.Name
    # 24000Hz / 16bit / 单声道：silk 支持档位内，音质与体积折中最优
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
      24000,
      [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
      [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile([string]$cfg.outWav, $fmt)
    $synth.Speak([string]$cfg.text)
  } finally {
    $synth.Dispose()
  }
  Write-Result @{ ok = $true; voice = $usedVoice }
} catch {
  Fail $_.Exception.Message
}
`;

/**
 * 截屏脚本。
 * 关键点：Screen.AllScreens 取到的 Bounds 与 Graphics.CopyFromScreen 使用的
 * 是同一套坐标（本进程非 DPI-aware，Windows 会统一虚拟化），所以不要
 * SetProcessDPIAware，否则两者坐标体系不一致，截出来的图会错位/缺块。
 */
const PS_SCREEN_SCRIPT = `${PS_COMMON_HEAD}
try {
  $cfg = Read-Cfg
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $screens = [System.Windows.Forms.Screen]::AllScreens
  $index = [int]$cfg.display
  if ($index -lt 0 -or $index -ge $screens.Count) {
    # 索引越界回落主屏（不是 AllScreens[0]，多屏时 0 号不一定是主屏）
    $target = [System.Windows.Forms.Screen]::PrimaryScreen
    $index = -1
  } else {
    $target = $screens[$index]
  }

  $b = $target.Bounds
  $x = [int]$b.X
  $y = [int]$b.Y
  $w = [int]$b.Width
  $h = [int]$b.Height

  # 可选区域裁剪：先和屏幕矩形求交，交集为空就当没传（继续全屏）
  if ($null -ne $cfg.region) {
    $rx = [int]$cfg.region.x
    $ry = [int]$cfg.region.y
    $rw = [int]$cfg.region.w
    $rh = [int]$cfg.region.h
    $x1 = [Math]::Max($x, $rx)
    $y1 = [Math]::Max($y, $ry)
    $x2 = [Math]::Min($x + $w, $rx + $rw)
    $y2 = [Math]::Min($y + $h, $ry + $rh)
    if (($x2 -gt $x1) -and ($y2 -gt $y1)) {
      $x = $x1; $y = $y1; $w = $x2 - $x1; $h = $y2 - $y1
    }
  }

  if ($w -le 0 -or $h -le 0) { throw '屏幕尺寸异常，无法截屏' }

  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    } finally {
      $g.Dispose()
    }
  } catch {
    $bmp.Dispose()
    throw
  }

  $capturedW = $w
  $capturedH = $h
  $final = $bmp

  # 超过 maxWidth 就等比缩小；HighQualityBicubic 是为了文字/UI 边缘不出锯齿
  $maxW = [int]$cfg.maxWidth
  if ($maxW -gt 0 -and $w -gt $maxW) {
    $nw = $maxW
    $nh = [int][Math]::Round(($h * $maxW) / $w)
    if ($nh -lt 1) { $nh = 1 }
    $scaled = New-Object System.Drawing.Bitmap($nw, $nh)
    $g2 = [System.Drawing.Graphics]::FromImage($scaled)
    try {
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g2.DrawImage($bmp, 0, 0, $nw, $nh)
    } catch {
      $g2.Dispose()
      $scaled.Dispose()
      $bmp.Dispose()
      throw
    }
    $g2.Dispose()
    $final = $scaled
  }

  $outW = [int]$final.Width
  $outH = [int]$final.Height
  try {
    if ([string]$cfg.format -eq 'png') {
      $final.Save([string]$cfg.outFile, [System.Drawing.Imaging.ImageFormat]::Png)
    } else {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' } |
        Select-Object -First 1
      if ($null -eq $codec) { throw '系统缺少 JPEG 编码器' }
      $pars = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $pars.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, [long]$cfg.quality)
      try {
        $final.Save([string]$cfg.outFile, $codec, $pars)
      } finally {
        $pars.Dispose()
      }
    }
  } finally {
    if (-not [object]::ReferenceEquals($final, $bmp)) { $final.Dispose() }
    $bmp.Dispose()
  }

  Write-Result @{
    ok = $true
    width = $outW
    height = $outH
    sourceWidth = $capturedW
    sourceHeight = $capturedH
    x = $x
    y = $y
    display = $index
  }
} catch {
  Fail $_.Exception.Message
}
`;

/** PowerShell 脚本用 -EncodedCommand 传：UTF-16LE base64，与码页、引号、换行全部无关 */
function encodePsCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(exe, script, { timeoutMs = 30000, env = null } = {}) {
  return runProcess(exe, [...PS_BASE_ARGS, '-EncodedCommand', encodePsCommand(script)], {
    timeoutMs,
    env,
  });
}

// ── 环境探测缓存 ────────────────────────────────────────────────────────────

let powershellCache; // undefined=未探测 / null=没有 / string=可用命令
let voiceCache; // 语音明细（含 culture/gender）
let ffmpegProbe; // undefined=未探测 / false / string=可用的 ffmpeg 命令

async function detectPowerShell(refresh = false) {
  if (!refresh && powershellCache !== undefined) return powershellCache;
  const candidates = ['pwsh', 'powershell.exe', 'powershell'];
  for (const exe of candidates) {
    try {
      const res = await runPowerShell(exe, PS_VERSION_SCRIPT, { timeoutMs: 15000 });
      if (res.code === 0 && res.stdout.trim()) {
        powershellCache = exe;
        return exe;
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  powershellCache = null;
  return null;
}

async function requirePowerShell() {
  const exe = await detectPowerShell();
  if (!exe) {
    throw new Error('未找到可用的 PowerShell（pwsh / powershell.exe），无法调用系统 SAPI 或截屏');
  }
  return exe;
}

/** 跑一个「读 JSON 配置 → 做活 → 写 JSON 结果」的 PowerShell 脚本 */
async function runPowerShellJson(script, config, { timeoutMs = 30000 } = {}) {
  const exe = await requirePowerShell();
  const cfgPath = tmpFile('dsh-qq-hands-cfg', '.json');
  const resultPath = tmpFile('dsh-qq-hands-res', '.json');
  try {
    await writeFile(cfgPath, JSON.stringify(config ?? {}), 'utf8');
    const run = await runPowerShell(exe, script, {
      timeoutMs,
      env: { DSH_MEDIA_CFG: cfgPath, DSH_MEDIA_RESULT: resultPath },
    });
    const result = await readJsonFile(resultPath);
    if (run.code !== 0 || !result || result.ok !== true) {
      // 结果文件里的错误是 UTF-8 原文（控制台的可能是乱码），优先用它
      const detail =
        (result && result.error) || summarize(run.stderr) || summarize(run.stdout) ||
        `PowerShell 退出码 ${run.code}`;
      throw new Error(detail);
    }
    return result;
  } finally {
    await safeUnlink(cfgPath);
    await safeUnlink(resultPath);
  }
}

/** 常见但没有进 PATH 的 ffmpeg 位置：本机实测 D:\弹弹play 与 LegionZone 各带一个。 */
const FFMPEG_FALLBACK_PATHS = [
  process.env.DSH_QQ_HANDS_FFMPEG,
  'D:\\弹弹play\\ffmpeg\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
].filter(Boolean);

async function detectFfmpeg(refresh = false) {
  if (!refresh && ffmpegProbe !== undefined) return ffmpegProbe;
  for (const cmd of ['ffmpeg', 'ffmpeg.exe']) {
    if (await commandWorks(cmd, ['-version'])) {
      ffmpegProbe = cmd;
      return cmd;
    }
  }
  // PATH 里没有就再找几个常见落点：弹弹play / 联想 LegionZone 都会自带 ffmpeg。
  for (const file of FFMPEG_FALLBACK_PATHS) {
    if (file && existsSync(file)) {
      ffmpegProbe = file;
      return file;
    }
  }
  ffmpegProbe = false;
  return false;
}

function detectSilkWasmVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('silk-wasm/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'not-installed';
  }
}

function voiceRank(v) {
  const culture = String(v?.culture || '').toLowerCase();
  const gender = String(v?.gender || '').toLowerCase();
  const zh = culture.startsWith('zh');
  if (zh && gender === 'female') return 0;
  if (zh) return 1;
  return 2;
}

function voicePreference(name) {
  const idx = VOICE_PREFERENCE.findIndex(
    (p) => p.toLowerCase() === String(name || '').toLowerCase(),
  );
  return idx === -1 ? 999 : idx;
}

/** 中文女声排前面，尤其 Huihui Desktop / Yaoyao；同档再按名字稳定排序 */
function sortVoices(list) {
  return [...list].sort((a, b) => {
    const r = voiceRank(a) - voiceRank(b);
    if (r !== 0) return r;
    const p = voicePreference(a.name) - voicePreference(b.name);
    if (p !== 0) return p;
    return String(a.name).localeCompare(String(b.name));
  });
}

/** 取语音明细（含 culture/gender），一次进程内只查一次 */
async function getVoiceDetails(refresh = false) {
  if (!refresh && voiceCache) return voiceCache;
  let result;
  try {
    result = await runPowerShellJson(PS_VOICES_SCRIPT, {}, { timeoutMs: 20000 });
  } catch (err) {
    throw new Error(`读取系统语音列表失败：${err.message}`);
  }
  const raw = Array.isArray(result.voices) ? result.voices : result.voices ? [result.voices] : [];
  voiceCache = sortVoices(raw.filter((v) => v && v.enabled !== false));
  return voiceCache;
}

/**
 * 挑默认声音或校验指定声音。
 * voice 指定时按「完全同名 → 忽略大小写同名 → 包含匹配」逐级放宽，
 * 都不中就报错并列出可用声音 —— 悄悄换成别的声音会让调用方以为生效了。
 */
async function resolveVoice(wanted) {
  const details = await getVoiceDetails();
  const names = details.map((v) => v.name);
  if (names.length === 0) {
    throw new Error('系统里没有任何可用的 SAPI 语音，请先在「设置 → 时间和语言 → 语音」安装中文语音');
  }

  const want = typeof wanted === 'string' ? wanted.trim() : '';
  if (want) {
    const lower = want.toLowerCase();
    const exact = details.find((v) => String(v.name).toLowerCase() === lower);
    if (exact) return exact.name;
    const partial = details.find((v) => String(v.name).toLowerCase().includes(lower));
    if (partial) return partial.name;
    throw new Error(
      `指定的语音「${want}」未安装。可用语音：${names.join('、')}`,
    );
  }

  // 缺省：优先 VOICE_PREFERENCE 里排前的（已排序，取第一个中文女声即可）
  const preferred = details.find((v) => voicePreference(v.name) !== 999);
  if (preferred) return preferred.name;
  const zhFemale = details.find((v) => voiceRank(v) === 0);
  if (zhFemale) return zhFemale.name;
  return details[0].name;
}

// ── WAV 解析与 SILK 编码核心 ────────────────────────────────────────────────

/**
 * 从 WAV 里抽出 data 段的裸 PCM。
 * silk-wasm 的 getWavFileInfo 能正确处理带 LIST/fact 等额外 chunk 的文件，
 * 比手写 offset 44 稳。
 */
async function wavToSilk(wavBuffer, label) {
  const silk = await loadSilk();
  let info;
  try {
    info = silk.getWavFileInfo(wavBuffer);
  } catch (err) {
    throw new Error(`${label} WAV 文件格式无法识别：${err?.message || err}`);
  }

  const dataChunk = (info.chunkInfo || []).find((c) => c.chunkId === 'data');
  if (!dataChunk || !(dataChunk.dataLength > 0)) {
    throw new Error(`${label} WAV 里没有找到有效的 data 段（可能是空音频）`);
  }

  const sampleRate = Number(info.fmt?.sampleRate);
  if (!SILK_SAMPLE_RATES.has(sampleRate)) {
    throw new Error(
      `${label} 采样率 ${sampleRate}Hz 不被 SILK 支持，请先转成 8000/12000/16000/24000Hz`,
    );
  }

  const pcm = wavBuffer.subarray(
    dataChunk.dataOffset,
    dataChunk.dataOffset + dataChunk.dataLength,
  );

  let encoded;
  try {
    encoded = await silk.encode(pcm, sampleRate);
  } catch (err) {
    throw new Error(`${label} SILK 编码失败：${err?.message || err}`);
  }

  const silkBuffer = Buffer.from(encoded.data.buffer, encoded.data.byteOffset, encoded.data.length);
  if (!silkBuffer.subarray(0, SILK_LOOSE_HEAD.length).equals(SILK_LOOSE_HEAD)) {
    throw new Error(`${label} SILK 编码结果头部异常（不是 QQ 可识别的 SILK 格式）`);
  }

  // encode() 的 duration 偶发为 0，退回用 PCM 长度估算（16bit 单声道 = 2 字节/采样点）
  const bytesPerFrame = Number(info.fmt?.bytesPerFrame) > 0 ? Number(info.fmt.bytesPerFrame) : 2;
  const estimated = Math.round((pcm.length / bytesPerFrame / sampleRate) * 1000);
  const durationMs = Number.isFinite(encoded.duration) && encoded.duration > 0
    ? Math.round(encoded.duration)
    : estimated;

  return { silk: silkBuffer, durationMs, pcmBytes: pcm.length, sampleRate };
}

function assertSilkBuffer(buffer, label) {
  if (buffer.length < SILK_LOOSE_HEAD.length) {
    throw new Error(`${label}不是有效的 SILK 文件（长度过短）`);
  }
  if (!buffer.subarray(0, SILK_LOOSE_HEAD.length).equals(SILK_LOOSE_HEAD)) {
    throw new Error(`${label}不是有效的 SILK 文件（头部应为 02 23 21 53 49 4c 4b）`);
  }
}

// ── 1) probeEnv ─────────────────────────────────────────────────────────────

/**
 * 探测运行环境。
 * 结果在进程内缓存（语音/ffmpeg 不会随时变），但仍保留 refresh 入口方便排查。
 */
export async function probeEnv(opts = {}) {
  const refresh = Boolean(opts && opts.refresh);
  const powershell = await detectPowerShell(refresh);
  const ffmpegCmd = await detectFfmpeg(refresh);

  let voices = [];
  if (powershell) {
    try {
      voices = (await getVoiceDetails(refresh)).map((v) => v.name);
    } catch {
      voices = []; // 语音探测失败不该让整个 probeEnv 炸掉，调用方看空数组就知道
    }
  }

  return {
    powershell,
    voices,
    ffmpeg: Boolean(ffmpegCmd),
    // 顺手把实际用的 ffmpeg 路径给出去：它可能不在 PATH 里，
    // 测试和排障要自己造音频时不能再去 spawn 裸 'ffmpeg'。
    ffmpegPath: ffmpegCmd || '',
    silkWasm: detectSilkWasmVersion(),
  };
}

// ── 2) synthesizeSilk ───────────────────────────────────────────────────────

/**
 * 文本 → SILK v3。
 * @param {{ text: string, voice?: string, rate?: number, volume?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ silk: Buffer, durationMs: number, wavBytes: number, voice: string, text: string }>}
 */
/**
 * SAPI 合成：离线兜底路径。
 * 优点是完全本地、零网络依赖；缺点是 Huihui/Yaoyao 是拼接式合成，语调平、断句硬。
 * 所以它只在 Edge 不可用时兜底（见下面的 synthesizeSilk）。
 */
async function synthesizeSapiSilk(opts = {}) {
  const options = opts || {};

  if (typeof options.text !== 'string' || options.text.trim() === '') {
    throw new Error('语音文本不能为空');
  }
  const text = options.text.trim();
  // 用码点计数，避免 emoji/生僻字被算成两个字符
  const charCount = Array.from(text).length;
  if (charCount > MAX_TTS_CHARS) {
    throw new Error(`语音文本过长（${charCount} 字），最多 ${MAX_TTS_CHARS} 字，请拆成多条发送`);
  }

  const rateRaw = options.rate === undefined || options.rate === null ? 0 : options.rate;
  const rate = Math.trunc(Number(rateRaw));
  if (!Number.isFinite(rate) || rate < -10 || rate > 10) {
    throw new Error('rate 必须是 -10 到 10 之间的整数（SAPI 语速档位）');
  }

  const volumeRaw = options.volume === undefined || options.volume === null ? 100 : options.volume;
  const volume = Math.trunc(Number(volumeRaw));
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
    throw new Error('volume 必须是 0 到 100 之间的整数');
  }

  const timeoutMs = clampInt(options.timeoutMs, 1000, 180000, 60000);
  const voice = await resolveVoice(options.voice);

  const wavPath = tmpFile('dsh-qq-hands-tts', '.wav');
  try {
    let result;
    try {
      result = await runPowerShellJson(
        PS_TTS_SCRIPT,
        { text, voice, rate, volume, outWav: wavPath },
        { timeoutMs },
      );
    } catch (err) {
      throw new Error(`SAPI 语音合成失败：${err.message}`);
    }

    let wavBuffer;
    try {
      wavBuffer = await readFile(wavPath);
    } catch (err) {
      throw new Error(`SAPI 语音合成失败：没有生成 WAV 文件（${err.message}）`);
    }
    if (wavBuffer.length <= 44) {
      throw new Error('SAPI 语音合成失败：生成的 WAV 是空音频（请检查文本是否只有空白或符号）');
    }

    const encoded = await wavToSilk(wavBuffer, '语音合成');

    return {
      silk: encoded.silk,
      durationMs: encoded.durationMs,
      wavBytes: wavBuffer.length,
      voice: String(result.voice || voice),
      text,
      engine: 'sapi',
    };
  } finally {
    await safeUnlink(wavPath);
  }
}

/**
 * Edge 神经网络语音：真·少女音的来源。
 *
 * 参数换算（两套引擎的档位语义不同，这里统一到 SAPI 的对外语义）：
 *   - rate   -10..10 档  →  Edge 百分比，每档 4%（0 档交给音色自带的预设）
 *   - volume 0..100      →  Edge 的 -100%..0%（100 就是原音量）
 *   - voice  只把长得像 Edge 音色名的传下去；'Microsoft Huihui Desktop' 这类 SAPI 名字忽略
 */
async function synthesizeEdgeSilk(options) {
  const { synthesizeSilkEdge } = await import('./tts-edge.js');
  const text = String(options.text || '').trim();
  const voiceWanted = typeof options.voice === 'string' ? options.voice.trim() : '';
  const looksEdgeVoice = /^(zh|en|ja|ko)-|xiaoyi|xiaoxiao|xiaobei|xiaoni|yunxia/i.test(voiceWanted);
  const rateNumber = options.rate === undefined || options.rate === null ? NaN : Number(options.rate);
  const volumeNumber = options.volume === undefined || options.volume === null ? NaN : Number(options.volume);
  const result = await synthesizeSilkEdge({
    text,
    ...(looksEdgeVoice ? { voice: voiceWanted } : {}),
    ...(Number.isFinite(rateNumber) ? { rate: `${Math.round(rateNumber * 4)}%` } : {}),
    ...(Number.isFinite(volumeNumber) ? { volume: `${Math.round(volumeNumber - 100)}%` } : {}),
    ...(options.timeoutMs ? { timeoutMs: clampInt(options.timeoutMs, 5000, 180000, 90000) } : {}),
  });
  return {
    silk: result.silk,
    durationMs: result.durationMs,
    // wavBytes 的语义是「喂给编码器的原始音频字节数」：
    // Edge 链路没有 WAV 中间文件，就用解出来的 PCM 字节，量的口径保持一致。
    wavBytes: result.pcmBytes || 0,
    voice: result.voice,
    voiceId: result.voiceId || '',
    text,
    engine: 'edge',
    mp3Bytes: result.mp3Bytes || 0,
  };
}

/**
 * 文本 → SILK v3（对外统一入口）。
 *
 * 默认先走 Edge 神经网络语音（晓伊 / 晓晓，真少女音），失败才回落到 SAPI：
 * edge-tts 没装、断网、或者主人显式指定 engine:'sapi' 时都走兜底，
 * 而且兜底结果里会带 engine/edgeError，排查时不用猜。
 *
 * @param {{ text: string, voice?: string, rate?: number, volume?: number, timeoutMs?: number, engine?: 'auto'|'edge'|'sapi' }} opts
 * @returns {Promise<{ silk: Buffer, durationMs: number, wavBytes: number, voice: string, text: string, engine: string }>}
 */
export async function synthesizeSilk(opts = {}) {
  const options = opts || {};
  // 参数校验放在分发之前：两个引擎的边界和文案必须一致，
  // 否则换个引擎就换一套报错，调用方和测试都会被绕晕。
  if (typeof options.text !== 'string' || options.text.trim() === '') {
    throw new Error('语音文本不能为空');
  }
  const charCount = Array.from(options.text.trim()).length;
  if (charCount > MAX_TTS_CHARS) {
    throw new Error(`语音文本过长（${charCount} 字），最多 ${MAX_TTS_CHARS} 字，请拆成多条发送`);
  }
  const rateCheck = options.rate === undefined || options.rate === null ? 0 : Math.trunc(Number(options.rate));
  if (!Number.isFinite(rateCheck) || rateCheck < -10 || rateCheck > 10) {
    throw new Error('rate 必须是 -10 到 10 之间的整数（SAPI 语速档位）');
  }
  const volumeCheck = options.volume === undefined || options.volume === null ? 100 : Math.trunc(Number(options.volume));
  if (!Number.isFinite(volumeCheck) || volumeCheck < 0 || volumeCheck > 100) {
    throw new Error('volume 必须是 0 到 100 之间的整数');
  }

  let engine = String(options.engine || 'auto').toLowerCase();
  if (engine !== 'sapi' && engine !== 'edge') engine = 'auto';
  const voiceWanted = typeof options.voice === 'string' ? options.voice.trim() : '';
  // 主人显式点名 SAPI 音色（Microsoft xxx）时尊重他的选择，别偷偷换成 Edge。
  if (engine === 'auto' && /^microsoft\s/i.test(voiceWanted)) engine = 'sapi';

  if (engine === 'sapi') return synthesizeSapiSilk(options);

  try {
    return await synthesizeEdgeSilk(options);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    if (engine === 'edge') throw new Error(`Edge 语音合成失败：${reason}`);
    // auto：Edge 挂了就静默回落 SAPI，但把原因带回去，别让主人以为还是老声音没换。
    const fallback = await synthesizeSapiSilk(options);
    fallback.edgeError = reason;
    return fallback;
  }
}

// ── 3) audioFileToSilk ──────────────────────────────────────────────────────

const FFMPEG_INPUT_EXTS = new Set(['.mp3', '.m4a', '.ogg', '.flac', '.amr', '.aac', '.wma', '.opus', '.webm']);

/** 用 ffmpeg 转成 24000Hz/16bit/单声道 WAV（SILK 最舒服的输入） */
async function ffmpegToWav(inputPath, outWav, timeoutMs) {
  const ffmpegCmd = await detectFfmpeg();
  if (!ffmpegCmd) {
    throw new Error(
      '本机没有检测到 ffmpeg，无法转换 mp3/m4a/ogg/flac 等格式。请安装 ffmpeg 并加入 PATH，或改用 .wav / .silk 文件',
    );
  }
  let res;
  try {
    res = await runProcess(
      ffmpegCmd,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', inputPath,
        '-ar', String(TTS_SAMPLE_RATE),
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        outWav,
      ],
      { timeoutMs },
    );
  } catch (err) {
    throw new Error(`ffmpeg 转换失败：${err.message}`);
  }
  if (res.code !== 0) {
    throw new Error(`ffmpeg 转换失败（退出码 ${res.code}）：${summarize(res.stderr) || '未知原因'}`);
  }
}

/**
 * 已有音频文件 → SILK v3。
 * @param {{ path: string, timeoutMs?: number }} opts
 * @returns {Promise<{ silk: Buffer, durationMs: number, source: string }>}
 */
export async function audioFileToSilk(opts = {}) {
  const options = opts || {};
  const rawPath = options.path;
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('音频路径不能为空');
  }
  const filePath = nodePath.resolve(rawPath.trim());

  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`音频文件不存在：${filePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`音频路径不是文件：${filePath}`);
  }
  if (info.size > MAX_AUDIO_BYTES) {
    const mb = (info.size / 1024 / 1024).toFixed(1);
    throw new Error(`音频文件过大（${mb}MB），最多 20MB`);
  }
  if (info.size === 0) {
    throw new Error(`音频文件是空的：${filePath}`);
  }

  const ext = nodePath.extname(filePath).toLowerCase();
  const timeoutMs = clampInt(options.timeoutMs, 1000, 300000, 120000);

  // .silk：原样返回，只校验头部（可能是别的工具生成的旧版头，也放行）
  if (ext === '.silk') {
    const buffer = await readFile(filePath);
    assertSilkBuffer(buffer, '该文件');
    let durationMs = 0;
    try {
      const silk = await loadSilk();
      const d = silk.getDuration(buffer);
      if (Number.isFinite(d) && d > 0) durationMs = Math.round(d);
    } catch {
      durationMs = 0; // 时长算不出来不算致命，QQ 端自己会算
    }
    return { silk: buffer, durationMs, source: filePath, via: 'silk' };
  }

  // .wav：单声道且采样率被支持时直接吃 data 段，否则借 ffmpeg 重采样
  if (ext === '.wav') {
    const buffer = await readFile(filePath);
    const silkMod = await loadSilk();
    let wavInfo = null;
    try {
      wavInfo = silkMod.getWavFileInfo(buffer);
    } catch (err) {
      throw new Error(`WAV 文件格式无法识别：${err?.message || err}`);
    }
    const channels = Number(wavInfo.fmt?.numberOfChannels);
    const sampleRate = Number(wavInfo.fmt?.sampleRate);
    const bits = Number(wavInfo.fmt?.bitsPerSample);
    const formatCode = Number(wavInfo.fmt?.formatCode);

    const directOk =
      channels === 1 && bits === 16 && formatCode === 1 && SILK_SAMPLE_RATES.has(sampleRate);

    if (directOk) {
      const encoded = await wavToSilk(buffer, '该音频');
      return { silk: encoded.silk, durationMs: encoded.durationMs, source: filePath, via: 'wav' };
    }

    // 立体声 / 非 16bit PCM / 非常见采样率 → 交给 ffmpeg 规范化
    const ffmpegCmd = await detectFfmpeg();
    if (!ffmpegCmd) {
      throw new Error(
        `该 WAV 是 ${channels} 声道 / ${bits}bit / ${sampleRate}Hz，SILK 需要单声道 16bit 且采样率为 8000/12000/16000/24000Hz。` +
          '本机没有检测到 ffmpeg，无法自动转换，请先自行转成 24000Hz 单声道 WAV',
      );
    }
    const converted = tmpFile('dsh-qq-hands-wav', '.wav');
    try {
      await ffmpegToWav(filePath, converted, timeoutMs);
      const convBuffer = await readFile(converted);
      const encoded = await wavToSilk(convBuffer, '该音频');
      return {
        silk: encoded.silk,
        durationMs: encoded.durationMs,
        source: filePath,
        via: 'ffmpeg',
      };
    } finally {
      await safeUnlink(converted);
    }
  }

  // 其它格式：必须 ffmpeg
  if (!FFMPEG_INPUT_EXTS.has(ext) && ext !== '') {
    throw new Error(`不支持的音频格式「${ext}」，支持 .silk / .wav / .mp3 / .m4a / .ogg / .flac`);
  }

  const ffmpegCmd = await detectFfmpeg();
  if (!ffmpegCmd) {
    throw new Error(
      `本机没有检测到 ffmpeg，无法把 ${ext || '该文件'} 转成 SILK。请安装 ffmpeg 并加入 PATH，或改用 .wav / .silk 文件`,
    );
  }

  const converted = tmpFile('dsh-qq-hands-wav', '.wav');
  try {
    await ffmpegToWav(filePath, converted, timeoutMs);
    const convBuffer = await readFile(converted);
    const encoded = await wavToSilk(convBuffer, '该音频');
    return { silk: encoded.silk, durationMs: encoded.durationMs, source: filePath, via: 'ffmpeg' };
  } finally {
    await safeUnlink(converted);
  }
}

// ── 4) captureScreen ────────────────────────────────────────────────────────

function normalizeImageFormat(raw) {
  if (raw === undefined || raw === null || raw === '') return 'jpg';
  const value = String(raw).trim().toLowerCase().replace(/^image\//, '');
  if (value === 'png') return 'png';
  if (value === 'jpg' || value === 'jpeg' || value === 'jpe') return 'jpg';
  throw new Error(`不支持的图片格式「${raw}」，只支持 png / jpg`);
}

/**
 * 解析 region：'x,y,w,h'（也兼容 {x,y,w,h} 对象）。
 * 非法时返回 null 表示「忽略该参数、继续全屏」，而不是报错中断截屏 ——
 * 截一张全屏图总比什么都不发好。
 */
function parseRegion(raw) {
  if (raw === undefined || raw === null || raw === '') return null;

  let nums;
  if (typeof raw === 'string') {
    const parts = raw.split(',').map((s) => s.trim());
    if (parts.length !== 4) return null;
    nums = parts.map((p) => Number(p));
  } else if (typeof raw === 'object') {
    nums = [Number(raw.x), Number(raw.y), Number(raw.w ?? raw.width), Number(raw.h ?? raw.height)];
  } else {
    return null;
  }

  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums.map((n) => Math.trunc(n));
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * 截屏。
 * @param {{ display?: number, region?: string|object, delayMs?: number,
 *           format?: 'png'|'jpg', quality?: number, maxWidth?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ data: Buffer, format: 'png'|'jpg', width: number, height: number, bytes: number }>}
 */
export async function captureScreen(opts = {}) {
  const options = opts || {};

  let display = 0;
  if (options.display !== undefined && options.display !== null && options.display !== '') {
    const n = Math.trunc(Number(options.display));
    if (!Number.isFinite(n) || n < 0) {
      throw new Error('display 必须是非负整数（显示器索引，0 开始）');
    }
    display = n;
  }

  const format = normalizeImageFormat(options.format);
  const quality = clampInt(options.quality, 1, 100, DEFAULT_JPEG_QUALITY);
  const delayMs = clampInt(options.delayMs, 0, MAX_DELAY_MS, 0);

  let maxWidth = DEFAULT_MAX_WIDTH;
  if (options.maxWidth !== undefined && options.maxWidth !== null && options.maxWidth !== '') {
    const n = Math.trunc(Number(options.maxWidth));
    if (!Number.isFinite(n) || n < 0) {
      throw new Error('maxWidth 必须是非负整数（0 表示不缩放）');
    }
    maxWidth = n;
  }

  const region = parseRegion(options.region);
  const timeoutMs = clampInt(options.timeoutMs, 1000, 120000, 30000);

  // 截屏本身很快，delayMs 是给「等页面渲染/动画停下来」用的
  if (delayMs > 0) await sleep(delayMs);

  const outFile = tmpFile('dsh-qq-hands-shot', format === 'png' ? '.png' : '.jpg');
  try {
    let result;
    try {
      result = await runPowerShellJson(
        PS_SCREEN_SCRIPT,
        { display, region, format, quality, maxWidth, outFile },
        { timeoutMs },
      );
    } catch (err) {
      throw new Error(`截屏失败：${err.message}`);
    }

    let data;
    try {
      data = await readFile(outFile);
    } catch (err) {
      throw new Error(`截屏失败：没有生成图片文件（${err.message}）`);
    }
    if (data.length === 0) {
      throw new Error('截屏失败：生成的图片是空文件');
    }

    const width = clampInt(result.width, 1, 100000, 0);
    const height = clampInt(result.height, 1, 100000, 0);
    if (!width || !height) {
      throw new Error('截屏失败：系统没有返回有效的图片尺寸');
    }

    return {
      data,
      format,
      width,
      height,
      bytes: data.length,
      sourceWidth: clampInt(result.sourceWidth, 1, 100000, width),
      sourceHeight: clampInt(result.sourceHeight, 1, 100000, height),
      display: clampInt(result.display, 0, 64, display),
    };
  } finally {
    await safeUnlink(outFile);
  }
}
