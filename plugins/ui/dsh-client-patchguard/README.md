# dsh-client-patchguard

本地客户端插件补丁的**守卫**：把「往别人包里塞 settings.section」这类本地改造，
做成每次启动都会自动重打、并且不会写坏 pnpm 存储的东西。

## 它解决的具体事故

2026-10-31 22:14，插件市场把 `dsh-connect-workbuddy` 更新到 5.16.0，整份覆盖了
`lib/client.js`。那份文件里原本有本地补丁注入的 `settings.section` 注册 —— 覆盖之后
补丁消失，表现就是**设置页里 WorkBuddy 又没有自己的分区了**（只能去「插件 → 已安装 →
点进 dsh-connect-workbuddy」看那张卡片）。

上游插件本身没有 bug：它设计上就只注册 `plugins.bundle.config` / `plugins.row.config` /
`conversation.*` / `shell.quota-notice`，从不注册 `settings.section`。

## 两个机制

### 1. 重打（against 覆盖）

配方 = `recipes/*.json`，每条记录「几个精确字符串替换 + 更换前后整份文件的 sha256」。
守卫在两种时机执行：

- **宿主启动时**：`apply()` 里立刻跑一遍。
- **运行期轮询**（默认 3000ms）：按 `mtime:size:ino` 变化触发。市场在会话中途更新插件也
  能打回去；`dsh-client-hmr` 每 500ms stat 轮询 `lib/client.js`，所以改写后浏览器里会自动
  热换 bundle，不用重启宿主。

三态判定（`detectState`）：

| 状态 | 含义 | 动作 |
|---|---|---|
| `applied` | 已打过补丁 | 什么都不做 |
| `pristine` | 原始未打补丁 | 套用配方，**先校验锚点唯一命中 + 结果语法合法**才落盘 |
| `unknown` | 锚点失配（上游改版） | **只告警，绝不改动** |

强度保证：
- 每个锚点必须**恰好命中 1 次**，否则整条配方放弃（不做「大概对」的猜测替换）。
- 落盘前用 `new vm.Script` 编译整份结果（客户端 bundle 是 classic script）；语法不合法就不写。
- `patchedSha256` **不是**闸门而是漂移探测：上游改了无关代码时它必然不同，此时照样打补丁，
  只在报表里标注「上游有其它改动」。把哈希当闸门会让补丁在上游小改后静默失效 —— 那正是
  这次事故的样子。
- 写入后回读校验；不符立刻回滚成原内容（宁可没补丁，也不留半坏 bundle）。

### 2. 不写坏 pnpm store（这条比补丁本身更重要）

pnpm 的安装文件与内容寻址存储（CAS）是**硬链接**：

```
D:\.pnpm-store\v11\files\ba\614bdba14565229b...  ←→  <profile>\node_modules\dsh-connect-workbuddy\lib\client.js
```

两者是同一个 inode（`nlink=2`）。用 `fs.writeFileSync(目标)` 就地在原地写，会把 store 里
那份「按内容寻址」的原始文件**一起改脏**，而且没有任何报错 —— 下一次 pnpm 从 store 重建
任何共享这份内容的 profile / 版本，都会装出被改过的文件。

所以本插件唯一的写入口是 `writeBreakingHardlink()`：**同目录临时文件 + `rename`**。
rename 之后新文件是独立 inode（`nlink=1`），store 那一端纹丝不动。

`healStore()` 负责收拾已经被就地写穿的历史包袱，顺序不能反：

1. 安装文件若仍是硬链接（`nlink>1`）却已不是原始内容 → 先用「临时文件 + rename」把它
   变成独立 inode（**保住补丁内容**）；
2. 再把 pristine 内容写回 CAS 条目（此时安装文件已经不受影响）。

反向还原出来的内容会算 sha512，只有**正好等于 CAS 条目的路径名**才认定这是对应的那份
原始文件 —— 不靠猜。

## 用法

```powershell
# 直接看状态（不写盘）
node index.js --dry

# 打补丁/修 store
node index.js

# 指定路径（默认自动探测 DSH_HOME / ~/.dsh，再向上找 .pnpm-store）
node index.js --profile-dir "D:\DeepSeek-DSH\profiles\desktop" --store "D:\.pnpm-store"
```

宿主内运行时由 `cordis.patch.yml` 的 bundle 层挂载，`apply(ctx, config)` 接受：
`profile`（profile 名，默认 desktop）、`profileDir`、`storeRoot`、`pollIntervalMs`。

报表落在 `<profile>\.dsh-patchguard\report.json`，首次改动前的原文件备份在
`<profile>\.dsh-patchguard\backup\`。

退出码（可直接拿来做开机健康检查）：0 = 全部 applied 或本次已 patched；
1 = 有 `unknown`（上游改版）/ `error` / `invalid-recipe` / `rolled-back`，或有配方该打却停在
`pristine`。

## 当前登记的配方

| 配方 id | 目标包 | 做什么 |
|---|---|---|
| `imagegen-settings-section` | dsh-image-gen | `settings.plugin.item` → `settings.section`，卡片根 `li` → `div` |
| `imagegen-compact-ui` | dsh-image-gen | 输入栏生图按钮：28px 带描边胶囊 → **28×28 纯图标**（999px 透明底、`label-secondary`、16px 图标），文字与箭头隐藏，`aria-label` / `title` 带当前 provider 名；弹出菜单同步收紧到 280px |
| `memory-compact-ui` | @restregular/dsh-memory | 输入栏「记忆权限」按钮：28px 描边实底卡片 → **28×28 纯图标幽灵按钮**；**按钮上的作用域数字已去掉**（数量与限制等级只由 `title` / `aria-label` / 面板表达） |
| `workbuddy-credits-icon-only` | dsh-connect-workbuddy | 积分读数「WB CN · 2,357」文字 → **28×28 硬币图标按钮**，余额与地区留在 `title` / `aria-label` |
| `pdf-mineru-settings-section` | dsh-pdf-mineru | 新增 `settings.section` 注册（复用同一 `SettingsPage`），中英字典各加 `sectionLabel` 导航标签 |

> **输入栏插件按钮的统一口径（2026-11-14 修正）**：三个插件控件（积分 / 生图 / 记忆）都是
> 28×28、999px、透明底、`label-secondary`、**16px 图标**（= 宿主模型座位
> `IconDataOutlineRegular size={16}` 的大小）。
>
> **间距一律由容器决定，插件侧不要再写任何负 margin。** 宿主工具条
> `.GRgSLq_standardControls{gap:12px}` 是 `conversation.input.right` 的 list 槽和
> `conversation.input.model` 座位共用的那个 flex 容器 —— 三个插件按钮和右侧模型选择器都在里面。
> 所以 `imagegen-compact-ui` 里加了一条 `div[class*="_standardControls"]{gap:5px !important}`，
> 把容器 gap 收到 5px；三个插件自己的 `-wrap` / `-root` 保持零 margin。
>
> 为什么不再用负 margin：之前是三个插件各写 `margin-inline:-3.5px` 去凑 12−7=5，
> 结果是①跨 slot 边界那一格（记忆→模型）凑不到，②任何一条被别的规则盖住就立刻变成
> 「一紧一松」，实测截图里就是 16px 与 12px 不等。容器 gap 只有一个来源，改一处全齐。
>
> **图标描边统一 1.5**：宿主 16px 图标的 `strokeWidth` 标准值就是 **1.5**（app.asar 里 16 网格图标
> 共 26 个，其中 102 处 `strokeWidth` 取 1.5，是绝对主流）。三个插件图标原先 1.6（生图 / 积分）
> 与 1.3（记忆）各自为政，截图里看着亮度不一 —— 其实是笔画粗细不同导致抗锯齿后覆盖率不同。
> 现在三条统一 1.5。注意记忆插件的 `NavLineIcon` 被**两处**复用：输入栏按钮和轨迹行 12px 徽标，
> 只改前者（锚点带上 `function NavLineIcon(` 签名），后者保持 1.3。
>
> **皮肤主题的染色陷阱（2026-11-14 踩过）**：`@smalltailqwq/dsh-client-ui-skin-maid-atelier`
> 有一条 `body[data-dsh-maid-atelier][data-ds-dark-theme] [data-composer-card] [class*=trailing]
> button[aria-haspopup=menu]{color:#e7ecf7}`。生图按钮恰好是**唯一**带 `aria-haspopup="menu"` 的
> composer 插件按钮（积分是 `dialog`、记忆没有该属性），于是被单独染成 `label-primary`，
> 截图里就它更亮。改 `.dsh-ig-pill-button` 自身的 `color` 没用 —— 特异性打不过 `body[...][...]` 那条。
> 解法是加一条 `button.dsh-ig-pill-button{color:...!important}`，`!important` 才能压过皮肤。
>
> 预览：`D:\DeepSeek-Workspace\dsh-image-gen\preview-composer.mjs` 直接从三个已打补丁的
> bundle 里按选择器抓 CSS 生成对照页（不手抄），改完 CSS 记得重跑一次；它会把实测的
> 盒子间距 / 图形间距 / 按钮尺寸 / 文本节点数一起打印出来，改错了一眼就能看见。

> ⚠ **不要写链式配方**：image-gen 这两条最初是「compact 改尺寸 → icon 去文字」两级串联，
> 上游一更新，第二级的锚点就落在中间态上、必然 `unknown`。现已合成**一条** `imagegen-compact-ui`，
> 以真正的上游原始文件为基线，24 个 op 一次到位。以后再加 UI 改动也在同一条配方里追加 op，
> 不要新建「依赖前一条配方结果」的配方。

`pdf-mineru` 这条的锚点特意带上 `apply()` 的结尾 `exports.apply = apply;`，
所以**只有原始文件**（还没插过 section）才会命中；已经打过补丁的文件一律判成 `applied`，
不会因为「`old` 锚点仍存在」而被重复套一遍。页面根节点本来就是 `div` + flex column，
不需要 `li` → `div` 改造（不能照抄前两条配方）。

> **换行符陷阱（2026-11-14 踩过）**：`@restregular/dsh-memory` 0.31.0 的 bundle 是 **CRLF** 换行，
> 而配方里的多行锚点当初按 LF 写的 —— `detectState` 判成 `pristine`，`applyOps` 却在
> 「命中 0 次」上直接放弃，结果就是**补丁静默没打上**，界面回退成旧样式。
> 所以：写跨行锚点前先确认目标文件的行尾（`
` 还是 `
`），锚点必须与之一致；
> 单行锚点不受影响。生成/校验配方时用 `open(..., newline="")` 读，别让 Python 替你翻译行尾。

## 加一条新配方

```jsonc
{
  "id": "某个包-某个目的",
  "package": "要改的包名",
  "file": "lib/client.js",
  "testedWith": ["1.2.3"],
  "pristineSha256": "未打补丁时的整份文件 sha256（大写十六进制）",
  "patchedSha256": "打完的整份文件 sha256",
  "pristineMarkers": ["原始版里有、打完就没有的片段"],
  "appliedMarkers": ["打完才有的片段"],
  "ops": [{ "tag": "这个替换干什么", "old": "精确原文", "new": "替换成什么" }]
}
```

锚点用**带缩进的精确原文**（tabs 也要一致），不要用正则 —— 精确字符串才能保证
「命中次数」是可判定的。

## 已知边界

- 上游把那段代码改得面目全非时，配方会停在 `unknown` 并告警。这是有意的：改不出来
  比改错强。届时需要人工重新对照新版生成锚点。
- 只看护本文件里登记的配方，不做通用 diff/patch。
- 不改 profile 的 `cordis.patch.yml`：机器相关路径都在运行时探测。

