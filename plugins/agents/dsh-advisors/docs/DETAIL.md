# 只读顾问（Read-only advisors）

给主智能体配一个「另一个视角的脑子」。遇到拿不准的地方，它可以开一个**真实的子智能体**去问，顾问只回答方法与建议，绝不参与实施。

## 路由：每个领域可以各用一个模型

四个领域默认都走 GPT-6 Astra（`apikey/gpt-6-astra`），**但每个领域都可以在「设置 → 顾问」里单独换模型**。

为什么要有这个开关：同一个问题该问谁不一样。实测（2026-11-13，两轮 A/B）Astra 是好的工程审稿人——并发队列那题它抓出了「超时后槽位被提前归还、实际并发 12 超上限 6 倍」，而单干版把自己的 bug 归因错了；但审美判断上 Claude Opus 5.5 的分组语义更准。所以默认全部 Astra，同时允许你把 `aesthetic` 换成 Claude。

| 领域 `domain` | 内容 | 默认模型 |
|---|---|---|
| `frontend` | 前端实现、组件与状态结构、交互 | GPT-6 Astra（provider `apikey`） |
| `aesthetic` | 视觉审美、排版、质感、动效 | GPT-6 Astra |
| `modeling` | 数据 / 领域 / 系统建模、架构形状 | GPT-6 Astra |
| `backend` | 服务端、数据层、性能、并发、失败处理 | GPT-6 Astra |

可选模型**不再写死**，而是每次向宿主的 LLM 注册表现查：

```js
ctx.get('llm').listProviders()   → 通道（带 displayName）
ctx.get('llm').listModels(id)    → 该通道声明的模型
```

也就是说 profile 的 `llm-pi-ai.providers` 里加一条通道、或给某条通道加一个模型，
下拉里立刻就有，**不需要改本插件一行代码**。实测当前有 41 个模型、13 条通道。

> 早期版本把 8 个模型写死在 `MODEL_CATALOG` 里，其中一半还指向根本不存在的
> provider（`apikey1`），而 profile 里真实配置的 `kele-claude` / `kele-gemini` /
> `apikey-gemini` / `kele-gpt` / `workbuddy` / `qoder` / `trae` 一条都看不到。
> 2026-11-14 主人指出这个问题后改成现查。

下拉面板带**搜索框**（匹配模型名 / 完整 id / 注解 / 通道名 / 通道 id），因为真实规模
是 40+ 项、十几个分组，只靠方向键逐屏扫不可用。

> 目录里查不到的 `provider/model` **也接受**——它可能来自 profile 里新增、目录尚未收录的模型。
> 回执里的 `domains[].availability` 会标成 `missing`，设置页显示为「目录外」分组，
> 但**不会自动改你的配置**：目录枚举不等于执行能力探测，暂时失败的通道也会缺席，
> 贸然清掉选择比留着更糟。

## 目录读取的工程细节

这些细节都是顾问审出来的真实 bug，不要简化：

| 机制 | 为什么 |
|---|---|
| `ctx.get('llm')` 而不是 `ctx.llm` | `llm` **不在 `inject` 里**。写进去会让插件在 llm 缺席或热替换空窗期完全不挂载——连 `ask_advisor`、开关、守卫都没了。目录是锦上添花，不该拖垮本体。 |
| `GET ?view=state` 轻量分支 | 模型菜单里那一行开关只要一个布尔值，不该为它枚举十几条通道。 |
| 30 秒 TTL + single-flight | 并发请求共享同一个 in-flight Promise，不重复枚举。 |
| `llm/adapters-updated` 事件作废缓存 | 宿主公开事件（`types.d.ts` 里声明过），profile 改完立刻生效。 |
| in-flight 带 generation 身份 | 失效后旧一代的结果不得写快照、不得更新提示词名称、不得清掉新一代的记录。 |
| 单通道 5 秒超时 | 永不完成的 `listModels` 不许卡死整个请求。 |
| 失败通道 60 秒冷却 | 否则一条坏通道会让每轮都白等 5 秒。冷却中仍记入 `failedProviders`，不冒充 fresh。 |
| 兜底目录**先归一化再缓存** | 曾经把空目录写进快照、只把本次返回值换成兜底 → 第一次 GET 有内容、第二次直接变空。 |
| POST 不 `await` 目录 | 保存动作不该等最慢通道那 5 秒。回执只带 `stateView()`，客户端自己决定要不要刷新目录。 |
| 落盘失败必须报错 | `saveState()` 会抛。`commitState()` 先写盘成功才提交内存状态。否则磁盘满时用户看到「已保存」，重启后配置没了。 |

## 开关：由你在开始前选，不由模型擅自决定

位置和「启用智能体团队协作」完全一致 —— 输入框的**模型菜单**里，紧挨着它下面。

- **默认关闭**。关闭时插件不注册 `ask_advisor` 工具、不注入任何提示词，模型既看不到也不知道有这个能力。
- 打开后，本会话可用 `ask_advisor`；开关按会话保存，重启后仍在。
- 「设置 → 顾问」里还有一个**新会话默认开启**，省得每个新会话都手动点一次。已有会话保留各自的选择（显式值优先于全局默认）。
- 子智能体（包括顾问自己）不显示这个开关。

## 顾问为什么「绝不能参加工作」

三重互不依赖的边界：

1. **预设边界** —— 顾问跑在 `advisor` 预设上，工具面只有 `read` / `read_image` / `glob` / `grep`，外加时间上下文。`tool-fs` 行显式关掉 `write` / `edit` / `applyPatch`，`bash`、`pwsh`、`todo` 这类一律没挂。
2. **守卫边界** —— 插件在 `agent/created` 里识别出顾问会话后，装上 `ctx.tools.guard()`：除那四个只读工具外，任何调用（包括宿主级的 `send_meme`、`plugin_manager`、`cordis_run`、`workflow`、`schedule` 等预设挂不到的）都在调用时刻被拒绝，理由写明「顾问会话只回答问题、不参与实施」。
   机制依据：`ToolsService.checkGuards()` 沿 `exec.agent` 的 scope 链查找守卫，命中后 pipeline 直接把拒绝理由物化成 `Error: <理由>` 并**不进入 dispatch**（`dsh-tools/src/pipeline.ts` 的 `prepare()`）。
3. **深度边界** —— 以「父深度 + 1」为 `maxDepth` 启动：主智能体（0）和子智能体（1）都能开顾问，顾问自己（2）不能再往下派。

## 用法

打开开关后，主智能体像这样咨询：

```
ask_advisor(
  domain: "aesthetic",
  question: "这个设置页现在用 13px 的字号加 34px 行高，视觉上偏散。目标是有层次的密集表单，...
             参考 src/settings/Row.tsx 和 tokens.css。给我排版方案和具体的数值。"
)
```

工具立刻返回顾问的子智能体名，**不阻塞**主智能体继续干活；顾问的答复作为一条消息回到主会话。可以继续用 `send_message` 追问同一个顾问。

## 状态存哪

`$DSH_HOME/dsh-advisors.json`：

```json
{
  "version": 1,
  "sessions": { "<sessionId>": { "enabled": true, "updatedAt": 1794504141010 } },
  "routes": { "aesthetic": "kele-claude/claude-opus-5-5" },
  "defaultEnabled": false
}
```

- `sessions` —— 每个会话的显式开关；
- `routes` —— 各领域选定的模型（缺省 = 用 `DEFAULT_ROUTES`）；
- `defaultEnabled` —— 新会话默认值。

写盘用 temp + rename，避免半截 JSON。**写盘失败会抛错并回 500**，不会谎报「已保存」：
`commitState()` 先构造候选状态 → 写盘成功 → 才替换内存状态。文件损坏时插件按
「全部关闭、全部默认模型」起来并记一条 warn，不会崩。

**为什么不用 Session 事件**：插件不能 append 新的会话事件类型（宿主只放行已注册类型），而且开关是界面偏好、不是对话内容，塞进日志会污染 fork/resume。

## 模型 / provider 改配置

三种改法，优先级从低到高：

1. `index.js` 的 `DEFAULT_ROUTES`（**只决定默认值**，不限制可选范围）；
2. 插件行 config 里的 `routes`（`cordis.patch.yml` 覆盖）；
3. 设置页选的值（`dsh-advisors.json` 的 `routes`）—— 最高。

可选范围由 profile 的 `llm-pi-ai` 决定，不需要改插件：

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-channel:            # 这个键就是 provider id
        displayName: 我的通道  # 下拉里的分组标题
        models:
          - id: some-model
            name: Some Model
```

改完保存，`llm/adapters-updated` 会把缓存作废，设置页刷新即见。

## 边界与限制

- 顾问**看得到工作目录**，但只能读。它是来给判断的，不是来改代码的。
- `ask_advisor` 只在开关打开的会话里出现；关掉就立即消失。
- 守卫是**进程内**的，防的是「模型自己越界」，**不防**恶意代码（插件本身跑在 `danger-full-access` 文件策略下）。
- 顾问与主智能体共享文件系统，主智能体在顾问答复期间的改动，顾问后续追问时能看到。
- 会话开关按 session id 存：**新建或重命名会话后默认值生效**，需要时在菜单里点一下。
- **下拉面板不做上下翻转**：固定向下展开，靠列表自身滚动 + 宿主设置页滚动兜住。
  在没有 portal 的前提下测量裁剪祖先成本偏高，作为已知限制接受。
- 目录枚举**不等于**执行能力探测：`listed` 只说明它在目录里，不保证真的能调通。
  换了模型后建议先发一句最短的试探咨询。
