# dsh-asar-tools

让 ASAR 归档可被检索。提供 `asar_list` 与 `asar_grep` 两个工具，绕开「原生 `rg.exe` 读不了 `app.asar`」的限制。

## 问题

DSH 桌面版的实现全在 `resources\app.asar` 里，那是一个**单体归档文件**（约 200 MB），内部 `dsh/...` 是虚拟路径。

| 工具 | 执行方式 | 能否读 asar 内部 |
|---|---|---|
| `read` | 宿主 `fs`（Electron 有 asar 补丁层） | ✅ |
| `glob` / `grep` | 交给独立原生 `rg.exe` 子进程 | ❌ `IO error ... (os error 3)` |

`rg.exe` 是原生二进制，用操作系统文件系统调用，完全不知道 asar 是什么。于是模型既不能列目录、也不能搜内容，只能猜路径 —— 实际使用中会稳定浪费好几轮。

## 做法

**不依赖 Electron 补丁。** asar 的布局是公开的：

```
[8 字节 pickle 头][headerSize 字节 JSON 头][数据区]
header.files 是目录树，文件节点的 offset 相对数据区起点
```

所以本插件用纯 Node 自己解析头部、按 `8 + headerSize + offset` 精确定位读取。任何进程都能跑，不依赖运行时是否加载了 asar 补丁。

## 两个工具

### `asar_list`

列归档内条目。参数 `pattern`（子串或带 `*` 的通配）、`limit`、`asarPath`。

### `asar_grep`

搜归档内**文件内容**。这是 `grep` 的归档感知替代品。

- `pattern`：**按字面量**匹配，不是正则（避免模型传入的 `"version": "1.0.0"` 里的 `.` 被当通配符）
- `include`：路径过滤，支持三种语义 —— 通配（`dsh-agent/lib/*.js`）、目录（`dsh-tools/lib` 会匹配其下所有文件）、子串
- `limit` / `caseSensitive` / `asarPath`

自动跳过二进制文件（含 NUL 字节即判定）与超大文件。

## 两类成员的区别（踩过的坑）

归档里有两类条目，**读取路径完全不同**：

| kind | 含义 | 真实位置 |
|---|---|---|
| `packed` | 字节在归档内 | `app.asar\<相对路径>`，按 offset 读 |
| `unpacked` | 字节在归档外 | `app.asar.unpacked\<相对路径>`，是普通文件 |

当前归档中 `unpacked` 有 1666 个（LibreOffice 二进制、许可证等）。若把这类误判成 packed，读到的会是错误内容。

## 开发中实测发现的坑

### 0. 宿主里的 `fs` 打开了 asar 补丁层（最致命，单测抓不到）

在 DSH 桌面版（Electron）进程内，**任何以 `.asar` 结尾的路径都被解释成「归档的虚拟根目录」**，而不是磁盘文件：

```js
fs.statSync('...\\app.asar').size      // → 0（不是 209021953）
fs.openSync('...\\app.asar', 'r')      // → 抛 ENOENT
```

但同样的代码在**普通 node 里完全正常**（size=209021953、可读）。这就是「单测 29 项全绿、实机一调全废」的原因——我在这上面错了两次。

**绕法（按优先级）：**

1. **`original-fs`**（首选）。Electron 提供的官方通道，专用于绕过 asar 虚拟化直接读物理文件。不需要建链接、不占空间、不受同卷约束。用动态 `import('original-fs')` 并静默回退——它在普通 Node 里不存在。
2. **硬链接镜像**。补丁层按路径组件边界识别 `.asar`，所以建一个后缀不是 `.asar` 的硬链接即可：

```powershell
mklink /H D:\DeepSeek-DSH\_asar-mirror\<sha256前16位>.bin <app.asar>
```

- **不占额外磁盘**（共享同一 inode；实测清理时磁盘变化 0 MB）
- 镜像名用**完整绝对路径的哈希**，避免不同目录下同名 `app.asar` 互相碰撞
- 源升级导致 inode 变化时，按已有镜像能否读取判断重建

3. `realpathSync` → `\\?\` 长路径前缀 → 原路径（后两者在补丁存在时通常无效，仅作兜底）。

`physicalPathOf()` 只缓存**成功**结果——早期版本连失败也写进 Map，导致第一次失败后永远不再尝试。

**⚠️ `ensureMirror` 里绝不能用 `fs.statSync(asarPath)` 做前置判断。** 该路径在宿主里被虚拟成「归档目录」，stat 返回 `size=0`、`isFile()=false`，用它当门槛会让镜像**永远建不出来**。硬链接是内核级操作，与用户态补丁无关，直接尝试即可。

### 1. 数据区起点必须用偏移 4 的 headerPickleSize

asar 头部布局（实测字节）：

```
offset 0  uint32LE = 4                pickle 前缀
offset 4  uint32LE = 5669972          headerPickleSize  ← 数据区起点用这个
offset 8  uint32LE = 5669968          jsonSize + 3
offset 12 uint32LE = 5669961          jsonSize          ← 不能用这个
offset 16          JSON 正文开始
数据区起点 = 8 + headerPickleSize
```

我最初用了偏移 12 的 `jsonSize`，比正确起点**少 11 字节**，导致每个成员读出来前面都混着头部残留（`"]}}}}}}\0\0\0{"` 后面才是真正的 JSON）。

**为什么测试没抓到**：搜 `"version": "0.2.2-rc.3"` 这种中段字符串时，错位 11 字节仍包含它。只有校验「成员首个字符」或「最靠后成员 end == 归档大小」才暴露。

### 2. `offset` 是字符串不是数字

asar 头里全部 20051 个 offset 都是 `"116049434"` 这种字符串，一个 number 都没有。用 `typeof offset === 'number'` 判断会让所有归档内成员被误判成外置成员、走错读取路径。

### 3. 不能每次读文件都重新解析头部

头部 JSON 有 5.6 MB。早期 `readMember` 内部调 `readHeader()`，搜 36 个文件要 2.3 秒，全库直接卡死。现在一次开 fd 复用。

### 4. 排除表不能一刀切

`libreoffice-kit-win32-x64/` 下既有 185 MB 的二进制，也有 2 KB 的许可证文本。按目录整棵排除会让「搜许可证文本」静默返回 0 命中。同理，早期写过「2 MB 以上跳过」，把 **`dsh/desktop-runtime.json`（4.7 MB，DSH 运行时清单，插件/模型/预设都在里面）** 静默漏掉了。

### 5. 读取失败不能静默变零命中

早期 `catch { continue }` 会把损坏节点、权限失败、外置缺失全吞掉，用户看到「No content match」会误以为文件不存在。现在单独统计 `readErrors` 并附 `errorSamples`，`render` 里始终显示完整性状态。

### 6. 工具注册不要挂 `when`

写过 `{ when: ({ agent }) => agent !== undefined }`，重启后插件状态 `active`，但工具**完全不在** `request/header` 的清单里，且**不报任何错**。`when` 是步骤级激活条件，返回 false 的工具静默消失。

**判定工具是否真可用，唯一可靠办法是查会话日志 `request/header` 里的 tools 名单，不要只看插件状态。**

## 安装

把本目录加入 profile 的 `dsh.profile.bundles`（或用 junction 挂到 `profiles/<name>/node_modules`），`cordis.patch.yml` 会自动挂载。

## 测试

```powershell
npm test
```

- `selftest.mjs`（16 项）：打真实 `app.asar`，覆盖全量列表、通配、外置标记、内容搜索、**数据区起点精确性**、字面量语义、大小写、二进制跳过、外置小文本、真实源码符号、**4.7 MB 大文件可搜**、错误路径、render、schema 字段。
- `test/edge.mjs`（13 项）：构造最小 asar，覆盖负 offset、小数 offset、**invalidEntries 与 readErrors 互斥**、size 越界、正常归档逐字节正确、UTF-16LE BOM、外置路径穿越、损坏头部、**合法 link 分类**、**link 不计 readErrors**、**奇数 UTF-16 单文件失败不中断**、UTF-8 BOM 剥离、**非 app.asar 外置根**。
- `test/asar-patch-sim.mjs`（5 项）：**伪造宿主的 asar 补丁**（让 `statSync(app.asar)` 返回 size=0、`openSync` 抛 ENOENT），验证绕过链路仍然读到正确内容。

最后这份是关键：前两份**全部在普通 node 里跑，测不出 asar 补丁问题**——曾经 29 项全绿、实机一调就挂。只有用 monkey-patch 伪造宿主行为，才能在进程外验证这件事。

`edge.mjs` 的构造器按实测推导（真实归档 N=5669961、padding=3）：

```
offset 0  = 4
offset 4  = headerPickleSize = 8 + N + padding
offset 8  = 4 + N + padding
offset 12 = N
dataStart = 8 + headerPickleSize
```

## 性能与响应性（实测）

| 指标 | 值 |
|---|---|
| 全库扫描（20450 个文本文件） | 约 6 秒（热缓存） |
| abort 生效延迟 | 约 53 ms |
| 扫描期间 timer 响应 | 每 100ms 定时器在 5.8 秒内触发 39 次（期望 58） |

分批让出用 `setImmediate`，每 50 个文件一次。**`async execute()` 不会自动让同步代码变异步** —— 不加这一步，几十秒的扫描会堵死宿主事件循环，连 abort 都送不进来。

## 已知边界

- **只读**：不提供写入。
- **字面量搜索**：`pattern` 按字面量匹配，不支持正则。这是有意的——搜代码符号时不必二次转义，也避免正则注入与灾难性回溯。
- **不支持跨行匹配**：逐行扫描，含换行的 pattern 不会命中；也不支持纯 CR 换行。
- **不跟随 link 节点**：归档内的 link 条目不做重定向解析，只计入 `skippedLinks` 并在结果里显示。
- **外置路径只做静态隔离**：用 `realpathSync` 拒绝越出 `app.asar.unpacked` 的链接，但不能防「检查后替换」的并发攻击。
- **升级不失效**：直接读归档，不依赖外部索引文件，DSH 升级后无需重建任何缓存。
