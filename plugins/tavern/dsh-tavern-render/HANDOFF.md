# 交接文档：酒馆回话分层排版插件

> 交接日期：2026-11-12
> 状态：**已重做完成并装进 desktop profile，待真机验收**。
> 上一轮（2026-11-11）失败并回滚；本轮把三个事故根因全部堵死，并新增两道闸。

---

## 0. 一句话

只在「酒馆·扮演」预设里生效的助手回话，按 TRS 格式渲染成分层视图
（旁白/对白/神态/状态卡/动态/聊天/选项）。
**其他预设、工作区、思考过程、工具输出、普通编程会话：一个字节都不改。**

---

## 1. 当前状态（准确快照）

| 项 | 状态 |
|---|---|
| 插件 | **已装进 `D:\DeepSeek-DSH\profiles\desktop`**（`link:` 安装），在 `dsh.profile.bundles` 里 |
| 生效条件 | **重启 DSH**（不是刷新页面） |
| 备份 | `profiles\desktop\package.json.bak-tavernrender-20261112-001317`<br>`profiles\desktop\cordis.patch.yml.bak-tavernrender-20261112-001317` |
| `cordis.patch.yml` | **未改动**（安装前后哈希一致） |
| 预设 `tavern-play` | **未改动**（本轮没碰预设；条件式约束文本只写进了 `docs/`，等你确认后再注入） |
| 测试 | `bundle.test.mjs` **68 通过** / `trs.test.mjs` **58 通过** / `parse.test.mjs` 正常 |
| 预览 | `preview.html`（深色）/ `preview-light.html`（浅色），截图已在仓库根 |

### 卸载（一条命令）

```powershell
dsh plugin --profile desktop remove dsh-tavern-render
```

再把它从 `package.json` 的 `dsh.profile.bundles` 数组里删掉，重启 DSH。

---

## 2. 本轮修了什么（对照上一轮的三个坑）

### 坑 1：靠 CSS 类名指纹找容器 → 改错了思考过程

上一轮：`/_root/` + `_body` 唯一命名假设。实测至少 8 个组件共用，含思考过程容器。

本轮：
- 锚点全部换成宿主自己的**业务语义属性**：
  `[data-chat-flow-kind="assistant-step"]` / `[data-text-interaction-source]` /
  `[data-turn-process-inline]` / `[data-conversation-session]`。
- `_root`/`_body` 只在**二次确认**里用，且写成 `/^[A-Za-z0-9]+_body$/` 形式，不硬编码哈希。
- 排除思考行有三道：`[data-turn-process-inline]` 子树、`data-chat-group-part="reasoning"`、
  以及「思考行没有 `_body`」。
- 有专门的回归测试 `[6] 思考过程零改动`，往思考行里塞完整 `<scene>` 让它当陷阱。

### 坑 2：「宽松兜底」把普通回复也吃了

上一轮：`parseLoose` 的「有引号/星号就当正文」，靠 `minSpeech>=2` 门槛挡。

本轮：**从根上拒绝**。`isAcceptable()` 只接受 `syntax === 'trs' || 'legacy'`，
`loose` 一律不接管。门槛（`minSpeech`，默认 1）只决定「trs/legacy 里要不要排」，
与 loose 完全无关——以后谁调门槛都不会复活它。

测试 `[9] 闸 4 拒绝 loose 兜底` 断言了「这段确实是 loose」+「确实不接管」两件事。

### 坑 3：预设约束写成绝对律

上一轮：往 persona prefix 塞「每一条回复都必须是一个完整 `<scene>` 块，没有例外」。
结果编程任务里代码全被塞进 `<scene><panel><list>`。

本轮：`docs/PRESET-CONSTRAINT.md` 改成**条件式**——
「先判断这一轮是在演还是在干活」，并给了明确的退出条件 + 三个反例。
**尚未注入预设**（见下节）。

### 新增的坑 4：改写宿主 DOM 导致内容可能丢

上一轮：`body.innerHTML = html`，原文另存字符串。破坏 React 节点树，还原环节出错就真丢内容。

本轮：**纯叠加**。给 `_body` 打标记 → 把排版结果作为新节点**追加**到末尾 →
用 CSS 把「非本插件节点」`display:none`。
宿主的子节点从头到尾没被删改，**任何情况下不可能吞内容**。

---

## 3. 四道闸（任何一关不过就彻底不接管）

| 闸 | 条件 | 代码位置 |
|---|---|---|
| 1 预设白名单 | `agentPreset ∈ ['tavern-play']` | `isTavernSession()` |
| 2 锚点 | 在 `assistant-step` 内，排除 reasoning 分组与思考子树 | `findBodyIn()` |
| 3 唯一性 | 正文 markdown 容器**恰好 1 个**，且确认 `_root > _body` 直接子 | `findBodyIn()` + `confirmBody()` |
| 4 严格解析 | `syntax ∈ {trs, legacy}` | `isAcceptable()` |

外加：流式保护（`data-streaming` / `data-chat-running`）、幂等标记、单条失败只影响当条。

---

## 4. ⚠️ 唯一没在真机核对过的一点

**`projections.faceOf('agentPreset').getSnapshot()` 返回的是预设 id 还是显示名。**

代码证据（`dsh-client-ui-conversation:16156`）只证明类型是 `string | undefined`，
没有把返回值与 registry 字段对齐的代码。

本轮的处理：代码里 `presets` 白名单同时接受两者——你把两种写法都填上就百分百生效：

```yaml
# profiles/desktop/cordis.patch.yml
- id: dsh-tavern-render
  name: dsh-tavern-render
  config:
    presets: [tavern-play, '酒馆·扮演']
```

**验收时请在 DevTools Console 打一次**，确认到底是哪个值（见 README「排错」）。

---

## 5. 验收清单（装机后必须做）

1. 重启 DSH。
2. 新建会话，预设选 **酒馆·扮演**，随便说一句剧情台词。
   - 若模型没输出 `<scene>` → 需要先注入条件式约束（见第 6 节）。
   - 有 `<scene>` 但没排版 → 查 Console 有没有 `[dsh-tavern-render]` 告警。
3. **换一个编程会话，确认完全没变化**（这是上一轮事故点）。
4. **确认思考过程折叠区里的文字没被改**（上一轮另一个事故点）。
5. 关掉 setting 开关 → 确认还原成原始文本。

---

## 6. 还要做的事（按优先级）

1. **验收真机**（第 5 节）。
2. **确认 agentPreset 返回值**，必要时调 config。
3. **注入条件式约束到预设**——`docs/PRESET-CONSTRAINT.md` 已改好，
   但**没有**直接改 `D:\DeepSeek-Workspace\dsh-tavern-preset\cordis.patch.yml`。
   改之前先备份，改完用 `yaml.parse()` 验缩进。
   注意：`persona.prefix` 走模板引擎，**不能出现双花括号**。
4. 可选：窄屏 `@media (max-width:560px)` 分支没在真机验过。

---

## 7. 本轮踩到并已修的解析器 bug（供参考）

1. **TRS 的 `<panel>` 里写位置式 `<status>` 会整块吞内容**。模型新旧混用时很常见。
   `parseTrs` 的 status 分支只试 `parseChars()`，没 `<char>` 就放弃，没回退到
   `parseStatusRows()`（而 `parsePhone` 有）。已修，测试 `[8]`。
2. **`parseSocial()` 只解析 `<account1>` 的第一条账号**。同一个 `<account>` 里
   用 `<br>` 分隔的评论全落进 `extra`，显示成一串碎片。已修成逐条拆开，
   并用「第三段像不像计数」区分「主帖有 stats」与「评论没有 stats」。测试 `[9]`。

---

## 8. 文件地图

| 文件 | 作用 |
|---|---|
| `lib/client.bundle.tpl.js` | **接入层**（四道闸 + 叠加渲染），本轮重写的核心 |
| `lib/client.js` | 构建产物，DSH 实际加载，**不要手改** |
| `lib/parse.js` / `render.js` / `styles.js` | 解析 / 渲染 / 样式（复用上一轮，修了 2 个 bug） |
| `docs/SLOT-RESEARCH.md` | 为什么换不了渲染器、锚点为什么这么选（带行号证据） |
| `docs/PRESET-CONSTRAINT.md` | 条件式约束文本（**待你确认后注入**） |
| `docs/SYNTAX.md` | TRS 语法权威定义 |
| `scripts/build.mjs` | 内联构建，改 lib 后必须跑 |
| `scripts/preview.mjs` | 预览页生成器（不装插件也能看效果） |
| `test/bundle.test.mjs` | 68 项：四道闸 + 事故回归 + 幂等/还原/卸载 |
| `test/trs.test.mjs` | 58 项：语法 + 两个解析器 bug 的回归 |

---

## 9. 联系与边界

- 用户明确要求：**不要为了完成任务而绕过验证**，宁可慢。
- 用户对「改坏其他工作区」极其敏感，任何全局副作用都不可接受——
  这就是为什么要预设白名单 + 四道闸，而不是「尽量别误伤」。
- 用户说停就停，不要继续「顺手优化」。
- 不确定就问，不要自己假设后直接动手。
