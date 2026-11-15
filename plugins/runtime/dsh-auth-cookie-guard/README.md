# dsh-auth-cookie-guard

根治 DSH 桌面端「启动即崩」：

```
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (.../lib/main.js:8886:31)
    at async Object.start (.../lib/main.js:12195:22)
```

2026-11-03 凌晨那次崩溃就是它。**根因不是账号/凭据/网络，是请求头被自己越堆越大的 cookie 撑爆了。**

---

## 根因（已逐层取证）

| # | 环节 | 证据 |
|---|---|---|
| ① | 宿主每次启动都由 Electron 以 `--port 0` 拉起，拿到**随机端口** | `dsh-desktop-host/lib/index.js:234-240` 的 args |
| ② | 种 cookie 的名字是 `dsh-auth-` + `base64url(sha256(authority))`，authority = `127.0.0.1:<端口>` | `dsh-client-connection/lib/index.js:335-337`、`:463` |
| ③ | 端口随机 → **名字每次都变** → 上一条永远没人覆盖，只会堆着 | 本机 71 条名字**全部**能用 `sha256("127.0.0.1:"+port)` 反推出端口 |
| ④ | 它不是会话 cookie：`Max-Age` 给足一年（`cookieMaxAgeDays`），持久化在 `Network\Cookies` | `:348` 的 `sessionCookie()` |
| ⑤ | cookie 作用域是 **host（127.0.0.1）不含端口**，所以历史上所有 `dsh-auth-*` 对每个端口都算命中，一次请求全部发出 | Chromium 的 cookie 匹配语义 |
| ⑥ | 71 条 ≈ **16,009 字符**，越过 Node `maxHeaderSize = 16384` 字节 | 本机 cookie 库实测 15,867 字节 |
| ⑦ | 宿主回 **431 Request Header Fields Too Large** | netlog 抓到 `HTTP/1.1 431` |
| ⑧ | 壳进程 `if (!authenticated.ok) throw new Error("desktop welcome: Web authentication failed")` | `lib/main.js:8886` |

实测复现：离线自测从 0 开始按同一套算法累积，**第 76 次启动**首次 431（实机是 71 条，同量级）。

> 报告里说「约再启动 70 次后会再次触及上限」是**低估**：按本机实测每条 ≈ 225B，
> 从 0 堆到越线只要 **73 次左右**，且越线之后是**必崩**、不会自愈。所以手动清一次库只是把倒计时重置，
> 必须堵住「只增不减」这个机制本身。

## 怎么修

宿主插件摸不到 Electron 的 cookie 库，**也不需要摸** —— 每个发往宿主端口的请求都能看到完整
`Cookie` 头，也都能改自己的响应头。于是两层，**先救命、再根治**：

### A. 抬高头上限（先救命）

`server.maxHeaderSize` 在 Node 里是**运行期可写**字段。实测：

| 设置 | 16.2KB 的 Cookie 头 | 40KB 的 Cookie 头 |
|---|---|---|
| 默认（16384） | **431** | **431** |
| `.maxHeaderSize = 1MiB` | 200 | 200 |

所以哪怕某台机器上已经堆了几十条，**装上本插件后本次启动就能成功握手**。

### B. 种新 cookie 时顺手删旧的（再根治）

宿主种 cookie 走的是 `res.writeHead(303, {..., "set-cookie": ...})`。守卫在响应落笔前往
`set-cookie` 里追加 `dsh-auth-xxx=; Max-Age=0; Path=/`，把**本次请求里除新种之外的所有
`dsh-auth-*`** 一并清掉。

- Chromium 对 `Max-Age=0` 是**真删**（从持久库移除，不是覆盖成空值）；
- 于是下一轮只剩上轮那 1 条，再删 1 条、再种 1 条 → **稳态恒为 1 条**，永不累积。

**为什么只在「种新 cookie 的响应」上动手**：只有那一刻我们才知道哪一条是刚生效的（就在同一个
Set-Cookie 里），其余按定义全是垃圾。换成「见到旧的就删」会把当前有效的那条也删掉，等于自杀。

### 两个安全边界

- 只改**单次请求的响应对象**（`server.prependListener('request')` 里改那个 `res`），
  不碰 `ServerResponse.prototype`，其它代码路径零影响。
- 守卫内部任何异常都被吞掉并原样放行真实响应：**宁可没清理，也绝不干扰认证**。
- 删除指令单次最多 128 条（约 9KB）—— 这一条是自测炸出来的真实缺陷：库里若堆了 1500 条，
  一次性回 1500 条删除指令就是 100KB+ 响应头，客户端直接 `Parse Error: Header overflow`。

## 安装

已经装好了。手动重装 / 迁移时：

```powershell
# 1) 依赖（link 到本仓库，改代码立刻生效）
#    在 D:\DeepSeek-DSH\profiles\desktop\package.json 的 dependencies 里加：
"dsh-auth-cookie-guard": "link:D:\\DeepSeek-Workspace\\dsh-auth-cookie-guard"
#    再在 dsh.profile.bundles 数组里加一项："dsh-auth-cookie-guard"

# 2) 建立 node_modules 链接
New-Item -ItemType Junction -Path "D:\DeepSeek-DSH\profiles\desktop\node_modules\dsh-auth-cookie-guard" `
         -Target "D:\DeepSeek-Workspace\dsh-auth-cookie-guard"

# 3) 重启 DSH 桌面端
```

启动日志里会出现：

```
[dsh-auth-cookie-guard] 已挂载到宿主 http://127.0.0.1:<port> — maxHeaderSize (默认 16384) → 1048576；将在种新 dsh-auth-* cookie 时批量删除旧 cookie
```

## 验证

```powershell
# 机制复现 + 修复证明（20 项，会真的起 http server 跑 200 次启动）
node selftest.mjs

# 接线自测（假宿主，4 项：重试挂载、工具注册、disposer 还原）
node selftest-plugin.mjs

# 体检（应用开着时读不到库属正常，运行期守卫兜着）
node index.js --status
```

自测输出里最关键的三行：

```
实测：第 76 次启动首次 431；崩溃时 76 条 / 16490 字节     ← 不装守卫，复现崩溃
实测：200 次启动全部 303，罐内恒 1 条，Cookie 头峰值 215 字节 ← 装守卫，根治
实测：80 条（16468 字节）→ 一次响应后 1 条（215 字节）      ← 已堆爆的现场也一次收敛
```

运行时也可以直接问 AI：工具 `auth_cookie_status`（`action=status` 看状态，`action=prune` 离线清库）。

## 配置（都可选）

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-auth-cookie-guard
  name: dsh-auth-cookie-guard
  config:
    maxHeaderSize: 1048576        # 抬到多少字节；false 关掉抬高（只做清理）
    maxDeletionsPerResponse: 128  # 单次响应最多下发多少条删除指令
    raiseHeaderLimit: true        # 设 false 则不碰 maxHeaderSize
    cookiePrefix: 'dsh-auth-'     # 不是换前缀就别动
    cookieDb: 'C:\...\Network\Cookies'  # 只在 cookie 库不在默认位置时需要
```

## 离线抢救（应用已完全退出时）

```powershell
node index.js --prune-db
```

会先备份成 `Network\Cookies.bak-<时间戳>-auth-cookie-guard` 再删 `dsh-auth-*`。
应用开着时 Chromium 独占该库，此命令会明确告知「请先退出 DSH」，不会硬来。

> 注意：手动清库只是重置倒计时。**留着本插件**才是根本 —— 它让 cookie 数量恒为 1。

## 已知边界

- 依赖宿主 `webServer.server` 这个公开字段（`WebServer` 的 `this.server = createServer(...)`）。
  上游若改名，插件会在日志里明确报「守卫未挂载」而不是静默失效；届时改 `attachGuard()` 里的取值即可。
- 只处理 `dsh-auth-*` 这一个前缀，不碰其它 cookie。
- cookie 库体检在应用运行期间读不到（Chromium 独占），这是**正常态**，不是故障；
  真正干活的是运行期守卫，不依赖读库。
---

## 关于 npm 同名包

npm 上有一个 `dsh-auth-cookie-guard`（维护者 jitianjiyan），**与本目录不是同一份代码**。
本目录版本基于本机逐层取证写成，八个环节的证据链与实测复现次数都记录在本文档根因表里。

## 维护提示

这个插件依赖两个宿主实现细节：`server.maxHeaderSize` 运行期可写、以及 `dsh-auth-*` 的命名算法
（`dsh-auth-` + `base64url(sha256(authority))`）。宿主一旦改掉任一前提，本插件需要重新验证。
