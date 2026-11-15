# dsh-token-tree 交接文档

> 交接对象：接手维护这个插件的下一个 AI / 人
> 最后更新：2026-11-13
> 作者：lead（本会话）

---

## 一、30 秒速览

**这是什么**：DSH 的一个插件，把**父代理 + 全部子孙代理**的 token 消耗加总，常驻在右侧栏。

**为什么需要它**：DSH 内核的 token 计量全部按**单个 Session** 算。每个 subagent 是独立 Session，父会话日志里只有一条 `subagent/catalog` 事件记住 `childId`，**没有任何地方把子会话用量汇总回父会话**。所以界面永远只显示当前这个 agent 的用量。`dsh-context` 的「编队/Fleet」页能看每个子 agent，但它给的是**费用估算**，没有 token 口径的合计键。

**核心价值（一句话）**：输入框下方显示 `42.8M tok`，面板显示 `64.13M` —— 差的 21.33M 就是子代理的，这就是你一直看不到的那个数。

**当前状态**：已装进 `desktop` profile，**待重启生效**（两轮修复都还没加载）。

---

## 二、环境事实（接手先核对这些）

| 项 | 值 | 怎么核对 |
|---|---|---|
| DSH 版本 | `0.2.2-rc.2` | `app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json` 的 `version` |
| 安装根 | `D:\Programs\DeepSeek-Harness` | 注册表 `DisplayVersion` 也确认过 |
| DSH_HOME | `D:\DeepSeek-DSH` | 环境变量 `$env:DSH_HOME` |
| 插件源码 | `D:\DeepSeek-Workspace\dsh-token-tree` | 本目录 |
| profile | `D:\DeepSeek-DSH\profiles\desktop` | |
| 会话日志 | `$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd` | 本机约 **1060 个会话 / 293 MB** |
| 当前路由 | `workbuddy` / `deepseek-v4.1-flash` | 影响 reasoning 字段（见 §七） |

**重要**：`desktop` profile 由 Electron 应用独占，`dsh --dump-config` 会报 `profile "desktop" is managed exclusively by the Electron application`。**验证配置必须另建临时 profile**（见 §六）。

---

## 三、文件清单

```
D:\DeepSeek-Workspace\dsh-token-tree\
├── package.json          插件清单（dsh.bundle + dsh.client 声明）
├── cordis.patch.yml      bundle 层：insert 一行插件
├── index.js        648行  宿主半：读日志、还原树、HTTP 路由、命中率派生
├── client.js       890行  浏览器半：右侧栏面板
├── README.md             面向使用者的说明 + 审计记录
│
├── selftest.mjs    219行  ★ 宿主断言 54 条
├── clienttest.mjs  310行  ★ 浏览器半断言 29 条
├── verify-incr.mjs  95行  ★ 增量 vs 全量一致性 + 加速比
├── preview.mjs     357行  ★ 把组件真实输出渲染成 ui-preview.html（改 UI 必跑）
├── ui-preview.html        preview.mjs 的产物，肉眼验收用
├── audit.mjs       307行    数据完整性审计
├── audit2.mjs      153行    用量口径审计
├── audit3.mjs       87行    compaction 漏算量化
└── perf.mjs         78行    扫描成本测量
```

★ = 改代码后**必须跑**的。

---

## 四、架构与关键决策

### 4.1 两半结构

```
[浏览器 client.js]  --fetch GET /api/dsh-token-tree/tree?sessionId=xxx-->  [宿主 index.js]
        ↑                                                                        |
        |                                                                        v
   渲染树形 UI                                                         读 sessions/*.jsonl.zstd
                                                                       还原代理树、累加 usage
```

**为什么是 HTTP 而不是 DSH 内置的 slot/projection**：内置的 `ctx.tokenMeter` / `contextPressure` / `tokenUsage` 都吃单个 `session`，拿不到别的会话。只能绕过它直接读日志文件。这是本插件的设计前提，也是它唯一的可行性来源。

### 4.2 两个必须知道的底层坑

**坑 1：`.zstd` 是追加写、多帧的**

`zlib.zstdDecompressSync` **只解第一帧**，于是会拿到一条 202 字节的 `{"type":"session"}` 就结束，看起来像「日志是空的」。

必须按 zstd 帧 magic（`28 B5 2F FD`）切帧，逐帧解压再拼。`selftest.mjs` 有两条断言专门锁这个：

```
ok   单次 zstdDecompressSync 只拿到第一帧（这就是踩坑现象）
ok   decodeLog 拿到两帧
```

**坑 2：帧是独立可解的 —— 这既是 bug 也是解药**

因为每帧独立，所以**正在写入的会话只需解压新增的那几帧**。这是 §五 性能修复的基础。`verify-incr.mjs` 会验证增量结果与全量逐字段相同（实测 26.8x 加速）。

### 4.3 代理树怎么还原

```
每个 session.v4.jsonl.zstd 的第一行是 header:
  { "type":"session", "id":..., "parentSession":..., "origin":"root|subagent",
    "delegationDepth":..., "cwd":..., "agentPreset":... }
```

- 根会话：`origin: "root"`，无 `parentSession`
- 子代理：`origin: "subagent"`，有 `parentSession` 指向父会话 id
- 建树：`parentSession` → 子列表；沿 parent 上溯到根

**注意**：`parentSession` 只表示「子代理的直接创建者」。普通 Session fork **不再记录** `parentSession`（0.2.1-rc.3 起独立化），所以不要用它判断「是不是子代理」，要用 `origin === 'subagent'`。

### 4.4 三个口径

| 口径 | 公式 | 用途 |
|---|---|---|
| `billed` | 未缓存输入 + 缓存读 + 缓存写 + 输出 | 计费口径，和 DSH 输入框下方那个数对齐 |
| `fresh` | 未缓存输入 + 输出 | 真实新增成本 |
| `cacheHitRate` | 缓存读 /（缓存读 + 未缓存输入） | 缓存命中率，看缓存到底省了多少 |

**为什么要分 billed / fresh**：实测某会话 `billed 64.13M`，其中 **95% 是缓存读**，`fresh` 只有 `3.22M`。只看 billed 会被吓到，看缓存占比才知道成本结构。

**命中率的分母为什么不含输出和缓存写**（2026-11-13 加）：

- 命中率回答的是「**这次请求的提示词**有多少是直接从缓存读到的」。输出是新生成的，物理上不可能命中缓存，
  放进分母只会把命中率系统性压低，得到一个既不叫缓存命中率、也不叫别的什么的数。
- 缓存写同理：它是往缓存里**存**，不是从缓存里**取**。
- 分母为 0（一次请求都还没有）时返回 `null`，UI 显示「—」。**不要改成 0** —— 0% 是「有请求但缓存没命中」，
  和「还没有请求」是两件事，混在一起会误导。

**这是派生量，不进 `sumKeys`**：比率不能相加。`buildTree` 里是在子节点汇总完 `input` / `cacheRead` 之后才调
`cacheHitRate(node.cacheRead, node.input)`。`applyEvents` 末尾也重算一次，所以全量/增量两条路径都一致。

字段语义已用**真实数据 8043 条**验证（`audit2.mjs`）：

```
input=4588  cacheRead=37504  output=103  total=42195
4588 + 37504 + 103 = 42195  ✅
totalTokens 与四项之和：零不一致
```

→ `inputTokens` 确实是「**未缓存**输入」，四项相加不重复计算。

---

## 五、已修复的问题清单（务必不要改回去）

### P1 — 漏算压缩 token【真 bug】

**症状**：总额系统性偏低。

**根因**：只统计了 `assistant/message`，但 `compaction/summary` **也带完整 usage**。压缩摘要本身是一次模型调用。

**证据**（`audit2.mjs` + `audit3.mjs`）：

```
带 usage 的事件类型: [["assistant/message", 36570], ["compaction/summary", 10]]

session-6c13625d   assistant 29,557,996  +  compaction 283,243  → 漏 0.95%
session-d4bac546   assistant 24,313,060  +  compaction 436,641  → 漏 1.76%
合计 6 个会话                               漏 1,147,091
```

**修复**：`index.js` 的 `applyEvents` 加 `case 'compaction/summary'`，计入总量并**单独记账** `compactionBilled` / `compactionFresh` / `compactionRequests`。UI 上单独提示「其中压缩摘要 N 次」。

**复验**：`29,841,239 = 29,557,996 + 283,243` ✅ 完全吻合。

**回归测试**：`selftest.mjs` 的「compaction/summary 计入」7 条断言。

---

### P2 — 每次刷新全量重解【真 bug，性能】

**症状**：CPU 被吃满，刷新卡。

**根因**：全量扫描 **1060 个会话 / 293 MB = 6991 ms**（`perf.mjs` 实测），而自动刷新是 **5 秒一次** —— 刷新比扫描还快。

**修复**（`index.js` 的 `loadOne`）：

1. **mtime + size 都没变** → 直接复用缓存
2. **size 变大（追加写）** → 用 `fd.read` 只读 `[oldSize, newSize)` 那段，`decodeLog` 后 `applyEvents` **增量累加**
3. 其余（首次 / 被截断 / 切帧失败）→ 退回全量

**关键**：`foldSession` 拆成了 `emptyRecord()` + `applyEvents()`，**全量与增量共用同一套折叠逻辑**，避免两条路径漂移。

**实测**：

```
全量折叠: 107 ms
增量(只解尾部 93 帧): 4 ms
加速比: 26.8x
=> 增量结果与全量完全一致 ✅
```

**回归测试**：`selftest.mjs` 的「增量 == 全量」11 条断言 + `verify-incr.mjs`。

> ⚠ **改 `applyEvents` 时，增量一致性测试必须继续通过**。这是整个优化唯一的安全网。

---

### P3 — 并发重复扫描【真 bug】

**症状**：两个面板 / 快速点刷新时，同时各跑一遍全量扫描。

**修复**：`scan()` 加单飞 `cache.inflight`，并发请求共享同一次扫描。

---

### P4 — `findRoot` 边界

**症状**：记录缺 `id` 字段时返回 `undefined`，整棵树渲染成空。

**修复**：回退到 `parent` / 入参，并加环路防护（`seen` 集初始化包含起始 id）。

---

### P5 — 自动刷新太激进

5 秒 → **15 秒**。既然扫描要付代价，就不该让轮询比扫描还快。

---

### P6 — 标题栏入口按钮占位过大【UI，2026-11-13 主人反馈】

**症状**：会话标题栏右侧 `utilities` 行里，本插件的入口是个 `Σ 父+子 Token` 的胶囊按钮（实测 **88×22px**），
把这一行撑得很长，右边的原生图标按钮被挤开，视觉上比其他控件大一圈。

**根因**：入口按钮复用了面板内部的 `.dshtt-btn`（带文字的 22px 胶囊）。那个样式是给侧栏面板头部用的，
放进标题栏就不合尺寸——标题栏的 utilities 行全是 28px 的纯图标按钮（`ui-layout` 的紧凑 Button，
`width:28px`、`height:28px`、`border-radius:999px`、幽灵底、hover 才出底色）。

**修复**（`client.js`）：

1. 新增 `.dshtt-hbtn`：`width:28px;height:28px;padding:0;border:0;border-radius:999px`，
   `display:inline-flex` 居中，`font-size:14px`，hover 用 `--dsw-alias-interactive-bg-hover` —— 与原生图标按钮同款。
2. 按钮内容从 `"Σ " + TEXT.tabTitle` 改成只放 `Σ`；完整名字走 `title` + `aria-label`（无障碍不受影响）。
3. 面板内部（`.dshtt-head`）继续用 `.dshtt-btn`，那是侧栏里的按钮，不要跟着改小。

**实测**：改后按钮 **28×28px**，与相邻原生按钮完全一致（预览见 `header-button-preview.html`，
页面底部会直接打印两边尺寸）。

**回归测试**：`clienttest.mjs` 新增 4 条断言锁死形状——
`header 按钮是图标尺寸（dshtt-hbtn）`、`不再用带文字的胶囊`、`有 aria-label`、`不渲染长文字`。
**别再把它改回带文字的胶囊**，一改这四条就红。

---

## 六、验证与部署

### 6.1 改完代码必跑

```powershell
cd D:\DeepSeek-Workspace\dsh-token-tree
node selftest.mjs      # 期望 54 passed, 0 failed
node clienttest.mjs    # 期望 29 passed, 0 failed
node verify-incr.mjs   # 期望「增量结果与全量完全一致」
node preview.mjs       # 改了 UI 才有必要；再截图看一眼
```

### 6.2 端到端验证（不要碰用户正在用的 GUI）

`desktop` profile 是 Electron 独占的，验证必须建临时 profile：

```powershell
# 1. 用官方模板建干净 profile（只含 base + web-app）
$bin = "D:\Programs\DeepSeek-Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
# 用 Electron 的 node 跑（普通 node 进不了 asar）
ELECTRON_RUN_AS_NODE=1 $env:DSH_NODE_EXECUTABLE $bin --profile <名字> --from-default-profile web --dump-config

# 2. 改 package.json：dependencies 加 link，bundles 加插件名
# 3. 建 junction：node_modules\dsh-token-tree -> D:\DeepSeek-Workspace\dsh-token-tree
# 4. 启动（务必重定向到文件拿 token）
Start-Process "DeepSeek Harness.exe" -ArgumentList @($bin,'--profile',<名字>,'--no-open','--port','18790') `
  -RedirectStandardOutput out.txt -RedirectStandardError err.txt -PassThru -WindowStyle Hidden

# 5. 从 out.txt 拿 "dsh web: http://127.0.0.1:18790/?token=..."
# 6. 打 API
Invoke-WebRequest "http://127.0.0.1:18790/api/dsh-token-tree/tree?sessionId=<id>" -UseBasicParsing
```

**清理**：先删 `node_modules` 里的 **junction**，再删 profile 目录。直接 `Remove-Item -Recurse` 可能报错或跟随链接。

> ⚠ 在本机用 `Stop-Process` 杀 probe 进程时，`subprocess-local` 有时报 `Windows Job runner exited with code 4294967295`。用 `taskkill /PID <id> /F` 或等几秒重试。

### 6.3 装进正式 profile

已经装好了。如果重装：

```jsonc
// D:\DeepSeek-DSH\profiles\desktop\package.json
{
  "dependencies": {
    "dsh-token-tree": "link:D:/DeepSeek-Workspace/dsh-token-tree"   // ← 加
  },
  "dsh": { "profile": { "bundles": [
    ...
    "dsh-context",
    "dsh-token-tree"                                                 // ← 加
  ] } }
}
```

然后建 junction：

```powershell
New-Item -ItemType Junction `
  -Path "D:\DeepSeek-DSH\profiles\desktop\node_modules\dsh-token-tree" `
  -Target "D:\DeepSeek-Workspace\dsh-token-tree"
```

**备份**：改动前的 profile 在 `package.json.bak-tokentree-20261113-001425`。

**卸载**：从 `bundles` 删掉 `"dsh-token-tree"` 一行，重启即可。源码目录可留可删。

---

## 七、已知限制（不是 bug，别去"修"）

| 限制 | 说明 |
|---|---|
| **推理恒为 0** | 抽样 3001 条 usage，**0 条**带 `reasoningTokens`。不是没推理，是当前路由（`workbuddy`）不报。换路由可能就有了。 |
| **冷启动首扫慢** | 1060 会话 / 293 MB 全量解压 7–12 秒。之后走缓存几十毫秒。 |
| **无计时** | 只汇总 token，不含墙钟。要时间看 DSH 的统计/轨迹页。 |
| **仅树内有效** | 跨不同根会话的合计请用「上下文洞察」页。 |
| **仅回环访问** | HTTP 只接受 127/8 与 ::1，且校验 Origin/Host 同源。这是安全边界，不要放宽。 |

> 曾经有个 `logCacheMs` 配置项，定义了但从未被读取（缓存实际靠 mtime+size 判断）。已在 2026-11-13 彻底删除，连同 `cordis.patch.yml` 和 README 里的引用。别再把它加回来。

---

## 八、如果你要改这个插件

### 想加口径
1. `index.js` → `emptyRecord()` 加字段 → `applyEvents()` 累加 → `buildTree()` 的 `sumKeys` 加键 → `stripNode()` 透传
2. `client.js` → UI 里读出来
3. **一定要在 `selftest.mjs` 补断言**，否则下一轮审计又会发现漏算

### 想加事件类型
先跑 `audit2.mjs` 看**哪些事件带 usage**，别假设只有 `assistant/message`。P1 就是这么漏的。

### 想优化性能
先跑 `perf.mjs` 拿基线。注意增量路径的**正确性完全依赖** `verify-incr.mjs`。

### 想改 UI

`client.js` 是**经典外链脚本**（不是 ESM），用 `window.__ModuleLoader__.load({ id, factory })` 注册，`id` 必须等于包名 `dsh-token-tree`。React 从 `require("react")` 拿，**不要**装第二份 React。

**改完一定要看图，别只看测试绿**。`node preview.mjs [sessionId]` 会把客户端组件**真实渲染出来的 DOM**
（假 React 记下元素树再序列化，CSS 也是从 `installStyles` 抓的那份）写进 `ui-preview.html`：

```powershell
node preview.mjs                                 # 手写示例数据
node preview.mjs session-a1405b24-...            # 打本机正在跑的 DSH，用真实会话
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
& $chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 `
  --window-size=800,760 --screenshot=shot.png --virtual-time-budget=2500 `
  "file:///D:/DeepSeek-Workspace/dsh-token-tree/ui-preview.html"
```

这条链路 2026-11-13 一次就抓出三个测试抓不到的毛病：「<0.1%」被印成「0.0%」、meta 行比名字更靠左、
名字被占比列挤掉。**布局问题只能看图发现。**

### UI 约定（2026-11-13 重做）

视觉参考是 `dsh-context` 的「上下文统计」卡片：一张合计卡 + 一张组成卡 + 一张明细卡，都在侧栏里。

- **四类 token 固定色相**，贯穿堆叠条 / 图例 / 树行命中率：未缓存输入 `#E8A33D`、缓存命中 `#35B6A4`、
  缓存写 `#9A8CF2`、输出 `#E4675C`。浅色主题下这四个要在 `body:not([data-ds-dark-theme])` 里压深
  （`#B57515` / `#0B8071` / `#6B5ACB` / `#C4423A`），否则青色小字在白色底上只有 2 点几的对比度。
- 其余颜色**全部走 `--dsw-alias-*` 语义变量**，不要写死深色。深色/浅色两套都要过一遍截图。
- 树行是「名字 + 数值」一行、「代理数 / 步 / 请求 / 命中」一行，**meta 行用 `margin-left:17px` 跳过 twisty**，
  否则会显得比名字更靠左。
- 有子节点的行给 `▾/▸` 折叠按钮，叶子行给**空占位**（同宽 14px），不放 `•` —— 放了名字就对不齐。
- 长标题优先保名字：占比之类的次要信息别占名字那一行的宽度。
- `header` 入口按钮必须保持 `.dshtt-hbtn`（28×28 图标），**别再改回带文字的胶囊**，见 P6。


---

## 九、踩过的坑速查

| 现象 | 真实原因 |
|---|---|
| 日志读出只有 1 条 `{"type":"session"}` | 多帧 zstd，只解了第一帧 |
| `dsh --dump-config --profile desktop` 报「managed exclusively」 | desktop 被 Electron 独占，用临时 profile 验证 |
| 面板空白 / 树渲染成空 | `findRoot` 拿不到 id（已修） |
| 切到 fresh 后百分比 1804% | 行数字换了口径但百分比没换（已修） |
| 命中率恒为 `null` / 显示「—」 | `cacheRead` 和 `input` 都是 0（真的没有请求），不是 bug |
| 命中率 100% 但 billed 还是很大 | 正常：billed 大头就是缓存读，命中率高说明缓存生效 |
| `guide: {...}` 注册报错 | `guide` 必须是**带 `id` 的数组**，`title` 必须是**函数** |
| 正文组件拿不到 sessionId | 侧栏正文的 owner props **直接带 `sessionId`**，不用 `useTabInfo` |
| probe 进程杀不掉 / job runner 报错 | 用 `taskkill /F`，或等几秒重试 |
| 测试全绿但界面还是难看 | 测试只验结构不验布局，跑 `node preview.mjs` + 截图 |

---

## 十、下一步建议（按优先级）

1. **重启 DSH 让两轮修复生效** —— 当前跑的还是旧代码
2. 观察一段时间，确认增量路径在**真实长会话**上不出偏差（`verify-incr.mjs` 只测了静态样本）
3. 如果要给别人用，`package.json` 里的 `private: true` 需要去掉，还要补 icon / locale
4. 5 个 audit 脚本可以合并成 `npm test` 一键跑

---

## 附：一句话总结给下一个人

> 这个插件的难点**不在 UI**，在**两条容易算错的口径**：
> ① `.zstd` 是多帧的，只解第一帧会得到空日志；
> ② `compaction/summary` 也消耗 token，只数 `assistant/message` 会系统性漏算。
> 改任何累加逻辑之前，先跑 `selftest.mjs` 和 `verify-incr.mjs`。
