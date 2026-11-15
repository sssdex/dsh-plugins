/**
 * dsh-asar-tools — 让 ASAR 归档可被检索。
 *
 * ## 为什么需要它
 *
 * DSH 桌面版的实现全部在 `resources\app.asar` 里，那是一个单体归档文件。
 * `read` 能穿透它（Electron 主进程给 fs 打了 asar 补丁），但 `glob` / `grep`
 * 不行：那两个工具把路径交给独立的原生 `rg.exe`，它不认识 asar，一律
 * `IO error ... (os error 3)`。于是模型既不能列目录、也不能搜内容，只能靠
 * 猜路径 —— 这条链在实际使用里会稳定地浪费好几轮。
 *
 * ## 做法
 *
 * 不依赖 Electron 补丁：asar 的布局是公开的 ——
 *
 *     [8 字节 pickle 头][headerSize 字节 JSON 头][数据区]
 *     header.files 是目录树，文件节点的 offset 相对于数据区起点
 *
 * 所以标题/搜索都能纯 Node 实现，任何进程都能跑，包括宿主里的插件。
 * 内容按 `headerSize + 8 + offset` 直接定位读取，只读需要的字节。
 *
 * ## 与外置成员的区别
 *
 * 归档里有 1666 个 `unpacked: true` 的条目（LibreOffice 二进制、许可证等），
 * 它们的字节不在归档里，而在 `app.asar.unpacked\` 下的真实文件中。这类条目
 * 必须拼另一个根，否则读到的是错误内容 —— 这是本项目早期版本踩过的缺口。
 *
 * @module dsh-asar-tools
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-asar-tools'
export const inject = ['tools']

/** asar 头部 JSON 的硬上限：超过它说明读错了东西，不该继续分配内存。 */
const MAX_HEADER_BYTES = 64 * 1024 * 1024

/** 单次返回的最大行数 / 最大字节，避免把整个归档灌进上下文。 */
const MAX_MATCHES = 200
const MAX_HITS_PER_FILE = 5
/**
 * 单次扫描读取的字节上限。
 *
 * 放宽到 24 MB 是实测需要：`dsh/desktop-runtime.json` 有 4.7 MB，它是 DSH 的
 * 运行时清单（插件、模型、预设都在里面），恰恰是最需要搜的文件之一。
 * 早期把它跟「2 MB 以上算打包产物」一起跳过，等于把最有价值的目标漏掉了。
 */
const MAX_FILE_BYTES_FOR_SCAN = 24 * 1024 * 1024

/** 单次 render 输出的字符上限，防止把几十万字符灌进上下文。 */
const MAX_RENDER_CHARS = 20000

/**
 * 扫描时每处理多少个文件让出一次事件循环。
 *
 * 实测：设为 200 时，6 秒的扫描期间 100ms 定时器只触发 21 次（期望 60），
 * 说明单批仍然太长；改为 50 后响应性明显改善，而 setImmediate 的调度开销
 * 在 2 万文件规模上可忽略。
 */
const YIELD_EVERY_FILES = 50

/**
 * 默认跳过的目录前缀：这些树里是原生二进制与体积大户，搜源码时没有价值。
 *
 * 注意：只在**文件较大**时按目录跳过，不能整棵树一刀切 —— 同一棵
 * `libreoffice-kit-win32-x64/` 下还有 licenses/*.txt 这类小文本，
 * 一刀切会让「搜许可证文本」静默返回 0 命中，看起来像文件不存在。
 */
const DEFAULT_EXCLUDE_DIRS = [
  '/libreoffice-kit-win32-x64/',
  '/sherpa-onnx',
  '/@img/',
  '/@vscode/ripgrep',
  '/node-pty/',
  '/@koromix/',
  '/koffi/',
  '/@swc/',
  '/node-gyp-build/',
]

/** 超过这个大小的文件即便在源码树里也跳过：多半是打包产物或资源。 */
const LARGE_FILE_BYTES = 2 * 1024 * 1024

/**
 * 读取并校验 asar 头部。
 *
 * ## 头部布局（实测，别凭记忆改）
 *
 *     offset 0  uint32LE = 4             pickle 前缀
 *     offset 4  uint32LE = headerPickleSize   整个 header pickle 的长度
 *     offset 8  uint32LE = jsonSize + 3  （string size，含对齐/长度前缀）
 *     offset 12 uint32LE = jsonSize      JSON 字节长度
 *     offset 16          JSON 正文开始
 *     数据区起点 = 8 + headerPickleSize
 *
 * 关键坑：**数据区起点必须用 offset 4 的 headerPickleSize，不能用 offset 12
 * 的 jsonSize**。两者相差 11 字节（pickle 元数据与对齐填充）。早期版本用了
 * jsonSize，导致每个成员的读取都提前 11 字节、头部残留混进内容 —— 搜中段
 * 字符串仍能命中，所以测试没暴露；用「首个成员首字节」才验出来。
 *
 * ## 为什么不用 fs.openSync 打开归档本身
 *
 * DSH 桌面版运行在 Electron 里，主进程给 `fs` 打了 **asar 补丁**：任何形如
 * `*.asar` 的路径都被解释成「归档的虚拟根目录」，而不是磁盘文件。于是
 * `fs.statSync('...\app.asar')` 返回 **size = 0**，`fs.openSync('...\app.asar')`
 * 直接抛 `ENOENT` —— 尽管这个文件在磁盘上明明是 209 MB。
 *
 * 这个差异只在宿主进程内出现：同样的代码在普通 node 里一切正常。所以
 * **单测全绿、实机全废**，必须用下面的绕法。
 *
 * 绕法：先用 `realpath` 把 `app.asar` 解析到**不带 .asar 后缀的等价路径**，
 * 让补丁层认不出来，再按普通文件读。Windows 上先用 `resolvedAliasPath`
 * 行不通时退回 `\\?\` 长路径前缀，最后退回原路径。
 *
 * @param asarPath - 归档绝对路径。
 * @returns 目录树、数据区起点、归档总大小，以及实际可用的读取路径。
 */
async function readHeader(asarPath) {
  // 首选 Electron 的 original-fs（绕过 asar 虚拟化的官方通道）；
  // 它不可用时退到硬链接镜像 / realpath / 长路径 / 原路径。
  const ofs = await originalFs()
  if (ofs !== null) {
    try {
      const fd = ofs.openSync(asarPath, 'r')
      try {
        const stat = ofs.fstatSync(fd)
        if (stat.isFile() && stat.size > 16) return parseHeader(fd, ofs, asarPath, stat.size, asarPath)
      } finally { ofs.closeSync(fd) }
    } catch { /* original-fs 打不开，继续回退 */ }
  }

  const real = physicalPathOf(asarPath)

  let fd
  try {
    fd = fs.openSync(real, 'r')
  } catch (error) {
    throw new Error(`无法打开归档 ${asarPath}：${error.code ?? error.message}。`
      + ` 已尝试的读取路径：${real}。`
      + ' 若运行在 Electron 里，说明 asar 补丁层把该路径当归档目录处理，'
      + ' 且硬链接镜像与 original-fs 都不可用。')
  }
  try {
    const stat = fs.fstatSync(fd)
    if (stat.size <= 16) {
      throw new Error(`无法把 ${asarPath} 当普通文件读取（fstat size=${stat.size}，读取路径 ${real}）。`
        + ' 若运行在 Electron 里，说明 asar 补丁层仍把它当归档目录处理。')
    }
    return parseHeader(fd, fs, asarPath, stat.size, real)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 从已打开的 fd 解析头部。fd 由调用方负责关闭。
 * @param fd - 已打开的文件描述符。
 * @param io - 与 fd 配套的 fs 实现（node:fs 或 original-fs）。
 * @param asarPath - 归档原始路径（用于报错信息）。
 * @param fileSize - 调用方 fstat 得到的文件大小。
 * @param readPath - 实际读取用的物理路径。
 * @returns 树、dataStart、大小与物理路径。
 */
function parseHeader(fd, io, asarPath, fileSize, readPath) {
  const stat = { size: fileSize }

  const head = Buffer.alloc(16)
  if (io.readSync(fd, head, 0, 16, 0) !== 16) throw new Error('归档头部读取不完整')

  const picklePrefix = head.readUInt32LE(0)
  if (picklePrefix !== 4) throw new Error(`不是 asar 归档：pickle 前缀应为 4，实际 ${picklePrefix}`)

  const headerPickleSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  if (!Number.isSafeInteger(headerPickleSize) || headerPickleSize <= 0 || headerPickleSize > MAX_HEADER_BYTES) {
    throw new Error(`headerPickleSize 异常：${headerPickleSize}`)
  }
  if (!Number.isSafeInteger(jsonSize) || jsonSize <= 0 || jsonSize > headerPickleSize) {
    throw new Error(`jsonSize 异常：${jsonSize}（headerPickleSize=${headerPickleSize}）`)
  }

  // JSON 正文从 16 开始；它与 pickle 尾部之间的对齐填充算进 headerPickleSize。
  const dataStart = 8 + headerPickleSize
  if (16 + jsonSize > stat.size || dataStart > stat.size || dataStart < 16 + jsonSize) {
    throw new Error(`头部区间越界：dataStart=${dataStart}, jsonEnd=${16 + jsonSize}, size=${stat.size}`)
  }

  const hb = Buffer.alloc(jsonSize)
  if (io.readSync(fd, hb, 0, jsonSize, 16) !== jsonSize) throw new Error('归档头部读取不完整')

  let tree
  try {
    tree = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''))
  } catch (error) {
    throw new Error(`头部 JSON 解析失败：${error.message}`)
  }
  if (tree === null || typeof tree !== 'object' || typeof tree.files !== 'object') {
    throw new Error('头部结构异常：缺少 files')
  }

  return { tree, dataStart, size: stat.size, physicalPath: readPath }
}

/**
 * 把目录树摊平成条目列表。
 *
 * 分类必须严格：只有显式 `unpacked === true` 才走外置真实文件路径。
 * offset 缺失/非法时**不能**静默降级成 unpacked —— 那会让一个损坏的归档
 * 看起来像「外置文件缺失」，把问题指向错误的方向。这里标记为 invalid，
 * 由读取处明确报错。
 *
 * @param tree - asar 头部根节点。
 * @returns 条目数组，每项含 rel/size/kind/offset。
 */
function flatten(tree) {
  const out = []
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node.files ?? {})) {
      const rel = prefix === '' ? key : `${prefix}/${key}`

      // 顺序很重要：先判节点是不是对象，再认目录，再认 link，
      // 最后才对普通文件校验 size/offset。
      // 早期版本先校验 size 才认 link，导致合法的 `{link:"x"}`（没有 size）
      // 被误判成 invalid —— link 节点本来就不带 size。
      if (value === null || typeof value !== 'object') {
        out.push({ rel, size: 0, kind: 'invalid', reason: '节点不是对象' })
        continue
      }
      if (value.files !== undefined) {
        walk(value, rel)
        continue
      }
      if (typeof value.link === 'string') {
        out.push({ rel, size: 0, kind: 'link', link: value.link })
        continue
      }

      const size = value.size
      if (!Number.isSafeInteger(size) || size < 0) {
        out.push({ rel, size: 0, kind: 'invalid', reason: `size 非法：${String(size)}` })
        continue
      }

      if (value.unpacked === true) {
        out.push({ rel, size, kind: 'unpacked' })
        continue
      }

      // 归档内成员：offset 是**字符串**（实测 20051 个全是字符串）。
      // 必须严格校验成非负安全整数。注意 Number('') === 0、Number(' ') === 0、
      // Number(true) === 1，所以先要求原始值是非空字符串或数字，
      // 否则空串会被当成合法 offset 0 而读到错误的成员。
      const raw = value.offset
      const rawOk = (typeof raw === 'string' && raw.trim() !== '') || typeof raw === 'number'
      const numeric = rawOk ? Number(raw) : Number.NaN
      if (!rawOk || !Number.isSafeInteger(numeric) || numeric < 0) {
        out.push({ rel, size, kind: 'invalid', reason: `offset 非法：${String(raw)}` })
        continue
      }

      out.push({ rel, size, kind: 'packed', offset: numeric })
    }
  }
  walk(tree, '')
  return out
}

/** 归档绝对路径：优先取环境变量，退回桌面版默认安装位置。 */
function asarPathOf(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (typeof process.env.DSH_ASAR === 'string' && process.env.DSH_ASAR.trim() !== '') {
    return process.env.DSH_ASAR.trim()
  }
  // app.asar 与 app.asar.unpacked 同级
  return path.resolve('D:/Programs/DeepSeek-Harness/resources/app.asar')
}

/**
 * 求「能被当普通文件打开」的等价路径，绕开 Electron 的 asar 补丁层。
 *
 * 背景见 readHeader 的注释：宿主里 `fs.statSync('*.asar')` 返回 size=0、
 * `fs.openSync` 抛 ENOENT —— 因为这个路径被解释成「归档虚拟根目录」，
 * 而不是磁盘文件。单测在普通 node 里全绿，实机却全废。
 *
 * 依次尝试，命中即返回（判据是 stat 为文件且 size > 0）：
 *
 *   1. **硬链接镜像**（最可靠）。补丁层按路径是否以 `.asar` 结尾来识别归档；
 *      在 `DSH_HOME/_asar-mirror/archive.bin` 建一个硬链接指向同一 inode，
 *      路径后缀不是 `.asar` 就不会被拦，且**不额外占磁盘**（共享同一份数据）。
 *      升级后源文件 inode 变化时，旧硬链接会指向旧数据，因此比对 size+mtime
 *      不一致就重建。
 *   2. `realpathSync` 解析后的真实路径（符号链接挂载时有效）。
 *   3. Windows `\\?\` 长路径前缀（能骗过基于字符串匹配的实现）。
 *   4. 原路径（普通 node 下就是它本身）。
 *
 * @param asarPath - 归档绝对路径。
 * @returns 可当作普通文件打开的路径。
 */
const physicalPathCache = new Map()

/**
 * 归档镜像目录：放在插件自己控制的目录下，按**完整绝对路径的哈希**命名。
 *
 * 早期版本只用 basename（`app.asar.bin`），两个不同目录下的同名归档会碰撞、
 * 互相复用对方的镜像 —— 那等于读错文件。
 */
function mirrorPathOf(asarPath) {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : null
  if (home === null) return null
  const dir = path.join(home, '_asar-mirror')
  const hash = createHash('sha256').update(path.resolve(asarPath)).digest('hex').slice(0, 16)
  return path.join(dir, `${hash}.bin`)
}

/**
 * 求「原始文件系统」的 fs 实现。
 *
 * Electron 提供 `original-fs`：专用于绕过 asar 虚拟化、直接访问物理文件。
 * 这是**首选**方案——不需要建硬链接、不占额外空间、不受同卷约束。
 *
 * 但它在普通 Node 里不存在，也只有在 Electron 主进程侧才可能加载，所以必须
 * 静默回退。用动态 import 且包在 try 里，任何失败都退到 `node:fs`。
 */
let originalFsPromise
function originalFs() {
  if (originalFsPromise === undefined) {
    originalFsPromise = import('original-fs').catch(() => null)
  }
  return originalFsPromise
}

/**
 * 建镜像并返回其路径；失败返回 null。
 *
 * **这里不能用 `fs.statSync(asarPath)` 做前置判断。** 实测在宿主的 asar 补丁下
 * 该路径被虚拟成「归档目录」，stat 返回 size=0、isFile() 为 false —— 早期版本
 * 用它当门槛，导致 `ensureMirror` 必然提前返回 null，镜像根本建不出来。
 * 硬链接是内核级操作，源路径是否被用户态补丁"看成目录"与它无关，直接尝试即可。
 *
 * @param asarPath - 归档绝对路径。
 * @returns 可当普通文件打开的镜像路径，或 null。
 */
function ensureMirror(asarPath) {
  const mirror = mirrorPathOf(asarPath)
  if (mirror === null) return null

  // 已有镜像：能当普通文件读就直接复用（不要求已知源 size —— 源可能被补丁遮住）。
  try {
    const existing = fs.statSync(mirror)
    if (existing.isFile() && existing.size > 16) return mirror
  } catch { /* 不存在，往下建 */ }

  try {
    fs.mkdirSync(path.dirname(mirror), { recursive: true })
    // 代际化重建：先删旧名再链，避免同名硬链接指向过期 inode。
    try { fs.unlinkSync(mirror) } catch { /* 本来就不在 */ }
    fs.linkSync(asarPath, mirror)
    return mirror
  } catch (error) {
    // EEXIST 说明有人抢先建好了同名文件（跨进程并发），验证后复用而不是当失败。
    if (error?.code === 'EEXIST') {
      try {
        const st = fs.statSync(mirror)
        if (st.isFile() && st.size > 16) return mirror
      } catch { /* 落到下面 */ }
    }
    return null // 跨卷 / 权限 / 非 NTFS：交给后面的候选
  }
}

function physicalPathOf(asarPath) {
  const cached = physicalPathCache.get(asarPath)
  if (cached !== undefined) return cached

  const works = (candidate) => {
    try {
      const st = fs.statSync(candidate)
      return st.isFile() && st.size > 16
    } catch {
      return false
    }
  }

  const candidates = []
  const mirror = ensureMirror(asarPath)
  if (mirror !== null) candidates.push(mirror)
  try { candidates.push(fs.realpathSync.native(asarPath)) } catch { /* 忽略 */ }
  try { candidates.push(fs.realpathSync(asarPath)) } catch { /* 忽略 */ }
  if (process.platform === 'win32' && /^[a-zA-Z]:\\/.test(asarPath)) {
    candidates.push(`\\\\?\\${asarPath}`)
  }
  candidates.push(asarPath)

  // 只缓存**成功**的结果。早期版本连失败都写进 Map，于是第一次失败之后
  // 永远返回原路径，即便后来镜像建好了、或权限恢复了也不会再尝试。
  for (const candidate of candidates) {
    if (works(candidate)) {
      physicalPathCache.set(asarPath, candidate)
      return candidate
    }
  }

  return asarPath // 不缓存失败，下次调用重新尝试
}

/**
 * 外置成员所在目录。
 *
 * Electron 的约定是「归档路径 + `.unpacked`」：`app.asar` → `app.asar.unpacked`，
 * `foo.asar` → `foo.asar.unpacked`。早期版本只对 `app.asar` 做替换，
 * 传入其它归档名时会退回归档自身当根，然后读不到任何外置成员。
 *
 * 注意这里**用原始路径**拼，不用 physicalPathOf 的结果：`.unpacked` 是真实
 * 目录，不能被 asar 补丁误伤，也不该继承「绕开 .asar 后缀」的处理。
 */
function unpackedRootOf(asarPath) {
  const resolved = asarPathOf(asarPath)
  return `${resolved}.unpacked`
}

/**
 * 读一个成员的内容。
 *
 * 边界与短读都必须严格校验：
 *   - 归档内成员：校验**整个**声明区间（不只是本次想读的 want）落在数据区内，
 *     因为只检查单侧会让「声明 size 很大、实际读到别处」蒙混过关；
 *   - 短读（readSync 返回不足）必须报错，不能把零填充当文件内容；
 *   - 外置成员：路径校验，拒绝 `..` 与绝对路径逃逸出 app.asar.unpacked。
 *
 * @param archive - { path, dataStart, size } 归档描述。
 * @param fd - 已打开的归档只读 fd（仅 packed 成员使用）。
 * @param entry - flatten() 产出的条目。
 * @param limitBytes - 最大读取字节，超出截断。
 * @returns 内容缓冲与是否截断。
 */
function readMember(archive, fd, entry, limitBytes = MAX_FILE_BYTES_FOR_SCAN) {
  if (entry.kind === 'unpacked') {
    const segments = entry.rel.split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..') || /^[a-zA-Z]:/.test(entry.rel)) {
      throw new Error(`外置成员路径非法：${entry.rel}`)
    }
    const root = unpackedRootOf(archive.path)
    const real = path.join(root, ...segments)

    // 词法检查只能挡住 `../`。unpacked 目录里若存在符号链接/junction 指向外部，
    // 仅靠 path.resolve 前缀比对是挡不住的 —— 必须用 realpath 后再比一次。
    // 这里只做一次 realpath：它不能防「检查后替换」的并发攻击，但能挡住静态逃逸。
    let realRoot
    let realTarget
    try {
      realRoot = fs.realpathSync(root)
      realTarget = fs.realpathSync(real)
    } catch (error) {
      throw new Error(`外置成员不可达：${entry.rel}（${error.code ?? error.message}）`)
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error(`外置成员经链接逃逸出根目录：${entry.rel}`)
    }

    const stat = fs.statSync(realTarget)
    if (!stat.isFile()) throw new Error(`外置成员不是普通文件：${entry.rel}`)
    const want = Math.min(stat.size, limitBytes)
    const buf = Buffer.alloc(want)
    const rfd = fs.openSync(realTarget, 'r')
    try {
      const got = fs.readSync(rfd, buf, 0, want, 0)
      if (got !== want) throw new Error(`外置成员短读：${entry.rel}（${got}/${want}）`)
    } finally { fs.closeSync(rfd) }
    return { buf, truncated: stat.size > want }
  }

  if (entry.kind === 'packed') {
    // 校验整个声明区间，而不只是本次读取量。
    const fullStart = archive.dataStart + entry.offset
    const fullEnd = fullStart + entry.size
    if (!Number.isSafeInteger(fullStart) || fullStart < archive.dataStart || fullEnd > archive.size) {
      throw new Error(`成员越界：${entry.rel}（${fullStart}..${fullEnd} 超出数据区 ${archive.dataStart}..${archive.size}）`)
    }

    const want = Math.min(entry.size, limitBytes)
    const buf = Buffer.alloc(want)
    const got = fs.readSync(fd, buf, 0, want, fullStart)
    if (got !== want) throw new Error(`归档成员短读：${entry.rel}（${got}/${want}）`)
    return { buf, truncated: entry.size > want }
  }

  throw new Error(`不支持的条目类型 ${entry.kind}：${entry.rel}${entry.reason ?? ''}`)
}

/**
 * 文本/二进制判断。
 *
 * 只看 NUL 是廉价启发式，但会把 UTF-16 源码误判成二进制（UTF-16 里
 * ASCII 高位就是 NUL）。所以先认 BOM：带 UTF-16 BOM 的一律当文本，
 * 再按「前 8KB 是否有 NUL」判定其余。
 *
 * @param buf - 成员内容。
 * @returns { binary: boolean, encoding: 'utf8'|'utf16le'|'utf16be' }
 */
function classify(buf) {
  if (buf.length >= 2) {
    if (buf[0] === 0xFF && buf[1] === 0xFE) return { binary: false, encoding: 'utf16le' }
    if (buf[0] === 0xFE && buf[1] === 0xFF) return { binary: false, encoding: 'utf16be' }
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { binary: false, encoding: 'utf8' }
  }
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return { binary: true, encoding: 'utf8' }
  return { binary: false, encoding: 'utf8' }
}

/**
 * 按编码解成字符串。
 *
 * 关键约束：UTF-16 正文必须是偶数长度。奇数长度意味着末尾留下半个码元
 * （损坏文件、写入中间态、错误编码标记都可能造成）。
 * 早期版本直接 `Buffer.swap16()`，奇数长度会抛 `ERR_INVALID_BUFFER_SIZE`
 * 并让整个 grep 调用失败 —— 一个坏文件不该毁掉整次搜索。
 * 这里显式检查长度并抛可分类的错误，由调用方按「单文件失败」处理。
 *
 * @param buf - 原始字节。
 * @param encoding - classify() 判定的编码。
 * @returns 解码后的字符串。
 */
function decode(buf, encoding) {
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    const body = buf.subarray(2) // 去掉 2 字节 BOM
    if (body.length % 2 !== 0) {
      const error = new Error('UTF-16 正文长度为奇数，末尾有半个码元')
      error.code = 'ENC_ODD_UTF16'
      throw error
    }
    if (encoding === 'utf16le') return body.toString('utf16le')
    const swapped = Buffer.from(body)
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  // UTF-8 BOM 需要剥离，否则首个命中行前面会带一个不可见字符。
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.subarray(3).toString('utf8')
  }
  return buf.toString('utf8')
}

/** 把 needle 当字面量做一次转义，避免模型传入的字符串被当正则解释。 */
function literalToRegExp(needle, caseSensitive) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped, caseSensitive ? '' : 'i')
}

/** 片段预算：按 **Unicode 码点** 计，不是字节、不是 UTF-16 码元、不是视觉字符。 */
const MAX_SNIPPET_CODE_POINTS = 400

/**
 * 生成以实际命中范围为中心的片段。
 *
 * 两个关键点（都是首版写错过的地方）：
 *
 * 1. **不要用 toLowerCase/indexOf 重新定位命中。** `/i` 正则与 toLowerCase 的
 *    Unicode 语义不同（例如 `İ` 小写会变成两个码点 `i̇`，改变字符串长度），
 *    重算出的下标可能偏离真实命中处。调用方已经把真实正则的 match 传进来。
 *
 * 2. **窗口要围绕整个命中范围**，不是只保证命中起点在窗口内。首版向左留 200
 *    码点，300 码点的关键词会被切掉一半。
 *
 * @param line - 原始行。
 * @param matchIndex - 命中的 UTF-16 起始下标（来自同一个正则）。
 * @param matchLength - 命中的 UTF-16 长度。
 * @returns 安全片段字符串。
 */
function snippet(line, matchIndex, matchLength) {
  const points = Array.from(line) // 按码点切，避免劈开代理对
  if (points.length <= MAX_SNIPPET_CODE_POINTS) return line

  // 把 UTF-16 下标换算成码点下标，保证与 points 对齐。
  const hitStart = matchIndex < 0 ? 0 : Array.from(line.slice(0, matchIndex)).length
  const hitEnd = matchIndex < 0
    ? Math.min(points.length, MAX_SNIPPET_CODE_POINTS)
    : hitStart + Array.from(line.slice(matchIndex, matchIndex + matchLength)).length

  const hitSpan = hitEnd - hitStart
  // 命中本身就超预算：只能截断命中，并明确标注。
  if (hitSpan >= MAX_SNIPPET_CODE_POINTS) {
    return `…${points.slice(hitStart, hitStart + MAX_SNIPPET_CODE_POINTS).join('')}… (match truncated)`
  }

  // 剩余预算前后均分。
  const room = MAX_SNIPPET_CODE_POINTS - hitSpan
  const before = Math.floor(room / 2)
  let start = Math.max(0, hitStart - before)
  const end = Math.min(points.length, start + MAX_SNIPPET_CODE_POINTS)
  start = Math.max(0, end - MAX_SNIPPET_CODE_POINTS)

  const head = start > 0 ? '…' : ''
  const tail = end < points.length ? '…' : ''
  return `${head}${points.slice(start, end).join('')}${tail}`
}

export function apply(ctx, config = {}) {
  const asarPath = asarPathOf(config.asarPath)

  /**
   * 头部缓存：按「物理路径 + 文件身份」失效。
   *
   * 两个坑（都踩过）：
   *   1. 早期版本先 `await readHeader()` 解析完 5.6 MB 头部，**才**检查缓存 ——
   *      缓存对性能毫无作用，等于每次调用都重新解析。
   *   2. key 只用 size：归档原地更新但大小不变时，会拿旧 entries/旧 dataStart
   *      去读新正文，得到「新内容配旧偏移」的静默错位。
   *      现在 key 里带上 mtimeMs 与 ctimeMs（两者都在变），并在解析后复核，
   *      变化则重解析一次；仍不一致就明确报错，不静默返回旧数据。
   */
  let cache = { key: '', entries: null, dataStart: 0, size: 0, physicalPath: '' }

  /** 用一个 fd 读 16 字节，取「便宜的身份指纹」用于缓存判断。 */
  const statKeyOf = (archivePath) => {
    try {
      const st = fs.statSync(archivePath)
      if (!st.isFile() || st.size <= 16) return null // 被补丁遮住，交给 readHeader 处理
      return `${archivePath}:${st.size}:${Math.round(st.mtimeMs)}:${Math.round(st.ctimeMs)}`
    } catch {
      return null
    }
  }

  const loadEntries = async (archivePath = asarPath) => {
    // 先看缓存：能命中就不解析头部。
    const preKey = statKeyOf(archivePath)
    if (preKey !== null && cache.entries !== null && cache.key === preKey) {
      return {
        entries: cache.entries,
        dataStart: cache.dataStart,
        size: cache.size,
        path: archivePath,
        physicalPath: cache.physicalPath,
      }
    }

    const { tree, dataStart, size, physicalPath } = await readHeader(archivePath)

    // 解析后复核身份：解析期间归档若被替换，就重来一次；仍变则明确失败。
    const postKey = statKeyOf(archivePath) ?? `unstat:${archivePath}:${size}`
    if (preKey !== null && postKey !== preKey) {
      const retry = await readHeader(archivePath)
      const retryKey = statKeyOf(archivePath) ?? `unstat:${archivePath}:${retry.size}`
      if (retryKey !== postKey) {
        throw new Error(`归档在读取期间发生变化（${archivePath}），为避免返回错位数据已放弃本次结果`)
      }
      const entries = flatten(retry.tree)
      cache = { key: retryKey, entries, dataStart: retry.dataStart, size: retry.size, physicalPath: retry.physicalPath }
      return { entries, dataStart: retry.dataStart, size: retry.size, path: archivePath, physicalPath: retry.physicalPath }
    }

    const entries = flatten(tree)
    cache = { key: postKey, entries, dataStart, size, physicalPath }
    return { entries, dataStart, size, path: archivePath, physicalPath }
  }

  /**
   * 判断是否跳过，并给出原因（用于结果里的完整性统计）。
   *
   * 只有两类会跳过：
   *   1. 超过硬上限 MAX_FILE_BYTES_FOR_SCAN —— 真读会吃掉太多内存与时间；
   *   2. 落在二进制目录里且足够大 —— 那里是 .exe/.node，没有可搜文本。
   * 单纯「文件较大」不再跳过（desktop-runtime.json 4.7 MB 必须可搜）。
   */
  const skipReasonOf = (rel, size) => {
    if (size > MAX_FILE_BYTES_FOR_SCAN) return 'over-hard-cap'
    const probe = `/${rel}/`
    if (DEFAULT_EXCLUDE_DIRS.some((frag) => probe.includes(frag)) && size > 256 * 1024) return 'binary-dir'
    return null
  }

  /**
   * 注意：这两个工具**不挂 `when` 条件**。
   *
   * 早期版本写了 `{ when: ({ agent }) => agent !== undefined }`，想表达「只在有
   * agent 的会话里出现」。但 `when` 是**步骤级激活条件**：宿主在 `resolve()`
   * 里逐个求值，返回 false 的工具不会进入这一步的工具 schema。真机重启后
   * 插件状态是 active、`asar_list`/`asar_grep` 却完全不在
   * `request/header` 的 83 个工具里 —— 条件没按预期成立，工具就静默消失了。
   *
   * 这两个工具本身是只读、无副作用的，本来也不需要在什么场合隐藏，
   * 所以直接无条件注册。
   */
  ctx.tools.register(defineTool({
    name: 'asar_list',
    description: 'List entries inside an ASAR archive (default: the DeepSeek Harness app.asar). '
      + 'Use this instead of glob when the path is inside app.asar — glob cannot read an archive. '
      + 'Returns matching relative paths with sizes; `unpacked` entries live under app.asar.unpacked.',
    parameters: {
      pattern: {
        type: 'string',
        description: 'Optional substring or glob-ish filter on the relative path, e.g. "dsh-tools" or "dsh-agent/lib/*.js". Omit to list everything (large).',
      },
      limit: {
        type: 'number',
        description: `Max entries to return (default 100, cap ${MAX_MATCHES}).`,
      },
      asarPath: {
        type: 'string',
        description: 'Optional archive path. Defaults to the configured DSH app.asar.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          asar: { type: 'string', required: true },
          total: { type: 'number', required: true },
          matched: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                size: { type: 'number', required: true },
                // kind 比布尔 unpacked 更有用：能区分 packed / unpacked / invalid / link，
                // 模型据此知道该用哪个根路径读取，以及某个条目是否根本不该读。
                kind: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.matched === 0) {
          return [{ type: 'text', text: `No entries matched in ${value.asar} (${value.total} total).` }]
        }
        const lines = value.entries.map((e) => `${String(e.size).padStart(9)}  ${e.kind.padEnd(8)}  ${e.path}`)
        const head = `${value.matched} of ${value.total} matched in ${value.asar}`
          + (value.truncated ? ` (showing first ${value.entries.length})` : '')
        return [{ type: 'text', text: `${head}\n${lines.join('\n')}` }]
      },
      presentationMeta: (_args, value) => ({ kind: 'asar-list', matched: value.matched, total: value.total }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const archive = asarPathOf(args.asarPath ?? asarPath)
      exec.signal?.throwIfAborted?.()

      const loaded = await loadEntries(archive)
      const all = loaded.entries
      const needle = typeof args.pattern === 'string' ? args.pattern.trim() : ''
      const cap = Math.min(Math.max(1, Math.floor(args.limit ?? 100)), MAX_MATCHES)

      let pool = all
      if (needle !== '') {
        // 支持最简单的 * 通配，且**不锚定开头**：模型常写 `dsh-agent/lib/*.js`
        // 这种中间片段，若按 ^...$ 全串匹配会命中不到
        // `dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js`。
        // 因此通配按「从任意位置开始的片段」匹配，但要求以扩展名或结尾收尾，
        // 避免 `*.js` 意外匹配到 `x.js.map` 之外的路径。
        const wildcard = needle.includes('*')
        if (wildcard) {
          const body = needle
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
          const rx = new RegExp(body, 'i')
          pool = all.filter((e) => rx.test(e.rel))
        } else {
          pool = all.filter((e) => e.rel.toLowerCase().includes(needle.toLowerCase()))
        }
      }

      const matched = pool.length
      const entries = pool.slice(0, cap).map((e) => ({ path: e.rel, size: e.size, kind: e.kind }))
      return { asar: archive, total: all.length, matched, truncated: matched > entries.length, entries }
    },
  }))

  // ------------------------------------------------------------ asar_grep
  ctx.tools.register(defineTool({
    name: 'asar_grep',
    description: 'Search file CONTENTS inside an ASAR archive (default: the DeepSeek Harness app.asar). '
      + 'This is the archive-aware replacement for grep: the native ripgrep binary cannot read inside '
      + 'app.asar, so plain grep always fails with "os error 3". Skips binary files.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Literal text to find. Treated as a plain string, not a regular expression.',
      },
      include: {
        type: 'string',
        description: 'Optional path filter, e.g. "dsh-advisors" or "*/lib/*.js".',
      },
      limit: {
        type: 'number',
        description: `Max matching files to report (default 20, cap ${MAX_MATCHES}).`,
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Default false.',
      },
      asarPath: {
        type: 'string',
        description: 'Optional archive path. Defaults to the configured DSH app.asar.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          asar: { type: 'string', required: true },
          scanned: { type: 'number', required: true },
          skippedBinary: { type: 'number', required: true },
          skippedLarge: { type: 'number', required: true },
          skippedLinks: { type: 'number', required: true },
          invalidEntries: { type: 'number', required: true },
          readErrors: { type: 'number', required: true },
          errorSamples: { type: 'array', required: true, items: { type: 'string' } },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                moreHits: { type: 'boolean', required: true },
                hits: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      line: { type: 'number', required: true },
                      text: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        // 完整性状态必须总能看见：零命中也可能是因为跳过了大量候选或读取失败，
        // 静默只报「No match」会把「读不到」误导成「不存在」。
        // 口径说明：invalidEntries（元数据非法，未尝试读）与 readErrors
        //（尝试读但失败）互斥，相加才是「有问题的条目数」。
        const status = `scanned ${value.scanned} text file(s)`
          + `; skipped ${value.skippedBinary} binary, ${value.skippedLarge} oversized`
          + (value.skippedLinks > 0 ? `, ${value.skippedLinks} link` : '')
          + (value.invalidEntries > 0 ? `; ${value.invalidEntries} invalid metadata` : '')
          + (value.readErrors > 0 ? `; ${value.readErrors} read/encoding failure(s)` : '')

        // 统一在这里做总长度裁剪：list、零命中分支、正常分支都走同一条路径，
        // 避免「只有 grep 的 body 受限、其它分支可能超长」。
        const clamp = (text) => (text.length > MAX_RENDER_CHARS
          ? `${text.slice(0, MAX_RENDER_CHARS)}\n… (output truncated at ${MAX_RENDER_CHARS} chars)`
          : text)

        if (value.matches.length === 0) {
          const detail = value.errorSamples.length > 0
            ? `\nSample errors:\n${value.errorSamples.map((e) => `  ${e}`).join('\n')}`
            : ''
          return [{ type: 'text', text: clamp(`No content match in ${value.asar} (${status}).${detail}`) }]
        }

        const blocks = value.matches.map((m) => {
          const lines = m.hits.map((h) => `  ${h.line}: ${h.text}`).join('\n')
          return `${m.path}${m.moreHits ? ' (more hits in this file)' : ''}\n${lines}`
        })
        const head = `${value.matches.length} file(s) matched in ${value.asar} (${status})`
          + (value.truncated ? ' (result cap reached)' : '')
        return [{ type: 'text', text: clamp(`${head}\n\n${blocks.join('\n\n')}`) }]
      },
      presentationMeta: (_args, value) => ({ kind: 'asar-grep', files: value.matches.length, scanned: value.scanned }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const archive = asarPathOf(args.asarPath ?? asarPath)
      const needle = String(args.pattern ?? '')
      if (needle === '') throw new Error('pattern 不能为空')

      const loaded = await loadEntries(archive)
      const all = loaded.entries
      const include = typeof args.include === 'string' ? args.include.trim() : ''
      const rxNeedle = literalToRegExp(needle, args.caseSensitive === true)
      const cap = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), MAX_MATCHES)

      // include 语义（三条，按宽到窄）：
      //   1. 带 * 时按通配匹配（* 不跨 /）；
      //   2. 不带 * 但看起来像**目录**（以 / 结尾或能匹配某条路径的目录段）时，
      //      按「该目录下任意文件」匹配 —— 否则 `dsh-tools/lib` 会漏掉
      //      `dsh-tools/lib/types/index.js`，而后者恰恰是模型最需要的深层文件；
      //   3. 其余按子串匹配。
      const includeMatchers = include === ''
        ? null
        : (() => {
          const esc = include.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          const rx = include.includes('*')
            ? new RegExp(esc.replace(/\*/g, '[^/]*'), 'i')
            : null
          const dirPrefix = include.replace(/\/+$/, '').toLowerCase()
          return (rel) => {
            if (rx !== null && rx.test(rel)) return true
            const lower = rel.toLowerCase()
            if (lower.includes(dirPrefix + '/')) return true
            return lower.includes(dirPrefix)
          }
        })()

      // 先按 include 缩小。注意：invalid 条目 size 可能为 0，
      // 所以不能用 `e.size > 0` 过滤后再统计 —— 那会让非法节点完全不进错误统计。
      const inScope = all.filter((e) => includeMatchers === null || includeMatchers(e.rel))
      let skippedLarge = 0
      let skippedLinks = 0
      let invalidEntries = 0
      const candidates = []
      for (const e of inScope) {
        if (e.kind === 'link') { skippedLinks++; continue }
        if (e.kind === 'invalid') { invalidEntries++; continue }
        if (e.size === 0) continue
        const reason = skipReasonOf(e.rel, e.size)
        if (reason !== null) { skippedLarge++; continue }
        candidates.push(e)
      }

      const matches = []
      let scanned = 0
      let skippedBinary = 0
      let readErrors = 0
      const errorSamples = []
      let truncated = false

      /** 读取 / 解码失败：不含 invalid 节点（后者单独计入 invalidEntries）。 */
      const recordError = (rel, message) => {
        readErrors++
        if (errorSamples.length < 3) errorSamples.push(`${rel}: ${message}`)
      }
      // invalid 节点单独给样本，但不重复计入 readErrors ——
      // 两者口径互斥：invalidEntries 是「元数据就不合法、根本没尝试读」，
      // readErrors 是「尝试读了但失败」。相加才等于有问题的条目总数。
      for (const e of inScope) {
        if (e.kind === 'invalid' && errorSamples.length < 3) {
          errorSamples.push(`${e.rel}: ${e.reason ?? 'invalid'}`)
        }
      }

      // 只开一次归档 fd：每次 readMember 都重新解析 5.6 MB 头部是早期版本的
      // 性能灾难（36 个文件要 2.3 秒，全量直接卡死）。
      const archiveFd = fs.openSync(loaded.physicalPath, 'r')
      try {
        for (let index = 0; index < candidates.length; index++) {
          // 每处理若干文件让出一次事件循环。
          // `async execute` 并不会让同步代码变成异步：不加这一步，几十秒的全库
          // 扫描会把宿主事件循环堵死，连 abort 信号都没机会送达。
          if (index > 0 && index % YIELD_EVERY_FILES === 0) {
            await new Promise((resolve) => setImmediate(resolve))
          }
          exec.signal?.throwIfAborted?.()

          const entry = candidates[index]
          if (matches.length >= cap) { truncated = true; break }

          // 单文件错误边界：读失败、编码异常都只影响这一个文件。
          // 早期版本把 decode() 放在 try 之外，一个奇数长度的 UTF-16 文件
          // 就能让整次 grep 抛错失败。
          let text
          try {
            const content = readMember(loaded, archiveFd, entry)
            const kind = classify(content.buf)
            if (kind.binary) { skippedBinary++; continue }
            text = decode(content.buf, kind.encoding)
          } catch (error) {
            recordError(entry.rel, error.message)
            continue
          }

          scanned++
          const hits = []
          let lineNo = 1
          let moreHits = false
          for (const line of text.split(/\r?\n/)) {
            // 用同一个正则拿真实命中位置，供 snippet 精确开窗。
            const m = rxNeedle.exec(line)
            if (m !== null) {
              if (hits.length >= MAX_HITS_PER_FILE) {
                // 只有真的还有第六条命中时才标记 moreHits。
                moreHits = true
                break
              }
              hits.push({ line: lineNo, text: snippet(line, m.index, m[0].length) })
            }
            lineNo++
          }
          if (hits.length > 0) {
            matches.push({ path: entry.rel, hits, moreHits })
          }
        }
      } finally {
        fs.closeSync(archiveFd)
      }

      return {
        asar: archive,
        scanned,
        skippedBinary,
        skippedLarge,
        skippedLinks,
        invalidEntries,
        readErrors,
        errorSamples,
        matches,
        truncated,
      }
    },
  }))
}
