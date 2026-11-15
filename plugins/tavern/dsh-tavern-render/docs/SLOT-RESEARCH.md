# SLOT 调研报告：助手正文的可用挂载点

> 调研人：slot-scout ｜ 2026-11-11 ｜ 证据来源：`D:\DeepSeek-Workspace\_dsh_src\` 下抽取的客户端 ESM 产物
> 行号规则：`dsh-client-ui-chat__lib__client.js` / `dsh-client-ui-conversation__lib__client.js` /
> `dsh-client-ui-renderer__lib__client.js` 是「文件:行」；`index-BgUyXZcc.js` 是压缩产物（工具集、SlotCore 都在这里面），
> 标注为「index 第 N 行（该行是超长单行，附特征串）」。

---

## 结论（先行）

**推荐 B（DOM 接管），但闸 3 的层级描述要改一处**，并且可以**去掉对 class 哈希的依赖**：

1. **放弃「slot 自渲染助手正文」**——唯一能覆盖正文的挂载点是 `conversation.chat.node` 的 keyed 项 `assistant-step`，
   而它被 ui-chat 的 `AssistantNodeView` 占着；用低 priority 抢先注册**技术上成立**（已确证，见 §3），
   但必须自己重写 reasoning 折叠 / 工具卡片 / 图片槽 / assistant-actions / turn-tail / presentation 策略，
   且 `AssistantMarkdown` **没有对外导出**（§2 末尾），拿不回来复用。风险不可接受，与主控判断一致。
2. **正文纯文本其实拿得到**（`props.node.data.blocks`，§2.3），所以「必须接管 DOM」的真实理由**不是拿不到文本**，
   而是「拿不到正文的渲染权」。这点要写进设计文档，别让后来人以为只能读 DOM。
3. **闸 2 的锚点建议升级**：不用 `_root`+`_body` 类名指纹，改用语义属性
   `[data-chat-flow-kind="assistant-step"]` 内的 `[data-text-interaction-source]`，并**排除**落在
   `[data-turn-process-inline]` 里的那些（思考行都包在那层里）。这一条同时替代闸 2 和闸 3，且不依赖任何哈希类名。
4. **闸 3 的层级要纠正**：`_root` **不是** flowItem 的直接子元素，中间还夹着一层
   `div[data-slot="conversation.chat.node"]`（`display:contents`）。层级结论与推理链见 §4.2。

---

## 1. `conversation.chat.text-interaction` 是什么（问题 1）

**它不是正文槽，是「选中文本后的浮动操作条」。**

- 声明处（唯一）：`dsh-client-ui-chat…js:15471-15474`，由 `conversation.view` 的 `id: "chat"` 条目声明：

  ```js
  "conversation.chat.text-interaction": {
      kind: "keyed",
      scope: "session"
  }
  ```

- 渲染处（唯一）：`dsh-client-ui-chat…js:3678-3689`，挂在 ChatView 里一个绝对定位、默认隐藏的浮层上
  （CSS：`.V4vHZW_textInteraction{z-index:6;visibility:hidden;width:max-content;margin:0;position:absolute}`，同文件 3384 行那段超长 CSS 尾部）：

  ```js
  className: ChatView_module_css_default.textInteraction,
  "data-text-interaction-surface": "",
  "aria-hidden": textInteraction.active === null,
  children: textInteraction.active !== null && renderSlot("conversation.chat.text-interaction", {
      trigger: textInteraction.active.trigger,   // "selection" | "contextmenu"
      readText: textInteraction.readText,        // () => 选中文本 or null
      dismiss: textInteraction.dismiss,
      clearSelection: textInteraction.clearSelection
  }, { entryKey: textInteraction.active.id })    // ← key = 插件注册的 interaction id
  ```

- 谁提供这些 props：`useTextInteraction(...)`（`dsh-client-ui-chat…js:862-1131`）。它监听 DOM 选区，
  `readText` 读的是**浏览器 selection**（875-880：`selectedText(current.selection)`），
  不是助手消息文本。触发后才 `setActive({id, trigger})`，`id` 来自 `dispatchInteraction` 的返回值
  （955-970：`const id = dispatchInteraction({...}); if (id === null) return;`），
  而 `dispatchInteraction` → `ctx.uiConversation.interactions.dispatch(sessionId, gesture)`
  （`dsh-client-ui-conversation…js:3686-3707`），后者遍历插件注册的 interaction，第一个 `open()` 的返回其 id。

- 结论：**助手正文不经由这个 key 渲染**；它只在你**选中正文文字**时才会挂载，props 是「选区 + 三个回调」。
  想靠它覆盖正文 = 不可能。（它倒是可以拿来做「选中一段话 → 用酒馆样式重排」的将来功能。）

---

## 2. 助手正文到底由谁渲染（问题 2）

### 2.1 渲染链

`ChatNodeSeat` → `renderSlot("conversation.chat.node", …)` → keyed 命中 `assistant-step`
→ `AssistantNodeView` → `AssistantMarkdown`。

- keyed 注册：`dsh-client-ui-chat…js:9268-9287`

  ```js
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
      name: "conversation.chat.node",
      key: "assistant-step",
      locale: NS,
      children: {
          "conversation.chat.reasoning.body": { kind: "single", scope: "session" },
          "conversation.chat.message.images": { kind: "single", scope: "session" }
      },
      inject: (sessionId) => ({ hooks: { presentation }, resolveFilePath: …, fileMentions: … })
  }, AssistantNodeView));
  ```

- 分发：`dsh-client-ui-chat…js:4593-4601`

  ```js
  children: renderSlot("conversation.chat.node", routedOwner, {
      entryKey: routedNode.kind,        // ← "assistant-step"
      hookContext,
      fallback: <JsonBlock label={t("message.unknownSurface", …)} payload={routedNode.data} … />
  })
  ```

- `AssistantNodeView`（8433-8448）把 `data.blocks` 交给 `AssistantMarkdown`：

  ```js
  return jsx(AssistantMarkdown, {
      blocks: data.blocks,
      groupPart,
      streaming: data.status === "running",
      textInteractionSource: data.status === "settled" && data.finalNode?.messageId !== void 0,
      interrupted: data.status === "interrupted",
      ...
  });
  ```

- `AssistantMarkdown`（8305-8381）按 block 逐条渲染：
  - `kind: "text"` → `MarkdownText`（8319-8327，`text: block.text`）
  - `kind: "reasoning"` → `ProcessReasoning` → `ReasoningRow`（8329-8345）
  - `kind: "image"` → `renderSlot("conversation.chat.message.images", …)`（8346-8361）
  - `kind: "tool-call"` → 跳过（8362）
  - 其它 → `JsonBlock`（8363-8367）
  - 外层 DOM：`div.<hash>_root`（`data-streaming`）> `div.<hash>_body`（8370-8380；哈希实测为 `xMeOpW`，见 8277-8282）

### 2.2 「替换它」的 slot 是否存在

**不存在。** 没有任何 slot 的 owner props 是「一段正文 markdown 的渲染位」。可用的相邻槽只有：
`conversation.chat.reasoning.body`（只给 reasoning 的 `rawText/text/running`，8227-8231）、
`conversation.chat.message.images`（只给 images/loadImage/align，8355-8359）、
`conversation.chat.turnTail`（只给 `turn/seq/openFile`，9030-9034）、
`conversation.chat.assistant-actions`（只给 `messageId`，9041）。

### 2.3 但数据（纯文本）拿得到

`ChatNodeSeat` 的 owner props 里带着**完整节点**（4557-4579）：

```js
const owner = { ..., ...groupPart === undefined ? {} : { groupPart }, cwd, openFile, inspectCall, forkAt, loadImage, turnProcess };
...
const routedOwner = { ...owner, node: routedNode };
```

所以任何注册进 `conversation.chat.node` 的组件都能拿到 `props.node.data.blocks`
（与 `AssistantMarkdown` 收到的 `blocks` 同一份，8434）。取正文纯文本：

```js
const text = props.node.data.blocks.filter(b => b.kind === "text").map(b => b.text).join("");
```

§2.4 还会说明：**`AssistantMarkdown` 组件本体拿不到**——ui-chat 的模块导出只有四个名字
（文件尾 `exports.EMPTY_CHAT_SNAPSHOT / apply / inject / isRunningTool / isSettledTool`），
`require("@deepseek-ai/dsh-client-ui-chat")` **不能**复用它。这就是「有数据、没渲染权」的准确表述。

---

## 3. `conversation.chat.node` 的 key 分发与冲突规则（问题 3）

`conversation.chat.node` 由 `conversation.chat.flow` 条目声明（`dsh-client-ui-chat…js:15437-15457`）：
`kind: "keyed"`, `scope: "session"`, `inject: CHAT_NODE_INJECT`（15259-15265，注入 `useTurnData / useDisclosure / useGroupAction`）。

ui-chat 自己注册了 15 个 key（9229-9348）：`user`、`steering`、`context`、`turn-trigger`、`system-prompt`、
`assistant-step`、`command`、`manual-compaction`、`compaction`、`model-retry`、`turn-error`、
`turn-max-tokens`、`turn-process`、`turn-tail`、`unknown`。

**冲突语义（`index-BgUyXZcc.js` 第 123 行内，SlotCore.register / entriesOfSlot，特征串
`register(e,t){const r=this.records.get(e.name)` / `entriesOfSlot(e){`）**：

```js
case "keyed": {
  if (e.key === void 0) throw new Error(`keyed slot "${e.name}" requires options.key`);
  const f = r.entries.find(h => h.options.key === e.key && (h.options.priority ?? 0) === n);
  if (f) throw new Error(`keyed slot "${e.name}" already has an entry for key "${e.key}" ` +
    `at priority ${n} — register at a different priority to shadow it (lowest renders)`);
  break;
}
```

```js
entriesOfSlot(e){
  ... const r = t.spec.kind; ...
  for (const s of t.entries) {
    if (this.abdicated.has(s)) continue;
    const l = r === "keyed" ? s.options.key : r === "list" ? s.options.id : void 0;
    n.has(l) || (n.add(l), i.push(s));      // ← 同 key 只取排序后第一个
  }
  return i;
}
```

- **同 key + 同 priority → 抛错**（不是静默覆盖）。**同 key + 不同 priority → 允许**，
  entries 按 `priority` 升序排序（`u.sort((f,h)=>(f.options.priority??0)-(h.options.priority??0))`），
  `entriesOfSlot` 取第一个未被 abdicate 的 → **priority 最小者渲染**。
- 所以 `priority: -1` + `key: "assistant-step"` 确实能顶掉 `AssistantNodeView`。**主控判断 2 成立。**
- 附带的安全网（很有用）：条目渲染期抛错会被错误边界捕获并 **abdicate**，outlet 自动回落到下一名
  （`dsh-client-ui-renderer…js:622-646` 的注释与 `getDerivedStateFromError`；`1136-1141`
  `onEntryError → host.reportEntryError(slotKey, entry, error, { abdicate: spec.kind !== "chain" })`；
  `index` 第 123 行 `reportEntryError(...)` 里 `if(i.abdicate){ … this.abdicated.add(t); … }`）。
  即：**抢注失败/自己崩了会自动露出宿主原渲染**，不会白屏。但「崩了才回落」不是设计目标。

**综合判断（同意主控 3）**：抢 `assistant-step` 需要重写整个 AssistantNodeView，
`AssistantMarkdown` 又不可复用（§2.4），代价不可接受。**不走这条路。**

---

## 4. 闸 2 / 闸 3 的证据（主控要的确认项）

### 4.1 `data-chat-group-part` 的取值

只有一个写入点：`dsh-client-ui-chat…js:4588`

```js
"data-chat-node-key": routedNode.key,
"data-chat-group-part": groupPart,        // 无值时 React 不输出该属性
```

`groupPart` 的来源就三种（组树 `13674-13698` 与 `AssistantMarkdown` 的分支）：

| 取值 | 证据 |
|---|---|
| `undefined`（属性不存在） | 4580 `groupPart === void 0 \|\| groupPart === "response" ? routedNode.key : JSON.stringify([key, groupPart])`；3488 无分组时 `order.map(key => ({kind:"node", key}))` |
| `"response"` | 13691 `emit(key, { kind:"node", key, groupPart:"response" })` |
| `"reasoning"` | 13684 `pending.push({ kind:"node", key, groupPart:"reasoning" })` |

`AssistantMarkdown` 里同名字段只用于过滤：8316-8317
`if (groupPart === "reasoning" && block.kind !== "reasoning") continue; if (groupPart === "response" && block.kind === "reasoning") continue;`

**结论**：取值域 = `"reasoning" | "response" | 属性缺失`，**就这三个**，没有别的。

⚠️ 一处**未完全确认**：当前分组策略下，`"reasoning"` 成员先入 `pending` 再被打包成 group 条目
（13681-13685），组条目渲染走 `ChatGroupSeat`（其根节点 4987-4996 只有 `data-chat-group-key` /
`data-chat-flow-key`，**没有** `data-chat-flow-kind`），所以「带 `data-chat-group-part="reasoning"` 的
flowItem」在默认分组下可能根本不出现。但这不影响闸 2：排除它**只会更严格**，
而且在不分组的路径（3488）上确实可能出现 thinking 的 flowItem，所以该排除**必须保留**。

### 4.2 闸 3 的层级推断：**主控版本错一层**

主控写的是「flowItem 的**直接子元素**里找 `_root` 且直接子 `_body`」。实际 DOM 中间还有一层槽位 wrapper：

`dsh-client-ui-renderer…js:1116-1127`（每个 outlet 都会渲染这个锚点）：

```js
const ANCHOR_STYLE = { display: "contents" };
...
return jsx(spec.inline === true ? "span" : "div", {
    "data-slot": slotKey,          // ← div[data-slot="conversation.chat.node"]
    style: ANCHOR_STYLE,           // ← display:contents，不产生盒子，但元素存在
    children: renderOutletContent(...)
});
```

中间无其它 wrapper：`SlotErrorBoundary` 未出错时 `return this.props.children`（643-644），
`StrictSessionEntry` → `SessionEntry` → `renderEntry` → `jsx(Comp, props)`（1091-1108、792-810）。

因此实际层级是：

```
div[data-chat-flow-kind="assistant-step"][data-chat-node-key="assistant-step"]   ← flowItem, 4581-4602
└─ div[data-slot="conversation.chat.node"]                  ← display:contents（renderer 1123）
   └─ div.xMeOpW_root                                        ← AssistantMarkdown 根（8370-8372）
      └─ div.xMeOpW_body                                     ← 8373-8379
         ├─ div.<hash>_markdown  (MarkdownText)              ← 正文 text block（index 第 179 行 F4）
         ├─ div[data-turn-process-inline]                    ← ProcessReasoning（8383-8387）
         │  └─ div.VJlF5q_root (ReasoningRow)                ← 8241-8246；类名 8152-8161
         ├─ div[data-slot="conversation.chat.message.images"] ← 图片槽（8355）
         └─ span.xMeOpW_stopped                              ← interrupted 标记（8375-8378）
```

要点：
- **`_root` 是 flowItem 的第 2 层（透过 display:contents 的槽位锚点）**，不是直接子。闸 3 若按
  「直接子」实现会**永远匹配不到**。正确写法：在 flowItem 内找 `[data-slot="conversation.chat.node"] > div > div`
  形式的 `_root>_body` 对，或直接按 §4.3 的属性法。
- **思考行（`VJlF5q_root`）确实不是 flowItem 的直接子**——它深 4 层，被 `div[data-turn-process-inline]`
  （8383-8387：`ref: useGroupAction(...), "data-turn-process-inline": hidden || void 0`）包着。
  **主控这条推断成立。**
- 但注意 `VJlF5q_root` 自身**没有** `_body`（8152-8161 只有 `leading/root/row/separator/summary/summaryText/thinkBody/title`），
  它的展开体是 `thinkBody`。所以「必须有直接子 `_body`」这条本来也能挡掉它——两道保险都成立。

### 4.3 更稳的锚点（建议替代闸 3 的类名指纹）

`MarkdownText` 在**已 settled 的**正文上会输出 `data-text-interaction-source`（`index` 第 179 行，`F4`）：

```js
p.jsx("div", { className: de(Mt.markdown, ...), "data-text-interaction-source": f ? "" : void 0, ... })
```

值来自 `AssistantMarkdown` 的 `textInteractionSource`，而它只在
`data.status === "settled" && data.finalNode?.messageId !== void 0` 时为 true（8438）。
同一个属性**也**出现在思考行的展开体上（8224-8231：`"data-text-interaction-source": textInteractionSource && !running ? "" : void 0`
套在 `thinkBody` 外层）。所以取法：

```js
const flowItem = el.closest('[data-chat-flow-kind="assistant-step"]');
if (!flowItem) return null;                                   // 闸 2（flowItem 级）
if (flowItem.dataset.chatGroupPart === 'reasoning') return null;  // 闸 2 补充排除
const hits = [...flowItem.querySelectorAll('[data-text-interaction-source]')]
  .filter(n => n.closest('[data-turn-process-inline]') === null);  // 排除思考行
if (hits.length !== 1) return null;                           // 闸 3 唯一性
const body = hits[0];
```

优点：①不依赖 `xMeOpW`/`VJlF5q` 这类构建哈希（升级即失效）；②天然只在「该条消息已结束」时命中，
流式期间不接管（因为 running 时属性根本没渲染）；③`[data-turn-process-inline]` 与
`[data-text-interaction-source]` 都是宿主自己在用的语义属性（`available()` 里就靠它判可交互，
`dsh-client-ui-chat…js:817`），比内部 CSS Module 类名稳定得多。

代价：只能拿到**正文 markdown 容器元素**，其中 `<scene>` 标签仍然是文本节点
（Markdown 渲染器 `case "html": return r.omitHtml ? null : e.value`，`index` 第 171 行），
所以「读 textContent 再按 TRS 重排」这条路成立；但**重排必须继续用 innerHTML 替换**——
即仍然是 B 方案，只是锚点现代化了。

---

## 5. `agentPreset` 的读法（问题 4）

### 5.1 客户端可用的调用形式

唯一直接证据，`dsh-client-ui-conversation…js:16153-16168`：

```js
const agentPreset = session.projections.faceOf("agentPreset").getSnapshot();
...
...typeof agentPreset === "string" ? { agentPreset } : {}
```

所以：**faceOf(...).getSnapshot() 返回 `string | undefined`**，`typeof === "string"` 才用，否则字段省略。
（另有 16104 把 `state.agentPreset` 交给 `analyticsPreset()` 上报 `agent_preset`，属同一值。）

### 5.2 值域 / 是不是 preset id

- `tavern-play` 是**预设 id**：`D:\DeepSeek-DSH\profiles\desktop\node_modules\@local\dsh-tavern-preset\cordis.patch.yml:28-32`

  ```yaml
  - id: preset-tavern-play
    name: '@deepseek-ai/dsh-agent-preset'
    id: tavern-play
    name: 酒馆·扮演
  ```

  且 `D:\DeepSeek-DSH\profiles\desktop\cordis.patch.yml:1714 / 1754` 的 `dsh-inject` 配置用
  `agentPresets: [tavern-play]` 引用它——即**下游一律按 id 引用**。
- 其它可能取值：`undefined`（如新会话还没选 / 该会话无预设），以及其它 preset id
  （`entry-customization` 里见过 `startSession(… { agentPreset: "cordis" })`，
  `dsh-client-ui-entry-customization…js:188-192`）。
- **未确认**：`faceOf("agentPreset")` 返回的到底是 preset 的 `id` 还是 `name`。客户端代码只证明类型是 string，
  没有把返回值与 registry 的字段对齐的代码。→ 落地前应在真实页面里 `console.log` 一次验证（1 分钟成本）。

### 5.3 在非 React 函数里能不能调 / 要不要 subscribe

- **能直接调**：`session.projections.faceOf(name)` 是普通方法，`getSnapshot()` 是普通函数，不依赖 hook。
  它出现在 `SessionInputShell` 的构造函数依赖里（16145-16156），那是**普通类**，不是组件 → 说明非 React 环境可用。
- **face 是 observable source**：`inbox: session.projections.faceOf("inbox")` 被当作 source 传下去（16176），
  下游 `deps.inbox?.subscribe(...)`（15430、15809）→ **face 自带 `subscribe`**。
- 对预案的实际含义：DOM 变更时**按需 `getSnapshot()` 采样即可**，不必订阅；如果想让插件在「用户切预设」时
  立即重扫已有 DOM，再 `face.subscribe(...)` 触发一次重扫（可选增强，不是必需）。

### 5.4 可直接抄的片段（方案 B 的闸 1）

```js
// 插件 apply(ctx) 里：inject 必须含 "sessions"（见 §6）
const PRESET_ALLOWLIST = ['tavern-play'];

function sessionIdOf(el) {
  return el.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') || null;
}

function presetAllowed(el, ctx) {
  const sid = sessionIdOf(el);
  if (!sid) return false;
  const binding = ctx.sessions.binding(sid);          // ui-chat 同款调用，见 15447
  if (!binding) return false;
  const preset = binding.session.projections.faceOf('agentPreset').getSnapshot();
  return typeof preset === 'string' && PRESET_ALLOWLIST.includes(preset);
}
```

`[data-conversation-session]` 的证据：`dsh-client-ui-conversation…js:20599-20605`

```js
"data-conversation-content": "",
"data-conversation-session": sessionId,
"data-conversation-region": "chat",
```

---

## 6. `ctx.sessions` 在插件里可用吗（问题 5 的一部分）

**可以。** ui-chat 自己的 inject 列表（`dsh-client-ui-chat…js:15267-15280`）就包含它：

```js
const inject = [
    "slots", "sessions", "uiWorkspace", "uiSession", "uiConversation",
    "locale", "configForms", "connection", "remote", "remote.session",
    "sidebarRight", "fileDrag"
];
```

并使用 `ctx.sessions.binding(sessionId)`（15447-15448）和
`ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd`（15491、183）。
插件侧写法：`exports.inject = ["slots", "sessions"];`，然后 `ctx.sessions.binding(id)`。
（`inject` 顺序即依赖激活顺序，与 ui-chat 保持一致即可。）

---

## 7. slot 注册契约（问题 5）——给「方案 A 若将来要做」的参考

`ctx.slots.register(options, Component)`（`dsh-client-ui-renderer…js:1813-1816`）→ `_register`（1603-1623）→
SlotCore.register。字段（从注册现场归纳，9229-9348 / 15437-15535 / 22903-22998）：

| 字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | slot key，**必须已被某个父条目的 `children` 声明**，否则抛 `slot "X" is not declared (a parent entry's children table must declare it)` |
| `kind` 由声明决定 | — | 不是注册参数，是父声明里的 `kind: single/keyed/list/chain` |
| `key` | keyed 必填 | keyed 的槽位格；同 key + 同 priority 冲突 |
| `id` | list 必填 | list 的行 id |
| `select` | chain 必填 | 链式选择函数，返回 null = 放弃 |
| `priority` | 否（默认 0） | 同格竞争；**升序，最小者渲染**；也是「抢注」的唯一合法手段 |
| `order` | 否 | list 内排序 |
| `label` | 否 | list 的标签（`() => string` 或 string） |
| `locale` | 否 | 命名空间字符串；给了就有 `t` prop |
| `store` | 否 | 会话级 store handle（给了就有 `useStore`/`actions`） |
| `children` | 否 | 声明子孙槽位；给了就有 `renderSlot`（含 chain 时还有 `renderSlotChain`） |
| `inject` | 否 | `(sessionId, actions) => props | {hooks, keyedHooks, ...}` |
| `registrant` | 否 | 默认取 `ctx.fiber?.name`（1605） |

`inject` 返回值（`dsh-client-ui-renderer…js:435-459`）：
- `hooks: { name: source }` → 变成 `useName(selector?)` prop（`standardHookPropName` 把 `foo` → `useFoo`，
  `index` 第 123 行 `function II(e){return \`use${e[0]?.toUpperCase()??""}${e.slice(1)}\`}`）；
- `keyedHooks: { name: resolver }` → 变成 `useName(key, selector?)`（ui-chat 用它做 `useChatNode(key)`，15430-15435）；
- 其余键**原样**成为 props（如 `dispatchInteraction`、`openFile`）。

组件拿到的 props = 标准 kit（`useSession`/`useSessions`/`t`/`renderSlot`/…，见 736-767）+ inject 结果
+ **owner props（owner 优先）**（784-790）。会话级 slot 的 owner props 就是 `renderSlot(key, ownerProps, opts)` 的第二个参数。

`ctx.slots.inject(key, callback)`（1368-1427）：等该 slot **被声明**后执行 callback，回调里 `register`；
slot 被折叠/重新声明时自动重跑。**这是外部插件往宿主槽位加东西的唯一正路**——
ui-chat / conversation / entry-customization 全部这么写（如 `entry-customization…js:195-212`）。

**最小可跑例子（纯文本，不碰 DOM）——挂在 turn-tail 列表里，只做「读」不做「替换」：**

```js
const NS = "tavernRender";

function TavernTailProbe({ useSession, useChatNode, t }) {
  const preset = useSession((s) => {
    const p = s?.projections?.faceOf?.("agentPreset")?.getSnapshot?.();
    return typeof p === "string" ? p : undefined;
  });
  if (!["tavern-play"].includes(preset)) return null;
  return React.createElement("div", { "data-tavern-probe": "" }, "tavern preset active");
}

ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
  name: "conversation.chat.turnTail",
  id: "tavern-probe",     // list 必需
  order: 100,
  locale: NS,
  inject: () => ({})
}, TavernTailProbe));
```

注意：`conversation.chat.turnTail` 是 **list**（`dsh-client-ui-chat…js:9332-9341`，由 `turn-tail` 条目声明），
所以 `id` 必填、`order` 决定位置；owner props 只有 `{turn, seq, openFile}`（9030-9034）——
**它拿不到 blocks**，要读正文得自己 `useChat(...)`（`useChat` 来自 ui-chat 的
`ctx.uiSession.provide({ hooks: ["chat"], … })`，15328-15331；该 hook 在会话级 slot 里自动可用）。
这也是为什么「在 tail 里自渲染 + 用 CSS 隐藏宿主正文」只能算半个 A 方案：正文仍在宿主 DOM 里，
隐藏依赖选择器，一旦选择器失效就是双份内容——**不推荐作为主路径**。

---

## 8. 判定与四道闸（落地结论）

### 推荐：B（DOM 接管），锚点全部改用语义属性

- **放弃 A**：唯一能拿到渲染权的路是抢注 keyed `assistant-step`，需重写整个 `AssistantNodeView`，
  且 `AssistantMarkdown` 未导出（§2.4）。风险/成本不可接受。
- **B 的风险可接受的理由**：只做「读 textContent → 严格校验 → 替换 body innerHTML」，
  锚点从「类名哈希指纹」换成宿主自己业务语义的属性（`data-chat-flow-kind` / `data-chat-node-key` /
  `data-chat-group-part` / `data-text-interaction-source` / `data-turn-process-inline` /
  `data-conversation-session`），并加唯一性 + 严格解析双闸。
  上一轮事故（误伤思考过程）的根因是**类名不唯一**；语义属性天然唯一，且思考行有
  `[data-turn-process-inline]` 这个明确边界可排除。

### 四道闸（按执行顺序）

1. **闸 1 预设白名单**：`[data-conversation-session]` → `ctx.sessions.binding(id).session.projections
   .faceOf('agentPreset').getSnapshot()` ∈ `['tavern-play']`，否则不接管（§5.4 代码）。
2. **闸 2 锚点**：`el.closest('[data-chat-flow-kind="assistant-step"]')` 存在，
   且 `flowItem.dataset.chatGroupPart !== 'reasoning'`（取值域 §4.1）。
3. **闸 3 唯一性（已按实测层级修正）**：在该 flowItem 内取 `[data-text-interaction-source]` 且
   `closest('[data-turn-process-inline]') === null` 的元素，**必须恰好 1 个**；
   再用「该元素必须是 `_root > _body` 里的 markdown 子元素」做二次确认（`_root` 距 flowItem **2 层**，§4.2）。
   多匹配/零匹配一律放弃。
4. **闸 4 严格解析**：`<scene>` 完整且能解析 → `syntax === 'trs'`（或 `'legacy'`）才接管；
   **拒绝 `'loose'`**，删除「有引号/星号就当正文」的兜底（上一轮坑 2）。

---

## 9. 未确认项 / 风险

| # | 未确认项 | 影响 | 建议验证方式 |
|---|---|---|---|
| 1 | `faceOf('agentPreset')` 返回的是 preset **id** 还是 **name** | 闸 1 会全盘失效（永远 false 或永远命中） | 真实页面 console 打一次 `ctx.sessions.binding(sid).session.projections.faceOf('agentPreset').getSnapshot()` |
| 2 | 默认分组下是否真存在 `data-chat-group-part="reasoning"` 的 flowItem | 无（排除更严格） | 不必验证，保留排除即可 |
| 3 | `data-text-interaction-source` 在宿主**未来版本**是否仍只挂 settled 正文 | 若改成运行时挂载，会开始在流式期间命中 | 加「流式保护」：命中后仍检查 `[data-streaming]` 祖先（`AssistantMarkdown` 根有 `data-streaming`，8372），有则跳过 |
| 4 | `xMeOpW` / `VJlF5q` 等哈希仅在 15589 行版本核对过 | 升级即变；**这正是不要用类名做主锚点的原因** | 只在闸 3 二次确认里用，且写成 `/^[A-Za-z0-9]+_root$/` 形式而非硬编码 |
| 5 | `conversation.chat.text-interaction` 的 keyed key 空间（插件 interaction id）未实际注册过 | 该槽是「选中重排」类功能的入口，与本次正文重排无关 | 以后要做再验 |
| 6 | 提取产物不含 `@deepseek-ai/dsh-client-ui-slots` 源（`SlotCore` 在 `index-BgUyXZcc.js` 第 123 行内，是压缩单行） | 冲突规则已从压缩代码读出（§3），但若宿主改用别的 kind 语义需复核 | 升级后重跑同样的 grep |

---

## 10. 附：本次用到的证据索引

| 主题 | 位置 |
|---|---|
| text-interaction 渲染 | `dsh-client-ui-chat__lib__client.js:3678-3692` |
| text-interaction 声明 | `dsh-client-ui-chat__lib__client.js:15458-15475` |
| 选区交互实现 | `dsh-client-ui-chat__lib__client.js:862-1131`（`readText` 875、`dispatch` 955） |
| interaction 注册表 / dispatch | `dsh-client-ui-conversation__lib__client.js:3667-3709` |
| assistant-step key 注册 | `dsh-client-ui-chat__lib__client.js:9268-9287` |
| ChatNodeSeat owner props + 语义属性 | `dsh-client-ui-chat__lib__client.js:4557-4602` |
| AssistantNodeView | `dsh-client-ui-chat__lib__client.js:8393-8449`（blocks 8434、settled 8438） |
| AssistantMarkdown | `dsh-client-ui-chat__lib__client.js:8305-8381`（root/body 8370-8380） |
| ProcessReasoning / data-turn-process-inline | `dsh-client-ui-chat__lib__client.js:8382-8388` |
| ReasoningRow 类名（无 _body） | `dsh-client-ui-chat__lib__client.js:8152-8161`、8241-8246 |
| MarkdownText / data-text-interaction-source | `index-BgUyXZcc.js` 第 179 行（`const F4=k.memo(...)`） |
| html 块按纯文本输出 | `index-BgUyXZcc.js` 第 171 行（`case"html":return r.omitHtml?null:e.value`） |
| SlotCore.register 冲突规则 / entriesOfSlot / abdicate | `index-BgUyXZcc.js` 第 123 行（特征串 `register(e,t){const r=this.records.get(e.name)`） |
| SlotOutlet 锚点（display:contents） | `dsh-client-ui-renderer__lib__client.js:1110-1128` |
| keyed 分发 | `dsh-client-ui-renderer__lib__client.js:1178-1182` |
| 错误边界 + abdicate 回落 | `dsh-client-ui-renderer__lib__client.js:621-646`、1136-1141 |
| 标准 kit / inject 绑定 / 组件 props 合成 | `dsh-client-ui-renderer__lib__client.js:435-459`、667-702、736-810 |
| `slots.inject` | `dsh-client-ui-renderer__lib__client.js:1368-1427` |
| `slots.register` 入口 | `dsh-client-ui-renderer__lib__client.js:1813-1820`、1603-1623 |
| agentPreset 读取 | `dsh-client-ui-conversation__lib__client.js:16153-16168` |
| face 作为 source（subscribe） | `dsh-client-ui-conversation__lib__client.js:16176`、15430、15809 |
| `data-conversation-session` | `dsh-client-ui-conversation__lib__client.js:20599-20605` |
| ui-chat inject 列表（含 sessions） | `dsh-client-ui-chat__lib__client.js:15267-15280` |
| uiSession 提供 `chat` hook | `dsh-client-ui-chat__lib__client.js:15328-15331` |
| turnTail / assistant-actions 声明 | `dsh-client-ui-chat__lib__client.js:9332-9341` |
| 组树 groupPart 发射 | `dsh-client-ui-chat__lib__client.js:13674-13698` |
| preset id `tavern-play` | `D:\DeepSeek-DSH\profiles\desktop\node_modules\@local\dsh-tavern-preset\cordis.patch.yml:28-32` |
