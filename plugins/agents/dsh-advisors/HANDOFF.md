# 只读顾问插件 · 交接文档

> 初稿 2026-11-13，同日续修。目标是让接手的人（或下一个 AI）在**不重读整个开发过程**的
> 前提下，能把这个插件改对、改完、不再踩同样的坑。
>
> **先读第 0 节。**

---

## 0. 当前状态（必读）

### 已做完、验证过的

| 功能 | 状态 | 证据 |
|---|---|---|
| 顾问子智能体（只读） | ✅ | 实跑返回结构化方法建议 |
| 运行时只读守卫 | ✅ 机制已核实 | 见下方「守卫的证据强度」 |
| 模型菜单开关（session 级） | ✅ | Slot 里 `dsh-advisors` occupant `active: true` |
| 四领域各自选模型 | ✅ **本次做完** | 设置页可换，`ask_advisor` 真的按选择派发 |
| **下拉控件自绘（深色主题可用）** | ✅ **本轮修复** | 弃用原生 `<select>`，见坑 8 |
| **新会话默认开启** | ✅ **本次新增** | `defaultEnabled`，会话显式值优先 |
| 开关与选择持久化 | ✅ | `$DSH_HOME/dsh-advisors.json` |
| 离线回归测试 | ✅ 192 条断言 | `npm test` |
| 后端任务 A/B 验证 | ✅ 有硬结论 | 见第 5 节 |

### 本轮修掉的真实 bug

**`loadState()` 会把用户的选择整个丢掉。** 原实现只挑出 `sessions` 返回：

```js
return { version: 1, sessions }   // ← routes 在这里被扔了
```

后果：设置页写进 `dsh-advisors.json` 的 `routes` 在下一次插件重载后**静默失效**，界面还显示
着旧选择。这个 bug 只有「写 → 重载 → 再读」才能发现，单看代码很像对的。
回归断言在 `test/host-probe.mjs` 里，标题就是「重载后用户选择没丢（曾经会被 loadState 吞掉）」。

同类的第二处：`routeOf()` 等六个函数原本**只有定义、没有调用**，`ask_advisor` 用的是闭包里的
`routes`。已接线，回归断言是「顾问实跑 Claude（回执 kele-claude/claude-opus-5-5）」。

### 守卫的证据强度（诚实说明）

2026-11-13 复验时，让顾问主动调 `send_meme` 采集拒绝文案，**三个顾问都拒绝尝试**，理由是
预设禁止越界。这是「预设边界 + 模型遵守」的证据，**不是**工具层守卫的证据——顾问根本没发起调用。

工具层的真实证据来自源码链路（`@deepseek-ai/dsh-tools`）：

- `ToolsService.checkGuards(exec)` 遍历 `[global, ...chainLayers(exec.agent)]` 上的 guard；
- guard 返回字符串 → 折叠成 `{ reason }`；
- `pipeline.ts` 的 `prepare()` 把拒绝物化成 `content: [{type:'text', text:'Error: <reason>'}]`、
  `isError: true`，**直接 `return` 成 `post-result`，不进入 `dispatch`**。

也就是说：**只要 guard 被正确挂到顾问 agent 的 scope 上**（`agent.ctx.tools.guard()`），
调用时刻必然被拦。`test/host-probe.mjs` 验证的是「挂载与判定逻辑」这一段；
「`agent.ctx` 的 scope 确实等于 `exec.agent` 的 scope」这一段是对 `dsh-scope` 的 `ScopedLayers`
源码推断的，**尚未用一次真实越界调用证伪或证实**。

**待办（真正该做的那次验收）**：让顾问真的调一次宿主级工具并看到 `Error:` 文案。
可行做法是把 `send_meme` 之类挂成**必然执行**的桩（例如临时在 profile 里加一个无副作用的
`noop_host_tool`），再让顾问调它。当前做不到，是因为任何「可疑」的工具调用都会被预设提示词挡下。

---

## 1. 插件是什么

给主智能体配一个**只读顾问**：遇到前端/审美/建模/后端设计问题时，开一个真子智能体去问方法与建议，
顾问**绝不参与实施**。

- 位置：`D:\DeepSeek-Workspace\dsh-advisors`
  （junction → `D:\DeepSeek-DSH\profiles\desktop\node_modules\dsh-advisors`）
- 包名 / loader id：`dsh-advisors`
- Client 注册 id 必须等于包名，否则 ModuleLoader 报 "loaded without registering dsh-advisors"

### 文件职责

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：`ask_advisor`、只读守卫、HTTP 路由、模型目录、路由优先级 |
| `client.js` | Client 半边：模型菜单开关行 + 设置页（四个领域下拉、默认开启） |
| `cordis.patch.yml` | 两行：`preset-advisor`（只读预设）+ `dsh-advisors`（插件本体） |
| `locale/{zh,en}.json` | 插件详情页的 `meta.title` / `description` |
| `docs/DETAIL.md` | 插件详情页正文 |
| `test/host-probe.mjs` | Host 半边回归（49 条断言） |
| `test/client-probe.mjs` | Client 半边回归（49 条断言） |
| `test/shim-loader.mjs` + `test/fixtures/` | 把 `@deepseek-ai/dsh-tools` 重定向到测试替身 |

---

## 2. 三层只读边界（核心设计，不要简化）

顾问「不能干活」靠三层互不依赖的机制，缺一层都有漏洞：

### 第一层：预设边界

`cordis.patch.yml` 里的 `preset-advisor`，工具面只有：

- `read` / `read_image`（`tool-fs` 显式关掉 `write` / `edit` / `applyPatch`）
- `glob` / `grep`（`tool-fs-search`）
- `time-context`

**没有** bash、pwsh、todo 等。

### 第二层：运行时双重闸（关键）

`index.js` 在 `agent/created` 里识别 `agentPreset === 'advisor'`，装上两道：

```js
// 闸一：声明式硬边界（执行级，不是只藏 schema）
agent.ctx.tools.restrict({ allow: [...ADVISOR_TOOL_ALLOWLIST] })  // read/read_image/glob/grep

// 闸二：调用期兜底，给出可读理由
agent.ctx.tools.guard((execution) =>
  ADVISOR_TOOL_ALLOWLIST.has(execution.name) ? undefined : '顾问会话只回答问题…')
```

**为什么必须有这层**：预设只能限制「挂什么工具」，但**宿主级工具**（`send_meme`、`plugin_manager`、
`cordis_run`、`workflow`、`schedule`、`subagent`）是从宿主配置进来的，预设管不到。
`restrict` 同时作用于 `view()` 与 `executable()`，非白名单工具既不可见也调不动；`guard` 负责拒绝文案兜底。

> **⚠️ 别再改回 `restrict({ allow: [] })`。** 曾经这么写过（理由是「自身 scope 的工具不受
> restrict 影响，allow:[] 正好只留预设自己的工具」），但真机实测**工具面直接变 0 个**
> （会话 `8e83baa6`，`request/header` 的 `toolCount: 0`）。原因是 `read`/`read_image`/`glob`/`grep`
> 是 bundle 级插件注册进**全局层**的，不在 agent 自己的 scope 里，`own` 为空 →
> 全在 `inherited` → 被 `allow:[]` 一并掐掉。**必须精确列出四个名字。**
> 白名单里写错名字不会静默通过：`restrict()` 的 unknown 检查会抛错。

**失败策略（顺序有意义）**：

| 失败点 | 行为 |
|---|---|
| `restrict` 装不上（名字不存在等） | 退回「仅 guard」模式并 warn——拒绝语义仍成立，不中止顾问 |
| `guard` 也装不上 | **fail-closed**：`agent.cancel()` 中止顾问，绝不让它带全量工具裸奔 |

**卸载/热重载顺序**：`liveAdvisors` 记录存活顾问，插件拆卸时**先 `cancel()` 中止顾问，再摘守卫**。
顺序反了会留下「守卫已摘、顾问还在跑」的可执行裸奔窗口。`agent/disposed` 时清理记录。

实测证据：早先版本（仅 guard）让顾问调 `send_meme`，返回：

```
Error: 顾问会话只回答问题、不参与实施：`send_meme` 在顾问会话里被禁用。
需要动手的部分请交回主智能体。
```

> ⚠️ 2026-11-13 同日复验**没能复现**该文案（顾问拒绝发起调用，见第 0 节「守卫的证据强度」）。
> 现版本已用 `restrict` 从工具面直接摘除，不再依赖「顾问是否愿意发起调用」。

### 第三层：深度边界

启动时 `maxDepth = 父深度 + 1`，顾问不能再往下派子智能体。

> **这里曾经有个 bug**：最初硬编码 `maxDepth: 1`，导致**子智能体开不了顾问**
> （子智能体深度 1 → 顾问深度 2 → 超限被拒）。
> 改成「父深度 + 1」后，主智能体和子智能体都能开顾问，顾问自己仍派不了下一层。
> `delegationDepthOf()` 是内联实现的，逻辑与 `@deepseek-ai/dsh-subagent` 的
> `delegationDepthOf` 一致（取 `session.header.delegationDepth` 与 `options.subagentDepth` 的较大值）。

---

## 3. 模型切换（本轮做完的部分）

### 三层优先级

```
设置页选择（dsh-advisors.json 的 routes）
      ↓ 没选
插件 config 的 routes（cordis.patch.yml 覆盖）
      ↓ 没配
DEFAULT_ROUTES（四个领域全 GPT-6 Astra）
```

目录里查不到的 `provider/model` **也接受**——它可能来自 profile 里新增、目录尚未收录的模型。
设置页会把它标成「目录外」而不是静默丢弃。

### HTTP 接口

`POST /dsh-advisors-api` 三个分支，按 body 区分：

| body | 作用 |
|---|---|
| `{ domain, modelId }` | 设置某领域模型；`modelId: null` = 清除、回退默认 |
| `{ sessionId, enabled }` | 会话开关 |
| `{ defaultEnabled }` | 新会话默认值 |

`GET /dsh-advisors-api?sessionId=…` 返回 `{ ok, enabled, defaultEnabled, catalog, catalogMeta, domains }`，
其中 `domains[].selected` 是用户显式选择（没选为 `null`），`effective` 是最终生效路由，
`availability` 是 `listed` / `missing` / `unknown`（判断的是 **effective**，不是 selected）。

`GET /dsh-advisors-api?view=state` 是**轻量分支**：只回 `{ ok, enabled, defaultEnabled, domains }`，
完全不碰 LLM。模型菜单里那一行开关走这个，不该为它枚举十几条通道。

### 模型目录：现查，不再写死（2026-11-14 重写）

**旧版有一份写死的 `MODEL_CATALOG`（8 条），其中一半指向不存在的 `apikey1`，
而 profile 里真实配好的 kele-claude / kele-gemini / apikey-gemini / kele-gpt /
workbuddy / qoder / trae 一条都看不到。主人指出后改成现查。**

现在的实现要点（每一条都是顾问审出来的真实 bug，不要简化）：

| 机制 | 为什么 |
|---|---|
| `ctx.get('llm')`，**不进 inject** | 写进 inject 会让插件在 llm 缺席/热替换空窗期完全不挂载——连 ask_advisor、开关、守卫都没了 |
| 30s TTL + single-flight | 并发请求共享同一个 in-flight Promise |
| in-flight 带 `{ generation, promise }` | 失效后旧代不得写快照、不得更新 lastCatalog、不得清掉新代记录 |
| `llm/adapters-updated` → 作废缓存 + **清空冷却表** | 配置变了，旧的失败判断不再适用 |
| 单通道 5s 超时 | 永不完成的 listModels 不许卡死请求 |
| 失败通道 60s 冷却，**读写都受 generation 约束** | 否则旧代的失败会把已修好的通道重新打进冷却（反方向也成立） |
| 兜底目录**先归一化再缓存** | 曾经把空目录写进快照、只把本次返回值换兜底 → 第一次有内容、第二次变空 |
| POST 不 await 目录 | 保存不该等最慢通道那 5s；回执只带 stateView |
| `saveState()` 抛错 + `commitState()` 先落盘后提交 | 否则磁盘满时谎报「已保存」，重启后配置丢失 |

> 实测当前 41 个模型 / 13 条通道。加新模型**只需改 profile 的 `llm-pi-ai`**，
> 不需要动插件一行代码。

### ⚠️ 已知的通道陷阱：`claude-opus-5-5` 目前不可用

2026-11-13 实测（记录在 `cordis.patch.yml` 第 119–122 行的注释里）：
旧 `apikey1` 网关上的 `claude-opus-5-5` **三次均 HTTP 500「All available accounts exhausted」**，
纯文本请求同样 500 —— 网关账号额度耗尽，不是能力问题。

表现是顾问**中途失败、无收尾消息**。我本轮就撞了一次：
把 `aesthetic` 换成 `claude-opus-5-5` 后 `ask_advisor` 回执正常（`kele-claude/claude-opus-5-5`），
但顾问跑了 25 秒后静默失败；换成 `claude-sonnet-5-5` 立刻成功。

**教训**：设置页把某个领域指向一个挂掉的模型时，失败信号是「顾问静默消失」，
`ask_advisor` 本身不会报错（它只负责启动）。要么在目录里给不可用模型加标注，
要么接受「换模型后先发一句最短的试探咨询」。

> **2026-11-14 补充**：目录现在是现查的，`availability` 只说明「在目录里」，
> **不代表真的能调通**——目录枚举不是执行能力探测。这条教训依然成立。
> 好消息是 `kele-claude` 通道上的 `claude-opus-5-5` 现在是可用的（上面那次失败是旧 `apikey1` 网关的额度问题）。

---

## 4. 开关：为什么不用 Session 事件

**决策**：开关状态存 `$DSH_HOME/dsh-advisors.json`，不走 Session log。

理由：

- 插件**不能** `session.append()` 新的事件类型。唯一允许写日志的是 `appendPluginRecord()`
  （`plugin:` 前缀 + `ignorable: true`），但它**门槛极高**：
  session 必须已 entered、creation announcement 已完成、不能重入其他 append 的 publication，
  且 `PluginRecordMap` 需要类型映射。**实测直接调会被拒**。
- 更重要的语义理由：开关是**界面偏好**，不是对话内容。塞进日志会污染 fork/resume。

**代价**（要如实知道）：按 session id 存，所以**新建/重命名会话后要重新打开**。
本轮加了 `defaultEnabled` 缓解这一点：新会话跟随全局默认，显式值优先。

**为什么不复用 Agent Teams 的做法**：它用 `session.append('team/mode')`，因为 `team/mode`
是 DSH 核心包里**已注册**的事件类型。我们不是核心包，拿不到这个权限。

---

## 5. A/B 验证结论（决定要不要用这个插件的依据）

同一个 spec 交给两个子智能体，一个带顾问、一个不带。

### 后端任务（并发队列）：**顾问明显赢**

| | 带顾问（GPT-6 Astra） | 单干 |
|---|---|---|
| 测试数 | 47 全绿 | 33 全绿 |
| 测试耗时 | 0.13s | 4.4s |
| **超时后并发峰值**（上限 2） | **2 ✅** | **12 ❌ 超 6 倍** |

单干版用 `Promise.race` 判超时后**立刻归还槽位**，但不听话的旧任务还在跑 → 实际并发失控。
它自己的 README 承认了「结果被丢弃」，却**没意识到槽位也被提前还了**，
把并发失控归因于「CPU 密集任务堵死事件循环」——归错因了。

顾问版 README 里是一张显式取舍表：

```
| 承诺 | 本实现 |
| 不合作任务被终止 | ❌ |
| 实际并发严格有界 | ✅ |
| 超时后立即重试 | ❌ |
```

**变异测试证明这些测试不是摆设**：退避置零 → 4 个失败；删 `#settling` 守卫 → 命名回归测试立刻失败；
并发 `while (running <= max)` → 8 个失败。

### 前端审美任务：**Astra 没跑赢 Claude**

三个版本（同一 spec）：

- **Claude Opus 5.5 顾问版**：分组语义最准（把「通知」和「安全」分开——前者只是打扰，后者涉及账号安全）
- **GPT-6 Astra 顾问版**：工程严谨（抓出 3 个真 bug，如「opacity:0 的开关上画 outline 看不见，
  键盘用户失去焦点提示」），但把邮件通知和双因素认证塞进同一个「偏好与安全」，语义混淆
- **单干版**：最有美学主张（手写账本风），但**黄铜色在深色模式下对比度不足**

**结论：Astra 是好的工程审稿人，不是更好的审美裁判。**
这正是「四领域可各自选模型」的理由。默认仍全 Astra（主人 2026-11-13 的要求），
但审美那一路可以随时换成 Claude（用 `claude-sonnet-5-5`，别用当前挂掉的 `claude-opus-5-5`）。

### 三个版本的技术验证（都是 0 缺陷）

CDP `Emulation.setDeviceMetricsOverride` 精确测 320/390/768/1100 四个宽度：

```
frontend-astra:        溢出全 0
frontend-with-advisor: 溢出全 0
frontend-solo:         溢出全 0
```

三份都零外部依赖（唯一的 `http://` 是内联 SVG 的 `xmlns`，不发起请求）。

---

## 6. 踩过的坑（血泪，别重复）

### 坑 1：用 `--window-size` 判断响应式，结论是错的

`chrome --headless --window-size=320,1200` **不等同于视口 320px**，截图会显示「溢出」假象。
差点据此冤枉 Astra 版「汇报造假」。

**正确做法**：CDP `Emulation.setDeviceMetricsOverride({ width: 320, height: 900, mobile: true })`，
然后读 `document.documentElement.scrollWidth` vs `window.innerWidth`。

### 坑 2：变异测试的替换字符串必须验证真的替换成功

第一次做变异时替换 `this._running >= this.concurrency`，但真实代码是
`while (this._running <= this._options.concurrency)` —— **没匹配上**，
却因为「测试全绿」差点得出「测试没守住」的错误结论。

**铁律**：变异后先 `Select-String` 确认改动真的落进文件，再看测试结果。

### 坑 3：Inspect 的 `listTools` 不套 `when()`

`cordis_inspect_query` 的 `Tool.listTools` 走 `tools.view()`，**不应用** step-time 条件。
所以开关关掉后 `ask_advisor` 仍会出现在清单里——**这是 Inspect 的限制，不是 bug**。

真正的准入在每一步的 `tools.resolve(context)`：`when` 返回 false 就不进 admitted 集。

### 坑 4：`install_bundle` 对已装包报 `already-installed`

不是失败。本包是 junction 安装，改源码直接生效；Host 靠 HMR 重载，
**Client 半边要刷新页面**。

**坑 4b（本轮踩的）**：改完 `index.js` 后 `curl` 拿到的仍是旧回执——HMR 并没有重载 Host 半边。
解决办法：`plugin_manager` 把 `include:dsh-advisors` **关掉再打开**。
判断依据是回执里有没有新加字段（本轮是 `catalog` / `defaultEnabled`）。

### 坑 5：清理目录时把别的 agent 的产物删了

之前一个被取消的 workflow 留下了前台 agent 在跑，重置 `ab-test` 目录时把它们的产物删了。
两个 agent 自己恢复了（其中一个还去回收站核实是永久删除）。

**教训**：取消 workflow 后先 `list_agents` 确认没有残留 agent，再动目录。

### 坑 6（本轮新）：`DSH_SESSION_ID` 才是「我在哪个会话」

一度按 session 目录的修改时间去猜当前会话，猜错了——把测试开关写到了另一个会话上。
**正确做法**：`$env:DSH_SESSION_ID` 就是当前会话 id，直接读，不要猜。

### 坑 7（本轮新）：写探针时 `.NET` 静态调用用的是进程 cwd

PowerShell 里 `cd` 之后 `[System.IO.File]::ReadAllText('test/x.mjs')` 仍按进程启动目录解析，
于是「文件不存在」。要么传绝对路径，要么用 PowerShell 自己的 cmdlet。

### 坑 8（本轮新，代价最大）：原生 `<select>` 在 Windows 深色主题下选项不可见

第一版设置页用了原生 `<select>`。截图一看：触发框正常，但**展开的选项列表是白底白字**，
完全没法选。原因不是颜色写错了：

- 宿主的深色主题靠 `body[data-ds-dark-theme]` 换 token（`design-platform.css`）；
- 但 `<option>` 的弹出层是**操作系统控件**，Windows 上不读页面 CSS，只跟系统的浅色外观走。
  页面给 `select` 设 `color`/`background` 管不到弹层。

**结论**：凡是「用户要在一组带说明的选项里挑一个」的地方，别用原生 `<select>`。
改成自绘：`button[aria-haspopup=listbox]` + 绝对定位面板，颜色全部走 `--dsw-alias-*`。

顺带解决的三件事（原生控件本来就给不了）：
1. **每个选项显示完整模型 id**（`kele-claude/claude-opus-5-5`）。只看 label「claude-opus-5-5」
   分不清 5 和 5.5，选错了会静默失败（见「通道陷阱」）。
2. **显示 note**（「审美与语义分组更强」）——挑模型靠的是这句判断理由。
3. 键盘可用（**2026-11-14 改成搜索框统一管理焦点**，旧描述已过时）：
   - 触发器上 `Enter`/`Space`/`↓` 展开 → **焦点自动进搜索框**
   - 搜索框里 `↑↓` 移动高亮（`aria-activedescendant` 同步）、`Enter` 选中、
     `Esc` 关闭并还原焦点到触发器、`Tab` 正常离开（由根节点 `onBlur` 判断焦点是否真的走了）
   - 选项是 `div[role=option]` **不是 button**：40+ 项不能都进 Tab 序列
   - 搜索框里空格就是空格（旧版 `Space` 是选中键，会误触）
   - 输入法组合中不抢 `Enter`（`composingRef` + `nativeEvent.isComposing` + `keyCode 229` 三重判断）
   - 选项 `onMouseDown` 对主键 `preventDefault()`：否则点一下只关面板、不选中
   - 展开后点外面关闭（捕获阶段监听，避免被宿主面板 `stopPropagation` 吞掉）

> **面板不上下翻转**，固定向下展开，靠列表自身滚动 + 宿主设置页滚动兜住。
> 没有 portal 的前提下测量裁剪祖先成本偏高，作为已知限制接受。

**这个坑在离线渲染探针里查不出来**——探针只验证逻辑，看不到「白底白字」。
是主人截图才发现的。教训：**UI 改完必须真看一眼**，逻辑测试全绿不代表能看。

### 坑 9（本轮新）：探针的实例身份要按 key 区分，不能只按位置

四个领域行的结构完全相同。探针一开始按渲染路径（位置）缓存组件实例，
结果展开第 2 个下拉时复用了第 1 个的 `open` 状态，断言「找不到 Claude 选项」——
是**探针错了**，不是产品错了。修法是身份改成「路径 + 组件名 + key」，对齐 React 的 key 语义。

另外探针必须模拟 `ref.current` 指向真实节点（`attachRefs()`），否则依赖 ref 的
「点外面关闭」逻辑在探针里永远走不到，会得到假阴性。

### 坑 10（2026-11-14，主人实测）：`position:static` 元素上的绝对定位伪元素会盖住整个面板

**现象**：打开「设置 → 顾问」后，**点哪里都没反应**，必须点旁边空白退出再进。
页面渲染完全正常，四个领域行、开关、下拉都在，但所有点击被吃掉。

**根因**（两行 CSS 的组合）：

```css
.dsh-advisors-switch{position:static; ...}                   /* 开关自己不是定位元素 */
.dsh-advisors-switch:after{position:absolute;inset:0; ...}   /* 伪元素却是绝对定位 */
```

伪元素找不到已定位的父级，包含块一路上溯到宿主设置面板的定位容器，
`inset:0` 就让它铺满整个面板 —— 一张**透明的点击遮罩**。

那个 `:after` 的原意是让「模型菜单」那一行整行可点（`.dsh-advisors-row` 有
`position:relative`，所以那里没问题）。设置页的开关没有这个祖先，就漏成了全屏遮罩。

**修法**：用祖先选择器限定作用域，不是给开关加 `position:relative`
（后者会让伪元素缩进开关内部，反而破坏整行点击）。

```css
.dsh-advisors-row .dsh-advisors-switch:after{...}   /* 只作用于菜单行 */
```

**通用规矩**（顾问建议，写在这里免得再犯）：

1. 任何 `position:absolute` 的元素**或伪元素**，其父级必须显式 `position:relative`。
2. 公共基础类上不要直接挂绝对定位伪元素；要挂就用祖先选择器限定上下文。
3. 同结构控件复用在多处时，**祖先链不同**就是行为差异的来源 —— 必须验证每个上下文。

**为什么探针抓不到**：这类「渲染正常但点不动」的 bug 属于 CSS 包含块计算，
最小 hooks 运行时根本不计算布局。只能靠**选择器层面的断言**守住：

```js
assert(!cssRuleLines.some(l => /^\.dsh-advisors-switch:after\s*\{/.test(l)), '没有裸规则')
assert(cssRuleLines.some(l => /^\.dsh-advisors-row\s+\.dsh-advisors-switch:after\s*\{/.test(l)), '有前缀')
```

同类教训见坑 8（原生 `<select>` 深色主题）—— 都是**逻辑全绿、肉眼才发现**。

---

## 7. 关键 API 速查（都是实测过的）

### 注册条件工具

```js
ctx.tools.register(defineTool({ name, description, parameters, output, execute }),
  { when: ({ agent }) => enabledForAgent(agent) })
```

`when` 每步调用；false 则不进 admitted 集。

### 只读守卫

```js
agent.ctx.tools.guard((execution) => allowlist.has(execution.name) ? undefined : '拒绝理由')
```

**必须绑在 `agent.ctx` 上**（不是插件自己的 ctx），agent 销毁时自动摘除。
插件卸载时也要 `ctx.effect(() => () => dispose())` 双保险。

### 启动子智能体

```js
await ctx.subagents.startActivation({
  provider: 'spawn',
  prompt: [{ type: 'text', text }],
  parent: exec.agent,
  agentPreset: 'advisor',
  agentOptions: { provider, model },
  maxDepth,
  signal: exec.signal,
  delivery: 'parent',   // 'parent' 才会把结果送回模型
})
```

### HTTP 路由

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix', path: '/dsh-advisors-api',
  handler(req, res) { /* 自己做 loopback 校验 */ },
}))
```

**必须包 `ctx.effect`**，否则热重载时撞 duplicate route。

### 写用户级 JSON 配置

`$DSH_HOME` 优先级：显式配置 > `process.env.DSH_HOME` > `~/.dsh`。
写入用 **temp + rename**，避免半截 JSON。

### 设置页槽位

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'dsh-advisors', order: 82,
  label: () => t('section.label'), locale: 'dsh-advisors',
}, AdvisorSettingsPage))
```

`label` 可以是 thunk（每次投影重读，跟着语言切换）。

---

## 8. 模型通道（profile 里的现状）

来自 `D:\DeepSeek-DSH\profiles\desktop\cordis.patch.yml` 的 `llm-pi-ai` 行：

| provider | 通道 | 模型 | 备注 |
|---|---|---|---|
| `apikey` | chatgpt | `gpt-6-astra`、`gpt-6.1-sol`、`gpt-6.1-terra` | 可用 |
| `apikey1` | claude | `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-opus-5`、`claude-sonnet-5` | **`claude-opus-5-5` 额度耗尽（500）** |
| `zzz1` | deepseek 中转 | `deepseek-flash`、`deepseek-v4-pro` | 可用 |

**注意**：两个通道都修过「不能识图」——根因是路由未声明 `defaultInput`，pi-ai 退回 `["text"]`。
若新增模型，记得加 `defaultInput: [text, image]`。

---

## 9. 建议的下一步（按优先级）

1. **做一次真正的守卫越界验收**（第 0 节末尾）。这是唯一还没有硬证据的一条。
2. **给目录里的不可用模型加标注**（至少 `claude-opus-5-5`），免得选中后顾问静默失败。
3. **状态文件并发**：两个标签页同时改不同领域会互相覆盖（整体读改写，无版本号）。
   单用户单机场景可以接受，但值得知道。
4. `sessions` 字典只增不减，长期会积累无用条目。低成本的清理是「写入时顺手丢掉 90 天前的条目」。
5. `ask_advisor` 启动后若顾问失败，主智能体**收不到任何通知**（本次实测：静默消失）。
   可以考虑在 `startActivation` 的 promise 上挂一个失败回调，向主会话投一条消息。

---

## 10. 验证清单（改完照着跑）

```powershell
cd D:\DeepSeek-Workspace\dsh-advisors

# 1. 语法 + 清单
node --check index.js
node --check client.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
node -e "const y=require('D:/DeepSeek-DSH/profiles/desktop/node_modules/yaml');console.log(y.parse(require('fs').readFileSync('cordis.patch.yml','utf8')).length)"

# 2. 离线回归（192 条断言，两个都必须退出码 0）
npm test

# 3. 运行中的路由（应反映你的选择）
curl.exe -s "http://127.0.0.1:10751/dsh-advisors-api"

# 4. 改一个领域
curl.exe -s -X POST "http://127.0.0.1:10751/dsh-advisors-api" -H "Content-Type: application/json" `
  --data-raw '{\"domain\":\"aesthetic\",\"modelId\":\"kele-claude/claude-sonnet-5-5\"}'

# 5. 端到端：真的发一次咨询，看回执里的 provider/model
#    回执对了还不够——顾问要能**跑完**。换模型后先发最短的试探问题。
```

**验收标准**：
- 第 2 步两个退出码都是 0；
- 第 4 步之后**重载插件**（关开 `include:dsh-advisors`），第 3 步仍能看到你的选择（这是本轮的 bug）；
- 第 5 步顾问**真的返回了消息**，不是静默消失。

---

## 11. 交接时的诚实交代

- 文档里的结论都来自实测，但 A/B 只有**两轮**（后端队列、前端设置页），样本很小，
  不足以支撑「某模型在所有场景更强」的普遍结论。
- 前端审美那条（Claude 更强）是**主观判断**，依据是分组语义和留白，没有量化指标。
  可以自己看 `ab-test/_shots/` 里的截图推翻。
- **守卫的工具层证据是源码推断 + 挂载逻辑测试，不是一次真实越界调用。** 见第 0 节。
- 插件跑在 `danger-full-access` 文件策略下，守卫是**进程内**的，防的是「模型自己越界」，
  **不防**恶意代码。这是设计边界，不是缺陷。
- 本轮验证用的 GUI 需要 `?token=` 启动参数才能进入浏览器会话，脚本浏览器进不去；
  因此 Client 半边的**逻辑**验证是离线渲染探针（真组件 + 假宿主）。
  **样式必须在真页面刷新后肉眼看**——坑 8（白底白字）和坑 10（全屏透明遮罩、
  点哪都没反应）都是逻辑全绿、肉眼才发现的问题。探针不计算布局，CSS 类 bug
  只能用选择器层面的断言 + 真机操作双重兜底。
