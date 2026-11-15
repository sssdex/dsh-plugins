# dsh-tavern-model-handoff

**酒馆扮演开局用中转站 flash 读卡，读完自动换 workbuddy-global/hy3 无思考出正文。**

## 解决什么

酒馆·扮演开局要 `read` 卡、`glob` 目录、偶尔跑命令。这些是确定性的活，
用 hy3 干很浪费 —— hy3 是 only-reasoning 模型，读个文件它也要先推演一遍。
而真正需要**感情表达**的是读完卡之后的正文。

这个插件把两个模型接成一条流水线：

| 阶段 | 模型 | 理由 |
|---|---|---|
| 开局读卡 / 跑命令 | `zzz1/deepseek-flash`（中转站） | 免费、快、工具调用准 |
| 读完卡后的正文 | `workbuddy-global/hy3` + **无思考** | 不推演，直接演 |

**只切一次**，整局锁定。不是每回合来回切 —— 那会反复插入「模型已变更」提示、
反复让上下文缓存失效。

## 生效范围（三条闸，缺一不接管）

1. **预设**：只认 `tavern-play`（酒馆·扮演）。编程会话、备卡会话、
   官方「酒馆模式」`tavern`、后台 `tavern-background` 一概不碰。
2. **会话必须是全新的**。已经有 `turn/start` / `step/start` 的会话不动 ——
   恢复老会话时不会被偷偷换模型。
3. **切换时机**：第一个 `tool/result` 落定，或第一回合 `turn/end`（兜底没调工具的情况）。
   之后 `phase = switched`，再也不会触发。

## 装

```powershell
dsh plugin --profile desktop add D:\DeepSeek-Workspace\dsh-tavern-model-handoff
```

装完**重启 DSH** 生效。验证日志（`D:\DeepSeek-DSH\logs`）里应出现：

```
[dsh-tavern-model-handoff] active：tavern-play → 开局 zzz1/deepseek-flash，工具后 workbuddy-global/hy3(off)
```

开一个「酒馆·扮演」新会话，说「加载 Blanche」，正常的话：
第一步读卡用 flash，卡读回来后正文由 hy3 无思考生成。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，不用改插件源码：

```yaml
- id: dsh-tavern-model-handoff
  config:
    enabled: true
    presets: [tavern-play]            # 想同时服务官方酒馆就加 'tavern'
    stripSwitchNotice: true           # 抹掉一次性的「模型已变更」提示
    flash:
      provider: zzz1
      model: deepseek-flash
    target:
      provider: workbuddy-global
      model: hy3
      reasoningEffort: off            # 首选档位；不支持就自动退档
```

临时关掉不重启：设环境变量 `DSH_TAVERN_MODEL_HANDOFF=0`。

## 无思考：能力探测与降级

hy3 上游声明的是 `supportedEfforts: [low, high]`，**不声明 `off`**。
但 workbuddy 插件的 `offModelIds` 里已把 hy3 打上标记 —— 也就是它家给了
「关闭思考」这个档位。所以本插件按这个顺序要：

1. 首选 `off`（真无思考）；
2. 拿不到就退到模型声明里**最低**的档（对 hy3 是 `low`）；
3. 连档位列表都查不到，就不加 `reasoningEffort`，走适配器默认。

**第 2、3 种情况都会打 warn 日志**，明确写「这不是真无思考」。不会静默降级。

探测是异步的，但切换必须同步完成（见下），所以能力在会话创建时后台解析好并缓存；
解析慢于工具结果时，插件记下「已该切」，解析一回来立刻补切 —— 不会整局卡在 flash。

## 三个时序坑（改代码前必读）

### 1. 不能在 `session/event` 监听器里直接 `select()`

`session/event` 是在 `session.commit()` 内部**同步**调用的，此时
`entry.appending === true`。`model.select()` 要 `append`，会抛：

```
session append cannot reenter while another append is being published
```

所以先 `queueMicrotask`（commit 的 `finally` 已把 `appending` 置回 `false`），
在微任务里再同步 `select()`。自测 `[2]` 专门复现这个崩溃点。

### 2. 能力必须在切换前查好，否则白切

`llm.resolveModelInfo()` 是 async。如果切换那一刻才 `await`，续体会排在
agent-loop 的续体之后，赶不上下一次 `preStep` —— 等于白切。

agent-loop 的 `preStep()` **每一步都重新读** `agent.model.current()`，
所以选择只要在「工具结果提交之后、下一步 preStep 之前」生效就一定管用。

### 3. 抹「模型变更提示」要重新注册监听器

`@deepseek-ai/dsh-agent` 的 `installModelSelection()` 在每个 agent 的 setup 阶段
往 `agent/pre-step` 队首（`prepend`）塞监听器，它在 `next()` 返回**之后**才把
`[model changed: …]` 拼到 messages 末尾。

waterfall 队首 = 最外层 = 最先执行。插件在 profile 启动时注册，本来在队首；
但每个新 agent 的 `installModelSelection` 又插到更前，把插件挤到内层 ——
内层拿到的 `decision` 里还没有 notice，抹不掉。

解法：每次 `agent/created` 时**先 dispose 再 prepend 重注册**，保证自己始终最外层。
失败也只是没抹掉（多一行提示），不影响主流程。

## 自测

```powershell
node test/selftest.mjs
```

39 项，七组：

| 组 | 覆盖 |
|---|---|
| `[1]` | 纯逻辑：档位挑选/降级、空白会话判定、预设匹配、路由比较、selection 组装 |
| `[2]` | **提交期 reentry 回归** —— 让 session 处于 `appending` 再派发事件，验证插件不写、事后正确切换 |
| `[3]` | `off` 可用时直接用 `off`，且不告警降级 |
| `[4]` | 安全边界：非 tavern-play、有历史的会话，一次都不 select |
| `[5]` | 能力查不到：仍能切过去，但有明确告警 |
| `[6]` | 「模型已变更」提示被抹掉，且只抹一次 |
| `[7]` | **竞态回归** —— 能力解析慢于工具结果时，解析回来必须补切 |

## 已知边界

- 预设身份用 `composedPreset` → `presetForSession` → `session.header.agentPreset`
  → 日志里最后一条 `agent-preset/selected`，四路兜底。全查不到就**不接管**
  （宁可失效不误伤）。
- `off` 是否真被上游接受，只能实测。被拒会有 warn，且整轮不会崩 —— 
  那一步会走适配器默认档。
- 只在**新建**会话生效。老会话想用，换个新会话重开。
- 中转站 flash 若密钥失效（`ZZZ1_API_KEY` 没配），开局那步会直接报错 ——
  这是中转站的问题，不是本插件能兜的。

## 卸

```powershell
dsh plugin --profile desktop remove dsh-tavern-model-handoff
```

还要从 `package.json` 的 `dsh.profile.bundles` 数组里删掉那一条，然后重启。
