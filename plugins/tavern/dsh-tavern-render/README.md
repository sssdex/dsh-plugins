# dsh-tavern-render · 酒馆回话分层排版

把酒馆预设的回话从「一坨同色文字」拆成**分层正文 + 状态卡 + 动态流 + 聊天 + 选项**。

**只在指定预设里生效**（默认 `tavern-play`／酒馆·扮演）。其他预设、其他工作区、思考过程、
工具输出、普通编程会话：**一个字节都不改**。

## 它解决什么

模型回话里塞着好几种完全不同的信息：旁白、对话、神态、状态数值、社交动态、
聊天记录、推荐流、选项。原生 Markdown 把它们排成一个样，读起来要一行行辨认。

| 信息 | 变成 |
|---|---|
| 旁白 | 常规字号，常规色 |
| **对话** | 放大、衬线字体、青色、左侧竖线，一眼从旁白里跳出来 |
| **神态 / 小动作** | 斜体、小一号、淡紫、浅底 |
| **好感 / 理性** | 环形进度表（不是数字） |
| 心情 / 穿着 / 状态 | 带字段名的彩色标签 |
| 社交动态 | 账号卡 + 引文 + 图片说明 |
| 聊天 | 带发送者的气泡 |
| 选项 | 编号卡片，悬停高亮 |

## 装

```powershell
dsh plugin --profile desktop add D:\DeepSeek-Workspace\dsh-tavern-render
```

装完**重启 DSH**（不是刷新页面）生效。

## 用

插件负责**显示**，预设负责**约束模型输出格式**。两者配合才有效果。

1. 装插件。
2. 把语法约束写进预设——见 [`docs/PRESET-CONSTRAINT.md`](docs/PRESET-CONSTRAINT.md)。
   注意它是**条件式**的：只在模型「演剧情」时套 `<scene>`，干活时不套。

不加强约束也能用：插件内置旧格式（`<mainbody>` / `<phone>` / `<Status>`）兼容，
网上现成的酒馆预设直接就能看。但旧格式是**位置式**（`62|18|心声|穿着`），
字段顺序靠猜，换模型容易错位。新语法用命名属性，顺序无关。

## 四道闸（这是本插件安全性的全部）

任何一关不过，就**彻底不接管**，正文原样显示。

| 闸 | 条件 | 不满足时 |
|---|---|---|
| 1 | 会话的 `agentPreset` ∈ `['tavern-play']` | 什么都不做 |
| 2 | 消息在 `[data-chat-flow-kind="assistant-step"]` 内，且不在 `[data-chat-group-part="reasoning"]`、不在 `[data-turn-process-inline]` 子树 | 跳过 |
| 3 | 正文 markdown 容器**恰好 1 个**，且能确认是 `_root > _body` 的直接子 | 跳过 |
| 4 | 解析结果 `syntax` 是 `trs` 或 `legacy` | 跳过 |

**闸 4 特别说明**：`syntax === 'loose'`（即「文本里有引号/星号就当正文」）被**明确拒绝**，
不是靠门槛去挡。上一轮就是靠这个宽松兜底把普通技术回复误伤了。

白名单可在 profile 里覆盖：

```yaml
- id: dsh-tavern-render
  name: dsh-tavern-render
  config:
    presets: [tavern-play, 别的预设id]
    minSpeech: 1        # 只有正文时的对白段数门槛
    enabled: true
```

## 为什么改的是 DOM，却没有覆盖宿主节点

DSH 的助手正文由内部 `AssistantMarkdown` 渲染，宿主**没有暴露「替换正文渲染」的 slot**。
唯一能拿到渲染权的路是抢注 keyed slot `assistant-step`（`priority: -1` 可顶掉宿主组件），
但那要自己重写思考折叠、工具卡片、图片槽、复制/重试按钮、流式策略，
而 `AssistantMarkdown` 没有对外导出、复用不了。代价不可接受。

（准确说法是「有数据、没渲染权」——`props.node.data.blocks` 里确实有正文纯文本。
完整调研见 [`docs/SLOT-RESEARCH.md`](docs/SLOT-RESEARCH.md)。）

所以走叠加渲染：

- 给 `_body` 打 `data-tt-body="1"`；
- 把排版结果作为**新节点追加**到 `_body` 末尾；
- 用一段 CSS 把 `_body` 里「非本插件节点」的子元素 `display:none`。

**宿主的子节点一个都没被删改**，所以还原 = 删掉我们那个节点 + 摘掉标记。
任何环节出错都不会吞内容——最坏情况是排版节点没生成，正文照常显示。

### 与上一版的区别

上一版是 `body.innerHTML = html`，把宿主节点整个替换掉、原文另存字符串。
两个根本缺陷：破坏 React 管理的节点树；保存/还原环节出错，内容就真没了。
现在这两条都不存在。

## 开发

### 改完源码要重新构建

DSH 的客户端 bundle 必须用 `window.__ModuleLoader__.load({id, factory})` 注册，
宿主把它当普通 `<script>` 执行 —— 浏览器里 `import './parse.js'` 不成立。
所以 `parse/render/styles` 会在构建期被内联进 `lib/client.js`：

```powershell
node scripts/build.mjs
```

### 测试

```powershell
node test/bundle.test.mjs   # 68 项：四道闸 + 事故回归 + 幂等/还原/卸载
node test/trs.test.mjs      # 46 项：新语法（属性乱序、缺字段、自定义属性）
node test/parse.test.mjs    # 解析器（含真实酒馆回话样例）
```

`bundle.test.mjs` 是最关键的一层：它在 jsdom 里按**宿主真实 DOM 层级**造消息，
逐条验证「不该接管的时候真的一点没动」。其中 `[6] 思考过程零改动` 是上一轮事故的回归测试。

### 预览页（不装插件就能看视觉效果）

```powershell
node scripts/preview.mjs
# → preview.html（深色）/ preview-light.html（浅色），自包含静态快照
```

截图：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu `
  --hide-scrollbars --window-size=1500,2800 `
  --screenshot="D:\DeepSeek-Workspace\dsh-tavern-render\preview-dark.png" `
  --virtual-time-budget=4000 "file:///D:/DeepSeek-Workspace/dsh-tavern-render/preview.html"
```

## 排错

### 装好了但没反应

按顺序查：

1. 会话是不是「酒馆·扮演」预设？新建会话时选对了吗。
2. 模型输出里有没有 `<scene>` 或 `<mainbody>`？没有标签就不会接管（这是故意的）。
3. 打开 DevTools Console，看有没有 `[dsh-tavern-render]` 开头的告警。
4. **确认 `agentPreset` 的实际返回值**（唯一没在真机核对过的点）：

```js
// 在 DSH 页面 Console 里跑
const sid = document.querySelector('[data-conversation-session]')
  ?.getAttribute('data-conversation-session');
console.log('sessionId =', sid);
// 如果插件已加载，ctx 不在全局，改用下面这条在插件里加日志的方式
```

若白名单始终不命中，可能是返回值用了预设的**显示名**而不是 id。
临时解法：在 config 里把 `presets` 设成 `['tavern-play', '酒馆·扮演']`（两种都填，代码同时接受）。

### 排版出来了但内容不对

看 `_body` 上的 `data-tt-syntax`：`trs` / `legacy` 是预期值。
如果本该排版却没排，多半是解析失败——贴着的那条消息在 Console 里会有告警，正文保留原文。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/parse.js` | 解析器：TRS v1 + 旧格式，纯函数，绝不抛异常 |
| `lib/render.js` | 渲染器：结构 → HTML，样式交给 CSS 变量 |
| `lib/styles.js` | 样式表：亮/暗主题、字体、字号 |
| `lib/client.bundle.tpl.js` | **接入层**（四道闸 + 叠加渲染） |
| `lib/client.js` | 构建产物，被 DSH 实际加载，**不要手改** |
| `index.js` | Host 侧空壳（视觉逻辑都在浏览器） |
| `docs/SYNTAX.md` | 语法权威定义 |
| `docs/PRESET-CONSTRAINT.md` | 给模型读的条件式约束（可直接粘进预设） |
| `docs/SLOT-RESEARCH.md` | 为什么不能换渲染器、锚点为什么这么选（带行号证据） |
| `scripts/build.mjs` | 内联构建 |
| `scripts/preview.mjs` | 预览页生成器 |
| `scripts/inject-preset.mjs` | 往预设里注入约束（**用前先人工确认**） |

## 已知边界

- 锚点依赖宿主的语义属性（`data-chat-flow-kind` / `data-text-interaction-source` /
  `data-turn-process-inline` / `data-conversation-session`）。宿主大版本改这些属性名的话，
  插件会**静默失效**（表现为「没反应」，正文照常显示）——不是崩，是降级。
- 流式输出期间不接管，说完那一下才换成排版。
- 「复制 / 引用」等原生交互在已排版的消息里会跟着原生节点一起被隐藏；关掉开关即恢复。
- 桌面客户端的 Web 页面带鉴权（401），无头浏览器进不去，所以真实页面必须人工验收一次。

## 许可

MIT
